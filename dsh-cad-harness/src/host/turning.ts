// Turning screen: bar-stock fit, L/D and rotational symmetry about the spindle.
//
// A lathe makes surfaces of revolution. The screen can decide three geometric
// facts from the mesh:
//   - the maximum diameter must fit the declared bar stock;
//   - length / diameter must stay within the declared L/D;
//   - every surface point must map onto the surface under 90/180/270° rotation
//     (deviation is the distance from the rotated point to the nearest surface).
//
// Undercuts and tool access along the profile are NOT measured here; they need a
// radial-profile/tool-shape evaluator. They are reported as handoffs, never as pass.
//
// Pure function: the tool computes the metrics (mesh + BVH) and this module judges.

export interface TurningParams {
  barDiameterMm: number;
  maxLdRatio: number;
  symmetryToleranceMm: number;
  /** When true, symmetry deviation is a witness; when false, a warning/finding. */
  requireSymmetry: boolean;
}

export interface TurningMetrics {
  maxDiameterMm: number;
  lengthMm: number;
  ldRatio: number;
  symmetryMaxDeviationMm: number;
  sampled: number;
  watertight: boolean;
}

export interface TurningWitness {
  rule: 'bar-stock-fit' | 'ld-ratio' | 'rotational-symmetry';
  measured: number;
  required: number;
  unit: 'mm' | 'ratio';
  note?: string;
}

export interface TurningAnalysis {
  verdict: 'excluded' | 'not-excluded';
  witnesses: TurningWitness[];
  findings: string[];
  unevaluable: string[];
  metrics: TurningMetrics;
}

const round3 = (v: number) => +v.toFixed(3);

export function analyzeTurning(metrics: TurningMetrics, params: TurningParams): TurningAnalysis {
  const witnesses: TurningWitness[] = [];
  const findings: string[] = [];
  const unevaluable: string[] = [];

  if (metrics.maxDiameterMm > params.barDiameterMm) {
    witnesses.push({
      rule: 'bar-stock-fit', measured: round3(metrics.maxDiameterMm), required: params.barDiameterMm, unit: 'mm',
      note: `最大直径 ${round3(metrics.maxDiameterMm)} > 棒料 ${params.barDiameterMm}`,
    });
  }
  if (metrics.ldRatio > params.maxLdRatio) {
    witnesses.push({
      rule: 'ld-ratio', measured: round3(metrics.ldRatio), required: params.maxLdRatio, unit: 'ratio',
      note: `L/D ${round3(metrics.ldRatio)} > 上限 ${params.maxLdRatio}`,
    });
  }
  if (metrics.symmetryMaxDeviationMm > params.symmetryToleranceMm) {
    if (params.requireSymmetry) {
      witnesses.push({
        rule: 'rotational-symmetry', measured: round3(metrics.symmetryMaxDeviationMm), required: params.symmetryToleranceMm, unit: 'mm',
        note: `回转偏差 ${round3(metrics.symmetryMaxDeviationMm)} > 容差 ${params.symmetryToleranceMm}`,
      });
    } else {
      findings.push(
        `回转偏差 ${round3(metrics.symmetryMaxDeviationMm)}mm 超过容差 ${params.symmetryToleranceMm}mm：` +
        '该件不是纯回转体，车削不能单独完成所有表面（需要二次铣削/车铣复合）。' +
        '若这是有意为之，保持 requireSymmetry:false；若要把它当否决，设 requireSymmetry:true。',
      );
    }
  }
  if (!metrics.watertight) {
    findings.push('网格不是封闭实体：直径/L/D 仍按包围盒计算，回转偏差的最近点查询在开放网格上可能不可靠。');
  }
  findings.push(
    '回转对称是绕“经过包围盒中心的声明主轴”测的；不搜索其他轴偏置。',
  );
  findings.push(
    '车削筛查只回答棒料直径、L/D、回转对称偏差；倒扣、沿轮廓的刀具可达、振刀/让刀、表面、送料限制不在本报告内。',
  );
  unevaluable.push('undercut / tool access along the profile', 'chatter / surface / bar feeder');

  return {
    verdict: witnesses.length > 0 ? 'excluded' : 'not-excluded',
    witnesses,
    findings,
    unevaluable,
    metrics: {
      ...metrics,
      maxDiameterMm: round3(metrics.maxDiameterMm),
      lengthMm: round3(metrics.lengthMm),
      ldRatio: round3(metrics.ldRatio),
      symmetryMaxDeviationMm: round3(metrics.symmetryMaxDeviationMm),
    },
  };
}
