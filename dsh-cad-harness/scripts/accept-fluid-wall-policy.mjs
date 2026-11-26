// F1 acceptance, part 1 — the thin-wall policy.
//
// A wall thinner than two cells has no interior cell, so the SDF never reaches its
// half-thickness, the MPM has nothing to collide with, and the run reports a
// penetration count and an arrival ratio that describe the GRID, not the part.
// The policy has three allowed answers, and all three are checked here:
//
//   ok        — the wall is resolvable at the requested dx;
//   refined   — dx was reduced until it is, and the decision is recorded;
//   refused   — it cannot be, and the message names the wall, the dx and the cost.
//
// Tubes are built with Manifold in-process, so the geometry is exact and there is
// no kernel or Python in the loop.
//
//   node scripts/accept-fluid-wall-policy.mjs

import ManifoldModule from 'manifold-3d';
import { deriveFluidPreset, measureThinWallMm, chooseDxForWalls } from '../src/host/fluid.ts';
import { buildSdfFromStl } from '../src/host/sdf.ts';
import { deriveGridFromStl } from '../src/host/fluid.ts';

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
  return toStl(outer.subtract(bore));
}
function blockStl([x, y, z]) {
  return toStl(Manifold.cube([x, y, z], true));
}
function toStl(solid) {
  const mesh = solid.getMesh();
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

console.log('fluid thin-wall policy acceptance\n');

// ── 1. the measurement itself ──────────────────────────────────────────────
{
  const stl = tubeStl(44, 30, 30);                 // 7 mm wall
  const grid = deriveGridFromStl(stl, 2);
  const sdf = await buildSdfFromStl(stl, { cells: grid.cells, dxMm: 2, originMm: grid.originMm });
  // The SDF is NEGATIVE inside metal — the sign that the first version of this
  // function got wrong, which made it report "no solid" on every part.
  let insideNegative = 0, insidePositive = 0;
  for (let i = 0; i < sdf.sdf.length; i++) {
    if (sdf.solidMask[i] !== 1) continue;
    if (sdf.sdf[i] < 0) insideNegative++; else insidePositive++;
  }
  check(insideNegative > insidePositive, 'the SDF is negative inside metal (the convention the policy relies on)',
    `${insideNegative} negative / ${insidePositive} positive`);
  const wall = measureThinWallMm(sdf);
  check(wall !== null && Math.abs(wall - 7) < 1.5, 'a Ø44/Ø30 tube measures a ~7 mm wall', `${wall?.toFixed(2)} mm`);
}

// ── 2. thick wall: no refinement, no refusal ───────────────────────────────
{
  const preset = await deriveFluidPreset(tubeStl(44, 30, 30), 2, 100);
  check(preset.wallPolicy.action === 'ok', 'a 7 mm wall at dx 2 is fine', preset.wallPolicy.reason);
  check(preset.wallPolicy.dxMm === 2, 'and dx is NOT changed', String(preset.wallPolicy.dxMm));
  check(/spans \d+(\.\d+)? cells/.test(preset.wallPolicy.reason), 'the reason quotes how many cells the wall spans',
    preset.wallPolicy.reason);
}

// ── 3. thin wall, refinable: dx halves and the decision says so ─────────────
{
  const preset = await deriveFluidPreset(tubeStl(44, 41.2, 30), 2, 100);   // ~1.4 mm wall
  check(preset.wallPolicy.action === 'refined', 'a ~1.4 mm wall at dx 2 is refined, not refused',
    preset.wallPolicy.reason);
  check(preset.wallPolicy.dxMm < 2, 'the run actually uses the finer dx', `dx ${preset.wallPolicy.dxMm}`);
  check(preset.wallPolicy.requestedDxMm === 2, 'and remembers what was asked for', String(preset.wallPolicy.requestedDxMm));
  check(preset.wallPolicy.measuredMm !== null && preset.wallPolicy.measuredMm < 2.5,
    'the measured wall is quoted, not implied', `${preset.wallPolicy.measuredMm?.toFixed(2)} mm`);
  // The grid really is the refined one.
  const expected = deriveGridFromStl(tubeStl(44, 41.2, 30), preset.wallPolicy.dxMm);
  check(preset.gridCells.join(',') === expected.cells.join(','), 'the preset grid matches the chosen dx',
    `${preset.gridCells.join(',')}`);
}

// ── 4. wall too thin at every dx the policy may try: refuse, and say why ───
{
  let refused = null;
  try {
    await deriveFluidPreset(tubeStl(44, 42.6, 30), 2, 100);   // ~0.7 mm wall
  } catch (error) {
    refused = String(error?.message ?? error);
  }
  check(refused !== null, 'a ~0.7 mm wall is REFUSED rather than run at a blind dx');
  check(/thin-wall policy refused/.test(refused ?? ''), 'the refusal names the policy', refused?.slice(0, 80));
  check(/thinnest wall \d+\.\d+ mm|under 2 cells/.test(refused ?? ''),
    'it either quotes the wall or says it is under the grid\'s resolution — never a sub-cell number as if it were measured',
    refused?.slice(0, 120));
  check(/2 cells/.test(refused ?? ''), 'and says the wall is under two cells');
}

// ── 5. explicit dx is the caller's decision: measure and warn, do not override
{
  const preset = await deriveFluidPreset(tubeStl(44, 42.6, 30), 2, 100, { explicitDxMm: true });
  check(preset.wallPolicy.action === 'ok', 'an explicit dx is not turned into a refusal', preset.wallPolicy.action);
  check(preset.wallPolicy.dxMm === 2, 'the requested resolution is kept', `dx ${preset.wallPolicy.dxMm}`);
  check(/UNDER 2 CELLS/.test(preset.wallPolicy.reason),
    'but the report says the wall is under two cells (the numbers describe the grid)', preset.wallPolicy.reason);
}

// ── 6. the policy function on its own: refuses when the grid would explode ─
{
  const stl = blockStl([200, 200, 4]);       // 4 mm plate: resolvable; the point is the API
  const { policy } = await chooseDxForWalls(stl, 2, async (dx) => {
    const grid = deriveGridFromStl(stl, dx);
    return buildSdfFromStl(stl, { cells: grid.cells, dxMm: dx, originMm: grid.originMm });
  });
  check(policy.action === 'ok' || policy.action === 'refined', 'a plate resolves without exploding', policy.reason);
  check(policy.cells > 0, 'the policy reports the grid it settled on', `${policy.cells} cells`);
}

console.log(failures ? `\naccept-fluid-wall-policy: ${failures} FAILURE(S)` : '\naccept-fluid-wall-policy: PASS');
process.exit(failures ? 1 : 0);
