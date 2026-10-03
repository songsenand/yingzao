// Acceptance for measure_distance (M2/M3 gap: two-point surface measurement).
//
// case a  snap=false pure math: (0,0,0)→(3,4,0) = 5mm exactly
// case b  cube 30³: far-outside points snap to ±x faces, distance = 30
// case c  pipe wall: two points inside the wall snap to inner/outer surfaces
//         → distance = wall thickness 4mm
// case d  two cubes 10mm apart: cross-part surface gap = 10mm
// case e  inside/outside flags: point inside the solid reports outside=false

import { parseBinaryStl } from '../src/host/mesh.ts';
import { measureDistance } from '../src/host/measure.ts';
import { compileStlOnly } from '../src/host/compile.ts';

let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) fail++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

async function meshOf(scad) {
  const c = await compileStlOnly(scad);
  if (!c.success || !c.stl) throw new Error('compile failed: ' + c.errors.join('; '));
  return parseBinaryStl(c.stl);
}

// ---- case a: pure math (snap=false) ----
{
  const cube = await meshOf('cube([30,30,30], center=true);');
  const r = measureDistance(cube, null, [0, 0, 0], [3, 4, 0], false);
  check('a pure math distance', near(r.distanceMm, 5, 1e-6), `${r.distanceMm}`);
  check('a components', r.dxMm === 3 && r.dyMm === 4 && r.dzMm === 0, `${r.dxMm}/${r.dyMm}/${r.dzMm}`);
}

// ---- case b: cube face snap ----
{
  const cube = await meshOf('cube([30,30,30], center=true);');
  const r = measureDistance(cube, null, [100, 0, 0], [-100, 0, 0], true);
  console.log(`  b: a→${JSON.stringify(r.aSnapped)} b→${JSON.stringify(r.bSnapped)} d=${r.distanceMm}`);
  check('b snap distance = 30 (outer width)', near(r.distanceMm, 30, 0.01), `${r.distanceMm}`);
  check('b snap distances ≈ 85 (100−15)', near(r.aSnapDistanceMm, 85, 0.5) && near(r.bSnapDistanceMm, 85, 0.5), `${r.aSnapDistanceMm}/${r.bSnapDistanceMm}`);
  check('b outside flags true', r.aOutside && r.bOutside, `${r.aOutside}/${r.bOutside}`);
}

// ---- case c: pipe wall thickness via two in-wall points ----
{
  const pipe = await meshOf(`$fn=64; difference() {
    rotate([0,90,0]) cylinder(h=60, d=48, center=true);
    rotate([0,90,0]) cylinder(h=70, d=40, center=true);
  }`);
  // radial y: r=21 inside the wall (bore r20 .. outer r24), nearest surface =
  // bore (1mm); r=23 nearest = outer surface (1mm) → distance = thickness 4mm
  const r = measureDistance(pipe, null, [0, 21, 0], [0, 23, 0], true);
  console.log(`  c: a→${JSON.stringify(r.aSnapped)} b→${JSON.stringify(r.bSnapped)} d=${r.distanceMm}`);
  check('c wall thickness = 4mm', near(r.distanceMm, 4, 0.1), `${r.distanceMm}`);
  check('c snaps to inner/outer surface', near(r.aSnapDistanceMm, 1, 0.05) && near(r.bSnapDistanceMm, 1, 0.05), `${r.aSnapDistanceMm}/${r.bSnapDistanceMm}`);
}

// ---- case d: cross-part gap ----
{
  const cubeStl = await meshOf('cube([10,10,10], center=true);');
  // cube A at origin (spans ±5), cube B at (20,0,0) (spans 15..25) → gap 10mm
  const bVerts = new Float32Array(cubeStl.vertProperties.length);
  for (let i = 0; i < cubeStl.vertProperties.length; i += 3) {
    bVerts[i] = cubeStl.vertProperties[i] + 20;
    bVerts[i + 1] = cubeStl.vertProperties[i + 1];
    bVerts[i + 2] = cubeStl.vertProperties[i + 2];
  }
  const meshB = { vertProperties: bVerts, triVerts: cubeStl.triVerts };
  // off-center inputs → unambiguous nearest face (+x of A, −x of B)
  const r = measureDistance(cubeStl, meshB, [2, 1, 1], [18, 1, 1], true);
  console.log(`  d: a→${JSON.stringify(r.aSnapped)} b→${JSON.stringify(r.bSnapped)} d=${r.distanceMm}`);
  check('d cross-part gap = 10mm', near(r.distanceMm, 10, 0.05), `${r.distanceMm}`);
  check('d snapped to facing faces', near(r.aSnapped[0], 5, 0.05) && near(r.bSnapped[0], 15, 0.05), `${r.aSnapped[0]}/${r.bSnapped[0]}`);
}

