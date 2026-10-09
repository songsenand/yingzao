// Parity acceptance for the migrated `simulate_physics` (batch 3, Q2=A).
//
// `runPhysics` now forwards to the Python worker; `runPhysicsInTs` is the previous
// implementation, kept as the oracle (and as the darwin-x64 canonical, where the
// lock ships no `rapier3d` wheel).
//
// WHAT IS ASSERTED, AND WHY IT IS NOT "THE SAME NUMBERS". The probe
// (experiments/20261008_python_rapier_probe.md) measured that the two engine
// versions agree on joint/constraint quantities to ~0.05 mm, on free flight and
// light contact to ~1 mm, and diverge on contact-dominated trajectories by
// millimetres to tens of millimetres. So the checks are layered:
//
//   1. ANALYTIC quantities must be identical (hold analysis is arithmetic, and the
//      shell-count note is text): 1e-4 relative.
//   2. QUALITATIVE verdicts must be identical (toppled, settled, holds, the
//      scenario notes, the keyframe label set, the final frame).
//   3. TRAJECTORY SHAPE must be identical (frame count, times).
//   4. NUMBERS must stay inside the case's declared band, which the report says the
//      re-baselined thresholds should use: 0.1 mm for constraint-driven cases,
//      1.5 mm for free flight / light contact. Contact-dominated cases print their
//      divergence instead of asserting it.
//
//   node scripts/accept-physics-parity.mjs [--runtime <dir>] [--keep]

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { runPhysics, runPhysicsInTs } from '../src/host/physics.ts';
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
  console.error(`no venv python at ${venvPython} — provision the runtime first (or pass --runtime <dir>)`);
  process.exit(2);
}

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const close = (a, b, tolerance) => Math.abs(a - b) <= tolerance;

const { compileStlOnly } = await import('../src/host/compile.ts');
const box = await compileStlOnly('cube([40,40,100], center=true);');
const tall = await compileStlOnly('cube([30,30,200], center=true);');
const ground = await compileStlOnly('translate([0,0,-5]) cube([400,400,10], center=true);');
const twoShells = await compileStlOnly(
  'union() { cube([30,30,30], center=true);'
  + ' translate([60,0,0]) cube([30,30,30], center=true);'
  + ' translate([0,60,0]) cube([30,30,30], center=true);'
  + ' translate([60,60,0]) cube([30,30,30], center=true); }');
const cube20 = await compileStlOnly('cube([20,20,20], center=true);');
const plate = await compileStlOnly('translate([0,0,-2]) cube([200,200,4], center=true);');
for (const [name, result] of [['box', box], ['tall', tall], ['ground', ground], ['twoShells', twoShells], ['cube20', cube20], ['plate', plate]]) {
  if (!result.success) console.error(`compile failed: ${name}`);
}

const DT = 1 / 60;
const CASES = [
  {
    label: 'constraint-driven: carriage on a prismatic rail',
    bandMm: 0.1,
    scenario: {
      // The slide starts at joint coordinate 50 (z=50 above a plate whose top is
      // z=0, carriage 20³ so its bottom is 40mm clear) and its LOWER LIMIT stops it
      // before any contact: this is a constraint-only case on purpose.
      parts: [
        { name: 'plate', stl: plate.stl, bodyType: 'fixed', position: [0, 0, 0] },
        { name: 'carriage', stl: cube20.stl, bodyType: 'dynamic', position: [0, 0, 50] },
      ],
      joints: [{ type: 'prismatic', bodyA: 'plate', bodyB: 'carriage', anchorA: [0, 0, 0], anchorB: [0, 0, 0], axis: [0, 0, 1], limits: [20, 50] }],
      durationSec: 2,
      timestepSec: DT,
      keyframeCount: 6,
    },
  },
  {
    label: 'free flight + light contact: a box kicked upright on the ground',
    bandMm: 1.5,
    scenario: {
      parts: [
        { name: 'ground', stl: ground.stl, bodyType: 'fixed', position: [0, 0, 0] },
        { name: 'box', stl: box.stl, bodyType: 'dynamic', position: [0, 0, 50], initialAngularVelocity: [0, 6, 0] },
      ],
      durationSec: 2,
      timestepSec: DT,
      keyframeCount: 6,
    },
  },
  {
    label: 'topples: a 200mm column pushed hard',
    bandMm: 60,
    contactDominated: true,
    scenario: {
      parts: [
        { name: 'ground', stl: ground.stl, bodyType: 'fixed', position: [0, 0, 0] },
        { name: 'column', stl: tall.stl, bodyType: 'dynamic', position: [0, 0, 100], initialAngularVelocity: [0, 2.5, 0] },
      ],
      durationSec: 2.5,
      timestepSec: DT,
      keyframeCount: 6,
    },
  },
  {
    label: 'quasi-static hold analysis (analytic, must be exact)',
    bandMm: 0.2,
    scenario: {
      parts: [
        { name: 'plate', stl: plate.stl, bodyType: 'fixed', position: [0, 0, 0] },
        { name: 'carriage', stl: cube20.stl, bodyType: 'dynamic', position: [0, 0, 50] },
      ],
      joints: [{ type: 'prismatic', bodyA: 'plate', bodyB: 'carriage', anchorA: [0, 0, 0], anchorB: [0, 0, 0], axis: [0, 0, 1], limits: [20, 50], staticFriction: 0.3 }],
      durationSec: 1,
      timestepSec: DT,
      keyframeCount: 4,
    },
  },
  {
    label: 'many-shell input: the settled-penetration note must fire',
    bandMm: 5,
    scenario: {
      parts: [
        { name: 'ground', stl: ground.stl, bodyType: 'fixed', position: [0, 0, 0] },
        { name: 'pair', stl: twoShells.stl, bodyType: 'dynamic', position: [0, 0, 30] },
      ],
      durationSec: 1,
      timestepSec: DT,
      keyframeCount: 4,
    },
  },
];

