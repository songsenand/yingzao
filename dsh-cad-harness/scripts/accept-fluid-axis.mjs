// F2 acceptance — the flow axis must come from the CAVITY, not the bounding box.
//
// The old rule took the longest bbox span. On a long pipe that is the bore's axis;
// on a Ø44 × 30 stubby tube the longest span is ACROSS the cross-section, so the
// flow was driven sideways through the wall — a deterministic error, not a
// tolerance question. These tubes are built with Manifold in-process (the same
// library the SDF path uses), so the geometry is exact and the test needs no
// kernel, no Python and no scratch directory.
//
//   node scripts/accept-fluid-axis.mjs

import ManifoldModule from 'manifold-3d';
import { deriveFluidPreset, flowAxisFromVoid } from '../src/host/fluid.ts';
import { buildSdfFromStl } from '../src/host/sdf.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const mod = await ManifoldModule();
mod.setup();
const { Manifold } = mod;

/** A closed tube along +z: outer cylinder minus a bore. */
function tubeStl({ outerD, boreD, height, segments = 48 }) {
  const outer = Manifold.cylinder(height, outerD / 2, outerD / 2, segments, false);
  const bore = Manifold.cylinder(height + 2, boreD / 2, boreD / 2, segments, false).translate([0, 0, -1]);
  const solid = outer.subtract(bore);
  return manifoldToStl(solid);
}

/** A solid block, for the "no cavity" fallback. */
function blockStl([x, y, z]) {
  return manifoldToStl(Manifold.cube([x, y, z], true));
}

/** Binary STL bytes from a Manifold solid (triangles + facet normals). */
function manifoldToStl(solid) {
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
    const ax = verts[a], ay = verts[a + 1], az = verts[a + 2];
    const bx = verts[b], by = verts[b + 1], bz = verts[b + 2];
    const cx = verts[c], cy = verts[c + 1], cz = verts[c + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    view.setFloat32(at, nx / len, true); view.setFloat32(at + 4, ny / len, true); view.setFloat32(at + 8, nz / len, true);
    for (const [i, p] of [[12, a], [24, b], [36, c]]) {
      view.setFloat32(at + i, verts[p], true);
      view.setFloat32(at + i + 4, verts[p + 1], true);
      view.setFloat32(at + i + 8, verts[p + 2], true);
    }
    view.setUint16(at + 48, 0, true);
    at += 50;
  }
  return new Uint8Array(buffer);
}

/** The OLD rule, quoted here as the regression witness. */
function bboxAxisOf(stl) {
  const spans = [0, 0, 0];
  const view = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
  const count = view.getUint32(80, true);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < count; t++) {
    for (let corner = 0; corner < 3; corner++) {
      const base = 84 + t * 50 + 12 + corner * 12;
      for (let a = 0; a < 3; a++) {
        const v = view.getFloat32(base + a * 4, true);
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
    }
  }
  for (let a = 0; a < 3; a++) spans[a] = max[a] - min[a];
  return spans[0] >= spans[1] && spans[0] >= spans[2] ? 0 : spans[1] >= spans[2] ? 1 : 2;
}

console.log('fluid flow axis acceptance\n');

// ── 1. the reported failure: a stubby tube ─────────────────────────────────
{
  const stl = tubeStl({ outerD: 44, boreD: 20, height: 30 });
  const oldAxis = bboxAxisOf(stl);
  const preset = await deriveFluidPreset(stl, 2, 100);
  check(oldAxis === 0, 'the OLD bbox rule picked X for Ø44×30 (the bug, as a witness)', `axis ${oldAxis}`);
  check(preset.axis === 2, 'the cavity rule picks Z for the same tube', `axis ${preset.axis} (${preset.axisSource})`);
  check(preset.axisSource === 'void', 'and says the CAVITY decided, not the bbox', preset.axisSource);
  check(preset.voidExtentMm !== null && preset.voidExtentMm[2] > preset.voidExtentMm[0],
    'the void is longest along Z, which is the flow direction', JSON.stringify(preset.voidExtentMm));
  check(preset.bboxSpansMm[0] > preset.bboxSpansMm[2],
    'the bbox is still recorded and still says the opposite (provenance, not silence)',
    JSON.stringify(preset.bboxSpansMm));
  // The preset's own geometry must follow the axis it chose.
  check(preset.inletBandMm[0] < preset.outletPlaneMm,
    'the inlet band sits before the outlet plane', `${preset.inletBandMm.join('..')} < ${preset.outletPlaneMm}`);
  check(preset.fluidRegionMm.max[2] - preset.fluidRegionMm.min[2] > 0,
    'the seed region has depth along the flow axis');
}

// ── 2. a long pipe still flows along its bore (no regression) ──────────────
{
  const stl = tubeStl({ outerD: 20, boreD: 10, height: 100 });
  const preset = await deriveFluidPreset(stl, 2, 100);
  check(preset.axis === 2, 'a Ø20×100 pipe still flows along Z', `axis ${preset.axis} (${preset.axisSource})`);
  check(preset.axisSource === 'void', 'and the cavity rule agrees with the bbox here', preset.axisSource);
}

// ── 3. no cavity → the bbox fallback, stated as such ───────────────────────
{
  const stl = blockStl([60, 40, 20]);
  const preset = await deriveFluidPreset(stl, 2, 100);
  check(preset.axisSource === 'bbox', 'a solid block falls back to the bbox rule', preset.axisSource);
  check(preset.axis === 0, 'and the bbox axis is X for 60×40×20', `axis ${preset.axis}`);
  check(preset.voidExtentMm === null, 'with no void extent claimed');
}

// ── 4. the pure probe ──────────────────────────────────────────────────────
{
  const stl = tubeStl({ outerD: 30, boreD: 12, height: 80 });
  const sdf = await buildSdfFromStl(stl, { cells: [24, 24, 48], dxMm: 2, originMm: [-24, -24, -40] });
  const probe = flowAxisFromVoid(sdf);
  check(probe !== null, 'the void probe finds a cavity');
  check(probe?.axis === 2, 'and reports Z as its longest run', `axis ${probe?.axis}`);
  check((probe?.cells ?? 0) > 0, 'with a cell count, not a guess', String(probe?.cells));
}

console.log(failures ? `\naccept-fluid-axis: ${failures} FAILURE(S)` : '\naccept-fluid-axis: PASS');
process.exit(failures ? 1 : 0);
