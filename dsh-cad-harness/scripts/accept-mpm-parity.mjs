// Parity acceptance for the migrated MLS-MPM kernel (`mpm.ts` → worker `mpm_*` ops).
//
// WHAT IS BEING ACCEPTED. The kernel is a stepped numerical scheme: after N steps
// of a chaotic system, two implementations that differ only in SUMMATION ORDER
// (numpy vectorises the 27-cell scatter; the TS kernel accumulates sequentially)
// cannot agree bit for bit, and the sine used for the deterministic jitter differs
// in the last ulp between JS and numpy. So the contract is layered:
//
//   1. CONFIGURATION results must be identical: calibrated rest density, escaped /
//      transit counts, active count, non-finite count.
//   2. AGGREGATES must agree tightly (total momentum, position sum, mean speed) —
//      these are what the fluid tool actually audits (conservation, arrival ratio).
//   3. PER-PARTICLE state is reported, with a band, as evidence of how far the
//      trajectories drift inside one kernel.
//
// The real acceptance for `simulate_fluid` is `accept-m4.mjs` (24/24) against the
// wired tool; this script is the unit-level proof that the kernel itself matches.
//
//   node scripts/accept-mpm-parity.mjs [--runtime <dir>]

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createMpmWorld } from '../src/host/mpm.ts';
import { ensurePythonWorker, resetPythonWorker } from '../src/host/python-worker.ts';

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

/** A deterministic lattice seed, shared by both sides. */
function latticeSeeds(count, cells) {
  const seeds = [];
  const nx = Math.min(10, cells[0] - 4);
  const ny = Math.min(10, cells[1] - 4);
  const nz = Math.max(1, Math.ceil(count / (nx * ny)));
  for (let i = 0; i < count; i++) {
    seeds.push(
      2 + (i % nx) * 1.2,
      2 + (Math.floor(i / nx) % ny) * 1.2,
      4 + Math.floor(i / (nx * ny)) * (nz > 1 ? 1.2 : 0),
    );
  }
  return seeds;
}

const worker = await ensurePythonWorker();

const CASES = [
  {
    label: 'stress-driven expansion, no gravity (kernel math)',
    config: { cells: [16, 16, 32], dxMm: 2, particleCount: 1200, dt: 1 / 120, vmax: 6, gravity: [0, 0, 0], stiffness: 50, viscosity: 0.1 },
    steps: 20,
  },
  {
    label: 'gravity, clamped regime (CFL guard)',
    config: { cells: [16, 16, 32], dxMm: 2, particleCount: 1200, dt: 1 / 60, vmax: 6, gravity: [0, 0, -4905], stiffness: 50, viscosity: 0.1 },
    steps: 20,
  },
  {
    label: 'outlet escape (arrival accounting)',
    config: { cells: [16, 16, 40], dxMm: 2, particleCount: 1200, dt: 1 / 120, vmax: 8, gravity: [0, 0, 0], stiffness: 50, viscosity: 0.1, inlet: { axis: 2, band: [0, 8], speed: 5 }, escape: { axis: 2, at: 36 } },
    steps: 40,
  },
  {
    label: 'inlet drive + recycle (steady state)',
    config: { cells: [16, 16, 40], dxMm: 2, particleCount: 1200, dt: 1 / 120, vmax: 8, gravity: [0, 0, 0], stiffness: 50, viscosity: 0.1, inlet: { axis: 2, band: [0, 8], speed: 5 }, recycle: { axis: 2, at: 36, respawn: 3 } },
    steps: 40,
  },
];

