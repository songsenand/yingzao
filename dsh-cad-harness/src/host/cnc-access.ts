// CNC 3-axis access / setup screen.
//
// The mesh is sampled and each sampled face is tested for visibility from the six
// principal directions (±X, ±Y, ±Z). A face is "accessible" from a direction when
// it faces that direction and the first ray hit from outside is the face itself.
//
// Two facts come out:
//   - area reachable from no principal direction (true undercut for this screen);
//   - the minimum number of principal setups needed to cover the accessible area
//     (greedy set cover).
//
// This is deliberately NOT a CAM check: oblique setups, tool length/diameter,
// fixture rigidity and chatter are handoffs. A part can be machinable with an
// angled setup even when this screen reports inaccessible area; that is why
// inaccessible area is a warning unless `requireAllAccessible` is true.

export interface CncAccessMetrics {
  sampled: number;
  areaMm2: number;
  accessiblePct: number;
  /** Area reachable from +spindleAxis (the "top" setup). */
  topAccessiblePct: number;
  inaccessiblePct: number;
  setupsNeeded: number;
  setupDirs: string[];
  /** Area reachable from each direction, for the report. */
  directionAreaMm2: { direction: string; areaMm2: number }[];
}

export interface CncAccessParams {
  maxSetups: number;
  requireAllAccessible: boolean;
}

export interface CncAccessWitness {
  rule: 'setup-count' | 'tool-access';
  measured: number;
  required: number;
  unit: 'count' | '%';
  note?: string;
}

export interface CncAccessAnalysis {
  verdict: 'excluded' | 'not-excluded';
  witnesses: CncAccessWitness[];
  findings: string[];
  unevaluable: string[];
  metrics: CncAccessMetrics;
}

const round3 = (v: number) => +v.toFixed(3);

export function analyzeCncAccess(metrics: CncAccessMetrics, params: CncAccessParams): CncAccessAnalysis {
  const witnesses: CncAccessWitness[] = [];
  const findings: string[] = [];
  const unevaluable: string[] = [
    'oblique/diagonal setups',
    'tool length/diameter and collision',
    'fixturing / fixture rigidity',
    'chatter / deflection',
  ];

  if (metrics.setupsNeeded > params.maxSetups) {
    witnesses.push({
      rule: 'setup-count', measured: metrics.setupsNeeded, required: params.maxSetups, unit: 'count',
      note: `最少需要 ${metrics.setupsNeeded} 个主方向装夹，上限 ${params.maxSetups}`,
    });
  }
  if (metrics.inaccessiblePct > 0) {
    if (params.requireAllAccessible) {
      witnesses.push({
        rule: 'tool-access', measured: round3(metrics.inaccessiblePct), required: 0, unit: '%',
        note: `${round3(metrics.inaccessiblePct)}% 面积从六个主方向都不可达`,
      });
    } else {
      findings.push(
        `${round3(metrics.inaccessiblePct)}% 面积从 ±X/±Y/±Z 都不可达：可能是倒扣/封闭腔，` +
        '也可能只是需要一个斜装夹或第四轴。默认是警告；若要求三轴六面全可达，设 requireAllAccessible:true。',
      );
    }
  }
  findings.push(
    `六方向可见性：最少 ${metrics.setupsNeeded} 个主方向装夹（${metrics.setupDirs.join(', ') || '无'}）；` +
    `仅 +主轴方向可达 ${round3(metrics.topAccessiblePct)}%。` +
    '斜装夹、刀具长度/直径、夹具刚性、振刀都不在本报告内。',
  );

  return {
    verdict: witnesses.length > 0 ? 'excluded' : 'not-excluded',
    witnesses,
    findings,
    unevaluable,
    metrics: {
      ...metrics,
      accessiblePct: round3(metrics.accessiblePct),
      topAccessiblePct: round3(metrics.topAccessiblePct),
      inaccessiblePct: round3(metrics.inaccessiblePct),
    },
  };
}
