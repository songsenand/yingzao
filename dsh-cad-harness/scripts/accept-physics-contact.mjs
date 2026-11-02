// Regression: the Roberval r002 explosion, pinned in four places.
//
// r002 (2026-10-28) reported 25.18mm settled penetration and five joint
// violations; its playback showed the pans flying out of their forks at 0.13s.
// The measured cause was NOT a closed-loop impossibility:
//
//   1. every dynamic body used a single CONVEX HULL collider, and the pan/link
//      fork had 0 mm³ of real overlap at t=0 but 12,140 mm³ of hull overlap at
//      each top hinge (3,937 mm³ at each bottom hinge);
//   2. contacts between the two bodies of a joint were ENABLED, so the solver
//      resolved that design clearance as deep penetration and threw the parts;
//   3. `axis` was one local vector for BOTH bodies, which is wrong for a
//      90°-rotated beam hinged to an unrotated pan (the same world axis is a
//      different local vector on each side);
//   4. a part authored at 90° read as "90° toppled" at t=0 because tilt was
//      measured against world up, not against its authored pose.
//
// This acceptance reproduces the r002 scene from its own STLs and asserts the
// four fixes, plus the t=0 assembly gate and the relative-tilt verdict.
//
//   node scripts/accept-physics-contact.mjs [--runtime <dir>]

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPhysics, runPhysicsInTs } from '../src/host/physics.ts';
import { resetPythonWorker } from '../src/host/python-worker.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REPO = resolve(ROOT, '..');
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const runtime = resolve(argOf('--runtime', join(REPO, '.tmp-measure-runtime')));
const venvPython = process.platform === 'win32'
  ? join(runtime, 'venv', 'Scripts', 'python.exe')
  : join(runtime, 'venv', 'bin', 'python');
const havePython = existsSync(venvPython);
if (havePython) process.env.DSH_CAD_PYTHON_ROOT = runtime;

const PARTS = join(REPO, 'examples', 'roberval-balance', 'cad-data', 'runs', 'r002', 'parts');
const partPath = (name) => join(PARTS, `${name}.stl`);
if (!existsSync(partPath('top_beam'))) {
  console.error(`missing r002 corpus at ${PARTS} — cannot run this acceptance`);
  process.exit(2);
}
const stl = (name) => new Uint8Array(readFileSync(partPath(name)));

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const drift = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// The r002 scene, with the axes the real machine needs: a world +Y hinge
// expressed per body (base: +Y; [90,0,0]-rotated beam: +Z; unrotated pan: +Y).
const scenario = {
  parts: [
    { name: 'base_unit', stl: stl('base_unit'), bodyType: 'fixed', position: [0, 0, 0] },
    { name: 'bottom_unit', stl: stl('bottom_unit'), bodyType: 'dynamic', position: [0, 0, 0] },
    { name: 'pan_unit_left', stl: stl('pan_unit_left'), bodyType: 'dynamic', position: [0, 0, 0] },
    { name: 'pan_unit_right', stl: stl('pan_unit_right'), bodyType: 'dynamic', position: [0, 0, 0] },
    { name: 'top_beam', stl: stl('top_beam'), bodyType: 'dynamic', position: [0, 0, 215], rotation: [90, 0, 0] },
  ],
  joints: [
    { type: 'revolute', bodyA: 'base_unit', bodyB: 'bottom_unit', anchorA: [0, 0, 150], anchorB: [0, 0, 150], axis: [0, 1, 0] },
    { type: 'revolute', bodyA: 'base_unit', bodyB: 'top_beam', anchorA: [0, 0, 215], anchorB: [0, 0, 0], axisA: [0, 1, 0], axisB: [0, 0, 1] },
    { type: 'revolute', bodyA: 'top_beam', bodyB: 'pan_unit_left', anchorA: [-80, 0, 0], anchorB: [-80, 0, 215], axisA: [0, 0, 1], axisB: [0, 1, 0] },
    { type: 'revolute', bodyA: 'top_beam', bodyB: 'pan_unit_right', anchorA: [80, 0, 0], anchorB: [80, 0, 215], axisA: [0, 0, 1], axisB: [0, 1, 0] },
    { type: 'revolute', bodyA: 'bottom_unit', bodyB: 'pan_unit_left', anchorA: [-80, 0, 150], anchorB: [-80, 0, 150], axis: [0, 1, 0] },
    { type: 'revolute', bodyA: 'bottom_unit', bodyB: 'pan_unit_right', anchorA: [80, 0, 150], anchorB: [80, 0, 150], axis: [0, 1, 0] },
  ],
  durationSec: 2,
  timestepSec: 1 / 60,
  keyframeCount: 6,
};

