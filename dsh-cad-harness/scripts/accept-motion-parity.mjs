// Parity acceptance for the migrated `simulate_motion` (batch 3, Q2=A).
//
// `runMotion` forwards to the Python worker; `runMotionInTs` is the oracle (and the
// darwin-x64 canonical, where the lock ships no `rapier3d` wheel).
//
// This one is NOT like the physics parity check. Here rapier is only a constraint
// solver (no colliders, no gravity) and the verdict comes from an EXACT Manifold
// interference timeline, so:
//   * the PASS/CHECK verdict and the interference PAIRS must agree,
//   * travel/period are constraint-driven and must agree closely,
//   * the crank milestone keyframes must land on the same steps,
//   * the trajectory must have the same shape.
// One case carries a part ROTATION on purpose: the Python binding's
// `RigidBodyBuilder.rotation()` takes a scaled-axis vector, not a quaternion, and
// that trap hid behind "no test sets a rotation" until this case existed.
//
//   node scripts/accept-motion-parity.mjs [--runtime <dir>]

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { runMotion, runMotionInTs } from '../src/host/motion.ts';
import { resetPythonWorker } from '../src/host/python-worker.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REPO = resolve(ROOT, '..');
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
};
process.env.DSH_CAD_PYTHON_ROOT = resolve(argOf('--runtime', join(REPO, '.tmp-measure-runtime')));

const venvPython = process.platform === 'win32'
  ? join(process.env.DSH_CAD_PYTHON_ROOT, 'venv', 'Scripts', 'python.exe')
  : join(process.env.DSH_CAD_PYTHON_ROOT, 'venv', 'bin', 'python');
if (!existsSync(venvPython)) {
  console.error(`no venv python at ${venvPython}`);
  process.exit(2);
}

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const { compileStlOnly } = await import('../src/host/compile.ts');
const crank = await compileStlOnly('translate([10,0,0]) cube([20,20,8], center=true);');
const rod = await compileStlOnly('cube([80,8,8], center=true);');
const piston = await compileStlOnly('cube([24,24,24], center=true);');
const block = await compileStlOnly('difference() { cube([60,40,40], center=true); translate([0,0,20]) cube([26,26,60], center=true); }');
const valve = await compileStlOnly('cube([10,10,40], center=true);');
for (const [name, result] of [['crank', crank], ['rod', rod], ['piston', piston], ['block', block], ['valve', valve]]) {
  if (!result.success) console.error(`compile failed: ${name}`);
}

const OMEGA = Math.PI; // 0.5 Hz
const BASE_JOINTS = [
  { type: 'revolute', bodyA: 'block', bodyB: 'crank', anchorA: [0, 0, 0], anchorB: [-10, 0, 0], axis: [0, 1, 0] },
  { type: 'revolute', bodyA: 'crank', bodyB: 'rod', anchorA: [10, 0, 0], anchorB: [-40, 0, 0], axis: [0, 1, 0] },
  { type: 'revolute', bodyA: 'rod', bodyB: 'piston', anchorA: [40, 0, 0], anchorB: [0, 0, 0], axis: [0, 1, 0] },
  { type: 'prismatic', bodyA: 'block', bodyB: 'piston', anchorA: [0, 0, 0], anchorB: [0, 0, 0], axis: [0, 0, 1], limits: [-40, 40] },
];

