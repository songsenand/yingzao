/**
 * The simulation's missing axis: a small SVG chart of what changed over time.
 *
 * The data strip answers "what is the final number"; this answers "when did it
 * start going wrong". It reads only `report.trajectory` (already stored per run)
 * — no solver change, no re-simulation.
 *
 * Motion: follower travel along the axis the report chose (mm).
 * Physics: per-part displacement from its start pose (mm); a toppling part rises
 * and falls, and the event ticks say when.
 * Fluid: no per-time series is stored in the report, so it returns null rather
 * than inventing one.
 */
import React from 'react';
import { t as tr } from './i18n.ts';
import { T } from './tokens';

export interface ChartSeries {
  name: string;
  color: string;
  values: number[];
}

export interface ChartEvent {
  timeSec: number;
  label: string;
  tone?: 'bad' | 'warn';
}

export interface RunChartData {
  times: number[];
  series: ChartSeries[];
  events: ChartEvent[];
  keyframes: { timeSec: number; label: string }[];
  unit: string;
  title: string;
  /** Honest scope line, e.g. "位移相对起点的模长". */
  note: string;
}

const PALETTE = ['#2f6fdb', '#c0392b', '#27ae60'];

const axisIndex = (axis: string): number => (axis === 'x' ? 0 : axis === 'y' ? 1 : 2);

const finiteSeries = (values: number[]): boolean => values.every((v) => Number.isFinite(v));

/** Build the chart from the run's own trajectory; null when there is nothing honest to plot. */
export function buildRunChart(kind: string, report: any): RunChartData | null {
  const tr = report?.trajectory;
  const times: number[] = Array.isArray(tr?.times) ? tr.times.filter((t: unknown) => typeof t === 'number') : [];
  const parts: any[] = Array.isArray(tr?.parts) ? tr.parts : [];
  if (times.length < 2 || parts.length === 0) return null;

  const keyframes = (Array.isArray(report?.keyframes) ? report.keyframes : [])
    .filter((k: any) => Number.isFinite(k?.timeSec))
    .map((k: any) => ({ timeSec: k.timeSec as number, label: String(k.label ?? 'frame') }))
    .sort((a: any, b: any) => a.timeSec - b.timeSec);

  if (kind === 'motion') {
    const followers = (report?.metrics?.followers ?? {}) as Record<string, { axis?: string; travelMm?: number }>;
    const candidates: { name: string; axis: number; values: number[]; range: number }[] = [];
    for (const part of parts) {
      const f = followers[part.name];
      const axis = axisIndex(f?.axis ?? 'z');
      const frames: number[][] = Array.isArray(part.frames) ? part.frames : [];
      if (frames.length !== times.length) continue;
      const values = frames.map((fr) => (fr[axis] ?? 0) - (frames[0]![axis] ?? 0));
      if (!finiteSeries(values)) continue;
      const range = Math.max(...values) - Math.min(...values);
      if (!(range > 1e-9)) continue;
      candidates.push({ name: part.name, axis, values, range });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.range - a.range);
    const chosen = candidates.slice(0, 3);
    const events: ChartEvent[] = ((report?.metrics?.interferenceEvents ?? []) as any[])
      .filter((e) => Number.isFinite(e?.timeSec))
      .map((e) => ({
        timeSec: e.timeSec as number,
        label: tr('ui.chart.interference', { a: e.partA ?? '?', b: e.partB ?? '?' }),
        tone: 'bad' as const,
      }));
    return {
      times,
      series: chosen.map((c, i) => ({ name: c.name, color: PALETTE[i % PALETTE.length]!, values: c.values })),
      events,
      keyframes,
      unit: 'mm',
      title: tr('ui.chart.travelTitle'),
      note: tr('ui.chart.travelNote'),
    };
  }

  if (kind === 'physics') {
    const candidates: { name: string; values: number[]; range: number }[] = [];
    for (const part of parts) {
      if (part.bodyType !== 'dynamic') continue;
      const frames: number[][] = Array.isArray(part.frames) ? part.frames : [];
      if (frames.length !== times.length) continue;
      const p0 = frames[0]!;
      const values = frames.map((fr) => Math.hypot(fr[0]! - p0[0]!, fr[1]! - p0[1]!, fr[2]! - p0[2]!));
      if (!finiteSeries(values)) continue;
      const range = Math.max(...values);
      if (!(range > 1e-6)) continue;
      candidates.push({ name: part.name, values, range });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.range - a.range);
    const chosen = candidates.slice(0, 3);
    const events: ChartEvent[] = ((tr?.events ?? []) as any[])
      .filter((e) => Number.isFinite(e?.timeSec))
      .filter((e) => !/^(start|final|context|crank\d+)/i.test(String(e.label ?? '')))
      .map((e) => ({ timeSec: e.timeSec as number, label: String(e.label), tone: 'warn' as const }));
    return {
      times,
      series: chosen.map((c, i) => ({ name: c.name, color: PALETTE[i % PALETTE.length]!, values: c.values })),
      events,
      keyframes,
      unit: 'mm',
      title: tr('ui.chart.displacementTitle'),
      note: tr('ui.chart.displacementNote'),
    };
  }

  return null;
}

const fmt = (v: number): string => {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
};

