// M4 acceptance — fluid through-flow (design: docs/archive/M4-PREP.md §5).
//
// case 1  straight pipe: conservation audit, zero penetration, arrival ratio,
//         section velocities, no divergence (numeric hard assertions)
// case 2  snapshot renderer produces non-blank PNGs
// (case 3: manual-route consistency lives in tools wiring — same runFluidJob)
//
// Pipe: along x from 0 to 200mm, bore d40, wall d48. Inlet 100mm/s at x∈[4,12].
// Fluid slug seeded x∈[5,35], full bore, zero gravity (driven plug flow).
// Escape plane x=195mm.

import { compileStlOnly } from '../src/host/compile.ts';
import { deriveGridFromStl, runFluid } from '../src/host/fluid.ts';
import { renderFluidSnapshot, gridBounds } from '../src/host/fluid-render.ts';
import { parseBinaryStl } from '../src/host/mesh.ts';
import { writeFile, mkdir } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Acceptance writes are throwaway: never pollute data/ (runs live in data/runs/).
const OUT_DIR = mkdtempSync(join(tmpdir(), 'accept-m4-'));

let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) fail++;
};

const PIPE_SCAD = `difference() {
  translate([100,0,0]) rotate([0,90,0]) cylinder(h=200, d=48, center=true);
  translate([100,0,0]) rotate([0,90,0]) cylinder(h=210, d=40, center=true);
}`;

console.log('--- case 1: straight pipe through-flow ---');
const pipe = await compileStlOnly(PIPE_SCAD);
if (!pipe.success || !pipe.stl) { console.error('FAIL pipe compile'); process.exit(1); }
const { cells, originMm } = deriveGridFromStl(pipe.stl, 2);
console.log(`grid: cells=${cells.join('x')} origin=${originMm.join(',')}`);

const t0 = Date.now();
const { report, sdf } = await runFluid({
  pipeStl: pipe.stl,
  gridCells: cells,
  gridOriginMm: originMm,
  dxMm: 2,
  fluidRegionMm: { min: [5, -15, -15], max: [35, 15, 15] },
  inlet: { axis: 0, bandMm: [4, 12], velocityMmPerSec: 100 },
  outletPlaneMm: 195,
  particlesPerCell: 4,
  steps: 2600,
  gravityMmPerSec2: [0, 0, 0],
  snapshotCount: 4,
});
const m = report.metrics;
console.log(`  particles0=${m.particleCount0} escaped=${m.escaped} active=${m.active} arrival=${m.outletArrivalRatio} penetr=${m.penetrationCount} t_out=${m.timeToOutletSteps} diverged=${m.diverged} (${report.durationSec}s wall)`);

check('c1 particle count ~10k (±40%)', m.particleCount0 > 6000 && m.particleCount0 < 14000, `${m.particleCount0}`);
check('c1 mass conservation (audit)', m.massConservationError < 1e-6, `${m.massConservationError}`);
check('c1 zero penetration', m.penetrationCount === 0, `${m.penetrationCount}`);
check('c1 no divergence', m.diverged === false, `${m.diverged}`);
check('c1 arrival ratio ≥ 0.7 (no-slip wall film creep, see docs/archive/M4-PREP.md §13.7)', m.outletArrivalRatio >= 0.7, `${m.outletArrivalRatio}`);
check('c1 outlet reached', m.timeToOutletSteps !== null && m.timeToOutletSteps > 0, `step ${m.timeToOutletSteps}`);
check('c1 sections carry flow', m.sectionAvgVelocity.filter((s) => s.velocityMmPerSec > 10).length >= 10,
  `${m.sectionAvgVelocity.filter((s) => s.velocityMmPerSec > 10).length}/20 bins > 10mm/s`);
check('c1 overall pass', report.overallStatus === 'pass', report.overallStatus);

