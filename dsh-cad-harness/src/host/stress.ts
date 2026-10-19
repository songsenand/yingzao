// simulate_stress — voxel hex8 linear-elastic static analysis, reported in the SAME
// `attention` shape `check_printability` uses: one field object, so the picture a human
// looks at and the digest an LLM reads cannot drift apart (DECISION-LOG 2026-10-19).
//
// THE CAPABILITY BOUNDARY IS THE TOOL'S CONTRACT, not a footnote (DESIGN §25.2 req. 1).
// The 2026-10-08 probes measured what this lane can and cannot answer, and the results
// are not symmetric:
//
//   * TRUST: integrals (reaction, section resultant, compliance, strain energy) — the
//     reaction came out at exactly 100.00 N and the internal moment within 1.0%; the
//     energy balance and the equilibrium residual are machine-precision self-checks;
//   * TRUST: hot-spot LOCATIONS above a tier, with the extent and the wall thickness in
//     cells attached, because the key coordinate error is a constant half cell and a
//     feature thinner than ~8 cells puts the peak on the wrong side (measured);
//   * TRUST, with a declared method: the surface stress recovered by walking INTO the
//     material from the hot spot and extrapolating the depth profile to the surface
//     (the probe's method: 0.8% on the cantilever, and the acceptance bands it);
//   * DO NOT REPORT: "the largest element stress". Refining a hole plate made it grow
//     1.002 -> 1.184, and fill-ratio weighting did not fix it (1.184 -> 1.169). Where a
//     curved boundary is a staircase, the cell maximum is a property of the staircase.
//     This module therefore has no field for it — a caller cannot ask for it by name.
//   * DO NOT REPORT: a safety factor. The peak method carries a documented under-read at
//     the declared distance, and the model is isotropic — it cannot see that an FDM part
//     is weak between layers, which is usually the direction that breaks first.
//
// The engine lives in `python/cad_worker/stress_fem.py` (numpy matrix-free CG, the 2026-10-08
// "FEM goes to Python" decision). This file is the tool face: materials, the request, and
// the mapping into the attention contract.

import type {
  AttentionField,
  AttentionLayer,
  AttentionPeak,
  AttentionRegion,
  Json,
} from './inspect.ts';
import { ensurePythonWorker } from './python-worker.ts';

/**
 * An isotropic linear-elastic material, DECLARED by the caller (DESIGN §25.2 req. 2).
 * `assumed: true` means nobody calibrated it for this filament/temperature/print — the
 * same discipline as `check_printability`'s built-in process fallback, which downgrades
 * its verdict rather than pretending the numbers were declared.
 */
export interface StressMaterial {
  id: string;
  name: string;
  youngModulusMPa: number;
  poissonRatio: number;
  /** Strength used for the colour tiers and the region classification only. */
  strengthMPa: number;
  /** Where the numbers come from — a verdict without its premise is not evidence. */
  source: string;
  assumed: boolean;
}

export const SHIPPED_MATERIALS: Record<string, StressMaterial> = {
  'fdm-pla': {
    id: 'fdm-pla',
    name: 'PLA, FDM printed (uncallibrated)',
    youngModulusMPa: 3500,
    poissonRatio: 0.35,
    // Deliberately the LAYER-ADHESION band (25-30 MPa), not the 50-60 MPa bulk figure:
    // the isotropic model cannot represent layer direction, so the tiers must not be
    // drawn with a bulk strength that the printed part will not reach across layers.
    strengthMPa: 25,
    source: 'builtin-default (bulk E ~3.5 GPa; strength = the 25-30 MPa layer-adhesion band)',
    assumed: true,
  },
};

export interface StressSupportFace {
  axis: 'x' | 'y' | 'z';
  side?: 'min' | 'max';
}

export interface StressSupportPoint {
  atMm: number[];
  radiusMm?: number;
}

export interface StressLoad {
  forceN: number[];
  face?: StressSupportFace;
  atMm?: number[];
  radiusMm?: number;
}

