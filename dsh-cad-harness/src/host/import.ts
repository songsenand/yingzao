// Import external geometry as a project part.
//
// WHY THIS EXISTS. Every tool in this harness takes a `versionId` and reads
// `versions/vNNN/model.stl`. `generate_part` was the only way to create a
// version, and it only accepts SCAD source — so the version store was, in
// practice, a source-code store, and geometry that came from anywhere else had
// no way in. That is what made "one person designs a part, another uses it"
// impossible, and it was mis-filed in HARNESS §7 as part of the STEP (B-rep)
// gap. It is not: STL *is* a mesh, and the whole truth engine here is mesh-based
// (Manifold booleans, BVH nearest-distance, rapier, MPM, the measure family).
// Reading an STL was never the missing piece — `mesh.ts` has parsed them for
// months and `renderVersionFrame` already renders through `import()`. Landing it
// as a *version* is the missing piece.
//
// Three consequences shape the code below:
//
// 1. IMPORT IS VERIFICATION, NOT TRANSPORT. The file's bytes are not the truth;
//    the mesh Manifold accepts is. So an import runs the same truth engine and
//    reports watertightness, volume, genus, shell count and degeneracy — and
//    REFUSES a mesh that is not a closed solid, because storing one would make
//    every downstream tool produce confident numbers about a shape that is not
//    a real body. `allowNonSolid` exists for looking at broken geometry, and it
//    marks the version so downstream tools can say what they are looking at.
//
// 2. UNITS ARE A DECLARATION, NEVER AN INFERENCE. STL carries no unit. The
//    caller states one (or an explicit scale); it is applied once, before any
//    measurement, and recorded verbatim so a human can audit it. Guessing is how
//    a part silently ships 25.4x too big.
//
// 3. THE VERSION IS THE INTERFACE. The output of this module is exactly what
//    `saveVersion` already stores — bytes + stats + provenance — so measure_*,
//    render_part, validate_assembly, check_assembly and the simulate_* family
//    need no knowledge that the geometry came from outside.

import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { parseBinaryStl, type ParsedMesh } from './mesh.ts';
import { ensurePythonWorker, workerScratchDir } from './python-worker.ts';
import type { DatumSet, DatumPoint, DatumAxis, DatumPlane, DatumCylinder } from './compile.ts';

// ---------- units ----------

export type Unit = 'mm' | 'cm' | 'm' | 'inch';

const UNIT_TO_MM: Record<Unit, number> = { mm: 1, cm: 10, m: 1000, inch: 25.4 };

export function unitToMm(unit: Unit): number {
  return UNIT_TO_MM[unit] ?? 1;
}

// ---------- format policy ----------

/** Formats this build can actually read. */
export const SUPPORTED_EXTENSIONS = ['.stl'] as const;

/** Formats that need a B-rep kernel this build does not ship. */
const BREP_EXTENSIONS = ['.step', '.stp', '.iges', '.igs', '.brep'];

/**
 * What to tell a caller who handed us a B-rep file.
 *
 * The point is that "unsupported" is not a dead end: it names the fact (this
 * harness tessellates; it has no B-rep kernel), the planned route, and the
 * thing the person can do in the next two minutes. A silent "parse failed"
 * here would be worse than useless — it would look like a bug in their file.
 */
export function kernelBoundaryMessage(file: string): string {
  return (
    `"${basename(file)}" is a B-rep format (STEP/IGES) and this harness has no B-rep kernel. ` +
    `Its truth engine is mesh-based by design — Manifold booleans, BVH distances, rapier, MPM — and ` +
    `neither OpenSCAD 2021.01 nor the bundled snapshot ships a step importer (verified via --export-format). ` +
    `Two ways forward: (a) right now, export STL from your CAD tool (FreeCAD: File → Export → STL) and import that — ` +
    `the mesh is what every tool here measures anyway; (b) the planned route is a tessellating kernel ` +
    `(replicad + OpenCASCADE wasm), which would also bring STEP export and exact hole/axis datums extracted ` +
    `from the B-rep. Note the trade honestly: STEP→mesh is standard tessellation, not reverse engineering, ` +
    `but it is lossy — accuracy is bounded by the chosen deflection.`
  );
}

