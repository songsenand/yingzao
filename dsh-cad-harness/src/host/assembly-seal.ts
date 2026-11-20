// Binary seal for the assembly contract.
//
// WHY THIS EXISTS. The contract (`assembly/assembly.json`) is the one file a
// wrong edit silently invalidates every fit/motion conclusion. The writer is
// `cad_assembly`; a generic file write is not an authoring path. A plain JSON
// file cannot tell "written by the tool" from "typed by an agent", so every
// write leaves a binary seal next to it:
//
//   assembly/assembly.json   the readable contract
//   assembly/assembly.seal   magic/version/revision/payload hash/log head
//   assembly/changes/        append-only change records
//
// The seal is intentionally small and boring: it carries no payload, only the
// identity of the JSON that was materialized. A direct edit changes the JSON
// hash and the seal no longer matches, so every reader refuses the file until
// `cad_assembly rebuild` re-materializes it from the change log. This is a
// process barrier, not a security boundary: an actor with the format and write
// access can forge a seal, but it cannot do so by accident, and every change
// still has to pass through the writer to be believed.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** `YZSEAL1\0` — versioned so a future format can be refused, not misread. */
const MAGIC = Buffer.from('YZSEAL1\0', 'latin1');
const VERSION = 1;
const HEADER_BYTES = 84;
const TOTAL_BYTES = HEADER_BYTES + 32;

export interface AssemblySeal {
  revision: number;
  logCount: number;
  /** sha256 of the exact JSON bytes that were materialized. */
  payloadSha256: string;
  /** sha256 of the latest change record, or the zero hash when there is none. */
  logHeadSha256: string;
}

export function sha256Text(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

export function sha256Buffer(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function sealPathFor(manifestPath: string): string {
  return join(dirname(manifestPath), 'assembly.seal');
}

export function changesDirFor(manifestPath: string): string {
  return join(dirname(manifestPath), 'changes');
}

export function encodeSeal(seal: AssemblySeal): Uint8Array {
  const out = Buffer.alloc(TOTAL_BYTES);
  MAGIC.copy(out, 0);
  out.writeUInt16LE(VERSION, 8);
  out.writeUInt16LE(0, 10);
  out.writeUInt32LE(seal.revision >>> 0, 12);
  out.writeUInt32LE(seal.logCount >>> 0, 16);
  out.set(Buffer.from(seal.payloadSha256.replace(/^sha256:/, ''), 'hex'), 20);
  out.set(Buffer.from(seal.logHeadSha256.replace(/^sha256:/, ''), 'hex'), 52);
  const footer = createHash('sha256').update(out.subarray(0, HEADER_BYTES)).digest();
  out.set(footer, HEADER_BYTES);
  return out;
}

export function decodeSeal(bytes: Uint8Array): AssemblySeal {
  if (bytes.length !== TOTAL_BYTES) {
    throw new Error(`assembly seal has ${bytes.length} bytes, expected ${TOTAL_BYTES}`);
  }
  const buf = Buffer.from(bytes);
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('assembly seal has an unknown magic; this is not a contract seal');
  }
  const version = buf.readUInt16LE(8);
  if (version !== VERSION) {
    throw new Error(`assembly seal version ${version} is not supported (expected ${VERSION})`);
  }
  const footer = createHash('sha256').update(buf.subarray(0, HEADER_BYTES)).digest();
  if (!buf.subarray(HEADER_BYTES).equals(footer)) {
    throw new Error('assembly seal footer does not match; the seal is corrupt');
  }
  return {
    revision: buf.readUInt32LE(12),
    logCount: buf.readUInt32LE(16),
    payloadSha256: `sha256:${buf.subarray(20, 52).toString('hex')}`,
    logHeadSha256: `sha256:${buf.subarray(52, 84).toString('hex')}`,
  };
}

export async function readSeal(path: string): Promise<AssemblySeal | null> {
  if (!existsSync(path)) return null;
  return decodeSeal(new Uint8Array(await readFile(path)));
}

export async function writeSeal(path: string, seal: AssemblySeal): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, encodeSeal(seal));
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}
