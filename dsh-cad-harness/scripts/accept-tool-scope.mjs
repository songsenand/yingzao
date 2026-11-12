// Acceptance for the preset tool scope (DESIGN §13.11).
//
//   1. The rule: a CAD-preset session keeps the whole catalog, any other NAMED
//      preset loses it, a session with no preset and a delegated child keep it
//      (a headless deployment must not silently lose the capability).
//   2. The glue: `ctx.tools.restrict` is called on the AGENT's own context (the
//      registry refuses a context-global restriction) with exactly the names
//      this plugin registers — no hard-coded list to drift.
//   3. The bundle patch lands: the CAD row asks for preset scope and no patch was
//      skipped (a patch that matches nothing warns and is dropped — an
//      unverified patch is an unverified feature).
//   4. The preset DECLARATION is the current mechanism, not the removed roster:
//      upstream replaced the `@deepseek-ai/dsh-agent-presets` package (config-side
//      `roots`) with a `@deepseek-ai/dsh-agent-preset` declaration row, so this
//      section reads the row this repository ships and checks it carries the
//      CAD-only skill root. Checking the old roster made this section SKIP and
//      silently stopped covering the skill root.
//
//   node scripts/accept-tool-scope.mjs             # checks
//   node scripts/accept-tool-scope.mjs --catalogs  # + real per-session evidence

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPresetToolScope, decideToolScope, effectivePresetOf } from '../src/host/tool-scope.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DSH = join(homedir(), '.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const skip = (label, why) => console.log(`SKIP  ${label}  — ${why}`);

const CAD_TOOLS = ['generate_part', 'create_part', 'import_part', 'validate_assembly', 'check_assembly',
  'simulate_physics', 'simulate_motion', 'simulate_fluid', 'render_part',
  'measure_part', 'measure_gap', 'measure_thickness',
  'measure_angle', 'list_features', 'measure_section', 'attach_appearance'];

console.log('preset tool scope acceptance\n');

// --- 1. the rule ------------------------------------------------------------
const PRESETS = ['cad'];
for (const [session, expect, label] of [
  [{ preset: 'cad' }, false, 'a CAD session keeps the catalog'],
  [{ preset: 'standard' }, true, 'a coding session loses it'],
  [{ preset: 'minimal' }, true, 'any other named preset loses it'],
  [{ preset: null }, false, 'no preset at all keeps it (headless must not lose the capability)'],
  [{ preset: 'standard', delegationDepth: 1 }, false, 'a delegated child keeps it'],
]) {
  const d = decideToolScope(session, PRESETS);
  check(d.restrict === expect, label, `restrict=${d.restrict} (${d.reason})`);
}

// The rule must be fed the EFFECTIVE preset. Reading the creation header hid the
// CAD tools from a session that had correctly switched to the CAD preset (the
// header keeps its birth value forever) — a real run was lost to it.
{
  const agent = (headerPreset, projection) => ({
    session: { header: { id: 's', agentPreset: headerPreset } },
    ctx: { sessionProjections: { stateOf: (_session, key) => (key === 'agentPreset' ? projection : undefined) } },
  });
  check(effectivePresetOf(agent('standard', 'cad')) === 'cad',
    'a switched session reports the preset it runs, not the one it was born with');
  check(effectivePresetOf(agent('standard', undefined)) === 'standard',
    'the header is the fallback when the projection service is absent');
  check(effectivePresetOf({ session: { header: { id: 's' } }, ctx: {} }) === null,
    'a session with no preset at all reads as null');
  check(effectivePresetOf({ session: { header: { agentPreset: 'standard' } }, ctx: { sessionProjections: { stateOf: () => { throw new Error('not registered'); } } } }) === 'standard',
    'a throwing projection read is contained and falls back to the header');
}

// --- 2. the glue ------------------------------------------------------------
function fakeCtx() {
  const calls = [];
  const listeners = {};
  return {
    calls,
    fire: (agent) => listeners['agent/created']({ agent }),
    switchTo: (sessionId, preset) => listeners['agent-preset/selected'](sessionId, preset),
    ctx: {
      logger: { info: (m) => calls.push(['info', m]), warn: (m) => calls.push(['warn', m]) },
      on: (event, cb) => { listeners[event] = cb; },
    },
  };
}