/** Extension-based dispatch, with messages that distinguish "planned" from "unknown". */
function checkFormat(file: string): void {
  const ext = extname(file).toLowerCase();
  if (BREP_EXTENSIONS.includes(ext)) throw new Error(kernelBoundaryMessage(file));
  if (ext === '' || (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) return;
  throw new Error(
    `cannot import "${ext}" files. Supported today: ${SUPPORTED_EXTENSIONS.join(', ')} (binary and ASCII). ` +
    `3MF/OBJ/OFF import needs no new kernel and is a planned increment; ` +
    `${BREP_EXTENSIONS.join('/')} need a B-rep kernel (see import_part notes).`,
  );
}

/** A part name a human would recognise, from the file name. */
export function deriveNameFromFile(file: string): string {
  const stem = basename(file).replace(/\.[^.]+$/, '');
  const cleaned = stem.replace(/[_-]+/g, ' ').trim();
  return (cleaned || stem || '导入零件').slice(0, 24);
}

// ---------- datums ----------

export interface DatumInput {
  name: string;
  kind: 'point' | 'axis' | 'plane' | 'cylinder';
  point: [number, number, number];
  /** axis/cylinder direction. */
  dir?: [number, number, number];
  /** plane normal. */
  normal?: [number, number, number];
  /** cylinder radius (mm, in the stored frame). */
  radius?: number;
}

function vec3(value: unknown, what: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new Error(`${what} must be three finite numbers, got ${JSON.stringify(value)}`);
  }
  return [value[0], value[1], value[2]] as [number, number, number];
}

/**
 * Turn declared datums into the canonical DatumSet.
 *
 * This is the step that makes an imported part a *participant* in assembly:
 * `check_assembly` addresses interfaces as "<partId>.<datumName>", so a mesh
 * with no datums cannot be an endpoint of anything. Generated parts declare
 * theirs in SCAD; imported parts have no source, so the declaration arrives as
 * an argument instead — same file format, same operators, same rules.
 *
 * Coordinates are in the stored frame (after unit/scale), matching what the
 * manifest's transforms are applied to.
 */
export function normalizeDatums(input: readonly DatumInput[] | undefined): DatumSet | null {
  if (!input || input.length === 0) return null;
  const set: DatumSet = { points: [], axes: [], planes: [], cylinders: [] };
  const seen = new Set<string>();
  for (const d of input) {
    const name = String(d?.name ?? '').trim();
    if (!name) throw new Error('every datum needs a non-empty name');
    if (seen.has(name)) throw new Error(`duplicate datum name "${name}"`);
    seen.add(name);
    const point = vec3(d.point, `datum "${name}" point`);
    switch (d.kind) {
      case 'point':
        (set.points as DatumPoint[]).push({ name, point });
        break;
      case 'axis':
        (set.axes as DatumAxis[]).push({ name, point, dir: vec3(d.dir, `datum "${name}" dir`) });
        break;
      case 'plane':
        (set.planes as DatumPlane[]).push({ name, point, normal: vec3(d.normal, `datum "${name}" normal`) });
        break;
      case 'cylinder': {
        const radius = Number(d.radius);
        if (!Number.isFinite(radius) || radius <= 0) throw new Error(`datum "${name}" needs a positive radius`);
        (set.cylinders as DatumCylinder[]).push({ name, point, dir: vec3(d.dir, `datum "${name}" dir`), radius });
        break;
      }
      default:
        throw new Error(`datum "${name}" has unknown kind "${String(d.kind)}" (point|axis|plane|cylinder)`);
    }
  }
  return set;
}

// ---------- the import itself ----------

export interface ImportRequest {
  /** As given by the caller: relative paths resolve against `cwd`. */
  file: string;
  /** The project directory (the calling session's cwd). */
  cwd: string;
  unit?: Unit;
  scale?: number;
  allowNonSolid?: boolean;
}

/** Payload of the worker's `import_mesh` op (see python/cad_worker/worker.py). */
interface ImportSolve {
  format: string;
  solid: boolean;
  inverted: boolean;
  signedVolumeMm3: number;
  volumeMm3: number;
  triangles: number;
  vertices: number;
  rawTriangles: number;
  rawVertices: number;
  shells: number;
  degenerate: number;
  badEdges: number;
  genus: number;
  reason: string | null;
  bbox: { min: number[]; max: number[]; size: number[] };
  appliedScale: number;
  outBytes: number;
}

export interface ImportedGeometry {
  /** Welded, unit-scaled, ready for `saveVersion`. */
  stl: Uint8Array;
  mesh: ParsedMesh;
  /** 'stl-binary' | 'stl-ascii'. */
  format: string;
  /** False = stored only because `allowNonSolid` was set. */
  solid: boolean;
  watertight: boolean;
  /** Human-readable list of what welding changed. */
  repaired: string[];
  triangles: number;
  shells: number;
  degenerate: number;
  /** Signed volume: negative would mean globally inverted winding. */
  signedVolumeMm3: number;
  volumeMm3: number;
  boundingBoxMm: { min: [number, number, number]; max: [number, number, number]; size: [number, number, number] };
  /** Genus of the solid (= through-hole count for simple parts); 0 when not a solid. */
  genus: number;
  unit: Unit;
  /** The multiplier actually applied (unit factor × declared scale). */
  appliedScale: number;
  /** Absolute path the bytes were read from. */
  resolvedPath: string;
  sha256: string;
  bytes: number;
  warnings: string[];
}

