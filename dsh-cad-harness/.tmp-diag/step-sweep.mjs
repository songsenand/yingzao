// When do the two runs part company? Compare the inlet + projection counters at
// increasing step counts (same Ø100 scenario).
process.env.CAD_FLUID_DEBUG_PROJECT = '1';
process.env.CAD_FLUID_DEBUG_PENETRATION = '1';
const { compileStlOnly } = await import('../src/host/compile.ts');
const { deriveFluidPreset, runFluid, runFluidInTs } = await import('../src/host/fluid.ts');
const tube = (od, bore = 30, len = 100) => `$fn=64;
difference(){ rotate([0,90,0]) cylinder(h=${len},d=${od},center=true);
              rotate([0,90,0]) cylinder(h=${len+10},d=${bore},center=true); }`;
const stl = (await compileStlOnly(tube(100))).stl;
const p = deriveFluidPreset(stl, 2, 100);
for (const steps of [10, 30, 100, 300]) {
  const scenario = {
    pipeStl: stl, gridCells: p.gridCells, gridOriginMm: p.gridOriginMm, dxMm: p.dxMm,
    fluidRegionMm: p.fluidRegionMm,
    inlet: { axis: p.axis, bandMm: p.inletBandMm, velocityMmPerSec: 100 },
    outletPlaneMm: p.outletPlaneMm, particlesPerCell: 6, steps, snapshotCount: 0,
  };
  const ts = await runFluidInTs(scenario);
  process.env.DSH_CAD_FLUID_PYTHON = '1';
  const py = await runFluid(scenario);
  const t = ts.report.debugProjection;
  const q = py.report.debugPenetration;
  console.log(`steps=${String(steps).padStart(3)}  inlet: TS band=${t.inlet.band} floored=${t.inlet.floored} inj=${t.inlet.injected.toFixed(0)} | py band=${q.inlet.band} floored=${q.inlet.floored} inj=${q.inlet.injected.toFixed(0)}`);
  console.log(`          proj: TS inside=${t.inside} killed=${t.killed} | py inside=${q.projectionInside} killed=${q.projectionKilled}   avgV TS=${ts.report.metrics.avgVelocityMmPerSec} py=${py.report.metrics.avgVelocityMmPerSec}`);
}
process.exit(0);
