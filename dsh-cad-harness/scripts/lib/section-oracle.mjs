// Cross-section area, computed WITHOUT the code under test.
//
// The cap is built by chaining intersection segments into loops and triangulating the
// regions between them. Every one of those steps can be wrong in a way that still
// produces "some filled triangles", which is why the old assertions ("area > 0",
// "smaller than the hull") stayed green on a visibly broken cut.
//
// This oracle sums the signed area of the same intersection SEGMENTS without ever
// building a loop: for a closed surface, ½·Σ (a×b)·n over the cut curve is the
// enclosed area, holes subtracting on their own. It is checked against closed-form
// values on a cube first (mid-plane 100 mm², 45° plane 141.42 mm², quarter-cut 100 mm²),
// so a wrong oracle fails before it accuses the cap.
//
// The cap under test is `capTrianglesOnPlane` in src/client/section.ts.

import * as THREE from 'three';
import { BoxGeometry } from 'three';
import { capTrianglesOnPlane } from '../../src/client/section.ts';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * Area enclosed by the plane's intersection curve with a closed mesh.
 *
 * Each triangle that crosses the plane contributes one segment. The segment's
 * DIRECTION must follow the curve consistently, or neighbouring segments cancel:
 * walking along `cross(n, n_triangle)` keeps the material on a fixed side, so the
 * segments telescope into a closed, consistently wound polygon and the shoelace sum
 * gives the enclosed area (holes wind the other way and subtract by themselves).
 */
export function crossSectionArea(geometry, plane) {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const count = index ? index.count / 3 : position.count / 3;
  const length = Math.hypot(plane.normal[0], plane.normal[1], plane.normal[2]);
  const n = [plane.normal[0] / length, plane.normal[1] / length, plane.normal[2] / length];
  const offset = dot(plane.pointMm, n);
  const vertexAt = (k) => {
    const i = index ? index.getX(k) : k;
    return [position.getX(i), position.getY(i), position.getZ(i)];
  };
  let sum = 0;
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
    sum += dot(cross(oriented[0], oriented[1]), n) / 2;
  }
  return Math.abs(sum);
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

// ── the oracle's own self-test (a wrong oracle must fail before it judges) ──
{
  const cube = new BoxGeometry(10, 10, 10, 1, 1, 1);
  const cases = [
    ['cube mid-plane through the centre', { pointMm: [0, 0, 0], normal: [0, 0, 1] }, 100],
    ['cube 45° plane through the centre', { pointMm: [0, 0, 0], normal: [Math.SQRT1_2, 0, Math.SQRT1_2] }, 100 * Math.SQRT2],
    ['cube quarter cut (x = 2.5)', { pointMm: [2.5, 0, 0], normal: [1, 0, 0] }, 100],
  ];
  let ok = true;
  for (const [label, plane, expected] of cases) {
    const got = crossSectionArea(cube, plane);
    const good = Math.abs(got - expected) / expected < 1e-6;
    if (!good) ok = false;
    console.log(`${good ? 'PASS' : 'FAIL'}  oracle: ${label} — expected ${expected.toFixed(2)}, got ${got.toFixed(2)}`);
  }
  if (!ok) {
    console.error('\nthe ORACLE is wrong; refusing to judge the cap with it');
    process.exit(2);
  }
  console.log('');
}
