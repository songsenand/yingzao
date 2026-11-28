#!/usr/bin/env node
// Acceptance: the pre-work brief gate (2026-11-28).
//
// The rule: before a session-bound design/evidence tool runs, the project must
// have a root `brief` with processes (non-empty), verify (non-empty) and
// buyVsMake (present). The tools that CREATE the brief (`cad_assembly write/info`)
// and reads are exempt; without that exemption the gate could never be satisfied.
//
//   node scripts/accept-brief-gate.mjs
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'cad-brief-gate-home-'));
const WORK = mkdtempSync(join(tmpdir(), 'cad-brief-gate-work-'));
process.env.DSH_HOME = HOME;
const PROJ = join(WORK, 'project');
mkdirSync(PROJ, { recursive: true });

const { registerCadToolsWithSurfaces } = await import('../src/host/register-with-surfaces.ts');
const { createProjectMarker, bindSessionToProject } = await import('../src/host/project.ts');

let passed = 0;
let failed = 0;
const check = (ok, label, detail = '') => {
  if (ok) { passed++; console.log(`  PASS ${label}`); }
  else { failed++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const tools = new Map();
const ctx = {
  tools: { register: (def) => { tools.set(def.name, def); return () => {}; } },
  connection: { fetch: { register: () => () => {} } },
  attachments: { saveImages: async (images) => images },
  reflect: { get: () => undefined },
  on: () => () => {},
  effect: (fn) => fn(),
  logger: { debug() {}, info() {}, warn() {}, error() {} },
};
registerCadToolsWithSurfaces(ctx, { toolSurfaces: ['part', 'assembly', 'check'], hideLegacy: 'all' });

await createProjectMarker(PROJ, 'brief gate fixture');
const exec = { agent: { session: { header: { id: 'brief-gate', cwd: PROJ } } } };
await bindSessionToProject(exec, PROJ);

const call = async (name, args) => {
  try { return { ok: true, value: await tools.get(name).execute(args, exec) }; }
  catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
};

console.log('--- before the brief: design/evidence tools are refused ---');
const roleBefore = await call('cad_part', { action: 'role', args: { part: 'x', role: 'printed' } });
check(!roleBefore.ok && /BOM gate/.test(roleBefore.error ?? ''), 'cad_part is refused with a BOM gate message', roleBefore.error);
check(/brief\.processes/.test(roleBefore.error ?? '') && /assembly\/assembly\.json/.test(roleBefore.error ?? ''),
  'the refusal names the missing field and the file to create', roleBefore.error);
check(/cad_assembly\(\{ action: "write"/.test(roleBefore.error ?? ''),
  'and shows the exact write call that satisfies it', roleBefore.error);
check(/\[brief-gate\]/.test(roleBefore.error ?? ''),
  'the envelope code is brief-gate, not invalid-input', roleBefore.error);
check(/write the kickoff brief first/.test(roleBefore.error ?? ''),
  'the hint tells the caller to write the brief, not to read a parameter', roleBefore.error);

const checkBefore = await call('cad_check', { action: 'parts', args: {} });
check(!checkBefore.ok && /BOM gate/.test(checkBefore.error ?? ''), 'cad_check is refused too', checkBefore.error);

const assemblyInfoBefore = await call('cad_assembly', { action: 'info', args: {} });
check(!/BOM gate/.test(assemblyInfoBefore.error ?? ''), 'cad_assembly info is not gated', assemblyInfoBefore.error);

console.log('--- the brief-creating write is exempt, and then the gate opens ---');
const brief = {
  processes: ['fdm-pla-0.4'],
  verify: ['assembly'],
  buyVsMake: [],
};
const write = await call('cad_assembly', {
  action: 'write',
  args: {
    mode: 'create', expectedRevision: 0, reason: 'kickoff brief',
    root: { kind: 'assembly', id: 'root', children: [], brief },
    manufacturing: { allowed: [{ id: 'fdm-pla-0.4' }], approvedBy: 'user' },
  },
});
check(write.ok, 'cad_assembly write creates the brief (not blocked by its own gate)', write.ok ? '' : write.error);

const roleAfter = await call('cad_part', { action: 'role', args: { part: 'x', role: 'printed' } });
check(!/BOM gate/.test(roleAfter.error ?? ''), 'after the brief, cad_part is no longer gated', roleAfter.error);

console.log('--- a later edit that drops a required field closes the gate again ---');
const manifestPath = join(PROJ, 'assembly', 'assembly.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
chmodSync(manifestPath, 0o644); // test fixture: edit past the seal
delete manifest.root.brief.verify;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
const roleNoVerify = await call('cad_part', { action: 'role', args: { part: 'x', role: 'printed' } });
check(!roleNoVerify.ok && /brief\.verify/.test(roleNoVerify.error ?? ''),
  'the gate names the field that is now missing', roleNoVerify.error);

console.log('--- escape hatch and unbound sessions ---');
process.env.DSH_CAD_BRIEF_GATE = 'off';
const off = await call('cad_part', { action: 'role', args: { part: 'x', role: 'printed' } });
check(!/BOM gate/.test(off.error ?? ''), 'DSH_CAD_BRIEF_GATE=off bypasses the gate (emergency hatch)', off.error);
delete process.env.DSH_CAD_BRIEF_GATE;

const unboundExec = { agent: { session: { header: { id: 'brief-gate-unbound', cwd: PROJ } } } };
try {
  const value = await tools.get('cad_part').execute({ action: 'role', args: { part: 'x', role: 'printed' } }, unboundExec);
  check(false, 'an unbound session must not be silently allowed', JSON.stringify(value));
} catch (error) {
  const text = String(error?.message ?? error);
  check(!/BOM gate/.test(text) && /select|No CAD project|bind/i.test(text),
    'an unbound session gets the selection error, not a BOM gate', text);
}

console.log(`\naccept-brief-gate: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
