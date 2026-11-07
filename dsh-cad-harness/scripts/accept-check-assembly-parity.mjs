// Parity acceptance for the `check_assembly` migration.
//
// WHAT THIS PROVES: the contract half of check_assembly now lives in the worker, and
// it produces the SAME verdicts, the SAME numbers and the SAME detail strings as the
// TypeScript implementation it replaced. The TS function stays as
// `runAssemblyCheckInTs` precisely so this comparison can exist; without it, "the
// migration changed nothing" would be an assertion rather than a measurement.
//
// Compared, field by field (deep):
//   results     — every operator, verdict, measured value, expected block, detail text
//   undeclared  — the discovered near/interfering pairs
//   summary / overallStatus / partWarnings
// `checkedAt` is excluded: it is a timestamp, not a result.
//
// The synthetic manifest exists because the fixture manifests do not exercise every
// operator: it adds coaxial, spring-preload, all five motion-clearance evidence
// outcomes, an unimplemented L1 check, an unknown L0 check, two unresolvable
// addresses, and a third part that nothing declares (the undeclared path).
//
//   node scripts/accept-check-assembly-parity.mjs [--runtime <dir>]

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAssemblyCheck, runAssemblyCheckInTs } from '../src/host/assembly-check.ts';
import { listVersions, openVersionStore } from '../src/host/version.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = resolve(HERE, '..');
const REPO = resolve(PLUGIN, '..');
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
process.env.DSH_CAD_PYTHON_ROOT = resolve(argOf('--runtime', join(REPO, '.tmp-measure-runtime')));

const venvPython = process.platform === 'win32'
  ? join(process.env.DSH_CAD_PYTHON_ROOT, 'venv', 'Scripts', 'python.exe')
  : join(process.env.DSH_CAD_PYTHON_ROOT, 'venv', 'bin', 'python');
if (!existsSync(venvPython)) {
  console.error(`no venv python at ${venvPython} — provision the runtime first (or pass --runtime <dir>)`);
  process.exit(2);
}

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

/**
 * First structural difference between two JSON values, as a path + both sides.
 *
 * Both sides are the JSON round-trip of the report (`compareManifest` normalises
 * before calling this), because that is the artifact under comparison.
 */
const diff = (a, b, path = '$') => {
  if (a === b) return null;
  if (typeof a !== typeof b) return `${path}: ${typeof a} ${JSON.stringify(a)} vs ${typeof b} ${JSON.stringify(b)}`;
  if (a === null || b === null || typeof a !== 'object') {
    return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  }
  const arrayA = Array.isArray(a);
  if (arrayA !== Array.isArray(b)) return `${path}: array vs object`;
  const keysA = arrayA ? a.map((_, i) => String(i)) : Object.keys(a);
  const keysB = arrayA ? b.map((_, i) => String(i)) : Object.keys(b);
  if (keysA.length !== keysB.length || keysA.some((k) => !keysB.includes(k))) {
    return `${path}: keys [${keysA.join(',')}] vs [${keysB.join(',')}]`;
  }
  for (const key of keysA) {
    const nested = diff(a[key], b[key], `${path}.${key}`);
    if (nested) return nested;
  }
  return null;
};

/** Compare both paths on one manifest; returns null when they agree. */
const compareManifest = async (store, manifestPath, runs) => {
  const mine = await runAssemblyCheck(store, manifestPath, { runs });
  const oracle = await runAssemblyCheckInTs(store, manifestPath, { runs });
  // Compare what would be WRITTEN, not what is in memory: an `expected: undefined`
  // key is not the same object as an absent key, but it is the same report on disk
  // (saveAssemblyReport JSON.stringify's it). Without this the comparison fails on
  // that artifact rather than on a real difference.
  const strip = ({ checkedAt, ...rest }) => JSON.parse(JSON.stringify(rest));
  return diff(strip(mine), strip(oracle));
};

const store = openVersionStore(join(PLUGIN, 'data'));
const versions = await listVersions(store);
console.log(`check_assembly parity  (store: ${store.root}, ${versions.length} versions)\n`);

// --- 1. the fixture manifests -------------------------------------------------
console.log('--- fixture manifests ---');
const fixtureDir = join(PLUGIN, 'data', 'assembly');
const fixtures = (await readdir(fixtureDir)).filter((name) => name.endsWith('.json') && !name.includes('report'));
let fixtureCount = 0;
for (const name of fixtures.sort()) {
  const manifestPath = join(fixtureDir, name);
  const difference = await compareManifest(store, manifestPath, []);
  fixtureCount++;
  check(difference === null, `${name}: worker and oracle agree`, difference ?? '');
}

