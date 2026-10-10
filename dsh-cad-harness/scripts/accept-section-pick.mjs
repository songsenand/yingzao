// Truth acceptance for the section (剖切) picking maths — `src/client/section.ts`.
//
// Why this file exists: the panel's section behaviour is otherwise only checkable by
// clicking at a running GUI, and "the two points I picked in the section measure the
// diagonal of the part" was exactly the kind of bug that survives that. The maths
// lives in a pure module so it can be driven here.
//
//   1. `clipCut` maps a 0..1 slider onto the box along the axis;
//   2. `projectToCutPlane` constrains a click to the plane — keeping the two in-plane
//      components and overwriting the axis one, for both Vector3 and array input;
//   3. `sectionSegments` returns the plane ∩ mesh: a 20mm cube cut at mid-height
//      gives 8 segments totalling 80mm of perimeter, all on the plane, forming the
//      ±10 square (and the numbers are checked against that, not against a snapshot);
//   4. a cut AT a vertex plane is still drawn (the top rim of the cube), which is the
//      case where a naive two-crossings-per-edge rule returns nothing;
//   5. `nearestVertex` snaps inside its radius and refuses outside it;
//   6. `millimetresPerPixel` matches the pinhole formula for a known camera.
//
//   node scripts/accept-section-pick.mjs

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Box3, BoxGeometry, BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';
import {
  axisIndex, capTriangles, chainLoops, clipCut, millimetresPerPixel, nearestVertex,
  loopCentroids, planeBasis, planeToWorld, pointInLoop, projectToCutPlane, sectionLoops,
  sectionSegments, signedArea2,
} from '../src/client/section.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
console.log(`section picking acceptance  (${ROOT})\n`);

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const close = (a, b, tolerance = 1e-9) => Math.abs(a - b) <= tolerance;
const fmt = (value) => (typeof value === 'number' ? value.toFixed(4) : JSON.stringify(value));

// --- 1. axis index and the slider → cut coordinate ---------------------------
check(axisIndex('x') === 0 && axisIndex('y') === 1 && axisIndex('z') === 2, 'axisIndex maps x/y/z to 0/1/2');
const box = new Box3(new Vector3(-30, -20, -5), new Vector3(30, 20, 5));
check(close(clipCut(box, { pos: 0, axis: 'z' }), -5)
  && close(clipCut(box, { pos: 0.5, axis: 'z' }), 0)
  && close(clipCut(box, { pos: 1, axis: 'z' }), 5),
  'clipCut maps 0 / 0.5 / 1 onto the low / middle / high end',
  [0, 0.5, 1].map((p) => fmt(clipCut(box, { pos: p, axis: 'z' }))).join(' '));
check(close(clipCut(box, { pos: 0.25, axis: 'x' }), -15),
  'clipCut follows the axis it is given', fmt(clipCut(box, { pos: 0.25, axis: 'x' })));

// --- 2. constraining a click to the plane -----------------------------------
const fromVector = projectToCutPlane(new Vector3(7, 3, 42), 'z', 0);
check(JSON.stringify(fromVector) === JSON.stringify([7, 3, 0]),
  'projectToCutPlane overwrites only the axis component (Vector3 input)', JSON.stringify(fromVector));
const fromArray = projectToCutPlane([7, 3, 42], 'x', -1.5);
check(JSON.stringify(fromArray) === JSON.stringify([-1.5, 3, 42]),
  'projectToCutPlane works on a plain array and follows the axis', JSON.stringify(fromArray));
check(projectToCutPlane(new Vector3(1, 2, 3), 'y', 9)[1] === 9,
  'projectToCutPlane follows the y axis');

