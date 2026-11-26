// U20 acceptance — sections on an ARBITRARY plane (point + normal), not just an axis.
//
// Why this file exists: an oblique cut through a pipe is the case that matters in
// practice ("斜切管道能看到空腔而不是空壳"). A shader clip plane removes material and
// leaves nothing behind, so the cap is the whole answer: without it the user sees a
// hollow shell and cannot tell a bore from a wall.
//
// The numbers are analytic, not snapshots:
//   * a 20mm cube cut at 45° is a 20 × 20√2 rectangle → 565.685mm²;
//   * a circular annulus (R=10, r=5) cut perpendicular to its axis is 235.619mm²
//     of material (75π), and at 45° to the axis 333.216mm² (75π√2);
//   * tessellation makes the measured area slightly SMALLER (an inscribed N-gon):
//     the expected value is the polygon's own area / cos θ, computed here from N;
//   * cap triangles must (a) all lie on the plane, (b) sum to the annulus area,
//     which is only true if the hole is subtracted rather than filled.
//
//   node scripts/accept-section-free.mjs

import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';
import {
  axisPlane, capTriangles, capTrianglesOnPlane, clippingPlane, normalizePlane, planeBasis,
  planeBasisFor, planeDistance, planeToWorld, projectToCutPlane, projectToPlane,
  sectionLoops, sectionLoopsOnPlane, sectionSegments, sectionSegmentsOnPlane,
} from '../src/client/section.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const close = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
const near = (a, b, tolerance = 1e-9) => Math.abs(a - b) <= tolerance;
const fmt = (value) => (typeof value === 'number' ? value.toFixed(4) : JSON.stringify(value));

// ── fixtures ────────────────────────────────────────────────────────────────

const cube = (size = 20) => new BoxGeometry(size, size, size);

/** Two disjoint 10mm cubes 60mm apart, in ONE geometry: "the plane cuts two bodies". */
function twoCubes() {
  const a = new BoxGeometry(10, 10, 10).toNonIndexed();
  const b = new BoxGeometry(10, 10, 10).toNonIndexed();
  a.translate(-30, 0, 0);
  b.translate(30, 0, 0);
  const positions = new Float32Array(a.getAttribute('position').array.length + b.getAttribute('position').array.length);
  positions.set(a.getAttribute('position').array, 0);
  positions.set(b.getAttribute('position').array, a.getAttribute('position').array.length);
  const merged = new BufferGeometry();
  merged.setAttribute('position', new Float32BufferAttribute(positions, 3));
  return merged;
}

/**
 * An open tube: two coaxial cylinder walls (R outer, r inner), N facets, no end
 * caps. A plane crossing it mid-height therefore returns exactly two loops — the
 * outer wall and the bore — which is the shape of the question.
 */
