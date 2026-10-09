// Is the Ø100 gap the INLET x projection interaction? Same case, no inlet drive.
process.env.CAD_FLUID_DEBUG_PROJECT = '1';
process.env.CAD_FLUID_DEBUG_PENETRATION = '1';
const { compileStlOnly } = await import('../src/host/compile.ts');
const { deriveFluidPreset, runFluid, runFluidInTs } = await import('../src/host/fluid.ts');

const tube = (od, bore = 30, len = 100) => `$fn=64;
difference(){ rotate([0,90,0]) cylinder(h=${len},d=${od},center=true);
              rotate([0,90,0]) cylinder(h=${len+10},d=${bore},center=true); }`;
const stl = (await compileStlOnly(tube(100))).stl;
const p = deriveFluidPreset(stl, 2, 100);
const base = {
  pipeStl: stl, gridCells: p.gridCells, gridOriginMm: p.gridOriginMm, dxMm: p.dxMm,
  fluidRegionMm: p.fluidRegionMm,
  outletPlaneMm: p.outletPlaneMm, particlesPerCell: 6, steps: p.steps, snapshotCount: 0,
};
const show = (label, r) => console.log(`${label.padEnd(22)} arrival=${r.metrics.outletArrivalRatio} escaped=${r.metrics.escaped} active=${r.metrics.active} avgV=${r.metrics.avgVelocityMmPerSec} pen=${r.metrics.penetrationCount}`);

for (const withInlet of [true, false]) {
  const scenario = withInlet
    ? { ...base, inlet: { axis: p.axis, bandMm: p.inletBandMm, velocityMmPerSec: 100 } }
    : base;
  const ts = await runFluidInTs(scenario);
  process.env.DSH_CAD_FLUID_PYTHON = '1';
  const py = await runFluid(scenario);
  console.log(`--- inlet=${withInlet} ---`);
  show('TS', ts.report);
  console.log('   TS proj:', JSON.stringify(ts.report.debugProjection));
  show('py', py.report);
  console.log('   py proj:', JSON.stringify(py.report.debugPenetration));
}
process.exit(0);
