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

// ---------------------------------------------------------------- scene plumbing

interface SceneHandle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  fit: (center: THREE.Vector3, radius: number) => void;
  /** Re-apply the last fit (the "复原视图" control). */
  refit: () => void;
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

  return {
    renderer,
    scene,
    camera,
    controls,
    fit,
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
  /** Live scene for the corner overlays (triad + scale bar + reset). */
  getScene?: () => OverlayScene | null;
  onReset?: () => void;
}> = ({ mountRef, controls, getScene, onReset }) =>
  React.createElement(
    'div',
    { style: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' } },
    React.createElement(
      'div',
      { style: { flex: 1, position: 'relative', minHeight: 0 } },
      React.createElement('div', { ref: mountRef, style: { position: 'absolute', inset: 0 } }),
      getScene && React.createElement(ViewportOverlay, { getScene, onReset }),
    ),
    React.createElement(
      'div',
      { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', paddingTop: 6 } },
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

const PART_COLORS = ['#4a7dbd', '#c0392b', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c'];

export function MotionPlaybackView(props: {
  /** The run this playback belongs to — every artifact is addressed by run id. */
  runId: string;
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
      }
      setMeshesVersion((v) => v + 1);
    })();

    return () => {
      dead = true;
      meshesRef.current = [];
      handle.dispose();
      sceneRef.current = null;
    };
  }, [traj]);

  const nFrames = traj?.trajectory.times.length ?? 0;
  const tMax = traj?.trajectory.times[nFrames - 1] ?? 1;

  // apply the current frame's poses to the meshes
  useEffect(() => {
    if (!traj) return;
    for (const part of traj.trajectory.parts) {
      const entry = meshesRef.current.find((x) => x.name === part.name);
      const f = part.frames[Math.min(frameIdx, part.frames.length - 1)];
      if (!entry || !f) continue;
      entry.mesh.position.set(f[0]!, f[1]!, f[2]!);
      entry.mesh.quaternion.set(f[3]!, f[4]!, f![5]!, f[6]!);
    }
  }, [traj, frameIdx, meshesVersion]);

  // playback clock
  useEffect(() => {
    if (!playing || nFrames === 0) return;
    const iv = setInterval(() => setFrameIdx((i) => (i + 1) % nFrames), Math.max(16, 33 / speed));
    return () => clearInterval(iv);
  }, [playing, speed, nFrames]);

  if (err) {
    return React.createElement('div', { style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888', fontSize: 13 } }, err);
  }
  if (!traj) {
    return React.createElement('div', { style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888', fontSize: 13 } }, '加载轨迹…');
  }

  const t = traj.trajectory.times[Math.min(frameIdx, nFrames - 1)] ?? 0;
  const isMotion = traj.kind === 'motion';

  return React.createElement(PlaybackFrame, {
    mountRef,
    getScene: () => (sceneRef.current
      ? { camera: sceneRef.current.camera, focus: sceneRef.current.controls.target }
      : null),
    onReset: () => sceneRef.current?.refit(),
    controls: [
      React.createElement('button', { key: 'play', onClick: () => setPlaying((p) => !p), style: btn(playing) },
        playing ? '⏸ 暂停' : '▶ 播放'),
      React.createElement('input', {
        key: 'seek', type: 'range', min: 0, max: Math.max(0, nFrames - 1), value: Math.min(frameIdx, nFrames - 1),
        onChange: (e: any) => { setPlaying(false); setFrameIdx(Number(e.target.value)); },
        style: { flex: 1, minWidth: 120 },
      }),
      React.createElement('span', { key: 'time', style: { fontSize: 11, color: '#555', minWidth: 96, textAlign: 'right' } },
        `t=${t.toFixed(2)}s · ${frameIdx + 1}/${nFrames}`),
      React.createElement('select', {
        key: 'speed', value: speed, onChange: (e: any) => setSpeed(Number(e.target.value)),
        style: { fontSize: 11, padding: '2px 4px' },
      }, [0.25, 0.5, 1, 2, 4].map((s) => React.createElement('option', { key: s, value: s }, `${s}×`))),
      props.onScreenshot && sceneRef.current
        ? React.createElement('button', {
            key: 'shot',
            onClick: () => props.onScreenshot?.(sceneRef.current!.renderer.domElement,
              `${isMotion ? '机构' : '物理'}回放 t=${t.toFixed(2)}s`,
              // The caption needs the exact frame, not just the rounded t it
              // prints: the frame index is what survives a same-t collision.
              { index: frameIdx + 1, total: nFrames, timeSec: t, events: traj.trajectory.events,
                stepSec: nFrames > 1 ? traj.trajectory.times[1]! - traj.trajectory.times[0]! : 0 }),
            style: btn(false),
          }, '📸')
        : null,
      // event ticks under the slider + part legend
      React.createElement('div', { key: 'legend', style: { display: 'flex', gap: 8, flexWrap: 'wrap', width: '100%' } },
        React.createElement('div', { key: 'ticks', style: { position: 'relative', flex: 1, minWidth: 160, height: 14 } },
          traj.trajectory.events.map((ev, i) => React.createElement('div', {
            key: i,
            title: `${ev.label} (t=${ev.timeSec}s)`,
            style: {
              position: 'absolute', top: 2, width: 4, height: 10, borderRadius: 1,
              left: `${Math.min(100, (ev.timeSec / (tMax || 1)) * 100)}%`,
              background: /干涉|接触|倾倒|穿透/.test(ev.label) ? '#e74c3c' : '#4a7dbd',
            },
          })),
        ),
        ...traj.trajectory.parts.map((p, i) => React.createElement('span', { key: p.name, style: { fontSize: 11, color: '#666' } },
          React.createElement('span', {
            style: {
              display: 'inline-block', width: 8, height: 8, borderRadius: 4, marginRight: 3, verticalAlign: 'middle',
              background: p.bodyType === 'fixed' ? '#9aa5b1' : PART_COLORS[i % PART_COLORS.length]!,
              opacity: p.bodyType === 'fixed' ? 0.6 : 1,
            },
          }),
          p.name)),
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

  return React.createElement(PlaybackFrame, {
    mountRef,
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
