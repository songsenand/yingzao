// Geometry sanity for a simulated scene: is every part actually AT the machine?
//
// WHY (2026-10-28): fructose-molecule r013 ran a mechanism whose "Base" and
// "Crank" were two 12-triangle cubes parked at (500,500). It reported
// `pass · 干涉 0 次`, the title said "… + Crank + Base", and the keyframe images
// (which the model DID see) looked like a sparse scene rather than an error. An
// image cannot be checked; this file produces the numbers that can.
//
// THE CRITERION IS A RATIO, NOT A DISTANCE (user, 2026-10-28): "离群的判定标准
// 应该是最近距离和零件尺寸之间的比例，而不应该是固定距离". A fixed 200mm would
// flag a large machine's normal spacing and would NOT flag a 3mm pin lost 50mm
// away. So:
//
//     ratio(part) = gap to the nearest other part ÷ the part's own bbox diagonal
//     suspect     = ratio > 5        (declared, reported with every line)
//
// and a part of ≤24 triangles is reported as SIMPLE BOX geometry (a box is 12: two
// triangles per face) — worded as a fact, because a spacer that IS a box is
// legitimate and only the human knows whether this one is a dummy.
//
// It is a FACT, not a verdict: nothing here changes pass/fail. A far-away part
// that is jointed to the mechanism may be legitimate (a long link), so
// `connected` travels with the line and the reader decides.

export const SUSPECT_RATIO = 5;
export const PLACEHOLDER_TRIANGLES = 24;

/** The rule, in words, so a report can state what it applied. */
export const SUSPECT_RULE =
  `离群 = 与最近零件的间隙 ÷ 自身包围盒对角线 > ${SUSPECT_RATIO}；` +
  `简单盒体 = ≤ ${PLACEHOLDER_TRIANGLES} 个三角面（立方体是 12 个）`;

/**
 * The world AABB of a solid placed with `position` and `rotation` (Euler degrees,
 * R = Rz·Ry·Rx — the same composition merge_parts and the engine use). The box is
 * of the ROTATED solid, not the rotated box's original extents.
 */
export function transformedAabb(
  local: { min: [number, number, number]; max: [number, number, number] },
  position?: [number, number, number],
  rotationDeg?: [number, number, number],
): { min: [number, number, number]; max: [number, number, number] } {
  const [rx, ry, rz] = (rotationDeg ?? [0, 0, 0]).map((d) => (d * Math.PI) / 180);
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  const t = position ?? [0, 0, 0];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const rotate = (x: number, y: number, z: number): [number, number, number] => {
    const ax = x;                            // Rx
    const ay = y * cx - z * sx;
    const az = y * sx + z * cx;
    const bx = ax * cy + az * sy;            // Ry
    const bz = -ax * sy + az * cy;
    return [bx * cz - ay * sz + t[0], bx * sz + ay * cz + t[1], bz + t[2]]; // Rz + translate
  };
  for (const x of [local.min[0], local.max[0]]) {
    for (const y of [local.min[1], local.max[1]]) {
      for (const z of [local.min[2], local.max[2]]) {
        const p = rotate(x, y, z);
        for (let i = 0; i < 3; i++) {
          if (p[i]! < min[i]!) min[i] = p[i]!;
          if (p[i]! > max[i]!) max[i] = p[i]!;
        }
      }
    }
  }
  return { min, max };
}

export interface SceneSolid {
  name: string;
  triangles: number;
  /** Axis-aligned bounds in the world pose the run starts from, mm. */
  min: [number, number, number];
  max: [number, number, number];
  /** Named by any joint / oscillator / drive (a far part may be legitimate). */
  connected?: boolean;
}

export interface SuspectPart {
  name: string;
  /** Surface gap to the nearest other part (0 when the boxes overlap), mm. */
  gapMm: number;
  /** The part's own bbox diagonal, the yardstick the gap is judged against. */
  sizeMm: number;
  ratio: number;
  triangles: number;
  connected: boolean;
  reasons: string[];
  /**
   * True when this is a WARNING (placement: 离群, or a degenerate box), false when
   * it is a NOTE (simple box geometry — a spacer that is a box is legitimate).
   * Only warnings move the run to `check`; a note must not make every plate-shaped
   * part look suspicious, or the warning becomes wallpaper.
   */
  warn: boolean;
}

const boxGap = (a: SceneSolid, b: SceneSolid): number => {
  let sum = 0;
  for (let k = 0; k < 3; k++) {
    const gap = Math.max(0, Math.max(a.min[k]! - b.max[k]!, b.min[k]! - a.max[k]!));
    sum += gap * gap;
  }
  return Math.sqrt(sum);
};

const sizeOf = (s: SceneSolid): number =>
  Math.hypot(s.max[0] - s.min[0], s.max[1] - s.min[1], s.max[2] - s.min[2]);

/** Every part that is far from everything (by its OWN size) or is a placeholder. */
export function suspectParts(solids: SceneSolid[]): SuspectPart[] {
  const out: SuspectPart[] = [];
  if (solids.length === 0) return out;
  for (const s of solids) {
    const size = sizeOf(s);
    // A part with no extent is a mesh problem, not a placement one: report it,
    // but do not divide by zero to produce an infinite ratio.
    const degenerate = !(size > 1e-6);
    const others = solids.filter((o) => o !== s);
    const gap = degenerate || others.length === 0
      ? 0
      : Math.min(...others.map((o) => boxGap(s, o)));
    const ratio = degenerate || !(size > 1e-6) ? 0 : gap / size;
    const reasons: string[] = [];
    if (degenerate) reasons.push('包围盒为零（网格异常）');
    else if (others.length > 0 && ratio > SUSPECT_RATIO) reasons.push(`离群 ${ratio.toFixed(1)}×`);
    // Factual, not a judgement: a spacer that IS a box is legitimate, and calling
    // it "placeholder" would be the panel deciding what the designer meant.
    if (s.triangles > 0 && s.triangles <= PLACEHOLDER_TRIANGLES) reasons.push(`简单盒体（${s.triangles} 个三角面）`);
    if (reasons.length === 0) continue;
    out.push({
      name: s.name,
      gapMm: +gap.toFixed(1),
      sizeMm: +size.toFixed(1),
      ratio: +ratio.toFixed(2),
      triangles: s.triangles,
      connected: Boolean(s.connected),
      reasons,
      warn: degenerate || (others.length > 0 && ratio > SUSPECT_RATIO),
    });
  }
  return out;
}

/** One line per suspect, with the numbers that justify it (never just "suspicious"). */
export function formatSuspects(suspects: SuspectPart[]): string[] {
  return suspects.map((s) =>
    `${s.name}：距最近零件 ${s.gapMm}mm ÷ 自身 ${s.sizeMm}mm = ${s.ratio}×` +
    (s.reasons.length ? ` — ${s.reasons.join('，')}` : '') +
    (s.connected ? '（有关节/驱动连接）' : '（无任何连接）'),
  );
}