// --- 3. the cut outline of a cube -------------------------------------------
const cube = new BoxGeometry(20, 20, 20);
cube.computeBoundingBox();
const flat = sectionSegments(cube, 'z', 0);
const points = [];
for (let i = 0; i < flat.length; i += 3) points.push([flat[i], flat[i + 1], flat[i + 2]]);
check(points.length === 16, 'a 20mm cube cut at mid-height gives 8 segments (16 points)', `${points.length} points`);
const perimeter = (() => {
  let total = 0;
  for (let i = 0; i < flat.length; i += 6) {
    total += Math.hypot(flat[i + 3] - flat[i], flat[i + 4] - flat[i + 1], flat[i + 5] - flat[i + 2]);
  }
  return total;
})();
check(close(perimeter, 80, 1e-6), 'those segments total the 80mm perimeter', fmt(perimeter));
check(points.every((p) => close(p[2], 0)), 'every outline point lies ON the cut plane');
const xs = points.map((p) => p[0]);
const ys = points.map((p) => p[1]);
check(close(Math.min(...xs), -10) && close(Math.max(...xs), 10)
  && close(Math.min(...ys), -10) && close(Math.max(...ys), 10),
  'the outline is the ±10 square',
  `x ${fmt(Math.min(...xs))}..${fmt(Math.max(...xs))}  y ${fmt(Math.min(...ys))}..${fmt(Math.max(...ys))}`);

// --- 4. a cut that lands exactly on a vertex plane ---------------------------
// The cube spans z ∈ [-10, 10], so z=10 is the top face: every one of its vertices
// lies ON the plane. The outline must still come back (the top rim), which is the
// case a strict two-sign-changes-per-edge rule reports as empty.
const rim = sectionSegments(cube, 'z', 10);
check(rim.length > 0, 'a cut exactly on a vertex plane still returns an outline',
  `${rim.length / 6} segment(s)`);
const rimZ = [];
for (let i = 2; i < rim.length; i += 3) rimZ.push(rim[i]);
check(rimZ.every((z) => close(z, 10)), 'that outline lies on the vertex plane', `${rimZ.length} points`);
const empty = sectionSegments(cube, 'z', 100);
check(empty.length === 0, 'a plane that misses the cube returns no outline');

// --- 5. vertex snapping ------------------------------------------------------
const positions = [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10];
check(JSON.stringify(nearestVertex(positions, [0.2, 0, 0], 1)) === JSON.stringify([0, 0, 0]),
  'nearestVertex snaps inside its radius');
check(JSON.stringify(nearestVertex(positions, [9.4, 0, 0], 1)) === JSON.stringify([10, 0, 0]),
  'nearestVertex picks the nearer vertex, not the first');
check(nearestVertex(positions, [5, 5, 5], 1) === null,
  'nearestVertex returns null outside its radius rather than snapping to something far away');

// --- 6. pixels → millimetres -------------------------------------------------
const perPixel = millimetresPerPixel({ fovDeg: 45, viewportHeightPx: 100, distanceMm: 100 });
const expected = (2 * 100 * Math.tan((45 * Math.PI) / 360)) / 100;
check(close(perPixel, expected, 1e-12), 'millimetresPerPixel matches the pinhole formula',
  `${fmt(perPixel)} vs ${fmt(expected)}`);
check(millimetresPerPixel({ fovDeg: 45, viewportHeightPx: 0, distanceMm: 100 }) === 0,
  'a zero-height viewport does not divide by zero');

// --- 7. plane frame, loop chaining, containment ------------------------------
check(JSON.stringify(planeBasis('z')) === JSON.stringify({ u: [1, 0, 0], v: [0, 1, 0] })
  && JSON.stringify(planeBasis('x')) === JSON.stringify({ u: [0, 1, 0], v: [0, 0, 1] }),
  'the plane frame matches the worker\'s convention (a +z cut is u=x, v=y)',
  `${JSON.stringify(planeBasis('z'))} ${JSON.stringify(planeBasis('x'))}`);
check(close(signedArea2([[0, 0], [10, 0], [10, 10], [0, 10]]), 100),
  'signedArea2 gives +100 for a CCW square', fmt(signedArea2([[0, 0], [10, 0], [10, 10], [0, 10]])));
