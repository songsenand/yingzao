// scan_stress_hotspots — DETECTION, not a verdict.
//
// The question this answers is "where do I look?", not "is it strong enough?".
// It runs the SAME linear-elastic solve as simulate_stress under a small basis of
// gravity directions and clusters the hot-spots that recur across them. A feature
// that is a geometric stress raiser tends to appear under more than one direction;
// a single-direction maximum may be that direction's load path, not the geometry.
//
// WHY 1g IS ENOUGH (and high-g is not): linear elasticity makes the stress field
// homogeneous in the load. 10g is 10x the 1g field, so the LOCATION of a hot spot
// does not move; only the number does. High-g would add no location information and
// would make an absolute threshold meaningless. The caller can scale the 1g reading
// linearly if a magnitude is wanted.
//
// WHAT THIS DELIBERATELY DOES NOT DO:
//   * no verdict / delivery field — a risk map is not a gate (DESIGN §25.7);
//   * no contact/Hertz stress: the solve is linear-elastic with held faces, not a
//     contact model; a D-flat edge or a thin ring is a boundary-condition problem;
//   * no preload, fatigue, creep or layer-direction failure;
//   * no claim to cover loads outside the declared basis. Gravity is a BODY force;
//     a pure torque path (a D-flat, a gear tooth) needs an explicit service load
//     and simulate_stress.
//
// The output is a pointer: run the listed coordinates through `simulate_stress`
// with a declared case, or through `measure`/`render_part`, before judging.

import {
  solveStress,
  type StressLoad,
  type StressMaterial,
  type StressSupportFace,
  type StressSupportPoint,
} from './stress.ts';

export interface StressHotspotDirection {
  label: string;
  gravityMmPerS2: number[];
}

export interface StressHotspotPeak {
  atMm: number[];
  value: number;
  direction: string;
  depthCells?: number;
}

export interface StressHotspot {
  atMm: number[];
  bboxMm: number[][];
  persistence: number;
  directions: string[];
  maxPeakMPa: number;
  maxPeakDirection: string;
  meanPeakMPa: number;
  peakCount: number;
  /** Distance to the nearest declared support point (mm). */
  distanceToSupportMm?: number;
  /** True when the hot spot sits on a support patch; its stress is the idealisation's. */
  nearSupport?: boolean;
}

export interface StressHotspotCase {
  label: string;
  gravityMmPerS2: number[] | null;
  loadCase: string;
  dxMm: number;
  solidCells: number;
  peakCount: number;
  peakMPa: number;
  atMm: number[] | null;
  durationMs: number;
}

export interface StressHotspotScanRequest {
  versionId: string;
  modelPath: string;
  material: StressMaterial;
  fixedFaces?: StressSupportFace[];
  fixedPoints?: StressSupportPoint[];
  directions?: StressHotspotDirection[];
  dxMm: number;
  criticalDistanceMm?: number;
  clusterRadiusMm?: number;
  maxHotspots?: number;
  excludeFromReport?: { atMm: number[]; radiusMm?: number }[];
}

export interface StressHotspotScanResult {
  versionId: string;
  hotspots: StressHotspot[];
  cases: StressHotspotCase[];
  method: {
    dxMm: number;
    clusterRadiusMm: number;
    criticalDistanceMm: number;
    caseCount: number;
    totalDurationMs: number;
    note: string;
  };
  capability: {
    mayClaim: string[];
    mayNotClaim: string[];
  };
}

/** The six unit-gravity directions. 1g = 9810 mm/s^2; the magnitude is a scale, not a finding. */
export function defaultGravityDirections(g = 9810): StressHotspotDirection[] {
  return [
    { label: '+x', gravityMmPerS2: [g, 0, 0] },
    { label: '-x', gravityMmPerS2: [-g, 0, 0] },
    { label: '+y', gravityMmPerS2: [0, g, 0] },
    { label: '-y', gravityMmPerS2: [0, -g, 0] },
    { label: '+z', gravityMmPerS2: [0, 0, g] },
    { label: '-z', gravityMmPerS2: [0, 0, -g] },
  ];
}

function distance(a: number[], b: number[]): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}

/**
 * Cluster peaks that land within `radiusMm` of each other. Pure and exported so the
 * acceptance can check the persistence rule without running an FEM.
 *
 * A cluster's `persistence` is the number of DISTINCT directions that produced a
 * peak in it. `atMm` is the strongest peak in the cluster (a real sampled point),
 * not the centroid, because the caller will go and look at that coordinate.
 */
