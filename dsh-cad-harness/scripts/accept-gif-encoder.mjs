// Acceptance: the panel's GIF encoder produces a file the panel can trust.
//
// The playback view exports "what you see" as a GIF or a video. GIF needs a byte
// encoder and the panel must not grow a dependency for one button, so it is
// hand-rolled — which means LZW, and LZW bugs are silent (a viewer shows garbage,
// or the animation stops at frame 2). So this script decodes the bytes back with
// an independent decoder written here and compares PIXELS against the quantiser's
// own output. No Python, no image library.
//
//   node scripts/accept-gif-encoder.mjs

import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { encodeGif, quantize } from '../src/client/gif-encoder.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// ---------------------------------------------------------------- decode ----
/** Independent GIF89a reader: walks blocks and LZW-decodes each full frame. */
function decodeGif(bytes) {
  let p = 0;
  const u8 = () => bytes[p++];
  const u16 = () => { const v = bytes[p] | (bytes[p + 1] << 8); p += 2; return v; };
  const sig = String.fromCharCode(...bytes.slice(0, 6));
  p = 6;
  const width = u16();
  const height = u16();
  const packed = u8();
  u8(); u8(); // background, aspect
  const gctSize = 1 << ((packed & 7) + 1);
  const gct = bytes.slice(p, p + gctSize * 3);
  p += gctSize * 3;
  const frames = [];
  const skipSubBlocks = () => { for (;;) { const n = u8(); if (n === 0) return; p += n; } };
  for (;;) {
    const marker = u8();
    if (marker === 0x3b) break;
    if (marker === 0x21) { u8(); skipSubBlocks(); continue; }
    if (marker !== 0x2c) throw new Error(`unexpected block 0x${marker.toString(16)} at ${p - 1}`);
    const left = u16(), top = u16(), w = u16(), h = u16();
    const ipacked = u8();
    if (ipacked & 0x80) p += 3 * (1 << ((ipacked & 7) + 1));
    const minCodeSize = u8();
    const data = [];
    for (;;) { const n = u8(); if (n === 0) break; for (let i = 0; i < n; i++) data.push(bytes[p++]); }
    frames.push({ left, top, w, h, indices: lzwDecode(data, minCodeSize) });
  }
  return { sig, width, height, gct, frames };
}

function lzwDecode(data, minCodeSize) {
  // Prefix/suffix tables instead of arrays-of-arrays: the naive form copies the
  // whole prefix on every push, which is O(n²) and hung on a 320×240 noise frame.
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const MAX = 4096;
  const prefixOf = new Int32Array(MAX);
  const suffixOf = new Uint8Array(MAX);
  const firstOf = new Uint8Array(MAX);
  const lenOf = new Uint16Array(MAX);
  const out = [];
  let next = 0;
  let size = minCodeSize + 1;
  let bitPos = 0;
  const reset = () => {
    for (let i = 0; i < clear; i++) { prefixOf[i] = -1; suffixOf[i] = i; firstOf[i] = i; lenOf[i] = 1; }
    next = eoi + 1;
    size = minCodeSize + 1;
  };
  reset();
  const readCode = () => {
    let code = 0;
    for (let i = 0; i < size; i++) {
      code |= ((data[bitPos >> 3] >> (bitPos & 7)) & 1) << i;
      bitPos++;
    }
    return code;
  };
  const emit = (code) => {
    // walk the chain backwards, then reverse
    const tmp = new Uint8Array(lenOf[code]);
    let c = code;
    for (let i = tmp.length - 1; i >= 0; i--) { tmp[i] = suffixOf[c]; c = prefixOf[c]; }
    for (let i = 0; i < tmp.length; i++) out.push(tmp[i]);
  };
  let prev = -1;
  for (;;) {
    if (bitPos + size > data.length * 8) break;
    const code = readCode();
    if (code === clear) { reset(); prev = -1; continue; }
    if (code === eoi) break;
    if (code < next) {
      emit(code);
      if (prev >= 0 && next < MAX) {
        prefixOf[next] = prev;
        suffixOf[next] = firstOf[code];
        firstOf[next] = firstOf[prev];
        lenOf[next] = lenOf[prev] + 1;
        next++;
        // The decoder is one entry BEHIND the encoder: it must widen BEFORE it
        // reads the first 2^size code, not after. Bumping `>` instead of `===`
        // desynchronises every code after the 512th (found by this acceptance).
        if (next === (1 << size) && size < 12) size++;
      }
    } else if (prev >= 0) {
      // KwKwK case: prev + first(prev)
      const ch = firstOf[prev];
      if (next < MAX) {
        prefixOf[next] = prev;
        suffixOf[next] = ch;
        firstOf[next] = firstOf[prev];
        lenOf[next] = lenOf[prev] + 1;
        next++;
        if (next === (1 << size) && size < 12) size++;
        emit(next - 1);
      }
    }
    prev = code < next ? code : next - 1;
  }
  return out;
}

