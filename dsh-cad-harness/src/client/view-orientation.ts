// View orientation arithmetic for the CAD viewport — pure, no three.js scene.
//
// WHY A MODULE: "顶/前/右/等轴" and "沿 ±X/±Y/±Z 看" are the same three directions
// in two spellings, and the traps are arithmetic, not UI:
//   * a pole view (top/bottom) puts the camera's up parallel to the view
//     direction, which makes lookAt undefined — the up must switch to +Y;
//   * the orthographic frustum is derived from the perspective camera's distance,
//     so switching projection must not change the apparent size of the part.
// Both are checkable here (`accept-viewport-orbit.mjs`) instead of by turning the
// camera and squinting at a screenshot.

export type StandardView = 'iso' | 'top' | 'front' | 'right' | 'back' | 'left';
export type AxisSnap = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

export type Direction = readonly [number, number, number];

const DIRECTIONS: Record<StandardView | AxisSnap, Direction> = {
  iso: [1, 1, 1],
  top: [0, 0, 1],
  front: [0, -1, 0],
  right: [1, 0, 0],
  back: [0, 1, 0],
  left: [-1, 0, 0],
  '+x': [1, 0, 0],
  '-x': [-1, 0, 0],
  '+y': [0, 1, 0],
  '-y': [0, -1, 0],
  '+z': [0, 0, 1],
  '-z': [0, 0, -1],
};

/** Unit direction from the orbit target to the camera for a named view/axis. */
export function viewDirection(name: StandardView | AxisSnap): Direction {
  const raw = DIRECTIONS[name];
  const length = Math.hypot(raw[0], raw[1], raw[2]);
  return [raw[0] / length, raw[1] / length, raw[2] / length];
}

/**
 * The camera's `up` for a view direction.
 *
 * World up is +Z (the project's convention), EXCEPT for a pole view: there the
 * view direction is parallel to +Z and `lookAt` needs a different up, so +Y is
 * used — which is also what a drawing calls "top view" (its screen-up is the y
 * axis). The threshold is on purpose: 0.999 accepts a real 90° view and rejects
 * the 45° iso.
 */
export function cameraUpFor(direction: Direction): [number, number, number] {
  const length = Math.hypot(direction[0], direction[1], direction[2]) || 1;
  const z = direction[2] / length;
  return Math.abs(z) > 0.999 ? [0, 1, 0] : [0, 0, 1];
}

/** Half-height of the orthographic frustum at a distance, matching a perspective fov. */
export function orthoHalfHeight(distanceMm: number, fovDeg: number): number {
  return Math.tan((fovDeg * Math.PI) / 360) * Math.max(distanceMm, 1e-6);
}

/**
 * The orthographic frustum that shows the same field of view as a perspective
 * camera at `distanceMm`. This is what makes the projection toggle honest: the
 * part keeps its apparent size instead of jumping.
 */
export function orthoBounds(
  distanceMm: number,
  fovDeg: number,
  aspect: number,
): { left: number; right: number; top: number; bottom: number } {
  const half = orthoHalfHeight(distanceMm, fovDeg);
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  return { left: -half * safeAspect, right: half * safeAspect, top: half, bottom: -half };
}

/** Millimetres per pixel in an orthographic view of height `hostHpx`. */
export function orthoMmPerPixel(bounds: { top: number; bottom: number }, hostHpx: number): number {
  if (hostHpx <= 0) return 0;
  return Math.abs(bounds.top - bounds.bottom) / hostHpx;
}
