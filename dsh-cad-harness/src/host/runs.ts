// Run store: every validation / simulation execution persists as an immutable,
// self-describing run under <projectRoot>/runs/rNNN (see project.ts).
//
// Why this exists: the panel used to fetch "the latest physics report", "the
// latest fluid frames" from fixed global filenames. That made a run
// unattributable — you could not say which version it was about, and the
// previous run was overwritten. With runs as first-class artifacts the panel
// can browse *products* (versions + runs) and let the artifact's own kind pick
// the presentation, instead of the human picking a mode first.
//
// Layout:
//   data/runs/manifest.json     { schemaVersion, runs: RunEntry[] }  (append-only index)
//   data/runs/r007/
//     run.json                  self-describing copy of the entry (survives a lost index)
//     report.json               the kind's full report
//     trajectory.json           motion / physics only
//     fluid-manifest.json       fluid only (frame index the panel scrubs)
//     parts/<name>.stl          geometry the run was computed on
//     frames/<file>             keyframe PNGs (motion/physics) or fluid .bin/.png

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunKind, RunProduct, RunStatus } from '../shared/types.ts';

export type { RunKind, RunStatus } from '../shared/types.ts';

/** One run as the store persists it: the product record plus its artifact names. */
export type RunEntry = Omit<RunProduct, 'type'>;

export interface RunManifest {
  schemaVersion: 1;
  runs: RunEntry[];
}

export interface RunStore {
  root: string;
}

/** @param dataRoot the plugin's `data/` directory (same root versions live in). */
export function openRunStore(dataRoot: string): RunStore {
  return { root: join(dataRoot, 'runs') };
}

const MANIFEST = 'manifest.json';

export async function readRunManifest(store: RunStore): Promise<RunManifest> {
  try {
    const raw = JSON.parse(await readFile(join(store.root, MANIFEST), 'utf8')) as RunManifest;
    return { schemaVersion: 1, runs: Array.isArray(raw.runs) ? raw.runs : [] };
  } catch {
    return { schemaVersion: 1, runs: [] };
  }
}

/** Runs newest-first (the order the product list wants). */
export async function listRuns(store: RunStore): Promise<RunEntry[]> {
  return (await readRunManifest(store)).runs
    .slice()
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
}

export async function readRun(store: RunStore, id: string): Promise<RunEntry | null> {
  return (await readRunManifest(store)).runs.find((r) => r.id === id) ?? null;
}

/** Latest run, optionally restricted to some kinds (legacy route aliases). */
export async function latestRun(store: RunStore, kinds?: RunKind[]): Promise<RunEntry | null> {
  const runs = await listRuns(store);
  return runs.find((r) => !kinds || kinds.includes(r.kind)) ?? null;
}

/** Absolute path inside a run dir, or null when `rel` is unsafe/escaping. */
export function runFilePath(store: RunStore, id: string, rel: string): string | null {
  if (!/^r\d{3,}$/.test(id)) return null;
  const parts = rel.split('/');
  if (parts.length === 0) return null;
  if (parts.some((p) => safeArtifactName(p) === null)) return null;
  return join(store.root, id, ...parts);
}

async function nextRunId(store: RunStore): Promise<string> {
  await mkdir(store.root, { recursive: true });
  let max = 0;
  try {
    for (const name of await readdir(store.root)) {
      const m = /^r(\d{3,})$/.exec(name);
      if (m) max = Math.max(max, parseInt(m[1]!, 10));
    }
  } catch { /* fresh store */ }
  // The index can outlive a deleted directory; trust whichever is further along.
  for (const r of (await readRunManifest(store)).runs) {
    const m = /^r(\d{3,})$/.exec(r.id);
    if (m) max = Math.max(max, parseInt(m[1]!, 10));
  }
  return `r${String(max + 1).padStart(3, '0')}`;
}

