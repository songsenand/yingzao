// Corner overlays for a 3D viewport: one instrument plate (coordinate triad over
// a fixed-length scale bar) bottom-left, a "reset view" control top-right, and
// optional DOM chips pinned to world points (probe read-outs — a WebGL canvas
// has no DOM inside it, so "a tooltip on the model" is a projected DOM element).
//
// Both are plain DOM driven from the live camera, deliberately NOT WebGL
// geometry: they must not be clipped by the model, they must stay crisp, and —
// practically — headless Firefox does not composite WebGL canvases into
// `--screenshot` captures, so a DOM overlay is the only version of this that can
// be verified in the sandbox harness.
import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';

export interface OverlayScene {
  camera: THREE.Camera;
  /** World point the camera orbits; the scale bar is measured at that depth. */
  focus?: THREE.Vector3;
}

/** Very light plate under both corners: the model behind them is arbitrary. */
const PLATE: React.CSSProperties = {
  background: 'rgba(255,255,255,0.55)',
  borderRadius: 7,
  backdropFilter: 'blur(1.5px)',
};

const AXES: { label: string; dir: [number, number, number]; color: string }[] = [
  { label: 'X', dir: [1, 0, 0], color: '#c0392b' },
  { label: 'Y', dir: [0, 1, 0], color: '#1e8449' },
  { label: 'Z', dir: [0, 0, 1], color: '#2471a3' },
];

/** Round millimetre lengths the bar may snap to (mm is the app's only unit). */
const NICE_MM = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];

/** Largest round length whose bar still fits the target pixel width. */
/** The scale bar never changes length; only its readout does. */
const SCALE_BAR_PX = 52;

/** A DOM chip pinned to a world point — the "tooltip on the model". */
export interface ViewportLabel {
  key: string;
  text: string;
  world: [number, number, number];
  color: string;
}

