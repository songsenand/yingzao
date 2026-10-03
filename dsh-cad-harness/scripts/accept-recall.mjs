// Acceptance for recall_reference_image (DESGIGN §15/§16 — the plugin-side
// answer to "oldest-first offload prunes the user's reference image").
//
// Verified against the REAL tool code (registerCadTools from src/host/tools.ts)
// with a fake attachment store that mirrors the content-addressed contract:
//
//   1. path mode: a placeholder-style path resolves, magic-byte sniffing works,
//      and the recalled image rides on the tool result as an image block.
//   2. attachmentId mode: readImage(ref) path works.
//   3. recallToken determinism: finalize emits exactly the image THIS call
//      saved (not another pending one), and the token never reaches the
//      model-visible render.
//   4. error paths: missing file, non-image bytes, missing args — all refuse
//      with actionable messages.
//   5. the tool is registered under the CAD scope (cadToolNames) so the preset
//      filter hides it from coding sessions.
//
//   node scripts/accept-recall.mjs

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerCadTools, cadToolNames } from '../src/host/tools.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const ROOT = join(tmpdir(), 'cad-recall-accept');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

// A real 1×1 red PNG, then a real render-sized image for the visual check.
const RED_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000100000001080200000090775' +
  '3de0000000c4944415408d763f8cfc00000030101', 'hex') ; // truncated on purpose? no — build below instead
// Build a valid PNG via zlib (avoid hand-rolled CRC mistakes).
import { deflateSync } from 'node:zlib';
function makePng(w, h, r, g, b) {
  const crcTable = [...Array(256)].map((_, n) => {
    let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (1 + w * 3) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const saved = [];
const fakeAttachments = {
  // mirrors the store contract: returns a durable ref, keeps bytes addressable
  async saveImages([input]) {
    const id = `sha256:saved${saved.length.toString().padStart(4, '0')}`;
    const file = join(ROOT, `${id}.img`);
    writeFileSync(file, input.data);
    saved.push({ id, file, input });
    return [{ attachmentId: id, mediaType: input.mediaType, name: input.name }];
  },
  async readImage(ref) {
    const hit = saved.find((s) => s.id === ref.attachmentId);
    if (!hit) throw new Error('INVALID_ATTACHMENT_REF');
    return readFileSync(hit.file);
  },
};

const registered = [];
const fakeCtx = {
  attachments: fakeAttachments,
  tools: { register: (def) => registered.push(def) },
  reflect: { get: () => null }, // headless: registerWhenReady will idle-retry
  on: () => {}, // usage observer registers an llm/stream listener we don't exercise
  fetch: { register: () => {} },
};
registerCadTools(fakeCtx);

const tool = registered.find((t) => t.name === 'recall_reference_image');
check(!!tool, 'the tool is registered');
check(cadToolNames().includes('recall_reference_image'),
  'the tool is in the CAD catalog (preset scope hides it from coding sessions)');

// --- fixture: a user reference image on disk, like a pruned placeholder names it
const refPath = join(ROOT, '参考图.png');
writeFileSync(refPath, makePng(64, 48, 200, 60, 30));

// --- 1. path mode ------------------------------------------------------------
const run1 = await tool.execute({ path: refPath, name: '用户参考图' });
check(run1.recalled === true && run1.attached === true && run1.mediaType === 'image/png',
  'path mode: recall succeeds and reports the sniffed media type', JSON.stringify(run1));
const blocks1 = tool.finalizeContent(null, { value: run1 });
check(Array.isArray(blocks1) && blocks1.length === 2 && blocks1[1].type === 'image',
  'path mode: the image block rides on the tool result', JSON.stringify(blocks1?.map((b) => b.type)));
const text1 = blocks1?.[0]?.text ?? '';
check(/用户参考图/.test(text1) && /recall_reference_image/.test(text1),
  'path mode: the envelope text names the image and the recovery tool', text1.slice(0, 80));
const recalledFile = saved.at(-1).file;
check(readFileSync(recalledFile).equals(readFileSync(refPath)),
  'path mode: the re-committed bytes are byte-identical to the original');

// visual confirmation — write what the model would receive and LOOK at it
const visualPath = join(ROOT, 'visual-recalled.png');
writeFileSync(visualPath, readFileSync(recalledFile));
console.log(`      visual check file: ${visualPath} (64×48 RGB 200/60/30 expected)`);

// --- 2. attachmentId mode ----------------------------------------------------
const run2 = await tool.execute({ attachmentId: saved[0].id });
const blocks2 = tool.finalizeContent(null, { value: run2 });
check(run2.recalled === true && blocks2?.[1]?.type === 'image',
  'attachmentId mode: recall via the durable id works', JSON.stringify(run2));

// --- 3. token determinism: two pending recalls finalize in the right order ---
saved.length = 0;
const p1 = join(ROOT, 'a.png'); writeFileSync(p1, makePng(8, 8, 255, 0, 0));
const p2 = join(ROOT, 'b.png'); writeFileSync(p2, makePng(8, 8, 0, 255, 0));
const ra = await tool.execute({ path: p1 });
const rb = await tool.execute({ path: p2 });
const fa = tool.finalizeContent(null, { value: ra });
const fb = tool.finalizeContent(null, { value: rb });
const refOf = (blocks) => saved.findIndex((s) => s.id === blocks[1].attachment.attachmentId);
check(refOf(fa) === 0 && refOf(fb) === 1,
  'two pending recalls finalize with THEIR OWN images (no cross-wiring)');
check(!JSON.stringify(fa?.[0]?.text ?? '').includes('recallToken'),
  'the recallToken never reaches the model-visible text');

// --- 4. error paths ----------------------------------------------------------
const refuses = async (args, want) => {
  try { await tool.execute(args); return { ok: false, msg: '(no throw)' }; }
  catch (e) { return { ok: e.message.includes(want), msg: e.message.split('\n')[0] }; }
};
check((await refuses({ path: join(ROOT, 'nope.png') }, 'does not exist')).ok,
  'missing file refuses with a placeholder hint');
const notImage = join(ROOT, 'notes.txt'); writeFileSync(notImage, 'hello');
check((await refuses({ path: notImage }, 'not a PNG/JPEG/WebP')).ok,
  'non-image bytes refuse on magic bytes');
check((await refuses({}, 'needs `path`')).ok,
  'no args refuses with usage guidance');
const r3 = tool.finalizeContent(null, { value: { attached: false } });
check(r3 === undefined, 'finalize without a recall emits no blocks');

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
