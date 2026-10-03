// M4 solver scaling benchmark: same physical pipe, increasing particle count.
//
// Answers: why cap at 10k particles for offline runs? Measures ms/step and
// quality (throughput, velocity profile noise, compression, stability) across
// a particle-count ladder on an identical physical scene.
//
// Physical scene (fixed across runs): pipe 48×48×200 mm along +x, dx=2mm
// → solver grid 24×24×100 cells (57.6k cells). Inlet band drives flow at
// 50 mm/s; particles recycle at the outlet (transit counter).
//
// Ladder: lattice spacing s in cells → particles ≈ fillVolume/s³:
//   s=1.00 → ~11.5k (1/cell)   s=0.63 → ~46k (4/cell)   s=0.50 → ~92k (8/cell)
//   s=0.40 → ~180k (16/cell)   s=0.32 → ~352k (30/cell)  s=0.25 → ~737k (64/cell)
//
// Comparability: the reference solver's stiffness/viscosity act per unit mass,
// so per-run they scale with rest density (K_i = K0·ρ_i/ρ0, μ_i = μ0·ρ_i/ρ0);
// dt and gravity stay identical → same physical time across runs.

import { createMpmWorld } from '../src/host/mpm.ts';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(new URL('../', import.meta.url).pathname);
const OUT_DIR = join(ROOT, 'data', 'bench');
mkdirSync(OUT_DIR, { recursive: true });

// --- physical scene (solver runs in cells; 1 cell = 2 mm) ---
const NX = 100, NY = 24, NZ = 24;        // flow along +x (long axis)
const DX_MM = 2;
const FILL_X0 = 2, FILL_X1 = 22;        // fluid block 20 cells long, full section
const INLET_BAND = [2, 5];
const INLET_SPEED = 25;                  // cells/s = 50 mm/s
const RECYCLE_AT = 98, RESPAWN_X = 3;
const DT = 0.004;                        // s (CFL: vmax·dt = 0.24 cells)
const VMAX = 60;                         // cells/s (= 120 mm/s)
const GRAVITY = [0, 0, -49.05];          // -98.1 mm/s² (gentle, keeps pool shallow)

const K0 = 50, MU0 = 0.1, RD0 = 1.5;     // reference constants @ ρ0=1.5

// ladder: [spacingCells, stepsTimed, stepsTotal]
const LADDER = [
  [1.0, 100, 700],
  [0.63, 100, 700],
  [0.5, 100, 700],
  [0.4, 100, 700],
  [0.32, 100, 500],
  [0.25, 100, 400],
];

const lattice = (s) => {
  const perX = Math.floor((FILL_X1 - FILL_X0) / s);
  const perY = Math.floor((NY - 3) / s);
  const perZ = Math.floor((NZ - 3) / s);
  return { perX, perY, perZ, count: perX * perY * perZ };
};


function buildWorld(s) {
  const { count } = lattice(s);
  let i = 0;
  const seed = () => {
    const { perX, perY, perZ } = lattice(s);
    const x = FILL_X0 + (i % perX) * s + 0.5 + s / 2;
    const y = 1.5 + (Math.floor(i / perX) % perY) * s + s / 2;
    const z = 1.5 + (Math.floor(i / (perX * perY)) % perZ) * s + s / 2;
    i++;
    return [x, y, z];
  };
  const world = createMpmWorld({
    cells: [NX, NY, NZ],
    dxMm: DX_MM,
    particleCount: count,
    gravity: GRAVITY,
    dt: DT,
    vmax: VMAX,
    inlet: { axis: 0, band: INLET_BAND, speed: INLET_SPEED },
    recycle: { axis: 0, at: RECYCLE_AT, respawn: RESPAWN_X },
  }, seed);
  const rd = world.calibrateRestDensity();
  world.cfg.stiffness = K0 * (rd / RD0);
  world.cfg.viscosity = MU0 * (rd / RD0);
  return { world, count, restDensity: rd };
}