console.log('--- MPM kernel parity: Python worker vs TS kernel ---');
{
  const base = { cells: [16, 16, 40], dxMm: 2, particleCount: 1200, dt: 1 / 120, vmax: 8, gravity: [0, 0, 0], stiffness: 50, viscosity: 0.1 };
  const seeds = latticeSeeds(1200, base.cells);
  const idle = await worker.request('mpm_create', { config: base, seeds });
  await worker.request('mpm_step', { worldId: idle.worldId, steps: 40 });
  const idleState = await worker.request('mpm_state', { worldId: idle.worldId });
  await worker.request('mpm_destroy', { worldId: idle.worldId });
  const driven = await worker.request('mpm_create', { config: { ...base, inlet: { axis: 2, band: [0, 8], speed: 5 } }, seeds });
  await worker.request('mpm_step', { worldId: driven.worldId, steps: 40 });
  const drivenState = await worker.request('mpm_state', { worldId: driven.worldId });
  await worker.request('mpm_destroy', { worldId: driven.worldId });
  check(drivenState.meanSpeed > idleState.meanSpeed * 1.05, 'the inlet actually drives the flow', `idle ${idleState.meanSpeed.toFixed(4)} → driven ${drivenState.meanSpeed.toFixed(4)} cells/s`);
}
for (const testCase of CASES) {
  const count = testCase.config.particleCount;
  const seeds = latticeSeeds(count, testCase.config.cells);

  // TS side: the kernel driven directly, with the same seeds.
  const seedFn = (i) => [seeds[i * 3], seeds[i * 3 + 1], seeds[i * 3 + 2]];
  const tsWorld = createMpmWorld(testCase.config, seedFn);
  tsWorld.calibrateRestDensity();
  const tsStart = performance.now();
  for (let i = 0; i < testCase.steps; i++) tsWorld.step();
  const tsMs = performance.now() - tsStart;

  // Python side: the worker owns the state.
  const created = await worker.request('mpm_create', { config: testCase.config, seeds });
  const pyStart = performance.now();
  await worker.request('mpm_step', { worldId: created.worldId, steps: testCase.steps });
  const pyMs = performance.now() - pyStart;
  const pyState = await worker.request('mpm_state', { worldId: created.worldId, particles: true });
  await worker.request('mpm_destroy', { worldId: created.worldId });

  console.log(`  -- ${testCase.label} --`);
  // The calibration is a median over per-cell masses, and the two sides sum the
  // scatter in different orders (sequential vs np.bincount) — 1e-6 relative is the
  // honest band, not bit equality.
  const densRel = Math.abs(created.restDensity - tsWorld.restDensity) / Math.max(1e-12, Math.abs(tsWorld.restDensity));
  check(densRel < 1e-6, 'calibrated rest density within 1e-6 relative', `TS ${tsWorld.restDensity.toFixed(12)} · py ${created.restDensity.toFixed(12)} (Δrel ${densRel.toExponential(2)})`);
  check(created.particles === count, 'particle count', `${created.particles}`);
  check(pyState.activeN === tsWorld.activeN, 'active particles after the run', `TS ${tsWorld.activeN} · py ${pyState.activeN}`);
  check(pyState.escaped === tsWorld.escaped, 'escaped count', `TS ${tsWorld.escaped} · py ${pyState.escaped}`);
  check(pyState.transits === tsWorld.transits, 'recycle transits', `TS ${tsWorld.transits} · py ${pyState.transits}`);
  check(pyState.nonFinite === tsWorld.nonFinite, 'non-finite events', `TS ${tsWorld.nonFinite} · py ${pyState.nonFinite}`);

  // Aggregates: these are what the fluid tool audits.
  let tsVelSum = [0, 0, 0];
  let tsPosSum = [0, 0, 0];
  let tsSpeedSum = 0;
  const activeN = tsWorld.activeN;
  for (let p = 0; p < activeN; p++) {
    for (let axis = 0; axis < 3; axis++) {
      tsVelSum[axis] += tsWorld.vel[p * 3 + axis];
      tsPosSum[axis] += tsWorld.pos[p * 3 + axis];
    }
    tsSpeedSum += Math.hypot(tsWorld.vel[p * 3], tsWorld.vel[p * 3 + 1], tsWorld.vel[p * 3 + 2]);
  }
  const tsMeanSpeed = activeN ? tsSpeedSum / activeN : 0;
  const rel = (a, b) => Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b));
  check(rel(pyState.meanSpeed, tsMeanSpeed) < 0.05, 'mean speed within 5%', `TS ${tsMeanSpeed.toFixed(6)} · py ${pyState.meanSpeed.toFixed(6)}`);
  for (let axis = 0; axis < 3; axis++) {
    check(rel(pyState.velocitySum[axis], tsVelSum[axis]) < 0.05, `total momentum[${axis}] within 5%`, `TS ${tsVelSum[axis].toFixed(3)} · py ${pyState.velocitySum[axis].toFixed(3)}`);
    const posRel = Math.abs(pyState.positionSum[axis] - tsPosSum[axis]) / Math.max(1, Math.abs(tsPosSum[axis]));
    check(posRel < 0.02, `position sum[${axis}] within 2%`, `TS ${tsPosSum[axis].toFixed(3)} · py ${pyState.positionSum[axis].toFixed(3)} (Δrel ${posRel.toExponential(2)})`);
  }
  check(Math.abs(pyState.clampedFraction - tsWorld.lastStep.clampedFraction) < 0.02, 'clamped fraction within 2pp', `TS ${(tsWorld.lastStep.clampedFraction * 100).toFixed(2)}% · py ${(pyState.clampedFraction * 100).toFixed(2)}%`);

  // Per-particle drift, reported as evidence (not asserted tightly: the two sides
  // sum the scatter in different orders).
  let maxPos = 0;
  let maxVel = 0;
  const cell = testCase.config.dxMm;
  for (let p = 0; p < Math.min(activeN, pyState.activeN); p++) {
    maxPos = Math.max(maxPos, Math.hypot(
      pyState.pos[p * 3] - tsWorld.pos[p * 3],
      pyState.pos[p * 3 + 1] - tsWorld.pos[p * 3 + 1],
      pyState.pos[p * 3 + 2] - tsWorld.pos[p * 3 + 2],
    ));
    maxVel = Math.max(maxVel, Math.hypot(
      pyState.vel[p * 3] - tsWorld.vel[p * 3],
      pyState.vel[p * 3 + 1] - tsWorld.vel[p * 3 + 1],
      pyState.vel[p * 3 + 2] - tsWorld.vel[p * 3 + 2],
    ));
  }
  console.log(`      per-particle drift: max |Δpos| ${maxPos.toExponential(3)} cells (${(maxPos / cell).toExponential(3)} mm) · max |Δvel| ${maxVel.toExponential(3)} cells/s`);
  console.log(`      timing: TS ${tsMs.toFixed(0)} ms · Python ${pyMs.toFixed(0)} ms (${(pyMs / Math.max(tsMs, 0.01)).toFixed(2)}×)`);
}

resetPythonWorker();
console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
