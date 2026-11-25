// Acceptance for the DECLARED joint envelope + fit gate (2026-11-22, A+capsule).
//
// Why: the default timeline drops every revolute-linked pair. When it is turned
// on, the tool must NOT silently assume "bearing": overlap inside the declared
// capsule is a fit candidate, and the run stays `check` until the model declares
// `fit` (bearing/press-fit/clamp/clearance) or the geometry/envelope changes.
//
// Fixture: a driven plate with a 10mm block hinged at its edge; at t=0 the block
// overlaps the plate by ~1000mm³, partly inside the declared capsule.
//   scan off                      -> pair excluded, 0 events
//   scan on, no envelope          -> whole overlap is a clash
//   scan on, R=6 capsule          -> outside clash + inside unresolved -> check
//   scan on, R=6 + fit            -> outside clash remains; fit resolved
//   scan on, R=30 + fit           -> 0 clash, fit resolved -> pass
//   scan on, R=30 no fit          -> 0 clash but unresolved -> check
//
//   node scripts/accept-motion-joint-pairs.mjs [--runtime <dir>]

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMotion, runMotionInTs } from '../src/host/motion.ts';
import { resetPythonWorker } from '../src/host/python-worker.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
process.env.DSH_CAD_PYTHON_ROOT = resolve(argOf('--runtime', process.env.DSH_CAD_PYTHON_ROOT?.trim() || join(REPO, '.tmp-measure-runtime')));
const venvPython = process.platform === 'win32'
  ? join(process.env.DSH_CAD_PYTHON_ROOT, 'venv', 'Scripts', 'python.exe')
  : join(process.env.DSH_CAD_PYTHON_ROOT, 'venv', 'bin', 'python');
const havePython = existsSync(venvPython);

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const { compileStlOnly } = await import('../src/host/compile.ts');
const plate = await compileStlOnly('cube([40,20,20], center=true);');
const block = await compileStlOnly('cube([10,10,10], center=true);');
if (!plate.success || !block.success) {
  console.error('compile failed');
  process.exit(2);
}

const joint = (extra = {}) => ({
  type: 'revolute', bodyA: 'plate', bodyB: 'block',
  anchorA: [20, 0, 0], anchorB: [5, 0, 0],
  axisA: [0, 1, 0], axisB: [0, 1, 0],
  ...extra,
});
const base = (extra = {}) => ({
  parts: [
    { name: 'plate', stl: plate.stl, bodyType: 'kinematic', position: [0, 0, 0] },
    { name: 'block', stl: block.stl, bodyType: 'dynamic', position: [15, 0, 0] },
  ],
  joints: [joint(extra)],
  drive: { body: 'plate', axis: [0, 1, 0], omegaRadPerSec: 0.5 },
  cycles: 0.02,
});

const run = async (scenario) => {
  const ts = await runMotionInTs(scenario);
  const py = havePython ? await runMotion(scenario) : null;
  return { ts, py };
};

console.log('--- scan off: the hinge pair is coverage, not a result ---');
{
  const { ts, py } = await run(base());
  check(ts.metrics.excludedJointPairs.length === 1, 'TS: the pair is listed as excluded', JSON.stringify(ts.metrics.excludedJointPairs));
  check(ts.metrics.candidatePairs === 0, 'TS: no candidate pairs', `${ts.metrics.candidatePairs}`);
  check(ts.metrics.interferenceCount === 0, 'TS: no event — never looked at', `${ts.metrics.interferenceCount}`);
  if (py) check(py.metrics.interferenceCount === ts.metrics.interferenceCount, 'Python: event count agrees', `${py.metrics.interferenceCount}`);
}

console.log('--- no envelope: nothing is forgiven ---');
{
  const { ts, py } = await run({ ...base(), scanJointPairs: true });
  check(ts.metrics.candidatePairs === 1, 'TS: the hinge pair is a candidate', `${ts.metrics.candidatePairs}`);
  check(ts.metrics.interferenceCount > 0, 'TS: the whole overlap is a clash', `${ts.metrics.interferenceCount}`);
  check(ts.metrics.jointExemptions.length === 0, 'TS: no envelope -> no exemption', JSON.stringify(ts.metrics.jointExemptions));
  // A clash that cannot say WHERE is the defect this field closes: without it the
  // caller must reload the run's parts + trajectory and redo the boolean by hand.
  const ev = ts.metrics.interferenceEvents[0];
  check(Array.isArray(ev?.overlapBboxMm) && ev.overlapBboxMm.length === 6,
    'TS: the clash carries its overlap bbox', JSON.stringify(ev?.overlapBboxMm));
  check(Boolean(ev?.overlapBboxMm)
    && ev.overlapBboxMm[0] <= ev.overlapBboxMm[3]
    && ev.overlapBboxMm[1] <= ev.overlapBboxMm[4]
    && ev.overlapBboxMm[2] <= ev.overlapBboxMm[5],
    'TS: bbox min <= max on every axis', JSON.stringify(ev?.overlapBboxMm));
  if (py) {
    const pev = py.metrics.interferenceEvents[0];
    check(Array.isArray(pev?.overlapBboxMm) && pev.overlapBboxMm.length === 6,
      'Python: the clash carries its overlap bbox', JSON.stringify(pev?.overlapBboxMm));
    check(py.metrics.interferenceCount === ts.metrics.interferenceCount, 'Python: clash count agrees', `${py.metrics.interferenceCount}`);
  }
}

