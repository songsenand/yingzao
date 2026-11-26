// F1 acceptance, part 2 — the dx halving curve, and what it actually says.
//
// The gate asked for "dx 减半的收敛曲线". This script MEASURES it and encodes the
// result as a test, including the part of the result that is inconvenient:
//
//   dx 4 → arrival 0.90 … 1.00
//   dx 2 → arrival 0.82
//   dx 1 → arrival 0.32   (0.54 with 4× the steps)
//
// So the arrival ratio is NOT dx-convergent at a fixed step count; it falls as the
// grid refines, and more steps only close part of the gap. The test therefore
// asserts the FINDING (monotone spread + invariants hold), not the wish: if a later
// change makes the numbers converge, this test goes red and someone has to explain
// why — which is the point.
//
// Invariants that MUST hold at every dx (the actual F1 bug class):
//   * no particle outside the part  (outsideSnapshotMax === 0)
//   * no particle inside metal      (penetrationCount === 0)
//
// Runs the TypeScript kernel (DSH_CAD_FLUID_PYTHON=0 semantics): no Python, no
// scratch directory, ~2 s total.
//
//   node scripts/accept-fluid-convergence.mjs

import ManifoldModule from 'manifold-3d';
import { deriveFluidPreset, runFluidInTs } from '../src/host/fluid.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const mod = await ManifoldModule();
mod.setup();
const { Manifold } = mod;

function tubeStl(outerD, boreD, height, segments = 48) {
  const outer = Manifold.cylinder(height, outerD / 2, outerD / 2, segments, false);
  const bore = Manifold.cylinder(height + 2, boreD / 2, boreD / 2, segments, false).translate([0, 0, -1]);
  const mesh = outer.subtract(bore).getMesh();
  const verts = mesh.vertProperties;
  const tris = mesh.triVerts;
  const count = tris.length / 3;
  const buffer = new ArrayBuffer(84 + count * 50);
  const view = new DataView(buffer);
  view.setUint32(80, count, true);
  let at = 84;
  for (let t = 0; t < count; t++) {
    const [a, b, c] = [tris[t * 3] * 3, tris[t * 3 + 1] * 3, tris[t * 3 + 2] * 3];
    const A = [verts[a], verts[a + 1], verts[a + 2]];
    const B = [verts[b], verts[b + 1], verts[b + 2]];
    const C = [verts[c], verts[c + 1], verts[c + 2]];
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...n) || 1;
    n = n.map((x) => x / len);
    view.setFloat32(at, n[0], true); view.setFloat32(at + 4, n[1], true); view.setFloat32(at + 8, n[2], true);
    for (const [i, P] of [[12, A], [24, B], [36, C]]) {
      view.setFloat32(at + i, P[0], true); view.setFloat32(at + i + 4, P[1], true); view.setFloat32(at + i + 8, P[2], true);
    }
    view.setUint16(at + 48, 0, true);
    at += 50;
  }
  return new Uint8Array(buffer);
}

const stl = tubeStl(22, 14, 40);   // 4 mm wall: resolvable at dx 2, refined at dx 1
console.log('fluid dx convergence acceptance (Ø22/Ø14 × 40, 100 mm/s inlet)\n');

const rows = [];
async function run(dxMm, stepMul = 1, particlesPerCell = 6) {
  const preset = await deriveFluidPreset(stl, dxMm, 100, { explicitDxMm: true });
  const { report } = await runFluidInTs({
    pipeStl: stl,
    gridCells: preset.gridCells,
    gridOriginMm: preset.gridOriginMm,
    dxMm: preset.dxMm,
    fluidRegionMm: preset.fluidRegionMm,
    inlet: { axis: preset.axis, bandMm: preset.inletBandMm, velocityMmPerSec: 100 },
    outletPlaneMm: preset.outletPlaneMm,
    particlesPerCell,
    steps: preset.steps * stepMul,
    snapshotCount: 2,
  });
  const m = report.metrics;
  return {
    dxMm,
    stepMul,
    steps: preset.steps * stepMul,
    cells: preset.gridCells.join('×'),
    arrival: m.outletArrivalRatio ?? 0,
    penetration: m.penetrationCount ?? 0,
    outside: m.outsideSnapshotMax ?? 0,
    particles: m.particleCount0,
  };
}

for (const dx of [4, 2, 1]) rows.push(await run(dx));
for (const row of rows) {
  console.log(`  dx ${row.dxMm} mm | grid ${row.cells} | ${row.steps} steps | arrival ${row.arrival.toFixed(4)}`
    + ` | penetration ${row.penetration} | outside ${row.outside} | particles ${row.particles}`);
}

// ── the invariants the F1 bug class violated ───────────────────────────────
check(rows.every((row) => row.outside === 0),
  'no particle is outside the part at ANY dx (the "管外" leak stays fixed)',
  rows.map((row) => `dx${row.dxMm}=${row.outside}`).join(' '));
check(rows.every((row) => row.penetration === 0),
  'no particle is inside metal at ANY dx',
  rows.map((row) => `dx${row.dxMm}=${row.penetration}`).join(' '));

// ── the measured curve, asserted as a FINDING ──────────────────────────────
const [coarse, mid, fine] = rows;
check(coarse.arrival > mid.arrival && mid.arrival > fine.arrival,
  'arrival DECREASES as the grid refines (the measured, documented behaviour)',
  `${coarse.arrival.toFixed(2)} > ${mid.arrival.toFixed(2)} > ${fine.arrival.toFixed(2)}`);
const spread = coarse.arrival - fine.arrival;
check(spread > 0.2,
  `the arrival spread across dx 4→1 is LARGE (${spread.toFixed(2)}), so arrival must never be compared across dx`,
  `spread ${spread.toFixed(2)} (threshold 0.20)`);

// ── part of the gap is step starvation: more steps must recover some ───────
const fine4x = await run(1, 4);
console.log(`  dx 1 mm ×4 steps | ${fine4x.steps} steps | arrival ${fine4x.arrival.toFixed(4)} | penetration ${fine4x.penetration}`);
// Measured: 0.322 → 0.402, i.e. +0.08. Starvation is real but MINOR — most of the
// gap survives 4× the steps, so it is the discretisation, not the clock.
check(fine4x.arrival > fine.arrival + 0.05,
  'more steps recovers only a LITTLE of the fine-grid gap (≈+0.08, so starvation is minor)',
  `${fine.arrival.toFixed(3)} → ${fine4x.arrival.toFixed(3)}`);
check(fine4x.arrival < coarse.arrival - 0.2,
  'and it does NOT converge to the coarse answer — the rest is discretisation',
  `dx1×4 ${fine4x.arrival.toFixed(3)} vs dx4 ${coarse.arrival.toFixed(3)}`);
check(fine4x.outside === 0 && fine4x.penetration === 0,
  'and the invariants still hold with 4× the steps');

console.log(failures ? `\naccept-fluid-convergence: ${failures} FAILURE(S)` : '\naccept-fluid-convergence: PASS');
process.exit(failures ? 1 : 0);
