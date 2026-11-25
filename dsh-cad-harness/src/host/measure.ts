// M2/M3 gap fill: two-point distance measurement with surface snapping.
//
// The LLM specifies approximate points; each is projected onto the nearest
// surface point of its part (MeshBVH closest-point query, same dependency as
// M2 clearance). Reports the exact distance, the snapped coordinates, how far
// the raw input was from the surface (guess quality), and whether each input
// point was inside the solid (face-normal sign test).
//
// `measureDistance` and `buildMeshBvh` are live for measure_distance / printability.
// The closest-point pair solver moved to the Python worker; its TS oracle was retired
// on 2026-11-25 (see DECISION-LOG), because the worker path is the only production one.

import { BufferAttribute, BufferGeometry, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';

export interface MeshData {
  vertProperties: Float32Array;
  triVerts: Uint32Array;
}

export function buildMeshBvh(mesh: MeshData): MeshBVH {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(mesh.vertProperties, 3));
  geometry.setIndex(new BufferAttribute(mesh.triVerts, 1));
  return new MeshBVH(geometry);
}

export interface SnapResult {
  snapped: [number, number, number];
  snapDistanceMm: number;
  outside: boolean;
}

/**
 * Project a point onto the nearest surface point; inside/outside via face normal.
 *
 * The face normal is resolved through the BVH's OWN index/position arrays, never
 * through the caller's `mesh`. `MeshBVH` reorders the index buffer it is handed, in
 * place, so `faceIndex` only addresses the intended triangle if the array you look it
 * up in is the one the BVH reordered. Today `buildMeshBvh(mesh)` aliases the caller's
 * `triVerts`, so both views agree by accident — but the moment a caller passes a copy
 * (`checkPrintabilityInTs` does, to pin its sampling order) `faceIndex` silently
 * resolves to a DIFFERENT triangle. Measured on a 20mm cube with a copied index, two
 * of four outside-probes flipped to "inside".
 */
function snapToSurface(bvh: MeshBVH, mesh: MeshData, p: [number, number, number]): SnapResult {
  const hit = bvh.closestPointToPoint(new Vector3(p[0], p[1], p[2]))!;
  const snapped: [number, number, number] = [hit.point.x, hit.point.y, hit.point.z];

  // geometric normal of the closest triangle, in the BVH's own ordering
  const index = bvh.geometry.getIndex()!.array as ArrayLike<number>;
  const position = bvh.geometry.getAttribute('position').array as ArrayLike<number>;
  const t = hit.faceIndex! * 3;
  const ia = index[t]! * 3, ib = index[t + 1]! * 3, ic = index[t + 2]! * 3;
  const v = (i: number) => new Vector3(position[i]!, position[i + 1]!, position[i + 2]!);
  const va = v(ia), vb = v(ib), vc = v(ic);
  const n = vb.sub(va).clone().cross(vc.clone().sub(va)).normalize();

  const toP = new Vector3(p[0] - snapped[0], p[1] - snapped[1], p[2] - snapped[2]);
  const outside = toP.dot(n) > 0;

  return { snapped, snapDistanceMm: hit.distance, outside };
}

export interface MeasureDistanceResult {
  distanceMm: number;
  dxMm: number;
  dyMm: number;
  dzMm: number;
  aSnapped: [number, number, number];
  bSnapped: [number, number, number];
  aSnapDistanceMm: number;
  bSnapDistanceMm: number;
  aOutside: boolean;
  bOutside: boolean;
}

/**
 * Measure the distance between two points, optionally snapped to the part
 * surfaces. `meshB === null` measures two points on the same part.
 */
export function measureDistance(
  meshA: MeshData,
  meshB: MeshData | null,
  a: [number, number, number],
  b: [number, number, number],
  snap: boolean | { snapA?: boolean; snapB?: boolean } = true,
): MeasureDistanceResult {
  const bvhA = buildMeshBvh(meshA);
  const bvhB = meshB ? buildMeshBvh(meshB) : bvhA;

  const doSnapA = typeof snap === 'object' ? snap.snapA ?? true : snap;
  const doSnapB = typeof snap === 'object' ? snap.snapB ?? true : snap;
  const snapA = doSnapA ? snapToSurface(bvhA, meshA, a) : { snapped: a, snapDistanceMm: 0, outside: false };
  const snapB = doSnapB ? snapToSurface(bvhB, meshB ?? meshA, b) : { snapped: b, snapDistanceMm: 0, outside: false };

  const pa: [number, number, number] = snapA.snapped;
  const pb: [number, number, number] = snapB.snapped;
  const dx = pb[0] - pa[0], dy = pb[1] - pa[1], dz = pb[2] - pa[2];

  return {
    distanceMm: +Math.hypot(dx, dy, dz).toFixed(4),
    dxMm: +dx.toFixed(4),
    dyMm: +dy.toFixed(4),
    dzMm: +dz.toFixed(4),
    aSnapped: snapA.snapped,
    bSnapped: snapB.snapped,
    aSnapDistanceMm: +snapA.snapDistanceMm.toFixed(4),
    bSnapDistanceMm: +snapB.snapDistanceMm.toFixed(4),
    aOutside: snapA.outside,
    bOutside: snapB.outside,
  };
}

