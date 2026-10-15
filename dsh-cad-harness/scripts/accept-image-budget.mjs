// Acceptance for image policy (DESIGN §16–17): route knobs stay at dsh
// FACTORY DEFAULTS; the only active budget is the per-session 造物 (cad)
// window enforced by the offload executor (accept-image-offload.mjs).
//
//   1. measureUsage's deepseek numbers PREDICT the cad window (24 retained)
//      and are cross-checked against the real dsh-llm implementation.
//   2. pi-ai has NO budget: nothing is pruned at any ordinary scale.
//   3. The telemetry mirror matches the real `requiredImageOffload` math.
//   4. Composed tree: the llm-deepseek row is UNPATCHED (factory defaults),
//      the stock executor is disabled, preset-cad lands, no patch skipped.
//
//   node scripts/accept-image-budget.mjs

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEEPSEEK_COUNT_QUANTUM, DEEPSEEK_KEEP_IMAGES, offloadedPrefixCount } from '../src/host/image-budget.ts';
import { measureUsage } from '../src/host/usage.ts';
import { telemetryRoot } from '../src/host/project.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (ok === undefined) { console.log(`SKIP  ${label}  — ${detail}`); return; }
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

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

/** Bytes of a real normalized render on this workspace (p50 / p90 / max). */
const REAL_RENDER_BYTES = [33 * 1024, 112 * 1024, 174 * 1024];

function cadHistory(rounds, viewBytes = REAL_RENDER_BYTES[0]) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: '把壁厚改到 2mm' }] }];
  for (let i = 1; i <= rounds; i++) {
    const callId = `call-${i}`;
    messages.push({ role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'generate_part', arguments: '{}' }] });
    messages.push({
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        content: [
          { type: 'text', text: `Version v${String(i).padStart(3, '0')} saved to part "x".` },
          ...['front', 'side', 'top', 'iso'].map((view, k) => ({
            type: 'image', offloaded: false,
            attachment: { attachmentId: `img-${i}-${view}`, mediaType: 'image/png', bytes: viewBytes, width: 800, height: 600, name: `v${String(i).padStart(3, '0')}-${view}` },
            _round: i, _view: k,
          })),
        ],
      }],
    });
  }
  return messages;
}

/** The cad WINDOW budget, exactly as the executor enforces it (count-only). */
const cadWindowBudget = {
  representation: 'raw',
  maxImages: DEEPSEEK_KEEP_IMAGES,
  maxBytes: undefined,
  byteQuantum: 1,
  countQuantum: DEEPSEEK_COUNT_QUANTUM,
};

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
console.log(`image policy acceptance  (real dsh-llm ${harness ? 'loaded' : 'UNAVAILABLE — cross-checks skipped'})`);
console.log(`policy: NO route budget on any preset · cad session window = ${DEEPSEEK_KEEP_IMAGES} images (executor-side)\n`);