export function ViewportOverlay(props: {
  /** Resolved every frame; return null while the scene is not ready. */
  getScene: () => OverlayScene | null;
  onReset?: () => void;
  labels?: ViewportLabel[];
  /**
   * Ink for the scale bar and its readout. DOM over a canvas, so it must follow
   * the ground the caller chose — the default dark ink vanishes on a dark one.
   */
  ink?: { color: string; halo: string };
  /**
   * Extra viewport chrome the caller renders in this overlay's coordinate space
   * (the ground picker sits directly under the 复原 button, so the two read as
   * one control group). Positioned by the caller; pointer events are its own.
   */
  chrome?: React.ReactNode;
}): React.ReactElement {
  const ink = props.ink ?? { color: '#26303a', halo: '#f0f0f0' };
  const rootRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(SVGLineElement | null)[]>([]);
  const labelRefs = useRef<(SVGTextElement | null)[]>([]);
  const barRef = useRef<HTMLDivElement>(null);
  // NB: `labelRefs` above is the triad's SVG <text> elements; these are the
  // pinned DOM chips. Read the specs through a ref (callers pass a fresh array).
  const chipRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const chipSpecs = useRef<ViewportLabel[]>(props.labels ?? []);
  chipSpecs.current = props.labels ?? [];
  const textRef = useRef<HTMLDivElement>(null);
  // Keep the getter out of the effect deps: callers pass an inline arrow.
  const getRef = useRef(props.getScene);
  getRef.current = props.getScene;
  const resetRef = useRef(props.onReset);
  resetRef.current = props.onReset;

  useEffect(() => {
    // Arms are length-scaled by the axis's own foreshortening, so an axis
    // pointing at the viewer shrinks to a stub — that is the depth cue.
    const CX = 33, CY = 33, ARM = 26, ARM_MIN = 8;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const root = rootRef.current;
      const scene = getRef.current();
      if (!root) return;
      if (!scene) { root.style.visibility = 'hidden'; return; }
      root.style.visibility = '';

      const cam = scene.camera as THREE.PerspectiveCamera & {
        top?: number; bottom?: number; isOrthographicCamera?: boolean;
      };
      const e = cam.matrixWorld.elements;
      // Camera basis in world space (columns of matrixWorld).
      const right = [e[0]!, e[4]!, e[8]!];
      const up = [e[1]!, e[5]!, e[9]!];
      const back = [e[2]!, e[6]!, e[10]!];       // +Z of the camera = away from the eye
      const eye = [e[12]!, e[13]!, e[14]!];

      // --- coordinate triad: project each world axis onto the screen ---
      for (let i = 0; i < AXES.length; i++) {
        const a = AXES[i]!;
        const [ax, ay, az] = a.dir;
        const sx = ax * right[0]! + ay * right[1]! + az * right[2]!;
        const sy = -(ax * up[0]! + ay * up[1]! + az * up[2]!);
        const len = Math.hypot(sx, sy) || 1e-6;
        const arm = Math.max(ARM_MIN, len * ARM);
        const depth = ax * back[0]! + ay * back[1]! + az * back[2]!;  // >0 = pointing away
        const x2 = CX + (sx / len) * arm;
        const y2 = CY + (sy / len) * arm;
        const line = lineRefs.current[i];
        if (line) {
          line.setAttribute('x1', String(CX));
          line.setAttribute('y1', String(CY));
          line.setAttribute('x2', x2.toFixed(1));
          line.setAttribute('y2', y2.toFixed(1));
          line.setAttribute('opacity', depth > 0.15 ? '0.45' : '1');
        }
        const label = labelRefs.current[i];
        if (label) {
          label.setAttribute('x', (CX + (sx / len) * (arm + 7)).toFixed(1));
          label.setAttribute('y', (CY + (sy / len) * (arm + 7)).toFixed(1));
          label.setAttribute('opacity', depth > 0.15 ? '0.45' : '1');
        }
      }

      // --- labels pinned to world points (the probe read-outs) ---
      // A WebGL canvas has no DOM inside it, so "a tooltip on the model" is a DOM
      // chip positioned here, by projecting the world point with the live camera
      // every frame — the same trick the triad and scale bar use, which is why
      // the text stays crisp and can be asserted from the DOM.
      const chipW = root.clientWidth;
      const chipH = root.clientHeight;
      for (const [key, el] of chipRefs.current) {
        if (!el) continue;
        const spec = chipSpecs.current.find((l) => l.key === key);
        if (!spec || chipW === 0 || chipH === 0) { el.style.display = 'none'; continue; }
        const v = new THREE.Vector3(spec.world[0], spec.world[1], spec.world[2]).project(cam);
        if (!Number.isFinite(v.x) || v.z > 1) { el.style.display = 'none'; continue; }
        el.style.display = '';
        el.style.left = `${((v.x * 0.5 + 0.5) * chipW).toFixed(1)}px`;
        el.style.top = `${((-v.y * 0.5 + 0.5) * chipH).toFixed(1)}px`;
      }

      // --- scale bar: pixels per millimetre at the orbit focus depth ---
      const hostH = root.parentElement?.clientHeight ?? 0;
      let pxPerMm = 0;
      if (hostH > 0) {
        if (cam.isOrthographicCamera || cam.top !== undefined) {
          const span = Math.abs((cam.top ?? 1) - (cam.bottom ?? -1));
          if (span > 0) pxPerMm = hostH / span;
        } else if (cam.fov) {
          const focus = scene.focus;
          const dist = focus
            ? Math.hypot(eye[0]! - focus.x, eye[1]! - focus.y, eye[2]! - focus.z)
            : Math.hypot(eye[0]!, eye[1]!, eye[2]!);
          const worldPerPx = (2 * Math.max(dist, 1e-6) * Math.tan((cam.fov * Math.PI) / 360)) / hostH;
          if (worldPerPx > 0) pxPerMm = 1 / worldPerPx;
        }
      }
      if (pxPerMm > 0 && Number.isFinite(pxPerMm)) {
        // Fixed bar, moving number (the user asked for exactly this): the bar is
        // always SCALE_BAR_PX long and the label states what that length is worth
        // in millimetres, two decimals.
        const label = `${(SCALE_BAR_PX / pxPerMm).toFixed(2)} mm`;
        if (textRef.current && textRef.current.textContent !== label) textRef.current.textContent = label;
        // Debug hooks: the sandbox probe reads these to prove the scale tracks
        // the camera (a screenshot alone cannot show that it re-ranged).
        const ppm = pxPerMm.toFixed(3);
        if (root.dataset.scale !== label) root.dataset.scale = label;
        if (root.dataset.ppm !== ppm) root.dataset.ppm = ppm;
      }
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, []);

  return React.createElement(
    'div',
    {
      ref: rootRef,
      // Above the canvas, below the annotation/measure capture layer (z-index 4/5).
      style: { position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 3, visibility: 'hidden' },
    },

    // Triad + scale bar in ONE plate, bottom-left. They answer the two halves of
    // the same question ("which way is up" / "how big is this"), so they read as
    // one instrument rather than two corner decorations.
    React.createElement(
      'div',
      {
        // data-corner is a debug hook (like data-scale/data-ppm): it lets the
        // sandbox probe measure THIS plate instead of guessing at the DOM.
        'data-corner': 'triad+scale',
        style: {
          position: 'absolute', left: 6, bottom: 6, padding: '5px 9px 4px',
          // Stacked (triad on top, scale below): at a flattened 4:3 viewport the
          // side-by-side plate was as wide as a third of the viewport.
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
          ...PLATE, overflow: 'hidden',
        },
      },
      React.createElement(
        'svg',
        {
          // 6 units of margin on every side of the 66-unit drawing: the axis
          // letters sit at arm+7 (=33 from centre), i.e. exactly on the old edge,
          // so they spilled outside the plate. The padding is inside the viewBox,
          // so nothing can stick out and the arms keep their full length.
          width: 56, height: 56, viewBox: '-6 -6 78 78',
          style: { display: 'block' },
        },
        React.createElement('circle', {
          cx: 33, cy: 33, r: 2.4, fill: '#6b7280', opacity: 0.85,
        }),
        ...AXES.map((a, i) => React.createElement('line', {
          key: `l${a.label}`,
          ref: (el: SVGLineElement | null) => { lineRefs.current[i] = el; },
          x1: 33, y1: 33, x2: 33, y2: 33,
          stroke: a.color, strokeWidth: 2, strokeLinecap: 'round',
        })),
        ...AXES.map((a, i) => React.createElement('text', {
          key: `t${a.label}`,
          ref: (el: SVGTextElement | null) => { labelRefs.current[i] = el; },
          x: 33, y: 33,
          fill: a.color, fontSize: 10, fontWeight: 700,
          textAnchor: 'middle', dominantBaseline: 'middle',
          style: { paintOrder: 'stroke', stroke: '#f0f0f0', strokeWidth: 2.5 },
        }, a.label)),
      ),
      React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 } },
        React.createElement('div', {
          ref: barRef,
          style: {
            width: SCALE_BAR_PX, height: 6,
            borderLeft: `2px solid ${ink.color}`, borderRight: `2px solid ${ink.color}`,
            borderBottom: `2px solid ${ink.color}`,
          },
        }),
        React.createElement('div', {
          ref: textRef,
          style: {
            fontSize: 10, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            color: ink.color, textShadow: `0 0 3px ${ink.halo}, 0 0 3px ${ink.halo}`,
          },
        }, '—'),
      ),
    ),

    // probe read-out chips, pinned to their world points
    ...(props.labels ?? []).map((l) => React.createElement('div', {
      key: l.key,
      ref: (el: HTMLDivElement | null) => { chipRefs.current.set(l.key, el); },
      'data-label': l.key,
      style: {
        position: 'absolute', left: 0, top: 0, display: 'none',
        transform: 'translate(-50%, -155%)',
        padding: '1px 5px', borderRadius: 4, fontSize: 11, lineHeight: '15px', whiteSpace: 'nowrap',
        fontWeight: 600, background: 'rgba(255,255,255,0.93)',
        border: `1px solid ${l.color}`, color: l.color, pointerEvents: 'none',
      },
    }, l.text)),

    // reset view — top-right (the one clickable element in this layer)
    props.onReset
      ? React.createElement('button', {
        type: 'button',
        title: '复原视图：回到默认取景',
        onClick: () => resetRef.current?.(),
        style: {
          position: 'absolute', right: 8, top: 8, pointerEvents: 'auto',
          cursor: 'pointer', borderRadius: 6, padding: '2px 7px',
          fontSize: 11, lineHeight: '16px',
          border: '1px solid #d5d9dd', background: 'rgba(255,255,255,0.86)', color: '#26303a',
        },
      }, '⤾ 复原')
      : null,

    // caller-supplied chrome (the ground picker)
    props.chrome ?? null,
  );
}
