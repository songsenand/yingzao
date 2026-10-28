/**
 * What a simulation run actually says, in the few numbers a human needs before
 * deciding whether to trust it.
 *
 * One source for both surfaces: the playback strip (compact) and the 报告 tab
 * (detailed). The report is the truth — this module never recomputes geometry and
 * never invents a value that is absent; a missing number renders as "—".
 */

export type RunTone = 'ok' | 'warn' | 'bad' | 'muted';

export interface RunFact {
  label: string;
  value: string;
  tone?: RunTone;
  /** Native tooltip, e.g. why a coverage number matters. */
  title?: string;
}

export interface RunEvent {
  timeSec: number;
  label: string;
  tone?: RunTone;
}

export interface RunKeyframe {
  step?: number;
  timeSec: number;
  label: string;
}

/**
 * The geometry-sanity warning as a data-strip chip (and the sentence for the
 * summary). A compiler-style warning: the run succeeded, but its numbers may
 * describe an empty field (a part parked 500mm away makes "0 interference"
 * unearned). The rule rides in the tooltip, because a warning nobody can
 * re-derive is just noise.
 */
const geometrySuspectFact = (report: any): RunFact | null => {
  const lines = (report?.metrics?.geometrySuspects ?? []) as string[];
  // Only WARNINGS get a chip. A "simple box" note must not paint every plate
  // yellow, or the warning becomes wallpaper; those notes stay in the tool reply.
  const warnCount = Number(report?.metrics?.geometrySuspectWarn ?? 0);
  if (!Array.isArray(lines) || lines.length === 0 || !(warnCount > 0)) return null;
  const rule = String(report?.metrics?.geometrySuspectRule ?? '');
  return {
    label: '几何',
    value: `⚠ ${warnCount} 处`,
    tone: 'warn',
    title: [rule, ...lines].filter(Boolean).join('\n'),
  };
};

export interface RunFacts {
  tone: RunTone;
  headline: string;
  /** One sentence: what this means / what to do next. */
  summary: string;
  facts: RunFact[];
  events: RunEvent[];
  keyframes: RunKeyframe[];
}

const none = '—';

const num = (v: unknown, digits = 2): string => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return none;
  const fixed = n.toFixed(digits);
  return fixed.replace(/\.?0+$/, '') || '0';
};

const pct = (v: unknown): string => {
  const n = typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? `${num(n * 100, 1)}%` : none;
};

const statusTone = (status?: string): RunTone =>
  status === 'pass' ? 'ok' : status === 'fail' ? 'bad' : status === 'check' ? 'warn' : 'muted';

const keyframesOf = (report: any): RunKeyframe[] =>
  (Array.isArray(report?.keyframes) ? report.keyframes : [])
    .filter((k: any) => Number.isFinite(k?.timeSec))
    .map((k: any) => ({ step: k.step, timeSec: k.timeSec, label: String(k.label ?? 'frame') }))
    .sort((a: RunKeyframe, b: RunKeyframe) => a.timeSec - b.timeSec);

const motionEvents = (report: any): RunEvent[] => {
  const m = report?.metrics ?? {};
  const detailed = Array.isArray(m.interferenceEvents) ? m.interferenceEvents : [];
  if (detailed.length > 0) {
    return detailed
      .filter((e: any) => Number.isFinite(e?.timeSec))
      .map((e: any) => ({
        timeSec: e.timeSec,
        label: `干涉 ${e.partA ?? '?'} ↔ ${e.partB ?? '?'}${Number.isFinite(e.volumeMm3) ? ` ${num(e.volumeMm3, 1)}mm³` : ''}`,
        tone: 'bad' as const,
      }));
  }
  return (report?.trajectory?.events ?? [])
    .filter((e: any) => Number.isFinite(e?.timeSec))
    .map((e: any) => ({ timeSec: e.timeSec, label: String(e.label ?? '事件'), tone: 'bad' as const }));
};

const physicsEvents = (report: any): RunEvent[] =>
  (report?.trajectory?.events ?? [])
    .filter((e: any) => Number.isFinite(e?.timeSec))
    .filter((e: any) => !/^(start|final|context|crank\d+)/i.test(String(e.label ?? '')))
    .map((e: any) => ({
      timeSec: e.timeSec,
      label: String(e.label ?? '事件'),
      tone: /倾倒|穿透|违规/.test(String(e.label)) ? 'warn' as const : 'muted' as const,
    }));