export function clusterStressPeaks(
  peaks: StressHotspotPeak[],
  radiusMm: number,
  maxHotspots = 12,
): StressHotspot[] {
  const n = peaks.length;
  if (n === 0) return [];
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r]!;
    while (parent[i] !== i) {
      const next = parent[i]!;
      parent[i] = r;
      i = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const r = Math.max(0, radiusMm);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (distance(peaks[i]!.atMm, peaks[j]!.atMm) <= r) union(i, j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(i);
    else groups.set(root, [i]);
  }
  const out: StressHotspot[] = [];
  for (const idxs of groups.values()) {
    const members = idxs.map((i) => peaks[i]!);
    const strongest = members.reduce((a, b) => (b.value > a.value ? b : a));
    const dirs = [...new Set(members.map((m) => m.direction))];
    const values = members.map((m) => m.value);
    const mins = [0, 1, 2].map((k) => Math.min(...members.map((m) => m.atMm[k]!)));
    const maxs = [0, 1, 2].map((k) => Math.max(...members.map((m) => m.atMm[k]!)));
    out.push({
      atMm: strongest.atMm,
      bboxMm: [mins, maxs],
      persistence: dirs.length,
      directions: dirs,
      maxPeakMPa: strongest.value,
      maxPeakDirection: strongest.direction,
      meanPeakMPa: values.reduce((a, b) => a + b, 0) / values.length,
      peakCount: members.length,
    });
  }
  return out
    .sort((a, b) => (b.persistence - a.persistence) || (b.maxPeakMPa - a.maxPeakMPa))
    .slice(0, Math.max(1, maxHotspots));
}

/**
 * Run the gravity basis and cluster the recurring peaks. Sequential on purpose:
 * the resident Python worker handles one solve at a time, so parallel calls would
 * only queue and make the timeout accounting lie.
 */
export async function scanStressHotspots(req: StressHotspotScanRequest): Promise<StressHotspotScanResult> {
  const directions = req.directions?.length ? req.directions : defaultGravityDirections();
  const clusterRadiusMm = req.clusterRadiusMm ?? Math.max(1.5, 2.5 * req.dxMm);
  const criticalDistanceMm = req.criticalDistanceMm ?? 1;
  const maxHotspots = req.maxHotspots ?? 12;
  const started = Date.now();
  const allPeaks: StressHotspotPeak[] = [];
  const cases: StressHotspotCase[] = [];

  for (const direction of directions) {
    const before = Date.now();
    const result = await solveStress({
      path: req.modelPath,
      material: req.material,
      dxMm: req.dxMm,
      fixedFaces: req.fixedFaces,
      fixedPoints: req.fixedPoints,
      loads: [] as StressLoad[],
      includeSelfWeight: true,
      gravityMmPerS2: direction.gravityMmPerS2,
      excludeFromReport: req.excludeFromReport ?? [],
      criticalDistanceMm,
      runConvergence: false,
    });
    if (result.refused) {
      throw new Error(`scan_stress_hotspots: ${req.versionId} refused under ${direction.label}: ${result.refused}`);
    }
    const peaks = result.peaks.map((p) => ({
      atMm: p.atMm,
      value: p.value,
      direction: direction.label,
      depthCells: p.depthCells,
    }));
    allPeaks.push(...peaks);
    const strongest = peaks.reduce<StressHotspotPeak | null>(
      (a, b) => (a === null || b.value > a.value ? b : a),
      null,
    );
    cases.push({
      label: direction.label,
      gravityMmPerS2: direction.gravityMmPerS2,
      loadCase: result.loadCase,
      dxMm: result.dxMm,
      solidCells: result.solidCells,
      peakCount: peaks.length,
      peakMPa: strongest?.value ?? 0,
      atMm: strongest?.atMm ?? null,
      durationMs: Date.now() - before,
    });
  }

  const hotspots = clusterStressPeaks(allPeaks, clusterRadiusMm, maxHotspots).map((h) => {
    const points = req.fixedPoints ?? [];
    if (points.length === 0) return h;
    let best = Number.POSITIVE_INFINITY;
    for (const p of points) {
      const r = p.radiusMm ?? 1.5 * req.dxMm;
      best = Math.min(best, Math.max(0, distance(h.atMm, p.atMm) - r));
    }
    const near = best <= Math.max(2 * req.dxMm, 3 * (points[0]?.radiusMm ?? 1.5 * req.dxMm));
    return { ...h, distanceToSupportMm: +best.toFixed(2), nearSupport: near };
  });
  return {
    versionId: req.versionId,
    hotspots,
    cases,
    method: {
      dxMm: req.dxMm,
      clusterRadiusMm,
      criticalDistanceMm,
      caseCount: directions.length,
      totalDurationMs: Date.now() - started,
      note:
        'one linear-elastic solve per direction; a peak is the top-cell reading at the declared '
        + 'distance, not the boundary maximum. Clusters are peaks within clusterRadiusMm; '
        + 'persistence is the number of distinct directions that produced a peak in the cluster.',
    },
    capability: {
      mayClaim: [
        'hot-spot LOCATIONS that recur across the declared gravity directions',
        'a relative ranking of geometric stress raisers under the declared basis',
      ],
      mayNotClaim: [
        'a strength or safety-factor verdict: the output deliberately has no verdict/delivery field',
        'contact/Hertz stress (a D-flat edge or a thin ring is a boundary condition, not an internal field)',
        'preload, fatigue, creep, buckling, or FDM layer-direction failure',
        'loads outside the declared basis: gravity is a body force, so a pure torque path needs an explicit service load',
        'a member thinner than the voxel: it is smeared into a thicker one and can read safe',
      ],
    },
  };
}