console.log('--- R=6 capsule, no fit: outside clash + unresolved inside ---');
{
  const { ts, py } = await run({ ...base({ overlapEnvelope: { radiusMm: 6, halfLengthMm: 10 } }), scanJointPairs: true });
  const exempt = ts.metrics.jointExemptions[0];
  check(ts.metrics.interferenceCount > 0, 'TS: outside-capsule overlap is still a clash', `${ts.metrics.interferenceCount}`);
  check(exempt?.maxVolumeMm3 > 1, 'TS: in-capsule overlap is measured', `${exempt?.maxVolumeMm3}`);
  check(exempt?.resolved === false, 'TS: no fit -> unresolved', String(exempt?.resolved));
  check(exempt?.attention.includes('unresolved-fit') === true, 'TS: attention names unresolved-fit', JSON.stringify(exempt?.attention));
  check(ts.metrics.jointFitsUnresolved === 1, 'TS: one unresolved fit gates the run', `${ts.metrics.jointFitsUnresolved}`);
  check(ts.overallStatus === 'check', 'TS: run is check, not pass', ts.overallStatus);
  if (py) {
    check(py.metrics.jointFitsUnresolved === 1, 'Python: unresolved fit count agrees', `${py.metrics.jointFitsUnresolved}`);
    check(Math.abs((py.metrics.jointExemptions[0]?.maxVolumeMm3 ?? 0) - (exempt?.maxVolumeMm3 ?? 0)) < 0.01,
      'Python: exempt volume agrees', `${py.metrics.jointExemptions[0]?.maxVolumeMm3} vs ${exempt?.maxVolumeMm3}`);
  }
}

console.log('--- R=6 capsule + fit: inside resolved, outside still clashes ---');
{
  const { ts } = await run({ ...base({ overlapEnvelope: { radiusMm: 6, halfLengthMm: 10 }, fit: 'bearing' }), scanJointPairs: true });
  const exempt = ts.metrics.jointExemptions[0];
  check(exempt?.resolved === true, 'TS: fit resolves the in-envelope overlap', String(exempt?.resolved));
  check(ts.metrics.jointFitsUnresolved === 0, 'TS: no unresolved fit', `${ts.metrics.jointFitsUnresolved}`);
  check(ts.metrics.interferenceCount > 0, 'TS: outside clash is NOT excused by fit', `${ts.metrics.interferenceCount}`);
}

console.log('--- R=30 + fit: swallowed overlap passes, but is listed ---');
{
  const { ts, py } = await run({ ...base({ overlapEnvelope: { radiusMm: 30, halfLengthMm: 10 }, fit: 'press-fit' }), scanJointPairs: true });
  check(ts.metrics.interferenceCount === 0, 'TS: nothing outside the declared capsule', `${ts.metrics.interferenceCount}`);
  const exempt = ts.metrics.jointExemptions[0];
  check(exempt?.frames > 0, 'TS: swallowed overlap is LISTED', JSON.stringify(exempt));
  check(exempt?.resolved === true, 'TS: declared fit is recorded', String(exempt?.resolved));
  check(ts.metrics.jointFitsUnresolved === 0, 'TS: no unresolved fit', `${ts.metrics.jointFitsUnresolved}`);
  check(ts.overallStatus === 'pass', 'TS: declared fit -> pass', ts.overallStatus);
  if (py) check(py.metrics.jointExemptions[0]?.frames === exempt?.frames, 'Python: exempt frames agree', `${py.metrics.jointExemptions[0]?.frames}`);
}

console.log('--- R=30 no fit: swallowed overlap keeps the run check ---');
{
  const { ts, py } = await run({ ...base({ overlapEnvelope: { radiusMm: 30, halfLengthMm: 10 } }), scanJointPairs: true });
  check(ts.metrics.interferenceCount === 0, 'TS: nothing outside the capsule', `${ts.metrics.interferenceCount}`);
  check(ts.metrics.jointFitsUnresolved === 1, 'TS: one unresolved fit gates the run', `${ts.metrics.jointFitsUnresolved}`);
  check(ts.overallStatus === 'check', 'TS: swallowed overlap without a fit is check', ts.overallStatus);
  check(ts.metrics.jointExemptions[0]?.requiredAction !== null, 'TS: requiredAction tells the agent what to do', String(ts.metrics.jointExemptions[0]?.requiredAction));
  if (py) check(py.metrics.jointFitsUnresolved === 1, 'Python: unresolved fit gates too', `${py.metrics.jointFitsUnresolved}`);
}

resetPythonWorker();
console.log(failures === 0 ? '\nOK' : `\nFAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