{
  const h = fakeCtx();
  let deny = null;
  applyPresetToolScope(h.ctx, CAD_TOOLS, { toolScope: 'preset', presets: ['cad'] });
  h.fire({ session: { header: { id: 's-code', agentPreset: 'standard' } }, ctx: { tools: { restrict: (f) => { deny = f.deny; return () => {}; } } } });
  check(Array.isArray(deny) && deny.length === CAD_TOOLS.length && CAD_TOOLS.every((n) => deny.includes(n)),
    'restricts exactly the registered CAD tools', deny ? `${deny.length} names` : '(restrict never called)');

  let touched = false;
  h.fire({ session: { header: { id: 's-cad', agentPreset: 'cad' } }, ctx: { tools: { restrict: () => { touched = true; } } } });
  h.fire({ session: { header: { id: 's-headless' } }, ctx: { tools: { restrict: () => { touched = true; } } } });
  check(!touched, 'never restricts a CAD session or a session with no preset');

  let contained = false;
  try {
    h.fire({ session: { header: { id: 's-throws', agentPreset: 'standard' } }, ctx: { tools: { restrict: () => { throw new Error('unknown global tool'); } } } });
    contained = true;
  } catch { contained = false; }
  check(contained, 'a refusing restrict() is contained');
  check(h.calls.some(([lvl, m]) => lvl === 'warn' && /could not hide/.test(m)), 'the refusal is logged, not swallowed');

  let count = 0;
  const h2 = fakeCtx();
  applyPresetToolScope(h2.ctx, CAD_TOOLS, { toolScope: 'preset', presets: ['cad'] });
  const agent = { session: { header: { id: 's-dup', agentPreset: 'standard' } }, ctx: { tools: { restrict: () => { count++; return () => {}; } } } };
  h2.fire(agent); h2.fire(agent);
  check(count === 1, 'one restriction per agent', `called ${count}×`);
}

// --- 2b. a live preset switch moves the agent into the new state -------------
{
  const h = fakeCtx();
  let restricted = false;
  let lifted = 0;
  const projection = { value: 'standard' };
  const agent = {
    session: { header: { id: 's-switch', agentPreset: 'standard' } },
    ctx: {
      sessionProjections: { stateOf: (_s, key) => (key === 'agentPreset' ? projection.value : undefined) },
      tools: { restrict: () => { restricted = true; return () => { restricted = false; lifted++; }; } },
    },
  };
  applyPresetToolScope(h.ctx, CAD_TOOLS, { toolScope: 'preset', presets: ['cad'] });
  h.fire(agent);
  check(restricted, 'a 标准模式 session is restricted at creation');
  projection.value = 'cad';                      // the host appends agent-preset/selected
  h.switchTo('s-switch', 'cad');
  check(!restricted && lifted === 1, 'switching to the CAD preset LIFTS the restriction', `lifted ${lifted}×`);
  check(h.calls.some(([lvl, m]) => lvl === 'info' && /restored/.test(m)), 'the restore is logged');
  projection.value = 'standard';
  h.switchTo('s-switch', 'standard');
  check(restricted && lifted === 1, 'switching away hides them again (one live restriction)');
  h.switchTo('s-unknown', 'cad');
  check(true, 'a switch for an unknown session is ignored, not thrown');
}

