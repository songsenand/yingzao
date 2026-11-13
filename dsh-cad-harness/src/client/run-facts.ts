/**
 * What a simulation run actually says, in the few numbers a human needs before
 * deciding whether to trust it.
 *
 * One source for both surfaces: the playback strip (compact) and the 报告 tab
 * (detailed). The report is the truth — this module never recomputes geometry and
 * never invents a value that is absent; a missing number renders as "—".
 */

import { t } from './i18n.ts';

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
    label: t('rf.geometry'),
    value: t('rf.geometryCount', { count: warnCount }),
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
        label: `${t('rf.interference')} ${e.partA ?? '?'} ↔ ${e.partB ?? '?'}${Number.isFinite(e.volumeMm3) ? ` ${num(e.volumeMm3, 1)}mm³` : ''}`,
        tone: 'bad' as const,
      }));
  }
  return (report?.trajectory?.events ?? [])
    .filter((e: any) => Number.isFinite(e?.timeSec))
    .map((e: any) => ({ timeSec: e.timeSec, label: String(e.label ?? t('rf.particles')), tone: 'bad' as const }));
};

const physicsEvents = (report: any): RunEvent[] =>
  (report?.trajectory?.events ?? [])
    .filter((e: any) => Number.isFinite(e?.timeSec))
    .filter((e: any) => !/^(start|final|context|crank\d+)/i.test(String(e.label ?? '')))
    .map((e: any) => ({
      timeSec: e.timeSec,
      label: String(e.label ?? t('rf.particles')),
      tone: /topple|toppled|penetrat|violation|违规|倾倒|穿透/.test(String(e.label)) ? 'warn' as const : 'muted' as const,
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
      { label: t('rf.duration'), value: `${num(report.durationSec, 2)}s` },
      ...(singlePose ? [{
        label: t('rf.poses'),
        value: t('rf.frames', { count: poses }),
        tone: 'warn' as const,
        title: t('rf.poseTitle'),
      }] : []),
      { label: t('rf.interference'), value: interference == null ? none : t('rf.times', { count: interference }), tone: bad ? 'bad' : 'ok' },
      {
        label: t('rf.sampling'),
        value: checks == null ? none : `${checks}/24`,
        tone: checks == null || satisfied === false ? 'warn' : 'ok',
        title: checks == null
          ? t('rf.samplingLegacyTitle')
          : satisfied === false
            ? t('rf.samplingLowTitle')
            : t('rf.samplingOkTitle'),
      },
      {
        label: t('rf.drift'),
        value: drift == null ? none : `${num(drift, 2)}mm`,
        tone: drift != null && drift > 2 ? 'warn' : 'ok',
        title: t('rf.driftTitle'),
      },
    ];
    const geoSuspect = geometrySuspectFact(report);
    if (geoSuspect) facts.push(geoSuspect);
    if (first) {
      facts.push({ label: t('rf.travel'), value: `${num(first.travelMm, 1)}mm`, title: t('rf.travelTitle', { part: followers[0]![0], axis: first.axis ?? '?' }) });
      if (Number.isFinite(first.periodSec)) facts.push({ label: t('rf.period'), value: `${num(first.periodSec, 2)}s` });
    }
    const legacyCoverage = checks == null;
    const singleNote = singlePose ? t('rf.singleNote', { count: poses ?? 0 }) : '';
    const summary = bad
      ? t('rf.motionBlocked', { count: interference ?? '?', note: singleNote })
      : singlePose
        ? t('rf.motionSingle', { count: poses ?? 0 })
        : legacyCoverage
          ? t('rf.motionLegacy')
          : satisfied === false
            ? t('rf.motionLow')
            : (geoSuspect
              ? t('rf.motionGeo', { count: String(geoSuspect.value).replace('⚠ ', '') })
              : drift == null ? t('rf.motionOk') : t('rf.motionOkDrift', { drift: num(drift, 2) }));
    return {
      tone,
      headline: bad ? t('rf.headline.blocked') : tone === 'ok' ? t('rf.headline.pass') : t('rf.headline.review'),
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
      { label: t('rf.duration'), value: `${num(report.durationSec, 2)}s` },
      { label: t('rf.settledPenetration'), value: `${num(m.settledPenetrationMm, 2)}mm`, tone: Number(m.settledPenetrationMm) > 1 ? 'warn' : 'ok' },
      { label: t('rf.maxPenetration'), value: `${num(maxPen, 2)}mm`, tone: Number(maxPen) > 2 ? 'warn' : 'ok' },
      { label: t('rf.fell'), value: fell.length ? t('rf.partsCount', { count: fell.length }) : t('rf.none'), tone: fell.length ? 'warn' : 'ok', title: fell.join(', ') || t('rf.fellTitle') },
      { label: t('rf.jointViolations'), value: violations.length ? t('rf.jointCount', { count: violations.length }) : t('rf.none'), tone: violations.length ? 'warn' : 'ok', title: violations.join('; ') || undefined },
    ];
    const geoSuspect = geometrySuspectFact(report);
    if (geoSuspect) facts.push(geoSuspect);
    const tone: RunTone = fell.length || violations.length || settled === false || geoSuspect
      ? 'warn' : baseTone === 'bad' ? 'bad' : 'ok';
    const summary = fell.length
      ? t('rf.physicsFell', { parts: fell.join(', ') })
      : violations.length
        ? violations.length > 1 ? t('rf.physicsViolationMore', { first: violations[0]!, count: violations.length }) : t('rf.physicsViolation', { first: violations[0]! })
        : settled === false
          ? t('rf.physicsUnsettled')
          : geoSuspect
            ? t('rf.physicsGeo')
            : t('rf.physicsOk');
    return { tone, headline: tone === 'ok' ? t('rf.headline.pass') : t('rf.headline.review'), summary, facts, events: physicsEvents(report), keyframes };
  }

  if (kind === 'fluid') {
    const arrival = m.outletArrivalRatio;
    const penetration = m.penetrationCount;
    const tone: RunTone = status === 'fail' || (Number(penetration) > 0) ? 'bad'
      : status === 'check' || (Number(arrival) < 0.9) ? 'warn' : 'ok';
    const facts: RunFact[] = [
      { label: t('rf.arrival'), value: pct(arrival), tone: Number(arrival) < 0.9 ? 'warn' : 'ok' },
      { label: t('rf.penetration'), value: penetration == null ? none : t('rf.particleCount', { count: penetration }), tone: Number(penetration) > 0 ? 'bad' : 'ok' },
      { label: t('rf.particles'), value: num(m.particleCount0, 0) },
      { label: t('rf.escaped'), value: num(m.escaped, 0) },
      { label: t('rf.active'), value: num(m.active, 0) },
      { label: t('rf.maxVelocity'), value: `${num(m.maxVelocityMmPerSec, 0)}mm/s` },
    ];
    const summary = Number(penetration) > 0
      ? t('rf.fluidPenetration')
      : Number(arrival) < 0.9
        ? t('rf.fluidArrival', { value: pct(arrival) })
        : t('rf.fluidOk');
    return { tone, headline: tone === 'ok' ? t('rf.headline.pass') : tone === 'bad' ? t('rf.headline.problem') : t('rf.headline.review'), summary, facts, events: [], keyframes: [] };
  }

  if (kind === 'assembly-check') {
    const s = report.summary ?? {};
    const scopeText = `${report.manifestName ?? ''} ${report.manifestPath ?? ''}`;
    const subassembly = /子装配|subassembly|assembly_ring|ring/i.test(scopeText);
    const tone: RunTone = (s.hardViolations ?? 0) > 0 ? 'bad'
      : (s.skipped ?? 0) + (s.intentFlags ?? 0) > 0 || (s.undeclared ?? 0) > 0 ? 'warn' : 'ok';
    return {
      tone,
      headline: tone === 'ok' ? t('rf.headline.contractOk') : tone === 'bad' ? t('rf.headline.contractConflict') : t('rf.headline.incomplete'),
      summary: (subassembly ? t('rf.subassemblyNote') : '') + (tone === 'ok'
        ? t('rf.contractOk')
        : t('rf.contractIncomplete')),
      facts: [
        { label: t('rf.scope'), value: subassembly ? t('rf.subassembly') : t('rf.wholeMachine'), tone: subassembly ? 'warn' : 'ok',
          title: String(report.manifestName ?? '—') },
        { label: t('rf.interfaces'), value: num(s.interfaces, 0) },
        { label: t('rf.headline.pass'), value: num(s.pass, 0) },
        { label: t('rf.hardViolations'), value: num(s.hardViolations, 0), tone: (s.hardViolations ?? 0) > 0 ? 'bad' : 'ok' },
        { label: t('rf.undeclared'), value: num(s.undeclared, 0), tone: (s.undeclared ?? 0) > 0 ? 'warn' : 'ok' },
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
      headline: interference > 0 ? t('rf.headline.interference') : tight > 0 ? t('rf.headline.tight') : t('rf.headline.pass'),
      summary: interference > 0
        ? t('rf.assemblyInterference', { count: interference })
        : tight > 0
          ? t('rf.assemblyTight', { count: tight })
          : t('rf.assemblyClean', { count: pairs.length }),
      facts: [
        { label: t('rf.pairs'), value: num(pairs.length, 0) },
        { label: t('rf.interference'), value: `${interference}`, tone: interference > 0 ? 'bad' : 'ok' },
        { label: t('rf.tight'), value: `${tight}`, tone: tight > 0 ? 'warn' : 'ok' },
      ],
      events: [],
      keyframes: [],
    };
  }

  return null;
}