const CASES = [
  {
    label: 'slider-crank: drive + followers + a prismatic guide',
    bandMm: 0.3,
    scenario: {
      parts: [
        { name: 'block', stl: block.stl, bodyType: 'fixed', position: [0, 0, 0] },
        { name: 'crank', stl: crank.stl, bodyType: 'dynamic', position: [0, 0, 0] },
        { name: 'rod', stl: rod.stl, bodyType: 'dynamic', position: [50, 0, 0] },
        { name: 'piston', stl: piston.stl, bodyType: 'dynamic', position: [90, 0, 0] },
      ],
      joints: BASE_JOINTS,
      drive: { body: 'crank', axis: [0, 1, 0], omegaRadPerSec: OMEGA },
      cycles: 2,
      samplePerCycle: 24,
      recordParts: ['piston'],
    },
  },
  {
    label: 'sinusoidal valve oscillator',
    bandMm: 0.3,
    scenario: {
      parts: [
        { name: 'block', stl: block.stl, bodyType: 'fixed', position: [0, 0, 0] },
        { name: 'valve', stl: valve.stl, bodyType: 'kinematic', position: [0, 0, 100] },
      ],
      joints: [{ type: 'prismatic', bodyA: 'block', bodyB: 'valve', anchorA: [0, 0, 0], anchorB: [0, 0, 0], axis: [0, 0, 1], limits: [-40, 40] }],
      oscillators: [{ body: 'valve', axis: [0, 0, 1], amplitudeMm: 10, periodSec: 1 }],
      cycles: 2,
      samplePerCycle: 24,
      recordParts: ['valve'],
    },
  },
  {
    label: 'rack & pinion coupling (r × drive angle)',
    bandMm: 0.3,
    scenario: {
      parts: [
        { name: 'block', stl: block.stl, bodyType: 'fixed', position: [0, 0, 0] },
        { name: 'crank', stl: crank.stl, bodyType: 'dynamic', position: [0, 0, 0] },
        { name: 'piston', stl: piston.stl, bodyType: 'dynamic', position: [90, 0, 0] },
      ],
      joints: [
        { type: 'revolute', bodyA: 'block', bodyB: 'crank', anchorA: [0, 0, 0], anchorB: [-10, 0, 0], axis: [0, 1, 0] },
        { type: 'prismatic', bodyA: 'block', bodyB: 'piston', anchorA: [0, 0, 0], anchorB: [0, 0, 0], axis: [0, 0, 1], limits: [-200, 200] },
      ],
      drive: { body: 'crank', axis: [0, 1, 0], omegaRadPerSec: OMEGA },
      oscillators: [{ body: 'piston', axis: [0, 0, 1], pitchRadiusMm: 12 }],
      cycles: 2,
      samplePerCycle: 24,
      recordParts: ['piston'],
    },
  },
  {
    label: 'a rotated part (covers the scaled-axis rotation trap)',
    bandMm: 0.3,
    scenario: {
      parts: [
        { name: 'block', stl: block.stl, bodyType: 'fixed', position: [0, 0, 0] },
        { name: 'crank', stl: crank.stl, bodyType: 'dynamic', position: [0, 0, 0], rotation: [0, 90, 0] },
        { name: 'rod', stl: rod.stl, bodyType: 'dynamic', position: [50, 0, 0], rotation: [30, -20, 45] },
        { name: 'piston', stl: piston.stl, bodyType: 'dynamic', position: [90, 0, 0] },
      ],
      joints: BASE_JOINTS,
      drive: { body: 'crank', axis: [0, 1, 0], omegaRadPerSec: OMEGA },
      cycles: 2,
      samplePerCycle: 24,
      recordParts: ['piston'],
    },
  },
  {
    label: 'negative: the piston hits the head (interference must be found)',
    bandMm: 0.5,
    expectInterference: true,
    scenario: {
      parts: [
        { name: 'block', stl: block.stl, bodyType: 'fixed', position: [0, 0, 0] },
        { name: 'crank', stl: crank.stl, bodyType: 'dynamic', position: [0, 0, 0] },
        { name: 'rod', stl: rod.stl, bodyType: 'dynamic', position: [50, 0, 0] },
        { name: 'piston', stl: piston.stl, bodyType: 'dynamic', position: [70, 0, 0] },
      ],
      joints: BASE_JOINTS,
      drive: { body: 'crank', axis: [0, 1, 0], omegaRadPerSec: OMEGA },
      cycles: 1,
      samplePerCycle: 24,
      recordParts: ['piston'],
    },
  },
];

