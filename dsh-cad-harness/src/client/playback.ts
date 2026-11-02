/** Panel playback views (M4R pillar B: visualization as a first-class citizen).
 *
 * - MotionPlaybackView: replays rigid-body / mechanism trajectories recorded by
 *   simulate_physics / simulate_motion (trajectory.json), with event markers.
 * - FluidPlaybackView: replays offline MPM frames (frames.json + frame .bin
 *   = Float32 pos[3N] ++ speed[N]) as a three.js Points cloud with speed
 *   coloring, over a transparent wall mesh.
 *
 * Both read the exact files the LLM reads — one artifact set, two consumers.
 */
import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ViewportOverlay, type OverlayScene } from './overlay';
import { fitDistance } from './fit';
import { attachStudioLights, configureStudioRenderer } from './lighting';
import { withProject } from './project';
import { placementEuler } from './placement';
import type { ShotFrame } from './shot-caption';
import { T } from './tokens';
import { runFacts, type RunEvent, type RunFact, type RunFacts, type RunKeyframe, type RunTone } from './run-facts';
import { buildRunChart, RunChart } from './run-chart';

// ---------------------------------------------------------------- scene plumbing

interface SceneHandle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  fit: (center: THREE.Vector3, radius: number) => void;
  /** Re-apply the last fit (the "复原视图" control). */
  refit: () => void;
  /** Scene bounds captured after the meshes were built (world mm). */
  bounds: THREE.Box3 | null;
  setBounds: (box: THREE.Box3) => void;
  /** Clip every part material with this plane (null restores full geometry). */
  setClip: (plane: THREE.Plane | null) => void;
  dispose: () => void;
}

/**
 * Repaint the clear colour when the caller's ground changes.
 *
 * A rebuild would cost a fresh WebGL context and re-fit the camera, so a ground
 * change is one property assignment on the live scene.
 */
function useGround(sceneRef: React.MutableRefObject<SceneHandle | null>, background?: string): void {
  useEffect(() => {
    if (sceneRef.current) sceneRef.current.scene.background = new THREE.Color(background ?? '#f2f3f5');
  }, [background]);
}

function createScene(mount: HTMLDivElement, background?: string): SceneHandle | null {
  // No context → null, and the view says so; never throw through React.
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  } catch {
    return null;
  }
  configureStudioRenderer(renderer);
  // The section control needs per-material clip planes; enabling it costs
  // nothing while no plane is assigned.
  renderer.localClippingEnabled = true;
  renderer.setSize(mount.clientWidth, mount.clientHeight || 420);
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(background ?? '#f2f3f5');
  const aspect = mount.clientWidth / (mount.clientHeight || 420);
  const camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 100_000);
  // Same studio rig as the model viewport: a replay is looked at from every
  // angle too, and a world-fixed key left half of it in the dark.
  attachStudioLights(scene, camera);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  // Re-fit on resize while the camera is still ours: the viewport takes the
  // dock's leftover height, so opening a disclosure changes its shape.
  let userMoved = false;
  controls.addEventListener('start', () => { userMoved = true; });
  const onResize = () => {
    const w = mount.clientWidth;
    const h = mount.clientHeight || 420;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (!userMoved && lastFit) fit(lastFit.center, lastFit.radius);
  };
  window.addEventListener('resize', onResize);
  const ro = new ResizeObserver(onResize);
  ro.observe(mount);

  let disposed = false;
  let raf = 0;
  const loop = () => {
    if (disposed) return;
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  };
  loop();

  let lastFit: { center: THREE.Vector3; radius: number } | null = null;
  let bounds: THREE.Box3 | null = null;
  // Viewing direction is fixed; the distance follows the viewport shape, which
  // is no longer a forced square (see fitDistance).
  const VIEW_DIR = new THREE.Vector3(1.6, 1.2, 1.8).normalize();
  const fit = (center: THREE.Vector3, radius: number) => {
    const r = Math.max(radius, 1);
    lastFit = { center: center.clone(), radius: r };
    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(VIEW_DIR, fitDistance(camera, r));
    controls.minDistance = r * 0.2;
    controls.maxDistance = r * 12;
    controls.update();
  };

  const setClip = (plane: THREE.Plane | null) => {
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!(mesh as unknown as { isMesh?: boolean }).isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        const m = mat as THREE.MeshStandardMaterial;
        m.clippingPlanes = plane ? [plane] : [];
        m.clipShadows = true;
        m.needsUpdate = true;
      }
    });
  };

  return {
    renderer,
    scene,
    camera,
    controls,
    fit,
    get bounds() { return bounds; },
    setBounds: (box: THREE.Box3) => { bounds = box.clone(); },
    setClip,
    // Recomputed from the camera's live aspect, so 复原 also repairs the frame
    // after the dock (or an open disclosure) changed the viewport's shape.
    refit: () => { if (lastFit) fit(lastFit.center, lastFit.radius); },
    dispose: () => {
      disposed = true;
      cancelAnimationFrame(raf);
      controls.dispose();
      ro.disconnect();
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      // Release the context now rather than at GC: the browser caps live
      // contexts, and switching between runs/versions would exhaust it.
      renderer.forceContextLoss();
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
    },
  };
}

