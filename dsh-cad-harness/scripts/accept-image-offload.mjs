// Acceptance for the protected image-offload executor (DESIGN §16).
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
//      a user-image decision applies verbatim (stock parity for non-cad).
//   4. composed tree: the stock row reads `disabled: true` after composition
//      and no patch was skipped (a dsh upgrade that renames the row fails here).
//
//   node scripts/accept-image-offload.mjs

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAD_IMAGE_WINDOW,
  countRetainedImages,
  enforceSessionWindow,
  presetOfSession,
  imageOffloadProjection,
  offloadMessageImages,
  offloadOldestProtected,
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
  const one = selectOffloadTargets(fixture, 1, true);
  check(!!one && one[0].seq === 2 && one[0].imageIndexes.length === 1,
    'needs 1 → the OLDEST TOOL image goes, not the user reference',
    JSON.stringify(one));

  // Every prunable occurrence: 12 tool images, user image untouched.
  const all = selectOffloadTargets(fixture, 999, true);
  const total = all?.reduce((a, t) => a + t.imageIndexes.length, 0) ?? 0;
  check(total === 12 && !all.some((t) => t.seq === userSeq),
    'needs 999 → exactly the 12 tool images, user image never selected',
    `selected ${total}`);

  // Only user images left → nothing prunable → null (waterfall proceeds).
  const userOnly = [fixture[0], { seq: 2, type: 'user/message', content: [img('截图', 40, 0)] }];
  check(selectOffloadTargets(userOnly, 1, true) === null,
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
  // A decision targeting a user top-level image now APPLIES — non-cad
  // presets must replay stock decisions verbatim (protection lives in the
  // selector, dispatched by preset, not in the projection).
  const userCtx = {
    nodes: new Set([1]),
    events: [{ type: 'user/message', data: fixture[0].content }],
    baseSeq: 1,
    messages: new Map([[1, message(fixture[0].content)]]),
  };
  {
    const out = imageOffloadProjection.project({ data: { targets: [{ seq: 1, imageIndexes: [0] }] } }, userCtx);
    const images = out.get(1).content.filter((b) => b.type === 'image');
    check(images[0].offloaded === true,
      'a user-image decision still APPLIES (stock parity for non-cad presets)');
  }
}

// ── 3b. error-waterfall dispatch by preset ──────────────────────────────────
{
  const makeSession = (preset) => {
    const log = [];
    return {
      log, header: { agentPreset: preset },
      surface: { nodes: fixture.map((f) => f.seq) },
      eventAt: (seq) => fixture.find((f) => f.seq === seq),
      deriveEventMessage: (event) => ({ role: 'user', content: structuredClone(event.content) }),
      append: (type, data) => log.push({ type, data }),
    };
  };
  const cadSession = makeSession('cad');
  check(offloadOldestProtected(cadSession, fixture.map((f) => f.seq), 1) === true
    && JSON.stringify(cadSession.log[0].data.targets).includes('"seq":2'),
    'cad session: the executor spares the user image', JSON.stringify(cadSession.log));
  const stdSession = makeSession('standard');
  check(offloadOldestProtected(stdSession, fixture.map((f) => f.seq), 1) === true
    && JSON.stringify(stdSession.log[0].data.targets).includes(`"seq":${userSeq}`),
    'standard session: the executor behaves EXACTLY like stock (user image first)',
    JSON.stringify(stdSession.log));
}

