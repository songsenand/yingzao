// Assembly validation: per-part watertightness, pairwise interference volume
// (exact, via Manifold booleans) and minimum clearance (nearest-triangle queries
// over sampled vertices).
//
// TWO IMPLEMENTATIONS, ONE CONTRACT (2026-10-08, batch 1): `validateAssembly` is
// now a thin forwarder to the Python worker (`python/cad_worker/worker.py`), and
// `validateAssemblyInTs` is the previous TS implementation kept as the PARITY
// ORACLE — `scripts/accept-assembly-parity.mjs` runs both on the same inputs and
// fails if the reports differ. The oracle is not a second production path: it
// exists so "the numbers did not change" stays checkable instead of asserted.
// `buildSolid` / `pairMinDistance` below are still live for `check_assembly` and
// the union tool (batch 2).

import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BufferGeometry, BufferAttribute, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { parseBinaryStl, isWatertight, boundingBox, type ParsedMesh } from './mesh.ts';
import { buildSolidFromStl } from './solidify.ts';
import { ensurePythonWorker, workerScratchDir } from './python-worker.ts';

export interface PartTransform {
  translate?: [number, number, number];
  rotate?: [number, number, number]; // degrees, XYZ order
  /**
   * Full 3×3 linear map applied FIRST (rightmost). Carries a manifest/pose
   * rotation (rotate about a datum axis) without folding through Euler angles;
   * when present it already includes rotate∘pose, so `rotate` must be absent.
   */
  matrix?: readonly (readonly [number, number, number])[];
}

export interface AssemblyPartInput {
  name: string;
  stl: Uint8Array;
  transform?: PartTransform;
}

export interface AssemblyPairReport {
  partA: string;
  partB: string;
  intersectionVolume: number;
  minDistance: number;
  status: 'ok' | 'interference' | 'too_tight';
}

export interface AssemblyReport {
  parts: { name: string; watertight: boolean; volume: number; boundingBox: { min: [number,number,number]; max: [number,number,number] }; triangles: number }[];
  pairs: AssemblyPairReport[];
  overallStatus: 'pass' | 'fail';
  thresholdMm: number;
  /** Interference below this volume (mm³) counts as polygonal-fit residual, not a clash. */
  interferenceEpsilonMm3: number;
}

/**
 * Build a transformed Manifold solid from STL bytes; throws on non-manifold
 * input.
 *
 * The parse→weld→Manifold sequence lives in `solidify.ts` so that "is this a
 * solid?" has exactly one answer in this codebase — the import path asks the
 * same question of an external file that this path asks of a generated one.
 */
export async function buildSolid(stl: Uint8Array, transform: PartTransform | undefined) {
  return buildSolidFromStl(stl, transform, parseBinaryStl);
}

/** Point→triangle distance over sampled vertices of A against B's BVH. */
function minDistanceViaBVH(meshA: ParsedMesh, bvhB: MeshBVH, maxSamples = 1200): number {
  const triCount = meshA.triVerts.length / 3;
  const step = Math.max(1, Math.floor(triCount / maxSamples));
  let best = Infinity;
  for (let t = 0; t < triCount; t += step) {
    for (const vi of [meshA.triVerts[t * 3]!, meshA.triVerts[t * 3 + 1]!, meshA.triVerts[t * 3 + 2]!]) {
      const point = new Vector3(
        meshA.vertProperties[vi * 3]!,
        meshA.vertProperties[vi * 3 + 1]!,
        meshA.vertProperties[vi * 3 + 2]!,
      );
      const hit = bvhB.closestPointToPoint(point);
      if (hit && hit.distance < best) best = hit.distance;
      if (best === 0) return 0;
    }
  }
  return best === Infinity ? NaN : best;
}

/**
 * Exact-ish minimum surface distance between two transformed solids (both
 * directions, same sampling as the pairwise report). 0 is reported only when
 * solids actually intersect — callers check interference separately.
 */
export async function pairMinDistance(
  a: { solid: Awaited<ReturnType<typeof buildSolid>>['solid']; parsed: ParsedMesh },
  b: { solid: Awaited<ReturnType<typeof buildSolid>>['solid']; parsed: ParsedMesh },
): Promise<number> {
  const bvhB = new MeshBVH((() => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(b.parsed.vertProperties, 3));
    g.setIndex(new BufferAttribute(b.parsed.triVerts, 1));
    return g;
  })());
  const bvhA = new MeshBVH((() => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(a.parsed.vertProperties, 3));
    g.setIndex(new BufferAttribute(a.parsed.triVerts, 1));
    return g;
  })());
  return Math.min(
    minDistanceViaBVH(a.parsed, bvhB),
    minDistanceViaBVH(b.parsed, bvhA),
  );
}