console.log('--- motion parity: Python worker vs TS oracle ---');
for (const testCase of CASES) {
  const tsStart = performance.now();
  const ts = await runMotionInTs(testCase.scenario);
  const tsMs = performance.now() - tsStart;

  const pyStart = performance.now();
  const py = await runMotion(testCase.scenario);
  const pyMs = performance.now() - pyStart;

  check(py.overallStatus === ts.overallStatus, `${testCase.label}: status`, `TS ${ts.overallStatus} · py ${py.overallStatus}`);
  check(py.metrics.diverged === ts.metrics.diverged, `${testCase.label}: diverged`, `${py.metrics.diverged}`);
  check(py.metrics.jointViolations.length === ts.metrics.jointViolations.length, `${testCase.label}: joint violations`, `${py.metrics.jointViolations.length}`);

  // The count is what decides PASS/CHECK, and it is EXACT Manifold work on both
  // sides — so it has to match, not merely agree in sign. (Several of these
  // mechanisms genuinely interfere at the pin/rail; that is the mechanism's
  // business, not the port's.)
  check(py.metrics.interferenceCount === ts.metrics.interferenceCount, `${testCase.label}: interference count identical`, `TS ${ts.metrics.interferenceCount} · py ${py.metrics.interferenceCount}`);
  if (testCase.expectInterference) {
    check(py.metrics.interferenceCount > 0 && ts.metrics.interferenceCount > 0, `${testCase.label}: both find interference`, `TS ${ts.metrics.interferenceCount} · py ${py.metrics.interferenceCount}`);
  }
  if (py.metrics.interferenceCount > 0 && ts.metrics.interferenceCount > 0) {
    const pairs = (report) => [...new Set(report.metrics.interferenceEvents.map((e) => [e.partA, e.partB].sort().join('↔')))].sort().join(',');
    check(pairs(py) === pairs(ts), `${testCase.label}: the same pair interferes`, `TS [${pairs(ts)}] · py [${pairs(py)}]`);
  }

  // followers: travel and period are what the tool reports to the model
  const tsFollowers = Object.keys(ts.metrics.followers).sort();
  const pyFollowers = Object.keys(py.metrics.followers).sort();
  check(pyFollowers.join(',') === tsFollowers.join(','), `${testCase.label}: follower set`, pyFollowers.join(','));
  let worstTravel = 0;
  let worstPeriod = 0;
  for (const name of tsFollowers) {
    const a = ts.metrics.followers[name];
    const b = py.metrics.followers[name];
    if (!a || !b || a.axis !== b.axis) { worstTravel = Infinity; continue; }
    worstTravel = Math.max(worstTravel, Math.abs(a.travelMm - b.travelMm));
    if (a.periodSec !== null && b.periodSec !== null) worstPeriod = Math.max(worstPeriod, Math.abs(a.periodSec - b.periodSec));
  }
  check(worstTravel <= testCase.bandMm, `${testCase.label}: follower travel within band`, `worst Δ ${worstTravel.toFixed(4)} mm · band ${testCase.bandMm} mm`);
  check(worstPeriod <= 0.02, `${testCase.label}: period agreement`, `worst Δ ${worstPeriod.toFixed(5)} s`);

  check(py.keyframes[0]?.label === ts.keyframes[0]?.label && py.keyframes[0]?.label === 'crank0', `${testCase.label}: first keyframe is crank0`);
  const pyLabels = py.keyframes.map((k) => k.label).join(',');
  const tsLabels = ts.keyframes.map((k) => k.label).join(',');
  check(pyLabels === tsLabels, `${testCase.label}: keyframe labels in order`, `TS [${tsLabels}] · py [${pyLabels}]`);
  check(py.trajectory.times.length === ts.trajectory.times.length, `${testCase.label}: trajectory frames`, `${py.trajectory.times.length} vs ${ts.trajectory.times.length}`);
  check(py.stepsRun === ts.stepsRun && py.durationSec === ts.durationSec, `${testCase.label}: steps and duration`, `${py.stepsRun} / ${py.durationSec}s`);

  for (const name of tsFollowers) {
    const a = ts.metrics.followers[name];
    const b = py.metrics.followers[name];
    if (a && b) console.log(`      ${name}: travel TS ${a.travelMm} → py ${b.travelMm} (${b.axis}) · period ${a.periodSec ?? '—'} → ${b.periodSec ?? '—'} s`);
  }
  console.log(`      timing: TS ${tsMs.toFixed(0)} ms · Python ${pyMs.toFixed(0)} ms (${(pyMs / Math.max(tsMs, 0.01)).toFixed(2)}×)`);
}

resetPythonWorker();
console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
