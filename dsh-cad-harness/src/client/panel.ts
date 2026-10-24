/** React panel: product browser (versions + runs) with a preview-first Three.js viewport. */
import React, { useEffect, useRef, useState } from 'react';
import { browseCategories } from './browse';
import {
  currentProject, currentSessionId, currentSessionPreset, currentSessionBlank, cadMissingToolsNotice,
  refreshProjectScope, withProject, setProjectOverride, sessionCwd,
  type CadScope,
} from './project';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MotionPlaybackView, FluidPlaybackView, StaticPartsView } from './playback';
import { ViewportOverlay, type OverlayScene, type ViewportLabel } from './overlay';
import { LocalFileDialog } from './local-file';
import { buildImportStlRequest, IMPORT_UNITS, partNameFromPath, type ImportUnit } from './local-file-request';
import { fitDistance } from './fit';
import { attentionQuery, buildHeatColors, pickHeatLayer, type AttentionPayload } from './heat';
import {
  axisIndex, capTriangles, clipCut, loopCentroids, millimetresPerPixel, nearestVertex,
  planeToWorld, projectToCutPlane, sectionLoops, sectionSegments,
} from './section';
import {
  attachStudioLights, configureStudioRenderer, backgroundById, loadBackgroundId, saveBackgroundId,
  overlayInk, VIEWPORT_BACKGROUNDS,
} from './lighting';
import type {
  PartProduct, PartRecord, ProductsResponse, RunJudgement, RunKind, RunProduct, RunStatus, VersionProduct, WorkspaceEntry,
} from '../shared/types';
import { judgementOf, versionVerdict } from './verdict';
import { refreshProducts, subscribeProducts } from './products-store';
import { loadRecent, pushRecent } from './recent';
import { approveReviewItem, refreshReviewQueue, setReviewItemStatus, subscribeReviewQueue, type ReviewItem } from './review-store';
import { parseMachine, type Machine } from './assembly';
// The kind labels are ONE source (`shared/labels.ts`): the host authors titles
// from them, the panel renders rows from them. A second copy here is how the
// two drift.
import { RUN_KIND_LABEL } from '../shared/labels';

const ANN_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c'];

/** The name a run is shown under: derived from its parts when the stored title is legacy. */
const runTitle = (r: RunProduct): string => r.displayTitle ?? r.title;

/** Status glyph for a run/product verdict. */
const statusGlyph = (status: string): React.ReactNode => {
  const color = status === 'pass' ? '#27ae60' : status === 'fail' ? '#c0392b' : status === 'check' ? '#b8860b' : '#8a94a0';
  const glyph = status === 'pass' ? '✅' : status === 'fail' ? '❌' : status === 'check' ? '⚠️' : '·';
  return React.createElement('span', { style: { color } }, glyph);
};

/**
 * Glyph for a canonical judgement. 'not-excluded' gets a hollow dot, NOT a check:
 * the word (不排除可行) is the claim, and a ✅ would silently drop its two negations.
 */
const judgementGlyph = (j: RunJudgement | null): React.ReactNode => {
  const color = j === 'excluded' ? '#c0392b' : j === 'difficult' ? '#b8860b' : j === 'not-excluded' ? '#2f7d5d' : '#8a94a0';
  const glyph = j === 'excluded' ? '✕' : j === 'difficult' ? '!' : j === 'not-excluded' ? '◦' : '·';
  return React.createElement('span', { style: { color, fontWeight: 700 } }, glyph);
};

const VERDICT_WORD: Record<string, string> = {
  // The band only ever shows a canonical judgement; `unjudged` is a run that judged
  // nothing, `draft` a version no run named. The legacy status words stay for rows.
  unjudged: '未判定', draft: '未验证',
  pass: '通过', check: '待复核', fail: '失败',
  // The canonical three (src/shared/judgement.ts). 'not-excluded' is deliberately NOT
  // 通过: it means no counter-example was found, never "safe" (DESIGN §25.7).
  'not-excluded': '不排除可行', difficult: '困难', excluded: '否决',
  // Assembly interface words — kept distinct from the three above.
  'hard-violation': '硬冲突', 'intent-flag': '意图标记', skipped: '跳过',
};
const verdictColor = (v: string | null): string =>
  v === 'not-excluded' ? '#2f7d5d' : v === 'excluded' ? '#c0392b' : v === 'difficult' ? '#9c6f0a'
    : v === 'pass' ? '#1e8449' : v === 'fail' ? '#c0392b' : v === 'check' ? '#9c6f0a' : '#8a94a0';

/**
 * One row of the 未登记 list. The host's scan (shared with delivery_audit) says
 * whether a file is importable and previewable; the panel does not re-derive it.
 */
export interface UnregisteredFileRow {
  path: string;
  bytes: number;
  modified: string;
  severity: 'blocked' | 'warn';
  format: string;
  importable: boolean;
  previewable: boolean;
}

