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
