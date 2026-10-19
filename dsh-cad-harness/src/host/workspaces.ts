// Discover the CAD corpora that live under one workspace root.
//
// WHY THIS EXISTS. A corpus is addressed by cwd (`<cwd>/cad-data/`, DESIGN §19),
// which means the panel can only ever see the ONE corpus the session sits in.
// A project with several components (`components/<name>/`) or a repo that keeps
// worked examples (`examples/<name>/`) therefore has its other corpora invisible:
// you cannot browse them without opening a session in each of them.
//
// `discoverWorkspaces` is the read-side counterpart: given a root, it finds every
// shallow `<dir>/cad-data` corpus and reports enough about each (parts, versions,
// newest stamp) for a human to pick one in a dropdown. It is deliberately:
//
//   * READ-ONLY — no corpus directory is created, no manifest is rewritten, so
//     asking "what is here?" can never leave a trace;
//   * SHALLOW — depth-capped and skip-listed, so a `node_modules` tree or the
//     plugin's own `lib/` cannot turn a dropdown into a filesystem crawl;
//   * TOLERANT — a corpus whose manifest is missing or corrupt still appears
//     (counted from `versions/`), because being unable to describe a corpus is
//     not a reason to hide it.
//
// It never decides which corpus a session WRITES to. Writes stay bound to the
// session cwd (`projectStoresFor`); this module only answers "what can be viewed".

import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import type { WorkspaceEntry } from '../shared/types.ts';

/** One browsable corpus (shape shared with the panel — see shared/types). */
export type { WorkspaceEntry } from '../shared/types.ts';

/**
 * Directories never worth descending into: build output, dependencies, the
 * corpus's own subdirectories (we test `cad-data` directly rather than walk it),
 * and archive/telemetry zones. Matched by exact name at any level.
 */
const SKIP = new Set([
  'node_modules', 'bin', 'lib', 'dist', 'out', 'renders', 'shots', '.local-archive',
  'python', 'skills', 'presets', 'sandbox', 'verification', 'telemetry', 'tmp',
  'assembly', 'parts', 'runs', 'versions', 'measure', 'frames', 'cad-data',
]);

/** Hard ceilings so a pathological tree cannot hang the endpoint. */
const MAX_DEPTH = 2;
const MAX_DIRS = 400;
const MAX_ENTRIES = 64;

/** Describe one `<cwd>/cad-data` corpus. Never throws. */
async function readCorpus(cwd: string): Promise<Omit<WorkspaceEntry, 'cwd' | 'rel' | 'name'>> {
  const cadData = join(cwd, 'cad-data');
  let versions = 0;
  let parts = 0;
  let latest: string | null = null;

  try {
    const manifest = JSON.parse(await readFile(join(cadData, 'manifest.json'), 'utf8'));
    if (Array.isArray(manifest?.versions)) {
      versions = manifest.versions.length;
      for (const v of manifest.versions) {
        const stamp = v?.timestamp;
        if (typeof stamp === 'string' && (!latest || stamp > latest)) latest = stamp;
      }
    }
  } catch { /* fall through to counting */ }

  if (versions === 0) {
    try {
      versions = (await readdir(join(cadData, 'versions'))).filter((n) => /^v\d{3,}$/i.test(n)).length;
    } catch { /* no versions dir either: still a (empty) corpus */ }
  }

  try {
    const partManifest = JSON.parse(await readFile(join(cadData, 'parts', 'manifest.json'), 'utf8'));
    if (Array.isArray(partManifest?.parts)) parts = partManifest.parts.length;
  } catch { /* parts are optional */ }

  return { parts, versions, latest };
}

/**
 * Every corpus directly under (or one/two levels below) `root`.
 *
 * Ordering is stable and human: the root's own corpus first, then subtrees in
 * path order. A corpus that cannot be read is skipped rather than failing the
 * whole list — one broken folder must not blank the dropdown.
 *
 * @param root - absolute workspace root (a project directory).
 * @returns corpora found, root-first; empty when none exist.
 */
export async function discoverWorkspaces(root: string): Promise<WorkspaceEntry[]> {
  const base = resolve(root);
  const entries: WorkspaceEntry[] = [];
  const seen = new Set<string>();
  const queue: { dir: string; depth: number }[] = [{ dir: base, depth: 0 }];
  let visited = 0;

  while (queue.length > 0 && visited < MAX_DIRS && entries.length < MAX_ENTRIES) {
    const { dir, depth } = queue.shift()!;
    visited += 1;

    const cadData = join(dir, 'cad-data');
    if (seen.size < MAX_ENTRIES && (existsSync(join(cadData, 'manifest.json')) || existsSync(join(cadData, 'versions')))) {
      if (!seen.has(dir)) {
        seen.add(dir);
        try {
          entries.push({
            cwd: dir,
            rel: relative(base, dir) || '.',
            name: basename(dir) || dir,
            ...(await readCorpus(dir)),
          });
        } catch { /* one unreadable corpus must not blank the list */ }
      }
    }

    if (depth >= MAX_DEPTH) continue;

    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (name.startsWith('.') || SKIP.has(name)) continue;
      const child = join(dir, name);
      try {
        if (!(await stat(child)).isDirectory()) continue;
      } catch {
        continue;
      }
      queue.push({ dir: child, depth: depth + 1 });
    }
  }

  // Root first, then path order (deterministic across machines).
  return entries.sort((a, b) => (a.rel === '.' ? -1 : b.rel === '.' ? 1 : a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}
