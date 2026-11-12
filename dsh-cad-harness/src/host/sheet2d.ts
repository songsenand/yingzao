// 2D cut/bend screen for sheet/plate processes (laser, waterjet, sheet metal).
//
// The subject is a SECTION of a flat part, not a DXF parser: `measure_section`
// already returns the outer ring, every hole (centre, diameter, wall-to-outside)
// and the hole-to-hole clearances as exact geometry. This module turns that
// section into a manufacturing screen with a KERF allowance:
//
//   effective hole    = measured hole diameter - kerf
//   effective feature = measured wall / clearance - kerf
//
// BEND LINES are optional, supplied in the section's own u/v frame. With them the
// screen checks hole-to-bend distance, minimum flange and a bend-relief heuristic.
// It deliberately does NOT claim to compute the flat pattern or K-factor (that
// needs bend angle + thickness + a bend model); those stay handoffs.
//
// Pure function so it can be accepted without the Python worker.

export type SheetPoint = [number, number];

export interface SheetHole {
  id: string;
  kind: string;
  diameterMm?: number;
  enclosingDiameterMm?: number;
  wallToOuterMm: number;
  centerWorldMm: [number, number, number];
  /** Section u/v centre (present for bend checks). */
  centerUv?: SheetPoint;
  /** Section u/v ring (present for non-circular holes). */
  pointsUv?: SheetPoint[];
}

export interface SheetPolygon {
  id: string;
  holes: SheetHole[];
  outer?: { pointsUv: SheetPoint[] };
}

export interface SheetSpacing {
  from: string;
  to: string;
  clearanceMm: number;
}

export interface SheetBendLine {
  from: SheetPoint;
  to: SheetPoint;
}

export interface SheetSection {
  polygons: SheetPolygon[];
  holeSpacing: SheetSpacing[];
  holeCount: number;
  empty?: boolean;
}

export interface Sheet2dParams {
  kerfMm: number;
  minHoleMm: number;
  minFeatureMm: number;
  minSpacingMm: number;
  /** Optional bend lines in the section's u/v frame. */
  bendLines?: SheetBendLine[];
  minHoleToBendMm?: number;
  minFlangeMm?: number;
  minBendReliefMm?: number;
}

export type Sheet2dRule = 'min-hole' | 'min-feature' | 'min-spacing' | 'hole-to-bend' | 'min-flange' | 'bend-relief';

export interface Sheet2dWitness {
  rule: Sheet2dRule;
  measured: number;
  required: number;
  unit: 'mm';
  locationMm?: [number, number, number];
  note?: string;
}

export interface Sheet2dAnalysis {
  verdict: 'excluded' | 'not-excluded';
  witnesses: Sheet2dWitness[];
  findings: string[];
  unevaluable: string[];
  metrics: {
    holes: number;
    roundHoles: number;
    nonCircularHoles: number;
    minHoleEffectiveMm?: number;
    minFeatureEffectiveMm?: number;
    minSpacingEffectiveMm?: number;
    kerfMm: number;
    bendLines: number;
    minHoleToBendMm?: number;
    minFlangeMm?: number;
    minBendReliefMm?: number;
  };
}

const round3 = (v: number) => +v.toFixed(3);

function pointSegmentDistance(p: SheetPoint, a: SheetPoint, b: SheetPoint): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function pointPolylineDistance(p: SheetPoint, pts: SheetPoint[]): number {
  if (pts.length === 0) return Infinity;
  if (pts.length === 1) return Math.hypot(p[0] - pts[0]![0], p[1] - pts[0]![1]);
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    best = Math.min(best, pointSegmentDistance(p, pts[i]!, pts[(i + 1) % pts.length]!));
  }
  return best;
}

function pointLineDistance(p: SheetPoint, a: SheetPoint, b: SheetPoint): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len <= 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
}

function circlePoints(center: SheetPoint, diameterMm: number): SheetPoint[] {
  const r = diameterMm / 2;
  if (!(r > 0)) return [];
  return Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * Math.PI * 2;
    return [center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)] as SheetPoint;
  });
}

/**
 * Analyze a section for a 2D cut/bend process.
 *
 * A witness is a counter-example (measured outside the declared allowance),
 * never a score. `not-excluded` means "this section produced no counter-example",
 * not "the part is cuttable" — uncovered cases are listed in `unevaluable`.
 */
