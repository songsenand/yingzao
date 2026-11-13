import { t as tr } from './i18n.ts';
// Captions for panel screenshots: the text that rides with the image.
//
// Two subjects, one rule — the caption must name what the picture IS, because
// the image is a one-shot attachment (DSH uploads the bytes and sends no
// filename text). After this turn the caption is the only handle a reader —
// human or model — has on the picture.
//
//   * RUN (motion / physics / fluid / static assembly): cite the run id, the
//     title and the frame. The view's own label names neither: `机构回放
//     t=0.66s` is a view type plus a rounded display time that two runs (or
//     two frames) can share.
//   * PART version: cite part + revision, and the facts that changed the
//     pixels but are not readable from them — old revision, section, measure,
//     thickness, annotations, heatmap legend, comparison inset.
//
// WHY a separate module: pure, so scripts/accept-shot-caption.mjs pins the
// wording without a browser. It also pins what must NOT appear: a replay must
// never inherit the part viewport's bounding box. That bbox was the leftover
// `spec` of the last viewed version (the scene builder returns before
// `setSpec(null)` when there is no version mesh), so it described another
// object.

import type { RunProduct } from '../shared/types.ts';

/**
 * What the replay view alone knows: where in the run the captured frame is.
 * The panel owns the run's identity; the view owns the position, and the two
 * meet here. Everything is measured, never inferred from the label text.
 */
export interface ShotFrame {
  /** 1-based frame position, e.g. the 20th of 121. */
  index: number;
  total: number;
  /** The frame's time. The label also prints it, rounded for display. */
  timeSec: number;
  /** Frame-to-frame step, so an event within half a step counts as this frame. */
  stepSec?: number;
  /** Events recorded by the trajectory; only those ON this frame are cited. */
  events?: readonly { timeSec: number; label: string }[];
}

/** The run fields a caption needs; `title` is already the human-facing name. */
export type CaptionRun = Pick<RunProduct, 'id' | 'sourceVersionIds'> & {
  title: string;
  /** Source versions that have since been superseded (the evidence expired). */
  staleVersionIds?: readonly string[];
};

/** Exact-enough for float event times; no window games. */
const EVENT_EPS_SEC = 1e-6;
/** More than this and the caption becomes a transcript, not an identity. */
const MAX_EVENTS = 2;
/** A collision label can be a sentence; the caption only needs the gist. */
const MAX_EVENT_CHARS = 40;

/**
 * Two lines: identity (`run · frame · t`), then the facts that make the frame
 * checkable (provenance + the event it depicts). No bbox: a replay's geometry
 * is posed per frame, and the only bbox in reach belonged to another view.
 */
export function runShotCaption(run: CaptionRun, label: string, frame?: ShotFrame): string {
  const head = tr('ui.caption.runHead', { id: run.id, title: run.title, label });
  const facts: string[] = [];
  if (frame) {
    facts.push(tr('ui.caption.frame', { index: frame.index, total: frame.total }));
    // An event is cited ONLY when it happened on this frame: a neighbouring
    // collision is not what the picture shows, and the label can be long.
    const tol = frame.stepSec !== undefined ? Math.max(frame.stepSec / 2, EVENT_EPS_SEC) : EVENT_EPS_SEC;
    const near = (frame.events ?? [])
      .filter((ev) => Math.abs(ev.timeSec - frame.timeSec) <= tol + EVENT_EPS_SEC)
      .slice(0, MAX_EVENTS);
    if (near.length) {
      facts.push(tr('ui.caption.event', { events: near.map((ev) => `${secText(ev.timeSec)}s ${clip(ev.label)}`).join(' / ') }));
    }
  }
  const versions = [...new Set(run.sourceVersionIds.filter(Boolean))];
  if (versions.length) facts.push(tr('ui.caption.geometry', { versions: versions.join(' + ') }));
  if (run.staleVersionIds?.length) facts.push(tr('ui.caption.sourceStale'));
  return tr('ui.caption.head', { head }) + (facts.length ? `\n${facts.join(' · ')}` : '');
}

/** Event times are exact floats; print 0.5, not 0.5000000000000001. */
function secText(sec: number): string {
  return Number.isInteger(sec) ? String(sec) : String(Number(sec.toFixed(3)));
}

function clip(text: string): string {
  return text.length <= MAX_EVENT_CHARS ? text : `${text.slice(0, MAX_EVENT_CHARS - 1)}…`;
}

/**
 * Everything a PART-version caption knows. Each optional field is a state the
 * panel can hold; the caption names only the ones that are actually on, so a
 * plain capture stays two short lines.
 */
export interface PartShotFacts {
  partName?: string;
  versionId?: string;
  /** Latest revision of the part; makes an old capture say that it is old. */
  latestVersionId?: string | null;
  label: string;
  bboxMm?: readonly number[];
  section?: { axis: string; keepPct: number };
  measureMm?: { dist: number; a: readonly number[]; b: readonly number[] };
  thicknessMm?: number;
  annotations?: number;
  /**
   * The heatmap legend shown in the UI. It is a DOM chip, so it is NOT in the
   * captured canvas: without this fact the colours have no meaning.
   */
  heatLegend?: string;
  /**
   * The comparison inset drawn into the canvas. Its blue/orange key is also a
   * DOM overlay, so the picture arrives with a second model and no legend.
   */
  compare?: { blue: { role: string; id: string }; orange: { role: string; id: string } };
}

/** Two lines: who this is (`part · revision · action`), then the pixel facts. */
export function partShotCaption(f: PartShotFacts): string {
  const head: string[] = [];
  if (f.partName) head.push(tr('ui.caption.part', { name: f.partName }));
  if (f.versionId) {
    // An old revision must not read like the current one: the picture cannot
    // show that a newer version exists.
    const stale = f.latestVersionId && f.versionId !== f.latestVersionId
      ? tr('ui.caption.oldVersion', { latest: f.latestVersionId })
      : '';
    head.push(tr('ui.caption.version', { version: f.versionId, stale }));
  }
  head.push(f.label);
  const facts: string[] = [];
  if (f.bboxMm) facts.push(tr('ui.caption.bbox', { values: f.bboxMm.map(round3).join(' × ') }));
  if (f.section) {
    facts.push(tr('ui.caption.section', { axis: f.section.axis, keep: Math.round(f.section.keepPct * 100) }));
  }
  if (f.measureMm) {
    facts.push(tr('ui.caption.measure', { dist: f.measureMm.dist.toFixed(2), a: f.measureMm.a.map((n) => n.toFixed(1)).join(', '), b: f.measureMm.b.map((n) => n.toFixed(1)).join(', ') }));
  }
  if (f.thicknessMm !== undefined) facts.push(tr('ui.caption.thickness', { value: f.thicknessMm.toFixed(2) }));
  if (f.annotations) facts.push(tr('ui.caption.annotations', { count: f.annotations }));
  if (f.heatLegend) facts.push(tr('ui.caption.heat', { legend: f.heatLegend }));
  if (f.compare) {
    facts.push(tr('ui.caption.compare', { blue: f.compare.blue.role, blueId: f.compare.blue.id, orange: f.compare.orange.role, orangeId: f.compare.orange.id }));
  }
  return tr('ui.caption.head', { head: head.join(' · ') }) + (facts.length ? `\n${facts.join(' · ')}` : '');
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
