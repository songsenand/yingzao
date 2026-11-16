#!/usr/bin/env node
// Phase 3d acceptance: all nine job surfaces, opt-in and full cutover.
//
// Default must stay 39. With all nine enabled and the 39 legacy names hidden,
// the model-facing surface is exactly 9. No CAD/Python is needed.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cad-all-surfaces-'));
process.env.DSH_HOME = home;
process.env.DSH_CAD_PYTHON = 'off';
const { registerCadToolsWithSurfaces } = await import('../src/host/register-with-surfaces.ts');
const { CAD_SURFACE_MEMBERS } = await import('../src/host/tool-surfaces.ts');

const ALL = ['session', 'part', 'assembly', 'check', 'simulate', 'inspect', 'see', 'python', 'deliver'];
const SURFACE_NAMES = ['cad_session', 'cad_part', 'cad_assembly', 'cad_check', 'cad_simulate', 'cad_inspect', 'cad_see', 'cad_python', 'cad_deliver'];

let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  PASS ${name}`);
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
function capture(scope) {
  const tools = new Map();
  const ctx = {
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {}; } },
    connection: { fetch: { register: () => (() => {}) } },
    attachments: { saveImages: async () => [] },
    reflect: { get: () => undefined },
    on: () => () => {},
    effect: (fn) => { try { fn(); } catch { /* ignore */ } },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
  registerCadToolsWithSurfaces(ctx, scope);
  return tools;
}
const chars = (map) => [...map.values()].reduce((sum, definition) => sum + JSON.stringify({
  name: definition.name,
  description: definition.description,
  parameters: definition.parameters,
}).length, 0);

const base = capture(undefined);
check('default: 39 tools', base.size === 39, String(base.size));
check('default: no surface registered', SURFACE_NAMES.every((name) => !base.has(name)));

const optIn = capture({ toolSurfaces: ALL });
check('opt-in: 48 tools (39 + 9 surfaces)', optIn.size === 48, String(optIn.size));
check('opt-in: all nine surfaces registered', SURFACE_NAMES.every((name) => optIn.has(name)));

const cutover = capture({ toolSurfaces: ALL, hideLegacy: CAD_SURFACE_MEMBERS });
check('cutover: exactly 9 tools', cutover.size === 9, String(cutover.size));
check('cutover: the nine are the surface names',
  [...cutover.keys()].sort().join(',') === [...SURFACE_NAMES].sort().join(','),
  [...cutover.keys()].join(','));
check('cutover: no legacy tool leaks', CAD_SURFACE_MEMBERS.every((name) => !cutover.has(name)));

const before = chars(base);
const after = chars(cutover);
check('cutover: schema is materially smaller', after < before / 2, `${after} vs ${before}`);
console.log(`  INFO nine-surface cutover: ${before} chars (39) -> ${after} chars (9), delta ${after - before}`);

const expectedCounts = {
  cad_session: 4,
  cad_part: 6,
  cad_assembly: 4,
  cad_check: 7,
  cad_simulate: 5,
  cad_inspect: 4,
  cad_see: 3,
  cad_python: 2,
  cad_deliver: 4,
};
for (const [name, count] of Object.entries(expectedCounts)) {
  const definition = cutover.get(name);
  const catalog = await definition.execute({ action: 'catalog' }, {});
  check(`${name}: ${count} ops`, catalog?.ops?.length === count, String(catalog?.ops?.length));
}
const deliverCatalog = await cutover.get('cad_deliver').execute({ action: 'catalog' }, {});
check('cad_deliver is marked as the gate', deliverCatalog?.gate === true);

rmSync(home, { recursive: true, force: true });
console.log(failed ? `\naccept-cad-all-surfaces: ${failed} FAILURE(S)` : '\naccept-cad-all-surfaces: PASS');
process.exit(failed ? 1 : 0);