/**
 * Read one external file and turn it into geometry the version store can hold.
 *
 * Throws — with an actionable message — when the file cannot be read, is a
 * format without a kernel, or is not a closed solid and the caller did not
 * explicitly accept that.
 */
export async function importGeometry(req: ImportRequest): Promise<ImportedGeometry> {
  const warnings: string[] = [];
  const raw = String(req?.file ?? '').trim();
  if (!raw) throw new Error('import needs a file path');
  const resolvedPath = isAbsolute(raw) ? raw : resolve(req.cwd, raw);
  checkFormat(resolvedPath);

  let info;
  try {
    info = await stat(resolvedPath);
  } catch {
    throw new Error(
      `no such file: ${resolvedPath}` +
      (isAbsolute(raw) ? '' : ` (relative paths resolve against the project directory ${req.cwd})`),
    );
  }
  if (!info.isFile()) throw new Error(`not a file: ${resolvedPath}`);

  const bytes = new Uint8Array(await readFile(resolvedPath));
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const unit: Unit = req.unit ?? 'mm';
  if (!(unit in UNIT_TO_MM)) throw new Error(`unknown unit "${String(req.unit)}" (mm|cm|m|inch)`);
  const declared = req.scale ?? 1;
  if (!Number.isFinite(declared) || declared <= 0) throw new Error(`scale must be a positive number, got ${String(req.scale)}`);
  const appliedScale = unitToMm(unit) * declared;

  // 1–5. Parse, count shells, apply the declared scale, weld and ask Manifold
  //      whether this is a body at all — all of that is Python's (batch 2). The
  //      worker WRITES the welded, scaled mesh; that file is what the store holds,
  //      so the picture and the version can never disagree.
  const scratch = await workerScratchDir();
  const weldedPath = join(scratch, `import-${randomUUID()}.stl`);
  let solved: ImportSolve;
  try {
    solved = await (await ensurePythonWorker()).request<ImportSolve>('import_mesh', {
      path: resolvedPath,
      scale: appliedScale,
      out: weldedPath,
    });
  } catch (e) {
    const message = String((e as Error).message ?? e)
      .replace(/^[a-z_]+ failed: /, '')
      .replace(/^ValueError: /, '');
    throw new Error(`${basename(resolvedPath)}: ${message}`);
  }
  const stl = new Uint8Array(await readFile(weldedPath));
  await rm(weldedPath, { force: true }).catch(() => {});
  const mesh = parseBinaryStl(stl);

  const volume = solved.signedVolumeMm3;
  const solid = solved.solid;
  if (!solid) {
    const reason = solved.inverted
      ? `its faces are wound inside-out (signed volume ${volume} mm³)`
      : (solved.reason ?? 'Manifold rejected it');
    if (!req.allowNonSolid) {
      throw new Error(
        `${basename(resolvedPath)} is not a closed solid: ${reason}. ` +
        `Nothing was imported — measure_part, validate_assembly and the simulate_* tools would each report ` +
        `confident numbers about a shape that is not a real body. ` +
        `Fix the mesh (close the holes / re-export as a solid) and import again, or pass ` +
        `allowNonSolid:true to store it as a reference-only version that the geometric tools will refuse.`,
      );
    }
    warnings.push(`NOT A SOLID (${reason}) — stored because allowNonSolid was set; the geometric tools will refuse this version.`);
  }

  // Report what welding changed, in words a human can check.
  const repaired: string[] = [];
  const droppedTris = Math.max(0, solved.rawTriangles - solved.triangles);
  const droppedVerts = Math.max(0, solved.rawVertices - solved.vertices);
  if (droppedVerts > 0) repaired.push(`${droppedVerts} coincident vertices merged`);
  if (droppedTris > 0) repaired.push(`${droppedTris} degenerate/unused triangles dropped`);
  // The TS parser counted these and then dropped the count on the way out
  // (`parseStl` returned `degenerate: 0`), so this line never fired. The worker
  // reports the real number: a file with degenerate facets now says so.
  if (solved.degenerate > 0) repaired.push(`${solved.degenerate} degenerate triangles discarded during parse`);

  if (solved.shells > 1) {
    warnings.push(
      `the file contains ${solved.shells} separate bodies (edge-disjoint). That is legal for a solid, but if you ` +
      `expected one part, the imported geometry is not what you think it is.`,
    );
  }

  return {
    stl,
    mesh,
    format: solved.format,
    solid,
    watertight: solid,
    repaired,
    triangles: solved.triangles,
    shells: solved.shells,
    degenerate: solved.degenerate,
    signedVolumeMm3: solved.signedVolumeMm3,
    volumeMm3: solved.volumeMm3,
    boundingBoxMm: {
      min: solved.bbox.min as [number, number, number],
      max: solved.bbox.max as [number, number, number],
      size: solved.bbox.size as [number, number, number],
    },
    genus: solved.genus,
    unit,
    appliedScale,
    resolvedPath,
    sha256,
    bytes: bytes.length,
    warnings,
  };
}


