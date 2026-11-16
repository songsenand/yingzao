#!/usr/bin/env node
// Production cutover preflight: hideLegacy:'all' must leave exactly the 9 surfaces,
// both in the registry and in cadToolNames().

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cad-cutover-'));
process.env.DSH_HOME = home;
process.env.DSH_CAD_PYTHON = 'off';
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  PASS ${name}`);
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const { registerCadToolsWithSurfaces } = await import('../src/host/register-with-surfaces.ts');
const { cadToolNames } = await import('../src/host/tools.ts');
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
const names = registerCadToolsWithSurfaces(ctx, {
  toolSurfaces: ['session', 'part', 'assembly', 'check', 'simulate', 'inspect', 'see', 'python', 'deliver'],
  hideLegacy: 'all',
});
check('registry has exactly 9 tools', tools.size === 9, String(tools.size));
check('returned names are the 9 surfaces', names.length === 9 && names.every((name) => name.startsWith('cad_')), names.join(','));
check('cadToolNames has exactly the 9 surfaces', cadToolNames().length === 9 && cadToolNames().every((name) => name.startsWith('cad_')), cadToolNames().join(','));
check('no legacy name remains', [...tools.keys()].every((name) => name.startsWith('cad_')), [...tools.keys()].join(','));

rmSync(home, { recursive: true, force: true });
console.log(failed ? `\naccept-surface-cutover: ${failed} FAILURE(S)` : '\naccept-surface-cutover: PASS');
process.exit(failed ? 1 : 0);
