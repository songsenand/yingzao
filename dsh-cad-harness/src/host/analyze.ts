// The risk-map contract: one normalisation that covers "risk at BOTH extremes" and
// "risk at ONE end", with no cross-quantity weights to invent (user-ratified 2026-10-20).
//
// The transform each detector must declare is a DEAD BAND plus two saturating scales:
//
//        u = -1                u = 0                    u = +1
//     <─── 太薄 ────[ lo ────── 舒适区 ────── hi ]──── 太厚 ────>
//          scaleLo                                  scaleHi
//
//   u = -clamp((lo - v)/scaleLo, 0, 1)      v below the band
//   u = +clamp((v - hi)/scaleHi, 0, 1)      v above the band
//   u = 0                                   inside the band
//
// One-sided risk is just an open band: stress has lo = -Infinity (low stress is not a
// risk), a sharp corner has hi = +Infinity (a blunt corner is not a risk). This is what
// prevents the failure mode of forcing everything into [-1, 1]: a benign low value does
// not light up just because the axis has a negative half.
//
// WHY |u| and not a weighted sum: every quantity becomes "how far from its own comfort
// zone, in units of its own declared scale" — dimensionless and comparable. The fusion
// therefore needs NO cross-unit weights; collapsing it into a single score would
// manufacture a number no one can defend.