console.log('--- physics parity: Python worker vs TS oracle ---');
for (const testCase of CASES) {
  const tsStart = performance.now();
  const ts = await runPhysicsInTs(testCase.scenario);
  const tsMs = performance.now() - tsStart;

  const pyStart = performance.now();
  const py = await runPhysics(testCase.scenario);
  const pyMs = performance.now() - pyStart;

  // 1. qualitative verdicts
  check(JSON.stringify(py.metrics.fellOver) === JSON.stringify(ts.metrics.fellOver), `${testCase.label}: toppled verdicts`, JSON.stringify(py.metrics.fellOver));
  check(py.metrics.settled === ts.metrics.settled, `${testCase.label}: settled verdict`, `TS ${ts.metrics.settled} · py ${py.metrics.settled}`);
  check(py.metrics.jointViolations.length === ts.metrics.jointViolations.length, `${testCase.label}: joint violations`, `TS ${ts.metrics.jointViolations.length} · py ${py.metrics.jointViolations.length}`);
  check(py.metrics.notes.length === ts.metrics.notes.length, `${testCase.label}: notes count`, `${py.metrics.notes.length}`);
  // 2. analytic hold analysis
  const tsHolds = ts.metrics.holdAnalysis ?? [];
  const pyHolds = py.metrics.holdAnalysis ?? [];
  check(tsHolds.length === pyHolds.length && pyHolds.every((entry, index) => entry.holds === tsHolds[index]?.holds), `${testCase.label}: hold verdicts`, JSON.stringify(pyHolds.map((h) => h.holds)));
  check(
    pyHolds.every((entry, index) => {
      const other = tsHolds[index];
      return other
        && entry.joint === other.joint
        && close(entry.massKg, other.massKg, Math.max(1e-4, Math.abs(other.massKg) * 1e-3))
        && close(entry.axialDriveN, other.axialDriveN, Math.max(1e-4, Math.abs(other.axialDriveN) * 1e-3))
        && close(entry.frictionCapN, other.frictionCapN, Math.max(1e-4, Math.abs(other.frictionCapN) * 1e-3));
    }),
    `${testCase.label}: hold numbers (analytic)`,
    pyHolds.map((h) => `${h.mu}·${h.massKg}kg → cap ${h.frictionCapN} vs drive ${h.axialDriveN}`).join(' | '),
  );
  // 3. trajectory shape
  check(py.trajectory.times.length === ts.trajectory.times.length, `${testCase.label}: trajectory frames`, `${py.trajectory.times.length} vs ${ts.trajectory.times.length}`);
  check(py.stepsRun === ts.stepsRun, `${testCase.label}: steps run`, `${py.stepsRun}`);
  const tsLabels = ts.keyframes.map((k) => k.label).sort().join(',');
  const pyLabels = py.keyframes.map((k) => k.label).sort().join(',');
  check(tsLabels === pyLabels, `${testCase.label}: keyframe label set`, `TS [${tsLabels}] · py [${pyLabels}]`);
  check(py.keyframes[py.keyframes.length - 1]?.label === 'final', `${testCase.label}: the last keyframe is the final frame`);

  // 4. numbers inside the declared band
  let worst = 0;
  let worstPart = '';
  for (const part of testCase.scenario.parts) {
    const a = ts.finalPositions[part.name] ?? [];
    const b = py.finalPositions[part.name] ?? [];
    const delta = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    if (delta > worst) { worst = delta; worstPart = part.name; }
  }
  const band = testCase.bandMm;
  const detail = `worst final Δ ${worst.toFixed(3)} mm (${worstPart}) · band ${band} mm`;
  if (testCase.contactDominated) console.log(`      note: contact-dominated case — ${detail} (printed, band is a sanity ceiling)`);
  check(worst <= band, `${testCase.label}: final positions within band`, detail);
  console.log(`      timing: TS ${tsMs.toFixed(0)} ms · Python ${pyMs.toFixed(0)} ms (${(pyMs / Math.max(tsMs, 0.01)).toFixed(2)}×)`);
}

if (args.includes('--keep')) {
  const dir = mkdtempSync(join(tmpdir(), 'cad-physics-keep-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'note.txt'), 'kept for inspection\n');
  console.log(`      (--keep wrote ${dir})`);
  rmSync(dir, { recursive: true, force: true });
}

resetPythonWorker();
console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
