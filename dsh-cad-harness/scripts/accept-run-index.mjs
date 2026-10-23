// Acceptance for the run index (2026-10-23 audit, FIX-E3).
//
// Every run writes a self-describing `run.json`, and the promise was "an index lost can be
// rebuilt from it" (DESIGN §6.8). Nothing read it: `readRunManifest` returned an empty list
// on any error, so a torn index made 36 runs of history look like an empty project.
//
//   node scripts/accept-run-index.mjs
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { openRunStore, beginRun, listRuns, readRunManifest, diagnoseRunManifest } = await import('../src/host/runs.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const root = await mkdtemp(join(tmpdir(), 'cad-run-index-'));
const store = openRunStore(root);

const a = await beginRun(store, { kind: 'physics', title: 'first' });
await a.commit({ status: 'pass', summary: 'stable', sourceVersionIds: ['v001'] });
const b = await beginRun(store, { kind: 'motion', title: 'second' });
await b.json('report.json', { ok: true });
await b.commit({ status: 'fail', summary: 'collision', sourceVersionIds: ['v001'], judgement: 'excluded' });

let diag = await diagnoseRunManifest(store);
check(diag.parseError === null && diag.onlyOnDisk.length === 0 && diag.onlyInIndex.length === 0,
  'index and run directories agree after two commits', JSON.stringify(diag));

// ── index torn ─────────────────────────────────────────────────────────────
await writeFile(join(store.root, 'manifest.json'), '{"runs": [ {"id": "r001"');
let manifest = await readRunManifest(store);
check(manifest.runs.length === 2, 'an unreadable index is rebuilt from run.json', `${manifest.runs.length}`);
check(manifest.runs.some((r) => r.id === a.id) && manifest.runs.some((r) => r.id === b.id), 'both runs came back');
check(manifest.runs.find((r) => r.id === b.id).judgement === 'excluded',
  'the recovered row keeps its judgement (run.json is self-describing)');

// ── index lost ─────────────────────────────────────────────────────────────
await rm(join(store.root, 'manifest.json'));
manifest = await readRunManifest(store);
check(manifest.runs.length === 2, 'a missing index is rebuilt too', `${manifest.runs.length}`);

// ── index partial ──────────────────────────────────────────────────────────
await writeFile(join(store.root, 'manifest.json'), JSON.stringify({ schemaVersion: 1, runs: manifest.runs.filter((r) => r.id !== b.id) }, null, 2));
const partial = await readRunManifest(store);
check(partial.runs.length === 2 && partial.runs.some((r) => r.id === b.id),
  'a run on disk but missing from the index is surfaced', partial.runs.map((r) => r.id).join(','));
const listed = await listRuns(store);
check(listed[0].timestamp >= listed[1].timestamp, 'the merged list is still newest-first');

// ── diagnose is pure ───────────────────────────────────────────────────────
await writeFile(join(store.root, 'manifest.json'), JSON.stringify({ schemaVersion: 1, runs: [] }, null, 2));
diag = await diagnoseRunManifest(store);
check(diag.onlyOnDisk.length === 2, 'diagnose reports the mismatch without rewriting anything', JSON.stringify(diag.onlyOnDisk));
const raw = JSON.parse(await readFile(join(store.root, 'manifest.json'), 'utf8'));
check(raw.runs.length === 0, 'and the file on disk was not modified by the read');

await rm(root, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