// Snapshot INTEGRITY. These arrays feed the rendered frames and the playback
// buffers, and the first version of the Python snapshot reader silently dropped
// the speeds (the slice's end was missing the running offset), which no metric
// check could see: `00-smoke` found it as a RangeError in the playback buffer.
check('c1 snapshots requested', report.snapshots.length === 4, `${report.snapshots.length}`);
{
  let bad = 0, minSpeed = Infinity, maxSpeed = 0, outOfGrid = 0;
  for (const snap of report.snapshots) {
    if (snap.posMm.length !== 3 * snap.speedMmPerSec.length) bad++;
    for (let p = 0; p < snap.speedMmPerSec.length; p++) {
      const s = snap.speedMmPerSec[p];
      if (!Number.isFinite(s) || s < 0) bad++;
      if (s < minSpeed) minSpeed = s;
      if (s > maxSpeed) maxSpeed = s;
    }
    for (let p = 0; p < snap.posMm.length; p += 3) {
      for (let a = 0; a < 3; a++) {
        const lo = originMm[a] - 1, hi = originMm[a] + cells[a] * 2 + 1;
        const v = snap.posMm[p + a];
        if (!Number.isFinite(v) || v < lo || v > hi) outOfGrid++;
      }
    }
  }
  check('c1 snapshot arrays consistent (pos = 3x speed)', bad === 0, `${bad} bad entries`);
  check('c1 snapshot speeds alive (max > 0)', maxSpeed > 0, `min=${minSpeed.toFixed(3)} max=${maxSpeed.toFixed(3)} mm/s`);
  check('c1 snapshot positions inside the grid', outOfGrid === 0, `${outOfGrid} out of range`);
}

// ---------------- case 2: snapshot renderer ----------------
console.log('--- case 2: snapshot renderer ---');
{
  await mkdir(join(OUT_DIR, 'frames'), { recursive: true });
  const wallVerts = parseBinaryStl(pipe.stl).vertProperties;
  const bounds = gridBounds(cells, originMm, 2);
  let nonBlank = 0;
  for (let i = 0; i < report.snapshots.length; i++) {
    const snap = report.snapshots[i];
    const png = renderFluidSnapshot(snap.posMm, snap.speedMmPerSec, {
      boundsMm: bounds,
      wallVertsMm: wallVerts,
      vmaxMmPerSec: Math.max(m.maxVelocityMmPerSec, 1),
    });
    const path = join(OUT_DIR, 'frames', `fluid_${String(snap.step).padStart(6, '0')}.png`);
    await writeFile(path, png);
    if (png.length > 5000) nonBlank++;
  }
  check('c2 rendered ≥ 3 non-blank PNGs', report.snapshots.length >= 4 && nonBlank >= 3,
    `${nonBlank}/${report.snapshots.length} (saved ${join(OUT_DIR, 'frames')})`);
}

// ---------------- case 1b: 50k-particle scale (original design scale) ----------------
console.log('--- case 1b: straight pipe at ~50k particles ---');
{
  const { report } = await runFluid({
    pipeStl: pipe.stl, gridCells: cells, gridOriginMm: originMm, dxMm: 2,
    fluidRegionMm: { min: [5, -15, -15], max: [65, 15, 15] },
    inlet: { axis: 0, bandMm: [4, 12], velocityMmPerSec: 100 },
    outletPlaneMm: 195,
    particlesPerCell: 6,
    steps: 1800,
    gravityMmPerSec2: [0, 0, 0],
    snapshotCount: 0,
  });
  const m = report.metrics;
  console.log(`  particles0=${m.particleCount0} escaped=${m.escaped} arrival=${m.outletArrivalRatio} penetr=${m.penetrationCount} (${report.durationSec}s wall)`);
  check('c1b scale ~46k (±40%)', m.particleCount0 > 27000 && m.particleCount0 < 63000, `${m.particleCount0}`);
  check('c1b zero penetration', m.penetrationCount === 0, `${m.penetrationCount}`);
  check('c1b arrival ≥ 0.75', m.outletArrivalRatio >= 0.75, `${m.outletArrivalRatio}`);
  check('c1b no divergence', m.diverged === false, `${m.diverged}`);
}

