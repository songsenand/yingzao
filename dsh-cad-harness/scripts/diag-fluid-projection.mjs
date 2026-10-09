// DIAGNOSTIC: is the fluid run's high-density transport gap caused by the SDF
// projection? Run the same 200-step pipe scenario on both engines with the
// projection ON and OFF and compare.
import { performance } from 'node:perf_hooks';
const { compileStlOnly } = await import('../src/host/compile.ts');
const { deriveGridFromStl, runFluid, runFluidInTs } = await import('../src/host/fluid.ts');

const pipe = await compileStlOnly(`difference() {
  translate([100,0,0]) rotate([0,90,0]) cylinder(h=200, d=48, center=true);
  translate([100,0,0]) rotate([0,90,0]) cylinder(h=210, d=40, center=true);
}`);
const { cells, originMm } = deriveGridFromStl(pipe.stl, 2);
const scenario = {
  pipeStl: pipe.stl, gridCells: cells, gridOriginMm: originMm, dxMm: 2,
  fluidRegionMm: { min: [5, -15, -15], max: [65, 15, 15] },
  inlet: { axis: 0, bandMm: [4, 12], velocityMmPerSec: 100 },
  outletPlaneMm: 195,
  particlesPerCell: 6,
  steps: Number(process.env.STEPS ?? 200),
  gravityMmPerSec2: [0, 0, 0],
  snapshotCount: 0,
};

async function run(label, fn) {
  const t0 = performance.now();
  const { report } = await fn(scenario);
  const m = report.metrics;
  console.log(`${label.padEnd(26)} avgV=${String(m.avgVelocityMmPerSec).padStart(7)} maxV=${String(m.maxVelocityMmPerSec).padStart(7)} escaped=${String(m.escaped).padStart(6)} active=${String(m.active).padStart(6)} (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
}

process.env.CAD_FLUID_NO_PROJECT = '';
await run('TS  proj ON', runFluidInTs);
await run('py  proj ON', runFluid);
process.env.CAD_FLUID_NO_PROJECT = '1';
await run('TS  proj OFF', runFluidInTs);
process.env.DSH_CAD_FLUID_PYTHON = '1';
await run('py  proj OFF', runFluid);
process.exit(0);
