// One-shot migration: the plugin's global `data/` corpus → per-project storage.
//
// Before project scoping every version/run/part lived in ONE directory next to
// the plugin (`<pluginRoot>/data`), which is why a new project listed the old
// project's parts. That corpus was produced by sessions rooted in the workspace
// the plugin is checked out in, so it belongs to that workspace's project.
//
// What moves where:
//   data/{versions,runs,parts,assembly,manifest.json}  → <DSH_HOME>/cad/<key>/
//   data/usage/usage.jsonl                             → <DSH_HOME>/cad/telemetry/
//   data/bench/                                        stays (plugin research
//                                                        artifact, not a design)
//
// Idempotent: a second run finds no legacy directory and does nothing.
//
//   node scripts/migrate-to-projects.mjs [--cwd <project dir>] [--check]
//
//   --cwd    the project the legacy corpus belongs to
//            (default: the workspace containing this checkout, i.e. `<plugin>/..`)
//   --check  report what would happen; exit 1 when something is still pending

import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureProjectDir, projectStores, telemetryRoot } from '../src/host/project.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..');
/** Where the old global corpus lived, and where it may still linger. */
const LEGACY = join(PLUGIN_ROOT, 'data');

const argv = process.argv.slice(2);
const check = argv.includes('--check');
const cwdArg = argv.indexOf('--cwd');
const projectCwd = resolve(cwdArg >= 0 ? (argv[cwdArg + 1] ?? '.') : join(PLUGIN_ROOT, '..'));

const project = projectStores(projectCwd);
const telemetry = telemetryRoot();
const MOVED = ['versions', 'runs', 'parts', 'assembly', 'manifest.json'];

/** Move a path, falling back to copy+delete across filesystems. */
function move(from, to) {
  try {
    renameSync(from, to);
  } catch (e) {
    if (e?.code !== 'EXDEV') throw e;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/** Read a file, or `null` when it is absent/unreadable (a merge must not throw). */
const readFileSyncSafe = (path) => {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
};

const countFiles = (dir) => {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(join(dir, entry.name));
    else n++;
  }
  return n;
};

console.log(`legacy corpus : ${LEGACY}${existsSync(LEGACY) ? '' : '  (absent)'}`);
console.log(`project cwd   : ${project.cwd}`);
console.log(`project store : ${project.root}`);
console.log(`telemetry     : ${telemetry}`);

if (!existsSync(LEGACY)) {
  console.log('\nnothing to migrate — the legacy directory is gone (already migrated).');
  process.exit(0);
}

const present = MOVED.filter((name) => existsSync(join(LEGACY, name)));
const usageSrc = join(LEGACY, 'usage', 'usage.jsonl');

/**
 * Merge one legacy entry into the project store, entry by entry.
 *
 * Drift is expected, not exceptional: until the running dsh is restarted it
 * still holds the OLD plugin code and keeps writing to the legacy paths, so a
 * second run must pick up whatever appeared in between. Anything that already
 * exists at the destination is a genuine conflict (two designs, one id) and is
 * reported instead of overwritten.
 */
function merge(name) {
  const from = join(LEGACY, name);
  const to = join(project.root, name);
  if (!statSync(from).isDirectory()) {
    if (existsSync(to)) return { conflicts: [name], moved: 0 };
    move(from, to);
    return { conflicts: [], moved: 1 };
  }
  mkdirSync(to, { recursive: true });
  let moved = 0;
  const conflicts = [];
  for (const entry of readdirSync(from)) {
    const dest = join(to, entry);
    if (existsSync(dest)) conflicts.push(`${name}/${entry}`);
    else { move(join(from, entry), dest); moved++; }
  }
  rmSync(from, { recursive: true, force: true });
  return { conflicts, moved };
}

/** Version manifests are append-only lists of versions: merge by id. */
function mergeVersionManifest() {
  const from = join(LEGACY, 'manifest.json');
  const to = join(project.root, 'manifest.json');
  const legacy = JSON.parse(readFileSyncSafe(from) ?? '{"versions":[]}');
  const current = JSON.parse(readFileSyncSafe(to) ?? '{"versions":[]}');
  const known = new Set((current.versions ?? []).map((v) => v.id));
  const added = (legacy.versions ?? []).filter((v) => !known.has(v.id));
  if (added.length === 0) return { conflicts: [], moved: 0 };
  current.versions = [...(current.versions ?? []), ...added];
  writeFileSync(to, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  rmSync(from, { force: true });
  return { conflicts: [], moved: added.length };
}

const summary = present.map((name) => {
  const from = join(LEGACY, name);
  const files = statSync(from).isDirectory() ? countFiles(from) : 1;
  const dest = join(project.root, name);
  const into = existsSync(dest) ? ' (merge into the existing store)' : '';
  return `  ${name.padEnd(14)} → ${project.root}${into}  (${files} file${files === 1 ? '' : 's'})`;
});
if (existsSync(usageSrc)) summary.push(`  usage/usage.jsonl → append to ${telemetry}`);

console.log(`\n${check ? 'would move:' : 'moving:'}`);
console.log(summary.join('\n'));

if (check) {
  console.log('\n(--check: nothing written; run without --check to migrate)');
  process.exit(1);
}

mkdirSync(project.root, { recursive: true });
mkdirSync(telemetry, { recursive: true });

const conflicts = [];
let moved = 0;
for (const name of present) {
  if (name === 'manifest.json') {
    const r = mergeVersionManifest();
    moved += r.moved;
    conflicts.push(...r.conflicts);
    continue;
  }
  const r = merge(name);
  moved += r.moved;
  conflicts.push(...r.conflicts);
}
console.log(`\nmoved ${moved} entr${moved === 1 ? 'y' : 'ies'}.`);
if (conflicts.length > 0) {
  console.error(`REFUSING to overwrite ${conflicts.length} existing entr${conflicts.length === 1 ? 'y' : 'ies'}:`);
  for (const c of conflicts.slice(0, 20)) console.error(`  ${c}`);
  if (conflicts.length > 20) console.error(`  … and ${conflicts.length - 20} more`);
  console.error('Both sides own that id — merge by hand; nothing was overwritten.');
}

// Telemetry is append-only, so a re-run never loses rows written after the
// first pass — dedupe by the record itself, which is timestamped.
if (existsSync(usageSrc)) {
  const target = join(telemetry, 'usage.jsonl');
  const seen = new Set((readFileSyncSafe(target) ?? '').split('\n').filter(Boolean));
  const rows = (readFileSyncSafe(usageSrc) ?? '').split('\n').filter((line) => line && !seen.has(line));
  if (rows.length > 0) appendFileSync(target, `${rows.join('\n')}\n`, 'utf8');
  rmSync(join(LEGACY, 'usage'), { recursive: true, force: true });
  console.log(`appended ${rows.length} usage row${rows.length === 1 ? '' : 's'}.`);
}

// The identity stamp belongs to the same "first write" rule as any other tool:
// a migrated project must be self-describing like a freshly generated one.
await ensureProjectDir(project);

const leftovers = readdirSync(LEGACY);
console.log(`\nmigrated. leftovers in ${LEGACY}: ${leftovers.join(', ') || '(none)'}`);
process.exit(conflicts.length > 0 ? 2 : 0);
