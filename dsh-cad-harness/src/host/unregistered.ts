// Unregistered geometry: mesh files in the workspace that no version accounts for.
//
// WHY A SHARED MODULE: two consumers need the SAME list — `delivery_audit` (which
// turns it into a blocked finding) and the panel's 未登记 category (which lets a
// human preview and import them). Two implementations would drift, and then the
// human would see a different list than the machine flags.
//
// "Accounted for" is EXACT, not name-based: the file's sha256 must equal a stored
// `model.stl`, an imported version's source sha256, or a cached panel export. A
// path alone is not enough — an edited import is a different geometry and must be
// re-imported, otherwise the corpus would vouch for bytes it never saw.
//
// The panel route calls this on demand, so file hashes and the version-hash set
// are cached (keyed by mtime+size, and by the version manifest signature). The
// audit calls it once per run and shares the same cache.

import { createHash } from 'node:crypto';
import { createReadStream, type Dirent } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import type { ProjectStores } from './project.ts';
import type { VersionManifestEntry } from './version.ts';
// The tool output schema's `additionalProperties: true` infers a JSON record; a
// typed interface needs the index signature to be assignable (see inspect.ts).
import type { Json } from './inspect.ts';

type JsonRecord = { [key: string]: Json };

/**
 * Extensions recognised as geometry on disk (whether or not we can read them).
 * DXF is here although it is 2D: it is importable geometry (a profile plus
 * depthMm makes a solid), so a stray DXF is just as unregistered as a stray STL —
 * it simply cannot be PREVIEWED until it has a depth.
 */
export const MESH_EXTENSIONS = new Set(['.stl', '.step', '.stp', '.3mf', '.dxf', '.obj', '.off', '.ply']);
/** Formats `import_part` can actually read. */
export const IMPORTABLE_EXTENSIONS = new Set(['.stl', '.step', '.stp', '.3mf', '.dxf']);
/** Formats the panel can preview (DXF needs depthMm, so it cannot be previewed). */
export const PREVIEWABLE_EXTENSIONS = new Set(['.stl', '.step', '.stp', '.3mf']);

/** Directories that are never "the design's own output" (deps, VCS, build, other stores). */
// `checks/` holds checker/v1 packages, including negative-sample meshes. Those are
// evidence tooling, not delivered geometry: a check fixture must be allowed to be a
// mesh without being imported as a version (otherwise every check adds a blocked
// `unregistered-geometry` finding). Surfaced by the pen-cam-timing trial, 2026-11-11.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.pnpm-store', '.local-archive', 'bin', '__pycache__', '.venv', 'venv', 'versions', 'checks']);
/** Walk budget, exported so a caller's message cannot drift from the real limit. */
export const SCAN_BUDGET = { maxVisitedEntries: 20_000, maxMeshFiles: 500 } as const;
const MAX_HASH_CACHE = 4_000;

export interface UnregisteredFile extends JsonRecord {
  /** Workspace-relative, POSIX separators (readable in a finding and a URL). */
  path: string;
  bytes: number;
  modified: string;
  /** blocked = newer than every version (or the corpus is empty); warn = older. */
  severity: 'blocked' | 'warn';
  /** Extension without the dot, lower-case: stl / step / 3mf / dxf / obj … */
  format: string;
  /** `import_part` can read it. */
  importable: boolean;
  /** The panel can render it (STL/STEP/3MF; DXF needs depthMm first). */
  previewable: boolean;
}

export interface UnregisteredScan extends JsonRecord {
  scanned: number;
  files: UnregisteredFile[];
  /** Declared exceptions, echoed with their reason (never blocked). */
  exempt: { path: string; reason: string }[];
  /** Exemptions naming a path that does not exist (a stale declaration). */
  missingExempt: { path: string; reason: string }[];
  /** True when the walk hit its budget and may have missed files. */
  truncated: boolean;
}

