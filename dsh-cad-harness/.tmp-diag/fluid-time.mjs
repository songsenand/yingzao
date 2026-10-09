import { performance } from 'node:perf_hooks';
const { compileStlOnly } = await import('../src/host/compile.ts');
const { deriveGridFromStl, runFluid, runFluidInTs } = await import('../src/host/fluid.ts');

const pipeScad = process.env.PIPE_SCAD ?? 'difference() { cube([180,40,40], center=true); rotate([0,90,0]) cylinder(h=200, r=14, center=true, $fn=48); }';
const compiled = await compileStlOnly(pipeScad);
const grid = deriveGridFromStl(compiled.stl, 2);
const scenario = {
  pipeStl: compiled.stl,
  gridCells: grid.cells,
  gridOriginMm: grid.originMm,
  dxMm: 2,
  fluidRegionMm: { min: [-60, -8, -8], max: [60, 8, 8] },
  inlet: { axis: 0, bandMm: [-88, -70], velocityMmPerSec: 100 },
  outletPlaneMm: 88,
  particlesPerCell: 4,
  steps: Number(process.env.STEPS ?? 200),
  snapshotCount: 2,
};
console.log('grid', grid.cells.join('x'));
let t0 = performance.now();
const ts = await runFluidInTs(scenario);
const tsMs = performance.now() - t0;
t0 = performance.now();
const py = await runFluid(scenario);
const pyMs = performance.now() - t0;
const line = (name, r) => `${name} ${r.metrics.particleCount0}p escaped=${r.metrics.escaped} active=${r.metrics.active} arrival=${r.metrics.outletArrivalRatio} pen=${r.metrics.penetrationCount} cons=${r.metrics.massConservationError} avgV=${r.metrics.avgVelocityMmPerSec}`;
console.log(line('TS', ts.report));
console.log(line('py', py.report));
console.log(`ratio ${(pyMs / tsMs).toFixed(2)}x (TS ${tsMs.toFixed(0)} ms, py ${pyMs.toFixed(0)} ms)`);
process.exit(0);