export interface StressResultantSpec {
  axis: 'x' | 'y' | 'z';
  atMm: number;
}

export interface StressSolveRequest {
  path: string;
  material: StressMaterial;
  dxMm?: number;
  fixedFaces?: StressSupportFace[];
  fixedPoints?: StressSupportPoint[];
  loads: StressLoad[];
  probeAtMm?: number[];
  resultants?: StressResultantSpec[];
  /** Support/load patches dropped from the report: their stress is the idealisation's. */
  excludeFromReport?: { atMm: number[]; radiusMm?: number }[];
  criticalDistanceMm?: number;
  coarsenFactor?: number;
  runConvergence?: boolean;
  fieldPath?: string;
}

/** Mirrors `stress_fem.run`'s result. Fields documented where they are produced. */
export interface StressRegion {
  tier: 'warn' | 'bad';
  cells: number;
  volumeMm3: number;
  projectedAreaMm2: number;
  meanDepthMm: number;
  atMm: number[];
  bboxMm: number[][];
  centroidMm: number[];
  peakVonMisesMPa: number;
  peakDepthCells: number;
  peakDepthMm: number;
  surfaceExtrapolatedMPa: number | null;
  /** The same estimate on the coarser grid — the stability check the peak needs. */
  extrapolationCoarseMPa?: number;
  extrapolationCrossResolutionPct?: number | null;
  pathSamples: number;
  pathDepthMm: number[];
  pathVonMisesMPa: number[];
  fitR2: number | null;
  localThicknessCells: number;
  minExtentCells: number;
  extentCells: number[];
  trustworthy: boolean;
  whyUntrustworthy: string | null;
}

export interface StressSolveResult {
  refused?: string;
  dxMm: number;
  gridCells: number[];
  solidCells: number;
  freeDof: number;
  cgIterations: number;
  cgResidualRel: number;
  criticalDistanceMm: number;
  effectiveDistanceMm: number;
  /** Cells dropped from the field/peaks/percentiles: the support and load patches
   *  are an idealisation, not evidence (see `excludeFromReport`). */
  excludedCells: number;
  peakDeclaredDepthMPa: number;
  peakDeclaredDepthAtMm: number[];
  peakDepthCells: number;
  /** Debug only: the acceptance measures that THIS is not a convergent quantity. */
  maxVonMisesBoundaryMPa: number;
  internalEnergyMj: number;
  externalWorkMj: number;
  energyBalancePct: number;
  reactionN: number[];
  appliedN: number[];
  equilibriumErrorPct: number;
  probeDisplacementMm: number[] | null;
  resultants: {
    axis: string;
    atMm: number;
    cells?: number;
    latticeLayers?: number;
    axialForceN?: number;
    shearN?: Record<string, number>;
    momentNmm?: Record<string, number>;
    centroidMm?: number[];
    refused?: string;
    note?: string;
  }[];
  percentilesMPa: Record<string, number>;
  peaks: { atMm: number[]; value: number; depthCells: number; evidence: string }[];
  regions: StressRegion[];
  regionsTrustworthy: number;
  meshIndependence: Record<string, Json | undefined> & {
    checked: boolean;
    verdict?: string;
    note?: string;
  };
  fieldPath?: string;
}

/**
 * Which material the run was solved with, and where those numbers came from. Same
 * discipline as `check_printability`'s process profiles: a DECLARED material is used
 * as given, a shipped default is used but marked `assumed`, and an unknown id is an
 * error rather than a silent fallback — a stress field solved with the wrong modulus
 * is a plausible wrong number, which is the failure mode this whole repo is organised
 * against.
 */
