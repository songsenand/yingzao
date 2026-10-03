// Acceptance for the protected image-offload executor (DESGIGN §16).
//
// The stock `@deepseek-ai/dsh-compaction-image-offload` picks the OLDEST
// retained occurrences with no exemption, so the user's reference image is
// pruned first. This plugin replaces that executor (cordis.patch.yml disables
// the stock row) with one that never selects user-message TOP-LEVEL images.
// Verified here, against the REAL plugin code:
//
//   1. selection: user top-level images are never selected; tool-result
//      images go oldest-first; exhausting prunable images returns null (the
//      waterfall proceeds instead of an infinite retry).
//   2. parity: a re-implementation of the STOCK selection on the same fixture
//      picks the user image first — pinning exactly the difference.
//   3. projection: valid decisions apply `offloaded` marks; malformed ones and
//      decisions targeting a protected user image are refused.
//   4. composed tree: the stock row reads `disabled: true` after composition
//      and no patch was skipped (a dsh upgrade that renames the row fails here).
//
//   node scripts/accept-image-offload.mjs

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  imageOffloadProjection,
  offloadMessageImages,
  selectOffloadTargets,
} from '../src/host/image-offload.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (ok === undefined) { console.log(`SKIP  ${label}  — ${detail}`); return; }
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// ── fixture: the microscope3 shape ──────────────────────────────────────────
// seq 1: user message (reference image + text)   → protected
// seq 2..4: tool results, 4 render views each    → prunable
const img = (name, kb, i) => ({ type: 'image', offloaded: false, attachment: { bytes: kb * 1024, name: `${name}-${i}`, attachmentId: `a-${name}-${i}` } });
const userSeq = 1;
const fixture = [
  { seq: 1, type: 'user/message', content: [img('参考图', 50, 0), { type: 'text', text: '照这个做' }] },
  ...[2, 3, 4].map((seq) => ({
    seq,
    type: 'tool/result',
    content: [0, 1, 2, 3].map((i) => img(`render-${seq}`, 30, i)),
  })),
];

// ── 1. protected selection ──────────────────────────────────────────────────
{
  // The microscope3 moment: the route needs 1 occurrence omitted.
  const one = selectOffloadTargets(fixture, 1);
  check(!!one && one[0].seq === 2 && one[0].imageIndexes.length === 1,
    'needs 1 → the OLDEST TOOL image goes, not the user reference',
    JSON.stringify(one));

  // Every prunable occurrence: 12 tool images, user image untouched.
  const all = selectOffloadTargets(fixture, 999);
  const total = all?.reduce((a, t) => a + t.imageIndexes.length, 0) ?? 0;
  check(total === 12 && !all.some((t) => t.seq === userSeq),
    'needs 999 → exactly the 12 tool images, user image never selected',
    `selected ${total}`);

  // Only user images left → nothing prunable → null (waterfall proceeds).
  const userOnly = [fixture[0], { seq: 2, type: 'user/message', content: [img('截图', 40, 0)] }];
  check(selectOffloadTargets(userOnly, 1) === null,
    'only user images remain → null (no infinite retry)');
}

// ── 2. parity with the stock selection ──────────────────────────────────────
{
  // Verbatim port of the stock selector (no exemption) — documents that the
  // ONLY behavioral difference is the user-image skip.
  const stockOldest = (entries, count) => {
    const targets = [];
    for (const entry of entries) {
      if (count === 0) break;
      const imageIndexes = [];
      let imageIndex = 0;
      const visit = (blocks) => {
        for (const block of blocks) {
          if (count === 0) break;
          if (block.type === 'image') {
            if (block.offloaded !== true) { imageIndexes.push(imageIndex); count -= 1; }
            imageIndex += 1;
          }
        }
      };
      visit(entry.content);
      if (imageIndexes.length > 0) targets.push({ seq: entry.seq, imageIndexes });
    }
    return targets;
  };
  const stock = stockOldest(fixture, 1);
  check(stock[0]?.seq === userSeq,
    'stock behavior on the same fixture picks the USER image first (the bug we replace)',
    JSON.stringify(stock));
}

