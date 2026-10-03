// M4: point-cloud PNG renderer for fluid snapshots — zero new dependencies
// (node:zlib, hand-built PNG chunks).
//
// Two orthographic views per image (iso + side): the pipe wall outline from
// STL vertices in grey, fluid particles coloured by speed (blue slow → red
// fast) with a z-buffer. Purpose: give the model a judgeable picture of
// "did it flow, did it stay in the pipe" without any GPU/X server dependency.

import { deflateSync } from 'node:zlib';

// ---------- minimal PNG encoder ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  // rows: filter byte 0 + RGBA
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
  }
  const idat = deflateSync(raw, { level: 6 });
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(idat)), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ---------- projection ----------
interface View {
  label: string;
  dir: [number, number, number];   // camera direction (towards scene), normalized
}

const ISO: View = { label: 'iso', dir: [1, -1, 0.6] };
const SIDE: View = { label: 'side', dir: [0, -1, 0] };

function basis(dir: [number, number, number]): { right: [number, number, number]; up: [number, number, number] } {
  const l = Math.hypot(dir[0], dir[1], dir[2]);
  const d: [number, number, number] = [dir[0] / l, dir[1] / l, dir[2] / l];
  // up: world z projected perpendicular to d
  let up: [number, number, number] = [0, 0, 1];
  const dot = up[0] * d[0] + up[1] * d[1] + up[2] * d[2];
  up = [up[0] - dot * d[0], up[1] - dot * d[1], up[2] - dot * d[2]];
  const ul = Math.hypot(up[0], up[1], up[2]) || 1;
  up = [up[0] / ul, up[1] / ul, up[2] / ul];
  const right: [number, number, number] = [
    up[1] * d[2] - up[2] * d[1],
    up[2] * d[0] - up[0] * d[2],
    up[0] * d[1] - up[1] * d[0],
  ];
  return { right, up };
}

function speedColor(t: number): [number, number, number] {
  const c = Math.min(1, Math.max(0, t));
  if (c < 0.5) {
    const k = c / 0.5;
    return [40 + k * 200, 90 + k * 110, 220 - k * 180];
  }
  const k = (c - 0.5) / 0.5;
  return [240 - k * 20, 200 - k * 150, 40 - k * 0];
}

export interface FluidRenderOptions {
  /** Scene bounds (mm): pipe bbox; also sets the projection scale. */
  boundsMm: { min: [number, number, number]; max: [number, number, number] };
  /** Pipe STL vertices (mm) — drawn as the grey wall outline. */
  wallVertsMm?: Float32Array;
  /** Max speed for colour mapping. Default: max observed. */
  vmaxMmPerSec?: number;
  width?: number;   // total image width (two viewports), default 1024
  height?: number;  // default 512
}

/**
 * Render one snapshot to a PNG (iso | side side-by-side).
 * Returns PNG bytes.
 */
export function renderFluidSnapshot(
  posMm: Float32Array,
  speedMmPerSec: Float32Array,
  opts: FluidRenderOptions,
): Uint8Array {
  const W = opts.width ?? 1024;
  const H = opts.height ?? 512;
  const vw = W >> 1;
  const rgba = new Uint8Array(W * H * 4).fill(255);
  const depth = new Float32Array(W * H).fill(Infinity);

  const { min, max } = opts.boundsMm;
  const center: [number, number, number] = [
    (min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2,
  ];
  const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
  const vmax = opts.vmaxMmPerSec ?? Math.max(1e-6, Math.max(...speedMmPerSec));

  const put = (view: View, vx0: number, x: number, y: number, z: number, color: [number, number, number], r: number) => {
    const { right, up } = basis(view.dir);
    const px = x - center[0], py = y - center[1], pz = z - center[2];
    const u = px * right[0] + py * right[1] + pz * right[2];
    const v = px * up[0] + py * up[1] + pz * up[2];
    const dep = px * view.dir[0] + py * view.dir[1] + pz * view.dir[2];
    const sx = Math.round(vx0 + vw / 2 + (u / extent) * vw * 0.92);
    const sy = Math.round(H / 2 - (v / extent) * H * 0.92);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const X = sx + dx, Y = sy + dy;
        if (X < vx0 || X >= vx0 + vw || Y < 0 || Y >= H) continue;
        const idx = Y * W + X;
        if (dep < depth[idx]!) {
          depth[idx] = dep;
          rgba[idx * 4] = color[0];
          rgba[idx * 4 + 1] = color[1];
          rgba[idx * 4 + 2] = color[2];
          rgba[idx * 4 + 3] = 255;
        }
      }
    }
  };

  // wall outline first (behind everything via depth)
  if (opts.wallVertsMm) {
    const wv = opts.wallVertsMm;
    for (let i = 0; i < wv.length; i += 3) {
      put(ISO, 0, wv[i]!, wv[i + 1]!, wv[i + 2]!, [150, 150, 158], 1);
      put(SIDE, vw, wv[i]!, wv[i + 1]!, wv[i + 2]!, [150, 150, 158], 1);
    }
  }

  // particles on top
  const n = speedMmPerSec.length;
  for (let p = 0; p < n; p++) {
    const x = posMm[p * 3]!, y = posMm[p * 3 + 1]!, z = posMm[p * 3 + 2]!;
    if (!Number.isFinite(x + y + z)) continue;
    const color = speedColor(speedMmPerSec[p]! / vmax);
    put(ISO, 0, x, y, z, color, 1);
    put(SIDE, vw, x, y, z, color, 1);
  }

  return encodePng(W, H, rgba);
}

/** Bounds helper from the SDF grid geometry. */
export function gridBounds(cells: [number, number, number], originMm: [number, number, number], dxMm: number): {
  min: [number, number, number]; max: [number, number, number];
} {
  return {
    min: originMm,
    max: [originMm[0] + cells[0] * dxMm, originMm[1] + cells[1] * dxMm, originMm[2] + cells[2] * dxMm],
  };
}