// ── 4. the per-preset window (DESIGN §16.4, plan B′) ───────────────────────
{
  check(CAD_IMAGE_WINDOW === 24, 'the cad window mirrors the DeepSeek count budget', String(CAD_IMAGE_WINDOW));

  // A fake session over the SAME surface fixture: header carries the preset,
  // append() records durable decisions so the checker can inspect them.
  const makeSession = (preset) => {
    const log = [];
    return {
      log,
      header: { agentPreset: preset },
      surface: { nodes: fixture.map((f) => f.seq) },
      eventAt: (seq) => fixture.find((f) => f.seq === seq),
      deriveEventMessage: (event) => ({ role: 'user', content: structuredClone(event.content) }),
      append: (type, data) => log.push({ type, data }),
    };
  };

  const requestMessages = [
    { role: 'user', content: [{ type: 'text', text: '照这个做' }] },
    ...fixture.slice(1).map((f) => ({ role: 'user', content: [{ type: 'tool-result', content: structuredClone(f.content) }] })),
  ];
  check(countRetainedImages(requestMessages) === 12,
    'countRetainedImages walks tool results', String(countRetainedImages(requestMessages)));

  // 12 retained + 16 fresh user uploads = 28 → excess 4 over the 24 window.
  const overSession = makeSession('cad');
  const decision = enforceSessionWindow(
    { get: () => overSession },
    { sessionId: 's1', messages: [...requestMessages, { role: 'user', content: Array.from({ length: 16 }, (_, i) => img('extra', 30, i)) }] },
  );
  check(!!decision && decision.preset === 'cad' && decision.excess === 4 && decision.appended === true,
    'cad session over the window gets a proactive offload decision', JSON.stringify(decision));
  const decidedSeqs = overSession.log.flatMap((d) => d.data.targets.map((t) => t.seq));
  check(decidedSeqs.length > 0 && decidedSeqs.every((seq) => seq !== userSeq),
    'the window decision still spares the user reference image',
    JSON.stringify(decidedSeqs));

  const underSession = makeSession('cad');
  const under = enforceSessionWindow({ get: () => underSession }, { sessionId: 's1', messages: requestMessages });
  check(!!under && under.appended === false && under.excess <= 0,
    'cad session under the window is left alone', JSON.stringify(under));

  const std = makeSession('standard');
  check(enforceSessionWindow({ get: () => std }, { sessionId: 's1', messages: requestMessages }) === null,
    'a standard-mode session is NEVER proactively pruned (the fairness the user asked for)');

  // microscope5's real shape: the session was BORN standard and then switched to
  // 营造模式 while blank (the log has agent-preset/selected + 228 CAD tool
  // calls). The live projection says cad; the frozen header still says standard.
  // Reading the header disabled the window for exactly the sessions it exists
  // for — so the reader must be the projection (§13.14's rule, repeated).
  const switchedSession = makeSession('standard');
  const overMessages = [...requestMessages, { role: 'user', content: Array.from({ length: 16 }, (_, i) => img('extra', 30, i)) }];
  const headerOnly = enforceSessionWindow({ get: () => switchedSession }, { sessionId: 's1', messages: overMessages });
  check(headerOnly === null,
    'header-only reading (the bug): a switched-to-cad session is treated as standard');
  const projectionService = {
    stateOf: (session, key) => (key === 'agentPreset' ? 'cad' : undefined),
  };
  const viaProjection = enforceSessionWindow(
    { get: () => switchedSession }, { sessionId: 's1', messages: overMessages },
    (session) => presetOfSession(session, projectionService),
  );
  check(!!viaProjection && viaProjection.preset === 'cad' && viaProjection.appended === true,
    'projection reading (the fix): the SAME session gets its cad window',
    JSON.stringify(viaProjection));
  check(presetOfSession(switchedSession, projectionService) === 'cad',
    'presetOfSession prefers the live projection over the frozen header');
  check(presetOfSession(switchedSession, undefined) === 'standard',
    'presetOfSession falls back to the header when no projection service exists');
  check(enforceSessionWindow({}, { sessionId: 's1', messages: requestMessages }) === null,
    'no sessions service → not applicable');
}

