/**
 * Export the playback view as an animation — "what you see", not a re-render.
 *
 * The panel owns the scene, the camera and the trajectory, so the export reuses
 * them: the same camera you are looking at, the same frames you are scrubbing.
 * That is the whole point of doing it in the client (and why this is not a tool):
 * a host-side renderer would produce a different picture from a different angle,
 * and the reducer session showed what happens when the model is forced to invent
 * a channel — it wrote a GIF renderer by hand and showed the user something the
 * panel could not pause, scrub or annotate.
 *
 * Two formats, chosen by the caller: GIF (shareable everywhere, 256 colours, our
 * own encoder) and WebM (full colour, MediaRecorder, no dependency).
 */

import * as THREE from 'three';
import { encodeGif } from './gif-encoder';

export type AnimationFormat = 'gif' | 'webm';

export interface AnimationRequest {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  meshes: { name: string; mesh: THREE.Mesh }[];
  parts: { name: string; frames: number[][] }[];
  /** Output size in pixels (the aspect is taken from here, so what you framed is what you get). */
  width: number;
  height: number;
  fps: number;
  onProgress?: (done: number, total: number) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Apply one frame's poses to the meshes (the playback view's own convention). */
function applyFrame(meshes: { name: string; mesh: THREE.Mesh }[], parts: { name: string; frames: number[][] }[], idx: number): void {
  for (const part of parts) {
    const entry = meshes.find((m) => m.name === part.name);
    const f = part.frames[Math.min(idx, part.frames.length - 1)];
    if (!entry || !f) continue;
    entry.mesh.position.set(f[0]!, f[1]!, f[2]!);
    entry.mesh.quaternion.set(f[3]!, f[4]!, f[5]!, f[6]!);
  }
}

/** Render every trajectory frame at a fixed size and hand back RGBA pixels. */
export async function captureFrames(req: AnimationRequest): Promise<Uint8ClampedArray[]> {
  const { renderer, scene, camera, meshes, parts } = req;
  const w = Math.max(2, Math.round(req.width));
  const h = Math.max(2, Math.round(req.height));
  const prevSize = renderer.getSize(new THREE.Vector2());
  const prevRatio = renderer.getPixelRatio();
  const prevAspect = camera.aspect;

  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('export: no 2D context');

  const frames: Uint8ClampedArray[] = [];
  const total = Math.max(...parts.map((p) => p.frames.length), 1);
  try {
    for (let i = 0; i < total; i++) {
      applyFrame(meshes, parts, i);
      renderer.render(scene, camera);
      ctx.drawImage(renderer.domElement, 0, 0, w, h);
      frames.push(ctx.getImageData(0, 0, w, h).data);
      req.onProgress?.(i + 1, total);
      // Yield every few frames: the progress label is a React state update, and a
      // purely synchronous loop would freeze it until the export finished.
      if (i % 8 === 0) await sleep(0);
    }
  } finally {
    renderer.setPixelRatio(prevRatio);
    renderer.setSize(prevSize.x, prevSize.y, false);
    camera.aspect = prevAspect;
    camera.updateProjectionMatrix();
  }
  return frames;
}

/** Frame-by-frame WebM via MediaRecorder; no dependency, plays in every browser. */
async function recordWebm(frames: Uint8ClampedArray[], w: number, h: number, fps: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('export: no 2D context');

  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
  if (!track || typeof track.requestFrame !== 'function') {
    throw new Error('export: this browser cannot record a canvas frame-by-frame');
  }
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error('export: MediaRecorder is not available');
  const chunks: BlobPart[] = [];
  const rec = new MediaRecorder(stream, { mimeType: mime });
  rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  const done = new Promise<void>((resolve) => { rec.onstop = () => resolve(); });
  rec.start();

  const img = ctx.createImageData(w, h);
  const delay = 1000 / Math.max(1, fps);
  for (const data of frames) {
    img.data.set(data);
    ctx.putImageData(img, 0, 0);
    track.requestFrame();
    await sleep(delay);
  }
  await sleep(delay);
  rec.stop();
  await done;
  return new Blob(chunks, { type: 'video/webm' });
}

/**
 * Render the run's whole trajectory and return the finished file.
 *
 * @returns the encoded bytes and a filename suggestion.
 */
export async function exportAnimation(
  req: AnimationRequest,
  format: AnimationFormat,
): Promise<{ blob: Blob; extension: string }> {
  const w = Math.max(2, Math.round(req.width));
  const h = Math.max(2, Math.round(req.height));
  const frames = await captureFrames({ ...req, width: w, height: h });
  if (frames.length === 0) throw new Error('export: the run has no frames');

  if (format === 'gif') {
    const bytes = encodeGif(frames.map((data) => ({ data })), w, h, Math.round(1000 / Math.max(1, req.fps)));
    // `.slice()` hands the Blob a plain ArrayBuffer-backed view (TS 5.7's
    // ArrayBufferLike/SharedArrayBuffer distinction otherwise rejects Uint8Array).
    return { blob: new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'image/gif' }), extension: 'gif' };
  }
  const blob = await recordWebm(frames, w, h, req.fps);
  return { blob, extension: 'webm' };
}

/** Hand a file to the browser's download flow. No host round-trip: this is a panel feature. */
export function downloadAnimation(blob: Blob, runId: string, extension: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${runId}-playback.${extension}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