check(pointInLoop([5, 5], [[0, 0], [10, 0], [10, 10], [0, 10]])
  && !pointInLoop([15, 5], [[0, 0], [10, 0], [10, 10], [0, 10]]),
  'pointInLoop distinguishes inside from outside');

// A square written as FOUR separate segments must chain into ONE loop.
const squareSegments = [[0, 0], [10, 0], [10, 0], [10, 10], [10, 10], [0, 10], [0, 10], [0, 0]];
const chained = chainLoops(squareSegments);
check(chained.length === 1 && chained[0].length === 4,
  'chainLoops closes four separate segments into one 4-point loop',
  `${chained.length} loop(s), ${chained[0]?.length} points`);
// The same square with each side SPLIT — which is what a triangulated wall really
// produces (one segment per triangle, so a straight side arrives in pieces).
const splitSegments = [
  [0, 0], [5, 0], [5, 0], [10, 0], [10, 0], [10, 5], [10, 5], [10, 10],
  [10, 10], [5, 10], [5, 10], [0, 10], [0, 10], [0, 5], [0, 5], [0, 0],
];
const splitLoops = chainLoops(splitSegments);
check(splitLoops.length === 1 && splitLoops[0].length === 8,
  'chainLoops keeps split sides in ONE 8-point loop',
  `${splitLoops.length} loop(s), ${splitLoops[0]?.length} points`);
// A duplicated edge is what coincident triangles produce. A greedy walk stops early
// here (it closes a 2-point circuit and abandons the rest); Hierholzer does not.
const doubledLoops = chainLoops([...splitSegments, [0, 0], [5, 0]]);
check(doubledLoops.length >= 1
  && new Set(doubledLoops.flat().map((point) => `${point[0]},${point[1]}`)).size >= 7,
  'chainLoops does not lose geometry when an edge is duplicated',
  `${doubledLoops.length} loop(s), ${new Set(doubledLoops.flat().map((p) => `${p[0]},${p[1]}`)).size} distinct points`);

