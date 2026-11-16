#!/usr/bin/env node
// Phase 3b acceptance: cad_check + cad_simulate opt-in and cutover arithmetic.
//
// No CAD/Python needed: registration, catalog/help and schema deltas are the subject.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cad-check-sim-'));
process.env.DSH_HOME = home;
process.env.DSH_CAD_PYTHON = 'off';
const { registerCadToolsWithFacades } = await import('../src/host/register-with-facades.ts');
const { CHECK_OPS } = await import('../src/host/facade-check.ts');
const { SIMULATE_OPS } = await import('../src/host/facade-simulate.ts');
const { INSPECT_OPS } = await import('../src/host/facade-inspect.ts');

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
  registerCadToolsWithFacades(ctx, scope);
  return tools;
}
const chars = (map) => [...map.values()].reduce((sum, definition) => sum + JSON.stringify({
  name: definition.name,
  description: definition.description,
  parameters: definition.parameters,
}).length, 0);

const base = capture(undefined);
check('default: 39 tools', base.size === 39, String(base.size));
const added = capture({ toolFacades: ['check', 'simulate'] });
check('opt-in: 41 tools (39 + 2 facades)', added.size === 41, String(added.size));
check('check facade registered', added.has('cad_check'));
check('simulate facade registered', added.has('cad_simulate'));

const checkDef = added.get('cad_check');
const simulateDef = added.get('cad_simulate');
const checkCatalog = await checkDef.execute({ action: 'catalog' }, {});
const simulateCatalog = await simulateDef.execute({ action: 'catalog' }, {});
check('check catalog has 7 ops', checkCatalog?.ops?.length === 7, String(checkCatalog?.ops?.length));
check('simulate catalog has 5 ops', simulateCatalog?.ops?.length === 5, String(simulateCatalog?.ops?.length));
check('check help exposes the legacy fields',
  (await checkDef.execute({ action: 'help', args: { op: 'printability' } }, {}))?.parameters?.some((row) => row.name === 'versionId'));
check('simulate help exposes the legacy fields',
  (await simulateDef.execute({ action: 'help', args: { op: 'motion' } }, {}))?.parameters?.some((row) => row.name === 'parts'));

let unknown = '';
try { await checkDef.execute({ action: 'printabilty', args: {} }, {}); } catch (error) { unknown = String(error?.message ?? error); }
check('check unknown action suggests printability', /did you mean "printability"/.test(unknown), unknown.slice(0, 140));

const hidden = [
  ...CHECK_OPS.map((entry) => entry.tool),
  ...SIMULATE_OPS.map((entry) => entry.tool),
];
const cutover = capture({ toolFacades: ['check', 'simulate'], hideLegacy: hidden });
check('cutover: 29 tools (39 - 12 old + 2 facades)', cutover.size === 29, String(cutover.size));
check('cutover: old check/simulate tools hidden', hidden.every((name) => !cutover.has(name)));
const before = chars(base);
const after = chars(cutover);
check('cutover: net schema is smaller', after < before, `${after} vs ${before}`);
console.log(`  INFO check+simulate cutover: ${before} chars (39) -> ${after} chars (29), delta ${after - before}`);
check('cutover: both facades remain', cutover.has('cad_check') && cutover.has('cad_simulate'));

const allHidden = [...INSPECT_OPS, ...CHECK_OPS, ...SIMULATE_OPS].map((entry) => entry.tool);
const three = capture({
  toolFacades: ['inspect', 'check', 'simulate'],
  hideLegacy: allHidden,
});
check('three facades: 26 tools (39 - 16 old + 3)', three.size === 26, String(three.size));
check('three facades: all three remain',
  ['cad_inspect', 'cad_check', 'cad_simulate'].every((name) => three.has(name)));
check('three facades: old 16 are hidden', allHidden.every((name) => !three.has(name)));
check('three facades: net schema is smaller than check+sim alone', chars(three) < after,
  `${chars(three)} vs ${after}`);
console.log(`  INFO three facades: ${before} chars (39) -> ${chars(three)} chars (26), delta ${chars(three) - before}`);

rmSync(home, { recursive: true, force: true });
console.log(failed ? `\naccept-cad-check-simulate: ${failed} FAILURE(S)` : '\naccept-cad-check-simulate: PASS');
process.exit(failed ? 1 : 0);
