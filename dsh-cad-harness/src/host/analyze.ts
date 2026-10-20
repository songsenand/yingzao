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
  input: { suspects?: readonly SuspectLike[]; field?: SampleFieldLike; wallBand: BandNorm; cornerBand?: BandNorm; cellMm?: number },
): { peaks: AnalyzePeak[]; layers: Record<string, number>; notMapped: string[] } {
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
  const wallPts = input.field?.samples?.wall ?? [];
  for (const p of wallPts) if (p.p?.length === 3) add('wall', p.p, signedOf(p.v, input.wallBand));

  const peaks = [...buckets.values()]
    .map((b) => ({ atMm: b.at, risk: b.risk, count: b.count, layers: [...b.layers].sort() }))
    .sort((a, b) => b.risk - a.risk || b.count - a.count || 0);
  return { peaks, layers, notMapped: ['overhang (sample value 0..20 is not an angle — units not established)'] };
}
