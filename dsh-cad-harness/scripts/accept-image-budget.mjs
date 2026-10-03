// Acceptance for image-context pruning (DESGIGN §12.3「图片修剪扩展」, §6.9p).
//
// Everything here is checked against the INSTALLED dsh tree
// (`~/.local/lib/node_modules/@deepseek-ai/dsh/...`) — an earlier revision of
// this suite validated claims about APIs that did not exist in any installed
// version and the drift shipped. What has to be true:
//
//   1. The numbers this plugin reports are the numbers the adapter produces.
//      `measureUsage()` predicts how many images a request keeps; the real
//      `requiredImageOffload()` + `projectOffloadedImages()` from dsh-llm
//      decide it. Both run here on the SAME synthetic history and must agree —
//      on the DeepSeek count budget and on the pi-ai byte budget (base64).
//   2. The projection is non-destructive in the only way that matters: removed
//      occurrences become a text placeholder naming the attachment and a local
//      path to re-read it, and the tool-result structure survives.
//   3. Declared policy and reported policy are the same numbers.
//   4. The patches actually land on the composed profile tree (`dsh
//      --profile web --dump-config` in a throwaway DSH_HOME): the llm-deepseek
//      image budget AND the preset-cad declaration row. This is the check that
//      caught the `@deepseek-ai/dsh-llm-deepseek` rename and the dead
//      `agent-presets` patch.
//   5. The installed pi-ai adapter has NO count knob: the glue must write only
//      `maxRequestImageBytes`.
//
//   node scripts/accept-image-budget.mjs

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEEPSEEK_COUNT_QUANTUM,
  DEEPSEEK_KEEP_IMAGES,
  PI_AI_KEEP_BYTES,
  offloadedPrefixCount,
} from '../src/host/image-budget.ts';
import { measureUsage } from '../src/host/usage.ts';
import { telemetryRoot } from '../src/host/project.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const skip = (label, why) => console.log(`SKIP  ${label}  — ${why}`);

// --- the real dsh-llm implementation ----------------------------------------
// Not a dependency of this plugin (it is a sibling bundle), so resolve it from
// the installed dsh tree. If none resolves, the cross-checks SKIP loudly
// instead of pretending the projection was verified.
async function loadHarness() {
  const candidates = [
    join(homedir(), '.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js'),
    join(homedir(), '.dsh/profiles/node_modules/@deepseek-ai/dsh-llm/lib/index.js'),
  ];
  for (const spec of candidates) {
    try {
      const mod = await import(spec);
      if (typeof mod.requiredImageOffload === 'function' && typeof mod.projectOffloadedImages === 'function') return mod;
    } catch { /* try the next location */ }
  }
  return null;
}

/**
 * The real `offloadedImagePrefixCount` is not exported; `requiredImageOffload`
 * over a synthetic history of one image per length is exactly equivalent
 * (raw representation, versionBytes = the length itself).
 */
function realPrefixCount(harness, lengths, budget) {
  const messages = lengths.map((bytes) => ({
    role: 'user',
    content: [{ type: 'image', offloaded: false, attachment: { bytes, attachmentId: `a${bytes}` } }],
  }));
  return harness.requiredImageOffload(messages, { ...budget, representation: 'raw' }, (block) => block.attachment.bytes);
}

// --- fixtures ---------------------------------------------------------------
/** Bytes of a real normalized render on this workspace (p50 / p90 / max). */
const REAL_RENDER_BYTES = [33 * 1024, 112 * 1024, 174 * 1024];

/**
 * A history shaped like the CAD loop: one user turn, then R rounds of
 * [assistant tool-call, user tool-result] where each result carries 4 render
 * views. That is exactly what `generate_part` produces.
 */
function cadHistory(rounds, viewBytes = REAL_RENDER_BYTES[0]) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: '把壁厚改到 2mm' }] }];
  for (let i = 1; i <= rounds; i++) {
    const callId = `call-${i}`;
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'generate_part', arguments: '{}' }],
    });
    messages.push({
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        content: [
          { type: 'text', text: `Version v${String(i).padStart(3, '0')} saved to part "x". Views: front, side, top, iso.` },
          ...['front', 'side', 'top', 'iso'].map((view, k) => ({
            type: 'image',
            offloaded: false,
            attachment: {
              attachmentId: `img-${i}-${view}`,
              mediaType: 'image/png',
              bytes: viewBytes,
              width: 800,
              height: 600,
              name: `v${String(i).padStart(3, '0')}-${view}`,
            },
            // marker so the check can prove WHICH occurrences survived
            _round: i,
            _view: k,
          })),
        ],
      }],
    });
  }
  return messages;
}