export function analyzeSheet2d(section: SheetSection, params: Sheet2dParams): Sheet2dAnalysis {
  const findings: string[] = [];
  const unevaluable: string[] = [];
  const witnesses: Sheet2dWitness[] = [];
  const { kerfMm, minHoleMm, minFeatureMm, minSpacingMm } = params;
  const bendLines = params.bendLines ?? [];

  let roundHoles = 0;
  let nonCircularHoles = 0;
  let minHoleEffective: number | undefined;
  let minFeatureEffective: number | undefined;
  let minSpacingEffective: number | undefined;

  const metricsBase = {
    holes: section.holeCount,
    roundHoles: 0,
    nonCircularHoles: 0,
    minHoleEffectiveMm: undefined as number | undefined,
    minFeatureEffectiveMm: undefined as number | undefined,
    minSpacingEffectiveMm: undefined as number | undefined,
    kerfMm,
    bendLines: bendLines.length,
    ...(params.minHoleToBendMm !== undefined ? { minHoleToBendMm: params.minHoleToBendMm } : {}),
    ...(params.minFlangeMm !== undefined ? { minFlangeMm: params.minFlangeMm } : {}),
    ...(params.minBendReliefMm !== undefined ? { minBendReliefMm: params.minBendReliefMm } : {}),
  };

  if (section.empty) {
    findings.push('该截面为空：平面没有切到实体，本报告不构成任何 2D 结论。');
    return {
      verdict: 'not-excluded',
      witnesses: [],
      findings,
      unevaluable: ['empty section'],
      metrics: metricsBase,
    };
  }

  for (const poly of section.polygons) {
    for (const hole of poly.holes) {
      if (hole.kind === 'round') {
        const d = hole.diameterMm ?? hole.enclosingDiameterMm;
        if (d === undefined || !Number.isFinite(d)) {
          unevaluable.push(`孔 ${hole.id} 是圆孔但缺少直径`);
        } else {
          roundHoles++;
          const effective = round3(d - kerfMm);
          minHoleEffective = minHoleEffective === undefined ? effective : Math.min(minHoleEffective, effective);
          if (effective < minHoleMm) {
            witnesses.push({
              rule: 'min-hole', measured: effective, required: minHoleMm, unit: 'mm',
              locationMm: hole.centerWorldMm,
              note: `圆孔 Ø${round3(d)} − 割缝 ${kerfMm} = Ø${effective}`,
            });
          }
        }
      } else {
        nonCircularHoles++;
      }
      if (Number.isFinite(hole.wallToOuterMm)) {
        const effective = round3(hole.wallToOuterMm - kerfMm);
        minFeatureEffective = minFeatureEffective === undefined ? effective : Math.min(minFeatureEffective, effective);
        if (effective < minFeatureMm) {
          witnesses.push({
            rule: 'min-feature', measured: effective, required: minFeatureMm, unit: 'mm',
            locationMm: hole.centerWorldMm,
            note: `孔 ${hole.id} 到外轮廓 ${round3(hole.wallToOuterMm)} − 割缝 ${kerfMm} = ${effective}`,
          });
        }
      }
    }
  }

  for (const s of section.holeSpacing) {
    if (!Number.isFinite(s.clearanceMm)) continue;
    const effective = round3(s.clearanceMm - kerfMm);
    minSpacingEffective = minSpacingEffective === undefined ? effective : Math.min(minSpacingEffective, effective);
    if (effective < minSpacingMm) {
      witnesses.push({
        rule: 'min-spacing', measured: effective, required: minSpacingMm, unit: 'mm',
        note: `孔 ${s.from} ↔ ${s.to} 间隙 ${round3(s.clearanceMm)} − 割缝 ${kerfMm} = ${effective}`,
      });
    }
  }

  // ── bend checks (only when bend lines are supplied) ───────────────────────
  if (bendLines.length > 0) {
    const outerPoints = section.polygons.flatMap((p) => p.outer?.pointsUv ?? []);
    const holeBoundary: SheetPoint[] = [];
    for (const poly of section.polygons) {
      for (const h of poly.holes) {
        if (h.pointsUv?.length) holeBoundary.push(...h.pointsUv);
        const d = h.diameterMm ?? h.enclosingDiameterMm;
        if (h.centerUv && d !== undefined) holeBoundary.push(...circlePoints(h.centerUv, d));
      }
    }
    const boundary = [...outerPoints, ...holeBoundary];

    for (const line of bendLines) {
      if (params.minHoleToBendMm !== undefined) {
        for (const poly of section.polygons) {
          for (const h of poly.holes) {
            if (!h.centerUv) continue;
            const d = pointSegmentDistance(h.centerUv, line.from, line.to);
            if (d < params.minHoleToBendMm) {
              witnesses.push({
                rule: 'hole-to-bend', measured: round3(d), required: params.minHoleToBendMm, unit: 'mm',
                locationMm: h.centerWorldMm,
                note: `孔 ${h.id} 到折弯线 ${round3(d)} < ${params.minHoleToBendMm}`,
              });
            }
          }
        }
      }
      if (params.minFlangeMm !== undefined && outerPoints.length > 0) {
        // Flange = material between the bend line and the free edge, measured
        // PERPENDICULAR to the bend. Points on the line itself are the bend's
        // own ends, not a flange, so they are ignored.
        let flange = Infinity;
        for (const p of outerPoints) {
          const d = pointLineDistance(p, line.from, line.to);
          if (d > 1e-6) flange = Math.min(flange, d);
        }
        if (Number.isFinite(flange) && flange < params.minFlangeMm) {
          witnesses.push({
            rule: 'min-flange', measured: round3(flange), required: params.minFlangeMm, unit: 'mm',
            note: `折弯线到最近的自由边（垂距）${round3(flange)} < 最小翻边 ${params.minFlangeMm}`,
          });
        }
      }
      if (params.minBendReliefMm !== undefined && boundary.length > 0) {
        for (const end of [line.from, line.to]) {
          const d = pointPolylineDistance(end, boundary);
          if (Number.isFinite(d) && d > params.minBendReliefMm) {
            witnesses.push({
              rule: 'bend-relief', measured: round3(d), required: params.minBendReliefMm, unit: 'mm',
              note: `折弯线端点离最近的自由边/孔 ${round3(d)} > 让位宽 ${params.minBendReliefMm}：端点在材料内，可能没有让位（启发式）`,
            });
          }
        }
      }
    }
    findings.push(
      '折弯检查是启发式：孔到折弯线用孔心到线段距离；最小翻边用外轮廓点到折弯线的垂距（忽略线上的点）；' +
      '折弯让位只判断“端点是否靠近自由边/孔”，不建让位槽模型。',
    );
    unevaluable.push('flat pattern / K-factor (needs bend angle + thickness)', 'bend relief notch geometry');
  } else {
    findings.push('未提供 bendLines：只做 2D 切割检查，折弯相关判据未行使。');
  }

  if (nonCircularHoles > 0) {
    unevaluable.push(
      `${nonCircularHoles} 个非圆孔（槽/多边形）的**最小宽度**未测量；min-hole 只对圆孔生效。`,
    );
  }
  findings.push(
    `2D 切割筛查基于一个截面（${section.holeCount} 个孔）：只检查圆孔直径、孔到外轮廓、孔间距，` +
    '并扣除割缝。非圆孔宽度、外轮廓窄筋、折弯让位、展开图/K 因子、热影响区/锥度不在本报告内。',
  );
  if (roundHoles === 0) {
    findings.push('本截面没有圆孔：min-hole 规则未被行使，不能据此认为孔都合格。');
  }

  return {
    verdict: witnesses.length > 0 ? 'excluded' : 'not-excluded',
    witnesses,
    findings,
    unevaluable,
    metrics: {
      ...metricsBase,
      roundHoles,
      nonCircularHoles,
      ...(minHoleEffective !== undefined ? { minHoleEffectiveMm: minHoleEffective } : {}),
      ...(minFeatureEffective !== undefined ? { minFeatureEffectiveMm: minFeatureEffective } : {}),
      ...(minSpacingEffective !== undefined ? { minSpacingEffectiveMm: minSpacingEffective } : {}),
    },
  };
}
