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

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readPythonOverlay } from './python-runtime.ts';
import { readCounter, withFileLock, writeCounter, writeJsonAtomic } from './file-lock.ts';
import type { RunJudgement, RunKind, RunProduct, RunStatus } from '../shared/types.ts';

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

/**
 * Read the run index, repairing it from `runs/rNNN/run.json` when it is missing or broken.
 *
 * WHY: every run writes a self-describing `run.json` beside its artifacts, and this
 * loader is the only thing that reads it (2026-10-23 audit, FIX-E3). Treating a broken
 * index as "no runs" made 36 runs of history look like an empty project — the same
 * failure the version index had (FIX-C3). A read does not rewrite the index; the next
 * `commit` persists the healed list.
 */
export async function readRunManifest(store: RunStore): Promise<RunManifest> {
  let raw: string;
  try {
    raw = await readFile(join(store.root, MANIFEST), 'utf8');
  } catch {
    return { schemaVersion: 1, runs: await recoverRuns(store) };
  }
  try {
    const parsed = JSON.parse(raw) as RunManifest;
    const runs = Array.isArray(parsed?.runs) ? parsed.runs : [];
    const known = new Set(runs.map((r) => r.id));
    const missing = (await listRunDirs(store)).filter((id) => !known.has(id));
    if (missing.length === 0) return { schemaVersion: 1, runs };
    return { schemaVersion: 1, runs: [...runs, ...await recoverRuns(store, known)] };
  } catch {
    return { schemaVersion: 1, runs: await recoverRuns(store) };
  }
}

async function listRunDirs(store: RunStore): Promise<string[]> {
  try {
    return (await readdir(store.root)).filter((n) => /^r\d{3,}$/.test(n)).sort();
  } catch {
    return [];
  }
}

/** Rebuild index rows from each run's own `run.json` (the artifact that survives a lost index). */
async function recoverRuns(store: RunStore, known: Set<string> = new Set()): Promise<RunEntry[]> {
  const out: RunEntry[] = [];
  for (const id of await listRunDirs(store)) {
    if (known.has(id)) continue;
    try {
      const entry = JSON.parse(await readFile(join(store.root, id, 'run.json'), 'utf8')) as RunEntry;
      if (entry && entry.id === id) out.push(entry);
    } catch { /* a run dir without a readable run.json has nothing to recover */ }
  }
  return out;
}

/**
 * Compare the index with the run directories WITHOUT healing either side.
 * `run.json` is the authoritative per-run copy; this says where the two disagree.
 */
export async function diagnoseRunManifest(store: RunStore): Promise<{
  onDisk: string[];
  inIndex: string[];
  onlyOnDisk: string[];
  onlyInIndex: string[];
  parseError: string | null;
}> {
  const onDisk = await listRunDirs(store);
  let inIndex: string[] = [];
  let parseError: string | null = null;
  try {
    const parsed = JSON.parse(await readFile(join(store.root, MANIFEST), 'utf8')) as { runs?: { id: string }[] };
    inIndex = (parsed?.runs ?? []).map((r) => r.id);
  } catch (e) {
    parseError = String((e as Error)?.message ?? e);
  }
  return {
    onDisk, inIndex,
    onlyOnDisk: onDisk.filter((id) => !inIndex.includes(id)),
    onlyInIndex: inIndex.filter((id) => !onDisk.includes(id)),
    parseError,
  };
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
  // A persisted counter, bumped under the manifest lock. Without it two writers
  // (two sessions on one project, or two tool calls in a turn) are handed the
  // same id and write into the same directory. The counter is healed from the
  // directories AND the manifest, so losing it costs a scan, not correctness —
  // and the run directory is still created lazily, so an id that never produced
  // a file leaves nothing behind.
  return withFileLock(join(store.root, MANIFEST), async () => {
    let max = await readCounter(join(store.root, 'next-id'));
    try {
      for (const name of await readdir(store.root)) {
        const m = /^r(\d{3,})$/.exec(name);
        if (m) max = Math.max(max, parseInt(m[1]!, 10));
      }
    } catch { /* fresh store */ }
    for (const r of (await readRunManifest(store)).runs) {
      const m = /^r(\d{3,})$/.exec(r.id);
      if (m) max = Math.max(max, parseInt(m[1]!, 10));
    }
    const n = max + 1;
    await writeCounter(join(store.root, 'next-id'), n);
    return `r${String(n).padStart(3, '0')}`;
  });
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
    /**
     * The canonical judgement, when this run actually judged something (DESIGN §25.7).
     * Omit it for evidence-only runs (a risk map, a fluid trend): the panel treats a
     * missing judgement as "not a delivery check", which is different from "clean".
     */
    judgement?: RunJudgement;
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
      // Read the index, decide the supersede chain and append the entry under ONE
      // lock: the chain depends on what is already there, so a read outside the
      // lock can mark an already-superseded run current (or drop a concurrent
      // run's row from the index).
      const overlay = await readPythonOverlay();
      await ensureDir();
      return withFileLock(join(store.root, MANIFEST), async () => {
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
          // Absent stays absent: "this run did not judge anything" is information the panel
          // needs, and defaulting it to 'not-excluded' would manufacture a clean bill.
          ...(final.judgement ? { judgement: final.judgement } : {}),
          summary: final.summary,
          sourceVersionIds: [...new Set(final.sourceVersionIds ?? [])].filter(Boolean).sort(),
          hasGeometry: parts.length > 0,
          parts: parts.slice().sort(),
          ...(final.subject ? { subject: final.subject } : {}),
          ...(superseded.length ? { supersedes: superseded } : {}),
          ...(Object.keys(placements).length ? { placements } : {}),
          // The user overlay is part of the environment a number came out of, and
          // the worker CAN import from it (that was the user's call). Recording it
          // is what keeps "the same version, the same tool" answerable — an empty
          // list is written too, so absence means "an older run", never "unknown".
          pythonOverlay: {
            packages: overlay.packages.map((p) => `${p.name}==${p.version}${p.override ? ' (overrides locked)' : ''}`),
            overrides: overlay.overrides.map((p) => `${p.name}==${p.version}`),
            digest: overlay.digest,
          },
        };
        await writeFile(join(dir, 'run.json'), JSON.stringify(entry, null, 2));
        for (const olderId of superseded) {
          const older = manifest.runs.find((r) => r.id === olderId);
          if (older) await writeFile(join(store.root, olderId, 'run.json'), JSON.stringify(older, null, 2)).catch(() => {});
        }
        manifest.runs = manifest.runs.filter((r) => r.id !== id).concat(entry);
        await writeJsonAtomic(join(store.root, MANIFEST), manifest);
        return entry;
      });
    },
  };
  return writer;
}
