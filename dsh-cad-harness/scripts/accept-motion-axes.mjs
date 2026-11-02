// Regression: the motion half of the Roberval r001 failure.
//
// r001 reported 105.566mm joint drift and still "passed" its 24/24 interference
// checks. Two input-frame facts were wrong, and neither is a closed-loop
// impossibility:
//
//   1. the joints were authored in world/file coordinates on a [90,0,0]-rotated
//      top beam, so the anchors were tens of mm apart (the tool now resolves
//      `anchorWorld`, and the t=0 gate refuses rather than warming the gap up);
//   2. `axis` was ONE local vector for both bodies, so the world +Y hinge was
//      local +Z on the beam and local +Y on the pan — the solver resolved the
//      frame mismatch by twisting the whole frame.
//
// This acceptance rebuilds the r001 mechanism from its own STLs, re-bases each
// part on the pivot the tool would use, gives the hinge per-body axes, and
// asserts that the same 0.02-turn sweep now has zero drift and 24 poses.
//
//   node scripts/accept-motion-axes.mjs [--runtime <dir>]

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMotion, runMotionInTs } from '../src/host/motion.ts';
import { parseBinaryStl, rebaseMesh, writeBinaryStl } from '../src/host/mesh.ts';
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
const raw = (name) => new Uint8Array(readFileSync(partPath(name)));

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

function rotate(v, deg) {
  const [rx, ry, rz] = deg.map((d) => (d * Math.PI) / 180);
  const [x, y, z] = v;
  const y1 = y * Math.cos(rx) - z * Math.sin(rx);
  const z1 = y * Math.sin(rx) + z * Math.cos(rx);
  const x2 = x * Math.cos(ry) + z1 * Math.sin(ry);
  const z2 = -x * Math.sin(ry) + z1 * Math.cos(ry);
  return [x2 * Math.cos(rz) - y1 * Math.sin(rz), x2 * Math.sin(rz) + y1 * Math.cos(rz), z2];
}

// The tool's default pivot: the anchor of the first joint naming the part.
const pivots = {
  base_unit: [0, 0, 150],
  bottom_unit: [0, 0, 150],
  pan_unit_left: [-80, 0, 215],
  pan_unit_right: [80, 0, 215],
  top_beam: [0, 0, 0],
};
const defs = [
  { name: 'base_unit', bodyType: 'fixed', position: [0, 0, 0], rotation: [0, 0, 0] },
  { name: 'bottom_unit', bodyType: 'dynamic', position: [0, 0, 0], rotation: [0, 0, 0] },
  { name: 'pan_unit_left', bodyType: 'dynamic', position: [0, 0, 0], rotation: [0, 0, 0] },
  { name: 'pan_unit_right', bodyType: 'dynamic', position: [0, 0, 0], rotation: [0, 0, 0] },
  { name: 'top_beam', bodyType: 'kinematic', position: [0, 0, 215], rotation: [90, 0, 0] },
];
const parts = defs.map((d) => {
  const pivot = pivots[d.name];
  const rebased = rebaseMesh(parseBinaryStl(raw(d.name)), pivot);
  const rp = rotate(pivot, d.rotation);
  return {
    name: d.name,
    stl: writeBinaryStl(rebased),
    bodyType: d.bodyType,
    position: [d.position[0] + rp[0], d.position[1] + rp[1], d.position[2] + rp[2]],
    rotation: d.rotation,
  };
});

// Local anchors: the joint point minus the part's pivot in its own frame.
const joint = (type, bodyA, bodyB, anchorA, anchorB, axisA, axisB) => ({
  type, bodyA, bodyB,
  anchorA: anchorA.map((v, i) => v - pivots[bodyA][i]),
  anchorB: anchorB.map((v, i) => v - pivots[bodyB][i]),
  axisA, axisB,
});
const joints = [
  joint('revolute', 'base_unit', 'bottom_unit', [0, 0, 150], [0, 0, 150], [0, 1, 0], [0, 1, 0]),
  joint('revolute', 'base_unit', 'top_beam', [0, 0, 215], [0, 0, 0], [0, 1, 0], [0, 0, 1]),
  joint('revolute', 'top_beam', 'pan_unit_left', [-80, 0, 0], [-80, 0, 215], [0, 0, 1], [0, 1, 0]),
  joint('revolute', 'top_beam', 'pan_unit_right', [80, 0, 0], [80, 0, 215], [0, 0, 1], [0, 1, 0]),
  joint('revolute', 'bottom_unit', 'pan_unit_left', [-80, 0, 150], [-80, 0, 150], [0, 1, 0], [0, 1, 0]),
  joint('revolute', 'bottom_unit', 'pan_unit_right', [80, 0, 150], [80, 0, 150], [0, 1, 0], [0, 1, 0]),
];
const scenario = {
  parts,
  joints,
  drive: { body: 'top_beam', axis: [0, 1, 0], omegaRadPerSec: 0.5 },
  cycles: 0.02,
};

function assertMotion(tag, report) {
  check(report.overallStatus === 'pass', `${tag}: the 0.02-turn sweep passes`, report.overallStatus);
  check(report.metrics.maxJointDriftMm < 2, `${tag}: no joint drift (was 105.566mm)`, `${report.metrics.maxJointDriftMm}mm`);
  check(report.metrics.jointViolations.length === 0, `${tag}: no joint violations`, report.metrics.jointViolations.join('; ') || 'none');
  check(report.metrics.interferenceChecks >= 24, `${tag}: 24+ sampled poses`, `${report.metrics.interferenceChecks}`);
  check(report.metrics.samplingSatisfied === true, `${tag}: coverage satisfied`, String(report.metrics.samplingSatisfied));
}

console.log('--- motion axes regression: r001 ---');
const ts = await runMotionInTs(scenario);
assertMotion('TS', ts);
if (havePython) {
  const py = await runMotion(scenario);
  assertMotion('Python', py);
  check(Math.abs(py.metrics.maxJointDriftMm - ts.metrics.maxJointDriftMm) < 0.1,
    'Python vs TS drift agree', `TS ${ts.metrics.maxJointDriftMm} · py ${py.metrics.maxJointDriftMm}`);
} else {
  console.log(`SKIP  Python worker (no venv at ${venvPython})`);
}

resetPythonWorker();
console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