/** Path segments that must never name a file inside a run directory. */
const UNSAFE_NAME = /[/\\:*?"<>|\u0000-\u001f]/;

/**
 * Is this a usable artifact name — a part, a frame, a JSON artifact?
 *
 * The rule is about the FILESYSTEM, not about the alphabet. It used to be
 * `/^[A-Za-z0-9._-]+$/`, which meant a run could not carry the part names the
 * rest of the harness uses: `generate_part` files a version under "底座" and the
 * panel prints "底座", but `validate_assembly` refused `Error: unsafe part name:
 * 底座` — so assembly runs spoke a different language than the corpus they were
 * about. Rejecting separators, control characters, the Windows-reserved set and
 * a leading dot is what the "no traversal" requirement actually needs; a name
 * may otherwise be any UTF-8 the model and the human agree on.
 *
 * Returns the name unchanged when it is safe, else null.
 */
export function safeArtifactName(name: string): string | null {
  if (typeof name !== 'string' || name.length === 0) return null;
  if (name !== name.trim()) return null;
  if (name === '.' || name === '..' || name.startsWith('.')) return null;
  if (UNSAFE_NAME.test(name)) return null;
  return name;
}

/** @deprecated internal alias kept for the call sites inside this module. */
const safeName = safeArtifactName;

export interface RunWriter {
  readonly id: string;
  readonly dir: string;
  /** JSON artifact at the run root (report.json, trajectory.json, …). */
  json(name: string, value: unknown): Promise<void>;
  /** Raw artifact at the run root. */
  bytes(name: string, data: Uint8Array | string): Promise<void>;
  /**
   * Geometry the run was computed on: parts/<name>.stl. `placement` records
   * where it sat (assembly runs need it to be shown correctly later).
   */
  part(name: string, stl: Uint8Array, placement?: { translate?: number[]; rotate?: number[] }): Promise<void>;
  /** Playback/render frame: frames/<name>. Returns the stored name. */
  frame(name: string, data: Uint8Array | string): Promise<string>;
  /** Logical path the panel fetches (parts/foo.stl, frames/bar.bin). */
  commit(final: {
    status: RunStatus;
    summary: string;
    title?: string;
    sourceVersionIds?: string[];
    /**
     * What this run is ABOUT, stable across iterations: the manifest it audited
     * or the part set it posed. Committing a run whose subject matches an older
     * run of the same kind marks that older one `supersededBy` this id.
     */
    subject?: string;
  }): Promise<RunEntry>;
}

/**
 * Open a new run. Files land in the run directory immediately; the manifest
 * entry is appended only on `commit`, so an interrupted run never shows up as a
 * browsable product.
 *
 * The DIRECTORY is created lazily, on the first write, and that is deliberate:
 * when it was created here, a call that threw before writing anything (the
 * microscope2 corpus has one — `validate_assembly` was given a part name the
 * store refused) left an empty `runs/r004/` behind, absent from the index and
 * indistinguishable from a half-written run. An id that never produced a file
 * now leaves nothing to clean up and is handed out again.
 *
 * `timestamp` is for adopting artifacts that already exist (migration): a run
 * created now uses the clock.
 */
export async function beginRun(
  store: RunStore,
  init: { kind: RunKind; title: string; timestamp?: string },
): Promise<RunWriter> {
  const id = await nextRunId(store);
  const dir = join(store.root, id);
  let dirReady: Promise<void> | null = null;
  const ensureDir = (): Promise<void> => (dirReady ??= (async () => {
    await mkdir(join(dir, 'parts'), { recursive: true });
    await mkdir(join(dir, 'frames'), { recursive: true });
  })());
  const parts: string[] = [];
  const placements: NonNullable<RunEntry['placements']> = {};

  const writer: RunWriter = {
    id,
    dir,
    async json(name, value) {
      const safe = safeName(name);
      if (!safe) throw new Error(`unsafe run artifact name: ${name}`);
      await ensureDir();
      await writeFile(join(dir, safe), JSON.stringify(value, null, 2));
    },
    async bytes(name, data) {
      const safe = safeName(name);
      if (!safe) throw new Error(`unsafe run artifact name: ${name}`);
      await ensureDir();
      await writeFile(join(dir, safe), data);
    },
    async part(name, stl, placement) {
      const safe = safeName(name);
      if (!safe) throw new Error(`unsafe part name: ${name}`);
      await ensureDir();
      await writeFile(join(dir, 'parts', `${safe}.stl`), stl);
      if (!parts.includes(safe)) parts.push(safe);
      if (placement && (placement.translate || placement.rotate)) {
        placements[safe] = {
          ...(placement.translate ? { translate: placement.translate } : {}),
          ...(placement.rotate ? { rotate: placement.rotate } : {}),
        };
      }
    },
    async frame(name, data) {
      const safe = safeName(name);
      if (!safe) throw new Error(`unsafe frame name: ${name}`);
      await ensureDir();
      await writeFile(join(dir, 'frames', safe), data);
      return safe;
    },
    async commit(final) {
      const manifest = await readRunManifest(store);
      // Lifecycle: a run that names its SUBJECT (the manifest it audited, the
      // part set it posed) replaces the previous run of the same kind about the
      // same subject. The older runs stay readable and keep their reports; only
      // a `supersededBy` pointer is added, so a corpus with 36 runs can still
      // answer "which one is the current check" without guessing from titles.
      const superseded: string[] = [];
      if (final.subject) {
        for (const older of manifest.runs) {
          if (older.id === id || older.kind !== init.kind) continue;
          if (older.subject !== final.subject || older.supersededBy) continue;
          older.supersededBy = id;
          superseded.push(older.id);
        }
      }
      const entry: RunEntry = {
        id,
        kind: init.kind,
        timestamp: init.timestamp ?? new Date().toISOString(),
        title: final.title ?? init.title,
        status: final.status,
        summary: final.summary,
        sourceVersionIds: [...new Set(final.sourceVersionIds ?? [])].filter(Boolean).sort(),
        hasGeometry: parts.length > 0,
        parts: parts.slice().sort(),
        ...(final.subject ? { subject: final.subject } : {}),
        ...(superseded.length ? { supersedes: superseded } : {}),
        ...(Object.keys(placements).length ? { placements } : {}),
      };
      await ensureDir();
      await writeFile(join(dir, 'run.json'), JSON.stringify(entry, null, 2));
      for (const olderId of superseded) {
        const older = manifest.runs.find((r) => r.id === olderId);
        if (older) await writeFile(join(store.root, olderId, 'run.json'), JSON.stringify(older, null, 2)).catch(() => {});
      }
      manifest.runs = manifest.runs.filter((r) => r.id !== id).concat(entry);
      await mkdir(store.root, { recursive: true });
      const tmp = join(store.root, `${MANIFEST}.tmp`);
      await writeFile(tmp, JSON.stringify(manifest, null, 2));
      await rename(tmp, join(store.root, MANIFEST));
      return entry;
    },
  };
  return writer;
}