export interface ScanOptions {
  project: ProjectStores;
  /** The workspace whose files are judged; defaults to the project cwd. */
  workspace?: string;
  /** Workspace-relative roots to scan. Default ['.']. */
  scanPaths?: string[];
  /** Files intentionally left as files, with a reason. */
  exempt?: { path: string; reason: string }[];
  versions: VersionManifestEntry[];
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((ok, fail) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk as Buffer));
    stream.on('end', () => ok());
    stream.on('error', fail);
  });
  return hash.digest('hex');
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

// A warm cache is what makes the panel route cheap enough to call on demand:
// hashing every mesh on every poll would be seconds of I/O for an unchanged tree.
const fileHashCache = new Map<string, { mtimeMs: number; size: number; hash: string }>();

async function cachedFileHash(abs: string, mtimeMs: number, size: number): Promise<string> {
  const hit = fileHashCache.get(abs);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.hash;
  const hash = await sha256File(abs);
  if (fileHashCache.size >= MAX_HASH_CACHE) fileHashCache.clear();
  fileHashCache.set(abs, { mtimeMs, size, hash });
  return hash;
}

let versionHashCache: { root: string; signature: string; hashes: Set<string> } | null = null;

/** Hashes of everything a version accounts for: stored mesh, import source, export cache. */
async function registeredHashes(project: ProjectStores, versions: VersionManifestEntry[]): Promise<Set<string>> {
  const signature = versions.map((v) => `${v.id}:${v.timestamp}`).join('|');
  if (versionHashCache && versionHashCache.root === project.root && versionHashCache.signature === signature) {
    return versionHashCache.hashes;
  }
  const hashes = new Set<string>();
  for (const v of versions) {
    const dir = join(project.root, 'versions', v.id);
    try { hashes.add(await sha256File(join(dir, 'model.stl'))); } catch { /* no mesh = registers nothing */ }
    if (v.source?.kind === 'imported') hashes.add(v.source.sha256);
    // A panel export (3MF/OBJ/…) is a DERIVED copy of a registered version and is
    // cached next to it; a saved copy in the workspace must not be flagged.
    try {
      for (const name of await readdir(dir)) {
        if (/^export_[a-z0-9]+\./.test(name)) {
          try { hashes.add(await sha256File(join(dir, name))); } catch { /* unreadable cache */ }
        }
      }
    } catch { /* no version dir */ }
  }
  versionHashCache = { root: project.root, signature, hashes };
  return hashes;
}

/** Newest version timestamp — the line between "produced after the last commit" and "pre-existing". */
function newestTimestamp(versions: VersionManifestEntry[]): string | undefined {
  return versions.slice().sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))[0]?.timestamp;
}

/**
 * Find mesh files under the scan roots that no version accounts for.
 *
 * A nested directory that owns a `cad-data/` is another project's corpus, so it
 * is skipped: judging its files from THIS corpus is the same category error the
 * panel's project scope exists to prevent.
 */
