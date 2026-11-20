// One validation entry for a version's artifacts.
//
// Design evidence is the STL mesh: Manifold decides whether it is a solid, and
// every fit/print/motion check consumes that same mesh. STEP is a SECONDARY
// native artifact: it is checked independently (cascadio -> mesh + the provider's
// BRepCheck claim) and compared to the STL, but a valid B-rep never turns a
// failing design check into a pass. `designEvidence: "mesh"` says this out loud.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseBinaryStl, isWatertight, boundingBox, type ParsedMesh } from './mesh.ts';
import { weldToSolid } from './solidify.ts';
import { importGeometry, normalizeDatums } from './import.ts';
import { readVersionEntry, type VersionStore } from './version.ts';

export type ValidationSeverity = 'blocked' | 'warn';

export interface GeometryIssue {
  code: string;
  message: string;
  fix: string;
  severity: ValidationSeverity;
}

export interface MeshFacts {
  present: boolean;
  valid: boolean;
  watertight?: boolean;
  triangles?: number;
  volumeMm3?: number;
  bboxMm?: { min: number[]; max: number[]; size: number[] };
}

export interface StepFacts extends MeshFacts {
  brepValid?: boolean;
  importedBy?: 'cascadio';
}

export interface DatumFacts {
  present: boolean;
  valid: boolean;
  count: number;
}

export interface VersionGeometryValidation {
  versionId: string;
  designEvidence: 'mesh';
  stl: MeshFacts;
  step: StepFacts;
  datums: DatumFacts;
  consistent: boolean;
  issues: GeometryIssue[];
}

const REL_VOLUME_TOL = 0.01;
const ABS_BBOX_TOL_MM = 0.5;

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function bboxOf(mesh: ParsedMesh): { min: number[]; max: number[]; size: number[] } {
  const bb = boundingBox(mesh);
  const min = bb.min.map(round3);
  const max = bb.max.map(round3);
  return { min, max, size: [round3(max[0]! - min[0]!), round3(max[1]! - min[1]!), round3(max[2]! - min[2]!)] };
}

function maxBboxDelta(a: number[], b: number[]): number {
  return Math.max(...a.map((v, i) => Math.abs(v - (b[i] ?? 0))));
}

/**
 * Validate the stored STL and (when present) the native STEP.
 *
 * Codes:
 *   stl_missing / stl_invalid / stl_not_manifold
 *   step_missing (warn; STEP is optional) / step_invalid / step_not_solid /
 *   step_invalid_brep / step_artifact_mismatch
 */
