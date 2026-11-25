// Python-only branch coverage for check_assembly (the TS oracle was retired
// 2026-11-25). Ported from the synthetic manifest of the deleted parity test:
// coaxial, spring-preload/behaviour, snap-fit, all motion-clearance evidence
// outcomes, unknown L0 checks, unresolvable addresses, undeclared adjacency and
// stock skip. Asserts the produced verdicts, not parity with a second engine.
//
//   node scripts/accept-check-assembly-branches.mjs

import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAssemblyCheck } from '../src/host/assembly-check.ts';
import { pythonRuntimeRoot } from '../src/host/python-runtime.ts';
import { listVersions, openVersionStore } from '../src/host/version.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = resolve(HERE, '..');
const REPO = resolve(PLUGIN, '..');
const argOf = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const localRuntime = join(REPO, '.tmp-measure-runtime');
const explicitRuntime = argOf('--runtime', process.env.DSH_CAD_PYTHON_ROOT?.trim());
if (explicitRuntime) process.env.DSH_CAD_PYTHON_ROOT = resolve(explicitRuntime);
else if (existsSync(join(localRuntime, 'venv'))) process.env.DSH_CAD_PYTHON_ROOT = localRuntime;
const venvPython = process.platform === 'win32'
  ? join(pythonRuntimeRoot(), 'venv', 'Scripts', 'python.exe')
  : join(pythonRuntimeRoot(), 'venv', 'bin', 'python');
if (!existsSync(venvPython)) {
  console.error(`no venv python at ${venvPython} — provision the runtime first (or pass --runtime <dir>)`);
  process.exit(2);
}
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const store = openVersionStore(join(PLUGIN, 'data'));
const versions = await listVersions(store);
console.log(`check_assembly branches (store: ${store.root}, ${versions.length} versions)\n`);

