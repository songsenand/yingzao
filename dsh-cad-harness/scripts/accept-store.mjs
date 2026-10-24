// Acceptance for the read port (T1.1).
//
// The port owns three questions every consumer used to answer for itself:
//   * WHAT is this address, and is it current?  -> resolve()
//   * WHAT does the corpus look like?           -> snapshot() (cached by mtime)
//   * DID anything change?                      -> changes(since) / ETag
//
//   node scripts/accept-store.mjs
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { storeAt } = await import('../src/host/store.ts');
const { buildProductsWire } = await import('../src/host/products.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const tmp = join(ROOT, `.tmp-store-${process.pid}`);
await rm(tmp, { recursive: true, force: true });
await mkdir(join(tmp, 'parts'), { recursive: true });
await mkdir(join(tmp, 'runs'), { recursive: true });

const versions = [
  { id: 'v001', partId: 'p001', timestamp: '2026-01-01T00:00:00.000Z', userIntent: '甲 第一版', parentVersion: null, status: 'draft' },
  { id: 'v002', partId: 'p001', timestamp: '2026-01-02T00:00:00.000Z', userIntent: '甲 第二版', parentVersion: 'v001', status: 'draft' },
  { id: 'v003', partId: 'p002', timestamp: '2026-01-03T00:00:00.000Z', userIntent: '乙 第一版', parentVersion: null, status: 'draft' },
];
const parts = [
  { id: 'p001', name: '甲', nameSource: 'agent', createdAt: '', lastActiveAt: '2026-01-02T00:00:00.000Z', versionIds: ['v001', 'v002'] },
  { id: 'p002', name: '乙', nameSource: 'agent', createdAt: '', lastActiveAt: '2026-01-03T00:00:00.000Z', versionIds: ['v003'] },
];
const runsBase = [
  { id: 'r001', kind: 'printability', timestamp: '2026-01-04T00:00:00.000Z', title: '制造筛查 · 甲', status: 'check', summary: '壁厚 1.0', sourceVersionIds: ['v002'], hasGeometry: false, parts: [] },
  { id: 'r002', kind: 'printability', timestamp: '2026-01-05T00:00:00.000Z', title: '旧的一次', status: 'pass', summary: 'ok', sourceVersionIds: ['v001'], hasGeometry: false, parts: [], supersededBy: 'r001' },
];

const writeJson = (file, value) => writeFile(join(tmp, file), JSON.stringify(value, null, 2));
await writeJson('manifest.json', { schemaVersion: 1, versions });
await writeJson('parts/manifest.json', { schemaVersion: 1, parts });
await writeJson('runs/manifest.json', { schemaVersion: 1, runs: runsBase });
await writeFile(join(tmp, 'notes.stl'), 'solid x\nendsolid x\n');

try {
  const store = storeAt(tmp);

  // ---- snapshot + sequence -------------------------------------------------
  const first = await store.snapshot();
  check(first.wire.parts.length === 2, 'snapshot: two parts', `${first.wire.parts.length}`);
  check(first.seq >= 1, 'snapshot carries a sequence', String(first.seq));
  check(typeof first.stamp === 'string' && first.stamp.length > 0, 'snapshot carries a stamp');

  const c1 = await store.changes(0);
  check(c1.changed === true, 'changes(0): the corpus is newer than "never seen"');
  const c2 = await store.changes(c1.seq);
  check(c2.changed === false, 'changes(current): nothing changed');

  // A second snapshot with an unchanged stamp must be the SAME object (cache hit).
  const second = await store.snapshot();
  check(second.wire === first.wire, 'an unchanged corpus is not rebuilt (same object)');

  // ---- resolve -------------------------------------------------------------
  const v1 = await store.resolve('v001');
  check(v1?.kind === 'version' && v1.partName === '甲', 'resolve v001 -> version of 甲', JSON.stringify(v1?.partId));
  check(v1?.isCurrent === false, 'v001 is NOT current (v002 is newer)');
  const v2 = await store.resolve('v002');
  check(v2?.isCurrent === true, 'v002 IS current');
  const v3 = await store.resolve('v003');
  check(v3?.kind === 'version' && v3.partName === '乙' && v3.isCurrent === true, 'v003 is current for 乙');

  const p1 = await store.resolve('p001');
  check(p1?.kind === 'part' && p1.part.name === '甲', 'resolve p001 -> part 甲');

  const r1 = await store.resolve('r001');
  check(r1?.kind === 'run' && r1.isCurrent === true, 'r001 is current evidence');
  const r2 = await store.resolve('r002');
  check(r2?.kind === 'run' && r2.isCurrent === false, 'a superseded run is NOT current');

  const u1 = await store.resolve('u:notes.stl');
  check(u1?.kind === 'file' && u1.exists === true, 'u:<rel> resolves an existing file');
  const u2 = await store.resolve('u:nope.stl');
  check(u2?.kind === 'file' && u2.exists === false, 'u:<rel> says so when the file is gone');

  check((await store.resolve('v999')) === null, 'an unknown version is null, not a guess');
  check((await store.resolve('nope')) === null, 'an unparseable address is null');

  // ---- change detection ----------------------------------------------------
  // Same size, different content is a stamp change only via mtime — a new run
  // also changes the size, which is the realistic case.
  await writeJson('runs/manifest.json', {
    schemaVersion: 1,
    runs: [...runsBase, { id: 'r003', kind: 'stress', timestamp: '2026-01-06T00:00:00.000Z', title: '应力', status: 'check', summary: '12 MPa', sourceVersionIds: ['v002'], hasGeometry: false, parts: [] }],
  });
  const c3 = await store.changes(c1.seq);
  check(c3.changed === true, 'a new run advances the sequence', `seq ${c1.seq} -> ${c3.seq}`);
  const after = await store.snapshot();
  check(after.wire.runs.length === 3, 'the rebuilt snapshot sees the new run', `${after.wire.runs.length}`);

  // ---- the tree is exactly what the builder produces -----------------------
  const direct = buildProductsWire(versions, parts, after.wire.runs);
  check(
    JSON.stringify(after.wire.parts) === JSON.stringify(direct.parts),
    'the port serves the same wire the builder produces (no second implementation)',
  );
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log(failures ? `\nFAILED (${failures})` : '\nOK');
process.exit(failures ? 1 : 0);
