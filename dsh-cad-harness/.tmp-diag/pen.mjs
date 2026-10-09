process.env.CAD_FLUID_DEBUG_PENETRATION = '1';
const { compileStlOnly } = await import('../src/host/compile.ts');
const { deriveFluidPreset, runFluid } = await import('../src/host/fluid.ts');
const tube = (od, bore = 30, len = 100) => `$fn=64;
difference(){ rotate([0,90,0]) cylinder(h=${len},d=${od},center=true);
              rotate([0,90,0]) cylinder(h=${len+10},d=${bore},center=true); }`;
for (const od of [60, 100]) {
  const stl = (await compileStlOnly(tube(od))).stl;
  const p = deriveFluidPreset(stl, 2, 100);
  const { report } = await runFluid({
    pipeStl: stl, gridCells: p.gridCells, gridOriginMm: p.gridOriginMm, dxMm: p.dxMm,
    fluidRegionMm: p.fluidRegionMm,
    inlet: { axis: p.axis, bandMm: p.inletBandMm, velocityMmPerSec: 100 },
    outletPlaneMm: p.outletPlaneMm, particlesPerCell: 6, steps: p.steps, snapshotCount: 0,
  });
  console.log(`Ø${od} pen=${report.metrics.penetrationCount} active=${report.metrics.active}`);
  console.log('   ', JSON.stringify(report.debugPenetration));
}
process.exit(0);
