// Acceptance: a manifest placement rotates in the SAME composition every other
// consumer uses (OpenSCAD / Manifold / the worker / rapier), not three's default.
//
// The bug this pins: StaticPartsView did `mesh.rotation.set(x, y, z)` and three
// defaulted to order 'XYZ' (R = Rx·Ry·Rz). The manifest, OpenSCAD, Manifold and
// the worker all mean R = Rz·Ry·Rx (three calls it 'ZYX'). The two compositions
// agree only when at most one angle is non-zero, so single-axis parts hid it.
// On glucose C1 ([54.7356, -54.7356, 60]) the default put the ball's sockets
// 28°–84° away from the sticks — the "装配体歪掉 / 每个孔都没对齐" screenshot.
//
//   node scripts/accept-placement-euler.mjs
import * as THREE from 'three';
import { placementEuler } from '../src/client/placement.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const DEG = Math.PI / 180;
const mul = (a, b) => a.map((row, r) => b[0].map((_, c) => row.reduce((s, v, k) => s + v * b[k][c], 0)));
const rotX = (d) => [[1, 0, 0], [0, Math.cos(d * DEG), -Math.sin(d * DEG)], [0, Math.sin(d * DEG), Math.cos(d * DEG)]];
const rotY = (d) => [[Math.cos(d * DEG), 0, Math.sin(d * DEG)], [0, 1, 0], [-Math.sin(d * DEG), 0, Math.cos(d * DEG)]];
const rotZ = (d) => [[Math.cos(d * DEG), -Math.sin(d * DEG), 0], [Math.sin(d * DEG), Math.cos(d * DEG), 0], [0, 0, 1]];
/** The manifest convention, written out without three: Rz·Ry·Rx. */
const manifestMatrix = ([x, y, z]) => mul(rotZ(z), mul(rotY(y), rotX(x)));
const apply = (m, v) => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
const angleDeg = (a, b) => {
  const dot = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) /
    (Math.hypot(...a) * Math.hypot(...b));
  return Math.acos(Math.max(-1, Math.min(1, dot))) / DEG;
};
const threeMatrix = (rot) => new THREE.Matrix4().makeRotationFromEuler(placementEuler(rot));
const threeApply = (rot, v) => v.clone().applyEuler(placementEuler(rot));

// ---- 1. the order is stated, not implied ------------------------------------
{
  const e = placementEuler([30, 40, 50]);
  check(e.order === 'ZYX', "placementEuler states order 'ZYX' (= Rz·Ry·Rx)", e.order);
  check(Math.abs(e.x - 30 * DEG) < 1e-12 && Math.abs(e.y - 40 * DEG) < 1e-12,
    'the angles are degrees, converted once');
}

// ---- 2. the matrix equals Rz·Ry·Rx, element for element ---------------------
{
  const rot = [30, 40, 50];
  const ref = manifestMatrix(rot);
  const got = threeMatrix(rot).elements; // column-major
  const asRows = [[got[0], got[4], got[8]], [got[1], got[5], got[9]], [got[2], got[6], got[10]]];
  const worst = Math.max(...asRows.flatMap((row, r) => row.map((v, c) => Math.abs(v - ref[r][c]))));
  check(worst < 1e-12, 'rotation matrix matches Rz·Ry·Rx', `max element error ${worst.toExponential(2)}`);
}

// ---- 3. the glucose case that exposed it ------------------------------------
// C1 rot, local socket s0 = +Z, world direction declared by spec/molecule.json.
{
  const rot = [54.7356, -54.7356, 60];
  const localZ = new THREE.Vector3(0, 0, 1);
  const want = new THREE.Vector3(0.471405, -0.816497, 0.333333);
  const got = threeApply(rot, localZ);
  const off = angleDeg(got.toArray(), want.toArray());
  check(off < 0.05, 'C1 socket 0 points at the declared bond direction', `${off.toFixed(3)}° off`);

  // Negative control: the pre-fix default must be FAR off, or this test cannot
  // fail when someone reintroduces it.
  const legacy = new THREE.Euler(rot[0] * DEG, rot[1] * DEG, rot[2] * DEG, 'XYZ');
  const legacyOff = angleDeg(localZ.clone().applyEuler(legacy).toArray(), want.toArray());
  check(legacyOff > 60, "the default 'XYZ' order is the failure this test catches", `${legacyOff.toFixed(1)}° off`);
}

// ---- 4. a single-axis placement is unchanged (the compatibility claim) ------
{
  const rot = [0, -70.5288, 0];
  const ref = manifestMatrix(rot);
  const got = threeMatrix(rot).elements;
  const asRows = [[got[0], got[4], got[8]], [got[1], got[5], got[9]], [got[2], got[6], got[10]]];
  const worst = Math.max(...asRows.flatMap((row, r) => row.map((v, c) => Math.abs(v - ref[r][c]))));
  check(worst < 1e-12, 'single-axis placement matches the old behaviour', `max element error ${worst.toExponential(2)}`);
}

// ---- 5. rotate then translate (the panel's order) --------------------------
{
  const rot = [30, 40, 50];
  const t = [10, -4, 2];
  const v = new THREE.Vector3(1, 2, 3);
  const placed = threeApply(rot, v).add(new THREE.Vector3(...t));
  const want = apply(manifestMatrix(rot), [1, 2, 3]).map((x, i) => x + t[i]);
  const d = placed.distanceTo(new THREE.Vector3(...want));
  check(d < 1e-12, 'world = translate + R·local', `${d.toExponential(2)} mm`);
}

console.log(failures ? `\n${failures} FAIL` : '\nall PASS');
process.exit(failures ? 1 : 0);
