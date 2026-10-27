// The one place a manifest `rotate` becomes a three.js rotation.
//
// `rotate: [x, y, z]` is degrees in the composition OpenSCAD's
// rotate([x, y, z]) and Manifold's `Manifold.rotate([x, y, z])` use:
//
//   R = Rz(z) · Ry(y) · Rx(x)
//
// (schemas/assembly-manifest.schema.json: "degrees, XYZ order (matching
// Manifold rotate)"). three.js names exactly that composition 'ZYX'; its
// DEFAULT 'XYZ' is Rx·Ry·Rz — the reverse order. The two agree whenever at
// most one angle is non-zero, which is why a single-axis part never exposed
// this. On a compound placement they do not agree at all: C1 of the glucose
// corpus ([54.7356, -54.7356, 60]) had its four sockets put 28°–84° away from
// the sticks under the default order, and the panel showed a ball with no
// holes where the sticks were.
//
// Every non-three consumer already uses Rz·Ry·Rx: OpenSCAD, Manifold (the
// worker's check_assembly / validate_assembly), `rotateVec` in
// host/assembly-check.ts, and the rapier quaternion in host/motion.ts.
// See scripts/accept-placement-euler.mjs for the pinned composition.

import * as THREE from 'three';

/** Euler for a manifest placement, in the plugin's Rz·Ry·Rx convention. */
export function placementEuler(rotate: readonly number[]): THREE.Euler {
  return new THREE.Euler(
    THREE.MathUtils.degToRad(rotate[0] ?? 0),
    THREE.MathUtils.degToRad(rotate[1] ?? 0),
    THREE.MathUtils.degToRad(rotate[2] ?? 0),
    'ZYX',
  );
}