function quality(w, steps) {
  const { pos, vel, n } = w;
  const bins = new Array(10).fill(0);
  const binsN = new Array(10).fill(0);
  let vxx2 = 0, vxx = 0, vmid = 0;
  let minMargin = Infinity;
  let nan = 0;
  let ke = 0;
  let outOfRange = 0;
  for (let p = 0; p < n; p++) {
    const x = pos[p * 3], y = pos[p * 3 + 1], z = pos[p * 3 + 2];
    const vx = vel[p * 3], vy = vel[p * 3 + 1], vz = vel[p * 3 + 2];
    if (!Number.isFinite(x + y + z + vx + vy + vz)) { nan++; continue; }
    ke += 0.5 * (vx * vx + vy * vy + vz * vz);
    const b = Math.min(9, Math.max(0, Math.floor((x - 1.5) / (NX - 3) * 10)));
    bins[b] += vx; binsN[b]++;
    const m = Math.min(x - 1.5, NX - 1.5 - x, y - 1.5, NY - 1.5 - y, z - 1.5, NZ - 1.5 - z);
    if (m < minMargin) minMargin = m;
    if (x < 1.45 || x > NX - 1.45 || y < 1.45 || y > NY - 1.45 || z < 1.45 || z > NZ - 1.45) outOfRange++;
    if (b >= 4 && b <= 5) { vxx += vx; vxx2 += vx * vx; vmid++; }
  }
  const profile = bins.map((v, k) => +(binsN[k] ? v / binsN[k] : 0).toFixed(3));
  const meanVx = vmid ? vxx / vmid : 0;
  const noise = vmid ? Math.sqrt(Math.max(0, vxx2 / vmid - meanVx * meanVx)) : 0;
  const profileMean = profile.reduce((a, b) => a + b, 0) / 10;
  return {
    profile,
    profileMeanAxial: +profileMean.toFixed(3),
    midSectionNoiseSigma: +noise.toFixed(3),
    midSectionMeanVx: +meanVx.toFixed(3),
    noiseRatio: +profileMean > 0 ? +(noise / Math.abs(meanVx)).toFixed(3) : null,
    minWallMarginCells: +minMargin.toFixed(3),
    outOfRange,
    nan,
    kePerParticle: +(ke / n).toFixed(1),
    transitsPerStep: +(w.transits / steps).toFixed(4),
    maxSpeed: +w.lastStep.maxSpeed.toFixed(2),
    clampedFraction: +w.lastStep.clampedFraction.toFixed(4),
  };
}

const results = [];

for (const [s, stepsTimed, stepsTotal] of LADDER) {
  console.log(`\n=== s=${s} ===`);
  const t0 = Date.now();
  const { world: w, count, restDensity: rd } = buildWorld(s);
  const memMB = process.memoryUsage().rss / 1e6;
  console.log(`particles=${count} restDensity=${rd.toFixed(2)} K=${w.cfg.stiffness.toFixed(1)} rss=${memMB.toFixed(0)}MB`);

  for (let i = 0; i < 10; i++) w.step(); // warmup

  const times = [];
  for (let i = 0; i < stepsTimed; i++) {
    const t = performance.now();
    w.step();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)];

  for (let i = stepsTimed + 10; i < stepsTotal; i++) w.step();
  const q = quality(w, stepsTotal);
  const row = {
    spacingCells: s,
    particles: count,
    particlesPerCell: +(1 / (s * s * s)).toFixed(1),
    restDensity: +rd.toFixed(2),
    stiffness: +w.cfg.stiffness.toFixed(1),
    rssMB: +memMB.toFixed(0),
    msPerStepP50: +p50.toFixed(1),
    msPerStepMean: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1),
    stepsPerSec: +(1000 / p50).toFixed(1),
    est600StepRunSec: +(p50 * 600 / 1000).toFixed(0),
    ...q,
    wallSec: +((Date.now() - t0) / 1000).toFixed(1),
  };
  results.push(row);
  console.log(JSON.stringify(row));
  writeFileSync(join(OUT_DIR, 'mpm-scaling.json'), JSON.stringify(results, null, 2));
}

console.log('\n===== SUMMARY (same pipe, finer particles →) =====');
console.log(['particles', 'ms/step', 'steps/s', '600step_s', 'throughput', 'noise/mean', 'nan', 'rssMB'].join('\t'));
for (const r of results) {
  console.log(
    [r.particles, r.msPerStepP50, r.stepsPerSec, r.est600StepRunSec, r.transitsPerStep, r.noiseRatio, r.nan, r.rssMB].join('\t'),
  );
}
console.log('\nsaved:', join(OUT_DIR, 'mpm-scaling.json'));