/** SVG chart: click anywhere (when `onSeek` is given) to jump the playback there. */
export function RunChart(props: {
  data: RunChartData;
  timeSec?: number;
  onSeek?: (timeSec: number) => void;
  height?: number;
}): React.ReactElement {
  const data = props.data;
  const W = 600;
  const H = 170;
  const m = { l: 38, r: 10, t: 12, b: 26 };
  const tMax = data.times[data.times.length - 1] || 1;
  const values = data.series.flatMap((s) => s.values);
  let yMin = Math.min(0, ...values);
  let yMax = Math.max(0, ...values);
  if (yMax - yMin < 1e-9) { yMax = 1; yMin = -1; }
  const pad = (yMax - yMin) * 0.08;
  yMin -= pad; yMax += pad;
  const x = (t: number): number => m.l + (t / tMax) * (W - m.l - m.r);
  const y = (v: number): number => m.t + (1 - (v - yMin) / (yMax - yMin)) * (H - m.t - m.b);
  const path = (vals: number[]): string =>
    vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(data.times[i]!).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
  const yTicks = [yMax, (yMax + yMin) / 2, yMin];
  const click = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!props.onSeek) return;
    // Map through the SVG's own CTM, not the element box: preserveAspectRatio
    // can letterbox the plot, and a percentage-of-width mapping would seek to
    // the wrong time at narrow dock widths.
    const ctm = e.currentTarget.getScreenCTM();
    if (!ctm) return;
    const pt = e.currentTarget.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const local = pt.matrixTransform(ctm.inverse());
    const t = Math.max(0, Math.min(tMax, ((local.x - m.l) / Math.max(1, W - m.l - m.r)) * tMax));
    props.onSeek(t);
  };
  const tNow = props.timeSec;
  return React.createElement(
    'div',
    { 'data-run-chart': '1', style: { display: 'flex', flexDirection: 'column', gap: 2 } },
    React.createElement('div', { style: { display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 10, color: T.soft } },
      React.createElement('b', { style: { fontSize: 11, color: T.ink } }, data.title),
      React.createElement('span', { style: { color: T.muted } }, data.unit),
      ...data.series.map((s) => React.createElement('span', { key: s.name, style: { display: 'inline-flex', gap: 3, alignItems: 'center' } },
        React.createElement('span', { style: { width: 8, height: 2, background: s.color, display: 'inline-block' } }),
        s.name)),
    ),
    React.createElement(
      'svg',
      {
        viewBox: `0 0 ${W} ${H}`,
        preserveAspectRatio: 'xMidYMid meet',
        onClick: click,
        style: {
          width: '100%', height: props.height ?? 160, display: 'block',
          background: T.plate, border: `1px solid ${T.border}`, borderRadius: 6,
          cursor: props.onSeek ? 'crosshair' : 'default',
        },
      },
      ...[0, 0.5, 1].map((f) => React.createElement('line', {
        key: `gx-${f}`, x1: m.l, x2: W - m.r, y1: y(yMin + f * (yMax - yMin)), y2: y(yMin + f * (yMax - yMin)),
        stroke: T.divider, strokeWidth: 1,
      })),
      ...yTicks.map((v, i) => React.createElement('text', {
        key: `yt-${i}`, x: m.l - 4, y: y(v) + 3, textAnchor: 'end', fontSize: 9, fill: T.muted,
      }, fmt(v))),
      ...[0, 0.5, 1].map((f) => React.createElement('text', {
        key: `xt-${f}`, x: x(f * tMax), y: H - 8, textAnchor: f === 0 ? 'start' : f === 1 ? 'end' : 'middle',
        fontSize: 9, fill: T.muted,
      }, `${fmt(f * tMax)}s`)),
      ...data.events.map((ev, i) => React.createElement('line', {
        key: `ev-${i}`, x1: x(ev.timeSec), x2: x(ev.timeSec), y1: m.t, y2: H - m.b,
        stroke: ev.tone === 'bad' ? T.danger : T.warn, strokeWidth: 1, strokeDasharray: '2 2', opacity: 0.75,
      })),
      ...data.keyframes.map((k, i) => React.createElement('rect', {
        key: `kf-${i}`, x: x(k.timeSec) - 2.5, y: m.t - 5, width: 5, height: 5,
        fill: T.accent, transform: `rotate(45 ${x(k.timeSec)} ${m.t - 2.5})`,
      })),
      ...data.series.map((s) => React.createElement('path', {
        key: s.name, d: path(s.values), fill: 'none', stroke: s.color, strokeWidth: 1.6,
        strokeLinejoin: 'round', strokeLinecap: 'round',
      })),
      typeof tNow === 'number' && Number.isFinite(tNow)
        ? React.createElement('line', {
            x1: x(Math.min(tMax, Math.max(0, tNow))), x2: x(Math.min(tMax, Math.max(0, tNow))),
            y1: m.t, y2: H - m.b, stroke: T.ink, strokeWidth: 1,
          })
        : null,
      React.createElement('line', { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0), stroke: T.soft, strokeWidth: 0.8 }),
    ),
    React.createElement('div', { style: { fontSize: 10, color: T.muted, lineHeight: 1.4 } }, data.note),
  );
}
