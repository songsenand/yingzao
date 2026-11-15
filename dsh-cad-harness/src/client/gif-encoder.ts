/**
 * Minimal GIF89a encoder — no dependency, no worker, ~150 lines.
 *
 * WHY hand-rolled: the panel already owns the scene, the camera and the
 * trajectory, so the only missing piece for "export what you see" is a byte
 * encoder. A GIF library would be a new runtime dependency (and a NOTICE entry)
 * for one screen. The palette is fixed and dithered instead of adaptive, which
 * keeps the encoder deterministic: the same frames always produce the same
 * bytes, so an acceptance can hash the output.
 *
 * What this is NOT: a general-purpose image library. It takes RGBA frames of one
 * size, quantises to a 6×7×6 web-ish palette with a 2×2 ordered dither, and
 * writes a looping animation.
 */

/** 6×7×6 = 252 colours: more green steps, because most shaded models are grey-green. */
const R_LEVELS = 6;
const G_LEVELS = 7;
const B_LEVELS = 6;

function buildPalette(): Uint8Array {
  const table = new Uint8Array(256 * 3);
  for (let r = 0; r < R_LEVELS; r++) {
    for (let g = 0; g < G_LEVELS; g++) {
      for (let b = 0; b < B_LEVELS; b++) {
        const i = r * G_LEVELS * B_LEVELS + g * B_LEVELS + b;
        table[i * 3] = Math.round((r * 255) / (R_LEVELS - 1));
        table[i * 3 + 1] = Math.round((g * 255) / (G_LEVELS - 1));
        table[i * 3 + 2] = Math.round((b * 255) / (B_LEVELS - 1));
      }
    }
  }
  return table;
}

const PALETTE = buildPalette();
const TWO_BY_TWO = [[-0.25, 0.25], [0.25, -0.25]];

/** RGBA → palette indices with a 2×2 ordered dither (cheap, and it kills banding on gradients). */
export function quantize(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const d = TWO_BY_TWO[y & 1]![x & 1]!;
      const r = Math.min(R_LEVELS - 1, Math.max(0, Math.round((rgba[p]! * (R_LEVELS - 1)) / 255 + d)));
      const g = Math.min(G_LEVELS - 1, Math.max(0, Math.round((rgba[p + 1]! * (G_LEVELS - 1)) / 255 + d)));
      const b = Math.min(B_LEVELS - 1, Math.max(0, Math.round((rgba[p + 2]! * (B_LEVELS - 1)) / 255 + d)));
      out[y * width + x] = r * G_LEVELS * B_LEVELS + g * B_LEVELS + b;
    }
  }
  return out;
}

/** Standard GIF LZW: variable-width codes, clear/EOI, 4096-entry reset. */
function lzwEncode(indices: Uint8Array, minCodeSize: number): number[] {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let dict = new Map<number, number>();
  let next = eoi + 1;
  let size = minCodeSize + 1;
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  const emit = (code: number) => {
    acc |= code << bits;
    bits += size;
    while (bits >= 8) {
      out.push(acc & 0xff);
      acc >>= 8;
      bits -= 8;
    }
  };

  emit(clear);
  if (indices.length === 0) {
    emit(eoi);
  } else {
    let prefix = indices[0]!;
    for (let i = 1; i < indices.length; i++) {
      const c = indices[i]!;
      const key = (prefix << 8) | c;
      const known = dict.get(key);
      if (known !== undefined) {
        prefix = known;
        continue;
      }
      emit(prefix);
      if (next < 4096) {
        dict.set(key, next++);
        if (next - 1 === (1 << size) && size < 12) size++;
      } else {
        emit(clear);
        dict = new Map();
        next = eoi + 1;
        size = minCodeSize + 1;
      }
      prefix = c;
    }
    emit(prefix);
    emit(eoi);
  }
  if (bits > 0) out.push(acc & 0xff);
  return out;
}

function pushSubBlocks(out: number[], data: number[]): void {
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
}

function u16(out: number[], value: number): void {
  out.push(value & 0xff, (value >> 8) & 0xff);
}

export interface GifFrame {
  /** RGBA, width*height*4. */
  data: Uint8ClampedArray;
}

/**
 * Build a looping GIF89a.
 *
 * @param frames RGBA frames, all the same size.
 * @param delayMs per-frame delay; below 20ms browsers clamp anyway, so it is floored at 20.
 */
export function encodeGif(frames: GifFrame[], width: number, height: number, delayMs = 66): Uint8Array {
  if (frames.length === 0) throw new Error('encodeGif: no frames');
  const delay = Math.max(2, Math.round(delayMs / 10)); // GIF stores centiseconds
  const out: number[] = [];

  // header + logical screen descriptor + global colour table
  out.push(...[...'GIF89a'].map((c) => c.charCodeAt(0)));
  u16(out, width);
  u16(out, height);
  out.push(0xf7, 0, 0); // GCT present, 256 entries, 8-bit colour resolution
  out.push(...PALETTE);
  // Netscape 2.0 loop extension: 0 = forever
  out.push(0x21, 0xff, 0x0b, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 0x03, 0x01, 0x00, 0x00, 0x00);

  for (const frame of frames) {
    // Graphic control extension: disposal = 1 ("do not dispose"), no transparency.
    // Every frame is full-size, so keeping the previous canvas is correct.
    // 8 bytes: introducer, label, block size 4, packed, delay lo/hi, transparent
    // index, block terminator. The terminator is its own 0x00 — omitting it makes
    // the next image descriptor get parsed as a sub-block length (found by the
    // decoder in accept-gif-encoder).
    out.push(0x21, 0xf9, 0x04, 0x04, delay & 0xff, (delay >> 8) & 0xff, 0x00, 0x00);
    // image descriptor: full-frame, no local table
    out.push(0x2c);
    u16(out, 0);
    u16(out, 0);
    u16(out, width);
    u16(out, height);
    out.push(0x00);
    const indices = quantize(frame.data, width, height);
    out.push(8); // LZW minimum code size
    pushSubBlocks(out, lzwEncode(indices, 8));
  }

  out.push(0x3b); // trailer
  return Uint8Array.from(out);
}