/** The common facts for any run kind. `status` is the run's own verdict. */
export function runFacts(kind: string, report: any, status?: string): RunFacts | null {
  if (!report) return null;
  const m = report.metrics ?? {};
  const keyframes = keyframesOf(report);
  const baseTone = statusTone(status ?? report.overallStatus);

  if (kind === 'motion') {
    const followers = Object.entries((m.followers ?? {}) as Record<string, any>);
    const first = followers[0]?.[1] as any;
    const checks = typeof m.interferenceChecks === 'number' ? m.interferenceChecks : null;
    const satisfied = m.samplingSatisfied;
    const interference = typeof m.interferenceCount === 'number' ? m.interferenceCount : null;
    const drift = typeof m.maxJointDriftMm === 'number' ? m.maxJointDriftMm : null;
    // Old runs sampled only the start pose (sampleEvery > stepsRun). The report
    // still says "duration 0.38s" and "0 interference"; playback is a still
    // image, so say that instead of letting the numbers imply a sweep.
    const poses = Array.isArray(report.trajectory?.times) ? report.trajectory.times.length : null;
    const singlePose = poses != null && poses < 2;
    const bad = status === 'fail' || (interference ?? 0) > 0;
    const tone: RunTone = bad ? 'bad'
      : baseTone === 'ok' && checks != null && satisfied === true ? 'ok' : 'warn';
    const facts: RunFact[] = [
      { label: '时长', value: `${num(report.durationSec, 2)}s` },
      ...(singlePose ? [{
        label: '位姿',
        value: `${poses} 帧`,
        tone: 'warn' as const,
        title: '少于 2 个采样位姿：回放只有一张静止图，不能作为运动/净空证据；重跑会按至少 24 个位姿采。',
      }] : []),
      { label: '干涉', value: interference == null ? none : `${interference} 次`, tone: bad ? 'bad' : 'ok' },
      {
        label: '采样',
        value: checks == null ? none : `${checks}/24`,
        tone: checks == null || satisfied === false ? 'warn' : 'ok',
        title: checks == null
          ? '这个报告没有 coverage 字段（旧 run）：无法从报告证明采样密度'
          : satisfied === false
            ? '少于 24 个采样位姿：这次 run 的“0 干涉”不是证据'
            : '采样位姿数 / 最低要求；每个位姿对每对候选零件做一次布尔检查',
      },
      {
        label: '漂移',
        value: drift == null ? none : `${num(drift, 2)}mm`,
        tone: drift != null && drift > 2 ? 'warn' : 'ok',
        title: '关节锚点在末态的轴向偏差；超过 2mm 时求解器可能已经掩盖了装配错误',
      },
    ];
    const geoSuspect = geometrySuspectFact(report);
    if (geoSuspect) facts.push(geoSuspect);
    if (first) {
      facts.push({ label: '行程', value: `${num(first.travelMm, 1)}mm`, title: `${followers[0]![0]} 的 ${first.axis ?? '?'} 向行程` });
      if (Number.isFinite(first.periodSec)) facts.push({ label: '周期', value: `${num(first.periodSec, 2)}s` });
    }
    const legacyCoverage = checks == null;
    const singleNote = singlePose ? ` 这个 run 只有 ${poses} 个采样位姿，事件时间线也不完整。` : '';
    const summary = bad
      ? `不可交付：${interference ?? '?'} 次重叠事件。时间线上的红色刻度就是它们，点一下跳到该时刻。${singleNote}`
      : singlePose
        ? `这个 run 只有 ${poses} 个采样位姿（旧引擎）：回放只有静止图，不能作为运动/净空证据；重跑后再判断。`
        : legacyCoverage
          ? '这个 run 早于采样覆盖字段：报告只能说“没发现干涉”，不能说“查过多少位姿”。'
          : satisfied === false
            ? '采样不足（少于 24 个位姿）：这次 run 的“0 干涉”不能当作净空证据。'
            : (geoSuspect
              ? `本次采样未发现干涉，但有 ${geoSuspect.value.replace('⚠ ', '')}几何疑点（零件离主体很远或只是盒体）：净空结论要打折看。`
              : `本次采样未发现干涉${drift == null ? '。' : `；关节最大漂移 ${num(drift, 2)}mm。`}`);
    return {
      tone,
      headline: bad ? '不可交付' : tone === 'ok' ? '通过' : '需要复核',
      summary,
      facts,
      events: motionEvents(report),
      keyframes,
    };
  }

  if (kind === 'physics') {
    const fell = Object.entries((m.fellOver ?? {}) as Record<string, boolean>)
      .filter(([, over]) => over).map(([name]) => name);
    const violations = Array.isArray(m.jointViolations) ? m.jointViolations : [];
    const settled = m.settled;
    const maxPen = m.maxPenetrationMm;
    const facts: RunFact[] = [
      { label: '时长', value: `${num(report.durationSec, 2)}s` },
      { label: '稳态穿透', value: `${num(m.settledPenetrationMm, 2)}mm`, tone: Number(m.settledPenetrationMm) > 1 ? 'warn' : 'ok' },
      { label: '最大穿透', value: `${num(maxPen, 2)}mm`, tone: Number(maxPen) > 2 ? 'warn' : 'ok' },
      { label: '倾倒', value: fell.length ? `${fell.length} 件` : '无', tone: fell.length ? 'warn' : 'ok', title: fell.join('、') || '没有零件超过 60° 倾倒判据' },
      { label: '关节违规', value: violations.length ? `${violations.length} 条` : '无', tone: violations.length ? 'warn' : 'ok', title: violations.join('; ') || undefined },
    ];
    const geoSuspect = geometrySuspectFact(report);
    if (geoSuspect) facts.push(geoSuspect);
    const tone: RunTone = fell.length || violations.length || settled === false || geoSuspect
      ? 'warn' : baseTone === 'bad' ? 'bad' : 'ok';
    const summary = fell.length
      ? `有零件倾倒：${fell.join('、')}。时间线上标出了首次倾倒的时刻。`
      : violations.length
        ? `关节约束违规：${violations[0]}${violations.length > 1 ? ` 等 ${violations.length} 条` : ''}。`
        : settled === false
          ? '求解器没有达到稳定状态，穿透数字只能当量级参考。'
          : geoSuspect
            ? '没有发现倾倒或关节违规，但有零件离主体很远（几何疑点）：穿透数字描述的可能是一片空场。'
            : '没有发现倾倒或关节违规；穿透数字是求解器接触深度，不是配合间隙。';
    return { tone, headline: tone === 'ok' ? '通过' : '需要复核', summary, facts, events: physicsEvents(report), keyframes };
  }

  if (kind === 'fluid') {
    const arrival = m.outletArrivalRatio;
    const penetration = m.penetrationCount;
    const tone: RunTone = status === 'fail' || (Number(penetration) > 0) ? 'bad'
      : status === 'check' || (Number(arrival) < 0.9) ? 'warn' : 'ok';
    const facts: RunFact[] = [
      { label: '到达率', value: pct(arrival), tone: Number(arrival) < 0.9 ? 'warn' : 'ok' },
      { label: '穿透', value: penetration == null ? none : `${penetration} 粒`, tone: Number(penetration) > 0 ? 'bad' : 'ok' },
      { label: '粒子', value: num(m.particleCount0, 0) },
      { label: '逃逸', value: num(m.escaped, 0) },
      { label: '活动', value: num(m.active, 0) },
      { label: '最大速度', value: `${num(m.maxVelocityMmPerSec, 0)}mm/s` },
    ];
    const summary = Number(penetration) > 0
      ? '有粒子进入壁面：先检查边界/网格，别先调入口速度。'
      : Number(arrival) < 0.9
        ? `到达率 ${pct(arrival)}：一部分粒子没有在仿真时长内到达出口。`
        : '流体在时长内到达出口，未发现粒子穿透壁面。';
    return { tone, headline: tone === 'ok' ? '通过' : tone === 'bad' ? '有问题' : '需要复核', summary, facts, events: [], keyframes: [] };
  }

  if (kind === 'assembly-check') {
    const s = report.summary ?? {};
    const scopeText = `${report.manifestName ?? ''} ${report.manifestPath ?? ''}`;
    const subassembly = /子装配|subassembly|assembly_ring|ring/i.test(scopeText);
    const tone: RunTone = (s.hardViolations ?? 0) > 0 ? 'bad'
      : (s.skipped ?? 0) + (s.intentFlags ?? 0) > 0 || (s.undeclared ?? 0) > 0 ? 'warn' : 'ok';
    return {
      tone,
      headline: tone === 'ok' ? '契约成立' : tone === 'bad' ? '契约有冲突' : '不完整',
      summary: (subassembly ? '这是子装配清单，不是整机；37/37 不能读成整机通过。' : '') + (tone === 'ok'
        ? '声明了的接口全部通过；“未声明 0”只说明近邻扫描没有发现未声明的接触，不等于整机几何已验。'
        : '还有未判定/未声明的条目；先看报告里的缺口行，不要把“通过 N 条”当成整机通过。'),
      facts: [
        { label: '范围', value: subassembly ? '子装配' : '整机', tone: subassembly ? 'warn' : 'ok',
          title: String(report.manifestName ?? '—') },
        { label: '接口', value: num(s.interfaces, 0) },
        { label: '通过', value: num(s.pass, 0) },
        { label: '硬冲突', value: num(s.hardViolations, 0), tone: (s.hardViolations ?? 0) > 0 ? 'bad' : 'ok' },
        { label: '未声明', value: num(s.undeclared, 0), tone: (s.undeclared ?? 0) > 0 ? 'warn' : 'ok' },
      ],
      events: [],
      keyframes: [],
    };
  }

  if (kind === 'assembly') {
    const pairs = Array.isArray(report.pairs) ? report.pairs : [];
    const interference = pairs.filter((p: any) => p.status === 'interference').length;
    const tight = pairs.filter((p: any) => p.status === 'too_tight').length;
    const tone: RunTone = interference > 0 ? 'bad' : tight > 0 ? 'warn' : 'ok';
    return {
      tone,
      headline: interference > 0 ? '有干涉' : tight > 0 ? '有过紧' : '通过',
      summary: interference > 0
        ? `${interference} 对零件在装配位姿下重叠；这是几何问题，不是公差问题。`
        : tight > 0
          ? `${tight} 对零件间隙小于阈值；确认是设计过盈还是公差偏紧。`
          : `所有 ${pairs.length} 对零件在装配位姿下无干涉、无过紧。`,
      facts: [
        { label: '零件对', value: num(pairs.length, 0) },
        { label: '干涉', value: `${interference}`, tone: interference > 0 ? 'bad' : 'ok' },
        { label: '过紧', value: `${tight}`, tone: tight > 0 ? 'warn' : 'ok' },
      ],
      events: [],
      keyframes: [],
    };
  }

  return null;
}