export async function validateVersionGeometry(
  store: VersionStore,
  versionId: string,
  opts: { requireStep?: boolean } = {},
): Promise<VersionGeometryValidation> {
  const dir = join(store.root, 'versions', versionId);
  const entry = await readVersionEntry(store, versionId);
  const issues: GeometryIssue[] = [];
  const stl: MeshFacts = { present: false, valid: false };
  const step: StepFacts = { present: false, valid: false };
  const datums: DatumFacts = { present: false, valid: true, count: 0 };

  let stlMesh: ParsedMesh | null = null;
  try {
    const bytes = await readFile(join(dir, 'model.stl'));
    stl.present = true;
    stlMesh = parseBinaryStl(bytes);
    const solid = await weldToSolid(stlMesh);
    stl.watertight = isWatertight(stlMesh).watertight;
    stl.triangles = stlMesh.triVerts.length / 3;
    stl.bboxMm = bboxOf(stlMesh);
    if (!solid.ok) {
      issues.push({
        code: 'stl_not_manifold',
        message: solid.reason ?? 'Manifold rejected the stored STL',
        fix: 'regenerate or repair the model; a non-solid cannot be measured or assembled',
        severity: 'blocked',
      });
    } else {
      stl.valid = true;
      stl.volumeMm3 = round3(Math.abs(solid.signedVolumeMm3));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      issues.push({
        code: 'stl_missing',
        message: `version ${versionId} has no model.stl`,
        fix: 'rebuild the version or import its mesh again',
        severity: 'blocked',
      });
    } else {
      issues.push({
        code: 'stl_invalid',
        message: `cannot parse model.stl: ${String((error as Error)?.message ?? error)}`,
        fix: 'the stored STL is truncated or not a mesh; regenerate it',
        severity: 'blocked',
      });
    }
  }

  const stepName = entry?.stepFile ?? 'model.step';
  const stepPath = join(dir, stepName);
  let stepBytes: Uint8Array | null = null;
  try {
    stepBytes = new Uint8Array(await readFile(stepPath));
    step.present = true;
  } catch {
    step.present = false;
  }

  if (step.present && entry?.stepSha256) {
    const expected = entry.stepSha256.replace(/^sha256:/i, '').toLowerCase();
    const actual = createHash('sha256').update(stepBytes!).digest('hex');
    if (!/^[0-9a-f]{64}$/.test(expected) || actual !== expected) {
      issues.push({
        code: 'step_hash_mismatch',
        message: `version ${versionId} records ${entry.stepSha256}, but the stored ${stepName} hashes to sha256:${actual}`,
        fix: 'the STEP is not the artifact this version recorded; rebuild/re-export it and do not validate against it',
        severity: 'blocked',
      });
    }
  }

  if (!step.present) {
    issues.push({
      code: 'step_missing',
      message: `version ${versionId} has no ${stepName}`,
      fix: opts.requireStep
        ? 'compile with a provider that can export STEP (CadQuery), or pass requireStep:false'
        : 'optional: a CadQuery compile with step:true writes model.step',
      severity: opts.requireStep ? 'blocked' : 'warn',
    });
  } else {
    if (entry?.brep && entry.brep.valid === false) {
      step.brepValid = false;
      issues.push({
        code: 'step_invalid_brep',
        message: `provider BRepCheck marked ${stepName} invalid`,
        fix: 'repair the model; do not treat a broken B-rep as a STEP artifact',
        severity: 'blocked',
      });
    } else if (entry?.brep) {
      step.brepValid = entry.brep.valid;
    }

    try {
      const imported = await importGeometry({
        file: stepPath,
        cwd: dir,
        unit: 'mm',
        preview: true,
        allowNonSolid: true,
      });
      step.valid = imported.solid;
      step.watertight = imported.watertight;
      step.triangles = imported.triangles;
      step.volumeMm3 = round3(imported.volumeMm3);
      step.bboxMm = {
        min: imported.boundingBoxMm.min,
        max: imported.boundingBoxMm.max,
        size: imported.boundingBoxMm.size,
      };
      step.importedBy = 'cascadio';
      if (!imported.solid) {
        issues.push({
          code: 'step_not_solid',
          message: `import_mesh read ${stepName} but it is not a closed solid`,
          fix: 'repair the B-rep or re-export the STEP from a closed solid',
          severity: 'blocked',
        });
      }
    } catch (error) {
      issues.push({
        code: 'step_invalid',
        message: `import_mesh could not read ${stepName}: ${String((error as Error)?.message ?? error)}`,
        fix: 're-export the STEP; OpenCASCADE produced no geometry (a silent cascadio failure is reported here)',
        severity: 'blocked',
      });
    }
  }

  // Datums are the assembly contract's addresses. `readVersionDatums` is
  // deliberately forgiving (missing = none), but a present file must satisfy
  // the same schema `set_datums` enforces; otherwise the failure surfaces later
  // as "datum not found" in an unrelated assembly check.
  try {
    const raw = JSON.parse(await readFile(join(dir, 'datums.json'), 'utf8')) as unknown;
    datums.present = true;
    if (raw === null || typeof raw !== 'object') throw new Error('datums.json must be an object or an array');
    const object = !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const list = (key: string): unknown[] => {
      if (Array.isArray(raw)) return key === 'points' ? raw : [];
      const value = object?.[key];
      if (value === undefined) return [];
      if (!Array.isArray(value)) throw new Error(`datums.${key} must be an array`);
      return value;
    };
    const inputs = [
      ...list('points').map((d: any) => ({ kind: 'point' as const, name: d?.name, point: d?.point })),
      ...list('axes').map((d: any) => ({ kind: 'axis' as const, name: d?.name, point: d?.point, dir: d?.dir })),
      ...list('planes').map((d: any) => ({ kind: 'plane' as const, name: d?.name, point: d?.point, normal: d?.normal })),
      ...list('cylinders').map((d: any) => ({ kind: 'cylinder' as const, name: d?.name, point: d?.point, dir: d?.dir, radius: d?.radius })),
    ];
    const set = normalizeDatums(inputs as any);
    datums.valid = true;
    datums.count = set ? set.points.length + set.axes.length + set.planes.length + set.cylinders.length : 0;
    // A datum can be a legitimate anchor outside the mesh (a fixture origin),
    // so this is a warning, not a block. It still catches the common authoring
    // mistake where a box is centered differently from its declared datums.
    if (set && stl.bboxMm) {
      const boxes = [
        ...set.points, ...set.axes, ...set.planes, ...set.cylinders,
      ].map((d) => ({ name: d.name, point: d.point }));
      const outside = boxes.filter((d) => d.point.some((v, i) =>
        v < (stl.bboxMm!.min[i]! - 0.5) || v > (stl.bboxMm!.max[i]! + 0.5)));
      if (outside.length > 0) {
        issues.push({
          code: 'datum_outside_bbox',
          message: `datum anchor(s) outside the mesh bbox by >0.5mm: ${outside.map((d) => d.name).join(', ')}`,
          fix: 'check the box origin/translation or the datum coordinates; schema-valid datums can still describe the wrong place',
          severity: 'warn',
        });
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      datums.present = false;
      datums.valid = true;
    } else {
      datums.present = true;
      datums.valid = false;
      issues.push({
        code: 'datums_invalid',
        message: `version ${versionId} has an invalid datums.json: ${String((error as Error)?.message ?? error)}`,
        fix: 're-run set_datums or regenerate the version; names must be non-empty/unique, directions non-zero, cylinder radii positive',
        severity: 'blocked',
      });
    }
  }

  let consistent = true;
  if (issues.some((i) => i.code === 'step_hash_mismatch')) consistent = false;
  if (stl.valid && step.present && step.valid && stl.bboxMm && step.bboxMm && !issues.some((i) => i.code === 'step_hash_mismatch')) {
    const bboxDelta = maxBboxDelta(stl.bboxMm.size, step.bboxMm.size);
    const volumeBase = Math.max(stl.volumeMm3 ?? 0, step.volumeMm3 ?? 0, 1e-9);
    const volumeDelta = Math.abs((stl.volumeMm3 ?? 0) - (step.volumeMm3 ?? 0));
    if (bboxDelta > ABS_BBOX_TOL_MM || volumeDelta / volumeBase > REL_VOLUME_TOL) {
      consistent = false;
      issues.push({
        code: 'step_artifact_mismatch',
        message:
          `STL and STEP disagree (bbox Δ ${round3(bboxDelta)} mm, volume Δ ${round3(volumeDelta)} mm³ / ` +
          `${(volumeDelta / volumeBase * 100).toFixed(2)}%)`,
        fix: 're-export both artifacts from the same source revision; do not validate a STEP from another model',
        severity: 'blocked',
      });
    }
  } else if (stl.valid && step.present && !step.valid) {
    consistent = false;
  }

  return { versionId, designEvidence: 'mesh', stl, step, datums, consistent, issues };
}