// ---------------- case 2: hydrostatic settling (closed cavity, no inflow) ----------------
console.log('--- case 2: settling in sealed cavity ---');
{
  const box = await compileStlOnly('difference() { cube([40,40,30], center=true); cube([32,32,22], center=true); }');
  if (!box.success || !box.stl) { console.error('FAIL box compile'); process.exit(1); }
  const g = deriveGridFromStl(box.stl, 2);
  const { report } = await runFluid({
    pipeStl: box.stl, gridCells: g.cells, gridOriginMm: g.originMm, dxMm: 2,
    fluidRegionMm: { min: [-10, -10, -6], max: [10, 10, 6] },
    particlesPerCell: 4,
    steps: 800,
    snapshotCount: 2,
  });
  const m = report.metrics;
  console.log(`  particles0=${m.particleCount0} active=${m.active} penetr=${m.penetrationCount} avgV=${m.avgVelocityMmPerSec}mm/s diverged=${m.diverged}`);
  check('c2 status pass (sealed: no escape term)', report.overallStatus === 'pass', report.overallStatus);
  check('c2 zero penetration after settling', m.penetrationCount === 0, `${m.penetrationCount}`);
  check('c2 settled (mean speed < 25mm/s)', m.avgVelocityMmPerSec < 25, `${m.avgVelocityMmPerSec}mm/s`);
  check('c2 no divergence', m.diverged === false, `${m.diverged}`);
}

// ---------------- case 3: 90° elbow (flow turns, M5 dead-zone data) ----------------
console.log('--- case 3: 90° elbow ---');
{
  const elbow = await compileStlOnly(`$fn=48; difference() {
    union() {
      translate([30,0,0]) rotate([0,90,0]) cylinder(h=60, d=48, center=true);
      translate([60,0,30]) cylinder(h=60, d=48, center=true);
      translate([60,0,30]) sphere(d=48);
    }
    union() {
      translate([30,0,0]) rotate([0,90,0]) cylinder(h=80, d=40, center=true);
      translate([60,0,30]) cylinder(h=80, d=40, center=true);
      translate([60,0,30]) sphere(d=40);
    }
  }`);
  if (!elbow.success || !elbow.stl) { console.error('FAIL elbow compile'); process.exit(1); }
  const g = deriveGridFromStl(elbow.stl, 2);
  const { report } = await runFluid({
    pipeStl: elbow.stl, gridCells: g.cells, gridOriginMm: g.originMm, dxMm: 2,
    fluidRegionMm: { min: [5, -15, -15], max: [30, 15, 15] },
    inlet: { axis: 0, bandMm: [4, 12], velocityMmPerSec: 100 },
    outletPlaneMm: 58,
    outletAxis: 2,
    particlesPerCell: 4,
    steps: 2000,
    gravityMmPerSec2: [0, 0, 0],
    snapshotCount: 3,
  });
  const m = report.metrics;
  console.log(`  particles0=${m.particleCount0} escaped=${m.escaped} arrival=${m.outletArrivalRatio} penetr=${m.penetrationCount} t_out=${m.timeToOutletSteps} (${report.durationSec}s wall)`);
  check('c3 flow made the turn (escaped ≥ 50%)', m.outletArrivalRatio >= 0.5, `${m.outletArrivalRatio}`);
  check('c3 zero penetration', m.penetrationCount === 0, `${m.penetrationCount}`);
  check('c3 no divergence', m.diverged === false, `${m.diverged}`);
  check('c3 status pass', report.overallStatus === 'pass', report.overallStatus);

  // visual: last snapshot render shows fluid through the bend
  await mkdir(join(OUT_DIR, 'frames'), { recursive: true });
  const wallVerts = parseBinaryStl(elbow.stl).vertProperties;
  const bounds = gridBounds(g.cells, g.originMm, 2);
  const last = report.snapshots[report.snapshots.length - 1];
  const png = renderFluidSnapshot(last.posMm, last.speedMmPerSec, {
    boundsMm: bounds, wallVertsMm: wallVerts, vmaxMmPerSec: Math.max(m.maxVelocityMmPerSec, 1),
  });
  await writeFile(join(OUT_DIR, 'frames', `elbow_${String(last.step).padStart(6, '0')}.png`), png);
  check('c3 elbow render non-blank', png.length > 5000, `${png.length} bytes`);
}

console.log(fail === 0 ? '\nM4 ACCEPTANCE (part 1: fluid) PASSED' : `\nM4 ACCEPTANCE FAILED (${fail})`);
process.exit(fail === 0 ? 0 : 1);
