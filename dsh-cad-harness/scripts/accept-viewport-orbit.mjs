// Acceptance for the CAD viewport camera controller.
//
// WHY THIS EXISTS. The viewport used to ship a hand-written "free orbit" that
// crossed the poles by rotating `camera.up` with the model. After an upside-down
// turn the screen basis was inverted and a horizontal drag moved the model the
// opposite way from the pointer. The user asked for three.js's stock behaviour
// back, so this test pins the structural part of that decision: the viewport
// adapter really constructs OrbitControls, and the camera it leaves behind keeps
// world up (the condition that makes the screen-right axis stable).
//
//   node scripts/accept-viewport-orbit.mjs
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { createFreeOrbit } = await import('../src/client/free-orbit.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// --- structural: no second controller implementation sneaks back in ---------
const source = readFileSync(join(ROOT, 'src/client/free-orbit.ts'), 'utf8');
check(/from 'three\/examples\/jsm\/controls\/OrbitControls\.js'/.test(source),
  'the viewport imports the stock OrbitControls');
check(/new OrbitControls\(/.test(source), 'the adapter constructs OrbitControls');
check(!/class\s+FreeOrbitControls\b/.test(source),
  'the hand-written controller class is gone (it is a type alias now)');

// --- behavioural: the ORIGINAL controller leaves camera.up alone -------------
// A DOM stub is enough for construction/update; pointer input itself belongs to
// OrbitControls, not to this repository.
function makeDomStub() {
  const listeners = new Map();
  const doc = { addEventListener() {}, removeEventListener() {} };
  return {
    style: {},
    addEventListener(type, fn) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener() {},
    getRootNode: () => doc,
    setPointerCapture() {},
    releasePointerCapture() {},
    clientWidth: 400,
    clientHeight: 300,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
  };
}

const camera = new THREE.PerspectiveCamera(45, 4 / 3, 0.1, 1000);
camera.position.set(12, 9, 12);
camera.lookAt(0, 0, 0);
const { controls, dispose } = createFreeOrbit(camera, makeDomStub(), {
  target: new THREE.Vector3(0, 0, 0),
  minDistance: 2,
  maxDistance: 80,
  rotateSpeed: 1.2,
  panSpeed: 0.8,
  zoomSpeed: 1.5,
});
controls.update();

check(typeof controls.getPolarAngle === 'function' && typeof controls.getAzimuthalAngle === 'function',
  'the controller exposes the stock spherical API');
check(controls.target.lengthSq() === 0 && controls.minDistance === 2 && controls.maxDistance === 80,
  'the CAD target and distance range are applied');
check(controls.rotateSpeed === 1.2 && controls.panSpeed === 0.8 && controls.zoomSpeed === 1.5,
  'the CAD speeds are applied');
check(camera.up.distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-9,
  'update() leaves camera.up at world up (no rolled screen basis)');

// The exact 180°-then-horizontal sequence the user reported. OrbitControls has
// no operation that rolls the camera's up vector, so the precondition for the
// direction inversion cannot exist; the assertion is about that invariant.
const upBefore = camera.up.clone();
for (let i = 0; i < 40; i++) {
  controls.rotateSpeed = 1;
  // Direct spherical drive: the same vertical sweep a long drag would produce.
  const phi = Math.min(Math.PI, controls.getPolarAngle() + 0.2);
  const theta = controls.getAzimuthalAngle() + 0.15;
  camera.position.setFromSphericalCoords(
    camera.position.distanceTo(controls.target), phi, theta,
  ).add(controls.target);
  controls.update();
}
check(camera.up.distanceTo(upBefore) < 1e-9,
  'a full vertical sweep plus horizontal turns never rotates camera.up', camera.up.toArray().join(','));

dispose();
console.log(failures ? `\n${failures} FAIL` : '\nall PASS');
process.exit(failures ? 1 : 0);
