// Import external geometry as a project part.
//
// WHY THIS EXISTS. Every tool in this harness takes a `versionId` and reads
// `versions/vNNN/model.stl`. `generate_part` was the only way to create a
// version, and it only accepts SCAD source — so the version store was, in
// practice, a source-code store, and geometry that came from anywhere else had
// no way in. That is what made "one person designs a part, another uses it"
// impossible, and it was mis-filed in DECISION-LOG 2026-10-01（补记）as part of the STEP (B-rep)
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
import { PREVIEWABLE_EXTENSIONS, resolveWorkspaceFile } from './unregistered.ts';
import type { DatumSet, DatumPoint, DatumAxis, DatumPlane, DatumCylinder } from './compile.ts';

// ---------- units ----------

export type Unit = 'mm' | 'cm' | 'm' | 'inch';

const UNIT_TO_MM: Record<Unit, number> = { mm: 1, cm: 10, m: 1000, inch: 25.4 };

export function unitToMm(unit: Unit): number {
  return UNIT_TO_MM[unit] ?? 1;
}

// ---------- format policy ----------

/** Formats this build can actually read. STEP via cascadio/OpenCASCADE (worker),
 *  3MF via trimesh+lxml (worker), DXF via ezdxf (worker): profiles extruded by
 *  depthMm, or 3D mesh entities. */
export const SUPPORTED_EXTENSIONS = ['.stl', '.step', '.stp', '.3mf', '.dxf'] as const;

/** Formats no shipped reader can parse. IGES: cascadio fails silently on it
 *  (probed 2026-10-15), and no other reader is bundled. */
const BREP_EXTENSIONS = ['.iges', '.igs', '.brep'];

/**
 * What to tell a caller who handed us a file no shipped reader can parse.
 *
 * The point is that "unsupported" is not a dead end: it names the fact (verified,
 * not guessed), the planned route, and the thing the person can do in the next
 * two minutes. A silent "parse failed" here would be worse than useless — it
 * would look like a bug in their file.
 */
export function kernelBoundaryMessage(file: string): string {
  return (
    `"${basename(file)}" is an IGES (or BREP) file and this harness cannot read IGES yet. ` +
    `The OpenCASCADE bridge used for STEP (cascadio) does not parse IGES — verified 2026-10-15: ` +
    `it fails silently, writing no output. ` +
    `Two ways forward: (a) right now, re-export as STEP (.step/.stp — imported here through OpenCASCADE) ` +
    `or STL (FreeCAD: File → Export) and import that — the mesh is what every tool here measures anyway; ` +
    `(b) the planned route for IGES is the kernel evaluation already tracked in DESIGN.md ` +
    `(FreeCAD headless → cadquery-ocp → replicad).`
  );
}