/** blue → cyan → green → yellow → red, t in [0,1] */
function speedColor(t: number): [number, number, number] {
  const stops: [number, number, number][] = [
    [0.16, 0.32, 0.9], [0.1, 0.8, 0.9], [0.2, 0.85, 0.3], [0.98, 0.85, 0.2], [0.9, 0.15, 0.1],
  ];
  const x = Math.min(0.999, Math.max(0, t)) * (stops.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = stops[i]!;
  const b = stops[i + 1] ?? a;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

const btn = (active = false, color = '#4a7dbd'): React.CSSProperties => ({
  cursor: 'pointer', borderRadius: 6, padding: '2px 10px', fontSize: 12,
  border: active ? `2px solid ${color}` : '1px solid #bbb', background: active ? '#e8f0fa' : '#fff',
});

const PlaybackFrame: React.FC<{
  mountRef: React.RefObject<HTMLDivElement>;
  controls: React.ReactNode[];
  /** Key numbers + what they mean, above the transport row. */
  data?: React.ReactNode;
  /** Render this instead of the 3D viewport (e.g. no WebGL) but keep data/transport. */
  fallback?: React.ReactNode;
  /** Short dock: hide secondary rows so the 3D viewport keeps room. */
  compact?: boolean;
  /** Live scene for the corner overlays (triad + scale bar + reset). */
  getScene?: () => OverlayScene | null;
  onReset?: () => void;
  /** Drawn above the canvas, inside the viewport box (annotation boxes, hints). */
  overlay?: React.ReactNode;
}> = ({ mountRef, controls, data, fallback, compact, getScene, onReset, overlay }) =>
  React.createElement(
    'div',
    {
      'data-playback-frame': '1',
      'data-playback-compact': compact ? '1' : undefined,
      style: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' },
    },
    React.createElement(
      'div',
      { 'data-playback-viewport': '1', style: { flex: 1, position: 'relative', minHeight: 0 } },
      fallback ?? React.createElement('div', { ref: mountRef, style: { position: 'absolute', inset: 0 } }),
      overlay ?? null,
      !fallback && getScene && React.createElement(ViewportOverlay, { getScene, onReset }),
    ),
    data ?? null,
    React.createElement(
      'div',
      { style: { display: 'flex', gap: 6, rowGap: 4, alignItems: 'center', flexWrap: 'wrap', paddingTop: 4 } },
      ...controls,
    ),
  );

// ---------------------------------------------------------------- motion playback

interface TrajectoryJson {
  kind: 'motion' | 'physics';
  durationSec: number;
  trajectory: {
    times: number[];
    parts: { name: string; bodyType: string; frames: number[][] }[];
    events: { timeSec: number; label: string }[];
  };
}

/** One committed annotation box, in the viewport's CSS-pixel frame. */
interface AnnBox { x0: number; y0: number; x1: number; y1: number; color: string }

const ANN_COLORS = [T.danger, T.warn, T.ok, T.accent];

/**
 * Bake the boxes into a COPY of the canvas, in device pixels.
 *
 * A box is screen-space (a rect), so this works in a playback view where the
 * picking machinery (raycast into the animated solids) is not wired up. The copy
 * matters: stroking the live canvas would smear the boxes across the next frames.
 */
const bakeBoxes = (src: HTMLCanvasElement, boxes: AnnBox[], rect: { width: number; height: number }): HTMLCanvasElement => {
  if (boxes.length === 0) return src;
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  const g = out.getContext('2d');
  if (!g) return src;
  g.drawImage(src, 0, 0);
  const sx = out.width / Math.max(1, rect.width);
  const sy = out.height / Math.max(1, rect.height);
  g.lineWidth = Math.max(2, out.width / 300);
  for (const b of boxes) {
    g.strokeStyle = b.color;
    g.strokeRect(
      Math.min(b.x0, b.x1) * sx, Math.min(b.y0, b.y1) * sy,
      Math.abs(b.x1 - b.x0) * sx, Math.abs(b.y1 - b.y0) * sy,
    );
  }
  return out;
};

/** The drag/commit layer: `pointer-events` only while annotating, so orbiting is
 *  never stolen by an invisible sheet. */
const annotateLayer = (opts: {
  on: boolean;
  boxes: AnnBox[];
  drag: AnnBox | null;
  onStart: (x: number, y: number) => void;
  onMove: (x: number, y: number) => void;
  onEnd: () => void;
}): React.ReactNode => React.createElement(
  'div',
  {
    'data-annotate-layer': '1',
    style: { position: 'absolute', inset: 0, cursor: opts.on ? 'crosshair' : 'default', pointerEvents: opts.on ? 'auto' : 'none', zIndex: 3 },
    onPointerDown: (e: any) => {
      if (!opts.on) return;
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      // Start FIRST, capture second: setPointerCapture throws on a pointer id that
      // is not active (a dispatched/synthetic pointer, or a stylus that already
      // lifted), and it used to abort the handler before the box existed.
      opts.onStart(e.clientX - r.left, e.clientY - r.top);
      try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); } catch { /* not a live pointer */ }
    },
    onPointerMove: (e: any) => {
      if (!opts.on) return;
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      // No `opts.drag` guard here: state updates are batched, so a fast drag can
      // deliver move before the re-render that sets `drag`. The parent's updater
      // is the one place that knows whether a drag is in progress.
      opts.onMove(e.clientX - r.left, e.clientY - r.top);
    },
    onPointerUp: () => { if (opts.on) opts.onEnd(); },
  },
  ...opts.boxes.map((b, i) => React.createElement('div', {
    key: `b${i}`, 'data-annotate-box': String(i),
    style: {
      position: 'absolute', left: Math.min(b.x0, b.x1), top: Math.min(b.y0, b.y1),
      width: Math.abs(b.x1 - b.x0), height: Math.abs(b.y1 - b.y0),
      border: `2px solid ${b.color}`, pointerEvents: 'none', borderRadius: 2,
    },
  })),
  opts.drag ? React.createElement('div', {
    'data-annotate-drag': '1',
    style: {
      position: 'absolute', left: Math.min(opts.drag.x0, opts.drag.x1), top: Math.min(opts.drag.y0, opts.drag.y1),
      width: Math.abs(opts.drag.x1 - opts.drag.x0), height: Math.abs(opts.drag.y1 - opts.drag.y0),
      border: `2px dashed ${opts.drag.color}`, pointerEvents: 'none',
    },
  }) : null,
);

