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

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import {
  boundingBox, parseStl, shellCount, writeBinaryStl, type ParsedMesh,
} from './mesh.ts';
import { weldToSolid } from './solidify.ts';
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

const round = (v: number): number => {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 ? 0 : r;
};

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

  // 1. Parse (throws with what was actually seen when the bytes are not STL).
  let parsed;
  try {
    parsed = parseStl(bytes);
  } catch (e) {
    throw new Error(`${basename(resolvedPath)}: ${(e as Error).message}`);
  }
  const { mesh: rawMesh, format } = parsed;
  if (rawMesh.triVerts.length === 0) throw new Error(`${basename(resolvedPath)}: no triangles`);

  // 2. Shells are counted on the file as delivered — welding can only merge
  //    what touches, and a multi-body file is something the caller must know.
  const shells = shellCount(rawMesh);

  // 3. Apply the declared unit/scale ONCE, before anything is measured, so
  //    every number this function returns is already in mm.
  const mesh = applyScale(rawMesh, appliedScale);

  // 4. Weld and ask Manifold whether this is a body at all.
  const result = await weldToSolid(mesh);
  const volume = result.signedVolumeMm3;
  // Inverted winding is a separate failure from "Manifold rejected it": the
  // mesh closes, but every face points inward, so a boolean with it produces the
  // complement of what was meant. It is NOT a solid for anyone's purposes, and
  // collapsing the two into one boolean here is how `solid:true` would end up on
  // a version the geometric tools then quietly misevaluate.
  const inverted = result.ok && volume < 0;
  const solid = result.ok && !inverted;

  if (!solid) {
    const reason = inverted
      ? `its faces are wound inside-out (signed volume ${round(volume)} mm³)`
      : (result.reason ?? 'Manifold rejected it');
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

  // 5. Report what welding changed, in words a human can check.
  const repaired: string[] = [];
  const droppedTris = Math.max(0, rawMesh.triVerts.length / 3 - result.diagnostics.triangles);
  const droppedVerts = Math.max(0, rawMesh.vertProperties.length / 3 - result.diagnostics.vertices);
  if (droppedVerts > 0) repaired.push(`${droppedVerts} coincident vertices merged`);
  if (droppedTris > 0) repaired.push(`${droppedTris} degenerate/unused triangles dropped`);
  if (parsed.degenerate > 0) repaired.push(`${parsed.degenerate} degenerate triangles discarded during parse`);

  const bb = boundingBox(result.mesh);
  const size: [number, number, number] = [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]];

  if (shells > 1) {
    warnings.push(
      `the file contains ${shells} separate bodies (edge-disjoint). That is legal for a solid, but if you ` +
      `expected one part, the imported geometry is not what you think it is.`,
    );
  }

  return {
    stl: writeBinaryStl(result.mesh, `imported ${basename(resolvedPath)}`),
    mesh: result.mesh,
    format: format === 'binary' ? 'stl-binary' : 'stl-ascii',
    solid,
    watertight: solid,
    repaired,
    triangles: result.diagnostics.triangles,
    shells,
    degenerate: parsed.degenerate,
    signedVolumeMm3: round(volume),
    volumeMm3: round(Math.abs(volume)),
    boundingBoxMm: {
      min: bb.min.map(round) as [number, number, number],
      max: bb.max.map(round) as [number, number, number],
      size: size.map(round) as [number, number, number],
    },
    genus: solid && result.solid ? result.solid.genus() : 0,
    unit,
    appliedScale,
    resolvedPath,
    sha256,
    bytes: bytes.length,
    warnings,
  };
}

/** Scale a mesh's vertices into a fresh buffer (never mutates the input). */
function applyScale(mesh: ParsedMesh, scale: number): ParsedMesh {
  if (scale === 1) return mesh;
  const verts = new Float32Array(mesh.vertProperties.length);
  for (let i = 0; i < verts.length; i++) verts[i] = mesh.vertProperties[i]! * scale;
  return { vertProperties: verts, triVerts: mesh.triVerts };
}
