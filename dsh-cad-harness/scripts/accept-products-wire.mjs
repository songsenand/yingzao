// Acceptance for the compact products payload (T0.3).
//
// `buildProducts` puts a run under EVERY part whose geometry it used — right for
// reading, wrong for the wire: microscope5 stores 69 runs and serialised them 438
// times (211 KB) on a poll that fires every 3 s.
//
// The wire carries each run once (`runs`) plus `runIds` per part; `inflateProducts`
// rebuilds the tree, and `coerceProducts` still accepts the old shape so a page
// that outlives a host restart does not blank itself.
//
//   node scripts/accept-products-wire.mjs
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { buildProducts, buildProductsWire } = await import('../src/host/products.ts');
const { inflateProducts, coerceProducts } = await import('../src/shared/products-wire.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const bytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

// ---- a corpus where one run belongs to two parts -----------------------------
const versions = [
  { id: 'v001', partId: 'p1', timestamp: '2026-01-01T00:00:00Z', userIntent: 'a1', parentVersion: null, status: 'draft' },
  { id: 'v002', partId: 'p2', timestamp: '2026-01-02T00:00:00Z', userIntent: 'b1', parentVersion: null, status: 'draft' },
];
const parts = [
  { id: 'p1', name: '甲', nameSource: 'agent', lastActiveAt: '2026-01-01T00:00:00Z', versionIds: ['v001'] },
  { id: 'p2', name: '乙', nameSource: 'agent', lastActiveAt: '2026-01-02T00:00:00Z', versionIds: ['v002'] },
];
const runs = [
  {
    id: 'r001', kind: 'motion', timestamp: '2026-01-03T00:00:00Z', title: '机构运动 · v001+v002',
    status: 'check', summary: '干涉 3 次', sourceVersionIds: ['v001', 'v002'], hasGeometry: true, parts: ['甲', '乙'],
  },
  {
    id: 'r002', kind: 'printability', timestamp: '2026-01-04T00:00:00Z', title: '制造筛查 · v001',
    status: 'pass', summary: '壁厚 1.4mm', sourceVersionIds: ['v001'], hasGeometry: false, parts: [],
  },
];

const wire = buildProductsWire(versions, parts, runs);
const inflated = buildProducts(versions, parts, runs);

check(wire.runs.length === 2, 'the wire carries each run exactly once', `${wire.runs.length} runs`);
const p1 = wire.parts.find((p) => p.id === 'p1');
const p2 = wire.parts.find((p) => p.id === 'p2');
check(p1?.runIds.length === 2, 'the two-part run is listed under p1', JSON.stringify(p1?.runIds));
check(p2?.runIds.length === 1, 'the two-part run is listed under p2', JSON.stringify(p2?.runIds));
check(wire.sceneRunIds.length === 1 && wire.sceneRunIds[0] === 'r001', 'a multi-part run stays in the cross-part bucket');
check(!('runs' in (p1 ?? {})), 'a part carries runIdS, not run objects');

const round = inflateProducts(wire);
const roundP1 = round.parts.find((p) => p.id === 'p1');
check(
  roundP1?.runs.map((r) => r.id).join(',') === 'r002,r001',
  'inflation restores the per-part order (newest first)',
  roundP1?.runs.map((r) => r.id).join(','),
);
check(wire.parts[0].id === 'p2', 'parts stay ordered by lastActiveAt (newest first)', wire.parts.map((p) => p.id).join(','));
check(
  JSON.stringify(round) === JSON.stringify(inflated),
  'inflate(wire) is byte-identical to buildProducts()',
);
check(
  JSON.stringify(coerceProducts(inflated)) === JSON.stringify(inflated),
  'coerceProducts still accepts the OLD inflated shape (compat)',
);
check(
  coerceProducts({ ...wire }).parts.length === 2,
  'coerceProducts inflates the WIRE shape',
);

// ---- the real corpus --------------------------------------------------------
try {
  const dataRoot = join(ROOT, '..', 'examples', 'microscope5', 'cad-data');
  const [vm, pm, rm] = await Promise.all(
    ['manifest.json', 'parts/manifest.json', 'runs/manifest.json'].map(async (f) =>
      JSON.parse(await readFile(join(dataRoot, f), 'utf8'))),
  );
  const w = buildProductsWire(vm.versions, pm.parts, rm.runs);
  const old = buildProducts(vm.versions, pm.parts, rm.runs);
  const listed = old.parts.reduce((a, p) => a + p.runs.length, 0) + old.scene.length;
  const stored = rm.runs.length;
  check(w.runs.length === stored, `microscope5: wire stores all ${stored} runs once`, `${w.runs.length}`);
  check(listed > stored, `the inflated tree still lists ${listed} (duplication is intentional there)`);
  const wB = bytes(w);
  const iB = bytes(old);
  check(wB < iB * 0.5, `wire is less than half the inflated payload`, `${(wB / 1024).toFixed(0)} KB vs ${(iB / 1024).toFixed(0)} KB`);
} catch (e) {
  console.log(`SKIP  real-corpus check (${String(e?.message ?? e).split('\n')[0]})`);
}

console.log(failures ? `\nFAILED (${failures})` : '\nOK');
process.exit(failures ? 1 : 0);
