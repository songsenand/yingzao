// CAD viewport orbit: the stock three.js OrbitControls.
//
// WHY THIS IS A THIN ADAPTER AGAIN. The hand-written "free orbit" let the camera
// cross the poles by rotating `camera.up` with the model. After a 180° vertical
// turn the screen basis was upside down, so a horizontal drag moved the model the
// opposite way from the pointer — the bug the user reported. Chasing it with more
// hand-written quaternion rules kept producing edge cases (pole blends, pinch
// hand-off, drag-right sign).
//
// OrbitControls owns the same input mapping without ever changing `camera.up`:
// it derives the camera pose from an azimuth/polar pair around world up, so the
// screen-right axis cannot invert. Vertical rotation stops at the poles instead
// of rolling the camera upside down, which is the behaviour the user asked to
// restore. The adapter only supplies the CAD defaults (target, distance range,
// speeds) so all viewports keep configuring the camera the same way.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/** The camera controller shared by every CAD viewport. */
export type FreeOrbitControls = OrbitControls;

export interface FreeOrbitOptions {
  /** World point the camera orbits. */
  target: THREE.Vector3;
  minDistance: number;
  maxDistance: number;
  rotateSpeed?: number;
  panSpeed?: number;
  zoomSpeed?: number;
}

export interface FreeOrbit {
  controls: FreeOrbitControls;
  dispose: () => void;
}

/**
 * Install three.js's OrbitControls with the CAD viewport's configuration.
 *
 * Damping stays at the library default (off): every pointer event changes the
 * pose deterministically, which is what the viewport probes and the "the model
 * follows the cursor" expectation rely on.
 */
export function createFreeOrbit(
  // Any camera: the viewport switches between a perspective and an
  // orthographic camera, and OrbitControls does not care which it drives.
  camera: THREE.Camera,
  domElement: HTMLElement,
  opts: FreeOrbitOptions,
): FreeOrbit {
  const controls = new OrbitControls(camera, domElement);
  controls.target.copy(opts.target);
  controls.minDistance = opts.minDistance;
  controls.maxDistance = opts.maxDistance;
  controls.rotateSpeed = opts.rotateSpeed ?? 1;
  controls.panSpeed = opts.panSpeed ?? 1;
  controls.zoomSpeed = opts.zoomSpeed ?? 1;
  controls.update();
  return { controls, dispose: () => controls.dispose() };
}
