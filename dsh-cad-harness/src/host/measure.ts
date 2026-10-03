// M2/M3 gap fill: two-point distance measurement with surface snapping.
//
// The LLM specifies approximate points; each is projected onto the nearest
// surface point of its part (MeshBVH closest-point query, same dependency as
// M2 clearance). Reports the exact distance, the snapped coordinates, how far
// the raw input was from the surface (guess quality), and whether each input
// point was inside the solid (face-normal sign test).

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

/** Project a point onto the nearest surface point; inside/outside via face normal. */
function snapToSurface(bvh: MeshBVH, mesh: MeshData, p: [number, number, number]): SnapResult {
  const hit = bvh.closestPointToPoint(new Vector3(p[0], p[1], p[2]))!;
  const snapped: [number, number, number] = [hit.point.x, hit.point.y, hit.point.z];

  // geometric normal of the closest triangle
  const t = hit.faceIndex! * 3;
  const ia = mesh.triVerts[t]! * 3, ib = mesh.triVerts[t + 1]! * 3, ic = mesh.triVerts[t + 2]! * 3;
  const v = (i: number) => new Vector3(mesh.vertProperties[i]!, mesh.vertProperties[i + 1]!, mesh.vertProperties[i + 2]!);
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

// ---------- closest-point pair between two solids (solver, not annotation) ----------

export interface ClosestPairResult {
  distanceMm: number;
  pointA: [number, number, number];
  pointB: [number, number, number];
}

/**
 * Minimum distance between two triangle meshes with the closest point pair.
 * Method: every vertex of A projected exactly onto B (and vice versa) — exact
 * whenever the closest pair involves a vertex (dominant case), facet-sagitta
 * bounded otherwise (≈0.03mm at $fn=64). The sphere-vs-mesh case has an exact
 * analytic branch: see closestPointsMeshVsSphere.
 */
export function closestPointsBetweenMeshes(meshA: MeshData, meshB: MeshData): ClosestPairResult {
  const bvhA = buildMeshBvh(meshA);
  const bvhB = buildMeshBvh(meshB);
  let bestD = Infinity;
  let pa: [number, number, number] = [0, 0, 0];
  let pb: [number, number, number] = [0, 0, 0];

  const scan = (verts: Float32Array, target: MeshBVH, side: 'a' | 'b') => {
    const count = verts.length / 3;
    const stride = Math.max(1, Math.ceil(count / 20000));
    for (let i = 0; i < count; i += stride) {
      const p = new Vector3(verts[i * 3]!, verts[i * 3 + 1]!, verts[i * 3 + 2]!);
      const hit = target.closestPointToPoint(p)!;
      if (hit.distance < bestD) {
        bestD = hit.distance;
        const q: [number, number, number] = [hit.point.x, hit.point.y, hit.point.z];
        if (side === 'a') { pa = [p.x, p.y, p.z]; pb = q; }
        else { pa = q; pb = [p.x, p.y, p.z]; }
      }
    }
  };
  scan(meshA.vertProperties, bvhB, 'a');
  scan(meshB.vertProperties, bvhA, 'b');
  return { distanceMm: +bestD.toFixed(4), pointA: pa, pointB: pb };
}

/**
 * Exact distance between a mesh and an analytic sphere: one BVH projection of
 * the sphere centre; the sphere-side point lies on the centre→hit direction.
 * Returns null when the sphere intersects the mesh (distance would be 0/ambiguous).
 */
export function closestPointsMeshVsSphere(
  mesh: MeshData,
  center: [number, number, number],
  radius: number,
): ClosestPairResult {
  const bvh = buildMeshBvh(mesh);
  const c = new Vector3(center[0], center[1], center[2]);
  const hit = bvh.closestPointToPoint(c)!;
  const dir = hit.point.clone().sub(c);
  const distC = dir.length();
  if (distC <= radius) return { distanceMm: 0, pointA: [hit.point.x, hit.point.y, hit.point.z], pointB: [hit.point.x, hit.point.y, hit.point.z] };
  const n = dir.clone().normalize();
  const pb: [number, number, number] = [c.x + n.x * radius, c.y + n.y * radius, c.z + n.z * radius];
  return { distanceMm: +(distC - radius).toFixed(4), pointA: [hit.point.x, hit.point.y, hit.point.z], pointB: pb };
}