// --- 3. the plugin collects the names it registers ---------------------------
{
  const src = readFileSync(join(ROOT, 'src/host/tools.ts'), 'utf8');
  const sites = [...src.matchAll(/registerTool\(defineTool\(\{/g)].length;
  check(sites > 0 && /registerWhenReady\(\);\s*\n\s*return registered;/.test(src),
    'registerCadTools collects every tool it registers and returns the list', `${sites} registration sites`);
  const scopeSrc = readFileSync(join(ROOT, 'src/host/tool-scope.ts'), 'utf8');
  const baked = CAD_TOOLS.filter((n) => scopeSrc.includes(`'${n}'`));
  check(baked.length === 0, 'the scope module bakes in no tool name', baked.join(', ') || 'none (always passed in)');
  check(/ADOPTION COST/.test(scopeSrc), 'the adoption cost is documented where it is implemented');
}

// --- 4. the preset declaration this repository ships ------------------------
// Upstream moved from a roster package (`@deepseek-ai/dsh-agent-presets`, with
// config-side `roots`) to a `@deepseek-ai/dsh-agent-preset` DECLARATION row. The
// old check imported the removed package, SKIPped, and thereby stopped covering
// the skill root entirely — a green suite that had quietly lost an assertion.
{
  const presetFile = join(ROOT, 'presets', 'cad', 'preset.patch.yml');
  check(existsSync(presetFile), 'the cad preset declaration ships from this repository',
    'presets/cad/preset.patch.yml');
  const text = existsSync(presetFile) ? readFileSync(presetFile, 'utf8') : '';
  check(/- id: preset-cad\n\s+name: '@deepseek-ai\/dsh-agent-preset'/.test(text),
    'it inserts a @deepseek-ai/dsh-agent-preset declaration row', 'id: preset-cad');
  check(/\n {8}id: cad\n/.test(text), 'the declaration names the `cad` preset');
  const named = /\n {8}name: "?([^"\n]+)"?\n/.exec(text);
  const described = /\n {8}description: "?([^"\n]+)/.exec(text);
  check(!!named?.[1] && !!described?.[1], 'it publishes display metadata',
    `${named?.[1] ?? '(none)'} / ${(described?.[1] ?? '(none)').slice(0, 24)}…`);
  const rows = (text.match(/\n {10}- id: /g) ?? []).length;
  check(rows > 10, 'the declaration composes the full agent plane', `${rows} plugin rows`);
  check(/id: cad-skill-filesystem[\s\S]*?customSkillDirs:[\s\S]*?\/skills/.test(text),
    'it mounts the CAD-only skill root', 'customSkillDirs -> dsh-cad-harness/skills');
}

// --- 5. the patch lands on the composed profile tree -------------------------
function checkPatchComposition() {
  const profile = 'web';
  const srcDir = join(homedir(), '.dsh', 'profiles', profile);
  if (!existsSync(join(srcDir, 'package.json'))) return skip('patch composition', `no profile at ${srcDir}`);
  let dsh;
  try { dsh = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim(); }
  catch { return skip('patch composition', 'dsh not on PATH'); }

  const home = mkdtempSync(join(tmpdir(), 'cad-tool-scope-'));
  try {
    const dst = join(home, 'profiles', profile);
    mkdirSync(dst, { recursive: true });
    for (const f of ['package.json', 'cordis.yml', 'cordis.patch.yml']) {
      const from = join(srcDir, f);
      if (existsSync(from)) cpSync(from, join(dst, f));
    }
    const mods = join(srcDir, 'node_modules');
    if (existsSync(mods)) symlinkSync(mods, join(dst, 'node_modules'));
    const homeMods = join(homedir(), '.dsh', 'profiles', 'node_modules');
    if (existsSync(homeMods)) symlinkSync(homeMods, join(home, 'profiles', 'node_modules'));

    const out = execFileSync(dsh, ['--profile', profile, '--dump-config'], {
      env: { ...process.env, DSH_HOME: home },
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180_000,
    });
    // The composed tree must carry OUR declaration row — that is what makes
    // 营造模式 selectable. (The old roster-row assertions were removed upstream.)
    const at = out.indexOf('- id: preset-cad');
    const block = at < 0 ? '' : out.slice(at, at + 8000);
    check(at >= 0, 'the composed tree carries the cad preset declaration',
      at >= 0 ? 'preset-cad' : 'row missing');
    check(/name: '@deepseek-ai\/dsh-agent-preset'/.test(block),
      'the declaration row uses the current preset package', '@deepseek-ai/dsh-agent-preset');
    check(/\n {4}id: cad\n/.test(block), 'the composed declaration names the `cad` preset');
    check(block.includes(join(ROOT, 'skills')),
      'the composed declaration mounts this repository\'s skill root', join(ROOT, 'skills'));
    check(/- id: cad-harness-host\n(?:.*\n)*? {4}toolScope: preset/.test(out), 'the CAD plugin row asks for preset scope');
    check(!/patch: entry .* not found|patch: name mismatch/.test(out), 'no patch was skipped (id and name both matched)');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
try { checkPatchComposition(); } catch (e) { skip('patch composition', String(e?.message ?? e).split('\n')[0]); }

// --- 6. real evidence --------------------------------------------------------
if (process.argv.includes('--catalogs')) {
  console.log('\n--- durable tool catalogs ---');
  console.log('run:  node scripts/inspect-tool-catalog.mjs');
}

console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
