#!/usr/bin/env node
// Acceptance: the model-facing error copy must name CALLS THAT EXIST.
//
// WHY (2026-11-27): a session called cad_python without selecting a project. The
// error told it to call `bind_project` / `init_project` — internal op names that the
// 2026-11-16 facade cutover removed from the model catalog. The model translated the
// hint to `cad_session bind`, guessed the wrong branch (the target had no marker),
// and failed a SECOND time. A hint the model cannot execute is not a hint.
//
// This test is the negative sample for that class:
//   1. the no-selection error states the cwd/ancestor state and the exact call(s);
//   2. no hidden op name (`bind_project`, `project_info`, `run_python`, ...) appears
//      in any registered tool description or in the errors exercised below;
//   3. a surface re-wraps its legacy tool without doubling `[tool-failed]` or
//      re-introducing the legacy stage name.
//
//   node scripts/accept-error-copy.mjs
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'cad-error-copy-home-'));

const {
  resolveProjectCwd, configureWorkingDirectoryService, createProjectMarker,
  projectInfoFor, bindSessionToProject, clearSessionBindingCache,
} = await import('../src/host/project.ts');
const { registerCadToolsWithSurfaces } = await import('../src/host/register-with-surfaces.ts');
const { withOutputContract } = await import('../src/host/tool-contract.ts');

let passed = 0;
let failed = 0;
const check = (ok, label, detail = '') => {
  if (ok) { passed++; console.log(`  PASS ${label}`); }
  else { failed++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** Op names that are NOT callable after the 2026-11-16 cutover. */
const HIDDEN = /(^|[^a-z0-9_])(bind_project|init_project|project_info|set_project_kernel|run_python|python_runtime)([^a-z0-9_]|$)/;
/** Every hidden tool name that is unambiguously a tool (not an English word). */
const HIDDEN_TOOL = /(^|[^a-z0-9_])(create_part|request_review|import_part|merge_parts|set_datums|set_part_role|write_assembly|suggest_interfaces|validate_assembly|simulate_physics|simulate_fluid|simulate_lbm|render_part|review_visual|attach_appearance|measure_thickness|check_sheet2d|check_turning|check_cnc_access|check_edm_access|measure_angle|check_printability|check_parts|check_sweep|simulate_stress|scan_stress_hotspots|scan_attention|delivery_audit|retire_run|affected_checks|pearl_run|check_appearance|check_assembly|recall_reference_image|generate_part)([^a-z0-9_]|$)/;
/** The nine callable surfaces; any other cad_* token in copy is a dead end. */
const SURFACES = new Set([
  'cad_session', 'cad_part', 'cad_assembly', 'cad_check', 'cad_simulate',
  'cad_inspect', 'cad_see', 'cad_python', 'cad_deliver',
]);
const real = (path) => { try { return realpathSync(path); } catch { return path; } };
const execOf = (header) => ({ agent: { session: { header } } });
const useLiveCwd = (live) => { configureWorkingDirectoryService({ ensure: async () => live }); };
const messageOf = async (fn) => {
  try { await fn(); return ''; } catch (error) { return String(error?.message ?? error); }
};
const callableIn = (text) => [...text.matchAll(/\bcad_[a-z]+\b/g)].map((m) => m[0]);
const deadSurfaces = (text) => callableIn(text).filter((name) => !SURFACES.has(name));

const base = mkdtempSync(join(tmpdir(), 'cad-error-copy-'));
const parent = join(base, 'parent');
mkdirSync(join(parent, 'cad-data'), { recursive: true });
writeFileSync(join(parent, 'cad-data', 'project.json'), '{}\n');
const sub = join(parent, 'new-part');
mkdirSync(sub, { recursive: true });
const workspace = join(base, 'workspace');
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, 'cad-workspace.json'), JSON.stringify({ schemaVersion: 1, kind: 'workspace' }));
const lonely = join(base, 'lonely');
mkdirSync(lonely, { recursive: true });