export function resolveStressMaterial(materialJson?: string, materialIds?: string[]): StressMaterial {
  if (materialJson) {
    const parsed = JSON.parse(materialJson) as Partial<StressMaterial>;
    const required = ['id', 'youngModulusMPa', 'poissonRatio', 'strengthMPa'] as const;
    for (const key of required) {
      if (parsed[key] === undefined) throw new Error(`materialJson is missing "${key}"`);
    }
    if (!(parsed.youngModulusMPa! > 0)) throw new Error('materialJson youngModulusMPa must be > 0');
    if (!(parsed.poissonRatio! > 0 && parsed.poissonRatio! < 0.5)) {
      throw new Error('materialJson poissonRatio must be in (0, 0.5)');
    }
    if (!(parsed.strengthMPa! > 0)) throw new Error('materialJson strengthMPa must be > 0');
    return {
      id: String(parsed.id),
      name: parsed.name ?? String(parsed.id),
      youngModulusMPa: parsed.youngModulusMPa!,
      poissonRatio: parsed.poissonRatio!,
      strengthMPa: parsed.strengthMPa!,
      source: 'declared-inline',
      assumed: false,
    };
  }
  const ids = materialIds && materialIds.length > 0 ? materialIds : ['fdm-pla'];
  if (ids.length > 1) {
    throw new Error(
      `simulate_stress solves ONE material per run (isotropic linear elasticity); got ${ids.join(', ')}`,
    );
  }
  const found = SHIPPED_MATERIALS[ids[0]!];
  if (!found) {
    throw new Error(
      `unknown material "${ids[0]}" (shipped: ${Object.keys(SHIPPED_MATERIALS).join(', ')}); pass materialJson for your own`,
    );
  }
  return found;
}

/**
 * The field half of the attention contract: the per-sample values the panel draws,
 * keyed by layer id, with that layer's own declared normalization. Identical in shape
 * to what `check_printability` writes (inspect.ts `AttentionFieldSamples`), so the
 * panel has ONE reader for both tools.
 */
export interface StressFieldPayload {
  samples: { [layerId: string]: { p: number[]; v: number }[] };
  normalization: { [layerId: string]: { [key: string]: Json } };
}

/** Read the field the solver wrote by file (a grid is megabytes; never inline). */
export async function readStressField(path: string): Promise<StressFieldPayload> {
  const { readFile } = await import('node:fs/promises');
  const raw = JSON.parse(await readFile(path, 'utf8')) as StressFieldPayload;
  if (!raw.samples || !raw.normalization) {
    throw new Error(`stress field at ${path} is not an attention field payload`);
  }
  return raw;
}

export async function solveStress(req: StressSolveRequest): Promise<StressSolveResult> {  const worker = await ensurePythonWorker();
  return worker.request<StressSolveResult>('stress_field', {
    path: req.path,
    dxMm: req.dxMm,
    youngModulusMPa: req.material.youngModulusMPa,
    poissonRatio: req.material.poissonRatio,
    yieldMPa: req.material.strengthMPa,
    fixedFaces: req.fixedFaces,
    fixedPoints: req.fixedPoints,
    loads: req.loads,
    probeAtMm: req.probeAtMm,
    resultants: req.resultants,
    excludeFromReport: req.excludeFromReport,
    criticalDistanceMm: req.criticalDistanceMm,
    coarsenFactor: req.coarsenFactor,
    runConvergence: req.runConvergence,
    fieldPath: req.fieldPath,
  });
}

/** A runnable way to LOOK at a location: a section cut through it. `fraction` is the
 *  only section form `render_part` accepts, so an `atMm` here would produce a command
 *  a caller cannot actually run. */
function lookAt(versionId: string, bbox: number[][], atMm: number[]): { tool: string; args: { [key: string]: Json } } {
  const spans = bbox.map((pair, i) => ({ axis: 'xyz'[i], lo: pair[0]!, hi: pair[1]!, span: pair[1]! - pair[0]! }));
  const axis = spans.reduce((a, b) => (b.span > a.span ? b : a));
  const raw = axis.span > 0 ? (atMm[['x', 'y', 'z'].indexOf(axis.axis)]! - axis.lo) / axis.span : 0.5;
  const fraction = Math.min(0.95, Math.max(0.05, raw));
  return { tool: 'render_part', args: { versionId, section: { axis: axis.axis, fraction: Number(fraction.toFixed(4)) } } };
}

