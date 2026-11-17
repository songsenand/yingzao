// Declarative feature checks (C framework, v1: hole-pattern).
//
// Features are CHECK-ONLY. This module reads a saved version's mesh, finds the
// holes that list_features reports, and compares them with the declaration in
// assembly.json. It never generates geometry from a feature, so there is no
// second modelling path and no second CAD kernel.
//
// A standard part is an ordinary part here: if it has a version, its holes are
// checked the same way; if it has no version it is BOM-only and skipped.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { flattenParts, loadAssemblyManifest, type HolePatternFeature } from './manifest.ts';
import { ensurePythonWorker } from './python-worker.ts';

export interface HoleLike {
  centerMm: number[];
  axisMm: number[];
  diameterMm?: number;
  through?: boolean;
  kind?: string;
}

export interface FeatureMatch {
  verdict: 'pass' | 'fail';
  matched: number;
  missing: number;
  wrongDiameter: number;
  wrongRadius: number;
  throughFailures: number;
  measured: { diametersMm: number[]; radiiMm: number[] };
  detail: string;
}

export interface FeatureCheckResult {
  partId: string;
  partName: string;
  versionId?: string;
  featureIndex: number;
  kind: 'hole-pattern';
  verdict: 'pass' | 'fail' | 'skipped';
  matched: number;
  expected: { count: number; pcdMm: number; diameterMm: number; through?: boolean };
  measured?: { diametersMm: number[]; radiiMm: number[] };
  detail: string;
}

const DEG = Math.PI / 180;
const norm = (v: number[]): number[] => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / l, v[1]! / l, v[2]! / l];
};
const dot = (a: number[], b: number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const sub = (a: number[], b: number[]): number[] => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const cross = (a: number[], b: number[]): number[] => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];

/**
 * Pure matcher, exported so it can be tested without a Python runtime.
 * `holes` are the round openings reported by list_features (or bore cylinders
 * when the face detector found none); `feature.axis` is the hole axis and
 * `feature.centerMm` is a point on the pattern axis.
 */
