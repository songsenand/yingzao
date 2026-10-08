// Pure-JS tar.gz extraction for the bundled Python runtime archive.
//
// WHY NOT `tar` / system tar / an npm dependency. This runs on a plugin user's
// machine, at host runtime, with no install step of its own: pnpm 11 gates
// dependency build scripts (so anything install-time is a support burden),
// minimal Linux images ship busybox tar with different flags, and Windows only
// grew a usable `tar.exe` in Windows 10 1803. Shelling out also makes the
// extractor's failure mode a PATH question. A reader over `node:zlib` has no
// such dependencies, and the archive we consume is small enough to audit:
// measured 2026-10-08 on cpython-3.13.16+20261003-...-install_only_stripped,
// 4526 members / 99.1MB of file data, ONLY typeflags '0' (regular file, 3478)
// and '2' (symlink, 1048) — no directory entries, no pax headers, no GNU
// longnames, no hardlinks, no absolute symlink targets, longest member path
// exactly 100 bytes.
//
// So this reader implements '0' and '2' and the long-name mechanisms we may
// meet if a future archive is packaged differently ('L'/'K' GNU longname,
// 'x'/'g' pax path/linkpath, '5' explicit directory). Anything else throws
// with the typeflag — a silently half-extracted interpreter is worse than a
// loud failure, because the venv built on it fails much later with a confusing
// error.

import { createGunzip } from 'node:zlib';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

const BLOCK = 512;

export interface ExtractTarGzOptions {
  /** Leading path component to strip; python-build-standalone archives are rooted at `python/`. */
  stripPrefix?: string;
  /** Progress in inflate bytes (`done` counts decompressed bytes). */
  onProgress?: (done: number) => void;
}

/** Growable byte queue over the gunzip stream: one concat per member at most. */
class ByteQueue {
  private chunks: Buffer[] = [];
  private length = 0;
  private iter: AsyncIterator<Buffer>;
  private finished = false;

  constructor(stream: AsyncIterable<Buffer>) {
    this.iter = stream[Symbol.asyncIterator]();
  }

  available(): number {
    return this.length;
  }

  used(): number {
    return this.consumed;
  }

  private consumed = 0;

  /** Pull until `n` bytes are buffered (or the stream ends). Returns whether `n` are available. */
  async ensure(n: number): Promise<boolean> {
    while (this.length < n && !this.finished) {
      const { value, done } = await this.iter.next();
      if (done || !value) {
        this.finished = true;
        break;
      }
      if (value.length > 0) {
        this.chunks.push(value);
        this.length += value.length;
      }
    }
    return this.length >= n;
  }

  /** Consume exactly `n` bytes (caller checked availability). */
  take(n: number): Buffer {
    if (n === 0) return Buffer.alloc(0);
    const first = this.chunks[0]!;
    this.consumed += n;
    this.length -= n;
    if (first.length === n) {
      this.chunks.shift();
      return first;
    }
    if (first.length > n) {
      const out = first.subarray(0, n);
      this.chunks[0] = first.subarray(n);
      return out;
    }
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const head = this.chunks[0]!;
      const want = n - off;
      if (head.length <= want) {
        head.copy(out, off);
        off += head.length;
        this.chunks.shift();
      } else {
        head.copy(out, off, 0, want);
        this.chunks[0] = head.subarray(want);
        off += want;
      }
    }
    return out;
  }

  /** Drop `n` bytes of padding without materializing them. */
  discard(n: number): void {
    if (n > 0) this.take(n);
  }

  /** True when the stream is drained and no bytes remain. */
  get drained(): boolean {
    return this.finished && this.length === 0;
  }
}

function parseOctal(field: Buffer): number {
  const text = field.toString('latin1').replace(/\0.*$/s, '').trim();
  if (text === '') return 0;
  const value = Number.parseInt(text, 8);
  if (Number.isNaN(value)) throw new Error(`tar: unparsable size field ${JSON.stringify(text)}`);
  return value;
}

function parseString(field: Buffer): string {
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
  return true;
}

/** Resolve a member path against the destination, refusing anything that escapes it. */
function safeJoin(destRoot: string, memberPath: string): string {
  if (memberPath === '') throw new Error('tar: empty member path');
  if (memberPath.startsWith('/') || /^[A-Za-z]:/.test(memberPath)) {
    throw new Error(`tar: refusing absolute member path ${JSON.stringify(memberPath)}`);
  }
  const target = resolve(destRoot, memberPath);
  if (target !== destRoot && !target.startsWith(destRoot + sep)) {
    throw new Error(`tar: refusing member path outside the destination: ${JSON.stringify(memberPath)}`);
  }
  return target;
}

/** A symlink is only created when its target resolves inside the destination. */
function safeLinkTarget(destRoot: string, linkPath: string, linkTarget: string): string {
  if (linkTarget === '') throw new Error(`tar: empty symlink target for ${JSON.stringify(linkPath)}`);
  if (isAbsolute(linkTarget) || /^[A-Za-z]:/.test(linkTarget)) {
    throw new Error(`tar: refusing absolute symlink target ${JSON.stringify(linkTarget)}`);
  }
  const resolved = resolve(dirname(linkPath), linkTarget);
  if (resolved !== destRoot && !resolved.startsWith(destRoot + sep)) {
    throw new Error(`tar: refusing symlink escaping the destination: ${JSON.stringify(linkTarget)}`);
  }
  return linkTarget;
}

