// Acceptance for the exploded-view planner (2026-11-26).
//
// The feature's failure modes are geometric, not visual: parts moving the WRONG
// way (toward the centre), parts with coincident centres staying stacked, and a
// slider that accumulates error because it adds to the last position instead of
// the authored one. This pins the pure planner; the component only adds the mesh.
//
//   node scripts/accept-explode.mjs
import * as THREE from 'three';
import { planExplosion, explodeOffset } from '../src/client/explode.ts';
import { fitBoxDistance } from '../src/client/fit.ts';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
};

const centre = new THREE.Vector3(0, 0, 0);
const radius = 100;
const centres = [
  new THREE.Vector3(10, 0, 0),   // off-axis
  new THREE.Vector3(0, 0, 50),   // axial stack
  new THREE.Vector3(0, 0, 0),    // coincident with the centre (a pin in a hole)
  new THREE.Vector3(-20, 5, 0),  // another off-axis
];
const steps = planExplosion(centre, radius, centres);

check('one step per part', steps.length === centres.length, `${steps.length}`);
check('all directions unit length',
  steps.every((s) => Math.abs(s.dir.length() - 1) < 1e-9),
  steps.map((s) => s.dir.length().toFixed(3)).join(','));
check('span is 1.15× radius', steps.every((s) => Math.abs(s.span - 115) < 1e-9), `${steps[0]?.span}`);

const dots = centres.map((c, i) => c.dot(steps[i].dir));
check('non-coincident parts move AWAY from the centre',
  dots.every((d, i) => centres[i].lengthSq() < 1e-6 || d > 0),
  dots.map((d) => d.toFixed(1)).join(','));
check('coincident part gets a real direction',
  steps[2].dir.lengthSq() > 0.99 && steps[2].dir.y === 0,
  `dir=(${steps[2].dir.x},${steps[2].dir.y},${steps[2].dir.z})`);

// Slider semantics: 0 = authored, 1 = full span, monotone in between.
const zero = explodeOffset(steps[0], 0);
const half = explodeOffset(steps[0], 0.5);
const full = explodeOffset(steps[0], 1);
check('0% is the authored position', zero.length() < 1e-12, zero.length().toFixed(6));
check('100% is exactly one span', Math.abs(full.length() - steps[0].span) < 1e-9, full.length().toFixed(1));
check('50% is half the span', Math.abs(half.length() - steps[0].span / 2) < 1e-9, half.length().toFixed(1));
check('slider offsets are idempotent (base + f·span, not last position)',
  zero.distanceTo(new THREE.Vector3()) < 1e-12
  && Math.abs(full.clone().sub(half).length() - steps[0].span / 2) < 1e-9);

// Framing (2026-11-28): the exploded view is framed by a BOX, not a sphere, so a
// wider-than-tall machine fills the frame. The failure this pins is "the model
// sits in a third of the viewport" — a sphere fit of the half-diagonal distance.
{
  const camera = new THREE.PerspectiveCamera(45, 355 / 264, 0.1, 100000);
  // A flat, wide box — the shape a machine base/plate is, and the case where
  // the half-diagonal is a poor proxy for what the camera sees.
  const box = new THREE.Box3(new THREE.Vector3(-300, -40, -200), new THREE.Vector3(300, 40, 200));
  const dir = new THREE.Vector3(1.6, 1.2, 1.8).normalize();
  const d = fitBoxDistance(camera, box, dir);

  // Every corner must land inside the frustum at that distance.
  camera.position.copy(dir.clone().multiplyScalar(d));
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  let maxNdc = 0;
  for (let i = 0; i < 8; i++) {
    const p = new THREE.Vector3(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    ).project(camera);
    maxNdc = Math.max(maxNdc, Math.abs(p.x), Math.abs(p.y));
  }
  check('box fit keeps every corner inside the frame', maxNdc <= 1 + 1e-6, `max|ndc|=${maxNdc.toFixed(3)}`);
  check('box fit is not needlessly far', maxNdc > 0.9, `max|ndc|=${maxNdc.toFixed(3)}`);

  // The same box fitted as a sphere (half-diagonal) needs a longer distance —
  // that is exactly the "third of the viewport" regression.
  const sphereR = box.getSize(new THREE.Vector3()).length() / 2;
  const sphereD = sphereR / Math.sin(THREE.MathUtils.degToRad(camera.fov) / 2);
  check('box fit is closer than the sphere fit', d < sphereD * 0.9, `${d.toFixed(1)} vs ${sphereD.toFixed(1)}`);
}

console.log(`\n${fail === 0 ? 'OK' : `${fail} FAILURE(S)`}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