export interface BandNorm {
  id: string;
  quantity: string;
  units: string;
  /** Comfortable band [lo, hi]. Use ±Infinity for a one-sided risk. */
  lo: number;
  hi: number;
  /** Distance beyond the band edge at which |u| saturates at 1. Must be finite, > 0. */
  scaleLo: number;
  scaleHi: number;
  /** WHERE lo/hi/scale come from (a declared profile, a material, a stated heuristic). */
  source: string;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** The signed coordinate. Keeps the DIRECTION, which is what the fix depends on. */
export function signedOf(v: number, n: BandNorm): number {
  if (!Number.isFinite(v)) return 0;
  if (n.scaleLo <= 0 || n.scaleHi <= 0) return 0; // a broken declaration must not silently score
  if (v < n.lo) return -clamp01((n.lo - v) / n.scaleLo);
  if (v > n.hi) return clamp01((v - n.hi) / n.scaleHi);
  return 0;
}

/** What the heat map draws: how extreme, direction dropped. */
export function riskOf(v: number, n: BandNorm): number {
  return Math.abs(signedOf(v, n));
}

export interface PointScore {
  layer: string;
  atMm: readonly number[];
  value: number;
  u: number;
}

/** Fusion at ONE location: the worst detector sets the colour, the count says how many
 *  agree. No weighted total, no probability union — both would be claims we cannot back. */
export function fuseAt(scores: readonly PointScore[]): { risk: number; count: number; worst: string | null } {
  let risk = 0;
  let worst: string | null = null;
  let count = 0;
  for (const s of scores) {
    const r = Math.abs(s.u);
    if (r >= 0.5) count += 1; // "this detector finds it at least half-way extreme"
    if (r > risk) { risk = r; worst = s.layer; }
  }
  return { risk, count, worst };
}

// ── v1 wiring: the two layers whose units are ESTABLISHED ─────────────────────
//
// wall  : measured thickness in mm (v ∈ [1.0, 75.1] on the toy-balance pan) -> two-sided band
// corner: reentrant corners from the geometry scan; `u` comes from the detector's own WORD
//         (likely-defect => saturated, check => half) — NOT a re-measured angle, because the
//         scan reports a chain length and a max dihedral in prose, not a number to re-score.
// overhang: NOT CONNECTED in v1 — its sample value spans 0..20 and is not an angle, so
//         normalising it as degrees would be the wrong-units error. Declared, not guessed.

export interface SuspectLike {
  kind?: string;
  where?: { atMm?: number[] };
  atMm?: number[];
  severity?: string;
  dihedralDeg?: number;
}

export interface SampleFieldLike {
  samples?: Record<string, { p: number[]; v: number }[]>;
}

export interface AnalyzePeak {
  atMm: number[];
  risk: number;
  count: number;
  layers: string[];
}

/** Stress (MPa) -> |u|: 0.5 at the declared `warnAt`, 1 at `badAt`; below warn is
 *  comfortable. This is the same 0.5/1.0 split the stress panel uses, not a re-scaled
 *  max: a low absolute stress must stay silent, even if it is the field's maximum. */
export function stressU(v: number, warnAt: number, badAt: number): number {
  if (!Number.isFinite(v) || !(warnAt > 0) || !(badAt > warnAt)) return 0;
  if (v <= 0) return 0;
  if (v <= warnAt) return 0.5 * (v / warnAt);
  if (v >= badAt) return 1;
  return 0.5 + 0.5 * (v - warnAt) / (badAt - warnAt);
}

/** The detector's own word -> how extreme it is. A missing word is treated as half-way:
 *  an unlabelled suspect must not silently score 0 (that would erase it from the map). */
function cornerU(s: SuspectLike, band?: BandNorm): number {
  // MEASURED 2026-10-20: mapping the numeric dihedral straight through the band SILENCED
  // the toy-balance elbows — the scan reports "二面角最大 135°" which equals the band's hi,
  // so u collapses to 0 exactly where the defect is. The direction of that angle
  // (material side vs void side) is not established yet, so the word is still the honest
  // input; `dihedralDeg` is carried for when the calibration is settled.
  void band;
  const w = String(s.severity ?? '');
  if (w === 'likely-defect') return 1;
  if (w === 'check') return 0.5;
  return 0.5;
}

/**
 * Score every detector's points, fuse per location (max |u| + agreement count), and return
 * the peaks sorted by risk. Comfortable points are DROPPED from the peak list (|u| < 0.5):
 * a heat map that lists "the whole part is fine" as a peak is noise, not guidance.
 */
export function analyzeVersion(
  input: {
    suspects?: readonly SuspectLike[];
    field?: SampleFieldLike;
    wallBand: BandNorm;
    cornerBand?: BandNorm;
    cellMm?: number;
    /** The stress run's `von-mises` field, already normalised by its own declared
     *  warn/bad values. Optional: without it the strength layer is `notMapped`, never
     *  silently 0. */
    stress?: {
      samples: { p: number[]; v: number }[];
      /** Local maxima already selected by the stress tool. They are a DETECTION layer
       *  at |u|=0.5 ("look here"), not an allowable claim: a low absolute stress peak
       *  still points at a real concentration. */
      peaks?: { p: number[]; v: number }[];
      warnAt: number;
      badAt: number;
      source: string;
      runId: string;
      loadCase: string;
    };
  },
): { peaks: AnalyzePeak[]; samples: { fused: { p: number[]; v: number }[] }; layers: Record<string, number>; notMapped: string[]; partNotes: { overhangFaces: number; overhangAreaMm2: number; maxWallMm: number; thickSamples: number; thickLimitMm: number; note: string }; stress: { runId: string; loadCase: string; warnAt: number; badAt: number; source: string; concentrationPeaks: number } | null } {
  const cell = input.cellMm ?? 8;
  const key = (p: readonly number[]) => p.map((x) => Math.floor(x / cell)).join(',');
  const buckets = new Map<string, { at: number[]; risk: number; layers: Set<string>; count: number }>();
  const layers: Record<string, number> = {};
  const add = (layer: string, at: readonly number[], u: number) => {
    layers[layer] = (layers[layer] ?? 0) + 1;
    const r = Math.abs(u);
    if (r < 0.5) return; // comfortable is silent
    const k = key(at);
    const b = buckets.get(k) ?? { at: [...at], risk: 0, layers: new Set<string>(), count: 0 };
    if (r > b.risk) b.risk = r;
    if (!b.layers.has(layer)) { b.layers.add(layer); b.count += 1; }
    buckets.set(k, b);
  };

  for (const s of input.suspects ?? []) {
    const at = s.where?.atMm ?? s.atMm;
    if (at && at.length === 3) add(s.kind ?? 'corner', at, cornerU(s, input.cornerBand));
  }
  // OVERHANG IS NOT A PLACE. Measured 2026-10-20 on the toy-balance pan: scoring it per
  // sample as binary "past the limit" painted 1041 of 2871 samples red (the whole rim and
  // bowl underside) and buried the 8 real corner signals — the map stopped guiding
  // attention and started describing the part's shape. Overhang has no "how extreme"
  // gradient (every sample in the layer is already past the limit) and it is a GLOBAL
  // process cost, so it is reported as one number per part (`partNotes`), never as points.
  // The pan's mesh is fine (watertight, 1 body, 2156 tris): the streaks in a viewport are
  // low-poly facet edges, not defects.
  const wallPts = input.field?.samples?.wall ?? [];
  // THIN is a place (thicken HERE); THICK is a region (sink/warp over an area) — the same
  // granularity argument as overhang. Measured on the toy-balance pan: the two-sided band
  // put |u|=1 on every solid mass (the pan body is 75 mm thick, saturating against a 4 mm
  // upper edge), 73 of the peaks were the part describing its own shape. Thin stays a
  // point layer; thick becomes one number per part in `partNotes`.
  let maxWallMm = 0;
  let thickSamples = 0;
  for (const p of wallPts) {
    if (p.p?.length !== 3) continue;
    if (Number.isFinite(p.v)) maxWallMm = Math.max(maxWallMm, p.v);
    if (Number.isFinite(p.v) && p.v > input.wallBand.hi) thickSamples += 1;
    // Only the LOWER side of the band scores points.
    const u = signedOf(p.v, input.wallBand);
    add('wall', p.p, u < 0 ? u : 0);
  }

  // STRENGTH is a POINT question, but only when the stress run says so: the |u| is
  // against the run's declared warnAt/badAt (0.5/1.0), never a re-scaled max. A low
  // absolute stress stays silent even if it is the field's maximum.
  const stressSamples = input.stress?.samples ?? [];
  for (const s of stressSamples) {
    if (s.p?.length !== 3 || !Number.isFinite(s.v)) continue;
    add('strength', s.p, stressU(s.v, input.stress!.warnAt, input.stress!.badAt));
  }
  // A local stress maximum is a DETECTION point even when its absolute value is far
  // below the allowable: "stress concentrates here" is a different question from
  // "this will break". It enters at 0.5 (a look), never as a fake 1.0 risk.
  for (const pk of input.stress?.peaks ?? []) {
    if (pk.p?.length === 3 && Number.isFinite(pk.v)) add('strength-concentration', pk.p, 0.5);
  }

  // The heat map needs EVERY sampled point (including comfortable ones) so the surface
  // is covered; `peaks` is the other view (only where it matters). Same buckets, two
  // projections — never two computations.
  const cellRisk = new Map<string, number>();
  for (const [k, b] of buckets) cellRisk.set(k, b.risk);
  const allPts: { p: number[]; v: number }[] = [];
  for (const p2 of input.field?.samples?.wall ?? []) {
    if (p2.p?.length !== 3) continue;
    allPts.push({ p: p2.p, v: cellRisk.get(key(p2.p)) ?? 0 });
  }
  for (const s2 of stressSamples) {
    if (s2.p?.length !== 3) continue;
    allPts.push({ p: s2.p, v: cellRisk.get(key(s2.p)) ?? 0 });
  }
  for (const pk of input.stress?.peaks ?? []) {
    if (pk.p?.length === 3) allPts.push({ p: pk.p, v: cellRisk.get(key(pk.p)) ?? 0 });
  }
  for (const s2 of input.suspects ?? []) {
    const at = s2.where?.atMm ?? s2.atMm;
    if (at && at.length === 3) allPts.push({ p: [...at], v: cellRisk.get(key(at)) ?? 0 });
  }

  const overhangPts = input.field?.samples?.overhang ?? [];
  // ALWAYS an object: `null` would make "no print-overhang" indistinguishable from "the
  // field was not written" — the exact ambiguity the run report had. Zero is a fact.
  const partNotes: { overhangFaces: number; overhangAreaMm2: number; maxWallMm: number; thickSamples: number; thickLimitMm: number; note: string } = {
    overhangFaces: overhangPts.length,
    overhangAreaMm2: +overhangPts.reduce((a, p) => a + (Number.isFinite(p.v) ? Math.max(0, p.v) : 0), 0).toFixed(1),
    maxWallMm: +maxWallMm.toFixed(2),
    thickSamples,
    thickLimitMm: input.wallBand.hi,
    note:
      overhangPts.length === 0
        ? '无朝下打印悬垂面（按声明角度）：整件打印悬垂事实为 0；薄壁/厚壁仍按 wall 层计。'
        : '打印悬垂与厚壁都是整件/成片性质（要支撑、会缩痕），不是局部风险：它们满布碗底与实体，' +
          '逐点着色会把注意力从真正的信号上引开，所以只作为整件事实报告；逐点层只留薄壁、再入角、强度与应力集中。',
  };

  const peaks = [...buckets.values()]
    .map((b) => ({ atMm: b.at, risk: b.risk, count: b.count, layers: [...b.layers].sort() }))
    .sort((a, b) => b.risk - a.risk || b.count - a.count || 0);
  return {
    peaks,
    samples: { fused: allPts },
    layers,
    notMapped: [],
    partNotes,
    stress: input.stress
      ? {
          runId: input.stress.runId,
          loadCase: input.stress.loadCase,
          warnAt: input.stress.warnAt,
          badAt: input.stress.badAt,
          source: input.stress.source,
          concentrationPeaks: input.stress.peaks?.length ?? 0,
        }
      : null,
  };
}