function parsePax(data: Buffer, into: Map<string, string>): void {
  let off = 0;
  while (off < data.length) {
    let space = data.indexOf(0x20, off);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(off, space).toString('latin1'), 10);
    if (!Number.isFinite(length) || length <= 0 || off + length > data.length) break;
    const record = data.subarray(space + 1, off + length).toString('utf8').replace(/\n$/, '');
    const eq = record.indexOf('=');
    if (eq > 0) into.set(record.slice(0, eq), record.slice(eq + 1));
    off += length;
  }
}

/**
 * Remove the archive's leading directory, keeping members that live outside it.
 *
 * python-build-standalone archives are rooted at `python/` but also carry
 * top-level `LICENSE*` files (measured 2026-10-08: 9 such members). Those must
 * travel with the interpreter — we are redistributing CPython — and dropping
 * them silently would be the kind of quiet omission this harness refuses. So a
 * member without the prefix keeps its path and lands next to `bin/`, which is
 * also exactly the layout `uv python install` produces.
 */
function stripLeading(memberPath: string, prefix: string | undefined): string {
  const normalized = memberPath.replace(/^\.\//, '');
  if (!prefix) return normalized;
  if (normalized === prefix) return '';
  const head = `${prefix}/`;
  return normalized.startsWith(head) ? normalized.slice(head.length) : normalized;
}

/**
 * Extract a `tar.gz` archive into `dest`.
 *
 * Members are written under `dest` with `stripPrefix` removed, so
 * `python/bin/python3` lands at `<dest>/bin/python3`. Unknown member types and
 * escaping paths throw instead of being skipped.
 */
export async function extractTarGz(
  archive: string,
  dest: string,
  options: ExtractTarGzOptions = {},
): Promise<void> {
  const destRoot = resolve(dest);
  await mkdir(destRoot, { recursive: true });

  const stream = createReadStream(archive).pipe(createGunzip());
  const queue = new ByteQueue(stream as unknown as AsyncIterable<Buffer>);

  let pendingLongName: string | undefined;
  let pendingLongLink: string | undefined;
  const pax = new Map<string, string>();
  const deferredLinks: { path: string; target: string }[] = [];
  let members = 0;

  for (;;) {
    if (!(await queue.ensure(BLOCK))) break;
    const header = queue.take(BLOCK);
    if (isZeroBlock(header)) {
      // End-of-archive marker; ignore whatever padding follows.
      break;
    }

    const size = parseOctal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] ?? 0);
    const mode = parseOctal(header.subarray(100, 108));
    const headerName = parseString(header.subarray(0, 100));
    const headerLink = parseString(header.subarray(157, 257));
    const padded = Math.ceil(size / BLOCK) * BLOCK;

    if (!(await queue.ensure(padded))) {
      throw new Error(`tar: truncated archive inside member ${JSON.stringify(headerName)}`);
    }
    const data = padded === 0 ? Buffer.alloc(0) : queue.take(padded).subarray(0, size);

    if (type === 'L') {
      pendingLongName = parseString(data);
      continue;
    }
    if (type === 'K') {
      pendingLongLink = parseString(data);
      continue;
    }
    if (type === 'x' || type === 'g') {
      parsePax(data, pax);
      continue;
    }

    const raw = pax.get('path') ?? pendingLongName ?? headerName;
    const rawLink = pax.get('linkpath') ?? pendingLongLink ?? headerLink;
    pendingLongName = undefined;
    pendingLongLink = undefined;
    pax.clear();

    const relative = stripLeading(raw, options.stripPrefix);
    if (relative === '') continue;
    const target = safeJoin(destRoot, relative);

    if (type === '0' || type === '\0') {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
      if (process.platform !== 'win32' && (mode & 0o111) !== 0) {
        await chmod(target, mode & 0o777);
      }
    } else if (type === '5') {
      await mkdir(target, { recursive: true });
    } else if (type === '2') {
      await mkdir(dirname(target), { recursive: true });
      const linkTarget = safeLinkTarget(destRoot, target, rawLink);
      try {
        await symlink(linkTarget, target, process.platform === 'win32' ? 'file' : undefined);
      } catch (error) {
        // Windows without the symlink privilege: resolve after the archive is
        // fully written (the target file exists by then) by copying it.
        if (process.platform === 'win32') deferredLinks.push({ path: target, target: linkTarget });
        else throw error;
      }
    } else {
      throw new Error(`tar: unsupported member type ${JSON.stringify(type)} at ${JSON.stringify(raw)}`);
    }

    members += 1;
    options.onProgress?.(queue.used());
  }

  for (const link of deferredLinks) {
    const source = resolve(dirname(link.path), link.target);
    try {
      await copyFile(source, link.path);
    } catch (error) {
      throw new Error(`tar: could not materialize symlink ${link.path} -> ${link.target}: ${String((error as Error)?.message ?? error)}`);
    }
  }

  if (members === 0) throw new Error(`tar: ${archive} contained no members`);
}

/** Convenience for callers that only need one entry extracted. */
export function tarEntryPath(dest: string, relative: string): string {
  return join(dest, relative);
}