const PART_COLORS = ['#4a7dbd', '#c0392b', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c'];

// ---------------------------------------------------------------- run data / timeline

const toneColor = (tone?: RunTone): string =>
  tone === 'ok' ? T.ok : tone === 'bad' ? T.danger : tone === 'warn' ? T.warn : T.muted;

const factChip = (f: RunFact, key: number) => React.createElement(
  'span',
  {
    key,
    title: f.title,
    style: {
      display: 'inline-flex', alignItems: 'baseline', gap: 3, fontSize: 10,
      color: T.soft, background: T.ground, border: `1px solid ${T.border}`,
      borderRadius: 8, padding: '2px 6px', whiteSpace: 'nowrap',
    },
  },
  React.createElement('span', { style: { color: T.muted } }, f.label),
  React.createElement('b', { style: { color: toneColor(f.tone), fontWeight: 600 } }, f.value),
);

/** The first thing a human should read: verdict, the five numbers that support
 * it, and one sentence saying what to look at. The detailed table stays in 报告. */
function RunDataStrip(props: {
  facts: RunFacts;
  onSeek: (timeSec: number) => void;
  compact?: boolean;
}): React.ReactElement {
  return React.createElement(
    'div',
    { 'data-playback-data': '1', style: { display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 4, borderTop: `1px solid ${T.border}` } },
    React.createElement(
      'div',
      { style: { display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' } },
      React.createElement('span', {
        style: {
          fontSize: 10, fontWeight: 700, color: toneColor(props.facts.tone),
          border: `1px solid ${toneColor(props.facts.tone)}`, borderRadius: 9, padding: '1px 7px',
        },
      }, props.facts.headline),
      ...(props.compact ? props.facts.facts.slice(0, 3) : props.facts.facts).map((f, i) => factChip(f, i)),
    ),
    React.createElement('div', {
      'data-run-summary': '1',
      // Always one line: a wrapped sentence is a second row of chrome paid for
      // by the viewport. The full text stays in the tooltip/report tab.
      title: props.facts.summary,
      style: {
        fontSize: 11, color: T.soft, lineHeight: 1.3,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      },
    }, props.facts.summary),
    !props.compact && props.facts.events.length > 0
      ? React.createElement(
        'details',
        { style: { fontSize: 11 } },
        React.createElement('summary', { style: { cursor: 'pointer', color: T.muted } },
          `事件 ${props.facts.events.length}（点时间跳到该帧）`),
        React.createElement('div', { style: { maxHeight: 96, overflowY: 'auto', marginTop: 2 } },
          ...props.facts.events.slice(0, 30).map((ev, i) => React.createElement(
            'button',
            {
              key: i, type: 'button', onClick: () => props.onSeek(ev.timeSec), title: ev.label,
              style: {
                display: 'block', width: '100%', textAlign: 'left', border: 0, background: 'transparent',
                padding: '1px 0', fontSize: 11, color: toneColor(ev.tone), cursor: 'pointer',
              },
            },
            `t=${ev.timeSec.toFixed(3)}s · ${ev.label}`,
          )),
        ),
      )
      : null,
  );
}

/** Keyframe renders already stored by the run — the strip is just their index.
 * The filename rule is the host's: frame_<step:5>_<label sanitised>.png. */
export function RunKeyframeStrip(props: {
  runId: string;
  keyframes: RunKeyframe[];
  activeIndex?: number;
  onPick?: (index: number) => void;
  compact?: boolean;
}): React.ReactElement | null {
  if (!Array.isArray(props.keyframes) || props.keyframes.length === 0) return null;
  const imgHeight = props.compact ? 46 : 58;
  return React.createElement(
    'div',
    { 'data-keyframe-strip': '1', style: { display: 'flex', gap: 6, overflowX: 'auto', padding: '2px 0 4px', alignItems: 'flex-start' } },
    ...props.keyframes.map((k, i) => {
      const safe = k.label.replace(/[^A-Za-z0-9\u4e00-\u9fff]+/g, '_').slice(0, 24);
      const name = `frame_${String(k.step ?? 0).padStart(5, '0')}_${safe}.png`;
      const active = props.activeIndex === i;
      return React.createElement(
        'button',
        {
          key: i, type: 'button', title: `${k.label} @ ${k.timeSec.toFixed(3)}s`,
          onClick: () => props.onPick?.(i),
          style: {
            flex: '0 0 auto', width: props.compact ? 82 : 96, padding: 2, cursor: 'pointer',
            border: `2px solid ${active ? T.accent : T.border}`, borderRadius: 5,
            background: active ? T.accentSoft : T.plate, textAlign: 'left',
          },
        },
        React.createElement('img', {
          src: withProject(`/api/cad/run/image?id=${encodeURIComponent(props.runId)}&name=${encodeURIComponent(name)}`),
          alt: k.label,
          onError: (e: React.SyntheticEvent<HTMLImageElement>) => { e.currentTarget.style.visibility = 'hidden'; },
          style: { width: '100%', height: imgHeight, objectFit: 'cover', borderRadius: 3, background: T.ground, display: 'block' },
        }),
        React.createElement('div', {
          style: { fontSize: 9, color: active ? T.ink : T.soft, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
        }, k.label),
        React.createElement('div', { style: { fontSize: 9, color: T.muted } }, `t=${k.timeSec.toFixed(2)}s`),
      );
    }),
  );
}

/** A real timeline instead of a 14px tick strip: keyframe diamonds (click to
 * pause there), coloured event ticks, a playhead, and click-to-seek anywhere. */
function RunTimeline(props: {
  times: number[];
  events: RunEvent[];
  keyframes: RunKeyframe[];
  timeSec: number;
  onSeek: (timeSec: number) => void;
  onKeyframe: (index: number) => void;
}): React.ReactElement {
  const tMax = props.times[props.times.length - 1] ?? 1;
  const pct = (t: number): string => `${Math.max(0, Math.min(100, (t / (tMax || 1)) * 100))}%`;
  const click = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = (e.clientX - r.left) / Math.max(1, r.width);
    props.onSeek(Math.max(0, Math.min(tMax, f * tMax)));
  };
  return React.createElement(
    'div',
    { 'data-run-timeline': '1', onClick: click, style: { position: 'relative', height: 22, width: '100%', cursor: 'crosshair', marginTop: 0 } },
    React.createElement('div', { style: { position: 'absolute', left: 0, right: 0, top: 10, height: 2, background: T.line } }),
    ...props.keyframes.map((k, i) => React.createElement('button', {
      key: `kf-${i}`, type: 'button', title: `关键帧 ${k.label} @ ${k.timeSec.toFixed(3)}s`,
      onClick: (e: React.MouseEvent) => { e.stopPropagation(); props.onKeyframe(i); },
      style: {
        position: 'absolute', left: pct(k.timeSec), top: 6, width: 8, height: 8, padding: 0,
        border: `1px solid ${T.white}`, background: T.accent, transform: 'translateX(-50%) rotate(45deg)',
        cursor: 'pointer',
      },
    })),
    ...props.events.slice(0, 40).map((ev, i) => React.createElement('button', {
      key: `ev-${i}`, type: 'button', title: ev.label,
      onClick: (e: React.MouseEvent) => { e.stopPropagation(); props.onSeek(ev.timeSec); },
      style: {
        position: 'absolute', left: pct(ev.timeSec), top: 3, width: 3, height: 16, padding: 0,
        border: 0, borderRadius: 1, background: toneColor(ev.tone), transform: 'translateX(-50%)',
        cursor: 'pointer',
      },
    })),
    React.createElement('div', {
      style: {
        position: 'absolute', left: pct(props.timeSec), top: 1, width: 2, height: 20,
        background: T.ink, transform: 'translateX(-50%)', pointerEvents: 'none',
      },
    }),
  );
}

export function MotionPlaybackView(props: {
  /** The run this playback belongs to — every artifact is addressed by run id. */
  runId: string;
  /** The run's own report (already fetched by the panel); drives the data strip. */
  report?: unknown;
  /** The run's verdict (pass/check/fail) for the badge. */
  status?: string;
  /** Ground colour (hex); the caller owns the choice — see lighting.ts. */
  background?: string;
  onScreenshot?: (canvas: HTMLCanvasElement, label: string, frame?: ShotFrame) => void;
}): React.ReactElement {
  const [traj, setTraj] = useState<TrajectoryJson | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [frameIdx, setFrameIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [meshesVersion, setMeshesVersion] = useState(0);
  const [kfIdx, setKfIdx] = useState(-1);
  const [pauseAtKf, setPauseAtKf] = useState(false);
  const [hiddenParts, setHiddenParts] = useState<Set<string>>(() => new Set());
  const [section, setSection] = useState<{ on: boolean; axis: 'x' | 'y' | 'z'; frac: number; flip: boolean }>(
    { on: false, axis: 'x', frac: 0.5, flip: false },
  );
  const [measureOn, setMeasureOn] = useState(false);
  const [measurePoints, setMeasurePoints] = useState(0);
  const [measureMm, setMeasureMm] = useState<number | null>(null);
  // Annotation boxes are per-view and stay across frames: a box drawn at t=0.30
  // marks a PLACE, and the screenshot label carries the frame it was read on.
  const [annotOn, setAnnotOn] = useState(false);
  const [boxes, setBoxes] = useState<AnnBox[]>([]);
  const [dragBox, setDragBox] = useState<AnnBox | null>(null);
  // The live drag lives in a ref as well: `onEnd` must COMMIT the box, and doing
  // that inside a setState updater is a side effect (React may drop or repeat it —
  // which is exactly how the first version lost every box).
  const dragBoxRef = useRef<AnnBox | null>(null);
  const [compact, setCompact] = useState(false);
  const measurePointsRef = useRef<THREE.Vector3[]>([]);
  const measureGroupRef = useRef<THREE.Group | null>(null);
  const playStartRef = useRef(0);
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneHandle | null>(null);
  useGround(sceneRef, props.background);
  const meshesRef = useRef<{ name: string; mesh: THREE.Mesh }[]>([]);

  // One run, one trajectory — no cross-kind fallback (that fallback was how the
  // old mode tabs silently showed a different subject than the selected version).
  useEffect(() => {
    let dead = false;
    setTraj(null);
    setErr(null);
    setFrameIdx(0);
    setKfIdx(-1);
    setHiddenParts(new Set());
    setSection((cur) => ({ ...cur, on: false }));
    setMeasureOn(false);
    setMeasurePoints(0);
    setMeasureMm(null);
    measurePointsRef.current = [];
    measureGroupRef.current = null;
    setPlaying(false);
    void (async () => {
      try {
        const res = await fetch(withProject(`/api/cad/run/trajectory?id=${encodeURIComponent(props.runId)}`));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as TrajectoryJson;
        if (dead) return;
        if (data?.trajectory?.parts?.length) setTraj(data);
        else setErr('这次运行没有轨迹数据');
      } catch {
        if (!dead) setErr('这次运行没有轨迹数据');
      }
    })();
    return () => { dead = true; };
  }, [props.runId]);

  // build the scene: one mesh per part, posed at frame 0
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !traj) return;
    const handle = createScene(mount, props.background);
    if (!handle) { setErr('此环境无法创建 WebGL 上下文 — 回放不可用'); return; }
    sceneRef.current = handle;
    let dead = false;

    void (async () => {
      const group = new THREE.Group();
      handle.scene.add(group);
      const meshes: { name: string; mesh: THREE.Mesh }[] = [];
      const center = new THREE.Vector3();
      let maxR = 0;
      for (let i = 0; i < traj.trajectory.parts.length; i++) {
        const part = traj.trajectory.parts[i]!;
        try {
          const res = await fetch(withProject(`/api/cad/run/stl?id=${encodeURIComponent(props.runId)}&part=${encodeURIComponent(part.name)}`));
          if (!res.ok) continue;
          const geo = new STLLoader().parse(await res.arrayBuffer());
          geo.computeBoundingSphere();
          const fixed = part.bodyType === 'fixed';
          const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
            color: fixed ? '#9aa5b1' : PART_COLORS[i % PART_COLORS.length]!,
            metalness: 0.1, roughness: 0.6,
            transparent: fixed, opacity: fixed ? 0.45 : 1,
          }));
          group.add(mesh);
          meshes.push({ name: part.name, mesh });
          const f = part.frames[0]!;
          center.add(new THREE.Vector3(f[0]!, f[1]!, f[2]!));
        } catch { /* missing part STL — skip it */ }
      }
      if (dead) return;
      meshesRef.current = meshes;
      if (meshes.length > 0) {
        center.divideScalar(meshes.length);
        for (const { mesh, name } of meshes) {
          const part = traj.trajectory.parts.find((p) => p.name === name);
          const f = part?.frames[0]!;
          const d = new THREE.Vector3(f![0]!, f![1]!, f![2]!).distanceTo(center);
          maxR = Math.max(maxR, d + (mesh.geometry.boundingSphere?.radius ?? 5));
        }
        handle.fit(center, maxR);
        handle.setBounds(new THREE.Box3().setFromObject(group));
      }
      setMeshesVersion((v) => v + 1);
    })();

    return () => {
      dead = true;
      meshesRef.current = [];
      measureGroupRef.current = null;
      handle.dispose();
      sceneRef.current = null;
    };
  }, [traj]);

  const nFrames = traj?.trajectory.times.length ?? 0;
  const facts = React.useMemo(
    () => runFacts(traj?.kind ?? 'motion', props.report, props.status),
    [traj?.kind, props.report, props.status],
  );
  const keyframes = facts?.keyframes ?? [];
  const chart = React.useMemo(
    () => (traj ? buildRunChart(traj.kind, props.report) : null),
    [traj?.kind, props.report],
  );

  const frameAt = (time: number): number => {
    const times = traj?.trajectory.times ?? [];
    let best = 0;
    let bestDelta = Infinity;
    for (let i = 0; i < times.length; i++) {
      const d = Math.abs(times[i]! - time);
      if (d < bestDelta) { bestDelta = d; best = i; }
    }
    return best;
  };
  const seekTime = (time: number) => {
    setPlaying(false);
    setKfIdx(-1);
    setFrameIdx(frameAt(time));
  };
  const goKeyframe = (index: number) => {
    const kf = keyframes[index];
    if (!kf) return;
    setPlaying(false);
    setKfIdx(index);
    setFrameIdx(frameAt(kf.timeSec));
  };
  const keyframeFrames = React.useMemo(() => {
    const map = new Map<number, number>();
    keyframes.forEach((kf, i) => {
      const f = frameAt(kf.timeSec);
      if (!map.has(f)) map.set(f, i);
    });
    return map;
    // frameAt is derived from traj.trajectory.times; keyframes from props.report.
  }, [traj, keyframes]);

  // apply the current frame's poses to the meshes
  useEffect(() => {
    if (!traj) return;
    for (const part of traj.trajectory.parts) {
      const entry = meshesRef.current.find((x) => x.name === part.name);
      const f = part.frames[Math.min(frameIdx, part.frames.length - 1)];
      if (!entry || !f) continue;
      entry.mesh.position.set(f[0]!, f[1]!, f[2]!);
      entry.mesh.quaternion.set(f[3]!, f[4]!, f![5]!, f[6]!);
      entry.mesh.visible = !hiddenParts.has(part.name);
    }
  }, [traj, frameIdx, meshesVersion, hiddenParts]);

  // playback clock
  useEffect(() => {
    if (!playing || nFrames === 0) return;
    const iv = setInterval(() => setFrameIdx((i) => (i + 1) % nFrames), Math.max(16, 33 / speed));
    return () => clearInterval(iv);
  }, [playing, speed, nFrames]);

  // "play, but stop at the next keyframe": starting ON a keyframe must not stop
  // immediately, so the frame the play started from is exempt until the playhead
  // reaches the following keyframe.
  useEffect(() => {
    if (!playing || !pauseAtKf) return;
    const hit = keyframeFrames.get(frameIdx);
    if (hit !== undefined && frameIdx !== playStartRef.current) {
      setPlaying(false);
      setKfIdx(hit);
    }
  }, [frameIdx, playing, pauseAtKf, keyframeFrames]);

  const clearMeasure = () => {
    const handle = sceneRef.current;
    const group = measureGroupRef.current;
    if (handle && group) {
      handle.scene.remove(group);
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = (mesh as unknown as { material?: THREE.Material | THREE.Material[] }).material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      });
    }
    measureGroupRef.current = null;
    measurePointsRef.current = [];
    setMeasurePoints(0);
    setMeasureMm(null);
  };

  // Section cut: one world-space plane, applied to every part material. It is a
  // live clip (no capped face) — the honest label says so, and the exact
  // section/measurement tools remain the version viewport's job.
  useEffect(() => {
    const handle = sceneRef.current;
    if (!handle) return;
    if (!section.on) { handle.setClip(null); return; }
    const box = handle.bounds;
    if (!box) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const normal = new THREE.Vector3(
      section.axis === 'x' ? 1 : 0,
      section.axis === 'y' ? 1 : 0,
      section.axis === 'z' ? 1 : 0,
    ).multiplyScalar(section.flip ? -1 : 1);
    const point = center.clone();
    point[section.axis] += (section.frac - 0.5) * size[section.axis]!;
    handle.setClip(new THREE.Plane(normal, -normal.dot(point)));
  }, [section.on, section.axis, section.frac, section.flip, meshesVersion]);

  // A measurement is tied to the pose it was taken on; moving the playhead makes
  // it stale, so it is cleared rather than shown against a different frame.
  useEffect(() => { clearMeasure(); }, [frameIdx, measureOn]);

  useEffect(() => {
    const handle = sceneRef.current;
    if (!handle || !measureOn) return;
    const canvas = handle.renderer.domElement;
    canvas.style.cursor = 'crosshair';
    const ray = new THREE.Raycaster();
    let downX = 0;
    let downY = 0;
    const onDown = (e: PointerEvent) => { downX = e.clientX; downY = e.clientY; };
    const onUp = (e: PointerEvent) => {
      // A drag is an orbit, not a measurement.
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) return;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      ray.setFromCamera(ndc, handle.camera);
      const hits = ray.intersectObjects(meshesRef.current.filter((m) => m.mesh.visible).map((m) => m.mesh), false);
      const hit = hits[0];
      if (!hit) return;
      if (measurePointsRef.current.length >= 2) clearMeasure();
      const point = hit.point.clone();
      measurePointsRef.current.push(point);
      const box = handle.bounds;
      const maxDim = box ? box.getSize(new THREE.Vector3()).length() : 100;
      const dotR = Math.max(0.6, maxDim * 0.006);
      let group = measureGroupRef.current;
      if (!group) {
        group = new THREE.Group();
        handle.scene.add(group);
        measureGroupRef.current = group;
      }
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(dotR, 10, 10),
        new THREE.MeshBasicMaterial({ color: 0xff3040, depthTest: false }),
      );
      dot.position.copy(point);
      dot.renderOrder = 20;
      group.add(dot);
      if (measurePointsRef.current.length === 2) {
        const [a, b] = measurePointsRef.current as [THREE.Vector3, THREE.Vector3];
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([a, b]),
          new THREE.LineBasicMaterial({ color: 0xff3040, depthTest: false }),
        );
        line.renderOrder = 20;
        group.add(line);
        setMeasureMm(a.distanceTo(b));
      }
      setMeasurePoints(measurePointsRef.current.length);
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.style.cursor = '';
    };
  }, [measureOn, frameIdx, meshesVersion]);

  // The dock at 380px is a 4:3 stage (~285px tall), not 900px. Without a compact
  // mode the data strip + transport + timeline consume the whole viewport; the
  // 3D scene is then 0px tall. Measure the frame, not the mount, because the mount
  // is the thing that collapses.
  useEffect(() => {
    const frame = mountRef.current?.closest('[data-playback-frame]') as HTMLElement | null;
    if (!frame) return;
    const update = () => setCompact(frame.clientHeight < 340);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(frame);
    return () => ro.disconnect();
  }, [traj]);

  if (!traj) {
    return React.createElement('div', { style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888', fontSize: 13 } }, err ?? '加载轨迹…');
  }

  const t = traj.trajectory.times[Math.min(frameIdx, nFrames - 1)] ?? 0;
  const isMotion = traj.kind === 'motion';
  const frameStep = nFrames > 1 ? Math.abs(traj.trajectory.times[1]! - traj.trajectory.times[0]!) : 0;
  const nearestKf = keyframes.findIndex((k) => Math.abs(k.timeSec - t) <= Math.max(1e-6, frameStep / 2));
  const selectedKf = kfIdx >= 0 ? kfIdx : nearestKf;
  const currentKf = selectedKf >= 0 ? keyframes[selectedKf] : undefined;
  const prevKf = (() => {
    for (let i = keyframes.length - 1; i >= 0; i--) if (keyframes[i]!.timeSec < t - 1e-6) return i;
    return -1;
  })();
  const nextKf = (() => {
    for (let i = 0; i < keyframes.length; i++) if (keyframes[i]!.timeSec > t + 1e-6) return i;
    return -1;
  })();
  const timeLabel = `t=${t.toFixed(2)}s · ${frameIdx + 1}/${nFrames}` + (currentKf ? ` · ${currentKf.label}` : '');
  const shortTime = `t=${t.toFixed(2)}s · ${frameIdx + 1}/${nFrames}`;
  const togglePart = (name: string) => setHiddenParts((prev) => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });

  // The tool row used to live under the data strip and cost a full line of
  // viewport height. It is now a translucent strip INSIDE the viewport (same
  // language as 复原/triad), so the 3D stage keeps the pixels.
  const playbackTools = !err && !compact && sceneRef.current
    ? React.createElement('div', {
        'data-playback-tools': '1',
        style: {
          position: 'absolute', top: 6, left: 6, zIndex: 7,
          display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap',
          maxWidth: 'calc(100% - 70px)', padding: '3px 5px',
          borderRadius: 7, background: 'rgba(255,255,255,0.88)',
          border: `1px solid ${T.border}`, boxShadow: '0 1px 4px rgba(20,30,40,0.14)',
          fontSize: 10, color: T.soft,
        },
      },
      React.createElement('button', {
        type: 'button', title: '实时剖切（无封盖）：看内部关节/间隙', onClick: () => setSection((cur) => ({ ...cur, on: !cur.on })),
        style: { ...btn(section.on), fontSize: 10, padding: '1px 7px' },
      }, '✂ 剖切'),
      React.createElement('button', {
        type: 'button', title: '在模型上点两点测距（视口射线，近似值）', onClick: () => setMeasureOn((v) => !v),
        style: { ...btn(measureOn, '#ff3040'), fontSize: 10, padding: '1px 7px' },
      }, '📏 测距'),
      // Screen-space box: works here because it does not need the picking stack
      // (the main viewer's 标注 was the only place this existed).
      React.createElement('button', {
        type: 'button', 'data-annotate-toggle': '1',
        title: '在画面上拖出一个框，圈出要说明的地方；框随截图一起带走',
        onClick: () => setAnnotOn((v) => !v),
        style: { ...btn(annotOn, T.danger), fontSize: 10, padding: '1px 7px' },
      }, annotOn ? '▭ 标注中' : '▭ 标注'),
      boxes.length
        ? React.createElement('button', {
            type: 'button', 'data-annotate-clear': '1', title: '清除所有标注框',
            onClick: () => setBoxes([]),
            style: { ...btn(false), fontSize: 10, padding: '1px 7px' },
          }, `清除 ${boxes.length}`)
        : null,
      section.on ? React.createElement('select', {
        value: section.axis, title: '剖切轴',
        onChange: (e: any) => setSection((cur) => ({ ...cur, axis: e.target.value as 'x' | 'y' | 'z' })),
        style: { fontSize: 10, padding: '1px 3px' },
      }, (['x', 'y', 'z'] as const).map((a) => React.createElement('option', { key: a, value: a }, a.toUpperCase()))) : null,
      section.on ? React.createElement('input', {
        type: 'range', min: 0, max: 1, step: 0.01, value: section.frac, title: '剖切位置',
        onChange: (e: any) => setSection((cur) => ({ ...cur, frac: Number(e.target.value) })),
        style: { width: 96 },
      }) : null,
      section.on ? React.createElement('button', {
        type: 'button', title: '翻转保留侧', onClick: () => setSection((cur) => ({ ...cur, flip: !cur.flip })),
        style: { ...btn(section.flip), fontSize: 10, padding: '1px 7px' },
      }, '翻转') : null,
      section.on ? React.createElement('span', { style: { color: T.muted } }, '无封盖') : null,
      measureOn
        ? React.createElement('span', { style: { color: measureMm == null ? T.muted : T.ink } },
            measureMm == null
              ? (measurePoints === 1 ? '再点一个点' : '点模型上两点')
              : `距离 ${measureMm.toFixed(2)}mm（视口近似）`)
        : null,
      measureMm != null
        ? React.createElement('button', {
            type: 'button', onClick: clearMeasure, style: { ...btn(false), fontSize: 10, padding: '1px 7px' },
          }, '清除')
        : null,
    )
    : null;

  return React.createElement(PlaybackFrame, {
    mountRef, compact,
    overlay: React.createElement(React.Fragment, null,
      annotateLayer({
        on: annotOn,
        boxes,
        drag: dragBox,
        onStart: (x, y) => {
          const box = { x0: x, y0: y, x1: x, y1: y, color: ANN_COLORS[boxes.length % ANN_COLORS.length]! };
          dragBoxRef.current = box;
          setDragBox(box);
        },
        onMove: (x, y) => {
          const cur = dragBoxRef.current;
          if (!cur) return;
          const next = { ...cur, x1: x, y1: y };
          dragBoxRef.current = next;
          setDragBox(next);
        },
        onEnd: () => {
          const cur = dragBoxRef.current;
          dragBoxRef.current = null;
          setDragBox(null);
          // A click (not a drag) must not leave a 0×0 "box" behind.
          if (cur && Math.abs(cur.x1 - cur.x0) > 6 && Math.abs(cur.y1 - cur.y0) > 6) {
            setBoxes((prev) => [...prev, { ...cur, x1: (cur as AnnBox).x1, y1: (cur as AnnBox).y1 }]);
          }
        },
      }),
      playbackTools,
    ),
    data: facts ? React.createElement(RunDataStrip, { facts, onSeek: seekTime, compact }) : null,
    fallback: err
      ? React.createElement('div', {
          style: {
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16, textAlign: 'center', color: T.muted, fontSize: 13,
          },
        }, err)
      : undefined,
    getScene: () => (!err && sceneRef.current
      ? { camera: sceneRef.current.camera, focus: sceneRef.current.controls.target }
      : null),
    onReset: () => { if (!err) sceneRef.current?.refit(); },
    controls: [
      React.createElement('button', {
        key: 'kf-first', title: '第一个关键帧', disabled: keyframes.length === 0,
        onClick: () => goKeyframe(0),
        style: { ...btn(false), opacity: keyframes.length ? 1 : 0.35 },
      }, '⏮'),
      React.createElement('button', {
        key: 'kf-prev', title: '上一关键帧', disabled: prevKf < 0,
        onClick: () => goKeyframe(prevKf),
        style: { ...btn(false), opacity: prevKf < 0 ? 0.35 : 1 },
      }, '⟨'),
      React.createElement('button', {
        key: 'play',
        onClick: () => {
          if (!playing) playStartRef.current = frameIdx;
          setPlaying((p) => !p);
        },
        style: btn(playing), title: playing ? '暂停' : '播放',
      }, playing ? '⏸' : '▶'),
      React.createElement('button', {
        key: 'kf-next', title: '下一关键帧', disabled: nextKf < 0,
        onClick: () => goKeyframe(nextKf),
        style: { ...btn(false), opacity: nextKf < 0 ? 0.35 : 1 },
      }, '⟩'),
      React.createElement('input', {
        key: 'seek', type: 'range', min: 0, max: Math.max(0, nFrames - 1), value: Math.min(frameIdx, nFrames - 1),
        onChange: (e: any) => { setPlaying(false); setKfIdx(-1); setFrameIdx(Number(e.target.value)); },
        style: { flex: '1 1 60px', minWidth: 60 },
      }),
      // No forced row break: at 842px the transport fits on one line, and the
      // old `flexBasis:100%` spacer cost a permanent 28px at that width. At
      // narrow widths `flexWrap` still moves the select/speed/checkbox down.
      // Fixed width + tabular digits: the label changes every frame/keyframe,
      // and an auto-width flex item made the whole transport row twitch (some
      // browsers repaint the native <select> at a new width). Reserve the box;
      // let the text be clipped, never the layout.
      React.createElement('span', {
        key: 'time', title: timeLabel,
        style: {
          fontSize: 10, color: T.soft, flex: '0 0 100px', width: 100,
          fontVariantNumeric: 'tabular-nums', overflow: 'hidden',
          textAlign: 'right', whiteSpace: 'nowrap',
        },
      }, shortTime),
      React.createElement('select', {
        key: 'kf-select', 'data-keyframe-select': '1', value: selectedKf, title: '跳到关键帧',
        onChange: (e: any) => {
          const i = Number(e.target.value);
          if (i >= 0) goKeyframe(i); else setKfIdx(-1);
        },
        // Same reason as the time label: native selects size themselves from
        // the selected option's text, so changing keyframe made the control
        // (and the row) jump. A fixed 150px box keeps the text change local.
        style: {
          fontSize: 11, padding: '2px 4px', flex: '0 0 150px', width: 150,
          fontVariantNumeric: 'tabular-nums', boxSizing: 'border-box',
        },
      },
      React.createElement('option', { value: -1 }, keyframes.length ? '关键帧…' : '无关键帧'),
      ...keyframes.map((k, i) => React.createElement('option', { value: i }, `${k.label} · ${k.timeSec.toFixed(2)}s`))),
      React.createElement('select', {
        key: 'speed', value: speed, onChange: (e: any) => setSpeed(Number(e.target.value)),
        style: { fontSize: 11, padding: '2px 4px', flex: '0 0 48px', width: 48 },
      }, [0.25, 0.5, 1, 2, 4].map((s) => React.createElement('option', { key: s, value: s }, `${s}×`))),
      React.createElement('label', {
        key: 'pause-kf', 'data-pause-keyframes': '1', title: '播放时在下一个关键帧自动暂停',
        style: { fontSize: 11, color: T.soft, display: 'inline-flex', gap: 3, alignItems: 'center' },
      },
      React.createElement('input', {
        type: 'checkbox', checked: pauseAtKf,
        onChange: (e: any) => setPauseAtKf(Boolean(e.target.checked)),
      }), '到关键帧停'),
      props.onScreenshot && sceneRef.current
        ? React.createElement('button', {
            key: 'shot',
            onClick: () => {
              const canvas = sceneRef.current!.renderer.domElement;
              const viewport = mountRef.current?.closest('[data-playback-viewport]') as HTMLElement | null;
              props.onScreenshot?.(
                bakeBoxes(canvas, boxes, { width: viewport?.clientWidth ?? canvas.clientWidth, height: viewport?.clientHeight ?? canvas.clientHeight }),
                `${isMotion ? '机构' : '物理'}回放 t=${t.toFixed(2)}s`,
              // The caption needs the exact frame, not just the rounded t it
              // prints: the frame index is what survives a same-t collision.
                { index: frameIdx + 1, total: nFrames, timeSec: t, events: traj.trajectory.events,
                  stepSec: nFrames > 1 ? traj.trajectory.times[1]! - traj.trajectory.times[0]! : 0 },
              );
            },
            style: btn(false),
          }, '📸')
        : null,
      React.createElement('div', { key: 'timeline', style: { width: '100%' } },
        React.createElement(RunTimeline, {
          times: traj.trajectory.times,
          events: facts?.events ?? [],
          keyframes,
          timeSec: t,
          onSeek: seekTime,
          onKeyframe: goKeyframe,
        })),
      compact ? null : React.createElement('details', { key: 'analysis', style: { width: '100%', fontSize: 11 } },
        React.createElement('summary', { style: { cursor: 'pointer', color: T.muted } },
          `曲线 / 关键帧缩略图${chart ? '' : '（这个 run 没有逐帧数据）'}`),
        React.createElement(RunKeyframeStrip, {
          runId: props.runId, keyframes, activeIndex: selectedKf >= 0 ? selectedKf : undefined,
          onPick: goKeyframe, compact: true,
        }),
        chart ? React.createElement(RunChart, { data: chart, timeSec: t, onSeek: seekTime, height: 96 }) : null),
      // legend doubles as visibility toggles: hide a part to see the joint/clearance inside
      compact ? null : React.createElement('div', { key: 'legend', style: { display: 'flex', gap: 8, flexWrap: 'wrap', width: '100%' } },
        ...traj.trajectory.parts.map((p, i) => {
          const hidden = hiddenParts.has(p.name);
          return React.createElement('button', {
            key: p.name, type: 'button', title: hidden ? '点击显示这个零件' : '点击隐藏这个零件',
            onClick: () => togglePart(p.name),
            style: {
              fontSize: 11, color: T.soft, border: 0, background: 'transparent', cursor: 'pointer',
              padding: 0, opacity: hidden ? 0.35 : 1,
            },
          },
          React.createElement('span', {
            style: {
              display: 'inline-block', width: 8, height: 8, borderRadius: 4, marginRight: 3, verticalAlign: 'middle',
              background: p.bodyType === 'fixed' ? '#9aa5b1' : PART_COLORS[i % PART_COLORS.length]!,
              opacity: p.bodyType === 'fixed' ? 0.6 : 1,
            },
          }),
          p.name);
        }),
      ),
    ],
  });
}

