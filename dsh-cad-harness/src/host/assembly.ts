// Assembly validation: per-part watertightness, pairwise interference volume
// (exact, via Manifold booleans) and minimum clearance.
//
// The SOLVE is Python's (DECISION-LOG 2026-10-08): `validateAssembly` is a thin
// forwarder to the worker's `validate_assembly` op. The pre-migration TS
// implementation (`validateAssemblyInTs` / `buildSolid` / `pairMinDistance`) was
// retired on 2026-11-25; the Python path is the only production one, and the
// assembly contract work already compares against it on real manifests.

import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  /**
   * Translation applied WITH `matrix` (before rotate/translate). A pose about a
   * datum axis is affine, not linear: the 3×3 alone rotates the part about the
   * ORIGIN, which is why a link pivoting at (0,0,20) reported a false 61 mm³.
   */
  matrixTranslate?: [number, number, number];
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
 * Validate an assembly. The STL bytes are written to the worker's scratch
 * directory and travel as paths (never through the pipe); the report comes back
 * in the same shape the tool has always seen.
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