/**
 * Validate an assembly. The SOLVE is Python's (batch 1, DECISION-LOG 2026-10-08):
 * the STL bytes are written to the worker's scratch directory and travel as paths
 * (never through the pipe), and the report comes back in the same shape as before.
 * Kept async and byte-oriented so every existing caller — the tool, the import
 * acceptance, the M2 acceptance — keeps working unchanged.
 */
export async function validateAssembly(
  parts: AssemblyPartInput[],
  thresholdMm = 0.75,
  interferenceEpsilonMm3 = 1e-3,
): Promise<AssemblyReport> {
  const scratch = await workerScratchDir();
  const written: string[] = [];
  const payload: { name: string; path: string; transform?: PartTransform }[] = [];
  for (const part of parts) {
    const path = join(scratch, `assembly-${randomUUID()}.stl`);
    await writeFile(path, part.stl);
    written.push(path);
    payload.push({ name: part.name, path, transform: part.transform });
  }
  try {
    const worker = await ensurePythonWorker();
    return await worker.request<AssemblyReport>('validate_assembly', { parts: payload, thresholdMm, interferenceEpsilonMm3 });
  } finally {
    await Promise.all(written.map((path) => rm(path, { force: true }).catch(() => {})));
  }
}

/**
 * Validate an assembly: watertight per part, then pairwise interference
 * volume (Manifold intersect) and minimum clearance (BVH).
 *
 * PARITY ORACLE — see the file header. Do not wire new callers to this.
 */
export async function validateAssemblyInTs(
  parts: AssemblyPartInput[],
  thresholdMm = 0.75,
  interferenceEpsilonMm3 = 1e-3,
): Promise<AssemblyReport> {
  const built: { name: string; solid: Awaited<ReturnType<typeof buildSolid>>['solid']; parsed: ParsedMesh; bvh: MeshBVH }[] = [];
  const partReports: AssemblyReport['parts'] = [];

  for (const part of parts) {
    const { solid, parsed } = await buildSolid(part.stl, part.transform);
    const watertight = isWatertight(parsed).watertight && solid.status() === 'NoError';
    // BVH over the transformed mesh: bake transform into a geometry copy.
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(solid.getMesh().vertProperties, 3));
    geometry.setIndex(new BufferAttribute(solid.getMesh().triVerts, 1));
    const bvh = new MeshBVH(geometry);
    built.push({ name: part.name, solid, parsed, bvh });
    partReports.push({
      name: part.name,
      watertight,
      volume: solid.volume(),
      boundingBox: solid.boundingBox(),
      triangles: parsed.triVerts.length / 3,
    });
  }

  const pairs: AssemblyPairReport[] = [];
  let fail = false;
  for (let i = 0; i < built.length; i++) {
    for (let j = i + 1; j < built.length; j++) {
      const A = built[i]!, B = built[j]!;
      const inter = A.solid.intersect(B.solid);
      const interVol = inter.isEmpty() ? 0 : Math.max(0, inter.volume());
      // Sub-epsilon interference is discretisation, not design: microscope3's
      // M40×1.5 printed thread reported 0.36mm³ (<1µm deep) forever, drowning
      // the real findings. Still reported, but as 'ok' with the volume visible.
      if (interVol > interferenceEpsilonMm3) {
        pairs.push({ partA: A.name, partB: B.name, intersectionVolume: interVol, minDistance: 0, status: 'interference' });
        fail = true;
        continue;
      }
      if (interVol > 1e-9) {
        // residual: touching/overlapping by a whisper — keep it visible, not failing
        pairs.push({ partA: A.name, partB: B.name, intersectionVolume: interVol, minDistance: 0, status: 'ok' });
        continue;
      }
      const dist = Math.min(
        minDistanceViaBVH(A.parsed, B.bvh),
        minDistanceViaBVH(B.parsed, A.bvh),
      );
      const status: AssemblyPairReport['status'] = dist < thresholdMm ? 'too_tight' : 'ok';
      pairs.push({ partA: A.name, partB: B.name, intersectionVolume: 0, minDistance: dist, status });
      if (status !== 'ok') fail = true;
    }
  }

  return {
    parts: partReports,
    pairs,
    overallStatus: fail ? 'fail' : 'pass',
    thresholdMm,
    interferenceEpsilonMm3,
  };
}