function tube({ R = 10, r = 5, height = 20, N = 360 }) {
  const positions = [];
  const push = (x, y, z) => positions.push(x, y, z);
  const at = (radius, k, z) => {
    const angle = (k / N) * Math.PI * 2;
    return [radius * Math.cos(angle), radius * Math.sin(angle), z];
  };
  for (const z of [-height / 2, height / 2]) { /* both rims share the same facets */ }
  for (let k = 0; k < N; k++) {
    for (const [inner, radius] of [[false, R], [true, r]]) {
      const [x0, y0] = at(radius, k, -height / 2);
      const [x1, y1] = at(radius, k + 1, -height / 2);
      const [x2, y2] = at(radius, k + 1, height / 2);
      const [x3, y3] = at(radius, k, height / 2);
      // Winding is irrelevant to plane-vs-triangle; keep both walls' facets explicit.
      if (!inner) {
        push(x0, y0, -height / 2); push(x1, y1, -height / 2); push(x2, y2, height / 2);
        push(x0, y0, -height / 2); push(x2, y2, height / 2); push(x3, y3, height / 2);
      } else {
        push(x1, y1, -height / 2); push(x0, y0, -height / 2); push(x3, y3, height / 2);
        push(x1, y1, -height / 2); push(x3, y3, height / 2); push(x2, y2, height / 2);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(positions), 3));
  return geometry;
}

const polygonArea = (radius, N) => (N / 2) * radius * radius * Math.sin((2 * Math.PI) / N);
const triangleAreaSum = (triangles) => {
  let total = 0;
  for (let i = 0; i + 8 < triangles.length; i += 9) {
    const a = [triangles[i], triangles[i + 1], triangles[i + 2]];
    const b = [triangles[i + 3], triangles[i + 4], triangles[i + 5]];
    const c = [triangles[i + 6], triangles[i + 7], triangles[i + 8]];
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cx = ab[1] * ac[2] - ab[2] * ac[1];
    const cy = ab[2] * ac[0] - ab[0] * ac[2];
    const cz = ab[0] * ac[1] - ab[1] * ac[0];
    total += Math.hypot(cx, cy, cz) / 2;
  }
  return total;
};

console.log('free-plane section acceptance\n');

// ── 1. the basis matches the worker's rule ──────────────────────────────────

check(JSON.stringify(planeBasisFor([0, 0, 1])) === JSON.stringify({ u: [1, 0, 0], v: [0, 1, 0] }),
  'a +z plane seeds u=x, v=y', JSON.stringify(planeBasisFor([0, 0, 1])));
check(JSON.stringify(planeBasisFor([1, 0, 0])) === JSON.stringify({ u: [0, 1, 0], v: [0, 0, 1] }),
  'a +x plane seeds u=y, v=z', JSON.stringify(planeBasisFor([1, 0, 0])));
// The Python side (worker.py `_plane_basis`) seeds the axis with the smallest
// |component| and breaks ties by the lowest index: for +y that is x, so v = y×x = −z.
// TypeScript used to say u=z, v=x: same plane, different coordinates for the same cut.
check(JSON.stringify(planeBasisFor([0, 1, 0])) === JSON.stringify({ u: [1, 0, 0], v: [-0, 0, -1] })
  || JSON.stringify(planeBasisFor([0, 1, 0])) === JSON.stringify({ u: [1, 0, 0], v: [0, 0, -1] }),
  'a +y plane now agrees with the worker: u=x, v=−z', JSON.stringify(planeBasisFor([0, 1, 0])));
check(JSON.stringify(planeBasis('y')) === JSON.stringify({ u: planeBasisFor([0, 1, 0]).u, v: planeBasisFor([0, 1, 0]).v }),
  'planeBasis(axis) is planeBasisFor(normal), not a second rule');

const oblique = normalizePlane({ pointMm: [0, 0, 0], normal: [0, -1, 1] });
check(near(Math.hypot(...oblique.normal), 1), 'a non-unit normal is normalised', fmt(Math.hypot(...oblique.normal)));
check(JSON.stringify(Object.keys(oblique).sort()) === '["normal","pointMm"]', 'normalizePlane keeps the point');
let degenerate = '';
try { normalizePlane({ pointMm: [0, 0, 0], normal: [0, 0, 0] }); } catch (error) { degenerate = String(error?.message ?? error); }
check(/non-zero/.test(degenerate), 'a zero normal raises instead of guessing a plane', degenerate);

// ── 2. the axis functions are the special case, unchanged ───────────────────

const box = cube(20);
for (const [axis, cut] of [['x', 0], ['y', 5], ['z', -7]]) {
  const legacy = sectionSegments(box, axis, cut);
  const general = sectionSegmentsOnPlane(box, axisPlane(axis, cut));
  check(legacy.length === general.length && legacy.every((value, index) => Object.is(value, general[index])),
    `sectionSegments('${axis}') is bit-identical to the plane path`, `${legacy.length} vs ${general.length}`);
  const legacyCap = capTriangles(box, axis, cut);
  const generalCap = capTrianglesOnPlane(box, axisPlane(axis, cut));
  check(legacyCap.length === generalCap.length && legacyCap.every((value, index) => Object.is(value, generalCap[index])),
    `capTriangles('${axis}') is bit-identical to the plane path`);
  const legacyLoops = JSON.stringify(sectionLoops(box, axis, cut));
  check(legacyLoops === JSON.stringify(sectionLoopsOnPlane(box, axisPlane(axis, cut))),
    `sectionLoops('${axis}') is identical to the plane path`);
}

// ── 3. a cube cut at 45° is a 20 × 20√2 rectangle ───────────────────────────

const fortyFive = { pointMm: [0, 0, 0], normal: [0, -1, 1] };
const loops45 = sectionLoopsOnPlane(box, fortyFive);
check(loops45.length === 1, 'a 45° cut of one cube gives one loop', String(loops45.length));
const capArea45 = triangleAreaSum(capTrianglesOnPlane(box, fortyFive));
const expected45 = 20 * 20 * Math.SQRT2;
check(close(capArea45, expected45, 1e-3),
  `the 45° cube cap is 20 × 20√2 = ${expected45.toFixed(3)}mm²`, fmt(capArea45));
const capPts = capTrianglesOnPlane(box, fortyFive);
let offPlane = 0;
for (let i = 0; i < capPts.length; i += 3) {
  if (Math.abs(planeDistance(fortyFive, [capPts[i], capPts[i + 1], capPts[i + 2]])) > 1e-9) offPlane++;
}
check(offPlane === 0, 'every 45° cap vertex lies on the plane', `${offPlane} off-plane`);

// The same rectangle expressed the other way round (flip the normal): the plane is
// the same set of points, so the geometry must not care.
const flippedLoops = sectionLoopsOnPlane(box, { pointMm: [0, 0, 0], normal: [0, 1, -1] });
check(close(triangleAreaSum(capTrianglesOnPlane(box, { pointMm: [0, 0, 0], normal: [0, 1, -1] })), expected45, 1e-3),
  'reversing the normal keeps the same cut face');

// ── 4. a tube cut perpendicular: an annulus, not a disc ────────────────────

const N = 360;
const h = tube({ N });
const outerPolly = polygonArea(10, N);
const innerPolly = polygonArea(5, N);
const perpendicular = sectionLoopsOnPlane(h, axisPlane('z', 0));
check(perpendicular.length === 2, 'a mid-height cut of the tube gives two loops (wall + bore)', String(perpendicular.length));
const perpCap = triangleAreaSum(capTrianglesOnPlane(h, axisPlane('z', 0)));
const perpExpected = outerPolly - innerPolly;
check(close(perpCap, perpExpected, perpExpected * 1e-4),
  `the perpendicular cap is the ANNULUS ${perpExpected.toFixed(3)}mm², not the disc ${outerPolly.toFixed(3)}`,
  fmt(perpCap));

// ── 5. the same tube cut at 45°: an ellipse, and the bore is still a hole ───

const cos45 = Math.SQRT1_2;
const obliqueTube = { pointMm: [0, 0, 0], normal: [0, -Math.SQRT1_2, Math.SQRT1_2] };
const obliqueLoops = sectionLoopsOnPlane(h, obliqueTube);
check(obliqueLoops.length === 2, 'the oblique cut still opens exactly two loops', String(obliqueLoops.length));
const obliqueCap = triangleAreaSum(capTrianglesOnPlane(h, obliqueTube));
const obliqueExpected = perpExpected / cos45;
check(close(obliqueCap, obliqueExpected, obliqueExpected * 5e-3),
  `the 45° cap is the ellipse π(R²−r²)/cos45 = ${obliqueExpected.toFixed(3)}mm²`, fmt(obliqueCap));
check(obliqueCap < outerPolly / cos45 - innerPolly / cos45 * 0.5,
  'the oblique cap is materially smaller than the outer ellipse: the bore was subtracted');
// Concentric loops: the bore's centroid is the tube's axis, so "the hole is in the
// middle" is assertable without trusting a renderer.
const centres = obliqueLoops.map((loop) => loop.reduce((acc, p) => [acc[0] + p[0] / loop.length, acc[1] + p[1] / loop.length], [0, 0]));
check(near(centres[0][0], centres[1][0], 1) && near(centres[0][1], centres[1][1], 1),
  'the two loops are concentric (a bore, not a lopsided blob)', JSON.stringify(centres));
let obOffPlane = 0;
const obCap = capTrianglesOnPlane(h, obliqueTube);
for (let i = 0; i < obCap.length; i += 3) {
  if (Math.abs(planeDistance(obliqueTube, [obCap[i], obCap[i + 1], obCap[i + 2]])) > 1e-9) obOffPlane++;
}
check(obOffPlane === 0, 'every oblique cap vertex lies on its plane', `${obOffPlane} off-plane`);

// A plane at 90° to the axis (through the ends) misses the walls' interior: no cap.
check(capTrianglesOnPlane(h, axisPlane('z', 50)).length === 0, 'a plane above the tube has no cap');

// ── 6. two disjoint bodies: both get a cap ─────────────────────────────────

const two = twoCubes();
const twoLoops = sectionLoopsOnPlane(two, axisPlane('z', 0));
check(twoLoops.length === 2, 'a plane through two bodies gives two outer loops', String(twoLoops.length));
check(close(triangleAreaSum(capTrianglesOnPlane(two, axisPlane('z', 0))), 200, 1e-3),
  'both bodies are capped (100 + 100 = 200mm²), not one outer + one hole',
  fmt(triangleAreaSum(capTrianglesOnPlane(two, axisPlane('z', 0)))));

// ── 7. clipping plane: what is kept, and the flip ──────────────────────────

const keepLow = clippingPlane(axisPlane('z', 5), true);
check(JSON.stringify(keepLow) === JSON.stringify({ normal: [-0, -0, -1], constant: 5 })
  || JSON.stringify(keepLow) === JSON.stringify({ normal: [0, 0, -1], constant: 5 }),
  'flip=true on +z reproduces the historical "keep z ≤ cut" clip', JSON.stringify(keepLow));
const kept = new Vector3(0, 0, 4);
const dropped = new Vector3(0, 0, 6);
const signed = (plane) => plane.normal[0] * kept.x + plane.normal[1] * kept.y + plane.normal[2] * kept.z + plane.constant;
check(signed(keepLow) > 0 && signed(keepLow) + 2 * -1 * 1 < 0 || signed(keepLow) > 0,
  'the kept half is positive for three.js (kept point z=4 is on the positive side)', fmt(signed(keepLow)));
const flipNo = clippingPlane(axisPlane('z', 5), false);
check(JSON.stringify(flipNo.normal.map((v) => (v === 0 ? 0 : v))) === '[0,0,1]' && near(flipNo.constant, -5),
  'without the flip the same plane keeps z ≥ cut', JSON.stringify(flipNo));

const arbitrary = { pointMm: [3, -2, 7], normal: [1, 2, 3] };
const cp = clippingPlane(arbitrary);
check(near(Math.hypot(...cp.normal), 1) && near(planeDistance(arbitrary, [3, -2, 7]), 0),
  'an arbitrary plane normalises and passes through its own point',
  `${JSON.stringify(cp.normal)} d=${fmt(planeDistance(arbitrary, [3, -2, 7]))}`);
check(near(cp.normal[0] * 3 + cp.normal[1] * -2 + cp.normal[2] * 7 + cp.constant, 0),
  'the clipping constant is consistent with the point', String(cp.constant));

// ── 8. projections ─────────────────────────────────────────────────────────

const off = [3, 2, 9];
const projected = projectToPlane(off, { pointMm: [0, 0, 0], normal: [0, 0, 1] });
check(JSON.stringify(projected) === JSON.stringify(projectToCutPlane(off, 'z', 0)),
  'projectToPlane agrees with projectToCutPlane on an axis plane', JSON.stringify(projected));
const skewed = projectToPlane([1, 1, 1], oblique);
check(near(planeDistance(oblique, skewed), 0, 1e-12),
  'a projected point lands exactly ON an oblique plane', fmt(planeDistance(oblique, skewed)));
check(Math.abs(planeDistance(oblique, [0, 1, 2])) > 0.1, 'a point the plane does not contain is not reported as on it');
// A plane that lies ON the cube's own edges (the 45° case above) must still give
// one clean loop: without the coincident-segment dedupe this returned a doubled
// boundary whose signed area cancelled to 0, and the cap came back empty.
const doubled = sectionLoopsOnPlane(box, { pointMm: [0, 0, 0], normal: [0, -1, 1] });
check(doubled.length === 1 && Math.abs(sectionLoopsOnPlane(box, { pointMm: [0, 0, 0], normal: [0, -1, 1] }).length) === 1,
  'a cut along the mesh\'s own edges is not double-counted');
check(Math.abs(triangleAreaSum(capTrianglesOnPlane(box, { pointMm: [0, 0, 0], normal: [0, -1, 1] })) - expected45) < 1e-3,
  'the edge-coincident cap is the full rectangle, not an empty face');

console.log(failures ? `\naccept-section-free: ${failures} FAILURE(S)` : '\naccept-section-free: PASS');
process.exit(failures ? 1 : 0);
