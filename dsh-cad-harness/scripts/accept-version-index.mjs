// Acceptance for the version index (2026-10-23 audit, FIX-C3).
//
// The index (`manifest.json`) is an optimisation over `versions/vNNN/`, but it was the
// only thing the panel and every tool read, and it was written in place:
//   * `readManifest` turned invalid JSON into `{ versions: [] }`;
//   * `saveVersion` then wrote that emptiness back plus one row.
// So one torn write looked like "this project has no versions" and erased intent/parent/
// part for every version while the directories sat there intact.
//
//   node scripts/accept-version-index.mjs
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { openVersionStore, saveVersion, readManifest, diagnoseManifest } = await import('../src/host/version.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const root = await mkdtemp(join(tmpdir(), 'cad-index-'));
const store = openVersionStore(root);
const v1 = await saveVersion(store, { scadCode: 'cube(1);', userIntent: 'first', parentVersion: null, partId: 'p001' });
const v2 = await saveVersion(store, { scadCode: 'cube(2);', userIntent: 'second', parentVersion: v1, partId: 'p001' });

// ── baseline ───────────────────────────────────────────────────────────────
let diag = await diagnoseManifest(store);
check(diag.parseError === null && diag.onlyOnDisk.length === 0 && diag.onlyInIndex.length === 0,
  'index and directories agree after two normal saves', JSON.stringify(diag));

// ── 1. index lost entirely ─────────────────────────────────────────────────
await writeFile(join(root, 'manifest.json'), JSON.stringify({ versions: [] }, null, 2));
let manifest = await readManifest(store);
check(manifest.versions.length === 2, 'an EMPTY index is rebuilt from the directories', `${manifest.versions.length} row(s)`);
check(manifest.versions.every((v) => v.recovered === true), 'rebuilt rows are marked recovered (they do not pretend to know intent/parent)');
check(manifest.versions[0].parentVersion === null, 'a recovered row does not invent a parent');

// ── 2. index torn (invalid JSON) ───────────────────────────────────────────
await writeFile(join(root, 'manifest.json'), '{"versions": [ {"id": "v001"');
manifest = await readManifest(store);
check(manifest.versions.length === 2, 'an UNREADABLE index is rebuilt, not treated as empty', `${manifest.versions.length} row(s)`);

// ── 3. the next save persists the healed index ─────────────────────────────
const v3 = await saveVersion(store, { scadCode: 'cube(3);', userIntent: 'third', parentVersion: v2, partId: 'p001' });
const raw = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
check(raw.versions.length === 3, 'the next save writes all three rows, not just the new one', `${raw.versions.length}`);
check(raw.versions.some((v) => v.id === v3), 'and the new version is among them');
// The older rows were recovered, so their intent is the honest placeholder — not "first".
check(raw.versions.find((v) => v.id === v1).userIntent !== 'first',
  'a recovered row says its intent is unknown instead of inventing one',
  raw.versions.find((v) => v.id === v1).userIntent);

// ── 4. index with a valid but PARTIAL list ─────────────────────────────────
const partial = { versions: raw.versions.filter((v) => v.id !== v2) };
await writeFile(join(root, 'manifest.json'), JSON.stringify(partial, null, 2));
manifest = await readManifest(store);
check(manifest.versions.some((v) => v.id === v2), 'a version on disk but missing from the index is surfaced', manifest.versions.map((v) => v.id).join(','));
check(manifest.versions.find((v) => v.id === v2).recovered === true, 'and it is marked recovered');
check(manifest.versions.find((v) => v.id === v1).userIntent === 'unknown (recovered from the directory)',
  'rows the index still knows keep their data (v1 was already recovered by step 2, so it stays honest)');

// ── 5. diagnose is pure: it must not "fix" anything ────────────────────────
await writeFile(join(root, 'manifest.json'), JSON.stringify({ versions: [] }, null, 2));
diag = await diagnoseManifest(store);
check(diag.onlyOnDisk.length === 3 && diag.inIndex.length === 0,
  'diagnose reports the mismatch without rewriting either side', JSON.stringify({ onlyOnDisk: diag.onlyOnDisk.length, inIndex: diag.inIndex.length }));

await rm(root, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
