// A probe part for the section: a knuckle-like bracket with every feature that made
// the cut look broken — a flat face, a boss, a fork, holes, a thin web.
//
// The user's parts (照明座, P-knuckle从动节) are not in this repo, so the cut has to be
// tested against geometry built to contain the same hazards:
//
//   • a FLAT TOP that the cut plane can coincide with  → coplanar triangles
//   • a BOSS whose cylindrical wall the plane grazes    → nearly-tangent segments
//   • a FORK with two prongs                            → two separate outer loops
//   • through HOLES                                     → inner loops that must NOT be filled
//   • a THIN WEB                                        → slivers when the plane crosses at a
//                                                         shallow angle
//
// Built with manifold (a dependency already used for SDF) so the result is watertight
// and deterministic: no OpenSCAD install, no random tessellation.
//
//   node scripts/lib/section-probe.mjs            # writes examples/section-probe/*.stl
//   node scripts/lib/section-probe.mjs --list     # names + triangle counts only

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ManifoldModule from 'manifold-3d';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const OUT_DIR = join(REPO, 'examples', 'section-probe');

/** Box helper: manifold's cube is centred on the origin in x/y and sits on z = 0. */
function box(Manifold, [x0, y0, z0], [x1, y1, z1]) {
  return Manifold.cube([x1 - x0, y1 - y0, z1 - z0], true).translate([
    (x0 + x1) / 2,
    (y0 + y1) / 2,
    (z0 + z1) / 2,
  ]);
}

function cylinder(Manifold, radius, height, centre) {
  return Manifold.cylinder(height, radius, radius, 96, true).translate(centre);
}

/** Binary STL bytes from a manifold mesh. */
function toStl(mesh) {
  // manifold returns flat typed arrays (triVerts = 3 indices per triangle), not an
  // object with numTri(); the count comes from the index array's length.
  const triCount = mesh.triVerts.length / 3;
  const buffer = Buffer.alloc(84 + triCount * 50);
  buffer.write('section probe', 0, 'ascii');
  buffer.writeUInt32LE(triCount, 80);
  const verts = mesh.vertProperties;
  const props = mesh.numProp;
  let offset = 84;
  const at = (index) => [
    verts[index * props],
    verts[index * props + 1],
    verts[index * props + 2],
  ];
  for (let t = 0; t < triCount; t++) {
    const [a, b, c] = [0, 1, 2].map((k) => at(mesh.triVerts[t * 3 + k]));
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let nx = u[1] * v[2] - u[2] * v[1];
    let ny = u[2] * v[0] - u[0] * v[2];
    let nz = u[0] * v[1] - u[1] * v[0];
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const value of [nx, ny, nz]) {
      buffer.writeFloatLE(value, offset); offset += 4;
    }
    for (const point of [a, b, c]) {
      for (const value of point) {
        buffer.writeFloatLE(value, offset); offset += 4;
      }
    }
    buffer.writeUInt16LE(0, offset); offset += 2;
  }
  return buffer;
}

const BUILT = {};
function build(Manifold) {
  // 1. the base plate, 30 × 33.5 × 6, with a FLAT TOP at z = 6 that a cut can hit
  const plate = box(Manifold, [-15, -16.75, 0], [15, 16.75, 6]);
  // 2. the boss: Ø26, 12 tall, on top of the plate — its wall is what a shallow cut grazes
  const boss = cylinder(Manifold, 13, 12, [0, 0, 6]);
  // 3. the fork: two prongs reaching out in +y, with a gap — two outer loops when cut
  const prongL = box(Manifold, [-13, 16.75, 1], [-5, 70, 5]);
  const prongR = box(Manifold, [5, 16.75, 1], [13, 70, 5]);
  // 4. a thin web between the prongs (1.2 mm) — sliver territory
  const web = box(Manifold, [-5, 40, 2.4], [5, 60, 3.6]);
  // 5. an upstand at the far end, so the part is not symmetric in z
  const upstand = box(Manifold, [-13, 62, 1], [13, 70, 22]);

  let solid = plate.add(boss).add(prongL).add(prongR).add(web).add(upstand);
  // 6. a bore straight through the boss and the plate (Ø26 wall → Ø14 hole)
  solid = solid.subtract(cylinder(Manifold, 7, 40, [0, 0, -2]));
  // 7. two bolt holes in the plate
  solid = solid.subtract(cylinder(Manifold, 2.2, 20, [-10, -12, -2]));
  solid = solid.subtract(cylinder(Manifold, 2.2, 20, [10, -12, -2]));
  // 8. a cross hole through the fork prongs (Ø6), so a cut through it exposes two holes
  solid = solid.subtract(
    Manifold.cylinder(20, 3, 3, 48, true)
      .rotate([90, 0, 0])
      .translate([0, 66, 11.5]),
  );
  BUILT.knuckle = solid;

  // A second probe that is JUST a flat slab with a rim: the coplanar case isolated.
  const slab = box(Manifold, [-20, -20, 0], [20, 20, 8]);
  BUILT.slab = slab.subtract(box(Manifold, [-12, -12, 3], [12, 12, 9]));
  return solid;
}

const manifest = [];
const mod = await ManifoldModule();
mod.setup();
const Manifold = mod.Manifold;
build(Manifold);
mkdirSync(OUT_DIR, { recursive: true });
for (const [name, solid] of Object.entries(BUILT)) {
  const mesh = solid.getMesh();
  const stl = toStl(mesh);
  writeFileSync(join(OUT_DIR, `${name}.stl`), stl);
  manifest.push({ name, triangles: mesh.triVerts.length / 3, bytes: stl.length, volume: solid.volume() });
}
if (process.argv.includes('--list')) {
  for (const entry of manifest) console.log(`${entry.name}: ${entry.triangles} triangles, ${entry.bytes} bytes, volume ${entry.volume.toFixed(1)} mm³`);
} else {
  console.log(`wrote ${manifest.length} probe part(s) to examples/section-probe/`);
  for (const entry of manifest) console.log(`  ${entry.name}.stl — ${entry.triangles} triangles, volume ${entry.volume.toFixed(1)} mm³`);
}
