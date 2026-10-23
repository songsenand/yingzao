// Acceptance for "which version is current" (2026-10-23 audit, FIX-C2).
//
// The question "is this run's evidence stale?" was answered by four hand-written loops
// that disagreed on the one case that matters: a version with no `partId` (everything
// written before parts existed) was folded into a synthetic `p000` by products.ts — so
// two legacy versions superseded each other — and skipped by delivery-audit.ts and by
// both call sites in assembly-check.ts. The same evidence was stale for the panel and
// fresh for the contract check.
//
//   node scripts/accept-newest-per-part.mjs
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { newestVersionPerPart, supersededVersionIds } = await import('../src/host/latest.ts');
const { buildProducts } = await import('../src/host/products.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const v = (id, partId, ts) => ({ id, partId, timestamp: ts, userIntent: id, parentVersion: null, status: 'draft' });

// p1 has three versions; p2 has one; v900/v901 are legacy (no partId).
const versions = [
  v('v001', 'p1', '2026-01-01T00:00:00.000Z'),
  v('v002', 'p1', '2026-01-02T00:00:00.000Z'),
  v('v003', 'p1', '2026-01-03T00:00:00.000Z'),
  v('v010', 'p2', '2026-01-01T12:00:00.000Z'),
  v('v900', undefined, '2026-01-01T00:00:00.000Z'),
  v('v901', undefined, '2026-01-02T00:00:00.000Z'),
  // out-of-order input: the rule must compare timestamps, not array order
  v('v000', 'p2', '2026-01-01T00:00:00.000Z'),
];

// ── the rule ───────────────────────────────────────────────────────────────
const newest = newestVersionPerPart(versions);
check(newest.get('p1') === 'v003', 'newest of p1 is v003 (by timestamp)', String(newest.get('p1')));
check(newest.get('p2') === 'v010', 'newest of p2 is v010, not the last element', String(newest.get('p2')));
check(!newest.has('p000'), 'legacy versions do NOT get a synthetic part (appendix: p000 is a display bucket, not a part)');
check(newest.size === 2, 'only real parts appear in the rule', [...newest.keys()].join(','));

// ── superseded ─────────────────────────────────────────────────────────────
const superseded = supersededVersionIds(versions, ['v001', 'v002', 'v003', 'v900', 'v901', 'v-missing']);
check(superseded.join(',') === 'v001,v002', 'only the superseded real-part versions are flagged', superseded.join(','));
check(!superseded.includes('v900') && !superseded.includes('v901'),
  'two legacy versions never supersede each other');
check(!superseded.includes('v-missing'), 'an id we cannot resolve is not a staleness finding');

// ── the panel agrees with the rule ─────────────────────────────────────────
// products.ts used to compute its own answer; it now calls the shared rule, and this
// asserts the observable consequence: a legacy version cited by a run is NOT stale.
const run = {
  id: 'r001', kind: 'assembly', timestamp: '2026-01-04T00:00:00.000Z', title: 't', status: 'pass',
  summary: '', sourceVersionIds: ['v900', 'v001'], hasGeometry: false, parts: [],
};
const products = buildProducts(versions, [], [run]);
const flat = [...products.parts.flatMap((p) => p.runs), ...products.scene].find((r) => r.id === 'r001');
check(flat !== undefined, 'the run appears in the browse tree');
check((flat.staleVersionIds ?? []).join(',') === 'v001',
  'panel staleness = the shared rule (v001 stale, legacy v900 not)', (flat.staleVersionIds ?? []).join(',') || '(none)');

// ── a merged body expires with its inputs (FIX-C5) ───────────────────────
const { mergedInputVersionIds } = await import('../src/host/latest.ts');
const mergedVersion = {
  id: 'v020', partId: 'p3', timestamp: '2026-01-05T00:00:00.000Z', userIntent: 'merged', parentVersion: null, status: 'draft',
  source: { kind: 'merged', at: '2026-01-05T00:00:00.000Z', from: [{ name: 'a', versionId: 'v001' }, { name: 'b', versionId: 'v010' }, { name: 'c', versionId: null }] },
};
check(mergedInputVersionIds(mergedVersion).join(',') === 'v001,v010', 'merged inputs ignore inline (null) contributors', mergedInputVersionIds(mergedVersion).join(','));
const withMerged = buildProducts([...versions, mergedVersion], [], []);
const mergedProduct = [...withMerged.parts.flatMap((p) => p.versions), ...withMerged.scene].find((x) => x.id === 'v020');
check(mergedProduct?.source === 'merged', 'the panel labels a merged body as merged (not generated)', String(mergedProduct?.source));
check((mergedProduct?.staleMergedInputs ?? []).join(',') === 'v001',
  'a merged body is stale exactly when one of its inputs was replaced', (mergedProduct?.staleMergedInputs ?? []).join(',') || '(none)');

// ── anti-drift: nobody keeps a private copy of the rule ───────────────────
const sources = ['products.ts', 'delivery-audit.ts', 'assembly-check.ts'];
for (const file of sources) {
  const text = await readFile(join(ROOT, 'src', 'host', file), 'utf8');
  const privateLoop = /newestOfPart\.get\(v\.partId\)\s*!==/.test(text) || /newestOfPart\.set\(v\.partId/.test(text);
  check(!privateLoop, `${file} does not re-implement the newest-per-part loop`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