const initial = Object.fromEntries(scenario.parts.map((p) => [p.name, p.position]));

function assertReport(tag, report) {
  const m = report.metrics;
  check(m.contactsDisabled?.length === 6, `${tag}: all six jointed pairs have contacts OFF`, `${m.contactsDisabled?.length ?? 0}`);
  check((m.initialJointGaps ?? []).every((g) => g.gapMm <= 2), `${tag}: t=0 anchors are assembled`, JSON.stringify(m.initialJointGaps));
  check(m.settledPenetrationMm < 1, `${tag}: no settled penetration (was 25.18mm)`, `${m.settledPenetrationMm}mm`);
  check(m.jointViolations.length === 0, `${tag}: no joint violations (was 5)`, m.jointViolations.join('; ') || 'none');
  check(m.fellOver.top_beam === false, `${tag}: the authored 90° beam is not "toppled"`, JSON.stringify(m.fellOver));
  const worst = Math.max(...Object.keys(initial).map((n) => drift(report.finalPositions[n], initial[n])));
  check(worst < 1, `${tag}: the mechanism stays put (drift < 1mm)`, `worst ${worst.toFixed(3)}mm`);
  check(m.colliders.top_beam === 'trimesh', `${tag}: non-convex beam uses the exact mesh`, JSON.stringify(m.colliders));
  check(m.closedLoop === true && m.loopJoints.length === 2, `${tag}: the graph is reported as a closed loop (2 closers)`, `${m.closedLoop} ${JSON.stringify(m.loopJoints)}`);
}

console.log('--- physics contact regression: r002 ---');
const ts = await runPhysicsInTs(scenario);
assertReport('TS', ts);
if (havePython) {
  const py = await runPhysics(scenario);
  assertReport('Python', py);
  const worst = Math.max(...Object.keys(initial).map((n) => drift(py.finalPositions[n], ts.finalPositions[n])));
  check(worst < 0.1, 'Python vs TS final poses agree (constraint-driven)', `worst Δ ${worst.toFixed(4)}mm`);
} else {
  console.log(`SKIP  Python worker (no venv at ${venvPython})`);
}

// ---- t=0 assembly gate: a 10mm anchor error is REFUSED, not simulated ----
const broken = {
  ...scenario,
  joints: scenario.joints.map((j, i) => (i === 0 ? { ...j, anchorB: [0, 0, 160] } : j)),
};
let refused = '';
try {
  await runPhysicsInTs(broken);
} catch (error) {
  refused = String(error?.message ?? error);
}
check(/REFUSED/.test(refused), 'a 10mm anchor error is refused', refused.split('\n')[0] || 'no error');
check(/10\.00mm/.test(refused), '  …and the refusal names the gap', refused.split('\n').slice(1, 2).join(' '));
check(/A-side world/.test(refused) && /B-side world/.test(refused), '  …and both world anchors', '');

// ---- tilt is relative to the authored pose, not world up ----
// A beam authored at 90° about X, hinged at its centre with no gravity: it must
// stay where it was authored, and it must NOT log a topple event at step 0.
const authored = {
  parts: [
    { name: 'base', stl: stl('base_unit'), bodyType: 'fixed', position: [0, 0, 0] },
    { name: 'beam', stl: stl('top_beam'), bodyType: 'dynamic', position: [0, 0, 215], rotation: [90, 0, 0] },
  ],
  joints: [{ type: 'revolute', bodyA: 'base', bodyB: 'beam', anchorA: [0, 0, 215], anchorB: [0, 0, 0], axisA: [0, 1, 0], axisB: [0, 0, 1] }],
  gravity: [0, 0, 0],
  durationSec: 1,
  timestepSec: 1 / 60,
  keyframeCount: 6,
};
const tilt = await runPhysicsInTs(authored);
check(tilt.metrics.fellOver.beam === false, 'authored 90° beam is not "toppled"', JSON.stringify(tilt.metrics.fellOver));
check(tilt.metrics.closedLoop === false && tilt.metrics.loopJoints.length === 0, 'a single hinge is a tree, not a loop', `${tilt.metrics.closedLoop} ${JSON.stringify(tilt.metrics.loopJoints)}`);
check(!tilt.trajectory.events.some((e) => /倾倒:beam/.test(e.label)), '  …and no topple event is logged', JSON.stringify(tilt.trajectory.events));

resetPythonWorker();
console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
