// Performance guard for `buildProducts` — the payload behind the panel's 3 s poll.
//
// The question "is this run's evidence stale?" is asked once per run AND once per
// merged version. It used to rebuild two full-corpus maps on every call, which made
// the build O(runs × versions): measured 0.58 ms per call at 5 000 versions →
// ~2.9 s for a 5 000-run corpus, on a poll that fires every three seconds.
//
// The fix is structural (build the tables once), so the guard is a wall-clock
// ceiling with a wide margin: the old code lands at ~360 ms for the 2 000/2 000
// corpus below, the fixed code at a few ms.
//
//   node scripts/bench-products.mjs
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { buildProducts } = await import('../src/host/products.ts');

const PARTS = 100;
const VERSIONS_PER_PART = 20;   // 2 000 versions
const RUNS = 2000;

const versions = [];
const parts = [];
const runs = [];
let vn = 0;
for (let p = 0; p < PARTS; p++) {
  const ids = [];
  for (let i = 0; i < VERSIONS_PER_PART; i++) {
    const id = `v${String(++vn).padStart(4, '0')}`;
    ids.push(id);
    versions.push({
      id,
      timestamp: new Date(1_700_000_000_000 + vn * 60_000).toISOString(),
      userIntent: `零件${p} 第 ${i} 版`,
      parentVersion: i ? ids[i - 1] : null,
      status: 'draft',
      partId: `p${p}`,
    });
  }
  parts.push({ id: `p${p}`, name: `零件${p}`, nameSource: 'agent', createdAt: '', lastActiveAt: '', versionIds: ids });
}
for (let r = 0; r < RUNS; r++) {
  const n = 1 + (r % 3);
  const sourceVersionIds = Array.from({ length: n }, (_, k) => versions[(r * 7 + k * 13) % vn].id);
  runs.push({
    id: `r${String(r + 1).padStart(4, '0')}`,
    kind: ['printability', 'motion', 'assembly-check', 'physics'][r % 4],
    timestamp: new Date(1_700_000_000_000 + r * 90_000).toISOString(),
    title: '检查',
    status: 'check',
    summary: '干涉 3 次 · 行程 23.9mm',
    sourceVersionIds,
    hasGeometry: true,
    parts: ['a'],
  });
}

const time = (n) => {
  const t = performance.now();
  let out;
  for (let i = 0; i < n; i++) out = buildProducts(versions, parts, runs);
  return { ms: (performance.now() - t) / n, out };
};
time(3); // warm-up
const { ms, out } = time(5);

const listed = out.parts.reduce((a, p) => a + p.runs.length, 0) + out.scene.length;

// Control: the O(versions)-per-call form the build used to invoke once per run.
// Printing it keeps the number honest — the guard below compares against THIS.
const { supersededVersionIds } = await import('../src/host/latest.ts');
const t0 = performance.now();
for (const r of runs) supersededVersionIds(versions, r.sourceVersionIds);
const legacyMs = performance.now() - t0;
console.log(`INFO  per-run map rebuild alone (the old build's per-run cost): ${legacyMs.toFixed(0)} ms`);
const LIMIT_MS = 250; // old implementation ≈ 360 ms here; fixed ≈ a few ms
const ok = ms < LIMIT_MS;
console.log(
  `${ok ? 'PASS' : 'FAIL'}  buildProducts ${PARTS * VERSIONS_PER_PART} versions / ${RUNS} runs: ` +
  `${ms.toFixed(1)} ms (limit ${LIMIT_MS} ms; listed ${listed})`,
);
process.exit(ok ? 0 : 1);