/** Extension-based dispatch, with messages that distinguish "planned" from "unknown". */
function checkFormat(file: string): void {
  const ext = extname(file).toLowerCase();
  if (BREP_EXTENSIONS.includes(ext)) throw new Error(kernelBoundaryMessage(file));
  if (ext === '' || (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) return;
  throw new Error(
    `cannot import "${ext}" files. Supported today: ${SUPPORTED_EXTENSIONS.join(', ')} ` +
    `(STEP through OpenCASCADE; 3MF through trimesh; DXF 2D profiles need depthMm to become a solid). ` +
    `OBJ/OFF import needs no new kernel and is a planned increment; ` +
    `${BREP_EXTENSIONS.join('/')} have no reader yet (see import_part notes).`,
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

const mag3 = (v: readonly number[]) => Math.hypot(v[0], v[1], v[2]);

/**
 * G2 (2026-10-29): a direction that is exactly zero is ALWAYS wrong — an axis
 * with no direction can never be an assembly endpoint (assembly-check refuses
 * point datums for coaxial for the same reason), so it is refused here at
 * declaration time instead of surfacing later as a silently unusable anchor.
 */
function rejectZeroDirection(name: string, kind: 'axis' | 'plane' | 'cylinder', dir: readonly number[]): void {
  if (mag3(dir) === 0) {
    throw new Error(
      `datum "${name}" (${kind}) direction is [0, 0, 0] — an axis with no direction can never be an assembly ` +
        `endpoint. Declare a non-zero direction (signature: ${kind === 'plane' ? 'normal' : 'dir'} = [dx, dy, dz]).`,
    );
  }
}

/**
 * G2 (2026-10-29): the positional p/dir swap (`datum_axis("rail", [0,0,1], [10,0,205])`)
 * is silent in OpenSCAD, and the swapped numbers land in datums.json where `coaxial`
 * reads them without complaint (roberval-balance: v048 bottom_axis was point=[0,1,0]
 * dir=[0,0,140]; four parts needed set_datums repair). The swap puts the SHORT true
 * direction into `point` and the LONG position into `dir`, so a direction that dwarfs
 * its own point is the signature. A WARNING, never an error — model scale cannot
 * disambiguate (a swapped [0,0,140] looks exactly like a legit endpoint-form dir in a
 * 205 mm model), and a missed swap (silent datums corruption) costs more than a
 * spurious warning, so this is allowed to over-trigger.
 */
export function datumDirectionWarnings(set: DatumSet): string[] {
  const out: string[] = [];
  const check = (kind: string, name: string, point: readonly number[], dir: readonly number[]) => {
    const mag = mag3(dir);
    const ptMag = mag3(point);
    if (mag > 4.0 * ptMag + 10.0) {
      out.push(
        `datum_${kind} "${name}": |dir|=${mag.toPrecision(6)} dwarfs its point (|p|=${ptMag.toPrecision(6)}) ` +
          '— this looks like swapped p/dir arguments (signature: ' +
          `datum_${kind}(name, point, dir), the direction is a short vector). ` +
          'If the magnitude is intentional (endpoint form), ignore this warning.',
      );
    }
  };
  for (const d of set.axes) check('axis', d.name, d.point, d.dir);
  for (const d of set.planes) check('plane', d.name, d.point, d.normal);
  for (const d of set.cylinders) check('cylinder', d.name, d.point, d.dir);
  return out;
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
        rejectZeroDirection(name, 'axis', vec3(d.dir, `datum "${name}" dir`));
        (set.axes as DatumAxis[]).push({ name, point, dir: vec3(d.dir, `datum "${name}" dir`) });
        break;
      case 'plane':
        rejectZeroDirection(name, 'plane', vec3(d.normal, `datum "${name}" normal`));
        (set.planes as DatumPlane[]).push({ name, point, normal: vec3(d.normal, `datum "${name}" normal`) });
        break;
      case 'cylinder': {
        const radius = Number(d.radius);
        if (!Number.isFinite(radius) || radius <= 0) throw new Error(`datum "${name}" needs a positive radius`);
        rejectZeroDirection(name, 'cylinder', vec3(d.dir, `datum "${name}" dir`));
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
  /** Extrusion depth in mm for DXF 2D closed profiles. Required when a DXF has
   *  no 3D mesh entities; ignored otherwise. */
  depthMm?: number;
  /**
   * Tessellation tolerances for STEP/3MF (forwarded to `import_mesh`; ignored for STL/DXF).
   * DESIGN §28.2 claimed these were pass-through while nothing exposed them — a doc claim
   * with no caller is a capability gap, not a stale sentence (2026-10-23 audit, D14).
   */
  tolLinear?: number;
  tolAngular?: number;
  allowNonSolid?: boolean;
  /**
   * PREVIEW, not a version: return the mesh even when a storage policy would
   * refuse it. A broken mesh and a plate of objects are exactly what a human
   * needs to SEE before deciding to import, and neither becomes evidence here —
   * so the refusal rules that protect the corpus (closed solid, one object)
   * are suspended. The returned `solid`/`shells` still tell the truth.
   */
  preview?: boolean;
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
  warnings?: string[];
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
  const ext = extname(resolvedPath).toLowerCase();
  // STEP and 3MF carry their own units: OpenCASCADE normalizes STEP and the
  // worker folds the metres→mm step into appliedScale; a 3MF declares `unit` in
  // its model XML and the worker folds that too. A caller-declared unit would
  // double-apply, so it is refused rather than silently ignored.
  if ((ext === '.step' || ext === '.stp' || ext === '.3mf') && unit !== 'mm') {
    const format = ext === '.3mf' ? '3MF' : 'STEP';
    throw new Error(
      `"${basename(resolvedPath)}": ${format} carries its own units — the import lands in mm without a unit ` +
      `argument. Drop unit (use scale if the size still needs correcting) or export STL and declare the unit there.`,
    );
  }
  if (req.depthMm !== undefined && (!Number.isFinite(req.depthMm) || req.depthMm <= 0)) {
    throw new Error(`depthMm must be a positive number of millimetres, got ${String(req.depthMm)}`);
  }
  if (req.depthMm !== undefined && ext !== '.dxf') {
    warnings.push('depthMm applies to DXF only; it was ignored for this format.');
  }
  const declared = req.scale ?? 1;
  if (!Number.isFinite(declared) || declared <= 0) throw new Error(`scale must be a positive number, got ${String(req.scale)}`);
  const appliedScale = unitToMm(unit) * declared;

  // 1–5. Parse, count shells, apply the declared scale, weld and ask Manifold
  //      whether this is a body at all. The worker WRITES the welded, scaled
  //      mesh; that file is what the store holds, so the picture and the version
  //      can never disagree.
  const scratch = await workerScratchDir();
  const weldedPath = join(scratch, `import-${randomUUID()}.stl`);
  let solved: ImportSolve;
  try {
    solved = await (await ensurePythonWorker()).request<ImportSolve>('import_mesh', {
      path: resolvedPath,
      scale: appliedScale,
      depthMm: req.depthMm,
      ...(req.tolLinear !== undefined ? { tolLinear: req.tolLinear } : {}),
      ...(req.tolAngular !== undefined ? { tolAngular: req.tolAngular } : {}),
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
  // Format-specific facts from the worker (STEP unit normalization, DXF $INSUNITS,
  // recovered-file errors) travel with the same result as the geometry facts.
  warnings.push(...(solved.warnings ?? []));

  const volume = solved.signedVolumeMm3;
  const solid = solved.solid;
  if (!solid) {
    const reason = solved.inverted
      ? `its faces are wound inside-out (signed volume ${volume} mm³)`
      : (solved.reason ?? 'Manifold rejected it');
    if (!req.allowNonSolid && !req.preview) {
      throw new Error(
        `${basename(resolvedPath)} is not a closed solid: ${reason}. ` +
        `Nothing was imported — measure_part, validate_assembly and the simulate_* tools would each report ` +
        `confident numbers about a shape that is not a real body. ` +
        `Fix the mesh (close the holes / re-export as a solid) and import again, or pass ` +
        `allowNonSolid:true to store it as a reference-only version that the geometric tools will refuse.`,
      );
    }
    warnings.push(req.preview
      ? `NOT A SOLID (${reason}) — preview only; importing it as a version would need allowNonSolid.`
      : `NOT A SOLID (${reason}) — stored because allowNonSolid was set; the geometric tools will refuse this version.`);
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
    // A 3MF is a CONTAINER of objects (a print plate is the normal case), so
    // "several bodies" there is not an authoring artifact to warn about — it is
    // a different thing than the caller asked for. The harness's rule is one
    // part = one connected solid, so refuse instead of storing a plate as a part.
    // STL/STEP keep the warning: a multi-shell mesh there is often one part whose
    // authoring left the shells disjoint, and refusing would break those files.
    if (ext === '.3mf' && !req.preview) {
      throw new Error(
        `${basename(resolvedPath)}: the 3MF contains ${solved.shells} separate bodies. ` +
        `This harness imports one connected part at a time — a 3MF is a container of objects (a print plate, ` +
        `an assembly), not a part. Export a single object from your slicer and import that; if you really need ` +
        `several bodies in one file, export STL instead (STL multi-body is stored with a warning).`,
      );
    }
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
    appliedScale: solved.appliedScale,
    resolvedPath,
    sha256,
    bytes: bytes.length,
    warnings,
  };
}

/** What the panel's 未登记 preview needs: a mesh plus the facts to label it. */
export interface PreviewGeometry {
  /** Welded STL bytes for the viewport; nothing is stored. */
  stl: Uint8Array;
  format: string;
  /** True when the numbers are known to be mm (STEP/3MF normalize in the worker);
   *  an STL's numbers are whatever its author used — the panel says so. */
  unitsMm: boolean;
  solid: boolean;
  shells: number;
  triangles: number;
  boundingBoxMm: { min: [number, number, number]; max: [number, number, number]; size: [number, number, number] };
  warnings: string[];
}

/**
 * Tessellate a workspace file for PREVIEW — same reader as import, no version,
 * no storage policy. A plate of objects or a mesh with holes is exactly what a
 * human needs to see before deciding, so the refusals that protect the corpus
 * are suspended here (`preview: true`) and the facts (`solid`, `shells`) still
 * come back. Nothing is written to the store.
 */
export async function previewGeometry(req: { file: string; cwd: string }): Promise<PreviewGeometry> {
  const resolvedPath = await resolveWorkspaceFile(req.file, req.cwd);
  const ext = extname(resolvedPath).toLowerCase();
  if (!PREVIEWABLE_EXTENSIONS.has(ext)) {
    throw new Error(
      ext === '.dxf'
        ? `"${basename(resolvedPath)}" is a DXF: a 2D profile is not a body, so there is nothing to show — import it with depthMm to make a solid.`
        : `cannot preview "${ext}" files. Previewable today: STL, STEP/STP, 3MF.`,
    );
  }
  const solved = await importGeometry({ file: resolvedPath, cwd: req.cwd, unit: 'mm', preview: true });
  return {
    stl: solved.stl,
    format: solved.format,
    // STEP and 3MF declare their own unit and the worker folded it to mm; an STL
    // has no unit statement at all, so its numbers are "the file's own".
    unitsMm: ext !== '.stl',
    solid: solved.solid,
    shells: solved.shells,
    triangles: solved.triangles,
    boundingBoxMm: solved.boundingBoxMm,
    warnings: solved.warnings,
  };
}