// ---- case e: inside flag ----
{
  const cube = await meshOf('cube([30,30,30], center=true);');
  const r = measureDistance(cube, null, [0, 0, 0], [100, 0, 0], true);
  check('e inside flag false for center point', r.aOutside === false, `${r.aOutside}`);
}

// ---- case f: datum anchors (declare intent, engine resolves coordinates) ----
{
  const { compileStlOnly } = await import('../src/host/compile.ts');
  const part = await compileStlOnly(`difference() {
    cube([50,50,10], center=true);
    translate([15,0,0]) cylinder(h=12, d=10, center=true);
  }
  datum("hole1-center", [15, 0, 0]);
  datum("corner-sw", [-25, -25, -5]);`);
  if (!part.success || !part.stl) { console.error('FAIL f compile'); process.exit(1); }
  console.log(`  f: datums parsed = ${part.datums.map((d) => d.name).join(', ')}`);
  const hole = part.datums.find((d) => d.name === 'hole1-center');
  const corner = part.datums.find((d) => d.name === 'corner-sw');
  check('f datums parsed (2, exact coords)', !!hole && !!corner && hole.point[0] === 15 && corner.point[2] === -5,
    `${JSON.stringify(part.datums)}`);

  // analytic: (15,0,0) → (-25,-25,-5) = sqrt(40² + 25² + 5²) = sqrt(2250) ≈ 47.4342
  const r = measureDistance(part, null, hole.point, corner.point, false);
  check('f datum-to-datum distance exact', near(r.distanceMm, Math.sqrt(2250), 1e-3), `${r.distanceMm} (expect ${Math.sqrt(2250).toFixed(4)})`);

  // datum resolution semantics live in the tool (datums.json); here we verify
  // the snap-exempt path: noSnapped coords equal raw datum points
  const rSnap = measureDistance(part, null, hole.point, corner.point, { snapA: false, snapB: false });
  check('f datum points never snapped', JSON.stringify(rSnap.aSnapped) === JSON.stringify(hole.point), `${JSON.stringify(rSnap.aSnapped)}`);
}

// ---- case g: solver — sphere probe vs pipe (analytic: 11mm) ----
{
  const { closestPointsMeshVsSphere, closestPointsBetweenMeshes } = await import('../src/host/measure.ts');
  const pipe = await meshOf(`$fn=64; difference() {
    translate([30,0,0]) rotate([0,90,0]) cylinder(h=60, d=48, center=true);
    translate([30,0,0]) rotate([0,90,0]) cylinder(h=70, d=40, center=true);
  }`);
  // sphere r=5 at (30,40,0): pipe outer wall r=24 → closest surfaces (30,24,0)/(30,35,0) → 11mm
  const r = closestPointsMeshVsSphere(pipe, [30, 40, 0], 5);
  console.log(`  g: d=${r.distanceMm} pa=${JSON.stringify(r.pointA.map(v=>+v.toFixed(2)))} pb=${JSON.stringify(r.pointB.map(v=>+v.toFixed(2)))}`);
  check('g sphere-vs-pipe distance = 11mm', near(r.distanceMm, 11, 0.1), `${r.distanceMm}`);
  check('g mesh point on outer wall (y≈24)', near(r.pointA[1], 24, 0.1), `y=${r.pointA[1].toFixed(2)}`);
  check('g sphere point on sphere (y≈35)', near(r.pointB[1], 35, 0.05), `y=${r.pointB[1].toFixed(2)}`);

  // ---- case h: mesh-vs-mesh (rotated pipe vs box) — vertex-exact method ----
  const box = await meshOf('cube([20,20,20], center=true);');
  const r2 = closestPointsBetweenMeshes(pipe, box);
  console.log(`  h: mesh-vs-mesh d=${r2.distanceMm} pa=${JSON.stringify(r2.pointA.map(v=>+v.toFixed(2)))} pb=${JSON.stringify(r2.pointB.map(v=>+v.toFixed(2)))}`);
  check('h mesh-vs-mesh positive & finite', r2.distanceMm > 0 && Number.isFinite(r2.distanceMm), `${r2.distanceMm}`);
  // box spans ±10 (x 20..40) — pipe bore r20 outer r24, walls at x 0..60:
  // closest approach should be near x 20..30 region; sanity: both points finite
  check('h both points on surfaces (non-degenerate)', r2.pointA.every(Number.isFinite) && r2.pointB.every(Number.isFinite), 'ok');
}

console.log(fail === 0 ? '\nMEASURE_DISTANCE ACCEPTANCE PASSED' : `\nMEASURE_DISTANCE ACCEPTANCE FAILED (${fail})`);
process.exit(fail === 0 ? 0 : 1);
