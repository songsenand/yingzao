// Exploded-view geometry, kept pure so it can be asserted without a DOM.
//
// The preview moves each part along the vector from the ASSEMBLY CENTRE to the
// part's own centre. That separates coaxial stacks (their centres differ along
// the axis) and never depends on the current camera. Coincident centres — a pin
// modelled at the same origin as its hole — would get a zero vector, so they
// fall back to an axis cycle; deterministic, so a screenshot at the same slider
// value is reproducible.
import * as THREE from 'three';

export interface ExplodeStep {
  /** Unit direction away from the assembly centre. */
  dir: THREE.Vector3;
  /** Distance at 100% (mm). */
  span: number;
}

/** One step per part, in the same order as `partCentres`. */
export function planExplosion(
  centre: THREE.Vector3,
  radius: number,
  partCentres: readonly THREE.Vector3[],
): ExplodeStep[] {
  // 1.15× the assembly radius clears most parts of each other at 100% without
  // launching the outermost one out of a 45° FOV framed at radius+span.
  const span = Math.max(radius * 1.15, 10);
  return partCentres.map((c, i) => {
    const dir = c.clone().sub(centre);
    if (dir.lengthSq() < 1e-6) {
      dir.set(i % 3 === 0 ? 1 : 0, i % 3 === 1 ? 1 : 0, i % 3 === 2 ? 1 : 0);
    }
    return { dir: dir.normalize(), span };
  });
}

/** Offset to add to the authored position. `factor` is 0..1. */
export function explodeOffset(step: ExplodeStep, factor: number): THREE.Vector3 {
  return step.dir.clone().multiplyScalar(step.span * factor);
}