/** Facts the preview route returns as headers — a file has no version to read them from. */
export interface FileMeta {
  format: string;
  /** False for STL: its numbers are whatever the author used, and we say so. */
  unitsMm: boolean;
  solid: boolean;
  shells: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Measurement annotations
//
// Probe dots are drawn in SCREEN space: a fixed pixel diameter that does not
// grow when you zoom in, and with depth testing off so a dot sitting on a wall
// is still visible next to it. The old world-space sphere (2% of the part's
// bounding radius) covered a 0.5mm wall completely as soon as you zoomed in —
// which made exactly the thin features unmeasurable.
// ---------------------------------------------------------------------------
/**
 * Chrome below the overlay sheet: band 23, strip 26, feedback 38, toolbar 26,
 * plus the 12px paddings and 8px gaps. The section body is NOT in here — its
 * height is user-adjustable and added at render time. Keeping the sheet anchored
 * below the toolbar/strip means every control stays visible and clickable while
 * it is open (no need to close it to switch tabs or take a screenshot).
 */
const SHEET_BELOW_FIXED = 12 + 23 + 5 + 5 + 26 + 5 + 25 + 5 + 26 + 5;

/**
 * The section body is the FUNCTION AREA, and it is paid for by the viewport:
 *   viewportH = stageAvail − bodyH
 * so a taller body is a shorter viewport (the viewport never moves, it shrinks).
 *
 * The viewport's shape is now a bandwidth the user sets, not a square:
 *   default 4:3 (viewportH = 0.75 × width), flattest allowed 16:9 (0.5625 × width).
 * Flat is not free — the camera fit is bound by the SHORTER side, so 4:3 shows
 * the model at 75% of its square size and 16:9 at 56% — but past 1:1 extra
 * height is only empty margin, so flattening is the one direction that buys
 * content area with something other than wasted space.
 */
const BODY_MIN_PX = 110;
const VIEWPORT_RATIO_DEFAULT = 3 / 4;   // 4:3
const VIEWPORT_RATIO_MIN = 9 / 16;      // 16:9

const DOT_PX = 7;
const MEASURE_COLOR = 0xff3040;
const THICK_COLOR = 0x00838f;
/** How close a click must be to a mesh vertex before it snaps onto it. */
const SNAP_PX = 9;
/** The cut plane's own outline, so the section reads as a plane and not a hole. */
const SECTION_COLOR = 0xf0a020;
/**
 * The cut FACE. Between the body (#7aa7d9) and the interior tint (#41608a) so the
 * cut reads as cut material rather than as a hole into the part.
 */
const CAP_COLOR = 0x6d90b8;
/** Unit sphere, scaled per frame; shared, so never disposed per marker. */
const DOT_GEO = new THREE.SphereGeometry(1, 12, 8);

/** Hold every dot at DOT_PX on screen, whatever the camera distance. */
function scaleScreenDots(dots: THREE.Object3D[], camera: THREE.PerspectiveCamera, viewportH: number): void {
  const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const h = Math.max(1, viewportH);
  for (const d of dots) {
    const dist = camera.position.distanceTo(d.position);
    d.scale.setScalar(Math.max((DOT_PX * dist * tanHalfFov) / h, 1e-5));
  }
}

/**
 * Section cut: keep `z <= cut`, so the removed half is the one facing the
 * default (above/front) camera and the view looks INTO the part. The old plane
 * sat at `box.max.z` with normal (0,0,-1), which keeps everything — the ◐剖切
 * toggle was a no-op.
 *
 * `axisIndex` / `clipCut` live in ./section.ts (with the picking maths) so the
 * arithmetic is testable without a browser.
 */

function applyClip(
  mesh: THREE.Mesh,
  clip: { on: boolean; pos: number; axis: 'x' | 'y' | 'z' },
  tint?: THREE.Mesh | null,
): void {
  const material = mesh.material as THREE.Material & { clippingPlanes?: THREE.Plane[] | null };
  const box = (mesh.geometry as THREE.BufferGeometry).boundingBox;
  const normal = new THREE.Vector3();
  normal.setComponent(axisIndex(clip.axis), -1);   // keep the half the default camera does not face
  const planes = clip.on && box ? [new THREE.Plane(normal, clipCut(box, clip))] : null;
  const countChanged = (material.clippingPlanes?.length ?? 0) !== (planes?.length ?? 0);
  material.clippingPlanes = planes;
  material.side = clip.on ? THREE.DoubleSide : THREE.FrontSide;
  // Only a change in the *number* of planes needs a shader rebuild; sliding the
  // plane must not recompile every frame (three re-uploads the plane values per
  // frame — verified in WebGLClipping.setState → projectPlanes).
  if (countChanged) material.needsUpdate = true;

  const tm = tint?.material as (THREE.Material & { clippingPlanes?: THREE.Plane[] | null }) | undefined;
  if (tint && tm) {
    tm.clippingPlanes = planes;
    tint.visible = clip.on;
    if (countChanged) tm.needsUpdate = true;
  }
}


/**
 * One line for the record picker. The identifying bits (id, kind, when) come
 * first so a narrow lane truncates the *description*, never the identity:
 * "v030 · 最新 · 09-28 16:08 — …" degrades to "v030 · 最新 · 09-…".
 */
const recordLabel = (r: PartRecord, isLatestVersion = false): string => {
  if (r.type === 'version') {
    const tag = isLatestVersion ? '最新 · ' : '';
    // "导入" rides in the row, not only in the tooltip: which revisions came
    // from outside is the thing a human scans a part's history for.
    const from = r.source === 'imported' ? '导入 · ' : r.source === 'merged' ? '合并 · ' : '';
    const broken = r.solid === false ? '非实体 · ' : '';
    return `${r.id} · ${tag}${from}${broken}${fmtTime(r.timestamp)} — ${r.title || '(无意图描述)'}`.slice(0, 96);
  }
  // "已被 rNNN 取代" rides in the row: with 36 runs in a project, whether a
  // record is still the current answer is the first thing a human needs, and
  // the timestamp alone does not say it (a run can be newer and still not
  // supersede a different subject).
  const replaced = r.supersededBy ? `已被 ${r.supersededBy} 取代 · ` : '';
  // Evidence expires with the version it cites (DESIGN §22): a run that still
  // says "pass" over geometry a part has since replaced must say so in the row.
  const stale = r.staleVersionIds?.length ? `⚠ 基于旧版本 ${r.staleVersionIds.join(', ')} · ` : '';
  // The name comes from the PARTS (`displayTitle`), not the version ids: fifteen
  // motion runs about the same mechanism are indistinguishable by `v014+v025+v026`.
  // Time leaves the row: the list is already newest-first and the tooltip keeps it,
  // while the width goes to the two things that tell runs apart — what it is, and
  // what it found.
  return `${r.id} · ${replaced}${stale}${runTitle(r)} — ${r.summary}`.slice(0, 96);
};

/** A version element for legacy callers that still build this shape. */
export interface VersionEntry {
  id: string;
  timestamp: string;
  userIntent: string;
  parentVersion: string | null;
  status: string;
}

export interface AssemblyPair {
  partA: string;
  partB: string;
  intersectionVolume: number;
  minDistance: number;
  status: string;
}

export interface AssemblyReportView {
  overallStatus: string;
  thresholdMm: number;
  parts: { name: string; watertight: boolean; volume: number; triangles?: number }[];
  pairs: AssemblyPair[];
}

let connectionService: any = null;
let sessionsService: any = null;
let conversationService: any = null;
let rootCtx: any = null;
export function setClientServices(opts: { connection?: any; sessions?: any; conversation?: any; root?: any }) {
  if (opts.connection) connectionService = opts.connection;
  if (opts.sessions) sessionsService = opts.sessions;
  if (opts.conversation) conversationService = opts.conversation;
  if (opts.root) rootCtx = opts.root;
}

/**
 * Project scope lives in its own module (client/project.ts) so this file and
 * the playback views can build `/api/cad/...` URLs without importing each other.
 */
export { currentProject, withProject } from './project';

/**
 * Resolve the live session's identity, its Agent scope, and its SessionFace.
 *
 * `sessions.list` is the read face (`{ current }`); `sessions.scope(id)` mints
 * an Agent-scoped ctx; `sessions.sessionOf(actx)` is the documented way to get
 * the face behind it (feature code never sees the concrete Session class).
 */
function liveSession(): { sessionId: string; actx: any; face: any } | null {
  try {
    // `getSnapshot()` is the SnapshotStore reader (see client/project.ts); the
    // others are fallbacks for a differently shaped store.
    const state = sessionsService?.list?.getSnapshot?.()
      ?? sessionsService?.list?.get?.()
      ?? sessionsService?.list?.value;
    // `current` was removed from the list snapshot in the 2026-10-03 dsh
    // upgrade (DESIGN §18) — resolve structurally like project.ts does.
    const sessionId = state?.current ?? currentSessionId();
    if (!sessionId) return null;
    const actx = sessionsService?.scope?.(sessionId);
    if (!actx) return null;
    return { sessionId, actx, face: sessionsService?.sessionOf?.(actx) ?? null };
  } catch {
    return null;
  }
}

/**
 * Put one screenshot into the conversation, image and all.
 *
 * The image is a durable attachment end to end: the browser keeps only a draft
 * (object URL + bytes), `conversation.sendSession` base64-encodes it into a
 * `{type:'image', mediaType, data, name}` prompt part, the Host admits those
 * bytes through `ctx.attachments` and the model context keeps only the
 * reference. Nothing is written to the transcript as inline data.
 *
 * Mode is always `'queue'`: a screenshot must never interrupt a running turn.
 *
 * Fallback chain, in order:
 *   1. `sendSession` — the message appears in the conversation and is sent.
 *   2. `input.for(actx).addAttachments(ids)` — parked in the composer, one Send
 *      away. This is the documented behaviour after a failed send too: the
 *      drafts stay registered so the composer can present them.
 *   3. nothing — the caller falls back to clipboard / tray.
 */
async function sendImageToSession(
  blob: Blob,
  name: string,
  text: string,
): Promise<{ how: 'sent' | 'composer' | 'failed'; reason?: string }> {
  const s = liveSession();
  // Failures must be visible, not swallowed: this path depends on three
  // services being mounted in the exact wire shape, so the reason is logged
  // and surfaced in the hint instead of silently degrading to the clipboard.
  const fail = (reason: string) => {
    try { console.warn('[cad-harness] 截图未能发送到会话:', reason); } catch { /* console may be gone */ }
    return { how: 'failed' as const, reason };
  };
  if (!s || !conversationService?.createDrafts) return fail('没有活动会话');
  const drafts: any[] = [];
  const release = () => { try { conversationService?.releaseDraftAttachments?.(drafts); } catch { /* nothing to release */ } };
  try {
    const file = new File([blob], name, { type: 'image/png' });
    drafts.push(...(conversationService.createDrafts(s.sessionId, [file]) ?? []));
    const ids = drafts.map((d: any) => d.id).filter(Boolean);
    if (ids.length === 0) return fail('附件草稿创建失败');

    if (s.face && typeof conversationService.sendSession === 'function') {
      try {
        const outcome = await conversationService.sendSession(s.face, text, ids, 'queue');
        if (outcome?.kind === 'success') return { how: 'sent' };
        release();
        return fail('会话拒绝了这次提交');
      } catch (e) {
        // A thrown sendSession keeps its drafts registered, so parking them in
        // the composer below is safe and loses nothing.
        const reason = String((e as Error)?.message ?? e);
        const input = conversationService?.input?.for?.(s.actx);
        if (input?.addAttachments?.(ids)) return { how: 'composer', reason };
        release();
        return fail(reason);
      }
    }

    const input = conversationService?.input?.for?.(s.actx);
    if (input?.addAttachments?.(ids)) return { how: 'composer', reason: '发送通道不可用' };
    release();
    return fail('会话输入框不可用');
  } catch (e) {
    release();
    return fail(String((e as Error)?.message ?? e));
  }
}

export interface FluidReportView {
  overallStatus: string;
  metrics: {
    particleCount0: number;
    escaped: number;
    active: number;
    outletArrivalRatio: number;
    penetrationCount: number;
    timeToOutletSteps: number | null;
  };
  frames?: string[];
}

export interface PhysicsReportView {
  metrics: {
    settledPenetrationMm: number;
    maxPenetrationMm: number;
    fellOver: Record<string, boolean>;
    jointViolations: string[];
    settled: boolean;
  };
  finalPositions: Record<string, number[]>;
  durationSec: number;
}

// ---------------------------------------------------------------------------
// Layout primitives
//
// The panel is preview-first: the 3D viewport owns every pixel the chrome does
// not need, and is the first thing on screen. Reports, parameters and exports
// fold into one-line disclosures below it, and version history is a single
// dropdown line above it rather than a chip grid.
//
// The viewport is deliberately NOT a forced square. Forcing one spends the
// dock's height on nothing (the old layout left a 411px empty details box at
// 380×900) while the model itself never grows past the *panel width* anyway.
// It takes the leftover height instead, which is what a tall sidebar has to
// give; `fitDistance` keeps the framing correct in either orientation.
//
// The status band is the one line of chrome that lives at the very bottom: it
// answers "what am I looking at, and is it healthy" without competing with the
// viewport (muted, 11px, one ellipsised line).
// ---------------------------------------------------------------------------

const fmtTime = (ts: string): string => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** A file's size, in the unit a human reads (the list shows bytes otherwise). */
const fmtBytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

/** Compact input used by the 未登记 import form (the dialog owns its own styles). */
const fieldStyle: React.CSSProperties = {
  fontSize: 11, padding: '2px 4px', border: '1px solid #d5d9dd', borderRadius: 4,
  minWidth: 0, boxSizing: 'border-box', background: '#fff',
};

const S: Record<string, React.CSSProperties> = {
  panel: {
    padding: 12, display: 'flex', flexDirection: 'column', gap: 5,
    height: '100%', minHeight: 0, boxSizing: 'border-box', overflow: 'hidden',
    position: 'relative',
  },
  // Errors float over the panel instead of taking a row: a row would push every
  // region down (including the viewport, which then re-fits the camera).
  error: {
    position: 'absolute', top: 4, left: 8, right: 8, zIndex: 30,
    padding: '4px 8px', borderRadius: 6, fontSize: 12,
    background: '#fdecea', border: '1px solid #e6b0aa', color: '#a93226',
  },
  // Same slot as `error` but amber: a standing condition, not a failure.
  notice: {
    position: 'absolute', top: 4, left: 8, right: 8, zIndex: 30,
    padding: '4px 8px', borderRadius: 6, fontSize: 11, lineHeight: 1.35,
    background: '#fdf3e3', border: '1px solid #e0c08a', color: '#8a5a12',
  },
  bar: { display: 'flex', alignItems: 'center', gap: 5, flex: 'none', flexWrap: 'wrap' },
  // Every region except the viewport keeps a fixed footprint. The viewport is
  // the only flexible one, so a mode toggle, a hint or an opened disclosure must
  // never resize it: resizing re-fits the camera (aspect changes) and the model
  // visibly jumps — which is what "点击测量之后图像位置变了" was.
  // Tool strip INSIDE the viewport, top-left (复原 owns top-right, the triad
  // bottom-left, the scale bar bottom-right). Absolute, so it costs no layout
  // height: the 34px the old toolbar row occupied now belongs to the section
  // body. Same visual language as the 复原 chip.
  // Vertical and LABELLED: icon-only was ambiguous (□ read as "drag a box" for
  // 壁厚 too). The column is ~117px tall, which a 4:3 viewport still affords.
  viewTools: {
    position: 'absolute', top: 6, left: 6, zIndex: 6,
    display: 'flex', flexDirection: 'column', gap: 3, pointerEvents: 'none',
  },
  // The viewport takes the dock's leftover height. The square is now the *floor*
  // (aspect-ratio gives the flex base size), not the ceiling: with slack it grows
  // into a portrait panel, and it only shrinks below square when the dock is too
  // short for everything — because a shorter viewport means a *smaller model*
  // (the fit is bound by the shorter side), which must be the last thing to give.
  stage: {
    // Basis = the FLATTEST allowed ratio (16:9): the real height then comes from
    // what the section body leaves, and the basis can never force a shrink.
    position: 'relative', width: '100%', aspectRatio: '16 / 9', flex: '1 1 auto', minHeight: 120,
    background: '#f0f0f0', border: '1px solid #e3e7ea', borderRadius: 10, overflow: 'hidden',
  },
  row: { display: 'flex', alignItems: 'center', gap: 6, flex: 'none', minWidth: 0 },
  select: {
    flex: '1 1 120px', minWidth: 0, height: 26, fontSize: 12, padding: '0 6px',
    border: '1px solid #d5d9dd', borderRadius: 6, background: '#fff', color: '#26303a',
  },
  caption: {
    fontSize: 11, lineHeight: 1.45, color: '#5b6673', flex: 'none',
    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
  },
  // The section body gives its height ALL back before the viewport loses a
  // pixel: a huge shrink factor means "the section scrolls, the model does not
  // shrink".
  // Reserved feedback block: two fixed lines, present whether or not a mode is
  // active. Idle it carries the standing instructions, active it carries the
  // measured value plus the instruction — same 38px either way.
  // ONE reserved line: the tools moved into the viewport, so the standing
  // "what each button does" paragraph is gone. Still fixed height — the value /
  // instruction for the active mode has to fit in this same 20px.
  feedback: {
    display: 'flex', flexWrap: 'nowrap', alignItems: 'center', columnGap: 6,
    // 25px: at 20 the 清除壁厚 button lost its bottom edge.
    height: 25, flex: 'none', overflow: 'hidden', minWidth: 0,
  },
  // Section strip: one 26px row of tabs replaces the accordion's per-section
  // header rows (4 x 26px), so the height the table of contents used to eat now
  // holds content. Fixed height, like every region except the viewport.
  tabs: {
    display: 'flex', alignItems: 'center', gap: 3, flex: 'none',
    height: 26, flexWrap: 'nowrap', overflow: 'hidden',
  },
  // The section body. FIXED basis (see the strip above): with `flex-basis: auto`
  // its natural height changed whenever content changed, which resized the
  // viewport and re-fitted the camera. Fixed basis + internal scroll moves
  // nothing. `minHeight` keeps one row reachable on a very short dock; below
  // that the viewport is the next to give, never the other way round.
  // The body height is a px basis chosen at runtime (see bodyH / autoBodyH).
  details: {
    // No maxHeight: the split is computed (4:3 viewport by default, adjustable to
    // 16:9), and a leftover 45% guard was silently capping it at 379px.
    flex: '0 100 158px', minHeight: 27,
    overflow: 'auto', scrollbarGutter: 'stable', display: 'flex', flexDirection: 'column',
  },
  // Expanded section: floats over the viewport. Absolute positioning is the
  // point — it takes no layout space, so opening it cannot move the model.
  sheet: {
    position: 'absolute', left: 8, right: 8, zIndex: 25,
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
    background: '#fff', border: '1px solid #d7dbe0', borderRadius: 10,
    boxShadow: '0 10px 30px rgba(20,30,40,0.20)', padding: 10,
  },
  sheetHead: { display: 'flex', alignItems: 'center', gap: 6, flex: 'none', marginBottom: 6 },
  sheetBody: { minHeight: 0, overflow: 'auto', scrollbarGutter: 'stable' },
  // Bottom status band: the viewport keeps the spotlight, this is the caption.
  status: {
    flex: 'none', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0,
    minHeight: 22, padding: '3px 8px', marginTop: 2, borderRadius: 6,
    borderTop: '1px solid #eef1f3', background: '#fafbfc',
    fontSize: 11, lineHeight: '16px', color: '#5b6673',
  },
  statusText: {
    flex: '1 1 auto', minWidth: 0, overflow: 'hidden',
    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  hint: { fontSize: 11, color: '#8a94a0', lineHeight: 1.5 },
  smallBtn: {
    cursor: 'pointer', borderRadius: 6, padding: '2px 7px', fontSize: 11, lineHeight: '16px',
    border: '1px solid #d5d9dd', background: '#fff', color: '#26303a', flex: 'none', whiteSpace: 'nowrap',
  },
};

/** Section tab in the strip. Same border width in both states (see iconBtnStyle). */
const tabBtnStyle = (active: boolean): React.CSSProperties => ({
  cursor: 'pointer', borderRadius: 6, padding: '2px 7px', fontSize: 11.5, lineHeight: '18px',
  border: `1px solid ${active ? '#4a7dbd' : '#e3e7ea'}`,
  background: active ? '#eaf2fb' : '#f7f9fb',
  color: active ? '#1f4e79' : '#5b6673',
  whiteSpace: 'nowrap', flex: 'none',
});

/** A viewport-corner tool chip: translucent, shadowed, and still clickable while
 *  the picking overlay covers the stage (hence `pointerEvents` back on). */
const viewToolStyle = (active: boolean, color = '#4a7dbd'): React.CSSProperties => ({
  ...iconBtnStyle(active, color),
  width: 66, textAlign: 'center', pointerEvents: 'auto', padding: '2px 5px',
  background: active ? '#fdecea' : 'rgba(255,255,255,0.86)',
  boxShadow: '0 1px 3px rgba(20,30,40,0.14)',
});

const iconBtnStyle = (active: boolean, color = '#4a7dbd'): React.CSSProperties => ({
  cursor: 'pointer', borderRadius: 6, padding: '3px 6px', fontSize: 12, lineHeight: '18px',
  // Border WIDTH is constant on purpose: 1px ↔ 1.5px would resize the button by a
  // pixel every time a mode toggled, and the toolbar row's geometry must not
  // depend on state (same reason the labels no longer swap to ✕…).
  border: `1.5px solid ${active ? color : '#d5d9dd'}`,
  background: active ? '#fdecea' : '#fff', color: '#26303a', flex: 'none', whiteSpace: 'nowrap',
});

export function CadPanel(): React.ReactElement {
  // The browse tree is 零件 → 记录(版本|运行). Two choices, both explicit: which
  // part you are working on, and which of its records you are looking at. The
  // record's own `type` decides what fills the viewport.
  const [parts, setParts] = useState<PartProduct[]>([]);
  const [scene, setScene] = useState<RunProduct[]>([]);
  /** Selected subject: a part id, or the cross-part scene bucket. */
  const [subjectId, setSubjectId] = useState<string>('');
  /** Selected record inside that subject (version or run id). */
  const [recordId, setRecordId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Which corpus the panel is looking at. '' = follow the session (the default);
   * any other value is an absolute project dir pinned via the workspace
   * dropdown. Writes are unaffected: the agent always writes the session corpus.
   */
  const [workspaceCwd, setWorkspaceCwd] = useState<string>('');
  /** Corpora discoverable under the session's workspace root. */
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  /** Bumped on a session switch so the discovery effect re-runs. */
  const [scopeTick, setScopeTick] = useState(0);
  /**
   * The session cwd as the last poll resolved it. State (not the module getter)
   * because the discovery effect must re-run the moment the session list
   * resolves — on first mount the cwd is still '' and a one-shot fetch would be
   * lost, leaving the dropdown empty forever.
   */
  const [sessionDir, setSessionDir] = useState('');
  /**
   * What the host says about tool visibility (null until it answers). The
   * panel's own half of this plugin is global while the model's half is
   * preset-scoped, so the human can be looking at a CAD panel whose session
   * cannot call a single CAD tool — see the notice near the top of the render.
   */
  const [cadScope, setCadScope] = useState<CadScope | null>(null);
  /** Viewport ground: the user's choice, restored from localStorage. */
  const [bgId, setBgId] = useState<string>(() => loadBackgroundId());
  const [bgPickerOpen, setBgPickerOpen] = useState(false);
  const bg = backgroundById(bgId);
  /**
   * The live scene, so a background change repaints without rebuilding it —
   * a rebuild costs a WebGL context (see the build effect).
   */
  const bgSceneRef = useRef<THREE.Scene | null>(null);
  /** Latest ground for the async build to pick up (it resolves after this render). */
  const bgRef = useRef(bg);
  bgRef.current = bg;
  const [runReport, setRunReport] = useState<any>(null);
  const [fluidBusy, setFluidBusy] = useState(false);
  /** 本地 STL 对话框：预览（不登记）或按路径导入为版本。 */
  const [fileOpen, setFileOpen] = useState(false);
  /**
   * A version id to select once the products poll sees it. Set by the human
   * import path, which returns an id before the panel's 3s poll has refreshed.
   */
  const pendingFocusRef = useRef<string | null>(null);
  const [section, setSection] = useState(false);
  /** Attention heatmap: the layer's own legend, or null when it is off. */
  const [heat, setHeat] = useState<{ legend: string } | null>(null);
  /** Set when this environment cannot give us a WebGL context at all. */
  const [glError, setGlError] = useState<string | null>(null);
  const [measureMode, setMeasureMode] = useState(false);
  const [thickMode, setThickMode] = useState(false);
  const [thick, setThick] = useState<{
    a: [number, number, number];
    b: [number, number, number];
    /** Material thickness along the view ray, mm. */
    dist: number;
  } | null>(null);
  const [sectionPos, setSectionPos] = useState(0.5);
  const [sectionAxis, setSectionAxis] = useState<'x' | 'y' | 'z'>('z');
  /** Inline section (the strip's selection) and the one expanded into the sheet. */
  const [tab, setTab] = useState<string>('overview');
  const [sheet, setSheet] = useState<string | null>(null);
  // The navigator overlay: one searchable list instead of a 类别 dropdown you had
  // to answer before you could see anything.
  const [navOpen, setNavOpen] = useState(false);
  const [navQuery, setNavQuery] = useState('');
  // Which part's version list is expanded past the recent window. Keyed by part
  // id, so switching parts collapses it without an effect to reset it.
  const [expandedVersionsFor, setExpandedVersionsFor] = useState<string | null>(null);

  // The review queue (T4.2): the badge and the overlay read ONE snapshot, so they
  // cannot disagree about how many things are waiting.
  const [review, setReview] = useState<{ items: ReviewItem[]; unread: number; error: string | null }>({ items: [], unread: 0, error: null });
  const [reviewOpen, setReviewOpen] = useState(false);
  useEffect(() => subscribeReviewQueue(setReview), []);
  // Most-recently-viewed addresses (localStorage): the navigator's first section
  // and what the panel restores on reopen.
  const [recent, setRecent] = useState<string[]>(() => loadRecent());
  // The evidence table's filter: the old 类别 list, demoted to a column filter.
  type EvidenceFilter = 'all' | 'current' | 'sim' | 'check' | 'assembly' | 'contract';
  const [evidenceFilter, setEvidenceFilter] = useState<EvidenceFilter>('all');
  /** Bounding box / triangle count of the loaded version, for the 概览 tab. */
  const [spec, setSpec] = useState<{ size: [number, number, number]; triangles: number } | null>(null);
  /** Section-body height: null = auto (give the body everything above square). */
  const [bodyH, setBodyH] = useState<number | null>(() => {
    try {
      const raw = localStorage.getItem('cad.bodyH');
      const n = Number(raw);
      return raw && Number.isFinite(n) && n >= BODY_MIN_PX ? n : null;
    } catch { return null; }
  });
  const [autoBodyH, setAutoBodyH] = useState(158);
  /** Vertical space the viewport + body share (panel minus chrome/padding/gaps). */
  const [stageAvail, setStageAvail] = useState(600);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ y: number; h: number } | null>(null);
  /** Live section state, read by the async scene builder and the pickers. */
  const clipRef = useRef<{ on: boolean; pos: number; axis: 'x' | 'y' | 'z' }>({ on: false, pos: 0.5, axis: 'z' });
  /** Probe dots, rescaled every frame by the render loop. */
  const measureDotsRef = useRef<THREE.Object3D[]>([]);
  const [measure, setMeasure] = useState<{
    a: [number, number, number];
    b?: [number, number, number];
    dist?: number;
  } | null>(null);
  const measureGroupRef = useRef<any>(null);
  /**
   * The cut plane's outline lives in its OWN group: the annotation effect above
   * clears its children every time a measurement changes, so sharing a parent would
   * make the outline disappear the moment the user measured something.
   */
  const sectionGroupRef = useRef<any>(null);
  const meshRef = useRef<any>(null);
  /** Double-sided twin of the mesh, used only for raycasting (see the builder). */
  const pickMeshRef = useRef<THREE.Mesh | null>(null);
  /** Back-face twin that tints the interior exposed by the section cut. */
  const tintRef = useRef<THREE.Mesh | null>(null);
  const cameraRef = useRef<any>(null);
  const versionSceneRef = useRef<OverlayScene | null>(null);
  const versionResetRef = useRef<(() => void) | null>(null);
  const clickStartRef = useRef<{ x: number; y: number } | null>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const recordRef = useRef<string | null>(null);
  const measureRef = useRef<{ a: [number, number, number]; b?: [number, number, number]; dist?: number } | null>(null);
  useEffect(() => { recordRef.current = recordId; }, [recordId]);
  useEffect(() => { measureRef.current = measure; }, [measure]);
  // Auto body height: everything the panel has, minus the fixed chrome and minus
  // a square-plus-air viewport. Recomputed on dock resize, so the default split
  // is never stale.
  useEffect(() => {
    const p = panelRef.current;
    if (!p) return;
    const compute = () => {
      const cs = getComputedStyle(p);
      const padY = parseFloat(cs.paddingTop || '0') + parseFloat(cs.paddingBottom || '0');
      const padX = parseFloat(cs.paddingLeft || '0') + parseFloat(cs.paddingRight || '0');
      const stageW = Math.max(120, p.clientWidth - padX);
      // In-flow rows: browse 26, feedback 20, strip 26, band 23 — the tools live
      // INSIDE the viewport, so they no longer cost layout height.
      const fixed = 26 + 25 + 26 + 23;
      const gaps = 5 * 5;                     // six in-flow children
      const avail = p.clientHeight - padY - gaps - fixed;
      setStageAvail(avail);
      // Default: the body takes everything above a 4:3 viewport.
      setAutoBodyH(Math.max(BODY_MIN_PX, Math.round(avail - stageW * VIEWPORT_RATIO_DEFAULT)));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(p);
    return () => ro.disconnect();
  }, []);
  const bodyHeight = bodyH ?? autoBodyH;
  /** Splitter's upper limit: a 16:9 viewport — flatter than that is pure model loss. */
  const bodyMax = Math.max(
    autoBodyH,
    Math.round(stageAvail - (panelRef.current?.clientWidth ?? 355) * VIEWPORT_RATIO_MIN),
  );
  useEffect(() => {
    if (bodyH === null) return;
    try { localStorage.setItem('cad.bodyH', String(bodyH)); } catch { /* ignore */ }
  }, [bodyH]);

  // Esc closes the overlay: it is a dialog, and it must be cheap to dismiss.
  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSheet(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet]);

  const SCENE = '__scene__';
  /**
   * The first browse column (DESIGN §20): 零件 / 组件 / 整体及仿真 / 装配契约.
   * 零件 keeps the part+version machinery below untouched; the other three
   * categories flatten their runs into one list and hide the version column
   * (runs have no versions).
   */
  type BrowseKind = 'part' | 'machine' | 'assembly' | 'sim' | 'check' | 'contract' | 'unregistered';
  const [kind, setKind] = useState<BrowseKind>('part');
  /**
   * 未登记: workspace mesh files no version accounts for. It is a KIND of the
   * same browse axis, not a modal — the human browses it where they browse
   * everything else (DESIGN §30.18). The list comes from the host's scan, the
   * bytes from /api/cad/file; neither can create a version.
   */
  const [unregistered, setUnregistered] = useState<UnregisteredFileRow[]>([]);
  const [unregError, setUnregError] = useState<string | null>(null);
  // The machine the assembly manifest describes (null: no manifest).
  const [machine, setMachine] = useState<Machine | null>(null);
  const [fileSubject, setFileSubject] = useState<string>('');
  const [fileMeta, setFileMeta] = useState<FileMeta | null>(null);
  // The 未登记 import form (inline, not a modal): the file is already chosen, so
  // the only declarations left are the ones only a human can make.
  const [importUnit, setImportUnit] = useState<ImportUnit>('mm');
  const [importPart, setImportPart] = useState('');
  const [importNonSolid, setImportNonSolid] = useState(false);
  const [importDepth, setImportDepth] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const currentPart = kind === 'part' && subjectId && subjectId !== SCENE
    ? parts.find((p) => p.id === subjectId) ?? null
    : null;
  const latestVersionId = currentPart?.versions[0]?.id ?? null;

  // Flat run pool across every part + the scene bucket, newest first.
  // Category lists live in ./browse so the de-duplication and the category
  // boundaries are testable without a DOM (accept-browse-categories.mjs).
  const { sim: simRuns, assembly: assemblyRuns, contract: contractRuns, check: checkRuns, all: allRuns } = browseCategories(parts, scene);

  // Which part each revision belongs to, and which parts a run's revisions span.
  // A run is MACHINE-level when it cites two or more parts: that is the machine's
  // evidence. One part means the evidence belongs under that part, not at the top.
  const partOfVersion = new Map<string, string>();
  const partByName = new Map<string, string>();
  for (const p of parts) {
    partByName.set(p.name, p.id);
    for (const v of p.versions) partOfVersion.set(v.id, p.id);
  }
  const ownersOfRun = (r: RunProduct): Set<string> =>
    new Set(r.sourceVersionIds.map((v) => partOfVersion.get(v)).filter((x): x is string => Boolean(x)));
  const machineRuns = allRuns.filter((r) => ownersOfRun(r).size >= 2);

  /**
   * The subject's history: its revisions plus the runs that touched it. While
   * the subject is still undecided (`''`) this is empty on purpose — otherwise
   * the first poll would briefly mount a scene run and then swap to the part,
   * burning a WebGL context and flashing the wrong thing.
   */
  // 零件的记录列 = 版本 ONLY (DESIGN §20): runs live in 仿真 / 组件 categories.
  const records: PartRecord[] = (
    currentPart
      ? currentPart.versions.slice().sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
      : (subjectId === SCENE ? scene : [])
  );
  const flatCategoryRuns: PartRecord[] | null = kind === 'machine' ? machineRuns
    : kind === 'sim' ? simRuns
    : kind === 'assembly' ? assemblyRuns
    : kind === 'check' ? checkRuns
    : kind === 'contract' ? contractRuns
    : null;
  /** Which browse group a run belongs to — used when a run is picked anywhere. */
  const browseKindOf = (r: RunProduct): BrowseKind =>
    r.kind === 'assembly' ? 'assembly'
      : r.kind === 'assembly-check' ? 'contract'
        : r.kind === 'motion' || r.kind === 'physics' || r.kind === 'fluid' ? 'sim'
          : 'check';
  const record: PartRecord | null = flatCategoryRuns
    ? (flatCategoryRuns.find((r) => r.id === recordId) ?? null)
    : (records.find((r) => r.id === recordId) ?? null);
  const version: VersionProduct | null = record?.type === 'version' ? record : null;
  const run: RunProduct | null = record?.type === 'run' ? record : null;
  const versionId = version?.id ?? null;
  // What the viewport shows: a version's stored mesh, or an unregistered file's
  // tessellation. ONE scene builder serves both — a preview that looked
  // different from the version it becomes would be its own kind of lie.
  const fileExt = fileSubject.slice(fileSubject.lastIndexOf('.')).toLowerCase();
  const meshSource = versionId
    ? { key: `v:${versionId}`, url: withProject(`/api/cad/stl?v=${encodeURIComponent(versionId)}`), kind: 'version' as const, unitsMm: true }
    : kind === 'unregistered' && fileSubject
      ? {
        key: `f:${fileSubject}`,
        url: `/api/cad/file?project=${encodeURIComponent(sessionCwd())}&path=${encodeURIComponent(fileSubject)}`,
        kind: 'file' as const,
        // An STL has no unit statement; STEP/3MF declare one and the worker folds it.
        unitsMm: fileExt !== '.stl',
      }
      : null;
  const versionIdRef = useRef<string | null>(null);
  useEffect(() => { versionIdRef.current = versionId; }, [versionId]);

  // Ghost comparison (T3.2): which version to overlay as a silhouette.
  //   * viewing an OLD version  → overlay the LATEST (what it became);
  //   * viewing the latest      → overlay the PARENT (what changed in this one).
  // The candidate is null when there is only one version, and for files/runs.
  // `null` = follow the context (an old version opens WITH the comparison, the
  // latest opens without it); a boolean = the user's explicit choice.
  const [compareOn, setCompareOn] = useState<boolean | null>(null);
  const insetRef = useRef<{ scene: THREE.Scene; camera: THREE.PerspectiveCamera; center: THREE.Vector3; distance: number } | null>(null);
  const insetOnRef = useRef(false);
  const ghostVersionId = (() => {
    if (!version || !currentPart) return null;
    if (latestVersionId && version.id !== latestVersionId) return latestVersionId;
    const idx = currentPart.versions.findIndex((v) => v.id === version.id);
    return idx >= 0 ? (currentPart.versions[idx + 1]?.id ?? null) : null;
  })();
  /** Runs of this part whose geometry named the selected version. */
  const runsOnVersion = version
    ? (currentPart?.runs ?? []).filter((r) => r.sourceVersionIds.includes(version.id))
    : [];

  // The tree arrives from ONE shared poller (`products-store`): the header's
  // "open on CAD activity" watcher subscribes to the same request, so a tick now
  // costs one fetch and one build for the whole client half — it used to be two.
  //
  // Applying an update is the panel's own business and stays here: a slow reply
  // for the project you just left must never repaint the one you moved to, and the
  // subject/record rules must never run for another project's tree.
  const applyProducts = (d: ProductsResponse) => {
    // A session with no cwd falls back to the server's own project (the host
    // echoes it), so this check only applies once we know which project we asked for.
    const wanted = currentProject();
    if (wanted && d.project !== undefined && d.project !== wanted) return;
    const list = d.parts ?? [];
    setParts(list);
    setScene(d.scene ?? []);
    // A transient failure (a host restart, say) must not leave a permanent red
    // row that also shifts the whole layout down.
    setError(null);
    setSubjectId((cur) => {
      if (cur === SCENE) return (d.scene ?? []).length ? SCENE : (list[0]?.id ?? '');
      return list.some((p) => p.id === cur) ? cur : (list[0]?.id ?? '');
    });
    // A human import returns a versionId before this poll; select the part
    // that owns it, and PIN it (the import is a deliberate act, not "follow
    // whatever arrives next"). Cleared only when the owner is actually seen.
    const pending = pendingFocusRef.current;
    if (pending) {
      const owner = list.find((p) => p.versions.some((v) => v.id === pending));
      if (owner) {
        pendingFocusRef.current = null;
        setKind('part');
        setSubjectId(owner.id);
        setRecordId(pending);
      }
    }
  };
  // The subscription is created once; this ref always points at the latest closure.
  const applyProductsRef = useRef(applyProducts);
  applyProductsRef.current = applyProducts;

  /** Force a fresh tree now (after a write the human just made). */
  const refresh = () => { void refreshProducts(); };

  // The machine comes from the assembly manifest — the project's own statement of
  // what it is building. Read once per project; a missing manifest is a normal
  // state (a project may not have an assembly yet), not an error.
  useEffect(() => {
    let dead = false;
    fetch(withProject('/api/cad/assembly/manifest'))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!dead) setMachine(parseMachine(d)); })
      .catch(() => { if (!dead) setMachine(null); });
    return () => { dead = true; };
  }, [sessionDir, workspaceCwd, scopeTick]);

  // The 未登记 list is fetched on demand (entering the kind, or 刷新): the scan
  // hashes files, so it is deliberately not on the 3 s poll.
  const refreshUnregistered = () => {
    const cwd = sessionCwd();
    setUnregError(null);
    fetch(`/api/cad/unregistered?project=${encodeURIComponent(cwd)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { files?: UnregisteredFileRow[]; project?: string }) => {
        // A slow reply for the project you just left must not repaint this one.
        if (d.project !== undefined && cwd && d.project !== cwd) return;
        setUnregistered(d.files ?? []);
      })
      .catch((e) => setUnregError(String(e?.message ?? e)));
  };
  useEffect(() => {
    if (kind === 'unregistered') refreshUnregistered();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, sessionDir]);

  // Record selection, in one place:
  //   * entering a part  → its newest REVISION (the version you are iterating);
  //   * a record arriving while following → jump to it (a fresh version or run);
  //   * otherwise stay put, and only fall back if the record disappeared.
  // Deliberately not "newest record always wins": timestamps in a migrated
  // corpus can be milliseconds apart, and a validation run would then displace
  // the revision you were working on every time the panel polls.
  const prevIdsRef = useRef<Set<string>>(new Set());
  const subjectRef = useRef<string>('');
  const kindRef = useRef<BrowseKind | null>(null);
  // The categories with a flat list (仿真 / 组件 / 装配契约) have no 零件 subject,
  // so `records` is empty for them — the effect must follow their own list or
  // switching category leaves the viewport blank (DESIGN §20.4).
  const activeList: PartRecord[] = flatCategoryRuns ?? records;
  const idsKey = `${kind}|${activeList.map((r) => r.id).join('|')}`;
  useEffect(() => {
    const ids = activeList.map((r) => r.id);
    const land = latestVersionId ?? ids[0] ?? null;
    prevIdsRef.current = new Set(ids);
    subjectRef.current = subjectId;
    kindRef.current = kind;
    // ONE rule: an explicit selection survives, anything else lands on the head.
    //
    // A newly arrived version or run does NOT move the viewport. That used to be
    // the 跟随最新 toggle, but the toggle only encoded HOW you had navigated here
    // (picking a part switched it on, picking a version switched it off) — it was
    // a mode pretending to be a preference. The stale banner asks for attention
    // instead: "v067 已有更新" — and the user decides when to look.
    setRecordId((cur) => (cur && ids.includes(cur) ? cur : land));
  }, [idsKey]);

  // A run's report is fetched on selection (and only for runs).
  useEffect(() => {
    setRunReport(null);
    if (!run) return;
    let dead = false;
    fetch(withProject(`/api/cad/run/report?id=${encodeURIComponent(run.id)}`))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!dead) setRunReport(d); })
      .catch(() => { /* the entry itself still renders */ });
    return () => { dead = true; };
  }, [run?.id]);

  // Repaint the ground when the choice changes. Deliberately NOT a scene
  // rebuild: `scene.background` is one property, and rebuilding would burn a
  // WebGL context and re-fit the camera under the user's hands.
  useEffect(() => {
    if (bgSceneRef.current) bgSceneRef.current.background = new THREE.Color(bg.hex);
  }, [bg.hex, versionId]);

  // Subscribe to the shared tree (one poller, one payload, hidden tabs idle) and
  // keep the session/corpus guards that only the panel knows about.
  useEffect(() => {
    const off = subscribeProducts(({ data, error }) => {
      // Re-read the project every tick: this tab is shared by every session, so a
      // session switch must swap the corpus, not merge it.
      const { switched } = refreshProjectScope();
      setSessionDir((cur) => {
        const now = sessionCwd();
        return cur === now ? cur : now;
      });
      if (switched) {
        // Nothing from the previous project survives the switch.
        prevIdsRef.current = new Set();
        subjectRef.current = '';
        setParts([]);
        setScene([]);
        setSubjectId('');
        setRecordId(null);
        setRunReport(null);
        setError(null);
        // A pinned workspace belongs to the old session's tree; follow the new one.
        setWorkspaceCwd('');
        setWorkspaces([]);
        // The 未登记 list and any selected file belong to the old session's
        // workspace; a path from there is not addressable in the new one.
        setUnregistered([]);
        setFileSubject('');
        setFileMeta(null);
        setScopeTick((t) => t + 1);
      }
      if (error) { setError(error); return; }
      if (data) applyProductsRef.current(data);
    });
    // The tool-scope decision is profile-wide and static, so it is fetched once.
    fetch('/api/cad/scope')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setCadScope({ toolScope: d.toolScope, presets: d.presets ?? [] }); })
      .catch(() => { /* an older host without the route: stay silent */ });
    return off;
  }, []);

  // Discover the corpora under this SESSION's workspace root (read-only).
  // Deliberately keyed on the session cwd, not on the pinned workspace: the
  // list must stay stable while you browse, and a session switch re-runs it.
  useEffect(() => {
    const root = sessionDir;
    if (!root) return;
    let dead = false;
    fetch(`/api/cad/projects?root=${encodeURIComponent(root)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { workspaces?: WorkspaceEntry[] }) => {
        if (!dead) setWorkspaces(d.workspaces ?? []);
      })
      .catch(() => { /* discovery is a convenience; "follow session" always works */ });
    return () => { dead = true; };
  }, [scopeTick, sessionDir]);

  // (Re)build the Three.js scene whenever the selected *version* changes.
  // Run products render through their own view instead.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !meshSource) return;
    setSpec(null);
    if (meshSource.kind === 'version') setFileMeta(null);

    // A missing WebGL context must degrade to a message, not take the whole
    // panel down: sandboxed/remote environments hit this routinely (read-only
    // /dev/shm does it on Linux), and the browse tree is still useful there.
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    } catch (e: any) {
      setGlError(String(e?.message ?? e));
      return;
    }
    setGlError(null);
    configureStudioRenderer(renderer);
    renderer.setSize(mount.clientWidth, mount.clientHeight || 420);
    mount.appendChild(renderer.domElement);
    (mount as unknown as { __renderer?: THREE.WebGLRenderer }).__renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(bgRef.current.hex);
    bgSceneRef.current = scene;
    const camera = new THREE.PerspectiveCamera(45, mount.clientWidth / (mount.clientHeight || 420), 0.1, 5000);
    // Camera-relative key/fill/rim (see lighting.ts for why the old
    // world-fixed light + 0.6 ambient was unreadable on small features).
    attachStudioLights(scene, camera);

    let disposed = false;
    let cleanupResize: (() => void) | undefined;
    // Owned by the async load below, disposed by the cleanup that follows.
    let insetOtherGeo: THREE.BufferGeometry | null = null;
    let insetSceneLocal: THREE.Scene | null = null;
    (async () => {
      try {
        const res = await fetch(meshSource.url);
        if (!res.ok) throw new Error(`STL fetch failed: HTTP ${res.status}`);
        if (meshSource.kind === 'file') {
          // The route states the facts a file has no version to carry.
          setFileMeta({
            format: res.headers.get('x-cad-format') ?? '',
            unitsMm: res.headers.get('x-cad-units') === 'mm',
            solid: res.headers.get('x-cad-solid') === '1',
            shells: Number(res.headers.get('x-cad-shells') ?? '0') || 0,
            warnings: decodeURIComponent(res.headers.get('x-cad-warnings') ?? '').split(' | ').filter(Boolean),
          });
        }
        const buf = await res.arrayBuffer();
        const geometry = new STLLoader().parse(buf);
        geometry.computeBoundingSphere();
        geometry.computeBoundingBox();
        if (disposed) return;

        // Frame on the geometry's own box: a part authored away from the origin
        // (a slide, an assembly member) must still land in the middle.
        const box = geometry.boundingBox ?? new THREE.Box3(
          new THREE.Vector3(-10, -10, -10), new THREE.Vector3(10, 10, 10));
        const center = new THREE.Vector3();
        box.getCenter(center);
        const size = new THREE.Vector3();
        box.getSize(size);
        const radius = Math.max(size.length() / 2, 1);

        // Roughness a touch below the old 0.6: the specular roll-off across a
        // fillet or a bore is itself a shape cue, and it sharpens as roughness
        // drops. Metalness stays low because there is no environment map to
        // reflect — raising it without one only darkens the part.
        const material = new THREE.MeshStandardMaterial({ color: '#7aa7d9', metalness: 0.08, roughness: 0.5 });
        const mesh = new THREE.Mesh(geometry, material);
        meshRef.current = mesh;
        // Raycasting honours `material.side`, and the display material is
        // FrontSide: against it the ray only ever reports the surface facing the
        // camera, so the far side of a wall is not hittable at all and no
        // thickness could be measured. Picking therefore uses a double-sided
        // twin that is never added to the scene (same geometry, no transform).
        const pickMesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
        pickMesh.updateMatrixWorld(true);
        pickMeshRef.current = pickMesh;
        // A shader clip has no cap, so the cut reads as a hollow shell. This
        // back-face-only twin paints the exposed inside in a darker tone, so the
        // opening reads as a cut face. Depth testing keeps it behind the front
        // faces (back faces of the near side are culled), so no draw order games.
        const innerMat = new THREE.MeshBasicMaterial({ color: '#41608a', side: THREE.BackSide });
        const innerMesh = new THREE.Mesh(geometry, innerMat);
        innerMesh.visible = false;
        innerMesh.renderOrder = 1;
        tintRef.current = innerMesh;
        scene.add(innerMesh);
        cameraRef.current = camera;
        const mGroup = new THREE.Group();
        scene.add(mGroup);
        measureGroupRef.current = mGroup;
        const sGroup = new THREE.Group();
        scene.add(sGroup);
        sectionGroupRef.current = sGroup;
        // Clipping is enabled on the renderer once and for all: toggling the
        // section or sliding its plane must NOT rebuild the scene, because every
        // rebuild costs a WebGL context (see forceContextLoss below).
        renderer.localClippingEnabled = true;
        applyClip(mesh, clipRef.current, innerMesh);
        scene.add(mesh);

        // Frame the part: same viewing direction as before, but the distance
        // comes from the *current* viewport shape (see `fitDistance`), and it is
        // recomputed on resize as long as the user has not taken the camera over.
        setSpec({
          size: [round3(size.x), round3(size.y), round3(size.z)],
          triangles: geometry.attributes.position.count / 3,
        });
        // Default cut axis = the part's LONGEST extent: that plane halves the
        // biggest silhouette and actually reveals the inside. A z-cut at the bbox
        // middle of the flange removes the whole disc and leaves only the hub —
        // which is exactly what "剖切好像不太对" was.
        setSectionAxis(size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z');

        const VIEW_DIR = new THREE.Vector3(1.6, 1.2, 1.6).normalize();
        const applyFit = () => {
          camera.position.copy(center).addScaledVector(VIEW_DIR, fitDistance(camera, radius));
        };
        applyFit();
        (mesh as unknown as { __radius?: number }).__radius = radius;

        // ── the comparison inset (T3.2) ──────────────────────────────────────
        // The main viewport keeps the SOLID part the user is looking at; the
        // difference lives in a picture-in-picture holding BOTH revisions, both
        // translucent, in different colours. An old version that got SMALLER is
        // invisible under an overlay — it cannot hide here, because the two are
        // drawn side by side in the same frame instead of on top of each other.
        const compareId = ghostVersionId && ghostVersionId !== versionId ? ghostVersionId : null;
        if (compareId) {
          void (async () => {
            try {
              const gres = await fetch(withProject(`/api/cad/stl?v=${encodeURIComponent(compareId)}`));
              if (!gres.ok) return;
              const other = new STLLoader().parse(await gres.arrayBuffer());
              if (disposed) { other.dispose(); return; }
              insetOtherGeo = other;
              const insetScene = new THREE.Scene();
              // A light ground and NORMAL blending: each version keeps its own
              // translucent colour (blue / orange) and the overlap reads as the
              // third colour — "these two coincide". Additive was tried and
              // washed the whole body to white, hiding exactly what "same" means.
              insetScene.background = new THREE.Color('#f2f4f7');
              const glass = (geo: THREE.BufferGeometry, color: string) => new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
                color, transparent: true, opacity: 0.46, depthWrite: false,
              }));
              const here = glass(geometry, '#2563eb');   // blue = the version on screen
              const there = glass(other, '#f97316');     // orange = the counterpart
              here.renderOrder = 1;
              there.renderOrder = 2;
              insetScene.add(here);
              insetScene.add(there);
              // Frame BOTH: cropping the bigger one would hide the very thing
              // this view exists to show.
              const box = new THREE.Box3().setFromObject(insetScene);
              const ic = new THREE.Vector3();
              box.getCenter(ic);
              const isz = new THREE.Vector3();
              box.getSize(isz);
              const ir = Math.max(isz.length() / 2, 1);
              const icam = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
              insetSceneLocal = insetScene;
              // 8% margin: an exact sphere fit makes the silhouette touch the frame,
              // which reads as "cropped" at this size.
              insetRef.current = { scene: insetScene, camera: icam, center: ic, distance: fitDistance(icam, ir) * 1.08 };
            } catch { /* a comparison that cannot load is simply absent */ }
          })();
        }

        // Mouse interaction: wheel zoom, drag rotate (damped).
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.target.copy(center);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.minDistance = radius * 0.3;
        controls.maxDistance = radius * 10;

        // Corner overlays read this live camera; 复原 returns to this framing
        // (recomputed, so it also repairs the frame after a dock resize).
        versionSceneRef.current = { camera, focus: center.clone() };
        versionResetRef.current = () => {
          controls.target.copy(center);
          applyFit();
          controls.update();
        };

        // Resize with the panel (right sidebar width changes on drag).
        let userMoved = false;
        controls.addEventListener('start', () => { userMoved = true; });
        const onResize = () => {
          const w = mount.clientWidth;
          const h = mount.clientHeight || 420;
          renderer.setSize(w, h);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          // A disclosure opening shrinks the viewport too; re-fitting under the
          // user's hands would be rude, so only do it while the camera is ours.
          if (!userMoved) applyFit();
        };
        window.addEventListener('resize', onResize);
        const resizeObserver = new ResizeObserver(onResize);
        resizeObserver.observe(mount);

        let raf = 0;
        const loop = () => {
          if (disposed) return;
          controls.update();
          // Probe dots keep a fixed pixel size: zooming must not inflate them.
          scaleScreenDots(measureDotsRef.current, camera, mount.clientHeight || 420);
          renderer.render(scene, camera);
          // The comparison inset: same view DIRECTION as the main camera (that is
          // the "axes stay in sync" the user asked for), its own fit distance, so
          // both revisions are always fully in frame.
          const inset = insetRef.current;
          if (inset && insetOnRef.current) {
            const w = mount.clientWidth || 1;
            const h = mount.clientHeight || 420;
            const s = Math.max(64, Math.min(Math.round(h * 0.54), Math.round(w * 0.62)));
            const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
            inset.camera.position.copy(inset.center).addScaledVector(dir, inset.distance);
            inset.camera.up.copy(camera.up);
            inset.camera.lookAt(inset.center);
            renderer.setScissorTest(true);
            renderer.setScissor(w - s - 6, 6, s, s);
            renderer.setViewport(w - s - 6, 6, s, s);
            renderer.render(inset.scene, inset.camera);
            renderer.setScissorTest(false);
            renderer.setViewport(0, 0, w, h);
          }
          raf = requestAnimationFrame(loop);
        };
        loop();

        cleanupResize = () => {
          cancelAnimationFrame(raf);
          controls.dispose();
          resizeObserver.disconnect();
          window.removeEventListener('resize', onResize);
        };
      } catch (e: any) {
        if (!disposed) setError(String(e?.message ?? e));
      }
    })();

    return () => {
      disposed = true;
      versionSceneRef.current = null;
      versionResetRef.current = null;
      pickMeshRef.current = null;
      tintRef.current = null;
      cleanupResize?.();
      insetRef.current = null;
      if (insetSceneLocal) {
        insetSceneLocal.traverse((o) => {
          const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(m)) m.forEach((x) => x.dispose()); else m?.dispose();
        });
      }
      insetOtherGeo?.dispose();
      renderer.dispose();
      // dispose() frees GPU resources but NOT the context: without this, every
      // version you visit leaves a live WebGL context until GC, and the browser
      // cap (~16) then turns into "Error creating WebGL context".
      renderer.forceContextLoss();
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
    };
    // Keyed on the SOURCE, not the version: an unregistered file renders through
    // the same builder, and switching version→file must rebuild the scene.
  }, [meshSource?.key]);

  // The comparison lives in its own scene (drawn as a picture-in-picture by the
  // main render loop). This effect only decides whether it is SHOWN — the meshes
  // are built once, with the main scene, so toggling costs nothing.
  useEffect(() => {
    insetOnRef.current = compareOn ?? Boolean(version && latestVersionId && version.id !== latestVersionId);
  }, [compareOn, version, latestVersionId]);

  // --- screenshot + annotation → context tray ---
  const [annotateMode, setAnnotateMode] = useState(false);
  const [annotations, setAnnotations] = useState<{ x0: number; y0: number; x1: number; y1: number; color: string }[]>([]);
  const [tray, setTray] = useState<{ id: string; thumb: string; label: string; status: string; time: string; note: string }[]>([]);
  // A captured screenshot parks here instead of flying straight into the
  // conversation: the user asked for a beat between「📸」and「sent」to type what
  // they mean（"这里的壁厚不对，改到 3mm"）. The draft holds the canvas so
  // 发送 and 只存托盘 both stay lossless.
  const [shotDraft, setShotDraft] = useState<{
    canvas: HTMLCanvasElement;
    url: string;
    label: string;
    /** Auto caption（视图/测量事实）— 机器生成，只读展示，随图必发。 */
    auto: string;
    /** 用户自己的话，与自动说明合并成一条消息发出。 */
    text: string;
    noteOverride?: string;
    /** Set when the capture came from a NON-latest version (DESIGN §20). */
    stale?: { version: string; latest: string };
  } | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  // Switching the displayed model discards every view-bound markup: the
  // annotations and measurements describe the PREVIOUS part — keeping them
  // across a switch produces screenshots whose caption contradicts the image
  // (a 测量 taken on 弯臂 riding on a shot of 镜筒). The section goes too: its
  // position meant something for the old geometry, and the scene builder picks
  // a fresh default axis for the new one anyway. Modes are mode-agnostic but
  // clearing them costs one extra click and removes any ambiguity about which
  // model the next click will land on. (Declared AFTER the states it resets.)
  useEffect(() => {
    setAnnotations([]);
    setMeasure(null);
    setThick(null);
    setAnnotateMode(false);
    setMeasureMode(false);
    setThickMode(false);
    setSection(false);
    setSectionPos(0.5);
    setHeat(null);
  }, [versionId]);
  const overlayRef = useRef<HTMLDivElement>(null);
  const rectRef = useRef<{ x0: number; y0: number; x1: number; y1: number; el: HTMLDivElement } | null>(null);
  const detailsRef = useRef<HTMLDivElement>(null);

  // "Latest value" refs for the async scene builder / pickers: read at call
  // time, so neither has to be an effect dependency (a scene rebuild per slider
  // tick would leak a WebGL context each time).
  clipRef.current.on = section;
  clipRef.current.pos = sectionPos;
  clipRef.current.axis = sectionAxis;

  /** Ray under the pointer, or null if this gesture was an orbit drag. */
  const pickRay = (e: React.MouseEvent): THREE.Raycaster | null => {
    const camera = cameraRef.current;
    const mount = mountRef.current;
    if (!camera || !mount) return null;
    const start = clickStartRef.current;
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) return null;
    const rect = mount.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, camera);
    return raycaster;
  };

  /**
   * Ray hits on surfaces that are actually on screen, nearest first.
   *
   * Two corrections over the raw raycast: coincident duplicates of the same
   * surface are dropped (a mesh that reports one face twice would otherwise
   * "measure" a 0.000mm wall), and with the section on, hits on the clipped-away
   * half are dropped too — they are still in the mesh but no longer visible, and
   * picking them measured geometry the user cannot see.
   */
  const visibleHits = (raycaster: THREE.Raycaster, target: THREE.Mesh) => {
    const raw = raycaster.intersectObject(target, false);
    const hits: typeof raw = [];
    for (const h of raw) {
      const last = hits[hits.length - 1];
      if (!last || h.distance - last.distance > 1e-4) hits.push(h);
    }
    const clip = clipRef.current;
    const box = (target.geometry as THREE.BufferGeometry).boundingBox;
    if (!clip.on || !box) return hits;
    const i = axisIndex(clip.axis);
    const cut = clipCut(box, clip) + 1e-6;
    return hits.filter((h) => h.point.getComponent(i) <= cut);
  };

  /** The mesh to pick against: the double-sided twin when we have it. */
  const pickTarget = (): THREE.Mesh | null => pickMeshRef.current ?? meshRef.current;

  const round3 = (v: number): number => Math.round(v * 1000) / 1000;
  const xyz = (p: THREE.Vector3): [number, number, number] => [round3(p.x), round3(p.y), round3(p.z)];

  // project a world point to CSS pixels within the viewport
  const projectToScreen = (v: [number, number, number]): [number, number] | null => {
    const camera = cameraRef.current;
    const mount = mountRef.current;
    if (!camera || !mount) return null;
    const vec = new THREE.Vector3(v[0], v[1], v[2]).project(camera);
    return [
      (vec.x * 0.5 + 0.5) * mount.clientWidth,
      (-vec.y * 0.5 + 0.5) * mount.clientHeight,
    ];
  };

  /**
   * Snap a raw pick to something the user can actually mean.
   *
   * Two corrections, both of them about the section:
   *
   * 1. **A cut plane has no geometry**, so a click that looks like it lands on the
   *    cut passes through the opening and hits the far interior wall — two points
   *    that look adjacent in a section then measure the part's diagonal. When the
   *    section is on, the pick is constrained to the cut plane.
   * 2. **A click is never exact**, and on a triangulated part a vertex is the one
   *    unambiguously "there" point. Within a few pixels of a vertex the pick snaps
   *    to it, which is what makes reading a corner or a boss centre reliable.
   *
   * The snap radius is stated in PIXELS and converted with the camera, so it keeps
   * its meaning when the part is small or the view is zoomed out.
   */
  const refinePick = (raw: [number, number, number]): [number, number, number] => {
    const geometry = (pickTarget()?.geometry ?? meshRef.current?.geometry) as THREE.BufferGeometry | undefined;
    const camera = cameraRef.current;
    const mount = mountRef.current;
    const clip = clipRef.current;
    const box = geometry?.boundingBox;
    let point = raw;
    if (clip.on && box) {
      point = projectToCutPlane(point, clip.axis, clipCut(box, clip));
    }
    const positions = geometry?.getAttribute('position');
    if (!geometry || !camera || !mount || !positions) return point;
    const distanceMm = camera.position.distanceTo(new THREE.Vector3(point[0], point[1], point[2]));
    const perPixel = millimetresPerPixel({
      fovDeg: (camera as THREE.PerspectiveCamera).fov ?? 45,
      viewportHeightPx: mount.clientHeight,
      distanceMm,
    });
    const radius = Math.max(perPixel * SNAP_PX, 1e-4);
    const snapped = nearestVertex(positions.array as ArrayLike<number>, point, radius);
    // In a section the centre of a HOLE is the target a user actually wants, and a
    // hole centre is not a mesh vertex — so the cut's own loops contribute snap
    // candidates too (see loopCentroids).
    let centre: [number, number, number] | null = null;
    if (clip.on && box) {
      const cut = clipCut(box, clip);
      for (const candidate of loopCentroids(sectionLoops(geometry, clip.axis, cut))) {
        const world = planeToWorld(candidate, clip.axis, cut);
        const away = Math.hypot(world[0] - point[0], world[1] - point[1], world[2] - point[2]);
        if (away > radius) continue;
        if (!centre || away < Math.hypot(centre[0] - point[0], centre[1] - point[1], centre[2] - point[2])) {
          centre = world;
        }
      }
    }
    if (centre && snapped) {
      const toCentre = Math.hypot(centre[0] - point[0], centre[1] - point[1], centre[2] - point[2]);
      const toVertex = Math.hypot(snapped[0] - point[0], snapped[1] - point[1], snapped[2] - point[2]);
      return toCentre <= toVertex ? centre : snapped;
    }
    return centre ?? snapped ?? point;
  };

  // CAD-style two-point pick on the mesh surface (measure mode)
  const pickMeasurePoint = (e: React.MouseEvent) => {
    const target = pickTarget();
    const raycaster = pickRay(e);
    if (!target || !raycaster) return;
    const hits = visibleHits(raycaster, target);
    if (hits.length === 0) { setHint('未点到零件表面 — 再试一次'); return; }
    const p = xyz(new THREE.Vector3(...refinePick(xyz(hits[0]!.point))));
    // Completing the pair ends the mode: the measurement (dots, line, value)
    // stays, but the viewport goes back to orbit/zoom without a second click.
    const finishing = !!measureRef.current && !measureRef.current.b;
    setMeasure((cur) => {
      if (!cur) return { a: p };                                   // first point
      if (!cur.b) {                                                // second point → complete
        const dist = Math.hypot(p[0] - cur.a[0], p[1] - cur.a[1], p[2] - cur.a[2]);
        if (dist < 1e-6) return cur;                               // same spot — ignore
        return { a: cur.a, b: p, dist: +dist.toFixed(2) };
      }
      return { a: p };                                             // complete → start a new one
    });
    setHint(null);
    if (finishing) setMeasureMode(false);
  };

  /**
   * One-click wall thickness: the material between the first and the second
   * surface the view ray crosses. For a thin wall you can see one face but
   * cannot click the other one at all — this is the way to get at it without
   * measuring two points on faces that face the same way.
   */
  const pickThicknessPoint = (e: React.MouseEvent) => {
    const target = pickTarget();
    const raycaster = pickRay(e);
    if (!target || !raycaster) return;
    const hits = visibleHits(raycaster, target);
    if (hits.length < 2) {
      setHint('视线只穿过一层表面 — 换个角度（或用 ◐剖切）让视线穿过壁的两面再点');
      return;
    }
    setThick({
      a: xyz(hits[0]!.point),
      b: xyz(hits[1]!.point),
      dist: +(hits[1]!.distance - hits[0]!.distance).toFixed(2),
    });
    // One click is the whole gesture, and reading it ends the mode — same shape
    // as the two-point measure. The value stays on the line below.
    setThickMode(false);
    setHint('壁厚已读取 — 已退出壁厚模式；再点「▤壁厚」测别处');
  };
  const clearThick = () => { setThick(null); };

  // 🔥 Heatmap: fetch the per-sample values behind the attention field and colour the
  // surface by the layer's OWN thresholds. Off = restore the flat material; nothing is
  // cached across versions, because a picture must not outlive the geometry it shows.
  const toggleHeat = async () => {
    const mesh = meshRef.current;
    const geo = mesh?.geometry as THREE.BufferGeometry | undefined;
    const mat = mesh?.material as THREE.MeshStandardMaterial | undefined;
    // A silent early return is how the first build "did nothing": the click was ignored
    // and the user had no way to tell a missing mesh from a missing field from a missing
    // route. Every exit now says something.
    if (!geo || !mat) {
      setHint('热力图需要先有一个版本的 3D 预览（当前视图里没有可着色的零件）');
      return;
    }
    if (!versionId) {
      setHint('热力图按版本取场数据，但当前预览没有 versionId');
      return;
    }
    if (heat) {
      geo.deleteAttribute('color');
      mat.vertexColors = false;
      mat.needsUpdate = true;
      setHeat(null);
      return;
    }
    try {
      setHint('热力图取数中…');
      // A selected run owns its field; a version asks for the newest one (see attentionQuery).
      const q = attentionQuery({ run: run ? { id: run.id, kind: run.kind } : null, versionId });
      let res = await fetch(withProject(`/api/cad/attention?${q.query}`));
      let fellBack = false;
      if (!res.ok && q.pinnedToRun) {
        // The selected run predates attention fields (or is a kind without one): fall back
        // to the version's newest field, and SAY SO — a silent substitution would be the
        // same "latest wins" lie the pinning exists to remove.
        res = await fetch(withProject(`/api/cad/attention?v=${encodeURIComponent(versionId)}`));
        fellBack = res.ok;
      }
      if (!res.ok) {
        setHint(`热力图：服务器上没有 ${versionId} 的场数据（HTTP ${res.status}）— 先对这个版本跑一次 check_printability 生成 run；` +
          '如果刚更新过插件，还需要重启 dsh 进程，新路由才会存在');
        return;
      }
      const payload = (await res.json()) as AttentionPayload;
      const layer = pickHeatLayer(payload);
      if (!layer) {
        setHint(`场数据回来了（${payload.samples ? Object.keys(payload.samples).join('/') : '空'}），但没有可画的层：壁厚与悬垂采样都少于 8 个`);
        return;
      }
      const { colors } = buildHeatColors(geo, layer);
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      mat.vertexColors = true;
      mat.needsUpdate = true;
      // Name the source run in the legend: the same version can have a press field and a
      // stress field, and "which one am I looking at" must not be a guess (FIX-E5).
      setHeat({ legend: payload.source ? `${layer.legend} · 来源 ${payload.source.runId}（${payload.source.kind}）` : layer.legend });
      setHint(fellBack
        ? '选中的运行没有场数据，已显示该版本最新的一份（来源写在图例里）'
        : null);
    } catch (err) {
      setHint(`热力图取数失败：${String(err).slice(0, 80)}`);
    }
  };

  // add/remove probe dots + dimension lines inside the scene
  useEffect(() => {
    const group: any = measureGroupRef.current;
    if (!group) return;
    while (group.children.length) {
      const c: any = group.children.pop();
      // The dot geometry is shared (DOT_GEO) — only per-call geometries are ours.
      if (c?.userData?.ownGeo) c.geometry?.dispose?.();
      c?.material?.dispose?.();
    }
    measureDotsRef.current = [];

    const dot = (p: [number, number, number], color: number) => {
      const s = new THREE.Mesh(DOT_GEO, new THREE.MeshBasicMaterial({
        color,
        // Annotations sit on top of the model: a dot half-buried in the surface
        // it marks (or hidden by a wall thinner than the dot) is useless.
        depthTest: false,
        depthWrite: false,
      }));
      s.renderOrder = 999;
      s.position.set(p[0], p[1], p[2]);
      group.add(s);
      measureDotsRef.current.push(s);
    };
    const segment = (a: [number, number, number], b: [number, number, number], color: number) => {
      const geom = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(...a), new THREE.Vector3(...b),
      ]);
      const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color, depthTest: false }));
      (line as any).userData.ownGeo = true;
      line.renderOrder = 998;
      group.add(line);
    };

    if (measure) {
      dot(measure.a, MEASURE_COLOR);
      if (measure.b) { dot(measure.b, MEASURE_COLOR); segment(measure.a, measure.b, MEASURE_COLOR); }
    }
    if (thick) {
      dot(thick.a, THICK_COLOR);
      dot(thick.b, THICK_COLOR);
      segment(thick.a, thick.b, THICK_COLOR);
    }
    group.visible = true;
  }, [measure, thick, versionId]);

  /**
   * Outline of the cut plane, so the section reads as a PLANE and not as a hole.
   *
   * A clip plane is a shader effect: it removes material and leaves nothing behind,
   * which is why a cut model used to look like a shell with a bite taken out of it
   * and why clicking "on the cut" was guesswork. The outline is the plane ∩ mesh, and
   * it is what tells the user where the plane actually is — and, with the pick
   * constrained to the same plane (see `refinePick`), where a click will land.
   *
   * Rebuilt only when the plane moves, in the annotation group: sliding the plane
   * must not rebuild the SCENE (every rebuild costs a WebGL context).
   */
  useEffect(() => {
    const group: any = sectionGroupRef.current;
    const geometry = meshRef.current?.geometry as THREE.BufferGeometry | undefined;
    if (!group) return;
    // `spec` is set at the END of the async scene build, so it is the signal that the
    // geometry belongs to the version now on screen — depending on `versionId` alone
    // would draw the outline of the PREVIOUS part for one frame after a switch.
    while (group.children.length) {
      const stale: any = group.children.pop();
      stale.geometry?.dispose?.();
      stale.material?.dispose?.();
    }
    if (!section || !geometry?.boundingBox) return;
    const cut = clipCut(geometry.boundingBox, { pos: sectionPos, axis: sectionAxis });
    // The cap: a clip plane removes material and leaves an open shell, so the cut is
    // filled with the actual cross-section — holes subtracted, not filled in. It is
    // NOT clipped itself (no clippingPlanes): it IS the boundary, and putting it on
    // the same plane as the clip would erase it.
    const cap = capTriangles(geometry, sectionAxis, cut);
    if (cap.length > 0) {
      const capGeometry = new THREE.BufferGeometry();
      capGeometry.setAttribute('position', new THREE.Float32BufferAttribute(cap, 3));
      const capMesh = new THREE.Mesh(capGeometry, new THREE.MeshBasicMaterial({
        color: CAP_COLOR,
        side: THREE.DoubleSide,
      }));
      capMesh.renderOrder = 996;
      group.add(capMesh);
    }
    const flat = sectionSegments(geometry, sectionAxis, cut);
    if (flat.length === 0) return;
    const outline = new THREE.BufferGeometry();
    outline.setAttribute('position', new THREE.Float32BufferAttribute(flat, 3));
    const line = new THREE.LineSegments(outline, new THREE.LineBasicMaterial({ color: SECTION_COLOR }));
    line.renderOrder = 997;
    group.add(line);
  }, [section, sectionPos, sectionAxis, versionId, spec]);

  // Section toggle / slider: update the live material, never rebuild the scene.
  useEffect(() => {
    const mesh = meshRef.current as THREE.Mesh | null;
    if (mesh?.material) applyClip(mesh, clipRef.current, tintRef.current);
  }, [section, sectionPos, sectionAxis, versionId]);

  const clearMeasure = () => { setMeasure(null); };
  const measureNote = measure?.b
    ? `测量: (${measure.a.join(',')}) → (${measure.b.join(',')}) 距离=${measure.dist}mm (版本 ${versionId})`
    : '';

  const captureCanvas = (): HTMLCanvasElement | null => {
    const mount = mountRef.current;
    const renderer = (mount as unknown as { __renderer?: THREE.WebGLRenderer })?.__renderer;
    if (!mount || !renderer) return null;
    const src = renderer.domElement;
    const out = document.createElement('canvas');
    out.width = src.width; out.height = src.height;
    const g = out.getContext('2d');
    if (!g) return null;
    g.drawImage(src, 0, 0);
    // bake committed annotation boxes (CSS px → backing px)
    const sx = out.width / mount.clientWidth;
    const sy = out.height / mount.clientHeight;
    g.lineWidth = 4;
    for (const r of annotations) {
      g.strokeStyle = r.color;
      g.strokeRect(Math.min(r.x0, r.x1) * sx, Math.min(r.y0, r.y1) * sy,
        Math.abs(r.x1 - r.x0) * sx, Math.abs(r.y1 - r.y0) * sy);
    }
    // bake the measurement dimension lines + labels (CSS px → backing px)
    const segs: { a: [number, number, number]; b: [number, number, number]; color: string; label: string }[] = [];
    if (measure?.b) {
      segs.push({ a: measure.a, b: measure.b, color: '#ff3040', label: `${(measure.dist ?? 0).toFixed(2)}mm` });
    }
    if (thick) {
      segs.push({ a: thick.a, b: thick.b, color: '#00838f', label: `壁厚 ${thick.dist.toFixed(2)}mm` });
    }
    for (const seg of segs) {
      const pa = projectToScreen(seg.a);
      const pb = projectToScreen(seg.b);
      if (!pa || !pb) continue;
      const ax = pa[0] * sx, ay = pa[1] * sy, bx = pb[0] * sx, by = pb[1] * sy;
      g.strokeStyle = seg.color;
      g.lineWidth = 3;
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
      for (const [cx2, cy2] of [[ax, ay], [bx, by]] as [number, number][]) {
        g.fillStyle = seg.color;
        g.beginPath(); g.arc(cx2, cy2, (DOT_PX / 2) * sy, 0, Math.PI * 2); g.fill();
      }
      g.font = `bold ${Math.max(16, Math.round(14 * sy))}px monospace`;
      const tw = g.measureText(seg.label).width;
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      g.fillStyle = seg.color;
      g.fillRect(mx - tw / 2 - 6, my - 14, tw + 12, 24);
      g.fillStyle = '#ffffff';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(seg.label, mx, my - 2);
    }
    return out;
  };

  /**
   * The prompt text that rides beside the image. Kept to two short lines: what
   * was captured (so the agent can place it in its own history) and the facts
   * the panel already knows and the picture may not show unambiguously. The
   * image carries the geometry; the text carries the identity.
   */
  const shotPrompt = (label: string): string => {
    const head: string[] = [];
    // A file's caption must not read like a version's: the image is the ONLY
    // handle the conversation has on it (there is no versionId to cite), so the
    // path and the "not evidence" status travel with the picture.
    const asFile = !version && kind === 'unregistered' && fileSubject ? fileSubject : null;
    if (asFile) {
      head.push(`未登记文件 ${asFile}`);
      head.push('不是版本 · 未入证据');
    } else {
      if (currentPart?.name) head.push(`零件「${currentPart.name}」`);
      if (version?.id) head.push(`版本 ${version.id}`);
    }
    head.push(label);
    const facts: string[] = [];
    if (asFile) {
      if (fileMeta) {
        facts.push(`格式 ${fileMeta.format || asFile.split('.').pop()}`);
        facts.push(fileMeta.unitsMm ? '单位 mm（文件自带）' : '单位未声明（按文件数字显示）');
        facts.push(fileMeta.solid ? '封闭实体' : `非封闭（${fileMeta.shells} 个壳）`);
      }
      if (annotations.length) facts.push(`${annotations.length} 处标注框`);
      return `CAD 视口截图 — ${head.join(' · ')}${facts.length ? `\n${facts.join(' · ')}` : ''}`;
    }
    if (spec) facts.push(`包围盒 ${spec.size.map((n) => round3(n)).join(' × ')} mm`);
    // 剖视状态改变画面含义（模型看起来缺一半），模型必须知道截的是什么：
    // 轴向 + 位置。没开剖视就不提，避免每张图都背一句废话。
    if (section) facts.push(`剖视：沿 ${sectionAxis} 轴、保留 ${Math.round(sectionPos * 100)}% 侧（测量点已约束在该剖切面内）`);
    if (measure?.b) {
      facts.push(`两点测量 ${(measure.dist ?? 0).toFixed(2)} mm（自 [${measure.a.map((n) => n.toFixed(1)).join(', ')}] 至 [${measure.b.map((n) => n.toFixed(1)).join(', ')}]）`);
    }
    if (thick) facts.push(`壁厚 ${thick.dist.toFixed(2)} mm`);
    if (annotations.length) facts.push(`${annotations.length} 处标注框`);
    return `CAD 视口截图 — ${head.join(' · ')}${facts.length ? `\n${facts.join(' · ')}` : ''}`;
  };

  const pushToTray = async (
    canvas: HTMLCanvasElement,
    label: string,
    noteOverride?: string,
    opts: { autoSend?: boolean; userText?: string } = {},
  ) => {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (!blob) { setError('截图编码失败'); return; }
    // thumbnail for the tray
    const thumb = document.createElement('canvas');
    thumb.width = 96; thumb.height = Math.max(1, Math.round(canvas.height * 96 / canvas.width));
    thumb.getContext('2d')!.drawImage(canvas, 0, 0, thumb.width, thumb.height);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    setTray((t) => [...t, {
      id,
      thumb: thumb.toDataURL('image/png'),
      // A capture taken from a history version says so: the image will be read
      // later, out of context, and "which revision is this?" must survive the trip.
      label: `${fileSubject && !version ? fileSubject : (recordId ?? '—')}`
        + `${version && latestVersionId && version.id !== latestVersionId ? '（旧版）' : ''}`
        + ` · ${label}${annotations.length ? ` · ${annotations.length}个标注` : ''}`,
      status: '发送中',
      time,
      note: noteOverride ?? '',
    }]);
    // stash the blob for the copy action
    blobById.set(id, { blob, name: `cad-${recordId ?? 'product'}-${label}.png` });
    setError(null);
    // The tray lives at the bottom of the scrollable details area: without this
    // the capture looked like a no-op. Scroll THAT box only — `scrollIntoView`
    // would also scroll an ancestor (the dock body in the real GUI) and drag the
    // whole panel, viewport included, out from under the pointer.
    // Preferred: send it. `conversation.sendSession` both shows the image in the
    // conversation and submits it, so one click replaces "capture → switch to
    // the composer → press Send". Queue mode never interrupts a running turn.
    // Then the composer, then the clipboard, then the tray.
    // autoSend=false (the 📸 dialog's「只存托盘」) stops right here: the shot is
    // parked with its status clearly「待发送」, nothing reaches the model.
    if (opts.autoSend === false) {
      setTray((t) => t.map((x) => x.id === id ? { ...x, status: '待发送', note: noteOverride ?? x.note } : x));
      setHint('截图已存入托盘（未发送）— 在列表里补备注后点 ↻发，或 📋图 复制');
      return;
    }
    const fileName = `cad-${recordId ?? 'view'}-${label}.png`;
    const sent = await sendImageToSession(blob, fileName, opts.userText ?? shotPrompt(label));
    if (sent.how === 'sent') {
      setTray((t) => t.map((x) => x.id === id ? { ...x, status: '已发送' } : x));
      setHint('截图已发送到会话（排队）— Agent 下一回合就能看到这张图');
      return;
    }
    if (sent.how === 'composer') {
      setTray((t) => t.map((x) => x.id === id ? { ...x, status: '待发送' } : x));
      setHint(`已插入会话输入框（${sent.reason ?? '发送通道不可用'}）— 补一句话后发送`);
      return;
    }

    let copied = false;
    try {
      if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        copied = true;
      }
    } catch { copied = false; }

    if (copied) {
      setHint(`已复制到剪贴板（第 ${tray.length + 1} 张）— 回会话输入框 Ctrl+V 即插入`);
      setTray((t) => t.map((x) => x.id === id ? { ...x, status: '已复制' } : x));
    } else {
      // Last resort: the tray is the one place guaranteed visible, so open it.
      setSheet('tray');
      setTray((t) => t.map((x) => x.id === id ? { ...x, status: '需手动发送' } : x));
      setHint(`${sent.reason ? `发送失败（${sent.reason}）` : '插入与剪贴板都不可用'} — 第 ${tray.length + 1} 张已存入浮层，可 ↻发 重试或 📋图 复制`);
    }
  };

  const blobById = new Map<string, { blob: Blob; name: string }>();

  const copyImage = async (id: string) => {
    const item = blobById.get(id);
    if (!item) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': item.blob })]);
      setTray((t) => t.map((x) => x.id === id ? { ...x, status: '图片已复制' } : x));
      setHint('图片已复制 — 输入框 Ctrl+V 粘贴');
    } catch {
      const url = URL.createObjectURL(item.blob);
      const a = document.createElement('a');
      a.href = url; a.download = item.name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setTray((t) => t.map((x) => x.id === id ? { ...x, status: '已下载' } : x));
      setHint('剪贴板不可用 — 已下载文件，可拖入会话');
    }
  };

  const copyNote = async (id: string) => {
    const note = tray.find((x) => x.id === id)?.note?.trim();
    if (!note) { setHint('备注为空 — 先填写备注再复制'); return; }
    try {
      await navigator.clipboard.writeText(note);
      setHint('备注已复制 — 粘贴到会话与图片一起发送');
    } catch {
      setHint('剪贴板不可用 — 请手动选择备注文字复制');
    }
  };

  /** Send one already-captured screenshot again (after a failure, or on purpose). */
  const resendImage = async (id: string) => {
    const item = blobById.get(id);
    const row = tray.find((x) => x.id === id);
    if (!item) { setHint('原图已不在内存里（页面刷新或列表过长）— 请重新截图'); return; }
    const note = row?.note?.trim();
    const text = [`CAD 视口截图 — ${row?.label ?? '视图'}`, note ? note : ''].filter(Boolean).join('\n');
    const r = await sendImageToSession(item.blob, item.name, text);
    setTray((t) => t.map((x) => x.id === id ? {
      ...x,
      status: r.how === 'sent' ? '已发送' : r.how === 'composer' ? '待发送' : '发送失败',
    } : x));
    setHint(r.how === 'sent' ? '已重新发送到会话（排队）'
      : r.how === 'composer' ? `已插入会话输入框（${r.reason ?? '发送通道不可用'}）— 补一句话后发送`
        : `发送失败：${r.reason ?? '未知原因'} — 可点 📋图 复制后手动粘贴`);
  };

  /** Capture and open the compose dialog — nothing is sent until the user confirms. */
  const openShotDraft = (canvas: HTMLCanvasElement, label: string, noteOverride?: string) => {
    const auto = shotPrompt(label);
    // Capture-time staleness: a screenshot of an old revision that later gets
    // sent as "this is the part" is exactly the confusion the banner exists
    // for — carry the fact into the draft so the warning can follow the image.
    const stale = kind === 'part' && version && latestVersionId && versionId !== latestVersionId
      ? { version: version.id, latest: latestVersionId }
      : undefined;
    setShotDraft({ canvas, url: canvas.toDataURL('image/png'), label, auto, text: noteOverride ?? '', noteOverride, stale });
  };

  const onScreenshot = async () => {
    const canvas = captureCanvas();
    if (!canvas) { setError('视口尚未就绪'); return; }
    openShotDraft(canvas, measure?.b ? `测量 ${(measure.dist ?? 0).toFixed(2)}mm` : '截图', measureNote || undefined);
  };

  /** 发送 = 自动说明（只读，机器生成的事实）+ 用户写的话，合成一条消息。 */
  const sendShotDraft = async () => {
    const d = shotDraft;
    if (!d) return;
    if (d.stale && !window.confirm(
      `⚠ 这张截图来自旧版本 ${d.stale.version}（最新为 ${d.stale.latest}）。\n` +
      '确认它就是你要让模型看的内容，并仍要发送？')) return;
    setShotDraft(null);
    const note = d.text.trim();
    const text = [d.auto, note].filter(Boolean).join('\n');
    // The full message doubles as the tray note so ↻发 re-sends the same words.
    await pushToTray(d.canvas, d.label, text, { userText: text });
  };

  /** 只存托盘: park it, send later (or never) from the list. */
  const parkShotDraft = async () => {
    const d = shotDraft;
    if (!d) return;
    setShotDraft(null);
    await pushToTray(d.canvas, d.label, d.text.trim(), { autoSend: false });
  };

  const overlayPointer = (kind: 'down' | 'move' | 'up') => (e: React.PointerEvent) => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    // The rubber-band box is 标注's gesture and nobody else's. This used to fall
    // through for 测量/壁厚, so merely dragging to orbit in those modes painted a
    // box and committed it as an annotation.
    if (!annotateMode) return;
    if (kind === 'down') {
      const bounds = overlay.getBoundingClientRect();
      const el = document.createElement('div');
      el.style.position = 'absolute';
      el.style.border = '2px solid #e74c3c';
      el.style.background = 'rgba(231,76,60,0.12)';
      el.style.pointerEvents = 'none';
      overlay.appendChild(el);
      rectRef.current = { x0: e.clientX - bounds.left, y0: e.clientY - bounds.top, x1: e.clientX - bounds.left, y1: e.clientY - bounds.top, el };
      try { overlay.setPointerCapture(e.pointerId); } catch { /* synthetic events have no active pointer */ }
      return;
    }
    const rect = rectRef.current;
    if (!rect) return;
    const bounds = overlay.getBoundingClientRect();
    if (kind === 'move') {
      rect.x1 = e.clientX - bounds.left; rect.y1 = e.clientY - bounds.top;
      rect.el.style.left = `${Math.min(rect.x0, rect.x1)}px`;
      rect.el.style.top = `${Math.min(rect.y0, rect.y1)}px`;
      rect.el.style.width = `${Math.abs(rect.x1 - rect.x0)}px`;
      rect.el.style.height = `${Math.abs(rect.y1 - rect.y0)}px`;
      return;
    }
    // up: commit the box — it stays visible on the viewport until cleared
    const w = Math.abs(rect.x1 - rect.x0);
    const h = Math.abs(rect.y1 - rect.y0);
    overlay.removeChild(rect.el);
    rectRef.current = null;
    if (w < 6 || h < 6) return; // treat tiny drags as accidental
    // Overlap rejection: boxes must not cover each other.
    const nx0 = Math.min(rect.x0, rect.x1), ny0 = Math.min(rect.y0, rect.y1);
    const nx1 = Math.max(rect.x0, rect.x1), ny1 = Math.max(rect.y0, rect.y1);
    const overlaps = annotations.some((a) =>
      nx0 < a.x1 && nx1 > a.x0 && ny0 < a.y1 && ny1 > a.y0);
    if (overlaps) {
      setHint('新标注与已有标注重叠 — 请换个位置或先清除重叠的框');
      return;
    }
    const color = ANN_COLORS[annotations.length % ANN_COLORS.length]!;
    setAnnotations((a) => [...a, { x0: nx0, y0: ny0, x1: nx1, y1: ny1, color }]);
  };

  const runFluid = async () => {
    if (!versionId || fluidBusy) return;
    setFluidBusy(true);
    setError(null);
    try {
      const res = await fetch(withProject('/api/cad/fluid/run'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ versionId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      await refresh();
    } catch (e: any) {
      setError(`流体仿真失败: ${String(e?.message ?? e)}`);
    } finally {
      setFluidBusy(false);
    }
  };

  /** Report-only runs (assembly manifest check) have no geometry to draw. */
  const reportOnlyCard = (r: RunProduct) => React.createElement(
    'div',
    {
      style: {
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 6, padding: 16, textAlign: 'center',
      },
    },
    React.createElement('div', { style: { fontSize: 30 } }, '📋'),
    React.createElement('div', { style: { fontSize: 13, fontWeight: 600 } }, runTitle(r)),
    React.createElement('div', { style: { fontSize: 12, color: '#4b5563' } }, r.summary),
    React.createElement('div', { style: { fontSize: 11, color: '#8a94a0' } },
      '这次运行没有几何体 — 清单检查只读接口与 datum'),
  );

  /** Compact per-kind report body, rendered from the run's own report.json. */
  const runReportBody = (r: RunProduct): React.ReactNode => {
    const rep = runReport;
    if (!rep) return React.createElement('div', { style: S.hint }, '报告读取中…');
    const line = (text: string, color?: string) =>
      React.createElement('div', { style: { fontSize: 12, padding: '1px 0', color: color ?? '#374151' } }, text);


    if (r.kind === 'physics') {
      const fell = Object.entries((rep.metrics?.fellOver ?? {}) as Record<string, boolean>);
      return React.createElement('div', null,
        line(`稳态穿透 ${rep.metrics?.settledPenetrationMm ?? '—'}mm · 最大 ${rep.metrics?.maxPenetrationMm ?? '—'}mm`),
        line(`时长 ${rep.durationSec ?? '—'}s · 关键帧 ${(rep.keyframes ?? []).length}`),
        ...fell.map(([name, over]) => line(`${name}: ${over ? '倒下' : '保持直立'}`, over ? '#b8860b' : '#27ae60')),
        ...(rep.metrics?.jointViolations ?? []).map((v: string, i: number) => line(v, '#c0392b')),
      );
    }
    if (r.kind === 'motion') {
      const followers = Object.entries((rep.metrics?.followers ?? {}) as Record<string, { travelMm: number; periodSec: number | null; axis: string }>);
      return React.createElement('div', null,
        line(`干涉 ${rep.metrics?.interferenceCount ?? '—'} 次 · 时长 ${rep.durationSec ?? '—'}s`),
        ...followers.map(([name, f]) => line(
          `${name}: 行程 ${f.travelMm?.toFixed?.(2) ?? '—'}mm` + (f.periodSec ? ` · 周期 ${f.periodSec.toFixed(2)}s` : ''))),
        ...((rep.metrics?.interferenceEvents ?? []) as { timeSec: number; label: string }[])
          .slice(0, 6).map((e, i) => line(`t=${e.timeSec}s ${e.label}`, '#c0392b')),
      );
    }
    if (r.kind === 'fluid') {
      return React.createElement('div', null,
        line(`到达率 ${rep.metrics?.outletArrivalRatio ?? '—'} · 穿透 ${rep.metrics?.penetrationCount ?? '—'}`),
        line(`粒子 ${rep.metrics?.particleCount0 ?? '—'} · 逃逸 ${rep.metrics?.escaped ?? '—'} · 活动 ${rep.metrics?.active ?? '—'}`),
        line(`状态 ${rep.overallStatus ?? '—'}`),
      );
    }
    if (r.kind === 'assembly-check') {
      // 装配契约报告 = 表格（DESIGN §20）：接口 × 要求 × 实测 × 判定。
      const rows = (rep.results ?? rep.hardViolations ?? rep.intentFlags ?? []) as {
        interfaceId?: string; a?: string; b?: string; type?: string;
        expected?: { quantity?: string; min?: number; max?: number };
        measured?: number; verdict?: string; detail?: string;
      }[];
      const color = (v?: string) => v === 'pass' ? '#27ae60' : v === 'intent-flag' ? '#b8860b' : '#c0392b';
      const req = (e?: { quantity?: string; min?: number; max?: number }) =>
        e ? `${e.quantity ?? ''} ${e.min ?? '≤'}–${e.max ?? ''}`.trim() : '—';
      const cell = (text: React.ReactNode, opts: { strong?: boolean; color?: string } = {}) =>
        React.createElement('td', {
          style: { padding: '3px 6px', borderBottom: '1px solid #e5e7eb', fontSize: 11,
                   fontWeight: opts.strong ? 600 : 400, color: opts.color ?? '#374151' },
        }, text);
      return React.createElement('div', { style: { overflowX: 'auto' } },
        line(`清单「${rep.manifestName ?? '—'}」· ${rep.results?.length ?? rows.length} 个接口 · ` +
             `通过 ${(rep.results ?? []).filter((x: any) => x.verdict === 'pass').length}`),
        React.createElement('table', { style: { borderCollapse: 'collapse', width: '100%', marginTop: 4 } },
          React.createElement('thead', null, React.createElement('tr', {},
            ['接口', '零件对', '要求', '实测', '判定'].map((h) =>
              React.createElement('th', { key: h, style: { padding: '3px 6px', fontSize: 11, textAlign: 'left',
                borderBottom: '2px solid #d1d5db', color: '#6b7280' } }, h)))),
          React.createElement('tbody', null, rows.map((row, i) =>
            React.createElement('tr', { key: i },
              cell(row.interfaceId ?? '—', { strong: true }),
              cell(`${row.a ?? '?'} ↔ ${row.b ?? '?'}`),
              cell(req(row.expected)),
              cell(String(row.measured ?? '—')),
              cell(row.verdict ?? '—', { strong: true, color: color(row.verdict) }))))),
      );
    }
    if (r.kind === 'assembly') {
      return React.createElement('div', null,
        ...((rep.parts ?? []) as { name: string; watertight: boolean; volume: number }[]).map((p, i) =>
          line(`${p.name}: ${p.watertight ? '水密' : '非水密'} · ${p.volume?.toFixed?.(0) ?? '—'}mm³`, p.watertight ? '#374151' : '#c0392b')),
        ...((rep.pairs ?? []) as { partA: string; partB: string; intersectionVolume: number; minDistance: number; status: string }[])
          .map((p, i) => line(
            `${p.partA} ↔ ${p.partB}: ` + (p.status === 'interference'
              ? `干涉体积 ${p.intersectionVolume.toFixed(1)}mm³`
              : `间隙 ${p.minDistance.toFixed(2)}mm (${p.status === 'too_tight' ? '过紧' : '正常'})`),
            p.status === 'interference' ? '#c0392b' : p.status === 'too_tight' ? '#b8860b' : '#27ae60')),
      );
    }
    // assembly-check
    const s = rep.summary ?? {};
    return React.createElement('div', null,
      line(`${s.interfaces ?? 0} 接口 · 通过 ${s.pass ?? 0} · 硬冲突 ${s.hardViolations ?? 0} · 意图偏差 ${s.intentFlags ?? 0} · 未声明 ${s.undeclared ?? 0}`),
      ...((rep.results ?? []) as { interfaceId: string; verdict: string; measured: number; type: string }[]).map((x, i) =>
        line(`${x.interfaceId} (${x.type}) — ${x.verdict} · 实测 ${x.measured}`,
          x.verdict === 'pass' ? '#27ae60' : x.verdict === 'hard-violation' ? '#c0392b' : '#b8860b')),
      ...((rep.undeclared ?? []) as { partA: string; partB: string; minDistance: number; intersectionVolume: number }[]).map((u, i) =>
        line(`未声明邻接: ${u.partA} ↔ ${u.partB} · ` + (u.intersectionVolume > 0
          ? `干涉 ${u.intersectionVolume.toFixed(1)}mm³`
          : `间隙 ${u.minDistance.toFixed(2)}mm`), '#b8860b')),
      ...((rep.partWarnings ?? []) as { partId: string; messages: string[] }[]).map((w, i) =>
        line(`${w.partId}: ${w.messages.join('; ')}`, '#b8860b')),
    );
  };

  const ownerPartOf = (versionId: string): PartProduct | null =>
    parts.find((p) => p.versions.some((v) => v.id === versionId)) ?? null;

  const sourceVersionChips = (r: RunProduct) => React.createElement(
    'div',
    { style: { ...S.row, flexWrap: 'wrap', paddingBottom: 4 } },
    React.createElement('span', { style: { fontSize: 11, color: '#8a94a0', flex: 'none' } }, '来源:'),
    r.sourceVersionIds.length === 0
      ? React.createElement('span', { style: { fontSize: 11, color: '#8a94a0' } },
        '内联 SCAD 场景 — 这次运行不基于任何已存版本')
      : r.sourceVersionIds.map((vid) => {
        const owner = ownerPartOf(vid);
        return React.createElement('button', {
          key: vid,
          type: 'button',
          onClick: () => { setSubjectId(owner?.id ?? SCENE); setRecordId(vid); },
          title: owner ? `打开零件「${owner.name}」的 ${vid}` : `打开 ${vid}`,
          style: S.smallBtn,
        }, `${owner?.name ?? '未归类'} · ${vid}`);
      }),
  );

  // ── the bottom status band ──
  // Deliberately NOT a repeat of the two dropdowns one row above: they already
  // carry the part name and the record id. The band carries what they cannot —
  // a verdict stated in words (a version has none of its own; only the runs that
  // named it do), the revision's index inside the part's history, and where the
  // geometry came from.
  // A run shows the judgement it actually made; a run that judged nothing (risk map,
  // fluid trend) shows 未判定 rather than borrowing its `status` as if it were one.
  const verdict: RunJudgement | null = run
    ? judgementOf(run)
    : version ? versionVerdict(runsOnVersion) : null;
  const revIndex = version && currentPart
    ? currentPart.versions.findIndex((v) => v.id === version.id) : -1;
  const revText = version && currentPart && revIndex >= 0
    ? `第 ${currentPart.versions.length - revIndex}/${currentPart.versions.length} 版` : null;
  const provenance = run
    // Count, not the ids: the band's frozen right edge must stay short enough
    // that the run's own summary wins the space (the ids are in the tooltip and
    // as clickable chips in the details).
    ? (run.sourceVersionIds.length ? `来源 ${run.sourceVersionIds.length} 版` : '内联 SCAD')
    : version ? (runsOnVersion.length ? `本版 ${runsOnVersion.length} 次验证` : '本版无验证')
      : null;
  const statusIdentity = record
    ? [record.id, run ? RUN_KIND_LABEL[run.kind] : '版本', revText, fmtTime(record.timestamp)]
      .filter(Boolean).join(' · ')
    : (parts.length === 0 ? '还没有零件 — 让 Agent 生成一个' : '该零件还没有记录');  // The description is the elidable tail: identity and revision come first.
  const statusDetail = record ? (run ? run.summary || runTitle(run) : version?.title ?? '') : '';
  const statusTooltip = record
    ? [
      statusIdentity, statusDetail,
      // Full provenance in the tooltip — the band only has room for the count.
      run ? (run.sourceVersionIds.length ? `来源 ${run.sourceVersionIds.join(' · ')}` : '内联 SCAD 场景') : null,
      run?.supersededBy
        ? `已被 ${run.supersededBy} 取代 — 同类、同主题（同一份清单 / 同一组零件）的更新一次运行`
        : null,
      provenance, `零件：${currentPart?.name ?? '跨零件场景'}`,
    ].filter(Boolean).join('\n')
    : statusIdentity;

  /**
   * Chips pinned to the probe points — the read-out that follows the model.
   * (The line under the viewport stays: this is the "tooltip", that is the text.)
   */
  const mid = (a: [number, number, number], b: [number, number, number]): [number, number, number] =>
    [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const probeLabels: ViewportLabel[] = [
    ...(measure
      ? [{
        key: 'measure',
        text: measure.b ? `${(measure.dist ?? 0).toFixed(2)} mm` : '第一点…',
        world: measure.b ? mid(measure.a, measure.b) : measure.a,
        color: '#c0392b',
      }]
      : []),
    ...(thick
      ? [{ key: 'thick', text: `壁厚 ${thick.dist.toFixed(2)} mm`, world: mid(thick.a, thick.b), color: '#00838f' }]
      : []),
  ];

  /** One line, whatever the state: the feedback block's height is fixed. */
  const feedbackText = annotateMode ? '标注：在视口里拖框框出问题区域，完成后点 📸 截图带走'
    : measureMode ? (!measure ? '测量：点击零件表面第一个点（可先旋转视角）'
      : '测量：已选第一点 — 点击第二个点出距离（量完自动退出测量）')
    : thickMode ? '壁厚：单击零件任意一处即读数（不用点第二个面、不用拉框），读完自动退出'
    : hint ?? (version
      ? '工具在视口左上角；「⤢」放大下面任一节'
      : '回放产物：截图在各回放视图内（📸）；「⤢」放大报告/几何体');

  // ── sections ──────────────────────────────────────────────────────────────
  // The strip is the table of contents (one fixed 26px row); the body holds the
  // selected section in a fixed box; "⤢" lifts that same section into an overlay
  // sheet that can use the whole panel height. Which of the two renders the
  // content is exclusive, so the section's inputs are never mounted twice.
  const tabs: { id: string; label: string }[] = kind === 'machine'
    ? [
      { id: 'overview', label: '概览' },
      { id: 'evidence', label: `证据${machineRuns.length ? ` ${machineRuns.length}` : ''}` },
      { id: 'nodes', label: `清单${machine ? ` ${machine.nodes.length}` : ''}` },
      { id: 'help', label: '用法' },
    ]
    : version
    ? [
      { id: 'overview', label: '概览' },
      // The part's whole evidence, not only the runs that named THIS revision:
      // that narrower list stays in 验证.
      { id: 'evidence', label: `证据${currentPart?.runs.length ? ` ${currentPart.runs.length}` : ''}` },
      { id: 'export', label: '导出' },
      { id: 'help', label: '用法' },
    ]
    : [
      { id: 'overview', label: '概览' },
      ...(run ? [{ id: 'report', label: '报告' }] : []),
      ...(run?.hasGeometry ? [{ id: 'geometry', label: `几何体 ${run.parts.length}` }] : []),
      { id: 'help', label: '用法' },
    ];
  const tabLabel = (id: string): string => (id === 'tray'
    ? `上下文插入列表（${tray.length}）`
    : tabs.find((t) => t.id === id)?.label ?? id);

  /** What each tool does and how to drive it; the answer to "这些按钮怎么用". */
  const helpBody = () => React.createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11, lineHeight: 1.5 } },
    ...([
      ['📏测量', '点一下进入测量 → 点零件上第一个点 → 点第二个点。两个点选完**自动退出**测量，红点/连线/读数都留着（再点 📏测量 可量下一处）。'],
      ['▤壁厚', '点一下进入壁厚 → **单击**零件任意一处：读的是「沿视线」穿过材料两面的厚度（薄壁只看得见一个面，所以不用点两个点）。读完**自动退出**，读数留在下面那行；不用拉框——拉框是「▭标注」。'],
      ['▭标注', '点一下进入标注 → 在视口里拖框框出问题区域 → 点 📸截图，框会一起带走。'],
      ['◐剖切', '点一下切开：沿 z 切掉近侧半边看内部；下面那行可换 x / y / z 轴并拖滑块改切面位置（看中心孔这类内部结构，用 x 或 y 纵向切）。剖切状态下测量只认看得见的面。'],
      ['📸截图', '点一下先弹出发送框：预览截图、写一句你想让它做什么（可改写默认说明），再点「发送到会话」——文字随图一起给模型，不用再补消息。也可「只存托盘」以后再发。运行中的回合不会被打断（排在你后面）。'],
      ['⤢ 放大', '把下面这一节抬到浮层，可用整栏高度阅读；浮层不占版式，所以放大/收回都不会让模型跳动。Esc 或 ✕ 收回。'],
    ] as [string, string][]).map(([k, v]) => React.createElement('div', { key: k, style: { display: 'flex', gap: 6 } },
      React.createElement('span', { style: { flex: 'none', width: 58, fontWeight: 600, color: '#3b4450' } }, k),
      React.createElement('span', { style: { color: '#5b6673' } }, v),
    )),
    React.createElement('div', { style: { color: '#8a94a0', borderTop: '1px solid #eef1f3', paddingTop: 5 } },
      '测量 / 壁厚 / 标注只对零件版本可用；回放产物（物理 / 机构 / 流体）在各回放视图内自带截图按钮。'),
  );

  const trayBody = () => React.createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
    tray.length === 0
      ? React.createElement('div', { style: S.hint }, '还没有截图 — 点工具栏的 📸截图，先写一句话（想让它改什么）再发进会话。')
      : React.createElement('div', null, ...tray.map((item) => React.createElement(
        'div',
        { key: item.id, style: { display: 'flex', gap: 6, alignItems: 'flex-start', padding: '3px 0' } },
        React.createElement('img', {
          src: item.thumb, style: { width: 52, flex: 'none', borderRadius: 4, border: '1px solid #e3e7ea' },
        }),
        React.createElement(
          'div',
          { style: { flex: 1, minWidth: 0, fontSize: 11 } },
          React.createElement('div', {
            style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, item.label),
          React.createElement('div', { style: { color: '#8a94a0', fontSize: 10 } }, item.time, ' · ', item.status),
          React.createElement('input', {
            type: 'text',
            placeholder: '备注（重发时随图给模型）',
            value: item.note,
            onChange: (e: any) => setTray((t) => t.map((x) => x.id === item.id ? { ...x, note: e.target.value } : x)),
            style: { width: '100%', marginTop: 2, fontSize: 11, padding: '2px 5px', border: '1px solid #e3e7ea', borderRadius: 4 },
          }),
        ),
        React.createElement('button', {
          type: 'button', onClick: () => void resendImage(item.id),
          title: '把这张图再发一次到会话（排队）', style: S.smallBtn,
        }, '↻发'),
        React.createElement('button', {
          type: 'button', onClick: () => void copyImage(item.id),
          title: '复制图片，粘贴到会话输入框', style: S.smallBtn,
        }, '📋图'),
        React.createElement('button', {
          type: 'button', onClick: () => void copyNote(item.id),
          title: '复制备注文本，粘贴到会话与图片一起发送', style: S.smallBtn,
        }, '📋文'),
        React.createElement('button', {
          type: 'button', onClick: () => setTray((t) => t.filter((x) => x.id !== item.id)), style: S.smallBtn,
        }, '✕'),
      ))),
    React.createElement('div', { style: { fontSize: 11, color: '#8a94a0', lineHeight: 1.5 } },
      '截图默认已直接发进会话（排队，不打断运行中的回合）；这里的 ↻发 用于重发，📋图 用于手动粘贴'),
  );

  /**
   * The part's evidence — a table you can tell apart WITHOUT opening a row.
   *
   * This is the surface the original complaint asked for: microscope5 has fifteen
   * motion runs about one mechanism, all titled `机构运动 · v014+v025+v026`. Each
   * row now carries the result, what it was about, WHICH revisions were posed, and
   * whether the evidence still stands; the old 类别 list is demoted to the filter
   * chips above.
   */
  const evidenceBody = (scope: 'part' | 'machine') => {
    const all = scope === 'machine' ? machineRuns : (currentPart?.runs ?? []);
    const groups: { id: EvidenceFilter; label: string; test: (r: RunProduct) => boolean }[] = [
      { id: 'all', label: '全部', test: () => true },
      { id: 'sim', label: '仿真', test: (r) => browseKindOf(r) === 'sim' },
      { id: 'check', label: '检查', test: (r) => browseKindOf(r) === 'check' },
      { id: 'assembly', label: '组件', test: (r) => browseKindOf(r) === 'assembly' },
      { id: 'contract', label: '契约', test: (r) => browseKindOf(r) === 'contract' },
    ];
    // 本版 is the scope the old 验证 tab had, now a FILTER instead of a second tab:
    // one list, two views ("this revision was tested by" vs "this part was").
    const vid = scope === 'part' ? version?.id ?? null : null;
    if (vid) {
      groups.splice(1, 0, { id: 'current', label: '本版', test: (r) => r.sourceVersionIds.includes(vid) });
    }
    const active = groups.find((g) => g.id === evidenceFilter) ?? groups[0]!;
    const list = all.filter(active.test);

    const badge = (text: string, color: string) =>
      React.createElement('span', {
        style: {
          flex: 'none', fontSize: 10, lineHeight: '14px', padding: '0 4px', borderRadius: 3,
          color, border: `1px solid ${color}55`, background: `${color}11`,
        },
      }, text);

    const row = (r: RunProduct) => React.createElement('button', {
      key: r.id,
      type: 'button',
      // The sandbox's ?assert=evidence reads these; a DOM assertion is the only
      // way to check "rows are distinguishable" without eyeballing a screenshot.
      'data-evidence-row': '',
      'data-evidence-id': r.id,
      // The two visible lines are the scannable part; the tooltip is the full
      // manifest of the row (ids, versions, summary) for when it is not enough.
      title: `${r.id} · ${runTitle(r)}\n${r.sourceVersionIds.join(' · ')}`
        + (r.summary ? `\n${r.summary}` : '')
        + (r.staleVersionIds?.length ? `\n⚠ 基于旧版本 ${r.staleVersionIds.join(', ')}` : '')
        + (r.supersededBy ? `\n已被 ${r.supersededBy} 取代` : ''),
      onClick: () => { setKind(browseKindOf(r)); setRecordId(r.id); },
      style: {
        display: 'flex', flexDirection: 'column', gap: 2, width: '100%', textAlign: 'left',
        padding: '5px 6px', border: 'none', borderBottom: '1px solid #f0f2f4',
        background: r.id === recordId ? '#eaf3fc' : 'transparent', cursor: 'pointer',
      },
    },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 } },
        statusGlyph(r.status),
        React.createElement('span', { style: { flex: 'none', fontSize: 11, fontWeight: 600, color: '#5b6673' } }, r.id),
        React.createElement('span', {
          // Named for the sandbox assertion: `innerText` on a <button> does not
          // reliably separate its block children, so the two lines are read by
          // attribute instead of by guessing at text layout.
          'data-evidence-title': '',
          style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: '#26303a' },
        }, runTitle(r)),
        r.staleVersionIds?.length ? badge('旧版', '#b8860b') : null,
        r.supersededBy ? badge('已被取代', '#8a94a0') : null,
      ),
      // Second line = the DISCRIMINATORS: which revisions were posed, then what
      // the run found. Fifteen same-named runs differ exactly here.
      React.createElement('div', {
        'data-evidence-meta': '',
        style: { fontSize: 10, color: '#8a94a0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, [
        r.sourceVersionIds.join(' · '),
        r.summary,
        // Time last: the list is already newest-first, but two runs of the same
        // revisions need one more discriminator before they read as duplicates.
        fmtTime(r.timestamp),
      ].filter(Boolean).join(' — ')),
    );

    return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
      React.createElement('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } },
        ...groups.map((g) => React.createElement('button', {
          key: g.id,
          type: 'button',
          'data-evidence-chip': g.id,
          onClick: () => setEvidenceFilter(g.id),
          style: {
            fontSize: 11, padding: '1px 6px', borderRadius: 10, cursor: 'pointer',
            border: `1px solid ${evidenceFilter === g.id ? '#4a7dbd' : '#d5d9dd'}`,
            background: evidenceFilter === g.id ? '#eaf3fc' : '#fff',
            color: evidenceFilter === g.id ? '#2f6fdb' : '#5b6673',
          },
        }, `${g.label} ${all.filter(g.test).length}`)),
      ),
      list.length === 0
        ? React.createElement('div', { style: S.hint }, '没有符合条件的证据 — 换一个筛选，或让 Agent 对它跑一次检查。')
        : React.createElement('div', null, ...list.map(row)),
      scope === 'part' && version && React.createElement(
        'div',
        { style: { borderTop: '1px solid #eef1f3', paddingTop: 6, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
        React.createElement('button', {
          type: 'button',
          onClick: () => void runFluid(),
          disabled: fluidBusy,
          style: { ...S.smallBtn, border: '1px solid #2c81ba', background: '#e8f4fa', opacity: fluidBusy ? 0.55 : 1 },
        }, fluidBusy ? '仿真中…（可能数分钟）'
          : version.id !== latestVersionId
            ? `在旧版 ${version.id} 上跑流体（结果会标注基于旧版）`
            : `以 ${version.id} 为管件跑流体仿真`),
        React.createElement('span', { style: S.hint }, '跑完会作为新运行出现在证据里'),
      ),
    );
  };

  /** What the machine physically is, and where its evidence went. */
  const machineOverview = () => React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
    React.createElement('div', { style: { fontSize: 12, fontWeight: 600, color: '#26303a' } }, machine?.name ?? '整机'),
    React.createElement('div', { style: S.hint },
      `清单 ${machine?.nodes.length ?? 0} 个节点 · ${machine?.distinctParts ?? 0} 种零件 · 机器级证据 ${machineRuns.length} 条`),
    React.createElement('div', { style: S.hint },
      '整机的检查（装配间隙 / 清单检查 / 机构运动 / 刚体物理）都在「证据」里；单个零件的检查在零件页。'),
    React.createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
      React.createElement('button', {
        type: 'button', onClick: () => setTab('evidence'), style: S.smallBtn,
      }, `看机器的 ${machineRuns.length} 条证据`),
      React.createElement('button', {
        type: 'button', onClick: () => setTab('nodes'), style: S.smallBtn,
      }, `看清单 ${machine?.nodes.length ?? 0} 个节点`),
    ),
  );

  /** The manifest's nodes: which part@version is installed where. */
  const machineNodes = () => React.createElement('div', { style: { display: 'flex', flexDirection: 'column' } },
    ...(machine?.nodes ?? []).map((n) => {
      const partId = partByName.get(n.part) ?? null;
      const known = Boolean(partId && n.version);
      return React.createElement('button', {
        key: n.id,
        type: 'button',
        disabled: !known,
        title: known ? `打开 ${n.part} ${n.version}` : '这个节点引用的零件/版本不在语料里',
        onClick: () => { if (partId && n.version) navPickVersion(partId, n.version); },
        style: {
          display: 'flex', gap: 6, width: '100%', textAlign: 'left', padding: '3px 6px',
          border: 'none', borderBottom: '1px solid #f0f2f4', background: 'transparent',
          cursor: known ? 'pointer' : 'default', fontSize: 12, color: known ? '#26303a' : '#8a94a0',
        },
      },
        React.createElement('span', {
          style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, n.part),
        React.createElement('span', { style: { flex: 'none', color: '#8a94a0', fontSize: 11 } }, n.version ?? '未钉版本'),
      );
    }),
  );

  const exportRow = () => React.createElement(
    'div',
    { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
    ...['stl', '3mf', 'obj', 'off', 'wrl'].map((fmt) => React.createElement('button', {
      key: fmt, type: 'button', style: S.smallBtn,
      onClick: () => { if (version) window.location.href = withProject(`/api/cad/export?v=${version.id}&format=${fmt}`); },
    }, fmt.toUpperCase())),
    React.createElement('span', { style: S.hint }, '下载当前版本的几何'),
  );

  /**
   * Register the selected workspace file as a version through the SAME door the
   * `import_part` tool uses (`/api/cad/import`, "manual-initiation path ②"), then
   * let the poll select it. The panel never writes a version itself.
   */
  const importFileAsVersion = async () => {
    const target = fileSubject.trim();
    if (!target) { setImportMsg('先选一个文件'); return; }
    setImportBusy(true);
    setImportMsg(null);
    try {
      const req = buildImportStlRequest({
        project: sessionCwd(),
        file: target,
        unit: importUnit,
        part: importPart.trim() || undefined,
        allowNonSolid: importNonSolid,
        depthMm: Number(importDepth) > 0 ? Number(importDepth) : undefined,
      });
      const res = await fetch(req.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req.body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(data?.error ?? `HTTP ${res.status}`));
      pendingFocusRef.current = typeof data?.versionId === 'string' ? data.versionId : null;
      setImportMsg(`已登记为版本 ${data?.versionId ?? ''} — 面板会切到它`);
      refresh();
      refreshUnregistered();
    } catch (e) {
      setImportMsg(`导入失败：${String((e as Error)?.message ?? e)}`);
    } finally {
      setImportBusy(false);
    }
  };

  /** The 未登记 sheet: file facts, then the declarations only a human can make. */
  const unregisteredBody = (): React.ReactNode => {
    const row = unregistered.find((f) => f.path === fileSubject) ?? null;
    const kids: React.ReactNode[] = [
      React.createElement('div', { style: { ...S.caption, color: '#9c6f0a' } }, '未登记 · 不是版本 · 不入证据'),
      React.createElement('div', { style: { fontSize: 11, color: '#8a94a0', lineHeight: 1.5 } },
        '工作区里没有版本的几何文件，与 delivery_audit 是同一份扫描。可以在这里看、可以登记为版本；' +
        '测量 / 壁厚 / 装配 / 热力图不适用于它们（那些需要一个版本作为主语）。'),
      React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
        React.createElement('button', { type: 'button', onClick: refreshUnregistered, style: S.smallBtn }, '↻ 刷新'),
        React.createElement('button', { type: 'button', onClick: () => setFileOpen(true), style: S.smallBtn }, '📂 按路径导入…'),
        React.createElement('span', { style: { fontSize: 11, color: '#8a94a0' } }, `${unregistered.length} 个文件`)),
    ];
    if (unregError) kids.push(React.createElement('div', { style: { fontSize: 11, color: '#c0392b' } }, `扫描失败：${unregError}`));
    if (!fileSubject) {
      kids.push(React.createElement('div', { style: S.hint }, unregistered.length
        ? '从上面的「未登记文件」列表选一个；不在工作区里的文件用「按路径导入」。'
        : '没有未登记的几何文件 — 每个 STL/STEP/3MF/DXF 要么有版本，要么被声明为豁免。'));
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, ...kids);
    }
    kids.push(React.createElement('div', {
      style: { fontFamily: 'ui-monospace, monospace', fontSize: 11, wordBreak: 'break-all' },
    }, fileSubject));
    if (row) {
      kids.push(React.createElement('div', {
        style: { fontSize: 11, color: row.severity === 'blocked' ? '#c0392b' : '#9c6f0a' },
      }, `${row.severity === 'blocked' ? '⚠ 比最新版本还新' : '早于最新版本'} · ${row.format.toUpperCase()} · ` +
         `${fmtBytes(row.bytes)} · ${fmtTime(row.modified)}`));
    }
    if (fileMeta) {
      kids.push(React.createElement('div', { style: { fontSize: 11, color: '#5b6673' } },
        `${fileMeta.solid ? '封闭实体' : `非封闭（${fileMeta.shells} 个壳）`} · ` +
        `${fileMeta.unitsMm ? '单位 mm（文件自带）' : '单位未声明（按文件里的数字显示）'}`));
      for (const w of fileMeta.warnings.slice(0, 3)) {
        kids.push(React.createElement('div', { key: w, style: { fontSize: 11, color: '#9c6f0a' } }, w));
      }
    }
    if (row && !row.previewable) {
      kids.push(React.createElement('div', { style: S.hint },
        'DXF 是二维轮廓，预览需要先有厚度 — 用下面的「导入为版本」并填深度。'));
    }
    kids.push(React.createElement('div', {
      style: { display: 'flex', flexDirection: 'column', gap: 4, borderTop: '1px solid #e6e9ec', paddingTop: 6 },
    },
      React.createElement('div', { style: { fontSize: 11, fontWeight: 600 } }, '登记为版本（写入会话目录）'),
      React.createElement('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } },
        React.createElement('input', {
          value: importPart, placeholder: `零件名（默认 ${partNameFromPath(fileSubject)}）`,
          'aria-label': '零件名', onChange: (e: any) => setImportPart(e.target.value),
          style: { ...fieldStyle, flex: '1 1 110px' },
        }),
        React.createElement('select', {
          value: importUnit, 'aria-label': '单位',
          onChange: (e: any) => setImportUnit(e.target.value as ImportUnit),
          style: { ...fieldStyle, flex: '0 0 86px' },
        }, ...IMPORT_UNITS.map((u) => React.createElement('option', { key: u.id, value: u.id }, u.label))),
        row?.format === 'dxf' && React.createElement('input', {
          value: importDepth, placeholder: '深度 mm', 'aria-label': 'DXF 深度',
          onChange: (e: any) => setImportDepth(e.target.value),
          style: { ...fieldStyle, flex: '0 0 76px' },
        }),
      ),
      React.createElement('label', { style: { fontSize: 11, color: '#5b6673' } },
        React.createElement('input', {
          type: 'checkbox', checked: importNonSolid,
          onChange: (e: any) => setImportNonSolid(Boolean(e.target.checked)),
        }),
        ' 非封闭也存（该版本会被几何工具拒绝）'),
      React.createElement('button', {
        type: 'button', disabled: importBusy, onClick: () => void importFileAsVersion(),
        style: { ...S.smallBtn, alignSelf: 'flex-start' },
      }, importBusy ? '导入中…' : '导入为版本'),
      importMsg && React.createElement('div', {
        style: { fontSize: 11, color: importMsg.startsWith('导入失败') ? '#c0392b' : '#1e8449' },
      }, importMsg),
    ));
    return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, ...kids);
  };

  const sectionBody = (id: string): React.ReactNode => {
    if (kind === 'unregistered') return unregisteredBody();
    // The machine's own page: these must be answered BEFORE the generic overview,
    // which would otherwise render the selected run's card as "the machine".
    if (kind === 'machine' && id === 'overview') return machineOverview();
    if (kind === 'machine' && id === 'evidence') return evidenceBody('machine');
    if (kind === 'machine' && id === 'nodes') return machineNodes();
    if (id === 'tray') return trayBody();
    if (id === 'help') return helpBody();
    if (id === 'overview') {
      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        React.createElement('div', { style: S.caption, title: version?.title ?? run?.title },
          version ? version.title : run ? `${runTitle(run)} · ${fmtTime(run.timestamp)}` : ''),
        spec && React.createElement('div', { style: { fontSize: 11, color: '#5b6673' } },
          `尺寸 ${spec.size.map((v) => v.toFixed(1)).join(' × ')} mm · ${spec.triangles} 面`),
        version?.source === 'imported' && React.createElement('div', { style: { fontSize: 11, color: '#5b6673' } },
          `导入自 ${version.origin ?? '外部文件'}`,
          version.solid === false && React.createElement('span', { style: { color: '#c0392b' } },
            ' · 非实体（几何工具会拒绝这个版本）')),
        // A merged body expires with its inputs, and that is worth a line: it looks like a
        // normal version until you know which revisions it was built from (FIX-C5).
        version?.source === 'merged' && React.createElement('div', { style: { fontSize: 11, color: '#5b6673' } },
          (version.staleMergedInputs?.length ?? 0) > 0
            ? React.createElement('span', { style: { color: '#c0392b' } },
              `合并件已过期：输入 ${version.staleMergedInputs!.join(', ')} 已被同一零件的新版本取代 —— 需要重新合并`)
            : '合并件：由多个零件的版本合成（输入仍是最新）'),
        run && sourceVersionChips(run),
        // A brand-new project has no parts at all — this is the one place a
        // human can start from THEIR file without an agent turn. Kept in the
        // body (not the bar): the bar is about which product you are browsing.
        React.createElement('button', {
          type: 'button',
          onClick: () => { setKind('unregistered'); setRecordId(null); refreshUnregistered(); },
          title: '未登记文件：工作区里没有版本的几何 — 在这里预览、标注，或登记为版本',
          style: { ...S.smallBtn, alignSelf: 'flex-start' },
        }, '📂 未登记文件：预览 / 导入'),
        React.createElement('button', {
          type: 'button', onClick: () => setTab('help'), style: { ...S.smallBtn, alignSelf: 'flex-start' },
        }, '这些按钮怎么用？'),
        !record && React.createElement('div', { style: S.hint },
          parts.length === 0
            ? `还没有零件。让 Agent 生成一个零件（它会按声明的零件名归档），或在会话里跑一次验证。${projectLabel}`
            : '该零件还没有记录 — 让 Agent 迭代它，或跑一次验证。'),
      );
    }
    if (id === 'evidence' && version) return evidenceBody('part');
    if (id === 'runs') return evidenceBody('part'); // legacy deep state → the merged view
    if (id === 'export' && version) return exportRow();
    if (id === 'report' && run) {
      const body = runReportBody(run);
      const notice = run.staleVersionIds?.length
        ? React.createElement('div', {
            style: { background: 'rgba(184, 134, 11, 0.15)', border: '1px solid #b8860b',
                     borderRadius: 6, padding: '4px 8px', fontSize: 12, fontWeight: 600,
                     color: '#8a5a00', marginBottom: 4 },
          }, `⚠ 此结果基于旧版本 ${run.staleVersionIds.join(', ')} — 零件已更新，需重跑后才能作为当前版本的证据`)
        : null;
      return React.createElement('div', null, notice, body);
    }
    if (id === 'geometry' && run) {
      return React.createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
        ...run.parts.map((name) => React.createElement('button', {
          key: name, type: 'button', style: S.smallBtn,
          title: '下载这次运行使用的该零件 STL',
          onClick: () => { window.location.href = withProject(`/api/cad/run/stl?id=${run.id}&part=${encodeURIComponent(name)}`); },
        }, `${name}.stl`)));
    }
    return null;
  };

  // ── the viewport ground picker ──
  // Rendered THROUGH the overlay, so it lives in the viewport's own coordinate
  // space directly under 复原 — the same corner, one control group — instead of
  // being positioned from the panel (whose top region is the browse row, which
  // is how a first attempt landed on the 零件/记录 selectors).
  // Deliberately NOT a sixth chip in `S.viewTools` either: that column already
  // covers the model's top-left, and more chips would cover more of it.
  // The stale banner sits at the very top of the viewport; the tool column must
  // start below it, or the first two chips (截图 / 标注) are covered by it.
  const staleBanner = Boolean(version && latestVersionId && version.id !== latestVersionId);
  const toolStripStyle = staleBanner ? { ...S.viewTools, top: 32 } : S.viewTools;
  // Un-touched, the comparison follows the context: an old version opens WITH it
  // (that is why you opened an old version), the latest opens without it.
  const compareActive = compareOn ?? staleBanner;

  // The comparison toggle sits under 背景: same corner, same pill. It names the
  // version it compares against, because "对比" alone does not say WHAT with.
  const ghostToggle = version && ghostVersionId && !glError
    ? React.createElement('button', {
      type: 'button',
      'data-compare-toggle': '',
      'aria-label': '对比视口',
      title: compareActive
        ? `副视口：蓝 = 当前 ${version.id}，橙 = ${ghostVersionId}（点击收起）`
        : `在右下角副视口里同时放置 ${version.id} 与 ${ghostVersionId}，看差在哪里`,
      onClick: () => setCompareOn(!compareActive),
      style: {
        position: 'absolute', right: 8, top: 66, zIndex: 8, cursor: 'pointer',
        borderRadius: 6, padding: '2px 7px', fontSize: 11, lineHeight: '16px',
        border: compareActive ? '1px solid #e07a3f' : '1px solid #d5d9dd',
        background: 'rgba(255,255,255,0.86)',
        color: compareActive ? '#a4531c' : '#26303a',
        ...(compareActive ? { boxShadow: '0 0 0 2px rgba(224,122,63,0.18)' } : {}),
      },
    }, `${compareActive ? '◫' : '▢'} 对比 ${ghostVersionId}`)
    : null;

  const bgPicker = version && !glError
    ? React.createElement(
      'div',
      {
        'data-bg-picker': '',
        style: { position: 'absolute', right: 8, top: 36, zIndex: 8, pointerEvents: 'auto' },
      },
      React.createElement('button', {
        type: 'button',
        title: `视口背景：当前是「${bg.label}」，点开选其它底色`,
        'aria-label': `视口背景（当前${bg.label}）`,
        onClick: () => setBgPickerOpen((v) => !v),
        // A visual twin of the neighbouring 复原 pill — same plate, same type —
        // with the CURRENT ground colour as its icon. The first version filled
        // the whole pill with the ground colour: on pale grounds it vanished
        // into the viewport, and on dark ones it clashed with 复原's white plate.
        style: {
          cursor: 'pointer', borderRadius: 6, padding: '2px 7px',
          fontSize: 11, lineHeight: '16px',
          border: bgPickerOpen ? '1px solid #3498db' : '1px solid #d5d9dd',
          background: 'rgba(255,255,255,0.86)', color: '#26303a',
          ...(bgPickerOpen ? { boxShadow: '0 0 0 2px rgba(52,152,219,0.25)' } : {}),
        },
      }, '🎨 背景'),
      bgPickerOpen && React.createElement(
        'div',
        {
          style: {
            position: 'absolute', right: 0, top: 26, zIndex: 20,
            display: 'flex', flexDirection: 'column', gap: 3, padding: 5,
            background: 'rgba(255,255,255,0.97)', border: '1px solid #c9ced4',
            borderRadius: 8, boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
          },
        },
        VIEWPORT_BACKGROUNDS.map((option) => React.createElement('button', {
          key: option.id,
          type: 'button',
          title: `背景：${option.label}`,
          onClick: () => { setBgId(option.id); saveBackgroundId(option.id); setBgPickerOpen(false); },
          style: {
            display: 'flex', alignItems: 'center', gap: 6, width: 92,
            padding: '2px 5px', cursor: 'pointer', fontSize: 11, lineHeight: '16px',
            borderRadius: 5, background: 'transparent', textAlign: 'left',
            border: option.id === bg.id ? '1px solid #3498db' : '1px solid transparent',
            color: '#26303a',
          },
        },
          React.createElement('span', {
            style: { width: 14, height: 14, borderRadius: 4, background: option.hex, border: '1px solid #b9c0c7', flex: 'none' },
          }),
          option.label,
        )),
      ),
    )
    : null;

  // Recomputed every render (the panel re-renders each poll), so a preset that
  // lands late — or a session switch — updates the banner without extra wiring.
  const notice = cadMissingToolsNotice(cadScope, currentSessionPreset(), currentSessionBlank());

  /**
   * Which project the empty state is empty IN.
   *
   * "No parts" and "I am reading the wrong directory" look identical otherwise
   * — and that ambiguity is how a project-scoping bug reads as "nothing here
   * yet". Naming the corpus costs one line and removes the guesswork.
   */
  const projectLabel = (() => {
    const cwd = currentProject();
    if (!cwd) return '\n（项目：未识别 — 此会话未报告工作目录，面板读的是服务器自己的目录）';
    const name = cwd.replace(/\/+$/, '').split('/').pop() || cwd;
    return `\n（项目：${name}）`;
  })();

  // ── the navigator: one overlay, every entry point ──────────────────────────
  // The old row made 类别 a PRECONDITION: you declared what KIND of thing you were
  // looking for before you could see anything, and the same object appeared under
  // a different bucket depending on who made it. Here those buckets are SECTIONS
  // of one searchable list, and the breadcrumb above is where you landed — not
  // something you had to choose first.
  const navFilter = (text: string): boolean => {
    const q = navQuery.trim().toLowerCase();
    return !q || text.toLowerCase().includes(q);
  };
  const navClose = () => { setNavOpen(false); setNavQuery(''); };
  const navPickPart = (id: string) => { setRecent(pushRecent(id)); setKind('part'); setSubjectId(id); setRecordId(null); navClose(); };
  const navPickVersion = (partId: string, vid: string) => { setRecent(pushRecent(vid)); setKind('part'); setSubjectId(partId); setRecordId(vid); navClose(); };
  const navPickRun = (r: RunProduct) => { setRecent(pushRecent(r.id)); setKind(browseKindOf(r)); setRecordId(r.id); navClose(); };
  const navPickMachine = () => { setKind('machine'); setRecordId(null); navClose(); };

  const navPickFile = (path: string) => { setRecent(pushRecent(`f:${path}`)); setKind('unregistered'); setRecordId(null); setFileSubject(path); setFileMeta(null); navClose(); refreshUnregistered(); };

  /**
   * Resolve a stored address against the CURRENT tree. An address that no longer
   * resolves (a version somebody deleted, a file that moved) is simply absent
   * from 最近 — the list is a convenience, never a claim.
   */
  const resolveAddress = (id: string): { title: string; meta: string; apply: () => void } | null => {
    if (/^v\d{3,}$/.test(id)) {
      for (const p of parts) {
        const v = p.versions.find((x) => x.id === id);
        if (v) return { title: recordLabel(v, v.id === latestVersionId), meta: p.name, apply: () => navPickVersion(p.id, id) };
      }
      return null;
    }
    if (/^r\d{3,}$/.test(id)) {
      const r = [...simRuns, ...checkRuns, ...assemblyRuns, ...contractRuns].find((x) => x.id === id);
      return r ? { title: `${r.id} · ${runTitle(r)}`, meta: r.summary, apply: () => navPickRun(r) } : null;
    }
    if (/^p\d{3,}$/.test(id)) {
      const p = parts.find((x) => x.id === id);
      return p ? { title: p.name, meta: `${p.versions.length} 版`, apply: () => navPickPart(id) } : null;
    }
    if (id.startsWith('f:')) {
      const path = id.slice(2);
      const f = unregistered.find((x) => x.path === path);
      return f ? { title: path, meta: f.format.toUpperCase(), apply: () => navPickFile(path) } : null;
    }
    return null;
  };

  // Reopen where you left off: the most recent address wins over the corpus's
  // arbitrary first part — but only before the user has chosen anything (a
  // deliberate pick later in the session must not be overridden).
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || parts.length === 0) return;
    restoredRef.current = true;
    const id = loadRecent()[0];
    if (!id) return;
    resolveAddress(id)?.apply();
  }, [parts.length]);

  /**
   * Deep link (T3.3): `?t=v029` (also r041 / p005 / machine / u:<path>), optional
   * `?compare=latest`. Read-only by design — the panel does NOT write the address
   * bar: it lives inside the host's page, and rewriting the host's URL from a
   * plugin would be a hostile takeover of state the host owns. A link handed to
   * you (by the agent, a note, a chat message) opens the right thing; that is the
   * half that matters for review.
   */
  const deepLinkedRef = useRef(false);
  useEffect(() => {
    if (deepLinkedRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const target = (params.get('t') ?? '').trim();
    if (!target) { deepLinkedRef.current = true; return; }
    // Wait for the tree: an address that cannot resolve yet is not an error.
    if (parts.length === 0) return;
    const hit = resolveAddress(target);
    if (!hit) return;   // try again when the corpus (or a file list) arrives
    deepLinkedRef.current = true;
    hit.apply();
    if (params.get('compare') === 'latest') setCompareOn(true);
  }, [parts, unregistered]);

  const navRow = (key: string, title: string, meta: string | null, onClick: () => void, active = false, muted = false) =>
    React.createElement('button', {
      key, type: 'button', onClick,
      // The sandbox (and any future deep link) addresses a row by its product id.
      'data-nav-id': key.includes(':') ? key.slice(key.indexOf(':') + 1) : key,
      style: {
        display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
        padding: '4px 6px', border: 'none', borderRadius: 5, cursor: 'pointer',
        background: active ? '#eaf3fc' : 'transparent',
        // Muted = "this is history": still one click away, but it must not look
        // like the default surface. The cost is visual weight, not a wall.
        color: muted ? '#6b7684' : '#26303a', fontSize: 12,
      },
    },
      React.createElement('span', {
        style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, title),
      // The meta column must not eat the name: a long summary used to truncate
      // `机构运动 · 弯臂 + 调焦滑座 + 齿轮轴` before the parts were readable.
      meta && React.createElement('span', {
        style: {
          flex: 'none', maxWidth: '42%', color: '#8a94a0', fontSize: 11,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        },
      }, meta),
    );

  const navSection = (label: string, rows: React.ReactNode[]) =>
    rows.length === 0 ? null : React.createElement('div', { key: label, style: { marginBottom: 6 } },
      React.createElement('div', { style: { fontSize: 11, color: '#8a94a0', padding: '2px 6px' } }, label),
      ...rows);

  const navOverlay = () => {
    const q = navQuery.trim();
    const partRows = parts
      .filter((p) => navFilter(p.name) || p.versions.some((v) => navFilter(v.id)))
      // `∗` keeps the honesty marker the old row carried: a name derived from
      // userIntent is not a name the agent declared.
      .map((p) => navRow(`p:${p.id}`, `${p.name}${p.nameSource === 'intent' ? ' ∗' : ''}`,
        `${p.versions.length} 版`, () => navPickPart(p.id), kind === 'part' && subjectId === p.id));
    // A 50-version part must not push every other section off the screen: the list
    // is capped and says so, with search as the way to reach older revisions.
    const versionsAll = currentPart
      ? currentPart.versions.filter((v) => navFilter(v.id) || navFilter(v.title ?? ''))
      : [];
    // The same label the old dropdown used: it carries 导入 / 合并 / 非实体 and
    // the 最新 marker — exactly what you scan a history for.
    const vRow = (v: VersionProduct, muted = false) => navRow(`v:${v.id}`, recordLabel(v, v.id === latestVersionId), null,
      () => navPickVersion(currentPart!.id, v.id), recordId === v.id, muted);

    // THE GATE (T3.1): five recent revisions are one click away; the rest are
    // folded behind one deliberate step. Not hidden — a history you cannot reach
    // is not a history — but no longer the default surface.
    const recentVersions = versionsAll.slice(0, 5);
    const selected = versionsAll.find((v) => v.id === recordId) ?? null;
    // Your own selection stays visible even when it is older than the window,
    // otherwise expanding/collapsing could hide the version you are looking at.
    const head = selected && !recentVersions.includes(selected)
      ? [...recentVersions, selected] : recentVersions;
    const older = versionsAll.slice(5).filter((v) => !head.includes(v));
    const versionsExpanded = expandedVersionsFor === currentPart?.id;
    const versionRows = q
      ? versionsAll.slice(0, 40).map((v) => vRow(v))
      : [
        ...head.map((v) => vRow(v)),
        ...(versionsExpanded && older.length
          ? [
            React.createElement('div', {
              key: 'older-divider',
              style: { fontSize: 10, color: '#8a94a0', padding: '4px 6px 2px', borderTop: '1px solid #f0f2f4', marginTop: 2 },
            }, `更早 ${older.length} 版 · 只读参考`),
            ...older.map((v) => vRow(v, true)),
            // A nudge, not a wall: history is here when you need it, but the
            // cheap path is to ask the agent — it can read old revisions and
            // explain the difference without you hunting through them.
            React.createElement('div', {
              key: 'older-nudge',
              style: { fontSize: 10, color: '#8a94a0', padding: '4px 6px', lineHeight: '14px' },
            }, '历史版本只用于对比。要让 Agent 查旧版 / 解释两版差在哪里，通常更快。'),
          ]
          : []),
      ];
    const versionToggle = !q && older.length
      ? navRow('versions-toggle', versionsExpanded ? '收起历史' : `全部 ${versionsAll.length} 版 ›`, null,
        () => setExpandedVersionsFor(versionsExpanded ? null : currentPart?.id ?? null))
      : null;
    const runRows = (list: RunProduct[]) => list
      .filter((r) => navFilter(runTitle(r)) || navFilter(r.id) || navFilter(r.summary))
      .slice(0, q ? 40 : 8)
      .map((r) => navRow(`r:${r.id}`, `${r.id} · ${runTitle(r)}`, r.summary,
        () => navPickRun(r), recordId === r.id));
    const fileRows = unregistered
      .filter((f) => navFilter(f.path))
      .slice(0, q ? 40 : 8)
      .map((f) => navRow(`f:${f.path}`, f.path, f.format.toUpperCase(),
        () => navPickFile(f.path), fileSubject === f.path));

    // A query searches EVERYTHING; without one the sections are the map (and each
    // long section is capped, with search as the way to reach the rest).
    const body = q
      ? [navSection(`结果 · “${q}”`, [
        ...versionRows, ...partRows, ...fileRows,
        ...runRows(simRuns), ...runRows(checkRuns), ...runRows(assemblyRuns), ...runRows(contractRuns),
      ])]
      : [
        // 最近 first: after an interruption this is what you actually want, and it
        // is the one section that needs no knowledge of the corpus at all.
        navSection('最近', (() => {
          const rows: React.ReactNode[] = [];
          for (const id of recent) {
            const hit = resolveAddress(id);
            if (hit) rows.push(navRow(`recent:${id}`, hit.title, hit.meta, hit.apply));
          }
          return rows;
        })()),
        navSection(
          currentPart
            ? `版本 · ${currentPart.name}`
              + (!q && older.length && !versionsExpanded ? `（最近 ${head.length} / 共 ${versionsAll.length}）` : '')
            : '版本',
          [...versionRows, versionToggle],
        ),
        // The machine is an OBJECT, not four run categories: its evidence lives
        // on its own page. Without a manifest there is nothing to group under, so
        // the flat sections stay as the fallback.
        machine
          ? navSection(`机器 · 1`, [navRow('machine', machine.name,
            `${machine.nodes.length} 节点 · ${machineRuns.length} 条证据`, navPickMachine, kind === 'machine')])
          : null,
        navSection(`零件 · ${parts.length}`, partRows),
        ...(machine ? [] : [
          navSection(`仿真 · ${simRuns.length}`, runRows(simRuns)),
          navSection(`检查 · ${checkRuns.length}`, runRows(checkRuns)),
          navSection(`组件 · ${assemblyRuns.length}`, runRows(assemblyRuns)),
          navSection(`契约 · ${contractRuns.length}`, runRows(contractRuns)),
        ]),
        navSection(`未登记 · ${unregistered.length}`, fileRows),
      ];

    return React.createElement('div', {
      style: {
        position: 'absolute', inset: 0, zIndex: 50, background: 'rgba(20,24,30,0.35)',
        display: 'flex', padding: 8, boxSizing: 'border-box',
      },
      onClick: (e: any) => { if (e.target === e.currentTarget) navClose(); },
    },
      React.createElement('div', {
        style: {
          flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: '#fff',
          borderRadius: 10, boxShadow: '0 10px 30px rgba(0,0,0,0.25)', overflow: 'hidden',
        },
      },
        React.createElement('div', {
          style: { display: 'flex', gap: 6, alignItems: 'center', padding: 8, borderBottom: '1px solid #eef1f3' },
        },
          React.createElement('input', {
            autoFocus: true, value: navQuery,
            placeholder: '搜索零件 / 版本 / 运行 / 文件…',
            'aria-label': '搜索产物',
            onChange: (e: any) => setNavQuery(e.target.value),
            onKeyDown: (e: any) => { if (e.key === 'Escape') navClose(); },
            style: { flex: 1, minWidth: 0, height: 28, fontSize: 12, padding: '0 8px', border: '1px solid #d5d9dd', borderRadius: 6 },
          }),
          React.createElement('button', { type: 'button', onClick: navClose, title: '关闭（Esc）', style: S.smallBtn }, '✕'),
        ),
        React.createElement('div', {
          style: { overflow: 'auto', padding: '4px 6px 8px', flex: 1, minHeight: 0 },
        }, ...body),
      ),
    );
  };

  /**
   * The review queue, consumed at the human's pace.
   *
   * Opening this overlay NEVER changes the viewport: that is the whole contract
   * (attention is requested, not taken). Choosing 看 does — one click, one object.
   * A rollback proposal carries its own action, because approving it writes a new
   * version and that must not be a side effect of "look at it".
   */
  const reviewOverlay = () => {
    const pending = review.items.filter((i) => i.status === 'unread');
    const settled = review.items.filter((i) => i.status !== 'unread');
    const card = { background: '#fff', borderRadius: 10, border: '1px solid #d5d9dd', padding: '6px 8px', display: 'flex', flexDirection: 'column' as const, gap: 3 };
    const tinyBtn = { ...S.smallBtn, padding: '1px 7px', fontSize: 11 };

    const row = (item: ReviewItem) => React.createElement('div', {
      key: item.id,
      'data-review-row': item.id,
      style: { ...card, opacity: item.status === 'unread' ? 1 : 0.6 },
    },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
        React.createElement('span', {
          style: {
            flex: 'none', fontSize: 10, lineHeight: '15px', padding: '0 5px', borderRadius: 3, fontWeight: 600,
            color: item.kind === 'revert' ? '#a4531c' : '#2f6fdb',
            background: item.kind === 'revert' ? '#fdeee2' : '#eaf3fc',
          },
        }, item.kind === 'revert' ? '回退提议' : '待看'),
        React.createElement('span', {
          style: { flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, color: '#26303a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, item.title),
        React.createElement('span', { style: { flex: 'none', fontSize: 10, color: '#8a94a0' } }, fmtTime(item.createdAt)),
      ),
      item.body && React.createElement('div', {
        style: { fontSize: 11, color: '#5b6673', lineHeight: '15px', whiteSpace: 'pre-wrap' },
      }, item.body),
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
        item.target && React.createElement('span', {
          style: { fontFamily: 'ui-monospace, monospace', fontSize: 10, color: '#8a94a0' },
        }, item.target),
        item.resolvedBy && React.createElement('span', { style: { fontSize: 10, color: '#1e8449' } }, `已回退为 ${item.resolvedBy}`),
        React.createElement('span', { style: { marginLeft: 'auto' } }),
        item.target && item.kind === 'revert' && React.createElement('button', {
          type: 'button',
          title: `批准回退：以 ${item.target} 的几何新建一个版本（父版本=当前 head，历史不改写）`,
          onClick: async () => {
            try {
              const res = await approveReviewItem(item.id);
              const pid = item.target ? partOfVersion.get(item.target) ?? null : null;
              if (res.versionId && pid) { setKind('part'); setSubjectId(pid); setRecordId(res.versionId); }
              setReviewOpen(false);
            } catch (e: any) {
              setError(`回退失败：${String(e?.message ?? e)}`);
            }
          },
          style: { ...tinyBtn, border: '1px solid #a4531c', color: '#a4531c', background: '#fdeee2' },
        }, '批准回退'),
        item.target && React.createElement('button', {
          type: 'button',
          'data-review-open': item.id,
          title: `在面板里打开 ${item.target}`,
          onClick: () => {
            const hit = item.target ? resolveAddress(item.target) : null;
            hit?.apply();
            void setReviewItemStatus(item.id, 'read');
            setReviewOpen(false);
          },
          style: { ...tinyBtn, border: '1px solid #2c81ba', background: '#e8f4fa' },
        }, '看'),
        React.createElement('button', {
          type: 'button', onClick: () => void setReviewItemStatus(item.id, item.status === 'unread' ? 'read' : 'unread'),
          style: tinyBtn,
        }, item.status === 'unread' ? '已阅' : '标为未读'),
        React.createElement('button', {
          type: 'button', onClick: () => void setReviewItemStatus(item.id, 'dismissed'),
          style: tinyBtn,
        }, '忽略'),
      ),
    );

    return React.createElement('div', {
      style: {
        position: 'absolute', inset: 0, zIndex: 50, background: 'rgba(20,24,30,0.35)',
        display: 'flex', padding: 8, boxSizing: 'border-box',
      },
      onClick: (e: any) => { if (e.target === e.currentTarget) setReviewOpen(false); },
    },
      React.createElement('div', {
        style: {
          flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: '#f7f9fb',
          borderRadius: 10, boxShadow: '0 10px 30px rgba(0,0,0,0.25)', overflow: 'hidden',
        },
      },
        React.createElement('div', {
          style: { display: 'flex', alignItems: 'center', gap: 6, padding: '7px 9px', borderBottom: '1px solid #e6ebef', background: '#fff' },
        },
          React.createElement('span', { style: { fontSize: 13, fontWeight: 600, color: '#26303a' } }, '待阅'),
          React.createElement('span', { style: { fontSize: 11, color: '#8a94a0' } },
            `${pending.length} 条未读${settled.length ? ` · ${settled.length} 条已处理` : ''}`),
          review.error && React.createElement('span', { style: { fontSize: 10, color: '#c0392b' } }, review.error),
          React.createElement('button', {
            type: 'button', onClick: () => setReviewOpen(false), title: '关闭（Esc）',
            style: { ...S.smallBtn, marginLeft: 'auto' },
          }, '✕'),
        ),
        React.createElement('div', {
          style: { overflow: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minHeight: 0 },
        },
          review.items.length === 0
            ? React.createElement('div', { style: { color: '#8a94a0', fontSize: 12, padding: 8 } },
              '还没有待阅项。Agent 想让你看什么时会往这里放，不会自己切换视口。')
            : [...pending, ...settled].map(row),
        ),
        React.createElement('div', {
          style: { borderTop: '1px solid #e6ebef', padding: '5px 9px', fontSize: 10, color: '#8a94a0', background: '#fff' },
        }, '打开这个列表不会改变视口；点「看」才会跳过去。'),
      ),
    );
  };

  /** Where you are, in one line: the breadcrumb IS the answer, not a chooser. */
  const crumb = (() => {
    if (kind === 'machine') return machine ? machine.name : '整机';
    if (kind === 'part') return currentPart ? `${currentPart.name}${version ? ` · ${version.id}` : ''}` : '选择零件';
    if (kind === 'unregistered') return fileSubject || '未登记文件';
    if (run) return `${run.id} · ${runTitle(run)}`;
    return kind === 'sim' ? '仿真运行' : kind === 'check' ? '检查结果' : kind === 'assembly' ? '组件' : '装配契约';
  })();

  return React.createElement(
    'div',
    { style: S.panel, ref: panelRef },

    // No CAD tools in this session: say it here, because the alternative is a
    // calm empty part list while the agent silently fails to make anything. The
    // text differs by whether the choice is still recoverable — see
    // cadMissingToolsNotice.
    notice &&
      React.createElement('div', {
        style: S.notice,
        title: '本插件的工具表按「预设」开放：只有选了 CAD 预设的会话才有 CAD 工具。'
          + '要让它必然生效，在 设置 → Agent 预设 里把「造物模式」设为默认预设，再新建会话。',
      },
        notice),

    error && React.createElement('div', { style: S.error }, error),

    // ── screenshot compose dialog: the beat between 📸 and "sent" ──
    // The user asked to attach words to a screenshot before it reaches the
    // model; an auto-caption alone forced a follow-up message and burned
    // another round. Editing the text IS the caption — the model receives
    // exactly one message: [user words + image].
    shotDraft && React.createElement(
      'div',
      {
        style: {
          position: 'fixed', inset: 0, background: 'rgba(20,24,30,0.45)', zIndex: 60,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        },
        onClick: (e: any) => { if (e.target === e.currentTarget) setShotDraft(null); },
      },
      React.createElement(
        'div',
        { style: { background: '#fff', borderRadius: 10, padding: 12, width: 340, maxWidth: '92vw', boxShadow: '0 10px 40px rgba(0,0,0,0.25)' } },
        React.createElement('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 6, color: '#3b4450' } },
          `📸 截图 · ${shotDraft.label} — 加一句你想让它做什么`),
        React.createElement('img', {
          src: shotDraft.url,
          alt: '截图预览',
          style: { width: '100%', borderRadius: 6, border: '1px solid #e3e7ea', marginBottom: 8, display: 'block' },
        }),
        // Auto caption: machine-generated facts (view, version, bbox, 测量/标注),
        // necessary context for the model but NOT the user's business to edit —
        // shown read-only, always sent.
        React.createElement('div', {
          title: '自动说明（随图必发，不可编辑）',
          style: {
            fontSize: 10, color: '#8a94a0', background: '#f4f6f8', borderRadius: 4,
            padding: '4px 6px', marginBottom: 6, whiteSpace: 'pre-wrap', userSelect: 'text',
          },
        }, shotDraft.auto),
        shotDraft.stale && React.createElement('div', {
          style: { background: 'rgba(184, 134, 11, 0.15)', border: '1px solid #b8860b',
                   borderRadius: 6, padding: '4px 8px', fontSize: 12, fontWeight: 600, color: '#8a5a00' },
        }, `⚠ 此截图来自旧版本 ${shotDraft.stale.version}（最新为 ${shotDraft.stale.latest}）— 发送时会再次确认`),
        React.createElement('textarea', {
          value: shotDraft.text,
          onChange: (e: any) => setShotDraft((d) => d ? { ...d, text: e.target.value } : d),
          onKeyDown: (e: any) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void sendShotDraft(); }
          },
          rows: 3,
          autoFocus: true,
          placeholder: '写你想让它做什么（可选）：例：这个孔太小了，改成 Ø12 再出一版',
          style: { width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '6px 8px', border: '1px solid #d7dde2', borderRadius: 6, resize: 'vertical' },
        }),
        React.createElement(
          'div',
          { style: { display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' } },
          React.createElement('button', {
            type: 'button', onClick: () => void sendShotDraft(),
            title: '图片 + 你写的文字一起发进会话（排队，不打断运行中的回合）',
            style: { ...S.smallBtn, background: '#2f6fdb', color: '#fff', border: '1px solid #2f6fdb', fontWeight: 600 },
          }, '✓ 发送到会话'),
          React.createElement('button', {
            type: 'button', onClick: () => void parkShotDraft(),
            title: '存进截图列表，不发送 — 以后可在列表里补备注后 ↻发',
            style: S.smallBtn,
          }, '只存托盘'),
          React.createElement('button', {
            type: 'button', onClick: () => setShotDraft(null),
            title: '丢弃这张截图', style: { ...S.smallBtn, marginLeft: 'auto' },
          }, '取消'),
        ),
        React.createElement('div', { style: { fontSize: 10, color: '#8a94a0', marginTop: 6 } },
          'Ctrl+Enter 发送 · 文字随图片一起给模型，不用再补一条消息'),
      ),
    ),

    // ── 本地 STL：看（不登记）或登记（成版本）──
    // Writes deliberately target the SESSION cwd (`sessionDir`), never the
    // pinned browse corpus: "look at one project, import into another" would
    // make the version appear in a corpus the agent cannot see.
    fileOpen && React.createElement(LocalFileDialog, {
      open: true,
      onClose: () => setFileOpen(false),
      project: sessionDir || sessionCwd(),
      background: bg.hex,
      onImported: (versionId: string) => {
        pendingFocusRef.current = versionId;
        setFileOpen(false);
        // An import lands in the SESSION corpus. If the panel is pinned to a
        // different corpus, following the session is the only way the new
        // version can appear — and the human just asked for exactly that.
        if (workspaceCwd) {
          setWorkspaceCwd('');
          setProjectOverride(null);
          prevIdsRef.current = new Set();
          subjectRef.current = '';
          setParts([]);
          setScene([]);
          setSubjectId('');
          setRecordId(null);
        }
        // The 3 s poll is too slow for an act the human just committed: refresh
        // now and let the pending id select it when the list lands.
        refresh();
      },
    }),

    // ── one row: WHERE YOU ARE, and the one way in ────────────────────────────
    // 类别 is gone from this row. Its buckets still exist, as SECTIONS inside the
    // navigator this breadcrumb opens: nothing has to be declared before you can
    // see anything, and the row now spends its width on the answer ("吊架 · v029")
    // instead of on four controls.
    React.createElement(
      'div',
      { style: S.bar },
      (workspaces.length > 1 || workspaceCwd) && React.createElement(
        'select',
        {
          key: 'workspace',
          value: workspaceCwd,
          onChange: (e: any) => {
            const next = e.target.value;
            setWorkspaceCwd(next);
            setProjectOverride(next || null);
            // Nothing from the previous corpus survives the switch.
            prevIdsRef.current = new Set();
            subjectRef.current = '';
            setParts([]);
            setScene([]);
            setSubjectId('');
            setRecordId(null);
            setError(null);
          },
          title: '工作目录：面板看哪份 CAD 语料（只读浏览）\nAgent 的工具始终写入会话所在目录，切换不会改变写入位置',
          'aria-label': '工作目录',
          style: { ...S.select, flex: 'none', maxWidth: 110 },
        },
        React.createElement('option', { value: '' },
          `跟随会话 · ${sessionDir ? (sessionDir.replace(/\/+$/, '').split('/').pop() || '') : ''}`.trim()),
        workspaces
          .filter((w) => w.cwd !== sessionDir)
          .map((w) => React.createElement('option', { key: w.cwd, value: w.cwd },
            `${w.rel === '.' ? '根语料' : w.rel} · ${w.parts}零件/${w.versions}版`)),
      ),
      React.createElement('button', {
        type: 'button',
        onClick: () => { setNavQuery(''); setNavOpen(true); },
        title: '选择要看的东西：搜索 / 零件 / 运行 / 未登记（Esc 关闭）',
        'aria-label': '打开产物导航',
        style: {
          // `1 1 0`, not `1 1 auto`: in a WRAPPING flex row the wrap decision uses
          // the flex base size, so an auto basis (the breadcrumb's text width) makes
          // the row wrap at 320 instead of letting the text ellipsize.
          flex: '1 1 0', minWidth: 0, height: 26, display: 'flex', alignItems: 'center', gap: 6,
          padding: '0 8px', border: '1px solid #d5d9dd', borderRadius: 6, background: '#fff',
          cursor: 'pointer', fontSize: 12, color: '#26303a', textAlign: 'left',
        },
      },
        React.createElement('span', { style: { color: '#8a94a0', flex: 'none', fontSize: 11 } }, '🔍'),
        React.createElement('span', {
          style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 },
        }, crumb),
        React.createElement('span', { style: { color: '#8a94a0', flex: 'none' } }, '▾'),
      ),
      kind === 'part' && record && statusGlyph(record.status),
      React.createElement('button', {
        type: 'button',
        title: '未登记文件：工作区里没有版本的几何 — 预览、标注、导入为版本',
        'aria-label': '未登记文件',
        onClick: () => { setKind('unregistered'); setRecordId(null); refreshUnregistered(); },
        style: { ...S.smallBtn, padding: '2px 6px' },
      }, '📂'),
    ),

    navOpen && navOverlay(),
    reviewOpen && reviewOverlay(),

    // ── the viewport: filled by what the product *is* ──
    React.createElement(
      'div',
      { style: S.stage },
      // Stale-version banner (DESIGN §20): the user demanded it be obvious.
      kind === 'part' && version && latestVersionId && versionId !== latestVersionId &&
        React.createElement('div', {
          title: '讨论请以此为准，或点「回到最新」',
          style: {
            position: 'absolute', top: 0, left: 0, right: 0, zIndex: 30,
            display: 'flex', alignItems: 'center', gap: 8,
            background: 'rgba(184, 134, 11, 0.92)', color: '#fff',
            padding: '4px 10px', fontSize: 12, fontWeight: 600,
          },
        },
          // One line: a two-line banner covered the tool chips, and "回到最新" is
          // the actionable half anyway. The full sentence lives in the tooltip.
          `⚠ 旧版本 ${version.id} · 最新 ${latestVersionId}`,
          React.createElement('button', {
            type: 'button',
            onClick: () => { setRecordId(latestVersionId); },
            style: { ...S.smallBtn, marginLeft: 'auto', padding: '1px 8px' },
          }, '回到最新'),
        ),
      // The inset's frame and colour key are DOM: the WebGL picture is drawn by
      // the renderer, but a border and a legend must stay crisp — and a canvas
      // has no DOM inside it.
      compareActive && ghostVersionId && React.createElement('div', {
        'data-compare-inset': '',
        style: {
          position: 'absolute', right: 6, bottom: 6, height: '54%', aspectRatio: '1 / 1',
          border: '1px solid #c9ced4', borderRadius: 8, pointerEvents: 'none', zIndex: 5,
          boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
        },
      },
        // The legend says WHICH ROLE each colour has, not just which id: the whole
        // point of this inset is "am I looking at the design or at its past?".
        React.createElement('div', {
          style: {
            position: 'absolute', left: 4, top: 3, fontSize: 10, lineHeight: '12px',
            color: '#3d4a57', background: 'rgba(255,255,255,0.84)', borderRadius: 4,
            padding: '1px 4px', fontWeight: 600,
          },
        },
          React.createElement('div', null,
            React.createElement('span', { style: { color: '#2563eb' } }, '● 蓝 '),
            React.createElement('span', null, `${staleBanner ? '历史' : '当前'} ${version?.id ?? ''}`)),
          React.createElement('div', null,
            React.createElement('span', { style: { color: '#e2651c' } }, '● 橙 '),
            React.createElement('span', null, `${staleBanner ? '当前' : '历史'} ${ghostVersionId}`)),
        ),
      ),
      meshSource && React.createElement('div', {
        ref: mountRef,
        // Picking listens HERE, not on an overlay that swallows the pointer:
        // with the old overlay, OrbitControls never saw the pointerdown, so
        // orbit and zoom were dead the moment you entered 测量 or 壁厚.
        onPointerDown: (e: any) => {
          if (!annotateMode) clickStartRef.current = { x: e.clientX, y: e.clientY };
        },
        onClick: (e: any) => {
          if (annotateMode) return;
          if (measureMode) pickMeasurePoint(e);
          else if (thickMode) pickThicknessPoint(e);
        },
        style: {
          position: 'absolute', inset: 0,
          cursor: annotateMode || measureMode || thickMode ? 'crosshair' : 'default',
        },
      }),
      meshSource && glError && React.createElement('div', {
        style: {
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 6, padding: 16, textAlign: 'center',
        },
      },
      React.createElement('div', { style: { fontSize: 26 } }, '🚫'),
      React.createElement('div', { style: { fontSize: 13, fontWeight: 600 } }, '此环境无法创建 WebGL 上下文'),
      React.createElement('div', { style: { fontSize: 11, color: '#8a94a0', lineHeight: 1.5 } },
        '几何预览不可用；版本、运行与报告仍可浏览。',
        React.createElement('br'),
        React.createElement('span', { style: { fontFamily: 'ui-monospace, monospace' } }, glError)),
      ),
      meshSource && !glError && React.createElement(ViewportOverlay, {
        getScene: () => versionSceneRef.current,
        ink: overlayInk(bg),
        chrome: React.createElement(React.Fragment, null, ghostToggle, bgPicker),
        // 复原 = back to the initial framing AND a clean slate for the markup:
        // annotations, measurements, the thickness probe AND the section all
        // belong to the view you were inspecting, so they go with it.
        labels: probeLabels,
        onReset: () => {
          versionResetRef.current?.();
          setAnnotations([]);
          setMeasure(null);
          setThick(null);
          setAnnotateMode(false);
          setMeasureMode(false);
          setThickMode(false);
          setSection(false);
          setSectionPos(0.5);
          setHint('视图已复原 — 剖视 / 测量 / 壁厚 / 标注已清除');
        },
      }),
      run && (run.kind === 'motion' || run.kind === 'physics') && run.hasGeometry &&
        React.createElement(MotionPlaybackView, {
          key: run.id, runId: run.id,
          background: bg.hex,
          onScreenshot: (canvas: HTMLCanvasElement, label: string) => openShotDraft(canvas, label),
        }),
      run && run.kind === 'fluid' &&
        React.createElement(FluidPlaybackView, {
          key: run.id, runId: run.id,
          background: bg.hex,
          onScreenshot: (canvas: HTMLCanvasElement, label: string) => openShotDraft(canvas, label),
        }),
      run && run.kind === 'assembly' && run.hasGeometry &&
        React.createElement(StaticPartsView, {
          key: run.id, runId: run.id, parts: run.parts,
          background: bg.hex,
          // The run stores each part's placement; without it StaticPartsView
          // draws every part at the origin, so a translated assembly looks like
          // a pile. Latent until now only because every corpus part so far was
          // modelled in world coordinates.
          placements: run.placements,
          onScreenshot: (canvas: HTMLCanvasElement, label: string) => openShotDraft(canvas, label),
        }),
      run && !run.hasGeometry && reportOnlyCard(run),
      // committed annotation boxes stay visible (any viewport with a mesh)
      meshSource && annotations.map((r, i) => React.createElement('div', {
        key: i,
        style: {
          position: 'absolute',
          left: Math.min(r.x0, r.x1), top: Math.min(r.y0, r.y1),
          width: Math.abs(r.x1 - r.x0), height: Math.abs(r.y1 - r.y0),
          border: `2px solid ${annotateMode ? r.color : r.color + '8c'}`,
          background: annotateMode ? r.color + '1a' : 'transparent',
          pointerEvents: 'none', zIndex: 4,
        },
      })),
      // 标注 only: a layer that captures the pointer (so the box drag does not
      // orbit the camera). In the picking modes the layer is transparent to
      // pointer events instead.
      meshSource && annotateMode && React.createElement('div', {
        ref: overlayRef,
        onPointerDown: overlayPointer('down'),
        onPointerMove: overlayPointer('move'),
        onPointerUp: overlayPointer('up'),
        style: { position: 'absolute', inset: 0, touchAction: 'none', zIndex: 5, cursor: 'crosshair' },
      }),
    // An unregistered file gets the two tools that need no version — look at it
    // and point at a problem. 测量 / 壁厚 / 剖切 / 热力图 need a stored mesh whose
    // facts a version owns; offering them here would produce numbers nothing
    // could cite (DESIGN §30.18: preview is not evidence).
    !version && meshSource && React.createElement(
      'div',
      { style: toolStripStyle },
      React.createElement('button', {
        type: 'button',
        title: '📸截图并发送到会话：把未登记文件的视图（含标注框）发进上下文，说明"就是这个文件"',
        onClick: () => void onScreenshot(),
        style: { ...viewToolStyle(false), overflow: 'hidden' },
      }, `📸截图${tray.length ? ` ${tray.length}` : ''}`),
      React.createElement('button', {
        type: 'button', title: annotateMode ? '□标注（进行中，再点一次退出）' : '□标注：在视口里拖框框出问题区域',
        onClick: () => setAnnotateMode((m) => !m),
        style: viewToolStyle(annotateMode, '#e74c3c'),
      }, '▭标注'),
    ),
    // ── markup tools, in the viewport (top-left): these only make sense on a
    // single part version ──
    version && React.createElement(
      'div',
      { style: toolStripStyle },
      React.createElement('button', {
        type: 'button',
        title: '📸截图并发送到会话：视口（含测量线、标注框）直接进上下文，排队不打断当前回合',
        onClick: () => void onScreenshot(),
        // Fixed width: the pending count must not widen the row. The count is
        // kept to a bare number so 320px docks still fit all five chips.
        style: { ...viewToolStyle(false), overflow: 'hidden' },
      }, `📸截图${tray.length ? ` ${tray.length}` : ''}`),
      React.createElement('button', {
        type: 'button', title: annotateMode ? '□标注（进行中，再点一次退出）' : '□标注：在视口里拖框框出问题区域',
        onClick: () => { setAnnotateMode((m) => !m); setMeasureMode(false); setThickMode(false); },
        style: viewToolStyle(annotateMode, '#e74c3c'),
      }, '▭标注'),
      React.createElement('button', {
        type: 'button', title: measureMode ? '📏测量（进行中，再点一次退出）' : '📏测量：点两个点量距离，量完自动退出',
        onClick: () => {
          setMeasureMode((v) => !v); setAnnotateMode(false); setThickMode(false);
          if (measureMode) clearMeasure();
        },
        style: viewToolStyle(measureMode, '#ff3040'),
      }, '📏测量'),
      React.createElement('button', {
        type: 'button',
        title: thickMode ? '▤壁厚（进行中，再点一次退出）' : '▤壁厚：点一处，读该处沿视线穿过材料两面的厚度',
        onClick: () => {
          setThickMode((v) => !v); setAnnotateMode(false); setMeasureMode(false);
          if (thickMode) clearThick();
        },
        style: viewToolStyle(thickMode, '#00838f'),
      }, '▤壁厚'),
      React.createElement('button', {
        type: 'button', title: section ? '◐剖切（已开启，再点一次关闭）' : '◐剖切：切掉近侧半边看内部（下面可换 x/y/z 轴）',
        onClick: () => setSection((v) => !v),
        style: viewToolStyle(section, '#8e44ad'),
      }, '◐剖切'),
      React.createElement('button', {
        type: 'button',
        title: '热力图：把检查工具测到的逐点数值画在零件表面上（颜色含义见图例；没有场数据时提示先跑 check_printability）',
        onClick: () => { void toggleHeat(); },
        style: viewToolStyle(Boolean(heat), '#c0392b'),
      }, '🔥热力图'),
    ),
  ),            // closes the panel's createElement (children resume below)

    // ── contextual feedback: measured values, mode instructions, hints ──
    // Always this exact height (S.feedback): entering 测量 used to add a row,
    // shrink the viewport and make the model jump.
    React.createElement(
      'div',
      { style: S.feedback },
      measure && React.createElement('span', {
        style: { fontSize: 12, fontWeight: 700, color: '#c0392b', flex: 'none', lineHeight: '18px' },
      }, measure.b ? `${(measure.dist ?? 0).toFixed(2)} mm` : '已选 1 点…'),
      measure && React.createElement('button', { type: 'button', onClick: clearMeasure, style: S.smallBtn }, '清除测量'),
      heat && React.createElement('span', {
        style: { fontSize: 11, color: '#c0392b', flex: '1 1 auto', lineHeight: '16px' },
      }, heat.legend),
      thick && React.createElement('span', {
        style: { fontSize: 12, fontWeight: 700, color: '#00838f', flex: 'none', lineHeight: '18px' },
      }, `壁厚 ${thick.dist.toFixed(2)} mm（沿视线）`),
      thick && React.createElement('button', { type: 'button', onClick: clearThick, style: S.smallBtn }, '清除壁厚'),
      annotations.length > 0 && React.createElement('button', {
        type: 'button', onClick: () => setAnnotations((a) => a.slice(0, -1)), style: S.smallBtn,
      }, '↩ 撤销标注'),
      annotations.length > 0 && React.createElement('button', {
        type: 'button', onClick: () => setAnnotations([]), style: S.smallBtn,
      }, '清除标注'),
      section && React.createElement(
        'span',
        {
          style: { display: 'flex', alignItems: 'center', gap: 4, flex: '1 1 170px', minWidth: 80, height: 20 },
        },
        React.createElement('span', { style: { fontSize: 11, color: '#8e44ad', flex: 'none' } }, '剖切'),
        React.createElement('select', {
          value: sectionAxis,
          onChange: (e: any) => setSectionAxis(e.target.value),
          'aria-label': '剖切轴向',
          title: '沿哪个轴切开：z 横向切、x/y 纵向切（看中心孔这类内部结构用 x/y）',
          style: { fontSize: 11, height: 20, flex: 'none', padding: '0 2px', border: '1px solid #d5d9dd', borderRadius: 4 },
        }, ...(['x', 'y', 'z'] as const).map((a) => React.createElement('option', { key: a, value: a }, a))),
        React.createElement('span', { style: { fontSize: 11, color: '#8e44ad', flex: 'none' } },
          `${(clipRef.current.pos * 100).toFixed(0)}%`),
        React.createElement('input', {
          type: 'range', min: 0, max: 1, step: 0.01, value: sectionPos,
          'aria-label': '剖切位置',
          title: '拖动改切面位置：0% = 低端，100% = 高端',
          onChange: (e: any) => setSectionPos(Number(e.target.value)),
          style: { flex: '1 1 auto', minWidth: 40, height: 18 },
        }),
      ),
      React.createElement('span', {
        style: {
          fontSize: 11, flex: '1 1 auto', lineHeight: '17px', height: 17, minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: annotateMode ? '#b8860b' : measureMode ? '#c0392b' : thickMode ? '#00838f'
            : (hint ? '#27ae60' : '#8a94a0'),
        },
        title: feedbackText,
      }, feedbackText),
    ),

    // ── sections: one fixed strip, one fixed body, one optional overlay ──
    React.createElement(
      'div',
      { style: { ...S.tabs, position: 'relative' } },
      // Splitter grip on the strip's top edge: drag to trade viewport for content
      // (double-click, or Home, returns to the automatic split). Keyboard arrows
      // work too, which is also how the sandbox can assert it.
      React.createElement('div', {
        role: 'separator',
        'aria-label': '调整详情区高度',
        tabIndex: 0,
        title: '拖动调整功能区高度：视口相应变矮。自动档 = 视口 4:3；最扁可到 16:9（视口越扁，模型显示得越小）；双击或按 Home 恢复自动',
        onDoubleClick: () => setBodyH(null),
        onPointerDown: (e: any) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          dragRef.current = { y: e.clientY, h: bodyHeight };
        },
        onPointerMove: (e: any) => {
          const d = dragRef.current;
          if (!d) return;
          setBodyH(Math.max(BODY_MIN_PX, Math.min(Math.round(d.h - (e.clientY - d.y)), bodyMax)));
        },
        onPointerUp: () => { dragRef.current = null; },
        onKeyDown: (e: any) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const step = (e.key === 'ArrowUp' ? 16 : -16) * (e.shiftKey ? 4 : 1);
            setBodyH(Math.max(BODY_MIN_PX, Math.min(bodyHeight + step, bodyMax)));
          } else if (e.key === 'Home') {
            e.preventDefault();
            setBodyH(null);
          }
        },
        style: {
          position: 'absolute', top: -5, left: 0, right: 0, height: 7,
          cursor: 'ns-resize', zIndex: 6, borderRadius: 3,
        },
      }),
      ...tabs.map((t) => React.createElement('button', {
        key: t.id,
        type: 'button',
        title: `查看「${t.label}」（点 ⤢ 放大到浮层）`,
        onClick: () => { setTab(t.id); setSheet((cur) => (cur && cur !== 'tray' ? t.id : cur)); },
        style: tabBtnStyle(t.id === tab && !sheet),
      }, t.label)),
      React.createElement('button', {
        key: '__expand',
        type: 'button',
        title: sheet ? '收回浮层' : '把当前这一节放大到浮层（浮层不占版式）',
        onClick: () => setSheet((cur) => (cur ? null : tab)),
        style: { ...S.smallBtn, marginLeft: 'auto', padding: '2px 6px' },
      }, sheet ? '⤡' : '⤢'),
    ),

    React.createElement('div', { style: { ...S.details, flexBasis: bodyHeight }, ref: detailsRef },
      sheet
        ? React.createElement('div', { style: S.hint }, `「${tabLabel(sheet)}」已在浮层中打开 — 点 ⤡ 收回`)
        : sectionBody(tab),
    ),

    // Expanded section: absolute, so opening/closing it cannot move anything.
    sheet && React.createElement(
      'div',
      {
        style: {
          ...S.sheet,
          bottom: SHEET_BELOW_FIXED + bodyHeight,
          maxHeight: `calc(100% - ${SHEET_BELOW_FIXED + bodyHeight + 12 + 26 + 8}px)`,
        },
      },
      React.createElement(
        'div',
        { style: S.sheetHead },
        React.createElement('span', { style: { fontSize: 12, fontWeight: 600, color: '#3b4450' } }, tabLabel(sheet)),
        run && React.createElement('span', { style: { fontSize: 11, color: '#8a94a0' } }, run.id),
        React.createElement('button', {
          type: 'button', onClick: () => setSheet(null),
          title: '收回（Esc）', style: { ...S.smallBtn, marginLeft: 'auto' },
        }, '✕ 收回'),
      ),
      React.createElement('div', { style: S.sheetBody }, sectionBody(sheet)),
    ),

    // ── status band: pinned to the bottom, one muted line, never the star ──
    React.createElement(
      'div',
      { style: S.status, title: statusTooltip },
      record && React.createElement('span', { style: { flex: 'none' } }, judgementGlyph(verdict)),
      record && React.createElement('span', {
        style: { flex: 'none', fontWeight: 600, color: verdictColor(verdict) },
      }, VERDICT_WORD[verdict ?? (run ? 'unjudged' : 'draft')]),
      React.createElement('span', { style: S.statusText },
        statusDetail ? `${statusIdentity} — ${statusDetail}` : statusIdentity),
      record && provenance && React.createElement('span', {
        style: { flex: 'none', color: '#8a94a0' },
      }, provenance),
      (review.unread > 0 || review.items.length > 0) && React.createElement('button', {
        type: 'button',
        'data-review-badge': '',
        onClick: () => { setReviewOpen(true); void refreshReviewQueue(); },
        title: review.unread
          ? `${review.unread} 条待阅：Agent 想让你看的东西（打开列表不会切视口）`
          : '待阅列表',
        style: {
          flex: 'none', border: 'none', background: 'none', cursor: 'pointer', padding: 0,
          fontSize: 11, lineHeight: '16px',
          color: review.unread ? '#a4531c' : '#8a94a0',
          fontWeight: review.unread ? 600 : 400,
          textDecoration: 'underline dotted',
        },
      }, `待阅 ${review.unread || review.items.length}`),
      tray.length > 0 && React.createElement('button', {
        type: 'button',
        onClick: () => setSheet('tray'),
        title: '打开截图列表 — 点 📋图 复制后回输入框 Ctrl+V',
        // Deliberately borderless and padding-less: it must occupy exactly the
        // height of the text it replaced, or the band grows and the viewport
        // shrinks by 2px the moment the first screenshot is taken.
        style: {
          flex: 'none', border: 'none', background: 'none', cursor: 'pointer', padding: 0,
          fontSize: 11, lineHeight: '16px', color: '#8a6d1a', textDecoration: 'underline dotted',
        },
      }, `📸 ${tray.length} 张截图`),
    ),
  );
}