// --- 2. corpus manifests -----------------------------------------------------
console.log('\n--- corpus manifests ---');
const candidates = [
  ['examples/microscope2/cad-data', 'examples/microscope2/cad-data/assembly/assembly.json'],
  ['examples/microscope3/cad-data', 'examples/microscope3/cad-data/assembly/assembly.json'],
  ['examples/microscope5', 'examples/microscope5/assembly/assembly.json'],
  // Plane-datum distance: toy-balance2 I9/I16 are the regression that motivated
  // `datumDistance` (plane anchors offset laterally, 8.5mm reported for a 0mm gap).
  ['examples/toy-balance2/cad-data', 'examples/toy-balance2/assembly/assembly.json'],
];
let corpusCount = 0;
for (const [storeDir, manifestRel] of candidates) {
  const manifestPath = join(REPO, manifestRel);
  if (!existsSync(manifestPath)) {
    console.log(`SKIP  ${manifestRel} — not present`);
    continue;
  }
  const corpusStore = openVersionStore(join(REPO, storeDir));
  const difference = await compareManifest(corpusStore, manifestPath, []);
  corpusCount++;
  const name = manifestRel.split('/').slice(-3).join('/');
  check(difference === null, `${name}: worker and oracle agree`, difference ?? '');
}

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
        { id: 'if-spring-behaviour-clash', a: 'holder.轴孔', b: 'pin.轴径', type: '弹簧', severity: 'hard', check: 'spring-behaviour',
          elastic: { direction: 'compression', freeLengthMm: 40, stiffnessNPerMm: 2, solidHeightMm: 35, forceBudgetN: 100 } },
        { id: 'if-spring-behaviour-stretched', a: 'holder.轴孔', b: 'pin.轴径', type: '弹簧', severity: 'hard', check: 'spring-behaviour',
          elastic: { direction: 'compression', freeLengthMm: 20, stiffnessNPerMm: 2, forceBudgetN: 100 } },
        { id: 'if-spring-behaviour-no-direction', a: 'holder.轴孔', b: 'pin.轴径', type: '弹簧', severity: 'hard', check: 'spring-behaviour',
          elastic: { freeLengthMm: 40, stiffnessNPerMm: 2, solidHeightMm: 20, forceBudgetN: 100 } },
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
  const difference = await compareManifest(store, manifestPath, runs);
  check(difference === null, `synthetic manifest (${manifest.root.interfaces.length} interfaces): worker and oracle agree`, difference ?? '');

  // Prove the synthetic manifest actually reaches the branches it was written for,
  // so a future "agreement" cannot come from both sides skipping everything.
  const report = await runAssemblyCheck(store, manifestPath, { runs });
  const kinds = report.results.map((r) => `${r.check}:${r.verdict}`);
  for (const [label, wanted] of [
    ['a spring without parameters is skipped with the missing inputs named', report.results.some((r) => r.interfaceId === 'if-pending' && r.verdict === 'skipped' && r.detail.includes('spring-behaviour needs'))],
    ['spring-behaviour pass with a user budget and a force band', report.results.some((r) => r.interfaceId === 'if-spring-behaviour-pass' && r.verdict === 'pass' && r.elastic?.forceBandN?.length === 2)],
    ['spring-behaviour reports a positive force inside its band and all declared checks OK', report.results.some((r) => r.interfaceId === 'if-spring-behaviour-pass' && r.elastic !== undefined && r.elastic.forceN > 0 && r.elastic.forceBandN !== undefined && r.elastic.forceBandN[0] <= r.elastic.forceN && r.elastic.forceN <= r.elastic.forceBandN[1] && r.elastic.checks.direction === 'ok' && r.elastic.checks.solidHeight === 'ok' && r.elastic.checks.forceBudget === 'ok')],
    ['spring-behaviour always exposes an order-of-magnitude band', report.results.some((r) => r.interfaceId === 'if-spring-behaviour-pass' && r.elastic !== undefined && r.elastic.forceDecadeN[0] <= Math.abs(r.elastic.forceN) && Math.abs(r.elastic.forceN) <= r.elastic.forceDecadeN[1])],
    ['spring-behaviour without a budget is skipped, not passed', report.results.some((r) => r.interfaceId === 'if-spring-behaviour-no-budget' && r.verdict === 'skipped')],
    ['spring-behaviour below solid height is a hard violation', report.results.some((r) => r.interfaceId === 'if-spring-behaviour-clash' && r.verdict === 'hard-violation')],
    ['a compression spring that is stretched is a hard violation', report.results.some((r) => r.interfaceId === 'if-spring-behaviour-stretched' && r.verdict === 'hard-violation')],
    ['an undeclared direction cannot pass even with a budget', report.results.some((r) => r.interfaceId === 'if-spring-behaviour-no-direction' && r.verdict === 'intent-flag' && r.elastic?.checks.direction === 'unknown')],
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

console.log(`\ncompared: ${fixtureCount} fixture + ${corpusCount} corpus + 1 synthetic manifest`);
console.log(`${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