// --- 1. the cad window prediction, cross-checked against the real math ------
{
  const history = cadHistory(22);   // 88 images: the observed worst case
  const raw = imagesOf(history);
  const record = measureUsage(history, 'deepseek-flash');

  check(record.imagesBeforePrune === 88, 'cad window: history carries 88 image occurrences', `reported ${record.imagesBeforePrune}`);
  check(record.images === DEEPSEEK_KEEP_IMAGES,
    'cad window: the prediction keeps exactly the window size', `kept ${record.images}`);

  if (!harness) {
    check(undefined, 'cad window: prediction == real offload math', 'dsh-llm not resolvable');
  } else {
    const { projected } = projectOffload(harness, history, cadWindowBudget, (b) => b.attachment.bytes);
    const kept = imagesOf(projected);
    check(kept.length === record.images,
      'cad window: prediction == real offload math',
      `measureUsage ${record.images} vs requiredImageOffload ${kept.length}`);
    const lastKept = kept[kept.length - 1];
    check(lastKept._round === 22 && lastKept._view === 3, 'cad window: the newest image is untouched');
    const placeholders = [];
    for (const m of projected) for (const b of m.content ?? []) if (b.type === 'text' && b.text.includes('image omitted')) placeholders.push(b.text);
    check(placeholders.length === 88 - kept.length && placeholders.every((t) => /path=\/x\//.test(t)),
      'cad window: removed images became placeholders with a recovery path', `${placeholders.length} placeholders`);
  }
}

// --- 2. pi-ai: no budget at all ---------------------------------------------
{
  const history = cadHistory(22, REAL_RENDER_BYTES[1]); // 88 × 112KB — big on purpose
  const record = measureUsage(history, 'glm-5.3-flash');
  check(record.imagesBeforePrune === 88 && record.images === 88,
    'pi-ai: NO pruning is predicted at any ordinary scale (factory defaults)', `kept ${record.images}`);
}

// --- 3. the mirror against the real implementation ---------------------------
if (harness) {
  const realPrefixCount = (h, lengths, budget) => {
    const messages = lengths.map((bytes) => ({
      role: 'user',
      content: [{ type: 'image', offloaded: false, attachment: { bytes, attachmentId: `a${bytes}` } }],
    }));
    return h.requiredImageOffload(messages, { ...budget, representation: 'raw' }, (block) => block.attachment.bytes);
  };
  let mismatches = 0, cases = 0;
  for (const n of [0, 1, 4, 5, 16, 17, 23, 24, 25, 32, 40, 88, 129]) {
    for (const bytes of [0, 1, 1024, 50_000, 112 * 1024]) {
      const lengths = Array.from({ length: n }, () => bytes);
      for (const [maxImages, maxBytes, cq, bq] of [
        [DEEPSEEK_KEEP_IMAGES, undefined, DEEPSEEK_COUNT_QUANTUM, 1],
        [undefined, undefined, 1, 1],
        [24, 8 * 1024 * 1024, 8, 4 * 1024 * 1024],
      ]) {
        cases++;
        const mine = offloadedPrefixCount(lengths, maxImages, maxBytes, cq, bq);
        const theirs = realPrefixCount(harness, lengths, { maxImages, maxBytes, countQuantum: cq, byteQuantum: bq });
        if (mine !== theirs && mismatches < 3) console.log(`      mirror mismatch n=${n} bytes=${bytes} → ${mine} vs ${theirs}`);
        if (mine !== theirs) mismatches++;
      }
    }
  }
  check(mismatches === 0, 'the telemetry mirror matches the real offload math', `${cases} cases`);
} else {
  check(undefined, 'mirror cross-check', 'dsh-llm not resolvable');
}

// --- replay: what the cad window achieves on the recorded corpus -------------
const usagePath = [join(telemetryRoot(), 'usage.jsonl'), join(ROOT, 'data/usage/usage.jsonl')].find((p) => existsSync(p));
if (usagePath) {
  const rows = readFileSync(usagePath, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).filter((r) => !r.purpose && r.generatePartRounds > 0);
  const ds = rows.filter((r) => /deepseek/i.test(r.model ?? ''));
  const rawOf = (r) => r.imagesBeforePrune ?? r.images;
  const keptOf = (r) => rawOf(r) - offloadedPrefixCount(
    Array.from({ length: rawOf(r) }, () => 0), DEEPSEEK_KEEP_IMAGES, undefined, DEEPSEEK_COUNT_QUANTUM, 1);
  const before = ds.reduce((a, r) => a + rawOf(r), 0);
  const after = ds.reduce((a, r) => a + keptOf(r), 0);
  const over = ds.filter((r) => rawOf(r) > DEEPSEEK_KEEP_IMAGES);
  console.log(`\nreplay of ${ds.length} recorded deepseek requests through the cad window`);
  console.log(`  image occurrences ${before.toLocaleString()} → ${after.toLocaleString()} (${(100 * (1 - after / before)).toFixed(1)}% removed)`);
  check(over.length > 0, 'the recorded corpus actually exceeds the window (control)', `${over.length} calls`);
  const minKept = Math.min(...over.map(keptOf));
  check(minKept >= 16, 'every over-window call keeps four render rounds or more', `min kept ${minKept}`);
  check(after < before, 'the window reduces the corpus', `${before} → ${after}`);
} else {
  check(undefined, 'telemetry replay', 'usage.jsonl not found');
}

// --- 4. composed tree: factory defaults everywhere but the executor swap -----
{
  const realHome = join(homedir(), '.dsh');
  const srcDir = join(realHome, 'profiles', 'web');
  if (!existsSync(join(srcDir, 'package.json'))) {
    check(undefined, 'composed tree', `no profile at ${srcDir}`);
  } else {
    const home = mkdtempSync(join(tmpdir(), 'cad-image-budget-'));
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
      const llmRow = /- id: llm-deepseek\n {2}name: '@deepseek-ai\/dsh-llm-deepseek-api-key'\n(?!\n? {2}config:)/.test(out)
        || /- id: llm-deepseek\n {2}name: '@deepseek-ai\/dsh-llm-deepseek-api-key'\n\n/.test(out);
      check(!out.includes('maxImagesPerRequest'),
        'the llm-deepseek row is UNPATCHED (factory defaults; the cad window is session-level)');
      check(/- id: image-offload\n {2}name: '@deepseek-ai\/dsh-compaction-image-offload'\n {2}disabled: true/.test(out),
        'the stock image-offload row reads disabled after composition');
      check(/- id: preset-cad\n {2}name: '@deepseek-ai\/dsh-agent-preset'/.test(out),
        'the preset-cad declaration row lands after composition');
      check(/cad-skill-filesystem/.test(out), 'the CAD skill root lands inside the preset composition');
      check(!/patch: entry .* not found|patch: name mismatch/.test(out),
        'no patch was skipped (id and name both matched)');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
}

console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
