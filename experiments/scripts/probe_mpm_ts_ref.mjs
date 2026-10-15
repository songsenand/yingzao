// TS MPM kernel reference timing — same pipe scene as probe_numba_mpm.py.
// Run: node experiments/scripts/probe_mpm_ts_ref.mjs
// Refreshes the 2026-10-08 TS baselines (3.1/23.4/88.3 ms/step) on today's machine.

import { performance } from 'node:perf_hooks';
import { createMpmWorld } from '../../dsh-cad-harness/src/host/mpm.ts';

const CELLS = [100, 24, 24];
const CONFIG = {
  cells: CELLS,
  dxMm: 2,
  dt: 0.004,
  vmax: 60,
  gravity: [0, 0, -49.05],
  stiffness: 50,
  viscosity: 0.1,
  inlet: { axis: 0, band: [2, 5], speed: 25 },
  recycle: { axis: 0, at: 98, respawn: 3 },
};
const LADDER_S = [1.0, 0.5, 0.28, 0.25];

function lattice(s) {
  const xs = [], ys = [], zs = [];
  for (let x = 2.5; x < 22.0; x += s) xs.push(x);
  for (let y = 2.0; y < 22.5; y += s) ys.push(y);
  for (let z = 2.0; z < 22.5; z += s) zs.push(z);
  const points = [];
  for (const x of xs) for (const y of ys) for (const z of zs) points.push([x, y, z]);
  return points;
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[(s.length - 1) >> 1];
}

const results = [];
for (const s of LADDER_S) {
  const pts = lattice(s);
  let idx = 0;
  const world = createMpmWorld({ ...CONFIG, particleCount: pts.length }, () => {
    const p = pts[idx % pts.length];
    idx += 1;
    return p;
  });
  const steps = pts.length < 100_000 ? 50 : 25;

  for (let i = 0; i < 3; i += 1) world.step();
  const blocks = [];
  for (let b = 0; b < 3; b += 1) {
    const t0 = performance.now();
    for (let i = 0; i < steps; i += 1) world.step();
    blocks.push((performance.now() - t0) / steps);
  }
  const entry = {
    latticeSpacingCells: s,
    particles: pts.length,
    timedStepsPerBlock: steps,
    restDensity: world.restDensity,
    tsKernel: {
      msPerStepBlocks: blocks.map((v) => Math.round(v * 1000) / 1000),
      msPerStepBest: Math.round(Math.min(...blocks) * 1000) / 1000,
      msPerStepMedian: Math.round(median(blocks) * 1000) / 1000,
    },
  };
  results.push(entry);
  console.log(JSON.stringify(entry));
}
const { writeFileSync } = await import('node:fs');
writeFileSync(
  new URL('../20261014_numba_mpm_ts_ref.json', import.meta.url),
  JSON.stringify({ date: '2026-10-14', node: process.version, ladder: results }, null, 2) + '\n',
);
console.log('results -> experiments/20261014_numba_mpm_ts_ref.json');