// ---------------------------------------------------------------- fluid playback

interface FluidManifest {
  particleCount0: number;
  dxMm: number;
  boundsMm: { min: number[]; max: number[] };
  vmaxMmPerSec: number;
  frames: { step: number; timeSec: number; particles: number; file: string }[];
}

export function FluidPlaybackView(props: {
  /** The run this playback belongs to — every artifact is addressed by run id. */
  runId: string;
  /** The run's own report; drives the key-number strip. */
  report?: unknown;
  /** The run's verdict (pass/check/fail) for the badge. */
  status?: string;
  /** Ground colour (hex); the caller owns the choice — see lighting.ts. */
  background?: string;
  onScreenshot?: (canvas: HTMLCanvasElement, label: string, frame?: ShotFrame) => void;
}): React.ReactElement {
  const [manifest, setManifest] = useState<FluidManifest | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [frameIdx, setFrameIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [loading, setLoading] = useState(false);
  const [pointsReady, setPointsReady] = useState(0);
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneHandle | null>(null);
  useGround(sceneRef, props.background);
  const pointsRef = useRef<THREE.Points | null>(null);
  const cacheRef = useRef<Map<number, { pos: Float32Array; speed: Float32Array }>>(new Map());

  useEffect(() => {
    let dead = false;
    setManifest(null);
    setErr(null);
    setFrameIdx(0);
    cacheRef.current.clear();
    void (async () => {
      try {
        const res = await fetch(withProject(`/api/cad/run/fluid-manifest?id=${encodeURIComponent(props.runId)}`));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as FluidManifest;
        if (dead) return;
        if (data.frames.length > 0) setManifest(data);
        else setErr('这次运行没有流体帧');
      } catch {
        if (!dead) setErr('这次运行没有流体帧');
      }
    })();
    return () => { dead = true; };
  }, [props.runId]);

  // scene: transparent wall + points cloud (allocated once at max count)
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !manifest) return;
    const handle = createScene(mount, props.background);
    if (!handle) { setErr('此环境无法创建 WebGL 上下文 — 回放不可用'); return; }
    sceneRef.current = handle;
    let dead = false;

    void (async () => {
      const { min, max } = manifest.boundsMm;
      const center = new THREE.Vector3(
        (min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2);
      const radius = 0.5 * Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!);
      handle.fit(center, radius);

      try {
        const res = await fetch(withProject(`/api/cad/run/stl?id=${encodeURIComponent(props.runId)}&part=wall`));
        if (res.ok) {
          const geo = new STLLoader().parse(await res.arrayBuffer());
          const wall = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
            color: '#7a8aa0', metalness: 0, roughness: 0.9,
            transparent: true, opacity: 0.16, depthWrite: false,
          }));
          handle.scene.add(wall);
        }
      } catch { /* wall optional */ }
      if (dead) return;

      const maxN = Math.max(...manifest.frames.map((f) => f.particles));
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxN * 3), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(maxN * 3), 3));
      geo.setDrawRange(0, 0);
      const points = new THREE.Points(geo, new THREE.PointsMaterial({
        size: manifest.dxMm * 0.7, vertexColors: true, sizeAttenuation: true,
      }));
      points.frustumCulled = false;
      handle.scene.add(points);
      pointsRef.current = points;
      setPointsReady((v) => v + 1);
    })();

    return () => {
      dead = true;
      pointsRef.current = null;
      cacheRef.current.clear();
      handle.dispose();
      sceneRef.current = null;
    };
  }, [manifest]);

  const applyFrame = (i: number) => {
    const m = manifest;
    const points = pointsRef.current;
    if (!m || !points) return;
    const entry = m.frames[Math.min(i, m.frames.length - 1)];
    if (!entry) return;
    const cached = cacheRef.current.get(i);
    if (cached) {
      const geo = points.geometry;
      const pa = geo.getAttribute('position') as THREE.BufferAttribute;
      (pa.array as Float32Array).set(cached.pos);
      pa.needsUpdate = true;
      geo.setDrawRange(0, entry.particles);
      const ca = geo.getAttribute('color') as THREE.BufferAttribute;
      const arr = ca.array as Float32Array;
      for (let k = 0; k < entry.particles; k++) {
        const [r, g, b] = speedColor(cached.speed[k]! / m.vmaxMmPerSec);
        arr[3 * k] = r; arr[3 * k + 1] = g; arr[3 * k + 2] = b;
      }
      ca.needsUpdate = true;
      return;
    }
    void (async () => {
      setLoading(true);
      try {
        const res = await fetch(withProject(`/api/cad/run/frame?id=${encodeURIComponent(props.runId)}&i=${i}`));
        if (!res.ok) return;
        const buf = new Float32Array(await res.arrayBuffer());
        const n = entry.particles;
        const data = { pos: buf.slice(0, 3 * n), speed: buf.slice(3 * n, 4 * n) };
        cacheRef.current.set(i, data);
        const geo = points.geometry;
        const pa = geo.getAttribute('position') as THREE.BufferAttribute;
        (pa.array as Float32Array).set(data.pos);
        pa.needsUpdate = true;
        geo.setDrawRange(0, n);
        const ca = geo.getAttribute('color') as THREE.BufferAttribute;
        const arr = ca.array as Float32Array;
        for (let k = 0; k < n; k++) {
          const [r, g, b] = speedColor(data.speed[k]! / m.vmaxMmPerSec);
          arr[3 * k] = r; arr[3 * k + 1] = g; arr[3 * k + 2] = b;
        }
        ca.needsUpdate = true;
        // prefetch the next frame so playback stays smooth
        const next = (i + 1) % m.frames.length;
        if (!cacheRef.current.has(next)) {
          void fetch(withProject(`/api/cad/run/frame?id=${encodeURIComponent(props.runId)}&i=${next}`)).then((r2) => {
            if (!r2.ok) return;
            return r2.arrayBuffer().then((ab) => {
              const b2 = new Float32Array(ab);
              const n2 = m.frames[next]!.particles;
              cacheRef.current.set(next, { pos: b2.slice(0, 3 * n2), speed: b2.slice(3 * n2, 4 * n2) });
            });
          });
        }
      } finally {
        setLoading(false);
      }
    })();
  };

  useEffect(() => { applyFrame(frameIdx); }, [frameIdx, manifest, pointsReady]);

  useEffect(() => {
    if (!playing || !manifest) return;
    const n = manifest.frames.length;
    const iv = setInterval(() => setFrameIdx((i) => (i + 1) % n), Math.max(16, 33 / speed));
    return () => clearInterval(iv);
  }, [playing, speed, manifest]);

  if (err) {
    return React.createElement('div', { style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888', fontSize: 13 } }, err);
  }
  if (!manifest) {
    return React.createElement('div', { style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888', fontSize: 13 } }, '加载流体帧…');
  }

  const entry = manifest.frames[Math.min(frameIdx, manifest.frames.length - 1)]!;
  const fluidFacts = runFacts('fluid', props.report, props.status);

  return React.createElement(PlaybackFrame, {
    mountRef,
    data: fluidFacts ? React.createElement(RunDataStrip, {
      facts: fluidFacts,
      onSeek: (timeSec: number) => {
        let best = 0;
        let bestDelta = Infinity;
        manifest.frames.forEach((f, i) => {
          const d = Math.abs(f.timeSec - timeSec);
          if (d < bestDelta) { bestDelta = d; best = i; }
        });
        setPlaying(false);
        setFrameIdx(best);
      },
    }) : null,
    getScene: () => (sceneRef.current
      ? { camera: sceneRef.current.camera, focus: sceneRef.current.controls.target }
      : null),
    onReset: () => sceneRef.current?.refit(),
    controls: [
      React.createElement('button', { key: 'play', onClick: () => setPlaying((p) => !p), style: btn(playing, '#2c81ba') },
        playing ? '⏸ 暂停' : '▶ 播放'),
      React.createElement('input', {
        key: 'seek', type: 'range', min: 0, max: Math.max(0, manifest.frames.length - 1), value: Math.min(frameIdx, manifest.frames.length - 1),
        onChange: (e: any) => { setPlaying(false); setFrameIdx(Number(e.target.value)); },
        style: { flex: 1, minWidth: 120 },
      }),
      React.createElement('span', { key: 'time', style: { fontSize: 11, color: '#555', minWidth: 110, textAlign: 'right' } },
        `t=${entry.timeSec}s · ${entry.particles} 粒`),
      React.createElement('select', {
        key: 'speed', value: speed, onChange: (e: any) => setSpeed(Number(e.target.value)),
        style: { fontSize: 11, padding: '2px 4px' },
      }, [0.25, 0.5, 1, 2].map((s) => React.createElement('option', { key: s, value: s }, `${s}×`))),
      loading && React.createElement('span', { key: 'ld', style: { fontSize: 11, color: '#b8860b' } }, '加载帧…'),
      React.createElement('span', { key: 'legend', style: { fontSize: 11, color: '#666' } },
        '速度 ', React.createElement('span', { style: { color: '#3457d5', fontWeight: 700 } }, '■'),
        '→', React.createElement('span', { style: { color: '#e5261a', fontWeight: 700 } }, '■'),
        ` 0…${manifest.vmaxMmPerSec.toFixed(0)}mm/s`),
      props.onScreenshot && sceneRef.current
        ? React.createElement('button', {
            key: 'shot',
            onClick: () => props.onScreenshot?.(sceneRef.current!.renderer.domElement, `流体回放 t=${entry.timeSec}s`,
              { index: frameIdx + 1, total: manifest.frames.length, timeSec: entry.timeSec,
                stepSec: manifest.frames.length > 1 ? manifest.frames[1]!.timeSec - manifest.frames[0]!.timeSec : 0 }),
            style: btn(false),
          }, '📸')
        : null,
    ],
  });
}

// ------------------------------------------------------- static assembly view

/**
 * An assembly run's parts, placed exactly as `validate_assembly` saw them.
 * No timeline: an assembly gap check is a still product.
 */
export function StaticPartsView(props: {
  runId: string;
  parts: string[];
  placements?: Record<string, { translate?: number[]; rotate?: number[] }>;
  /** Ground colour (hex); the caller owns the choice — see lighting.ts. */
  background?: string;
  onScreenshot?: (canvas: HTMLCanvasElement, label: string, frame?: ShotFrame) => void;
}): React.ReactElement {
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(0);
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneHandle | null>(null);
  useGround(sceneRef, props.background);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const handle = createScene(mount, props.background);
    if (!handle) { setErr('此环境无法创建 WebGL 上下文 — 回放不可用'); return; }
    sceneRef.current = handle;
    let dead = false;

    void (async () => {
      const box = new THREE.Box3();
      let loaded = 0;
      for (let i = 0; i < props.parts.length; i++) {
        const name = props.parts[i]!;
        try {
          const res = await fetch(withProject(`/api/cad/run/stl?id=${encodeURIComponent(props.runId)}&part=${encodeURIComponent(name)}`));
          if (!res.ok) continue;
          const geo = new STLLoader().parse(await res.arrayBuffer());
          if (dead) return;
          const material = new THREE.MeshStandardMaterial({
            color: PART_COLORS[i % PART_COLORS.length]!,
            metalness: 0.1, roughness: 0.6,
            transparent: true, opacity: 0.92,
          });
          const mesh = new THREE.Mesh(geo, material);
          // Same convention as the host's Manifold path (R = Rz·Ry·Rx), then
          // translate. NOT three's default Euler order — see placement.ts.
          const place = props.placements?.[name];
          if (place?.rotate) mesh.rotation.copy(placementEuler(place.rotate));
          if (place?.translate) {
            mesh.position.set(place.translate[0] ?? 0, place.translate[1] ?? 0, place.translate[2] ?? 0);
          }
          mesh.updateMatrixWorld(true);
          handle.scene.add(mesh);
          box.expandByObject(mesh);
          loaded++;
        } catch { /* skip a part that failed to load */ }
      }
      if (dead) return;
      if (loaded === 0) setErr('这次运行的几何体读取失败');
      else {
        const center = new THREE.Vector3();
        box.getCenter(center);
        const radius = box.getSize(new THREE.Vector3()).length() / 2;
        handle.fit(center, radius);
      }
      setReady((v) => v + 1);
    })();

    return () => {
      dead = true;
      handle.dispose();
      sceneRef.current = null;
    };
  }, [props.runId, props.parts.join(','), ready === 0 ? 0 : 1]);

  return React.createElement(PlaybackFrame, {
    mountRef,
    getScene: () => (sceneRef.current
      ? { camera: sceneRef.current.camera, focus: sceneRef.current.controls.target }
      : null),
    onReset: () => sceneRef.current?.refit(),
    controls: [
      React.createElement('span', { key: 'label', style: { fontSize: 11, color: '#555' } },
        `装配静置视图 · ${props.parts.length} 零件`),
      err && React.createElement('span', { key: 'err', style: { fontSize: 11, color: '#c0392b' } }, err),
      props.onScreenshot && sceneRef.current
        ? React.createElement('button', {
            key: 'shot',
            onClick: () => props.onScreenshot?.(sceneRef.current!.renderer.domElement, '装配静置视图'),
            style: btn(false),
          }, '📸')
        : null,
    ],
  });
}
