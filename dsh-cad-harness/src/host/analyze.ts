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