export function matchHolePattern(feature: HolePatternFeature, holes: HoleLike[]): FeatureMatch {
  const tol = feature.toleranceMm ?? 0.2;
  const axis = norm(feature.axis);
  const center = feature.centerMm;
  // An orthonormal basis in the pattern plane; the axial component is ignored.
  const helper = Math.abs(axis[0]!) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = norm(cross(helper, axis));
  const v = norm(cross(axis, u));
  const parallelCos = Math.cos(2 * DEG);

  const seen = new Set<string>();
  const diameters: number[] = [];
  const radii: number[] = [];
  let wrongDiameter = 0;
  let wrongRadius = 0;
  let throughFailures = 0;

  for (const hole of holes) {
    const d = hole.diameterMm;
    if (typeof d !== 'number') continue;
    const ha = norm(hole.axisMm);
    if (Math.abs(dot(ha, axis)) < parallelCos) continue;
    const rel = sub(hole.centerMm, center);
    const axial = dot(rel, axis);
    const radialVec = [rel[0]! - axial * axis[0]!, rel[1]! - axial * axis[1]!, rel[2]! - axial * axis[2]!];
    const r = Math.hypot(radialVec[0]!, radialVec[1]!, radialVec[2]!);
    if (Math.abs(d - feature.diameterMm) > tol) {
      // Only a hole at the RIGHT radius is a diameter witness; otherwise it is
      // just another hole in the part and must not inflate the diagnostic.
      if (Math.abs(r - feature.pcdMm / 2) <= tol) wrongDiameter++;
      continue;
    }
    if (Math.abs(r - feature.pcdMm / 2) > tol) {
      wrongRadius++;
      continue;
    }
    // Deduplicate a through hole reported on the entry and exit faces: same
    // radial/angular position, different axial coordinate.
    const angle = Math.atan2(dot(radialVec, v), dot(radialVec, u)) / DEG;
    const key = `${Math.round(angle / 0.5)}:${Math.round(r * 20)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    diameters.push(d);
    radii.push(r);
    if (feature.through === true && hole.through !== true) throughFailures++;
  }

  const matched = seen.size;
  const missing = Math.max(0, feature.count - matched);
  const measured = {
    diametersMm: diameters.map((x) => +x.toFixed(3)).sort((a, b) => a - b),
    radiiMm: radii.map((x) => +x.toFixed(3)).sort((a, b) => a - b),
  };
  const verdict: 'pass' | 'fail' = missing === 0 && throughFailures === 0 ? 'pass' : 'fail';
  const extra = matched > feature.count ? ` · ${matched - feature.count} extra hole(s) at this PCD` : '';
  const detail = `expected ${feature.count} × Ø${feature.diameterMm} on PCD ${feature.pcdMm} (tol ±${tol}) → ` +
    `matched ${matched}` +
    (missing ? `, missing ${missing}` : '') +
    (wrongDiameter ? `, ${wrongDiameter} wrong diameter` : '') +
    (wrongRadius ? `, ${wrongRadius} off-PCD` : '') +
    (throughFailures ? `, ${throughFailures} not through` : '') + extra;
  return { verdict, matched, missing, wrongDiameter, wrongRadius, throughFailures, measured, detail };
}

interface ListFeaturesOut {
  faces?: { holes?: HoleLike[] }[];
  cylinders?: (HoleLike & { kind?: string; lengthMm?: number })[];
}

/**
 * Check every declared feature on every versioned part of a manifest.
 *
 * A part without a version is BOM-only: its features are reported as skipped
 * with that reason, never as a pass. A missing Python runtime is also skipped,
 * with the error, so the contract check does not silently drop the feature.
 */
export async function checkManifestFeatures(root: string, manifestPath: string): Promise<FeatureCheckResult[]> {
  const manifest = await loadAssemblyManifest(manifestPath);
  const jobs = flattenParts(manifest.root).filter((fp) => (fp.node.features?.length ?? 0) > 0);
  if (jobs.length === 0) return [];

  const skipped = (fp: (typeof jobs)[number], why: string): FeatureCheckResult[] =>
    (fp.node.features ?? []).map((feature, featureIndex) => ({
      partId: fp.id,
      partName: fp.node.name,
      ...(fp.node.version ? { versionId: fp.node.version } : {}),
      featureIndex,
      kind: feature.kind,
      verdict: 'skipped' as const,
      matched: 0,
      expected: { count: feature.count, pcdMm: feature.pcdMm, diameterMm: feature.diameterMm, ...(feature.through === undefined ? {} : { through: feature.through }) },
      detail: why,
    }));

  let worker: Awaited<ReturnType<typeof ensurePythonWorker>>;
  try {
    worker = await ensurePythonWorker();
  } catch (error) {
    return jobs.flatMap((fp) => skipped(fp, `feature check skipped: python worker unavailable (${String((error as Error)?.message ?? error)})`));
  }

  const results: FeatureCheckResult[] = [];
  for (const fp of jobs) {
    const version = fp.node.version;
    if (!version) {
      results.push(...skipped(fp, 'feature check skipped: part has no version (BOM-only stock)'));
      continue;
    }
    const stl = join(root, 'versions', version, 'model.stl');
    if (!existsSync(stl)) {
      results.push(...skipped(fp, `feature check skipped: version ${version} has no model.stl`));
      continue;
    }
    let out: ListFeaturesOut;
    try {
      out = await worker.request<ListFeaturesOut>('list_features', {
        path: stl,
        minFaceAreaMm2: 0.2,
        maxFaces: 400,
        maxCylinders: 400,
        withHoleDepth: true,
      });
    } catch (error) {
      results.push(...skipped(fp, `feature check skipped: list_features failed (${String((error as Error)?.message ?? error)})`));
      continue;
    }
    const holes = (out.faces ?? []).flatMap((face) => (face.holes ?? []).filter((h) => h.kind === 'round' && typeof h.diameterMm === 'number'));
    const bores = (out.cylinders ?? []).filter((c) => c.kind === 'bore').map((c) => ({
      centerMm: c.centerMm,
      axisMm: c.axisMm,
      diameterMm: c.diameterMm,
      through: undefined,
    }));
    for (const [featureIndex, feature] of (fp.node.features ?? []).entries()) {
      const match = matchHolePattern(feature, holes.length > 0 ? holes : bores);
      results.push({
        partId: fp.id,
        partName: fp.node.name,
        versionId: version,
        featureIndex,
        kind: feature.kind,
        verdict: match.verdict,
        matched: match.matched,
        expected: { count: feature.count, pcdMm: feature.pcdMm, diameterMm: feature.diameterMm, ...(feature.through === undefined ? {} : { through: feature.through }) },
        measured: match.measured,
        detail: match.detail,
      });
    }
  }
  return results;
}
