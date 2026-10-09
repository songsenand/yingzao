import { performance } from 'node:perf_hooks';
import { compileStlOnly } from '../src/host/compile.ts';
import { deriveFluidPreset, runFluid, runFluidInTs } from '../src/host/fluid.ts';
const tube = (od, bore = 30, len = 100) => `$fn=64;
difference(){ rotate([0,90,0]) cylinder(h=${len},d=${od},center=true);
              rotate([0,90,0]) cylinder(h=${len+10},d=${bore},center=true); }`;
const stl = (await compileStlOnly(tube(100))).stl;
const p = deriveFluidPreset(stl, 2, 100);
const scenario = {
  pipeStl: stl, gridCells: p.gridCells, gridOriginMm: p.gridOriginMm, dxMm: p.dxMm,
  fluidRegionMm: p.fluidRegionMm,
  inlet: { axis: p.axis, bandMm: p.inletBandMm, velocityMmPerSec: 100 },
  outletPlaneMm: p.outletPlaneMm, particlesPerCell: 6, steps: 600, snapshotCount: 0,
};
let t0 = performance.now();
const ts = await runFluidInTs(scenario);
const tsMs = performance.now() - t0;
process.env.DSH_CAD_FLUID_PYTHON = '1';
t0 = performance.now();
const py = await runFluid(scenario);
const pyMs = performance.now() - t0;
const f = (r) => `arrival=${r.metrics.outletArrivalRatio} active=${r.metrics.active} avgV=${r.metrics.avgVelocityMmPerSec}`;
console.log(`TS ${(tsMs/1000).toFixed(1)}s  ${f(ts.report)}`);
console.log(`py ${(pyMs/1000).toFixed(1)}s  ${f(py.report)}   ratio ${(pyMs/tsMs).toFixed(2)}x  (600 steps, 26923 particles)`);
process.exit(0);