// --- 3. a synthetic manifest over every operator ------------------------------
console.log('\n--- synthetic manifest (every operator) ---');
// Two versions of the SAME part, so one run can cite current geometry and another
// can cite superseded geometry (the staleness rule).
const byPart = new Map();
for (const version of versions) {
  if (!version.partId) continue;
  const list = byPart.get(version.partId) ?? [];
  list.push(version);
  byPart.set(version.partId, list);
}
const twoVersionPart = [...byPart.values()].find((list) => list.length >= 2);
const versionPool = new Map();
for (const version of versions) {
  if (version.id === 'v001' || version.id === 'v003' || version.id === 'v006') versionPool.set(version.id, version);
}
const holderVersion = versionPool.get('v001') ?? versions[0];
const pinVersion = versionPool.get('v003') ?? versions[1] ?? versions[0];
const thirdVersion = versionPool.get('v006') ?? versions[2] ?? versions[0];
if (!holderVersion || !pinVersion || !thirdVersion) {
  console.log('SKIP  synthetic manifest — the fixture store needs at least three versions');
} else {
  const currentCitation = twoVersionPart ? [twoVersionPart[1].id] : [];
  const staleCitation = twoVersionPart ? [twoVersionPart[0].id] : [];
  const dir = await mkdtemp(join(REPO, '.tmp-check-parity-'));
  const manifest = {
    schemaVersion: 1,
    name: 'parity-synthetic',
    root: {
      id: 'root', name: 'parity root', kind: 'assembly',
      children: [
        { id: 'holder', name: 'holder', kind: 'part', version: holderVersion.id },
        { id: 'pin', name: 'pin', kind: 'part', version: pinVersion.id, transform: { translate: [3, 0, 0] } },
        { id: 'ghost', name: 'ghost (declared by nothing)', kind: 'part', version: thirdVersion.id, transform: { translate: [4, 0, 0] } },
        { id: 'bought', name: 'bought in', kind: 'part', source: 'stock' },
      ],
      interfaces: [
        { id: 'if-distance', a: 'holder.轴孔', b: 'pin.轴径', type: '间隙', severity: 'hard', tolerance: { min: 0, max: 100 } },
        { id: 'if-clearance', a: 'holder.轴孔', b: 'pin.轴径', type: '紧固', severity: 'hard', tolerance: { min: 0, max: 0.5 } },
        { id: 'if-clearance-intent', a: 'holder.轴孔', b: 'pin.轴径', type: '紧固', severity: 'intent' },
        { id: 'if-coax', a: 'holder.轴孔', b: 'pin.轴径', type: '贴合', severity: 'hard', check: 'coaxial', tolerance: { min: 0, max: 0.5 } },
        { id: 'if-spring', a: 'holder.轴孔', b: 'pin.轴径', type: '弹簧', severity: 'hard', check: 'spring-preload', params: { freeLengthMm: 10, stiffnessNPerMm: 2 } },
        { id: 'if-spring-noparams', a: 'holder.轴孔', b: 'pin.轴径', type: '弹簧', severity: 'hard', check: 'spring-preload' },
        { id: 'if-spring-behaviour-pass', a: 'holder.轴孔', b: 'pin.轴径', type: '弹簧', severity: 'hard', check: 'spring-behaviour',
          elastic: { direction: 'compression', freeLengthMm: 40, stiffnessNPerMm: 2, solidHeightMm: 20, forceBudgetN: 100, stiffnessTolerancePct: 20, source: 'catalog' } },
        { id: 'if-spring-behaviour-no-budget', a: 'holder.轴孔', b: 'pin.轴径', type: '弹簧', severity: 'hard', check: 'spring-behaviour',
          elastic: { direction: 'compression', freeLengthMm: 40, stiffnessNPerMm: 2, solidHeightMm: 20 } },
        { id: 'if-spring-behaviour-travel-over', a: 'holder.轴孔', b: 'pin.轴径', type: '弹簧', severity: 'hard', check: 'spring-behaviour',
          elastic: { direction: 'compression', freeLengthMm: 40, stiffnessNPerMm: 2, solidHeightMm: 20, requiredTravelMm: 4, forceBudgetN: 20 } },
        { id: 'if-spring-standard-override', a: 'holder.轴孔', b: 'pin.轴径', type: '弹簧', severity: 'hard', check: 'spring-behaviour',
          elastic: { standardId: 'comp-od5.4-w0.6-l30', direction: 'compression', freeLengthMm: 40, stiffnessNPerMm: 2, solidHeightMm: 20, requiredTravelMm: 4, forceBudgetN: 20 } },
        { id: 'if-spring-behaviour-clash', a: 'holder.轴孔', b: 'pin.轴径', type: '弹簧', severity: 'hard', check: 'spring-behaviour',
          elastic: { direction: 'compression', freeLengthMm: 40, stiffnessNPerMm: 2, solidHeightMm: 35, forceBudgetN: 100 } },
        { id: 'if-spring-behaviour-stretched', a: 'holder.轴孔', b: 'pin.轴径', type: '弹簧', severity: 'hard', check: 'spring-behaviour',
          elastic: { direction: 'compression', freeLengthMm: 20, stiffnessNPerMm: 2, forceBudgetN: 100 } },
        { id: 'if-spring-behaviour-no-direction', a: 'holder.轴孔', b: 'pin.轴径', type: '弹簧', severity: 'hard', check: 'spring-behaviour',
          elastic: { freeLengthMm: 40, stiffnessNPerMm: 2, solidHeightMm: 20, forceBudgetN: 100 } },
        { id: 'if-snap-heavy', a: 'holder.轴孔', b: 'pin.轴径', type: '卡扣', severity: 'hard', check: 'snap-fit',
          elastic: { behavior: 'snap-fit', lobeCount: 4, lobeWidthMm: 8.9, lobeThicknessMm: 0.8, leverArmMm: 4.0, radialInterferenceMm: 0.125, youngModulusMPa: 3500, leadAngleDeg: 45, frictionCoeff: 0.3, forceBudgetN: 20, maxStrainPct: 2, retentionLoadN: 5, source: 'catalog' } },
        { id: 'if-snap-light', a: 'holder.轴孔', b: 'pin.轴径', type: '卡扣', severity: 'hard', check: 'snap-fit',
          elastic: { behavior: 'snap-fit', lobeCount: 3, lobeWidthMm: 7.4, lobeThicknessMm: 0.8, leverArmMm: 3.3, radialInterferenceMm: 0.075, youngModulusMPa: 3500, leadAngleDeg: 45, frictionCoeff: 0.3, forceBudgetN: 50, maxStrainPct: 2, retentionLoadN: 5 } },
        { id: 'if-snap-near', a: 'holder.轴孔', b: 'pin.轴径', type: '卡扣', severity: 'hard', check: 'snap-fit',
          elastic: { behavior: 'snap-fit', lobeCount: 4, lobeWidthMm: 8.9, lobeThicknessMm: 0.8, leverArmMm: 4.0, radialInterferenceMm: 0.125, youngModulusMPa: 3500, leadAngleDeg: 45, frictionCoeff: 0.3, forceBudgetN: 65, maxStrainPct: 2, retentionLoadN: 5 } },
        { id: 'if-snap-unknown', a: 'holder.轴孔', b: 'pin.轴径', type: '卡扣', severity: 'hard', check: 'snap-fit',
          elastic: { behavior: 'snap-fit', lobeCount: 4, lobeWidthMm: 8.9, lobeThicknessMm: 0.8, leverArmMm: 4.0, radialInterferenceMm: 0.125, youngModulusMPa: 3500, forceBudgetN: 20, maxStrainPct: 2, retentionLoadN: 5 } },
        { id: 'if-snap-selflock', a: 'holder.轴孔', b: 'pin.轴径', type: '卡扣', severity: 'hard', check: 'snap-fit',
          elastic: { behavior: 'snap-fit', lobeCount: 4, lobeWidthMm: 8.9, lobeThicknessMm: 0.8, leverArmMm: 4.0, radialInterferenceMm: 0.125, youngModulusMPa: 3500, leadAngleDeg: 70, frictionCoeff: 0.5, forceBudgetN: 20 } },
        { id: 'if-snap-missing', a: 'holder.轴孔', b: 'pin.轴径', type: '卡扣', severity: 'hard', check: 'snap-fit' },
        { id: 'if-motion-uncited', a: 'holder.轴孔', b: 'pin.轴径', type: '转动副', severity: 'hard', tolerance: { min: 0, max: 100 } },
        { id: 'if-motion-ok', a: 'holder.轴孔', b: 'pin.轴径', type: '滑动副', severity: 'hard', params: { runId: 'run-motion-ok' } },
        { id: 'if-motion-superseded', a: 'holder.轴孔', b: 'pin.轴径', type: '滑动副', severity: 'hard', tolerance: { min: 0, max: 100 }, params: { runId: 'run-motion-superseded' } },
        { id: 'if-motion-stale', a: 'holder.轴孔', b: 'pin.轴径', type: '滑动副', severity: 'hard', params: { runId: 'run-motion-stale' } },
        { id: 'if-motion-missing', a: 'holder.轴孔', b: 'pin.轴径', type: '滑动副', severity: 'hard', params: { runId: 'run-nope' } },
        { id: 'if-motion-wrongkind', a: 'holder.轴孔', b: 'pin.轴径', type: '滑动副', severity: 'hard', params: { runId: 'run-physics' } },
        { id: 'if-motion-failed', a: 'holder.轴孔', b: 'pin.轴径', type: '滑动副', severity: 'hard', params: { runId: 'run-motion-fail' } },
        { id: 'if-pending', a: 'holder.轴孔', b: 'pin.轴径', type: '弹簧', severity: 'hard' },
        { id: 'if-unknown-l0', a: 'holder.轴孔', b: 'pin.轴径', type: '贴合', severity: 'hard', check: 'teleport' },
        { id: 'if-missing-datum', a: 'holder.没有这个', b: 'pin.轴径', type: '贴合', severity: 'hard' },
        // NOTE: a malformed address ("holderonly") is rejected by the manifest
        // VALIDATOR, so that defensive branch in resolveEndpoint is unreachable from
        // a loadable manifest — it is not tested here because it cannot occur.
        { id: 'if-wrong-owner', a: 'ghost.轴孔', b: 'pin.轴径', type: '贴合', severity: 'hard' },
      ],
    },
  };
  const manifestPath = join(dir, 'synthetic.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const runs = [
    { id: 'run-motion-ok', kind: 'motion', status: 'pass', summary: 'stroke 12mm', sourceVersionIds: currentCitation },
    { id: 'run-motion-superseded', kind: 'motion', status: 'pass', summary: 'stroke 12mm', supersededBy: 'run-motion-ok', sourceVersionIds: currentCitation },
    { id: 'run-motion-stale', kind: 'motion', status: 'pass', summary: 'stroke 12mm', sourceVersionIds: staleCitation },
    { id: 'run-motion-fail', kind: 'motion', status: 'fail', summary: 'jam at 6mm', sourceVersionIds: currentCitation },
    { id: 'run-physics', kind: 'physics', status: 'pass', summary: 'rests stably', sourceVersionIds: currentCitation },
  ];
  // Prove the synthetic manifest actually reaches the branches it was written for,
  // so a future "all skipped" cannot masquerade as coverage.
  const report = await runAssemblyCheck(store, manifestPath, { runs });
  const kinds = report.results.map((r) => `${r.check}:${r.verdict}`);
  check(report.results.find((r) => r.interfaceId === 'if-clearance')?.check === 'diameter-match',
    'a 紧固 interface reports the DERIVED diameter-match operator, not distance',
    JSON.stringify(report.results.find((r) => r.interfaceId === 'if-clearance')));
  check(report.results.find((r) => r.interfaceId === 'if-distance')?.check === 'distance',
    'a 间隙 interface still reports distance',
    JSON.stringify(report.results.find((r) => r.interfaceId === 'if-distance')));
  for (const [label, wanted] of [
    ['a spring without parameters is skipped with the missing inputs named', report.results.some((r) => r.interfaceId === 'if-pending' && r.verdict === 'skipped' && r.detail.includes('spring-behaviour needs'))],
    ['spring-behaviour pass with a user budget and a force band', report.results.some((r) => r.interfaceId === 'if-spring-behaviour-pass' && r.verdict === 'pass' && r.elastic?.forceBandN?.length === 2)],
    ['spring-behaviour reports a positive force inside its band and all declared checks OK', report.results.some((r) => r.interfaceId === 'if-spring-behaviour-pass' && r.elastic !== undefined && r.elastic.forceN > 0 && r.elastic.forceBandN !== undefined && r.elastic.forceBandN[0] <= r.elastic.forceN && r.elastic.forceN <= r.elastic.forceBandN[1] && r.elastic.checks.direction === 'ok' && r.elastic.checks.solidHeight === 'ok' && r.elastic.checks.forceBudget === 'ok')],
    ['spring-behaviour always exposes an order-of-magnitude band', report.results.some((r) => r.interfaceId === 'if-spring-behaviour-pass' && r.elastic !== undefined && r.elastic.forceDecadeN[0] <= Math.abs(r.elastic.forceN) && Math.abs(r.elastic.forceN) <= r.elastic.forceDecadeN[1])],
    ['spring-behaviour without a budget is skipped, not passed', report.results.some((r) => r.interfaceId === 'if-spring-behaviour-no-budget' && r.verdict === 'skipped')],
    ['spring-behaviour checks the force at the travel endpoint, not only the preload', report.results.some((r) => r.interfaceId === 'if-spring-behaviour-travel-over' && r.verdict === 'hard-violation' && r.elastic?.forceN === 18.7464 && r.elastic?.forceAtTravelN === 26.7464 && r.elastic?.checks.forceBudget === 'violation')],
    ['a standardId fills the catalog and explicit fields still win', report.results.some((r) => r.interfaceId === 'if-spring-standard-override' && r.elastic?.standardId === 'comp-od5.4-w0.6-l30' && r.elastic?.freeLengthMm === 40 && r.elastic?.stiffnessNPerMm === 2 && r.elastic?.forceAtTravelN === 26.7464)],
    ['spring-behaviour below solid height is a hard violation', report.results.some((r) => r.interfaceId === 'if-spring-behaviour-clash' && r.verdict === 'hard-violation')],
    ['a compression spring that is stretched is a hard violation', report.results.some((r) => r.interfaceId === 'if-spring-behaviour-stretched' && r.verdict === 'hard-violation')],
    ['an undeclared direction cannot pass even with a budget', report.results.some((r) => r.interfaceId === 'if-spring-behaviour-no-direction' && r.verdict === 'intent-flag' && r.elastic?.checks.direction === 'unknown')],
    ['snap-fit heavy is over the insertion budget', report.results.some((r) => r.interfaceId === 'if-snap-heavy' && r.verdict === 'hard-violation' && r.snapFit?.worst?.check === 'insertion')],
    ['snap-fit light passes with the same user-declared criteria', report.results.some((r) => r.interfaceId === 'if-snap-light' && r.verdict === 'pass')],
    ['snap-fit near the insertion budget is an intent flag, not a pass', report.results.some((r) => r.interfaceId === 'if-snap-near' && r.verdict === 'intent-flag' && r.snapFit?.checks.some((c) => c.check === 'insertion' && c.verdict === 'near') && r.detail.includes('near the limit'))],
    ['snap-fit without lead/friction cannot judge insertion', report.results.some((r) => r.interfaceId === 'if-snap-unknown' && r.verdict === 'intent-flag' && r.snapFit?.checks.some((c) => c.check === 'insertion' && c.verdict === 'unknown'))],
    ['snap-fit self-lock is a hard violation', report.results.some((r) => r.interfaceId === 'if-snap-selflock' && r.verdict === 'hard-violation' && r.snapFit?.selfLocking === true)],
    ['snap-fit without beam geometry is skipped with the missing names', report.results.some((r) => r.interfaceId === 'if-snap-missing' && r.verdict === 'skipped' && r.detail.includes('snap-fit needs'))],
    ['an unknown L0 check is skipped', kinds.includes('teleport:skipped')],
    ['a motion claim without a run is a pass with a warning', report.results.some((r) => r.interfaceId === 'if-motion-uncited' && r.verdict === 'pass' && r.detail.includes('motion half NOT evidenced'))],
    ['a missing run is a hard violation', report.results.some((r) => r.interfaceId === 'if-motion-missing' && r.verdict === 'hard-violation')],
    ['a non-motion run is a hard violation', report.results.some((r) => r.interfaceId === 'if-motion-wrongkind' && r.verdict === 'hard-violation')],
    ['a failed run is a hard violation', report.results.some((r) => r.interfaceId === 'if-motion-failed' && r.verdict === 'hard-violation')],
    ['a cited green run is evidenced (superseded noted)', report.results.some((r) => r.interfaceId === 'if-motion-superseded' && r.verdict === 'pass' && r.detail.includes('SUPERSEDED'))],
    ['unresolvable addresses are skipped, not thrown', report.results.filter((r) => r.verdict === 'skipped').length >= 3],
    ['the undeclared part is discovered', report.undeclared.some((pair) => pair.partA === 'ghost' || pair.partB === 'ghost')],
    ['a stock part is skipped with a warning', report.partWarnings.some((w) => w.partId === 'bought' && w.messages[0].includes('stock part'))],
  ]) check(wanted, `synthetic: ${label}`);
}

console.log(`${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