console.log('--- no selection: state + the exact call ---');
{
  useLiveCwd(sub);
  const msg = await messageOf(() => resolveProjectCwd(execOf({ id: 'unbound-sub', cwd: sub }), { requireSelection: true }));
  check(/No CAD project is selected/.test(msg), 'the refusal keeps its stable prefix', msg.slice(0, 120));
  check(msg.includes(`cad_session({ action: "init", args: { dir: "${real(sub)}" } })`),
    'it names the init call that makes the cwd a project', msg);
  check(msg.includes(`cad_session({ action: "bind", args: { dir: "${real(parent)}" } })`),
    'it names the bind call for the existing ancestor', msg);
  check(new RegExp(`inside the project ${real(parent).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(msg),
    'it says the cwd is INSIDE a project (the fact the old hint omitted)', msg);
  check(!HIDDEN.test(msg), 'it never names a pre-cutover op', msg);
  check(deadSurfaces(msg).length === 0, 'every cad_* name it mentions is a real surface', deadSurfaces(msg).join(','));
}
{
  useLiveCwd(parent);
  const msg = await messageOf(() => resolveProjectCwd(execOf({ id: 'unbound-root', cwd: parent }), { requireSelection: true }));
  check(msg.includes(`cad_session({ action: "bind", args: { dir: "${real(parent)}" } })`),
    'a cwd that IS a project is offered bind, not a branch', msg);
  check(/is itself a CAD project/.test(msg), 'and says why', msg);
}
{
  useLiveCwd(workspace);
  const msg = await messageOf(() => resolveProjectCwd(execOf({ id: 'unbound-ws', cwd: workspace }), { requireSelection: true }));
  check(/WORKSPACE/.test(msg) && msg.includes(`cad_session({ action: "init", args: { dir: "${real(workspace)}/my-part" } })`),
    'a workspace cwd names a concrete init target', msg);
  check(!HIDDEN.test(msg), 'workspace copy has no hidden op name', msg);
}
{
  useLiveCwd(lonely);
  const msg = await messageOf(() => resolveProjectCwd(execOf({ id: 'unbound-new', cwd: lonely }), { requireSelection: true }));
  check(/Nothing here or above/.test(msg) && msg.includes(`cad_session({ action: "init", args: { dir: "${real(lonely)}" } })`),
    'a fresh directory names init on itself', msg);
}

console.log('--- bind: the precondition is in the error ---');
{
  useLiveCwd(sub);
  const msg = await messageOf(() => bindSessionToProject(execOf({ id: 'bind-nomarker', cwd: sub }), sub));
  check(msg.includes(`cad_session({ action: "init", args: { dir: "${real(sub)}" } })`),
    'binding a marker-less directory names init (not "then bind")', msg);
  check(!HIDDEN.test(msg), 'no hidden op name', msg);
}
{
  useLiveCwd(workspace);
  const msg = await messageOf(() => bindSessionToProject(execOf({ id: 'bind-ws', cwd: workspace }), workspace));
  check(msg.includes(`cad_session({ action: "init", args: { dir: "${real(workspace)}/my-part" } })`),
    'binding a workspace names a member init target', msg);
  check(!HIDDEN.test(msg), 'no hidden op name', msg);
}

console.log('--- project_info: the read path says the same thing ---');
{
  useLiveCwd(sub);
  const info = await projectInfoFor(execOf({ id: 'info-sub', cwd: sub }));
  check(info.selected === false, 'the unbound session reports selected:false');
  check(!HIDDEN.test(info.note), 'its note names no hidden op', info.note);
  check(info.note.includes(`cad_session({ action: "init", args: { dir: "${real(sub)}" } })`),
    'its note carries the exact init call', info.note);
}

console.log('--- the sanctioned path actually resolves ---');
{
  useLiveCwd(sub);
  const made = await createProjectMarker(sub, 'new part');
  check(made.created === true, 'init creates the marker');
  await bindSessionToProject(execOf({ id: 'after-init', cwd: sub }), sub);
  const resolved = await resolveProjectCwd(execOf({ id: 'after-init', cwd: sub }), { requireSelection: true });
  check(resolved.cwd === real(sub), 'the session then resolves to the new project', resolved.cwd);
  clearSessionBindingCache();
}

console.log('--- surface wrapping: one prefix, callable stage ---');
{
  const inner = withOutputContract({
    name: 'run_python',
    output: { schema: { type: 'object' } },
    execute: async () => { throw new Error('No CAD project is selected for this session.'); },
  });
  const outer = withOutputContract({
    name: 'cad_python',
    output: { schema: { type: 'object' } },
    execute: async (args, exec) => inner.execute(args, exec),
  });
  const msg = await messageOf(() => outer.execute({ action: 'run' }, {}));
  check((msg.match(/\[tool-failed\]/g) ?? []).length === 1, 'the prefix appears exactly once', msg);
  check(msg.startsWith('[tool-failed] cad_python action=run:'), 'the stage is the callable surface + action', msg.slice(0, 80));
  check(!/run_python/.test(msg), 'the legacy op name is gone from the text', msg);
  check((msg.match(/hint:/g) ?? []).length === 1, 'the hint appears exactly once', msg);
}

{
  // A legacy body that prefixes its own name must not survive the surface layer.
  const inner = withOutputContract({
    name: 'set_datums',
    output: { schema: { type: 'object' } },
    execute: async () => { throw new Error('set_datums: no usable anchors in the request'); },
  });
  const outer = withOutputContract({
    name: 'cad_assembly',
    output: { schema: { type: 'object' } },
    execute: async (args, exec) => inner.execute(args, exec),
  });
  const msg = await messageOf(() => outer.execute({ action: 'datums', args: {} }, {}));
  check(msg.startsWith('[tool-failed] cad_assembly action=datums: no usable anchors'),
    'a legacy self-prefix is dropped at the surface layer', msg);
  check(!/set_datums/.test(msg), 'the dead op name is gone from the cause', msg);
}

console.log('--- registered descriptions: no dead tool names ---');
{
  const collected = new Map();
  const ctx = {
    tools: { register: (def) => { collected.set(def.name, def); return () => {}; } },
    on: () => {},
    effect: (fn) => fn(),
    attachments: { saveImages: async (images) => images.map((img) => ({ attachmentId: 'test', mediaType: 'image/png', bytes: 1, name: img.name })) },
    reflect: {
      get: (k) => (k === 'agentPresets' ? { list: async () => [{ id: 'cad', name: 'cad' }] }
        : k === 'connection' ? { fetch: { register: () => () => {} }, rpc: { intercept: () => () => {} } } : undefined),
    },
  };
  registerCadToolsWithSurfaces(ctx, {
    toolScope: 'preset', presets: ['cad'],
    toolSurfaces: ['session', 'part', 'assembly', 'check', 'simulate', 'inspect', 'see', 'python', 'deliver'],
    hideLegacy: 'all',
  });
  check([...collected.keys()].includes('cad_session'), 'the session surface is registered');
  const offenders = [];
  for (const def of collected.values()) {
    if (HIDDEN.test(def.description ?? '')) offenders.push(def.name);
    if (deadSurfaces(def.description ?? '').length) offenders.push(`${def.name} (unknown cad_*)`);
  }
  check(offenders.length === 0, 'no description names a pre-cutover op or an unknown cad_* surface', offenders.join(', '));

  // Every catalog + help reply is model-visible: it must not resurrect a dead name.
  let helpChecked = 0;
  for (const surface of collected.values()) {
    if (!String(surface.name).startsWith('cad_')) continue;
    const catalog = JSON.stringify(await surface.execute({ action: 'catalog' }, execOf({ id: 'catalog', cwd: sub })));
    check(!HIDDEN.test(catalog), `${surface.name} catalog names no hidden op`, catalog.slice(0, 160));
    check(!HIDDEN_TOOL.test(catalog), `${surface.name} catalog names no legacy tool`, catalog.slice(0, 160));
    for (const op of JSON.parse(catalog).ops ?? []) {
      const help = JSON.stringify(await surface.execute({ action: 'help', args: { op: op.op } }, execOf({ id: 'help', cwd: sub })));
      check(!HIDDEN.test(help), `${surface.name} help "${op.op}" names no hidden op`, help.slice(0, 160));
      check(!HIDDEN_TOOL.test(help), `${surface.name} help "${op.op}" names no legacy tool`, help.slice(0, 160));
      check(deadSurfaces(help).length === 0, `${surface.name} help "${op.op}" only names real surfaces`, deadSurfaces(help).join(','));
      helpChecked++;
    }
  }
  check(helpChecked > 30, 'every op help was inspected, not a sample', `${helpChecked} ops`);

  // The real delegation path, through the surface, still produces one envelope.
  const surface = collected.get('cad_check');
  const msg = await messageOf(() => surface.execute({ action: 'parts', args: { versionIds: ['v001'], checks: ['measure'] } }, execOf({ id: 'surface-unbound', cwd: sub })));
  check(msg.includes('[tool-failed] cad_check action=parts:'), 'the surface stage is callable', msg.slice(0, 100));
  check((msg.match(/\[tool-failed\]/g) ?? []).length === 1, 'exactly one prefix through the real surface', msg);
  check(!HIDDEN.test(msg), 'the real error has no hidden op name', msg);
}

console.log(`\naccept-error-copy: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