// ── 3. projection validation and application ────────────────────────────────
{
  const message = (content) => ({ role: 'user', content: structuredClone(content) });
  const messages = new Map(fixture.map((f) => [f.seq, message(f.content)]));
  const ctx = {
    nodes: new Set(fixture.map((f) => f.seq)),
    events: fixture.map((f) => ({ type: f.type, data: f.content })),
    baseSeq: 1,
    messages,
  };
  const decision = { targets: [{ seq: 2, imageIndexes: [0, 1] }] };
  const out = imageOffloadProjection.project({ data: decision }, ctx);
  const projected = out.get(2).content.filter((b) => b.type === 'image');
  check(projected[0].offloaded === true && projected[1].offloaded === true && projected[2].offloaded === false,
    'a valid decision marks exactly the selected occurrences offloaded',
    JSON.stringify(projected.map((b) => b.offloaded)));

  const refused = (data, want) => {
    try { imageOffloadProjection.project({ data }, ctx); return { ok: false, msg: '(no throw)' }; }
    catch (e) { return { ok: e.message.includes(want), msg: e.message }; }
  };
  check(refused({ targets: [] }, 'nonempty targets array').ok, 'empty targets refused');
  check(refused({ targets: [{ seq: 2, imageIndexes: [0] }, { seq: 2, imageIndexes: [1] }] }, 'duplicate').ok,
    'duplicate seq refused');
  check(refused({ targets: [{ seq: 2, imageIndexes: [1, 0] }] }, 'strictly increasing').ok,
    'non-increasing indexes refused');
  check(refused({ targets: [{ seq: 2, imageIndexes: [0, 1, 9] }] }, 'does not exist').ok,
    'out-of-range index refused');
  // A decision that would hit a user top-level image is refused (defence in
  // depth: the selector never produces one, so this only fires on tampering).
  const userCtx = {
    nodes: new Set([1]),
    events: [{ type: 'user/message', data: fixture[0].content }],
    baseSeq: 1,
    messages: new Map([[1, message(fixture[0].content)]]),
  };
  try {
    imageOffloadProjection.project({ data: { targets: [{ seq: 1, imageIndexes: [0] }] } }, userCtx);
    check(false, 'a decision targeting a user image is refused');
  } catch (e) {
    check(e.message.includes('protected user image'), 'a decision targeting a user image is refused', e.message);
  }
}

// ── 4. composed tree: exactly one executor owns the seam ────────────────────
{
  const realHome = join(homedir(), '.dsh');
  const srcDir = join(realHome, 'profiles', 'web');
  if (!existsSync(join(srcDir, 'package.json'))) {
    check(undefined, 'composed tree', `no profile at ${srcDir}`);
  } else {
    const home = mkdtempSync(join(tmpdir(), 'cad-offload-'));
    try {
      const dst = join(home, 'profiles', 'web');
      mkdirSync(dst, { recursive: true });
      for (const f of ['package.json', 'cordis.yml', 'cordis.patch.yml']) {
        const from = join(srcDir, f);
        if (existsSync(from)) cpSync(from, join(dst, f));
      }
      const mods = join(srcDir, 'node_modules');
      if (existsSync(mods)) symlinkSync(mods, join(dst, 'node_modules'));
      const homeMods = join(realHome, 'profiles', 'node_modules');
      if (existsSync(homeMods)) symlinkSync(homeMods, join(home, 'profiles', 'node_modules'));
      const out = execFileSync('dsh', ['--profile', 'web', '--dump-config'], {
        env: { ...process.env, DSH_HOME: home },
        encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180_000,
      });
      check(/- id: image-offload\n {2}name: '@deepseek-ai\/dsh-compaction-image-offload'\n {2}disabled: true/.test(out),
        'the stock image-offload row reads disabled after composition');
      check(!/patch: entry .* not found|patch: name mismatch/.test(out),
        'no patch was skipped (a renamed row on dsh upgrade fails here)');
      check(/- id: preset-cad/.test(out) && /maxImagesPerRequest: 24/.test(out),
        'the earlier patches still land (preset-cad, llm-deepseek budget)');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
}

console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