/** What `scan_attention` returns per suspect (fields optional: the mapper is defensive
 *  on purpose — a courtesy scan must never break the stress result). */
export interface GeometrySuspect {
  kind?: string;
  where?: { atMm?: number[]; bboxMm?: number[][] };
  atMm?: number[];
  why?: string;
  evidence?: string;
  /** `scan_attention` reports a WORD ("likely-defect"), not a number. */
  severity?: number | string;
}

/**
 * The layer that keeps `simulate_stress` from going SILENT (HARNESS §11.14, DESIGN §30).
 *
 * When the stress half certifies nothing — the common case for the toy-balance parts,
 * whose members are thinner than the voxel — returning an empty field tells the reader
 * "all fine", which is exactly the attention failure §11.14 forbids. This layer carries
 * the geometric places worth looking at, labelled for what they are: a corner angle,
 * NOT a stress. `areaMm2` is 0 by construction (a corner is a line, not an area) and
 * `domain.regionAreaIs` says so.
 */
export function geometrySuspectLayer(
  versionId: string,
  partBbox: number[][],
  suspects: GeometrySuspect[],
): AttentionLayer {
  const at = (s: GeometrySuspect): number[] => s.where?.atMm ?? s.atMm ?? [0, 0, 0];
  const why = (s: GeometrySuspect): string =>
    [s.evidence ?? s.why ?? `${s.kind ?? 'geometric suspect'} — reported by scan_attention`,
     typeof s.severity === 'string' ? `severity: ${s.severity}` : null]
      .filter(Boolean)
      .join(' · ');
  // The ramp needs a number; the WORD goes in the evidence. 'likely-defect' must not be
  // silently dropped just because the schema asks for a value.
  const weight = (s: GeometrySuspect): number =>
    typeof s.severity === 'number'
      ? s.severity
      : s.severity === 'likely-defect'
        ? 1
        : s.severity === 'check'
          ? 0.5
          : 0;
  const peaks: AttentionPeak[] = suspects.slice(0, 6).map((s) => ({
    atMm: at(s),
    value: weight(s),
    evidence: why(s),
    probe: lookAt(versionId, partBbox, at(s)),
  }));
  const regions: AttentionRegion[] = suspects.slice(0, 8).map((s) => ({
    tier: 'warn',
    areaMm2: 0,
    atMm: at(s),
    bboxMm: s.where?.bboxMm ?? partBbox,
    look: lookAt(versionId, partBbox, at(s)),
    kind: s.kind ?? 'geometric-suspect',
  }));
  return {
    id: 'geometry-suspects',
    quantity: 'reentrant-corner-angle',
    units: 'deg',
    direction: 'larger-is-sharper',
    domain: {
      kind: 'geometry-scan',
      source: 'scan_attention',
      regionAreaIs: 'a corner is a line, not an area: areaMm2 is 0 by construction',
      notAStressResult: true,
    },
    normalization: { mode: 'absolute', warnAt: 100, source: 'scan_attention concaveMinDeg default' },
    stats: {
      suspects: suspects.length,
      note:
        'the stress half certified NO region at this resolution, so THIS layer carries the ' +
        'places to look at instead of an empty field (HARNESS §11.14); it is geometry, not stress',
    },
    peaks,
    regions,
  };
}

export interface StressAttentionInput {
  versionId: string;
  material: StressMaterial;
  result: StressSolveResult;
  bbox: number[][];
  warnFactor: number;
  badFactor: number;
}

/**
 * The attention field. `id` carries version + tool + the parameters that change the
 * numbers, because a picture may not outlive the geometry or the case it describes.
 */
