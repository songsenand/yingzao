// Compare the two projections quantity by quantity on the Ø100 case.
process.env.CAD_FLUID_DEBUG_PROJECT = '1';
process.env.CAD_FLUID_DEBUG_PENETRATION = '1';
const { compileStlOnly } = await import('../src/host/compile.ts');
const { deriveFluidPreset, runFluid, runFluidInTs } = await import('../src/host/fluid.ts');

const tube = (od, bore = 30, len = 100) => `$fn=64;
difference(){ rotate([0,90,0]) cylinder(h=${len},d=${od},center=true);
              rotate([0,90,0]) cylinder(h=${len+10},d=${bore},center=true); }`;
const stl = (await compileStlOnly(tube(100))).stl;
const p = deriveFluidPreset(stl, 2, 100);
const scenario = {
  pipeStl: stl, gridCells: p.gridCells, gridOriginMm: p.gridOriginMm, dxMm: p.dxMm,
  fluidRegionMm: p.fluidRegionMm,
  inlet: { axis: p.axis, bandMm: p.inletBandMm, velocityMmPerSec: 100 },
  outletPlaneMm: p.outletPlaneMm, particlesPerCell: 6, steps: p.steps, snapshotCount: 0,
};
const ts = await runFluidInTs(scenario);
const tsDebug = ts.report.debugProjection ?? ts.report.debugPenetration;
console.log('TS projection:', JSON.stringify(tsDebug));
console.log(`TS result: arrival=${ts.report.metrics.outletArrivalRatio} active=${ts.report.metrics.active} avgV=${ts.report.metrics.avgVelocityMmPerSec}`);
process.env.DSH_CAD_FLUID_PYTHON = '1';
const py = await runFluid(scenario);
console.log('py projection:', JSON.stringify(py.report.debugPenetration));
console.log(`py result: arrival=${py.report.metrics.outletArrivalRatio} active=${py.report.metrics.active} avgV=${py.report.metrics.avgVelocityMmPerSec}`);
process.exit(0);
