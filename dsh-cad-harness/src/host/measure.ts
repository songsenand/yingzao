// Shared mesh BVH builder.
//
// The two-point distance solver and the closest-point pair solver moved to the
// Python worker; the pre-migration TS implementations were retired on 2026-11-25.
// `buildMeshBvh` stays because `check_printability` (TS preflight) and the tool
// path use it directly.

import { BufferAttribute, BufferGeometry } from 'three';
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
