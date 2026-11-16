#!/usr/bin/env node
// Phase 1 prototype acceptance: cad_inspect over the four legacy definitions.
//
// The facade is not registered here — that is Phase 2. This script checks:
//   1. catalog/help are small and do not touch the legacy execute;
//   2. a real op delegates to the wrapped legacy tool (fake executor here);
//   3. unknown actions give did_you_mean, not a bare "unknown";
//   4. the facade schema is materially smaller than the four old schemas.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cad-inspect-facade-'));
process.env.DSH_HOME = home;
process.env.DSH_CAD_PYTHON = process.env.DSH_CAD_PYTHON || 'off';

const { buildCadInspectFacade, INSPECT_OPS } = await import('../src/host/facade-inspect.ts');
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  PASS ${name}`);
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

// Fake legacy defs prove delegation and forwarding without a CAD project.
const calls = [];
const fake = new Map(INSPECT_OPS.map((entry, index) => [entry.tool, {
  name: entry.tool,
  description: `legacy ${entry.tool}`,
  parameters: { versionId: { type: 'string', required: true, description: 'version id' } },
  execute: async (args, exec) => {
    calls.push({ tool: entry.tool, args, exec });
    return { op: entry.op, forwarded: args };
  },
}]));
const facade = buildCadInspectFacade(fake);

const catalog = await facade.execute({ action: 'catalog' }, {});
check('catalog lists 4 ops', Array.isArray(catalog?.ops) && catalog.ops.length === 4, JSON.stringify(catalog).slice(0, 120));
check('catalog does not execute legacy tools', calls.length === 0);
check('catalog includes required fields',
  catalog.ops.every((row) => Array.isArray(row.required) && row.required.includes('versionId')));

const help = await facade.execute({ action: 'help', args: { op: 'measure' } }, {});
check('help returns the legacy description', help?.description === 'legacy measure');
check('help returns parameter rows', help?.parameters?.[0]?.name === 'versionId' && help.parameters[0].required === true);
check('help does not execute legacy tools', calls.length === 0);

const delegated = await facade.execute({ action: 'features', args: { versionId: 'v002' } }, { tag: 'exec' });
check('op delegates to the legacy tool', calls.length === 1 && calls[0].tool === 'list_features');
check('op forwards args unchanged', calls[0].args.versionId === 'v002');
check('op forwards exec unchanged', calls[0].exec.tag === 'exec');
check('op returns the legacy value', delegated?.op === 'features' && delegated?.forwarded?.versionId === 'v002');

let unknown = '';
try { await facade.execute({ action: 'mesure', args: {} }, {}); } catch (error) { unknown = String(error?.message ?? error); }
check('unknown action suggests the nearest op', /did you mean "measure"/.test(unknown), unknown.slice(0, 160));
check('unknown action does not execute legacy tools', calls.length === 1);

let unknownHelp = '';
try { await facade.execute({ action: 'help', args: { op: 'mesure' } }, {}); } catch (error) { unknownHelp = String(error?.message ?? error); }
check('unknown help names the accepted ops', /\bmeasure\b/.test(unknownHelp), unknownHelp.slice(0, 160));

// Real schemas from the live registry, measured with the same JSON shape the
// audit uses. This is the Phase 1 token claim, not a hand-written estimate.
const tools = new Map();
const ctx = {
  tools: { register: (definition) => { tools.set(definition.name, definition); return () => {}; } },
  connection: { fetch: { register: () => (() => {}) } },
  attachments: { saveImages: async () => [] },
  reflect: { get: () => undefined },
  on: () => () => {},
  effect: (fn) => { try { fn(); } catch { /* ignore registration effects */ } },
  logger: { debug() {}, info() {}, warn() {}, error() {} },
};
const { registerCadTools } = await import('../src/host/tools.ts');
registerCadTools(ctx);
const realFacade = buildCadInspectFacade(tools);
const oldChars = INSPECT_OPS.reduce((sum, entry) => {
  const definition = tools.get(entry.tool);
  return sum + JSON.stringify({ name: definition.name, description: definition.description, parameters: definition.parameters }).length;
}, 0);
const newChars = JSON.stringify({ name: realFacade.name, description: realFacade.description, parameters: realFacade.parameters }).length;
check('real four tools are present', INSPECT_OPS.every((entry) => tools.has(entry.tool)));
check('facade schema is less than half the four old schemas', newChars * 2 < oldChars, `${newChars} vs ${oldChars}`);
console.log(`  INFO cad_inspect schema: ${newChars} chars; four legacy schemas: ${oldChars} chars`);

rmSync(home, { recursive: true, force: true });
console.log(failed ? `\naccept-cad-inspect-facade: ${failed} FAILURE(S)` : '\naccept-cad-inspect-facade: PASS');
process.exit(failed ? 1 : 0);
