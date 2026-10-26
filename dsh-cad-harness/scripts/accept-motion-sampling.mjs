// Acceptance for motion interference SAMPLING coverage (2026-10-26).
//
// Why this exists: `samplePerCycle = 24` is a density per crank PERIOD, not per
// RUN. A 0.03-cycle working sweep (754 steps at omega=0.5) got sampleEvery=1047,
// so the interference loop ran ZERO times — while `interferenceCount = 0` and
// `clean = true` still reported pass. The toy-balance working-range runs
// (r070/r013) are exactly this shape, and their "0 interference" was cited as
// assembly evidence.
//
// The rule now: every motion run gets at least 24 sampled poses, the FINAL pose
// is always sampled, and a run that cannot fit 24 poses is `check`, never pass.
//
//   node scripts/accept-motion-sampling.mjs [--runtime <dir>]

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMotion, runMotionInTs } from '../src/host/motion.ts';
import { resetPythonWorker } from '../src/host/python-worker.ts';

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
  console.error(`no venv python at ${venvPython}`);
  process.exit(2);
}

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const { compileStlOnly } = await import('../src/host/compile.ts');
const arm = await compileStlOnly('translate([40,0,0]) cube([80,8,8], center=true);');
const block = await compileStlOnly('translate([70,15,0]) cube([40,10,10], center=true);');
if (!arm.success || !block.success) {
  console.error('compile failed');
  process.exit(2);
}

// A fixed block the rotating arm reaches only part-way through a 10.8° sweep:
// the run DID move and DID overlap, so a zero-check run would still have said
// "0 interference". That is the false green this acceptance pins down.
const BASE = {
  parts: [
    { name: 'block', stl: block.stl, bodyType: 'fixed', position: [0, 0, 0] },
    { name: 'arm', stl: arm.stl, bodyType: 'kinematic', position: [0, 0, 0] },
  ],
  joints: [],
  drive: { body: 'arm', axis: [0, 0, 1], omegaRadPerSec: 0.5 },
};

console.log('--- motion sampling: short sweep must be CHECKED, not assumed ---');

// 1. The working-range shape: 0.03 turn = 10.8°, 754 steps at omega=0.5.
{
  const scenario = { ...BASE, cycles: 0.03 };
  const py = await runMotion(scenario);
  const ts = await runMotionInTs(scenario);
  const m = py.metrics;

  check(py.stepsRun === 754 && py.durationSec === 0.377,
    'short sweep: 754 steps / 0.377s', `${py.stepsRun} / ${py.durationSec}s`);
  check(m.interferenceChecks >= 24,
    'short sweep: >= 24 sampled poses', `${m.interferenceChecks}`);
  check(m.samplingSatisfied === true,
    'short sweep: sampling satisfied', String(m.samplingSatisfied));
  check(m.candidatePairs === 1,
    'short sweep: the unjointed pair is a candidate', `${m.candidatePairs}`);
  check(m.interferencePairChecks === m.interferenceChecks * m.candidatePairs,
    'short sweep: pair checks = poses × pairs', `${m.interferencePairChecks}`);
  check(m.interferenceCount > 0,
    'short sweep: the late overlap is FOUND', `${m.interferenceCount} event(s)`);
  check(py.trajectory.times.length >= 25 && py.trajectory.times.at(-1) === 0.377,
    'short sweep: trajectory ends at the final pose',
    `${py.trajectory.times.length} frames · last ${py.trajectory.times.at(-1)}`);
  check(py.keyframes.some((k) => k.label === 'final' && k.timeSec === 0.377),
    'short sweep: final keyframe is the end pose');
  check(typeof m.maxSampleGapDeg === 'number' && m.maxSampleGapDeg < 1,
    'short sweep: max crank gap < 1°', `${m.maxSampleGapDeg}°`);

  // The two engines must agree on the coverage numbers, not only the verdict.
  check(ts.metrics.interferenceChecks === m.interferenceChecks,
    'short sweep: TS/Python checks agree', `TS ${ts.metrics.interferenceChecks} · py ${m.interferenceChecks}`);
  check(ts.metrics.interferencePairChecks === m.interferencePairChecks,
    'short sweep: TS/Python pair checks agree', `TS ${ts.metrics.interferencePairChecks} · py ${m.interferencePairChecks}`);
  check(ts.metrics.interferenceCount === m.interferenceCount,
    'short sweep: TS/Python interference events agree', `TS ${ts.metrics.interferenceCount} · py ${m.interferenceCount}`);
  check(ts.metrics.maxSampleGapDeg === m.maxSampleGapDeg,
    'short sweep: TS/Python max gap agree', `TS ${ts.metrics.maxSampleGapDeg}° · py ${m.maxSampleGapDeg}°`);
  check(ts.metrics.samplingSatisfied === m.samplingSatisfied,
    'short sweep: TS/Python coverage flag agree', String(m.samplingSatisfied));
  check(ts.overallStatus === py.overallStatus,
    'short sweep: TS/Python status agree', `TS ${ts.overallStatus} · py ${py.overallStatus}`);
}

// 2. A full turn keeps the old density (24/cycle) and still adds the final pose.
{
  const scenario = { ...BASE, cycles: 1 };
  const py = await runMotion(scenario);
  const m = py.metrics;
  check(m.interferenceChecks >= 24 && m.samplingSatisfied === true,
    'full turn: coverage satisfied', `${m.interferenceChecks} poses`);
  check(m.maxSampleGapDeg === 15,
    'full turn: 24/cycle = 15° per sample (unchanged)', `${m.maxSampleGapDeg}°`);
  check(py.trajectory.times.at(-1) === 12.5665,
    'full turn: trajectory ends at the final step', `${py.trajectory.times.at(-1)}`);
}

// 3. Too little travel to fit 24 poses: a check, never a pass. This is the old
//    "durationSec = 0" shape; the engine must not dress it as a clean run.
{
  const scenario = { ...BASE, cycles: 0.00001 };
  const py = await runMotion(scenario);
  const m = py.metrics;
  check(py.overallStatus === 'check',
    'degenerate sweep: status is check', py.overallStatus);
  check(m.samplingSatisfied === false,
    'degenerate sweep: sampling NOT satisfied', String(m.samplingSatisfied));
  check(m.interferenceChecks < 24,
    'degenerate sweep: fewer than 24 poses', `${m.interferenceChecks}`);
  check(py.stepsRun === 1,
    'degenerate sweep: one step', `${py.stepsRun}`);
}

resetPythonWorker();
console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
