// EDM sinker electrode access: single-axis line of sight.
//
// A sinker EDM burns along ONE axis. This screen samples the mesh and asks: from
// far outside along the declared burn axis, is the first surface hit the sample
// itself? If another surface is hit first, that area cannot be reached by an
// electrode travelling straight down that axis.
//
// It is NOT an electrode-shape/undercut model: a reachable line of sight does not
// prove the electrode can be made or withdrawn, and inaccessible area may be
// reachable with a different burn axis or a shaped electrode. Those are handoffs.

export interface EdmAccessMetrics {
  sampled: number;
  areaMm2: number;
  reachablePct: number;
  inaccessiblePct: number;
  burnAxis: string;
}

export interface EdmAccessParams {
  requireAllReachable: boolean;
}

export interface EdmAccessWitness {
  rule: 'electrode-access';
  measured: number;
  required: number;
  unit: '%';
  note?: string;
}

export interface EdmAccessAnalysis {
  verdict: 'excluded' | 'not-excluded';
  witnesses: EdmAccessWitness[];
  findings: string[];
  unevaluable: string[];
  metrics: EdmAccessMetrics;
}

const round3 = (v: number) => +v.toFixed(3);

export function analyzeEdmAccess(metrics: EdmAccessMetrics, params: EdmAccessParams): EdmAccessAnalysis {
  const witnesses: EdmAccessWitness[] = [];
  const findings: string[] = [];
  const unevaluable = [
    'electrode shape / side-burn / undercut',
    'electrode wear and replacement',
    'minimum feature / electrode diameter',
    'surface finish / burn parameters',
  ];

  if (metrics.inaccessiblePct > 0 && params.requireAllReachable) {
    witnesses.push({
      rule: 'electrode-access', measured: round3(metrics.inaccessiblePct), required: 0, unit: '%',
      note: `${round3(metrics.inaccessiblePct)}% 面积沿 ${metrics.burnAxis} 轴被遮挡`,
    });
  } else if (metrics.inaccessiblePct > 0) {
    findings.push(
      `${round3(metrics.inaccessiblePct)}% 面积沿 ${metrics.burnAxis} 轴不可达：可能需要换 burn axis、` +
      '成形电极或先开粗。默认是警告；若要求单轴全可达，设 requireAllReachable:true。',
    );
  }
  findings.push(
    `单轴电极可达：沿 ${metrics.burnAxis} 轴的首次命中必须是该面本身；可达 ${round3(metrics.reachablePct)}%，` +
    `不可达 ${round3(metrics.inaccessiblePct)}%。电极形状/侧蚀/最小特征/损耗不在本报告内。`,
  );

  return {
    verdict: witnesses.length > 0 ? 'excluded' : 'not-excluded',
    witnesses,
    findings,
    unevaluable,
    metrics: {
      ...metrics,
      reachablePct: round3(metrics.reachablePct),
      inaccessiblePct: round3(metrics.inaccessiblePct),
    },
  };
}
