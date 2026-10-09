// DIAGNOSTIC (kept as evidence, not an acceptance): the TS arrival ratio for the
// 50k-particle pipe is insensitive to a ±1% seed-density perturbation (three runs,
// identical to four decimals) — which is why the Python run\x27s 0.098 is a systematic
// difference and not a chaotic draw. See execution_summaries/20261012_refactor_simulate_fluid_wiring_open_defect.md
// Is the case-1b arrival ratio a STABLE property of the physics, or a realization
// draw? Perturb the seed lattice density by fractions of a percent on the TS
// canonical and watch the arrival ratio move.
import { compileStlOnly } from '../src/host/compile.ts';
import { deriveGridFromStl, runFluidInTs } from '../src/host/fluid.ts';

const PIPE_SCAD = `difference() {
  translate([100,0,0]) rotate([0,90,0]) cylinder(h=200, d=48, center=true);
  translate([100,0,0]) rotate([0,90,0]) cylinder(h=210, d=40, center=true);
}`;
const pipe = await compileStlOnly(PIPE_SCAD);
const { cells, originMm } = deriveGridFromStl(pipe.stl, 2);
for (const ppc of [6, 6.05, 5.95]) {
  const { report } = await runFluidInTs({
    pipeStl: pipe.stl, gridCells: cells, gridOriginMm: originMm, dxMm: 2,
    fluidRegionMm: { min: [5, -15, -15], max: [65, 15, 15] },
    inlet: { axis: 0, bandMm: [4, 12], velocityMmPerSec: 100 },
    outletPlaneMm: 195,
    particlesPerCell: ppc,
    steps: 1800,
    gravityMmPerSec2: [0, 0, 0],
    snapshotCount: 0,
  });
  console.log(`TS ppc=${ppc}: particles0=${report.metrics.particleCount0} escaped=${report.metrics.escaped} arrival=${report.metrics.outletArrivalRatio} pen=${report.metrics.penetrationCount}`);
}
process.exit(0);
