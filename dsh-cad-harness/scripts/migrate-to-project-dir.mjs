// One-shot migration: `<DSH_HOME>/cad/<basename>-<hash8>/` → `<cwd>/cad-data/`.
//
// The 2026-10-03 user decision (DESIGN §19): per-project artifacts live
// INSIDE the project folder, so deleting the folder deletes the corpus and
// recreating a same-named project in place starts fresh. The legacy hashed
// directories record their cwd in `project.json`; this script moves each
// corpus to its project's `cad-data/`.
//
// Merge semantics (same as the v2.13s migration): a target id that already
// exists is NEVER overwritten — the conflict is reported and the source is
// left in place. Two legacy dirs may map to the SAME cwd (observed:
// microscope4 had two); the merge handles that. Telemetry stays put.
//
// Idempotent: a re-run finds nothing pending and does nothing — which is also
// how you sweep a live session that wrote to the legacy path before its dsh
// restart.
//
//   node scripts/migrate-to-project-dir.mjs [--home <DSH_HOME>] [--check]

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { dshHome, projectsHome } from '../src/host/project.ts';

const argv = process.argv.slice(2);
const check = argv.includes('--check');
const homeIdx = argv.indexOf('--home');
const home = homeIdx >= 0 ? argv[homeIdx + 1] : dshHome();
const MOVED = ['versions', 'runs', 'parts', 'assembly', 'manifest.json'];

let pending = 0;
let conflicts = 0;
const symlinks = [];

/** Move a path, falling back to copy+delete across filesystems. */
function move(from, to) {
  try {
    renameSync(from, to);
    return;
  } catch (e) {
    if (e?.code !== 'EXDEV') { if (e?.code !== 'EROFS' && e?.syscall !== 'rm') throw e; }
    // EXDEV → copy+delete; EROFS (a read-only source, e.g. the sandbox) →
    // copy only and leave the source for a later sweep.
    cpSync(from, to, { recursive: true });
    try { rmSync(from, { recursive: true, force: true }); }
    catch { console.log(`  NOTE  source kept (read-only): ${from}`); }
  }
}

if (!existsSync(projectsHome())) {
  console.log('no legacy corpora directory — nothing to migrate');
  process.exit(0);
}

for (const dir of readdirSync(projectsHome(), { withFileTypes: true })) {
  if (dir.name === 'telemetry') continue;
  const src = join(projectsHome(), dir.name);
  if (lstatSync(src).isSymbolicLink()) {
    symlinks.push(src);
    console.log(`SYMLINK  ${dir.name} → ${readlinkSync(src)}  (left alone; swept below if it dangles)`);
    continue;
  }
  if (!dir.isDirectory()) continue;
  const metaPath = join(src, 'project.json');
  if (!existsSync(metaPath)) {
    console.log(`SKIP  ${dir.name}  (no project.json — not a project corpus)`);
    continue;
  }
  let cwd;
  try { cwd = JSON.parse(readFileSync(metaPath, 'utf8')).cwd; } catch { cwd = undefined; }
  if (!cwd) {
    console.log(`SKIP  ${dir.name}  (project.json has no cwd)`);
    continue;
  }
  const target = join(cwd, 'cad-data');
  console.log(`${check ? 'WOULD MOVE' : 'MOVE   '}  ${dir.name}  →  ${target}`);
  if (check) { pending++; continue; }
  pending++;
  mkdirSync(target, { recursive: true });
  let dirConflicts = 0;
  for (const entry of MOVED) {
    const from = join(src, entry);
    if (!existsSync(from)) continue;
    const to = join(target, entry);
    if (!existsSync(to)) {
      move(from, to);
      continue;
    }
    // merge, refusing to overwrite any existing id
    if (entry === 'manifest.json') {
      const a = readFileSync(from, 'utf8'), b = readFileSync(to, 'utf8');
      if (a === b) { rmSync(from); continue; }
      console.log(`  CONFLICT  manifest.json differs in ${target} — source kept at ${from}`);
      conflicts++; dirConflicts++;
      continue;
    }
    for (const id of readdirSync(from)) {
      const idTo = join(to, id);
      if (existsSync(idTo)) {
        console.log(`  CONFLICT  ${entry}/${id} exists in ${target} — source kept at ${from}/${id}`);
        conflicts++; dirConflicts++;
        continue;
      }
      move(join(from, id), idTo);
    }
  }
  // sweep the legacy dir when nothing was left behind
  const leftovers = readdirSync(src).filter((n) => n !== 'project.json');
  if (dirConflicts === 0 && leftovers.length === 0) {
    try {
      rmSync(src, { recursive: true, force: true });
      console.log(`  swept legacy dir ${src}`);
    } catch {
      console.log(`  legacy dir is read-only — kept; sweep it after the dsh restart (re-run this script)`);
    }
  } else {
    console.log(`  legacy dir kept (${dirConflicts} conflict(s), ${leftovers.length} other file(s)) — resolve and re-run`);
  }
}

// sweep symlinks left dangling by the moves (e.g. a stray alias that pointed
// at a now-migrated legacy dir)
for (const link of symlinks) {
  if (!existsSync(link)) {
    if (!check) rmSync(link);
    console.log(`${check ? 'WOULD REMOVE' : 'REMOVED'}  dangling symlink ${link}`);
  }
}

console.log(`\n${check ? `${pending} corpus dir(s) pending` : `${pending} corpus dir(s) processed`}` +
  (conflicts ? `, ${conflicts} conflict(s) need manual resolution` : ''));
process.exit(conflicts ? 1 : 0);