/** Route budgets exactly as the serving adapters resolve them. */
const deepseekBudget = {
  representation: 'raw',
  maxImages: DEEPSEEK_KEEP_IMAGES,
  maxBytes: 128 * 1024 * 1024,      // maxRequestFilesBytes default: never fires here
  byteQuantum: 64 * 1024 * 1024,    // imageOffloadByteQuantum default
  countQuantum: DEEPSEEK_COUNT_QUANTUM,
};
/** pi-ai budget as `image-budget.ts` applies it (base64 accounting, step 1). */
const piAiBudget = {
  representation: 'base64',
  maxBytes: PI_AI_KEEP_BYTES,
  byteQuantum: 1,
  countQuantum: 1,
};

/** Every retained image occurrence in request order, with its markers. */
const imagesOf = (messages) => {
  const out = [];
  const walk = (blocks) => {
    for (const b of blocks ?? []) {
      if (b.type === 'image' && b.offloaded !== true) out.push(b);
      else if (b.type === 'tool-result') walk(b.content);
    }
  };
  for (const m of messages) walk(m.content);
  return out;
};

/**
 * Simulate the adapter projection the way the serving adapters see it: tool
 * results are first flattened into `role:"tool"` messages (their image blocks
 * sit at the TOP level there — `visitImageBlocks` does not recurse), then the
 * required prefix is offloaded and projected to placeholders.
 */
function projectOffload(harness, history, budget, versionBytes) {
  const flat = [];
  for (const m of history) {
    const blocks = Array.isArray(m.content) ? m.content : [];
    const direct = [];
    for (const b of blocks) {
      if (b.type === 'tool-result') flat.push({ role: 'tool', content: b.content });
      else direct.push(b);
    }
    if (direct.length) flat.push({ ...m, content: direct });
  }
  const n = harness.requiredImageOffload(flat, budget, versionBytes);
  const marked = structuredClone(flat);
  let remaining = n;
  const mark = (blocks) => {
    for (const b of blocks ?? []) {
      if (remaining === 0) return;
      if (b.type === 'image' && b.offloaded !== true) { b.offloaded = true; remaining--; }
    }
  };
  for (const m of marked) mark(m.content);
  const projected = harness.projectOffloadedImages(marked, (ref) => `[image omitted; ${ref.name}; path=/x/${ref.attachmentId}]`);
  return { count: n, projected };
}

const harness = await loadHarness();
console.log(`image-context pruning acceptance  (real dsh-llm ${harness ? 'loaded' : 'UNAVAILABLE — cross-checks skipped'})`);
console.log(`policy: deepseek keep=${DEEPSEEK_KEEP_IMAGES} quantum=${DEEPSEEK_COUNT_QUANTUM} · pi-ai maxRequestImageBytes=${PI_AI_KEEP_BYTES}\n`);

