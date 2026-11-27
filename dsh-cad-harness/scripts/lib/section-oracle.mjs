// Cross-section area AND centroid, computed WITHOUT the code under test.
//
// The cap is built by chaining intersection segments into loops and triangulating the
// regions between them. Every one of those steps can be wrong in a way that still
// produces "some filled triangles", which is why the old assertions ("area > 0",
// "smaller than the hull") stayed green on a visibly broken cut.
//
// This oracle sums the signed area (and its first moments) of the same intersection
// SEGMENTS without ever building a loop: for a closed surface, ½·Σ (a×b)·n over the
// cut curve is the enclosed area, holes subtracting on their own. The AREA is blind to
// a cap that is the right shape in the wrong place — the 2026-11-27 "loose ribbons"
// were a pure translation inside the plane, and every area assertion passed. The
// FIRST MOMENT is what pins the shape down, so `crossSectionCentroid` is checked too.
//
// Both are checked against closed-form values on a cube first (mid-plane 100 mm²,
// 45° plane 141.42 mm², quarter-cut 100 mm², all centroids at the plane's origin), so
// a wrong oracle fails before it accuses the cap.
//
// The cap under test is `capTrianglesOnPlane` in src/client/section.ts.

import * as THREE from 'three';
import { BoxGeometry } from 'three';
import { capTrianglesOnPlane } from '../../src/client/section.ts';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * The plane's own orthonormal frame: the world axis LEAST aligned with the normal
 * seeds u (first index wins a tie), v = n × u. Same rule as `planeBasisFor`, but
 * written out here: the oracle must not borrow the frame from the code it judges.
 */
function planeFrameOf(plane) {
  const length = Math.hypot(plane.normal[0], plane.normal[1], plane.normal[2]);
  const n = [plane.normal[0] / length, plane.normal[1] / length, plane.normal[2] / length];
  const abs = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])];
  let seedIndex = 0;
  for (let i = 1; i < 3; i++) if (abs[i] < abs[seedIndex]) seedIndex = i;
  const seed = [0, 0, 0];
  seed[seedIndex] = 1;
  const along = dot(seed, n);
  const raw = [seed[0] - along * n[0], seed[1] - along * n[1], seed[2] - along * n[2]];
  const rawLength = Math.hypot(raw[0], raw[1], raw[2]);
  const u = [raw[0] / rawLength, raw[1] / rawLength, raw[2] / rawLength];
  return { n, u, v: cross(n, u), point: plane.pointMm };
}

/**
 * Area and first moments of the plane's intersection curve with a closed mesh.
 *
 * Each triangle that crosses the plane contributes one segment. The segment's
 * DIRECTION must follow the curve consistently, or neighbouring segments cancel:
 * walking along `cross(n, n_triangle)` keeps the material on a fixed side, so the
 * segments telescope into a closed, consistently wound polygon and the shoelace sum
 * gives the enclosed area (holes wind the other way and subtract by themselves).
 *
 * Coordinates are taken in the plane's frame RELATIVE TO THE PLANE'S POINT — the
 * same convention `frameToWorld` documents. Projecting the raw world coordinate
 * instead is a translation of (point·u, point·v) that no area check can see.
 */
function sectionMoments(geometry, plane) {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const count = index ? index.count / 3 : position.count / 3;
  const { n, u, v, point } = planeFrameOf(plane);
  const offset = dot(point, n);
  const vertexAt = (k) => {
    const i = index ? index.getX(k) : k;
    return [position.getX(i), position.getY(i), position.getZ(i)];
  };
  let area2 = 0;
  let mx = 0;
  let my = 0;
  for (let t = 0; t < count; t++) {
    const corners = [vertexAt(t * 3), vertexAt(t * 3 + 1), vertexAt(t * 3 + 2)];
    // SIMULATION OF SIMPLICITY: a vertex exactly on the plane is treated as strictly
    // positive. A cube cut through its own diagonal puts FOUR vertices exactly on the
    // plane, each shared by six triangles; without the nudge every one of them is
    // "on the plane" for six triangles and the segment pairing becomes arbitrary
    // (measured: 45° cube returned 247.49 instead of 141.42).
    const d = corners.map((c) => {
      const value = dot(c, n) - offset;
      return value === 0 ? 1e-12 : value;
    });
    const points = [];
    const push = (p) => {
      if (points.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 1e-7)) return;
      points.push(p);
    };
    for (let e = 0; e < 3; e++) {
      const a = corners[e];
      const b = corners[(e + 1) % 3];
      const da = d[e];
      const db = d[(e + 1) % 3];
      if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
        const w = da / (da - db);
        push([a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w]);
      }
    }
    if (points.length !== 2) continue;
    const triNormal = cross(sub(corners[1], corners[0]), sub(corners[2], corners[0]));
    const walk = cross(n, triNormal);
    const [p, q] = points;
    const seg = sub(q, p);
    const oriented = dot(seg, walk) >= 0 ? [p, q] : [q, p];
    const a = sub(oriented[0], point);
    const b = sub(oriented[1], point);
    const ax = dot(a, u);
    const ay = dot(a, v);
    const bx = dot(b, u);
    const by = dot(b, v);
    const shoelace = ax * by - bx * ay;
    area2 += shoelace;
    mx += (ax + bx) * shoelace;
    my += (ay + by) * shoelace;
  }
  const frame = { point, u, v, n };
  const area = Math.abs(area2) / 2;
  // World-space area centroid of the enclosed region; null for a degenerate curve.
  const centroid = Math.abs(area2) < 1e-9
    ? null
    : [
        point[0] + u[0] * (mx / (3 * area2)) + v[0] * (my / (3 * area2)),
        point[1] + u[1] * (mx / (3 * area2)) + v[1] * (my / (3 * area2)),
        point[2] + u[2] * (mx / (3 * area2)) + v[2] * (my / (3 * area2)),
      ];
  return { area, centroid, frame };
}

