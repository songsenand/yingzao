// The one place where triangle soup becomes a solid.
//
// Why this is a module and not four lines inside assembly.ts: "is this a
// solid?" is the question every downstream answer depends on. `measure_part`,
// `validate_assembly`, `check_assembly`'s diameter operator and the whole
// simulate_* family assume a closed 2-manifold, and a mesh that is a solid for
// one caller but not for another is exactly the class of silent lie this
// harness exists to prevent. Engine imports stay in few places on purpose
// (HARNESS §12.3); this is the manifold one for "bytes → solid".
//
// Welding is `Mesh.merge()`: coincident vertices become shared, degenerate
// triangles disappear. That is the ONLY repair performed here. A mesh Manifold
// rejects is reported, never patched — a hole filled by guesswork is a
// measurement that lies, and the whole value of an imported part is that it can
// be trusted the same way a generated one is.

import ManifoldModule from 'manifold-3d';
import { isWatertight, transformMesh, type ParsedMesh } from './mesh.ts';

type ManifoldModuleT = Awaited<ReturnType<typeof ManifoldModule>>;
export type ManifoldSolid = InstanceType<ManifoldModuleT['Manifold']>;

let M: ManifoldModuleT | null = null;

/** The shared Manifold module (wasm init once per process). */
export async function manifold(): Promise<ManifoldModuleT> {
  if (!M) { M = await ManifoldModule(); M.setup(); }
  return M;
}

export interface SolidifyDiagnostics {
  /** Undirected edges that are not shared by exactly two triangles. */
  badEdges: number;
  triangles: number;
  vertices: number;
}

export interface SolidifyResult {
  ok: boolean;
  solid?: ManifoldSolid;
  /** The welded mesh Manifold actually accepted (or the best-effort one). */
  mesh: ParsedMesh;
  /** Manifold's own error status; `NoError` on success. */
  status: string;
  /** Signed volume: negative means the winding is globally inverted. */
  signedVolumeMm3: number;
  diagnostics: SolidifyDiagnostics;
  /** One actionable line when `ok` is false. */
  reason?: string;
}

/**
 * Weld a mesh and hand it to Manifold. Never throws for bad geometry — a
 * non-solid input is a *result*, because the caller has to decide whether to
 * refuse it or store it with the caveat attached.
 */
export async function weldToSolid(input: ParsedMesh): Promise<SolidifyResult> {
  const Mm = await manifold();
  const gm = new Mm.Mesh({ numProp: 3, vertProperties: input.vertProperties, triVerts: input.triVerts });
  gm.merge();
  const merged: ParsedMesh = { vertProperties: gm.vertProperties, triVerts: gm.triVerts };
  const water = isWatertight(merged);
  const diagnostics: SolidifyDiagnostics = {
    badEdges: water.edgeStats.undirectedBad,
    triangles: merged.triVerts.length / 3,
    vertices: merged.vertProperties.length / 3,
  };

  let solid: ManifoldSolid;
  try {
    solid = new Mm.Manifold(gm); // throws ManifoldError('NotManifold') on bad input
  } catch (e) {
    return {
      ok: false,
      mesh: merged,
      status: /NonFiniteVertex/.test(String(e)) ? 'NonFiniteVertex' : 'NotManifold',
      signedVolumeMm3: 0,
      diagnostics,
      reason: water.watertight
        ? `Manifold rejected the mesh despite watertight edges: ${String((e as Error).message ?? e)}`
        : `${diagnostics.badEdges} edge(s) are not shared by exactly two triangles — the surface has holes or T-junctions`,
    };
  }

  const out = solid.getMesh();
  const mesh: ParsedMesh = { vertProperties: out.vertProperties, triVerts: out.triVerts };
  const volume = solid.volume();
  const status = String(solid.status());
  if (status !== 'NoError') {
    return { ok: false, mesh, status, signedVolumeMm3: volume, diagnostics, reason: `Manifold status ${status}` };
  }
  return { ok: true, solid, mesh, status, signedVolumeMm3: volume, diagnostics };
}

/**
 * Build a transformed solid from STL bytes. Kept as the assembly/physics entry
 * point so every rig that needs a placed solid shares one code path.
 *
 * Throws on non-manifold input: those callers have no meaningful answer to give
 * for a non-solid, and silently returning an empty solid would turn "this part
 * is broken" into "these parts do not interfere".
 */
export async function buildSolidFromStl(
  stl: Uint8Array,
  transform: {
    translate?: [number, number, number];
    rotate?: [number, number, number];
    /**
     * Full 3×3 linear map applied FIRST (rightmost, before rotate/translate).
     * This is how a manifest `pose` — rotate about a datum axis — reaches the
     * solid without being folded through Euler angles.
     */
    matrix?: readonly (readonly [number, number, number])[];
  } | undefined,
  parse: (bytes: Uint8Array) => ParsedMesh,
): Promise<{ solid: ManifoldSolid; parsed: ParsedMesh }> {
  let parsed = parse(stl);
  if (transform?.matrix) parsed = transformMesh(parsed, transform.matrix, [0, 0, 0]);
  const result = await weldToSolid(parsed);
  if (!result.ok || !result.solid) throw new Error(result.reason ?? 'not a solid');
  // Inverted winding closes the surface but points every face inward, so a
  // boolean against it returns the complement of what was meant. Refuse it here
  // too: "is this a solid?" must have one answer for every caller.
  if (result.signedVolumeMm3 < 0) {
    throw new Error(`mesh faces are wound inside-out (signed volume ${result.signedVolumeMm3} mm³) — not a usable solid`);
  }
  let solid = result.solid;
  if (transform?.rotate) solid = solid.rotate(transform.rotate as never);
  if (transform?.translate) solid = solid.translate(transform.translate as never);
  // Use the transformed mesh so every downstream consumer (BVH, distance
  // sampling, bbox) shares one coordinate frame.
  const gm = solid.getMesh();
  return { solid, parsed: { vertProperties: gm.vertProperties, triVerts: gm.triVerts } };
}