// --- 8. the cap: solid material, and a hole is a hole ------------------------
const triangleArea = (flat) => {
  let total = 0;
  for (let i = 0; i < flat.length; i += 9) {
    const ux = flat[i + 3] - flat[i], uy = flat[i + 4] - flat[i + 1], uz = flat[i + 5] - flat[i + 2];
    const vx = flat[i + 6] - flat[i], vy = flat[i + 7] - flat[i + 1], vz = flat[i + 8] - flat[i + 2];
    total += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return total;
};
const cubeCap = capTriangles(cube, 'z', 0);
check(cubeCap.length > 0 && close(triangleArea(cubeCap), 400, 1e-6),
  'the cube\'s cap is a solid 400mm² face', `${fmt(triangleArea(cubeCap))}mm²`);
const capZ = [];
for (let i = 2; i < cubeCap.length; i += 3) capZ.push(cubeCap[i]);
check(capZ.every((z) => close(z, 0)), 'every cap vertex lies on the cut plane');

// A rectangular tube: outer 20×20, inner 10×10. The cap must be 400 − 100 = 300mm²,
// i.e. the hole must be cut OUT rather than filled in.
const rectTube = (outer, inner, height, offset = [0, 0]) => {
  const h = height / 2;
  const o = outer / 2;
  const i = inner / 2;
  const [ox, oy] = offset;
  const positions = [];
  const quad = (a, b, c, d) => { positions.push(...a, ...b, ...c, ...a, ...c, ...d); };
  quad([-o, -o, -h], [o, -o, -h], [o, -o, h], [-o, -o, h]);
  quad([o, -o, -h], [o, o, -h], [o, o, h], [o, -o, h]);
  quad([o, o, -h], [-o, o, -h], [-o, o, h], [o, o, h]);
  quad([-o, o, -h], [-o, -o, -h], [-o, -o, h], [-o, o, h]);
  const corner = (sx, sy, z) => [ox + sx * i, oy + sy * i, z];
  quad(corner(-1, -1, -h), corner(-1, -1, h), corner(1, -1, h), corner(1, -1, -h));
  quad(corner(1, -1, -h), corner(1, -1, h), corner(1, 1, h), corner(1, 1, -h));
  quad(corner(1, 1, -h), corner(1, 1, h), corner(-1, 1, h), corner(-1, 1, -h));
  quad(corner(-1, 1, -h), corner(-1, 1, h), corner(-1, -1, h), corner(-1, -1, -h));
  for (const z of [-h, h]) {
    quad([-o, -o, z], corner(-1, -1, z), corner(1, -1, z), [o, -o, z]);
    quad([o, -o, z], corner(1, -1, z), corner(1, 1, z), [o, o, z]);
    quad([o, o, z], corner(1, 1, z), corner(-1, 1, z), [-o, o, z]);
    quad([-o, o, z], corner(-1, 1, z), corner(-1, -1, z), [-o, -o, z]);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  return geometry;
};
const tubeGeometry = rectTube(20, 10, 10);
const tubeSegments = sectionSegments(tubeGeometry, 'z', 0);
check(tubeSegments.length / 6 === 16,
  'the rectangular tube cuts into 16 segments (8 outer + 8 inner)',
  `${tubeSegments.length / 6} segments`);
// The production path, not a hand-made fixture: real section segments must chain into
// exactly two loops — an outer 20×20 and an inner 10×10 — with every vertex kept.
const tubeLoops = sectionLoops(tubeGeometry, 'z', 0).sort((a, b) => Math.abs(signedArea2(b)) - Math.abs(signedArea2(a)));
check(tubeLoops.length === 2 && tubeLoops.every((loop) => loop.length === 8),
  'the real section segments chain into two 8-point loops',
  tubeLoops.map((loop) => loop.length).join(' + '));
check(close(Math.abs(signedArea2(tubeLoops[0])), 400, 1e-6)
  && close(Math.abs(signedArea2(tubeLoops[1])), 100, 1e-6),
  'those loops measure 400mm² and 100mm²',
  tubeLoops.map((loop) => fmt(Math.abs(signedArea2(loop)))).join(' / '));
const tubeCap = capTriangles(tubeGeometry, 'z', 0);
check(close(triangleArea(tubeCap), 300, 1e-6),
  'the tube cap is 400 − 100 = 300mm²: the hole is subtracted, not filled',
  `${fmt(triangleArea(tubeCap))}mm²`);
check(capTriangles(cube, 'z', 100).length === 0, 'a plane that misses the cube has no cap');

// --- 9. loop centroids: how a section's HOLES become snappable -----------------
// A hole centre is not a mesh vertex, so vertex snapping alone can never reach the
// one point a user measuring hole spacing is aiming at.
check(JSON.stringify(loopCentroids([[[0, 0], [10, 0], [10, 10], [0, 10]]]))
  === JSON.stringify([[5, 5]]),
  'loopCentroids puts a square loop at its middle',
  JSON.stringify(loopCentroids([[[0, 0], [10, 0], [10, 10], [0, 10]]])));
const offsetTube = rectTube(20, 10, 10, [3, 0]);
const offsetLoops = sectionLoops(offsetTube, 'z', 0);
const offsetCentroids = loopCentroids(offsetLoops)
  .map((point) => point.map((value) => Math.round(value)))
  .sort((a, b) => a[0] - b[0]);
check(JSON.stringify(offsetCentroids) === JSON.stringify([[0, 0], [3, 0]]),
  'an offset bore reports its own centre (0,0) and (3,0)',
  JSON.stringify(offsetCentroids));
check(JSON.stringify(planeToWorld([2, 3], 'z', 0)) === JSON.stringify([2, 3, 0])
  && JSON.stringify(planeToWorld([2, 3], 'x', 5)) === JSON.stringify([5, 2, 3]),
  'planeToWorld lifts a 2D point onto the right plane',
  `${JSON.stringify(planeToWorld([2, 3], 'z', 0))} ${JSON.stringify(planeToWorld([2, 3], 'x', 5))}`);

console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