// ── 4b. telemetry: every window observation is DATA (DESIGN §23.5) ─────────
// The microscope5 post-mortem could not answer "did the window run?" without
// the session log; this block proves the answer is now in a jsonl file, with
// the reason when it did NOT apply.
{
  const { mkdtempSync, readFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { applyProtectedImageOffload, presetOfSession } = await import('../src/host/image-offload.ts');

  const home = mkdtempSync(join(tmpdir(), 'cad-window-tel-'));
  process.env.DSH_HOME = home;

  // A session born standard that switched to cad — the microscope5 shape.
  const makeReal = () => {
    const log = [];
    return {
      log,
      header: { agentPreset: 'standard' },
      surface: { nodes: fixture.map((f) => f.seq) },
      eventAt: (seq) => fixture.find((f) => f.seq === seq),
      deriveEventMessage: (event) => ({ role: 'user', content: structuredClone(event.content) }),
      append: (type, data) => log.push({ type, data }),
    };
  };
  const cadSession = makeReal();
  const stdSession = makeReal();
  const sessions = {
    get: (id) => (id === 'cad-switched' ? cadSession : id === 'plain-std' ? stdSession : undefined),
    registerMessageProjection: () => {},
  };
  const handlers = {};
  const ctx = {
    reflect: {
      get: (name) => (name === 'sessions' ? sessions
        // Session-aware: ONLY the switched session reports cad; the other one
        // stays standard (a blanket 'cad' would hide the preset-not-cad path).
        : name === 'sessionProjections' ? {
            stateOf: (session, key) => (key === 'agentPreset'
              ? (session === cadSession ? 'cad' : 'standard')
              : undefined),
          }
        : undefined),
    },
    on: (event, cb) => { if (event === 'llm/stream') handlers.stream = cb; },
    logger: { info: () => {}, warn: () => {} },
  };
  applyProtectedImageOffload(ctx);
  check(typeof handlers.stream === 'function', 'the executor registers an llm/stream observer');

  // Same shape as the selection tests above (12 tool images + 16 fresh uploads).
  const baseMessages = [
    { role: 'user', content: [{ type: 'text', text: '照这个做' }] },
    ...fixture.slice(1).map((f) => ({ role: 'user', content: [{ type: 'tool-result', content: structuredClone(f.content) }] })),
  ];
  const overMessages = [...baseMessages, { role: 'user', content: Array.from({ length: 16 }, (_, i) => img('extra', 30, i)) }];
  const next = () => 'stream';
  // One observation at a time: concurrent calls for the SAME session are
  // deduplicated as in-flight (that is the guard, tested elsewhere).
  const tick = () => new Promise((r) => setTimeout(r, 30));
  handlers.stream({ sessionId: 'cad-switched', messages: overMessages }, next);   // applied
  await tick();
  handlers.stream({ sessionId: 'plain-std', messages: overMessages }, next);      // preset-not-cad
  await tick();
  handlers.stream({ sessionId: 'cad-switched', messages: baseMessages }, next);   // under-window (12 ≤ 24)
  await tick();
  handlers.stream({ purpose: 'session-title', sessionId: 'cad-switched', messages: overMessages }, next);
  handlers.stream({ messages: overMessages }, next);
  await new Promise((r) => setTimeout(r, 120));

  const file = join(home, 'cad', 'telemetry', 'image-window.jsonl');
  check(existsSync(file), 'window telemetry file is written', file);
  const recs = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const outcomes = recs.map((r) => r.outcome);
  check(outcomes.includes('applied'), 'an over-window cad session is recorded as applied', JSON.stringify(outcomes));
  check(outcomes.includes('preset-not-cad'),
    'a session that is NOT 营造模式 is recorded as preset-not-cad (the microscope5 case)', JSON.stringify(outcomes));
  check(outcomes.includes('under-window'), 'an under-window cad session is recorded as under-window');
  check(outcomes.includes('aux-purpose') && outcomes.includes('no-session'),
    'auxiliary calls and session-less calls are recorded with their reasons', JSON.stringify(outcomes));
  const applied = recs.find((r) => r.outcome === 'applied');
  check(applied?.preset === 'cad' && applied?.window === CAD_IMAGE_WINDOW && applied?.pruned > 0,
    'the applied record carries the window, the effective preset and what was pruned',
    JSON.stringify({ preset: applied?.preset, window: applied?.window, pruned: applied?.pruned }));
  check(cadSession.log.some((d) => d.type === 'image/offload'),
    'the applied decision really appended an image/offload event');

  const { imageWindowReport } = await import('../src/host/usage.ts');
  const summary = imageWindowReport();
  check(summary.records >= 5 && summary.byOutcome.applied >= 1,
    'the in-memory summary (exposed by /api/cad/usage) counts every outcome',
    JSON.stringify(summary.byOutcome));
  delete process.env.DSH_HOME;
}

// ── 5. composed tree: exactly one executor owns the seam ────────────────────
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
      check(/- id: preset-cad/.test(out) && !out.includes('maxImagesPerRequest'),
        'preset-cad lands and the llm-deepseek row stays UNPATCHED (factory defaults)');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
}

console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