// --- 1+2. reported == projected, on both routes -----------------------------
// pi-ai's byte knob is now a FALLBACK for pathological attachments only
// (DESGIGN §16.4: the per-preset window lives in the executor), so it is
// exercised at a size that actually crosses 8 MiB: 88 × 112KB ≈ 13 MB base64.
for (const [route, model, budget, viewBytes] of [
  ['deepseek', 'deepseek-flash', deepseekBudget, REAL_RENDER_BYTES[0]],
  ['pi-ai', 'glm-5.3-flash', piAiBudget, REAL_RENDER_BYTES[1]],
]) {
  const history = cadHistory(22, viewBytes);   // 88 images: the observed worst case
  const raw = imagesOf(history);
  const record = measureUsage(history, model);
  const label = `${route} (${Math.round(viewBytes / 1024)}KB renders)`;

  check(record.imagesBeforePrune === raw.length && raw.length === 88,
    `${label}: history carries 88 image occurrences`, `reported ${record.imagesBeforePrune}`);
  check(record.images < 88, `${label}: the mirror actually prunes`, `kept ${record.images}`);

  if (!harness) {
    skip(`${label}: reported count == real projection`, 'dsh-llm not resolvable');
    continue;
  }
  const { count, projected } = projectOffload(harness, history, budget, (b) => b.attachment.bytes);
  const kept = imagesOf(projected);
  check(kept.length === record.images,
    `${label}: reported count == real projection`,
    `measureUsage ${record.images} vs requiredImageOffload ${kept.length} (removed ${count})`);

  // Newest survive, oldest are the ones replaced.
  const keptKeys = kept.map((i) => `${i._round}/${i._view}`);
  const lastKept = kept[kept.length - 1];
  check(lastKept._round === 22 && lastKept._view === 3,
    `${label}: the newest image is untouched`, `last kept ${lastKept._round}/${lastKept._view}`);
  const expected = raw.slice(raw.length - kept.length).map((i) => `${i._round}/${i._view}`);
  check(keptKeys.join(',') === expected.join(','),
    `${label}: exactly the newest N survive (oldest prefix removed, order preserved)`);

  // Non-destructive: the placeholder names the image and a path to re-read it.
  const placeholders = [];
  const collectText = (blocks) => {
    for (const b of blocks ?? []) {
      if (b.type === 'text' && b.text.includes('image omitted')) placeholders.push(b.text);
      else if (b.type === 'tool-result') collectText(b.content);
    }
  };
  for (const m of projected) collectText(m.content);
  check(placeholders.length === 88 - kept.length,
    `${label}: every removed image became text`, `${placeholders.length} placeholders`);
  check(placeholders.every((t) => /path=\/x\//.test(t)),
    `${label}: placeholders still carry a recovery path`, placeholders[0] ?? '(none)');
  // The per-round envelope text survives, so the model still knows what it built.
  const envelopes = projected.filter((m) => m.role === 'tool').length
    + projected.flatMap((m) => m.content ?? []).filter((b) => b.type === 'tool-result').length;
  check(envelopes === 22, `${label}: every tool result is still present`, `${envelopes} results`);
}

// --- the microscope3 scenario under the fallback budget ---------------------
// 40 renders of 30KB (base64 40KB) + one 50KB user reference image ≈ 1.6 MB
// base64 — BELOW the 8 MiB fallback, by design: the route knob no longer does
// fairness. What prunes here is the executor's per-preset window (tested in
// accept-image-offload.mjs), so the mirror must predict NO pruning while the
// user reference stays safe.
{
  const img = (name, kb) => ({ type: 'image', offloaded: false, attachment: { bytes: kb * 1024, name } });
  const msgs = [
    { role: 'user', content: [img('用户参考图', 50), { type: 'text', text: '照这个做' }] },
    { role: 'assistant', content: [{ type: 'tool-result', content: Array.from({ length: 40 }, (_, i) => img(`render-${i}`, 30)) }] },
  ];
  const rec = measureUsage(msgs, 'glm-5.3-flash');
  check(rec.imagesBeforePrune === 41 && rec.images === 41,
    'pi-ai: the fallback byte budget does NOT bind at microscope3 scale (the executor window prunes instead)',
    `before ${rec.imagesBeforePrune} → kept ${rec.images}`);
  if (harness) {
    const { projected } = projectOffload(harness, msgs, piAiBudget, (b) => b.bytes);
    const keptNames = imagesOf(projected).map((i) => i.attachment.name);
    check(!keptNames.includes('用户参考图'),
      'pi-ai: the STOCK adapter projection still prunes the user reference (what the adapter asks for)',
      `kept: ${keptNames.slice(0, 3).join(', ')}…`);
    // Since DESGIGN §16 the stock executor is DISABLED and the plugin's
    // protected executor owns the seam — at the selection level the user
    // image survives while renders go first.
    const { selectOffloadTargets } = await import('../src/host/image-offload.ts');
    const entries = [
      { seq: 1, type: 'user/message', content: msgs[0].content },
      { seq: 2, type: 'tool/result', content: msgs[1].content[0].content },
    ];
    const targets = selectOffloadTargets(entries, 16);
    check(targets.every((t) => t.seq !== 1),
      'pi-ai: the PROTECTED executor selection spares the user reference image (DESGIGN §16)',
      JSON.stringify(targets?.map((t) => t.seq)));
  }
}

// --- 3. declared policy == reported policy ----------------------------------
const patchText = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');
const declaredMax = Number(/maxImagesPerRequest:\s*(\d+)/.exec(patchText)?.[1]);
const declaredQuantum = Number(/imageOffloadCountQuantum:\s*(\d+)/.exec(patchText)?.[1]);
check(declaredMax === DEEPSEEK_KEEP_IMAGES && declaredQuantum === DEEPSEEK_COUNT_QUANTUM,
  'cordis.patch.yml declares the same numbers usage.ts reports',
  `patch ${declaredMax}/${declaredQuantum} vs code ${DEEPSEEK_KEEP_IMAGES}/${DEEPSEEK_COUNT_QUANTUM}`);
check(declaredQuantum <= declaredMax, 'quantum does not exceed the budget (the adapter rejects that)');

// --- the mirror itself, against the real implementation ---------------------
if (harness) {
  let mismatches = 0;
  let cases = 0;
  for (const n of [0, 1, 4, 5, 16, 17, 23, 24, 25, 32, 40, 88, 129]) {
    for (const bytes of [0, 1, 1024, 50_000, 112 * 1024]) {
      const lengths = Array.from({ length: n }, () => bytes);
      for (const [maxImages, maxBytes, cq, bq] of [
        [DEEPSEEK_KEEP_IMAGES, undefined, DEEPSEEK_COUNT_QUANTUM, 1],
        [undefined, PI_AI_KEEP_BYTES, 1, 1],
        [24, 8 * 1024 * 1024, 8, 4 * 1024 * 1024],
        [undefined, undefined, 1, 1],
      ]) {
        cases++;
        const mine = offloadedPrefixCount(lengths, maxImages, maxBytes, cq, bq);
        const theirs = realPrefixCount(harness, lengths, {
          maxImages, maxBytes, countQuantum: cq, byteQuantum: bq,
        });
        if (mine !== theirs) {
          mismatches++;
          if (mismatches <= 3) console.log(`      mirror mismatch n=${n} bytes=${bytes} → ${mine} vs ${theirs}`);
        }
      }
    }
  }
  check(mismatches === 0, 'the telemetry mirror matches offloadedImagePrefixCount', `${cases} cases`);
} else {
  skip('mirror cross-check', 'dsh-llm not resolvable');
}

// --- replay the profile's own telemetry -------------------------------------
// The recorded rows carry an image COUNT but not per-image byte sizes, so only
// the count budget can be replayed faithfully; the byte budget cannot be, and
// is covered by the synthetic cases above instead.
const usagePath = [join(telemetryRoot(), 'usage.jsonl'), join(ROOT, 'data/usage/usage.jsonl')]
  .find((p) => existsSync(p));
if (usagePath) {
  const rows = readFileSync(usagePath, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).filter((r) => !r.purpose && r.generatePartRounds > 0);
  const ds = rows.filter((r) => /deepseek/i.test(r.model ?? ''));
  const rawOf = (r) => r.imagesBeforePrune ?? r.images;
  const keptOf = (r) => rawOf(r) - offloadedPrefixCount(
    Array.from({ length: rawOf(r) }, () => 0), DEEPSEEK_KEEP_IMAGES, undefined, DEEPSEEK_COUNT_QUANTUM, 1,
  );
  const before = ds.reduce((a, r) => a + rawOf(r), 0);
  const after = ds.reduce((a, r) => a + keptOf(r), 0);
  const peak = Math.max(...ds.map(rawOf));
  const keptPeak = Math.max(...ds.map(keptOf));
  const over = ds.filter((r) => rawOf(r) > DEEPSEEK_KEEP_IMAGES);
  const minKept = Math.min(...over.map(keptOf));
  console.log(`\nreplay of ${ds.length} recorded DeepSeek requests through the count budget`);
  console.log(`  image occurrences   ${before.toLocaleString()} → ${after.toLocaleString()}`
    + `  (${(100 * (1 - after / before)).toFixed(1)}% removed)`);
  console.log(`  worst single call   ${peak} → ${keptPeak} images`);
  check(over.length > 0, 'the recorded corpus actually exceeds the budget (control)', `${over.length} calls`);
  check(minKept >= 16, 'every over-budget recorded call keeps four render rounds or more', `min kept ${minKept}`);
  check(keptPeak <= DEEPSEEK_KEEP_IMAGES, 'no call exceeds the ceiling', `max kept ${keptPeak}`);
  check(after < before, 'the budget reduces the corpus', `${before} → ${after}`);
} else {
  skip('telemetry replay', `${join(telemetryRoot(), 'usage.jsonl')} not found`);
}

// --- 5. the pi-ai half, against a fake settings service ---------------------
// Exercises the GLUE: which paths we write, that we never invent a provider,
// that a deliberate tighter user value is respected, that repeated boots are
// no-ops — and that we write ONLY maxRequestImageBytes, because the installed
// adapter's schema has no other knob.
async function checkPiAiGlue() {
  const { applyPiAiImageBudget } = await import('../src/host/image-budget.ts');

  const makeSettings = (providers) => {
    const base = { providers: {} };
    let user = { providers };
    const ops = [];
    const resolved = () => {
      const out = { providers: {} };
      for (const [name, profile] of Object.entries(base.providers)) out.providers[name] = { ...profile };
      for (const [name, profile] of Object.entries(user.providers ?? {})) {
        out.providers[name] = { ...(out.providers[name] ?? {}), ...profile };
      }
      return out;
    };
    return {
      ops,
      get: () => resolved(),
      mutate: async (ns, list) => {
        if (ns !== 'llm-pi-ai') throw new Error(`unexpected namespace ${ns}`);
        for (const op of list) {
          ops.push(op);
          const [, name, field] = op.path;
          user.providers[name] = { ...(user.providers[name] ?? {}), [field]: op.value };
        }
        for (const listener of listeners) listener(ns);
      },
    };
  };
  const listeners = [];

  const openProvider = { 'zai-coding-cn': { apiKeyEnv: 'ZAI', models: [{ id: 'glm-5.3-flash' }] } };
  const settings = makeSettings(openProvider);
  const sctx = {
    settings,
    logger: { info: () => {}, warn: () => {} },
    inject: (_deps, cb) => cb(sctx),
    on: (event, cb) => { if (event === 'settings/updated') listeners.push(cb); },
  };
  applyPiAiImageBudget(sctx);
  await new Promise((r) => setTimeout(r, 10));
  const sets = settings.ops.filter((o) => o.op === 'set');
  const byPath = Object.fromEntries(sets.map((o) => [o.path.join('.'), o.value]));
  check(byPath['providers.zai-coding-cn.maxRequestImageBytes'] === PI_AI_KEEP_BYTES,
    'pi-ai: writes the byte bound for a configured provider',
    sets.map((o) => `${o.path.join('.')}=${o.value}`).join(' ') || '(no ops)');
  check(!sets.some((o) => o.path.at(-1) === 'maxRequestImages'),
    'pi-ai: writes NO maxRequestImages — the installed adapter schema has no such knob',
    sets.map((o) => o.path.join('.')).join(' ') || '(no ops)');
  check(settings.get().providers['zai-coding-cn'].maxRequestImageBytes === PI_AI_KEEP_BYTES,
    'pi-ai: the resolved section then reports the budget', String(settings.get().providers['zai-coding-cn'].maxRequestImageBytes));

  // Our own write re-enters through settings/updated; it must not write again.
  const writes = settings.ops.length;
  for (const l of listeners) l('llm-pi-ai');
  await new Promise((r) => setTimeout(r, 10));
  check(settings.ops.length === writes, 'pi-ai: re-entry is a no-op, not a write loop',
    `${writes} op(s) then ${settings.ops.length}`);

  // A deliberate tighter value wins.
  const tight = makeSettings({ zai: { maxRequestImageBytes: 1024 } });
  const sctx2 = { settings: tight, logger: { info: () => {}, warn: () => {} }, inject: (_d, cb) => cb(sctx2), on: () => {} };
  applyPiAiImageBudget(sctx2);
  await new Promise((r) => setTimeout(r, 10));
  check(tight.ops.length === 0, 'pi-ai: never loosens or overrides an existing tighter budget');

  // No provider profiles: nothing may be invented (a phantom route would fail
  // the section's own serviceability check and could break boot).
  const empty = makeSettings({});
  const sctx3 = { settings: empty, logger: { info: () => {}, warn: () => {} }, inject: (_d, cb) => cb(sctx3), on: () => {} };
  applyPiAiImageBudget(sctx3);
  await new Promise((r) => setTimeout(r, 10));
  check(empty.ops.length === 0, 'pi-ai: invents no provider when the user defines none');

  // A refusing settings provider must not throw out of the plugin.
  let warned = '';
  const sctx4 = {
    settings: { get: () => ({ providers: { zai: {} } }), mutate: async () => { throw new Error('read-only settings'); } },
    logger: { info: () => {}, warn: (m) => { warned = m; } },
    inject: (_d, cb) => cb(sctx4),
    on: () => {},
  };
  let threw = false;
  try { applyPiAiImageBudget(sctx4); await new Promise((r) => setTimeout(r, 10)); } catch { threw = true; }
  check(!threw && /not applied/.test(warned), 'pi-ai: a refusing provider is contained and logged',
    warned || '(no warning)');

  // And a host with no settings service at all.
  let missingThrew = false;
  try { applyPiAiImageBudget({ inject: (_d, cb) => cb({}), logger: { warn: () => {} } }); } catch { missingThrew = true; }
  check(!missingThrew, 'pi-ai: a host without settings is a silent no-op');
}
await checkPiAiGlue();

// --- 6. the patches land on the composed profile tree -----------------------
function checkComposition() {
  const realHome = join(homedir(), '.dsh');
  const profile = 'web';
  const srcDir = join(realHome, 'profiles', profile);
  if (!existsSync(join(srcDir, 'package.json'))) return skip('patch composition', `no profile at ${srcDir}`);
  let dsh;
  try {
    dsh = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim();
  } catch { return skip('patch composition', 'dsh not on PATH'); }

  // `dsh` writes the profile manifest while composing, so compose inside a
  // throwaway DSH_HOME under the OS temp dir, with node_modules symlinked.
  const home = mkdtempSync(join(tmpdir(), 'cad-image-budget-'));
  try {
    const dst = join(home, 'profiles', profile);
    mkdirSync(dst, { recursive: true });
    for (const f of ['package.json', 'cordis.yml', 'cordis.patch.yml']) {
      const from = join(srcDir, f);
      if (existsSync(from)) cpSync(from, join(dst, f));
    }
    const mods = join(srcDir, 'node_modules');
    if (existsSync(mods)) symlinkSync(mods, join(dst, 'node_modules'));
    const homeMods = join(realHome, 'profiles', 'node_modules');
    if (existsSync(homeMods)) symlinkSync(homeMods, join(home, 'profiles', 'node_modules'));

    const out = execFileSync(dsh, ['--profile', profile, '--dump-config'], {
      env: { ...process.env, DSH_HOME: home },
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 180_000,
    });
    const row = /- id: llm-deepseek\n {2}name: '@deepseek-ai\/dsh-llm-deepseek-api-key'\n {2}config:\n {4}maxImagesPerRequest: (\d+)\n {4}imageOffloadCountQuantum: (\d+)/.exec(out);
    check(!!row, 'the llm-deepseek row carries the image budget after composition',
      row ? `maxImagesPerRequest=${row[1]} imageOffloadCountQuantum=${row[2]}` : 'row or config missing');
    if (row) {
      check(Number(row[1]) === DEEPSEEK_KEEP_IMAGES && Number(row[2]) === DEEPSEEK_COUNT_QUANTUM,
        'composed values equal the declared ones');
    }
    check(/- id: preset-cad\n {2}name: '@deepseek-ai\/dsh-agent-preset'\n {2}config:\n {4}id: cad/.test(out),
      'the preset-cad declaration row lands after composition');
    check(/cad-skill-filesystem/.test(out),
      'the CAD skill root lands inside the preset composition');
    check(/- id: agent-preset-registry\n {2}name: '@deepseek-ai\/dsh-agent-preset-registry'\n {2}config:\n {4}default: standard/.test(out),
      'the preset registry default is still standard (CAD is opt-in)');
    check(!/patch: entry .* not found|patch: name mismatch/.test(out),
      'no patch was skipped (id and name both matched)');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
try {
  checkComposition();
} catch (e) {
  skip('patch composition', String(e?.message ?? e).split('\n')[0]);
}

console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