/** Area enclosed by the plane's intersection curve with a closed mesh. */
export function crossSectionArea(geometry, plane) {
  return sectionMoments(geometry, plane).area;
}

/**
 * Area centroid of the enclosed cross-section, in WORLD coordinates.
 *
 * A translation of the cap inside its plane leaves the area untouched; this is the
 * number that catches it. Null when the plane only grazes the mesh (no area).
 */
export function crossSectionCentroid(geometry, plane) {
  return sectionMoments(geometry, plane).centroid;
}

/** Area of the triangles the cap builder returned. */
export function capArea(triangles) {
  let area = 0;
  for (let i = 0; i + 8 < triangles.length; i += 9) {
    const a = new THREE.Vector3(triangles[i], triangles[i + 1], triangles[i + 2]);
    const b = new THREE.Vector3(triangles[i + 3], triangles[i + 4], triangles[i + 5]);
    const c = new THREE.Vector3(triangles[i + 6], triangles[i + 7], triangles[i + 8]);
    area += new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).length() / 2;
  }
  return area;
}

/** Area-weighted centroid of the cap triangles, in WORLD coordinates. */
export function capCentroid(triangles) {
  let area = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i + 8 < triangles.length; i += 9) {
    const a = new THREE.Vector3(triangles[i], triangles[i + 1], triangles[i + 2]);
    const b = new THREE.Vector3(triangles[i + 3], triangles[i + 4], triangles[i + 5]);
    const c = new THREE.Vector3(triangles[i + 6], triangles[i + 7], triangles[i + 8]);
    const cross = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    const face = cross.length() / 2;
    area += face;
    cx += ((a.x + b.x + c.x) / 3) * face;
    cy += ((a.y + b.y + c.y) / 3) * face;
    cz += ((a.z + b.z + c.z) / 3) * face;
  }
  return area < 1e-9 ? null : [cx / area, cy / area, cz / area];
}

// ── the oracle's own self-test (a wrong oracle must fail before it judges) ──
{
  const cube = new BoxGeometry(10, 10, 10, 1, 1, 1);
  const shifted = new BoxGeometry(10, 10, 10, 1, 1, 1).translate(100, -200, 300);
  const cases = [
    ['cube mid-plane through the centre', cube, { pointMm: [0, 0, 0], normal: [0, 0, 1] }, 100, [0, 0, 0]],
    ['cube 45° plane through the centre', cube, { pointMm: [0, 0, 0], normal: [Math.SQRT1_2, 0, Math.SQRT1_2] }, 100 * Math.SQRT2, [0, 0, 0]],
    ['cube quarter cut (x = 2.5)', cube, { pointMm: [2.5, 0, 0], normal: [1, 0, 0] }, 100, [2.5, 0, 0]],
    ['cube translated 100,−200,300, 45° plane through its centre', shifted, { pointMm: [100, -200, 300], normal: [0, Math.SQRT1_2, Math.SQRT1_2] }, 100 * Math.SQRT2, [100, -200, 300]],
  ];
  let ok = true;
  for (const [label, geometry, plane, expected, expectedCentroid] of cases) {
    const got = crossSectionArea(geometry, plane);
    const centroid = crossSectionCentroid(geometry, plane);
    const goodArea = Math.abs(got - expected) / expected < 1e-6;
    const goodCentre = centroid !== null
      && Math.hypot(...centroid.map((value, i) => value - expectedCentroid[i])) < 1e-6;
    if (!goodArea || !goodCentre) ok = false;
    console.log(`${goodArea && goodCentre ? 'PASS' : 'FAIL'}  oracle: ${label} — expected ${expected.toFixed(2)} mm² at [${expectedCentroid.join(', ')}], got ${got.toFixed(2)} mm² at [${(centroid ?? []).map((value) => value.toFixed(3)).join(', ')}]`);
  }
  if (!ok) {
    console.error('\nthe ORACLE is wrong; refusing to judge the cap with it');
    process.exit(2);
  }
  console.log('');
}
