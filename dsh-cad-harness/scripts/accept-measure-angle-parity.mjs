// Parity acceptance for `measure_angle` against the TypeScript ORACLE.
//
// `assembly-check.ts`'s `axisLineDistance` is the implementation `check_assembly`'s
// `coaxial` operator has been using, and the decision that created `measure_angle`
// was to move that arithmetic to the worker and let BOTH consume it — otherwise two
// copies of an angle would eventually disagree, which is exactly the failure mode
// that makes a model stop trusting a number.
//
// So this file is the record of "the numbers did not change". The TS function stays
// as the oracle; when the coaxial operator is finally wired to the worker op, this
// script is what makes the claim checkable rather than asserted.
//
//   node scripts/accept-measure-angle-parity.mjs [--runtime <dir>]
//
// Compares, per case:
//   * `lineDistanceMm` (worker) vs `distance` (oracle)
//   * `acuteDeg` (worker) vs `angleDeg` (oracle)   [the oracle reports the acute angle]
// Tolerance is 1e-3: the worker reports mm to 0.001 by design (`_round3`), so asking
// for bit equality would be testing the rounding, not the arithmetic.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { axisLineDistance } from '../src/host/assembly-check.ts';
import { ensurePythonWorker, resetPythonWorker } from '../src/host/python-worker.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REPO = resolve(ROOT, '..');
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
const TOLERANCE = 1e-3;
const fmt = (value) => (typeof value === 'number' ? value.toFixed(6) : JSON.stringify(value));

// --- the cases ---------------------------------------------------------------
// Hand-picked axes-of-interest first (the shapes a mechanism actually has), then a
// deterministic pseudo-random batch so the comparison is not just the easy ones.
const CASES = [
  ['x vs y through the origin', [1, 0, 0], [0, 0, 0], [0, 1, 0], [0, 0, 0]],
  ['x vs z, 4mm apart in y', [1, 0, 0], [0, 0, 0], [0, 0, 1], [0, 4, 0]],
  ['skew: x axis vs y axis lifted 3mm', [1, 0, 0], [0, 0, 0], [0, 1, 0], [0, 0, 3]],
  ['parallel: z axes 5mm apart', [0, 0, 1], [0, 0, 0], [0, 0, 1], [5, 0, 2]],
  ['antiparallel: z vs -z', [0, 0, 1], [1, 1, 1], [0, 0, -1], [0, 0, 0]],
  ['30° apart, meeting', [1, 0, 0], [0, 0, 0], [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6), 0], [0, 0, 0]],
  ['a tilted bore vs a rail', [0, 0, 1], [0, 60, 200], [Math.sin(0.12), 0, Math.cos(0.12)], [3, 0, 100]],
  ['nearly parallel, long offsets', [0.001, 1, 0], [100, -50, 20], [0, 1, 0.002], [-30, 40, 60]],
  ['unnormalised inputs', [0, 0, 7], [0, 0, 0], [0, 0, -3], [1, 2, 3]],
];
// A fixed generator: the same cases every run, no dependency on Math.random.
let seed = 20261012;
const next = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const spread = () => [(next() - 0.5) * 40, (next() - 0.5) * 40, (next() - 0.5) * 40];
for (let i = 0; i < 30; i++) {
  CASES.push([`pseudo-random #${i}`, spread(), spread(), spread(), spread()]);
}

// --- run both sides ----------------------------------------------------------
const worker = await ensurePythonWorker();
let worstDistance = 0;
let worstAngle = 0;
let mismatches = 0;
for (const [label, d1, p1, d2, p2] of CASES) {
  const oracle = axisLineDistance(p1, d1, p2, d2);
  const mine = await worker.request('measure_angle', {
    aDir: d1, aOrigin: p1, bDir: d2, bOrigin: p2,
  });
  const distanceDelta = Math.abs(mine.lineDistanceMm - oracle.distance);
  const angleDelta = Math.abs(mine.acuteDeg - oracle.angleDeg);
  worstDistance = Math.max(worstDistance, distanceDelta);
  worstAngle = Math.max(worstAngle, angleDelta);
  if (distanceDelta > TOLERANCE || angleDelta > TOLERANCE) {
    mismatches++;
    console.log(`      ${label}: worker ${fmt(mine.lineDistanceMm)}mm / ${fmt(mine.acuteDeg)}°  `
      + `oracle ${fmt(oracle.distance)}mm / ${fmt(oracle.angleDeg)}°`);
  }
}
check(mismatches === 0,
  `all ${CASES.length} cases agree with the TS oracle (distance and acute angle)`,
  `worst Δdistance ${worstDistance.toExponential(2)}mm, worst Δangle ${worstAngle.toExponential(2)}°`);
check(worstDistance <= TOLERANCE && worstAngle <= TOLERANCE,
  'the worst disagreement stays inside the reported precision (0.001)');

// --- a real datum axis, which is what `coaxial` actually consumes -------------
const v010 = join(REPO, 'examples', 'microscope2', 'cad-data', 'versions', 'v010');
const datumsPath = join(v010, 'datums.json');
if (existsSync(datumsPath)) {
  const datums = JSON.parse(await (await import('node:fs/promises')).readFile(datumsPath, 'utf8'));
  const axis = datums.axes?.[0];
  if (axis) {
    const oracle = axisLineDistance(axis.point, axis.dir, [0, 0, 0], [0, 0, 1]);
    const mine = await worker.request('measure_angle', {
      aDir: axis.dir, aOrigin: axis.point, bDir: [0, 0, 1], bOrigin: [0, 0, 0],
    });
    check(Math.abs(mine.lineDistanceMm - oracle.distance) <= TOLERANCE
      && Math.abs(mine.acuteDeg - oracle.angleDeg) <= TOLERANCE,
      `a real datum axis (${axis.name}) agrees with the oracle`,
      `${fmt(mine.lineDistanceMm)}mm/${fmt(mine.acuteDeg)}° vs ${fmt(oracle.distance)}mm/${fmt(oracle.angleDeg)}°`);
  } else {
    console.log('SKIP  a real datum axis  — no axis datum in v010');
  }
} else {
  console.log(`SKIP  a real datum axis  — ${datumsPath} not found`);
}

await resetPythonWorker();
console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
