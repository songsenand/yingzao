/** Camera framing shared by every CAD view (version viewer + run playback). */
import * as THREE from 'three';

/**
 * Distance at which a bounding sphere of `radius` fits the camera's frame.
 *
 * The viewport is no longer a forced square — it takes whatever height the
 * dock leaves it — so the frame can be taller or wider than it is deep. A
 * sphere inscribed in the *narrower* field of view is therefore inscribed in
 * the viewport: fitting only the vertical FOV (a fixed distance multiplier)
 * crops the model horizontally as soon as the viewport turns portrait. The
 * caller keeps its own viewing direction; only the distance is aspect-aware.
 */
export function fitDistance(camera: THREE.PerspectiveCamera, radius: number): number {
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const aspect = Math.max(camera.aspect, 1e-6);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  return Math.max(radius, 1) / Math.sin(Math.min(vFov, hFov) / 2);
}

/**
 * Distance at which a BOX fits the camera when looked at along `direction`.
 *
 * `fitDistance` inscribes a sphere of `radius`, and a box's half-DIAGONAL is not
 * the extent the camera sees: framing a long, thin or flat machine by its
 * diagonal leaves it sitting in a third of the viewport (measured on the
 * 380px dock: an exploded 16-part microscope filled ~35% of the height). Here
 * each of the eight corners is projected — the required distance is the largest
 * one any corner asks for — and the direction is the caller's, so "keep the
 * angle, fill the frame" still holds.
 */
export function fitBoxDistance(
  camera: THREE.PerspectiveCamera,
  box: THREE.Box3,
  direction: THREE.Vector3,
): number {
  const dir = direction.clone().normalize();
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir);
  // Looking straight up/down: any right vector orthogonal to dir will do.
  if (right.lengthSq() < 1e-9) right.set(1, 0, 0);
  right.normalize();
  const up = new THREE.Vector3().crossVectors(dir, right).normalize();
  const forward = dir.clone().negate();
  const center = box.getCenter(new THREE.Vector3());
  const vTan = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const hTan = vTan * Math.max(camera.aspect, 1e-6);
  let d = 0;
  for (let i = 0; i < 8; i++) {
    const corner = new THREE.Vector3(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    ).sub(center);
    // Camera-space depth of the corner is D + z (z measured along `forward`).
    const x = corner.dot(right);
    const y = corner.dot(up);
    const z = corner.dot(forward);
    d = Math.max(d, Math.abs(x) / hTan - z, Math.abs(y) / vTan - z);
  }
  return Math.max(d, 1e-3);
}