export async function scanUnregistered(opts: ScanOptions): Promise<UnregisteredScan> {
  const workspace = resolve(opts.workspace ?? opts.project.cwd);
  const corpusDir = resolve(opts.project.root);
  const roots = (opts.scanPaths ?? ['.']).map((p) => resolve(workspace, p));
  const exemptEntries = (opts.exempt ?? []).map((e) => ({ abs: resolve(workspace, e.path), reason: e.reason }));
  const exemptReason = (abs: string): string | undefined => {
    for (const entry of exemptEntries) {
      if (abs === entry.abs || abs.startsWith(entry.abs + sep)) return entry.reason;
    }
    return undefined;
  };

  const found: string[] = [];
  const budget = { visited: 0, meshes: 0, truncated: false };
  const walk = async (dir: string): Promise<void> => {
    if (budget.truncated) return;
    let entries: Dirent[];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (++budget.visited > SCAN_BUDGET.maxVisitedEntries) { budget.truncated = true; return; }
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.tmp')) continue;
        if (resolve(path) === corpusDir) continue;
        // ANY directory owning a cad-data/ is another project's corpus — at any
        // depth. (The first version of this gated the check on `!isRoot`, so a
        // corpus directly under the workspace root was walked and its files
        // judged by this one; found 2026-10-22 by the nested-corpus acceptance.)
        if (await isDirectory(join(path, 'cad-data'))) continue;
        await walk(path);
      } else if (entry.isFile() && MESH_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        if (++budget.meshes > SCAN_BUDGET.maxMeshFiles) { budget.truncated = true; return; }
        found.push(path);
      }
    }
  };

  const candidates: string[] = [];
  for (const root of roots) {
    if (await isDirectory(root)) await walk(root);
    else if (MESH_EXTENSIONS.has(extname(root).toLowerCase())) candidates.push(root);
  }
  // A walk may reach the same file from two declared roots.
  for (const file of found) {
    if (!candidates.includes(file)) candidates.push(file);
  }

  const rel = (abs: string): string => relative(workspace, abs).split(sep).join('/') || abs;
  const exemptHits: { path: string; reason: string }[] = [];
  const toCheck: string[] = [];
  for (const abs of candidates) {
    const reason = exemptReason(abs);
    if (reason !== undefined) exemptHits.push({ path: rel(abs), reason });
    else toCheck.push(abs);
  }

  // Hash the corpus only when there is something to compare it against.
  const registered = toCheck.length > 0 ? await registeredHashes(opts.project, opts.versions) : new Set<string>();

  const newest = newestTimestamp(opts.versions);
  const isNewer = (mtimeMs: number): boolean => !newest || mtimeMs > new Date(newest).getTime();

  const files: UnregisteredFile[] = [];
  for (const abs of toCheck) {
    let info;
    try { info = await stat(abs); } catch { continue; }
    let hash: string;
    try { hash = await cachedFileHash(abs, info.mtimeMs, info.size); } catch { continue; }
    if (registered.has(hash)) continue;
    const ext = extname(abs).toLowerCase();
    files.push({
      path: rel(abs),
      bytes: info.size,
      modified: info.mtime.toISOString(),
      severity: isNewer(info.mtimeMs) ? 'blocked' : 'warn',
      format: ext.replace(/^\./, ''),
      importable: IMPORTABLE_EXTENSIONS.has(ext),
      previewable: PREVIEWABLE_EXTENSIONS.has(ext),
    });
  }
  files.sort((a, b) => (a.severity === b.severity ? b.modified.localeCompare(a.modified) : a.severity === 'blocked' ? -1 : 1));

  const missingExempt: { path: string; reason: string }[] = [];
  for (const entry of exemptEntries) {
    const exists = await stat(entry.abs).then(() => true).catch(() => false);
    if (!exists) missingExempt.push({ path: rel(entry.abs), reason: entry.reason });
  }

  return {
    scanned: candidates.length,
    files,
    exempt: exemptHits,
    missingExempt,
    truncated: budget.truncated,
  };
}

/**
 * Resolve a caller-supplied path to a real file INSIDE the workspace.
 *
 * The panel previews and imports files the session can name, and those are the
 * session's own workspace files. `realpath` is what makes the check meaningful:
 * a symlink inside the workspace pointing at `/etc/passwd` resolves outside it
 * and is refused, which a string-prefix test on the unresolved path would miss.
 */
export async function resolveWorkspaceFile(raw: string, workspace: string): Promise<string> {
  if (!raw || raw.includes('\0')) throw new Error('a file path is required');
  const root = await realpath(resolve(workspace)).catch(() => resolve(workspace));
  const real = await realpath(resolve(root, raw)).catch(() => null);
  if (!real) throw new Error(`no such file under the workspace: ${raw}`);
  if (real !== root && !real.startsWith(root + sep)) {
    throw new Error(
      `"${raw}" is outside this session's workspace (${root}) — the panel previews and imports workspace files only`,
    );
  }
  return real;
}
