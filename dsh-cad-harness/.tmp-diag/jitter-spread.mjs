// How much does the Ø100 OUTCOME move when the TS run is perturbed by ~1e-9
// relative (the same order as the numpy-vs-JS numerical difference)?
import { compileStlOnly } from '../src/host/compile.ts';
import { deriveFluidPreset, runFluidInTs } from '../src/host/fluid.ts';
const tube = (od, bore = 30, len = 100) => `$fn=64;
difference(){ rotate([0,90,0]) cylinder(h=${len},d=${od},center=true);
              rotate([0,90,0]) cylinder(h=${len+10},d=${bore},center=true); }`;
const stl = (await compileStlOnly(tube(100))).stl;
const p = deriveFluidPreset(stl, 2, 100);
const arrivals = [];
for (const amp of ['0.04', '0.040000001', '0.039999999']) {
  process.env.CAD_MPM_JITTER_AMP = amp;
  const { report } = await runFluidInTs({
    pipeStl: stl, gridCells: p.gridCells, gridOriginMm: p.gridOriginMm, dxMm: p.dxMm,
    fluidRegionMm: p.fluidRegionMm,
    inlet: { axis: p.axis, bandMm: p.inletBandMm, velocityMmPerSec: 100 },
    outletPlaneMm: p.outletPlaneMm, particlesPerCell: 6, steps: p.steps, snapshotCount: 0,
  });
  arrivals.push(report.metrics.outletArrivalRatio);
  console.log(`jitter=${amp}: arrival=${report.metrics.outletArrivalRatio} escaped=${report.metrics.escaped} active=${report.metrics.active} avgV=${report.metrics.avgVelocityMmPerSec}`);
}
console.log(`spread across a 2.5e-8 relative perturbation: ${(Math.max(...arrivals) - Math.min(...arrivals)).toFixed(4)}`);
process.exit(0);