export function stressAttention(input: StressAttentionInput): AttentionField {
  const { versionId, material, result, bbox, warnFactor, badFactor } = input;
  const id = [
    'simulate_stress',
    `${material.id}${material.assumed ? '~assumed' : ''}`,
    `dx${result.dxMm}`,
    `cd${result.criticalDistanceMm}`,
  ].join(':');

  const peaks: AttentionPeak[] = result.peaks.map((p) => ({
    atMm: p.atMm,
    value: p.value,
    evidence: p.evidence,
    probe: lookAt(versionId, bbox, p.atMm),
  }));

  const regions: AttentionRegion[] = result.regions.map((r) => ({
    tier: r.tier,
    // The contract asks a region for an AREA and a hot zone is three-dimensional:
    // this is the patch it projects onto the surface (volume / mean depth), and the
    // layer's `domain` says so. `volumeMm3` is carried alongside, unrounded.
    areaMm2: r.projectedAreaMm2,
    atMm: r.atMm,
    bboxMm: r.bboxMm,
    look: lookAt(versionId, bbox, r.atMm),
    volumeMm3: r.volumeMm3,
    peakVonMisesMPa: r.peakVonMisesMPa,
    peakDepthMm: r.peakDepthMm,
    surfaceExtrapolatedMPa: r.surfaceExtrapolatedMPa,
    extrapolationCoarseMPa: r.extrapolationCoarseMPa ?? null,
    extrapolationCrossResolutionPct: r.extrapolationCrossResolutionPct ?? null,
    localThicknessCells: r.localThicknessCells,
    minExtentCells: r.minExtentCells,
    fitR2: r.fitR2,
    trustworthy: r.trustworthy,
    whyUntrustworthy: r.whyUntrustworthy,
  }));

  const trustworthy = result.regions.filter((r) => r.trustworthy && r.surfaceExtrapolatedMPa !== null);
  const surfacePeak = trustworthy.length
    ? Math.max(...trustworthy.map((r) => r.surfaceExtrapolatedMPa as number))
    : null;

  const layer: AttentionLayer = {
    id: 'von-mises',
    quantity: 'von-mises-stress',
    units: 'MPa',
    direction: 'larger-is-worse',
    domain: {
      kind: 'solid-cells',
      dxMm: result.dxMm,
      gridCells: result.gridCells,
      solidCells: result.solidCells,
      regionAreaIs: 'projected surface patch = volume / mean distance-to-surface, NOT a measured surface area',
    },
    normalization: {
      mode: 'absolute',
      warnAt: Number((material.strengthMPa / warnFactor).toFixed(4)),
      badAt: Number((material.strengthMPa / badFactor).toFixed(4)),
      source: `declared-material ${material.id}${material.assumed ? ' (ASSUMED — not calibrated)' : ''}: strengthMPa ${material.strengthMPa}`,
      caveat:
        'isotropic model: layer-direction weakness of a printed part is NOT represented, so a tier is not a safety factor; ' +
        'surfaceExtrapolatedMPa is only quoted for regions that also passed the cross-resolution stability check ' +
        '(a good fit R^2 alone is not enough — measured: R^2 0.90 with a 17% move on a fillet)',
    },
    stats: {
      peakAtDeclaredDistanceMPa: result.peakDeclaredDepthMPa,
      criticalDistanceMm: result.criticalDistanceMm,
      effectiveSampleDistanceMm: result.effectiveDistanceMm,
      surfaceExtrapolatedMPa: surfacePeak,
      surfaceExtrapolatedFromRegions: trustworthy.length,
      percentilesMPa: result.percentilesMPa,
      maxDisplacementMm: result.probeDisplacementMm
        ? Math.hypot(...result.probeDisplacementMm)
        : null,
      strainEnergyMj: result.internalEnergyMj,
      equilibriumErrorPct: result.equilibriumErrorPct,
      energyBalancePct: result.energyBalancePct,
    },
    peaks,
    regions,
  };

  return { id: `${versionId}:${id}`, layers: [layer] };
}
