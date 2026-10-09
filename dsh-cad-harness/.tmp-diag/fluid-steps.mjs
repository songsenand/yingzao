import { performance } from 'node:perf_hooks';
const { compileStlOnly } = await import('../src/host/compile.ts');
const { deriveGridFromStl, runFluid, runFluidInTs } = await import('../src/host/fluid.ts');

const pipeScad = 'difference() { cube([180,40,40], center=true); rotate([0,90,0]) cylinder(h=200, r=14, center=true, $fn=48); }';
const compiled = await compileStlOnly(pipeScad);
const grid = deriveGridFromStl(compiled.stl, 2);
const base = {
  pipeStl: compiled.stl,
  gridCells: grid.cells,
  gridOriginMm: grid.originMm,
  dxMm: 2,
  fluidRegionMm: { min: [-60, -8, -8], max: [60, 8, 8] },
  inlet: { axis: 0, bandMm: [-88, -70], velocityMmPerSec: 100 },
  outletPlaneMm: 88,
  particlesPerCell: 2,
  snapshotCount: 1,
};
for (const steps of [50, 100, 200]) {
  const scenario = { ...base, steps };
  const ts = (await runFluidInTs(scenario)).report.metrics;
  const py = (await runFluid(scenario)).report.metrics;
  console.log(`steps=${String(steps).padStart(2)}  TS avgV=${String(ts.avgVelocityMmPerSec).padStart(7)} maxV=${String(ts.maxVelocityMmPerSec).padStart(7)} pen=${ts.penetrationCount} esc=${ts.escaped}   |   py avgV=${String(py.avgVelocityMmPerSec).padStart(7)} maxV=${String(py.maxVelocityMmPerSec).padStart(7)} pen=${py.penetrationCount} esc=${py.escaped}  (particles ${ts.particleCount0})`);
}
process.exit(0);