// -------------------------------------------------------------- fixture -----
const W = 64, H = 48, N = 4;
const frames = [];
for (let f = 0; f < N; f++) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      const sx = 4 + f * 12;
      const inSquare = x >= sx && x < sx + 16 && y >= 16 && y < 32;
      data[p] = inSquare ? 220 : 110;
      data[p + 1] = inSquare ? 30 : 110;
      data[p + 2] = inSquare ? 30 : 110;
      data[p + 3] = 255;
    }
  }
  frames.push({ data });
}

const gif = encodeGif(frames, W, H, 66);
const dir = mkdtempSync(join(tmpdir(), 'gif-accept-'));
writeFileSync(join(dir, 'anim.gif'), gif);

// --------------------------------------------------------------- checks -----
check(String.fromCharCode(...gif.slice(0, 6)) === 'GIF89a', 'header is GIF89a');
check(gif[gif.length - 1] === 0x3b, 'trailer present');

const decoded = decodeGif(gif);
check(decoded.width === W && decoded.height === H, 'logical screen size matches', `${decoded.width}x${decoded.height}`);
check(decoded.frames.length === N, 'one full frame per input frame', `${decoded.frames.length}/${N}`);

let mismatched = 0;
for (let i = 0; i < Math.min(N, decoded.frames.length); i++) {
  const expected = quantize(frames[i].data, W, H);
  const got = decoded.frames[i].indices;
  if (got.length !== expected.length) { mismatched += Math.abs(got.length - expected.length); continue; }
  for (let k = 0; k < expected.length; k++) if (got[k] !== expected[k]) mismatched++;
}
check(mismatched === 0, 'decoded pixels equal the quantiser output (LZW round-trip)', `${mismatched} mismatches`);

// the square must MOVE — a decoder that always returns frame 0 would pass the
// round-trip above only if the source frames differed, so assert the difference
// is visible in the decoded output.
const first = decoded.frames[0].indices;
const last = decoded.frames[N - 1].indices;
let changed = 0;
for (let k = 0; k < first.length; k++) if (first[k] !== last[k]) changed++;
check(changed > W, 'the last decoded frame differs from the first (motion is encoded)', `${changed} px`);

const again = encodeGif(frames, W, H, 66);
check(Buffer.compare(Buffer.from(gif), Buffer.from(again)) === 0, 'encoding is deterministic');

// a large frame count exercises the 4096-code dictionary reset path
{
  const big = [];
  for (let f = 0; f < 3; f++) {
    const data = new Uint8ClampedArray(320 * 240 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = (i * 7 + f * 31) & 0xff;
      data[i + 1] = (i * 3) & 0xff;
      data[i + 2] = (i * 11 + f) & 0xff;
      data[i + 3] = 255;
    }
    big.push({ data });
  }
  const noisy = encodeGif(big, 320, 240, 50);
  const dec = decodeGif(noisy);
  let bad = 0;
  dec.frames.forEach((fr, i) => {
    const exp = quantize(big[i].data, 320, 240);
    if (fr.indices.length !== exp.length) { bad += 1; return; }
    for (let k = 0; k < exp.length; k++) if (fr.indices[k] !== exp[k]) { bad++; break; }
  });
  check(dec.frames.length === 3 && bad === 0, 'a 320×240 noise frame set survives the code-table reset', `${dec.frames.length} frames, ${bad} bad`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
