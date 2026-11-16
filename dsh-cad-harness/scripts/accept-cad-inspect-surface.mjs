#!/usr/bin/env node
// Phase 1 prototype acceptance: cad_inspect over the four legacy definitions.
//
// The surface is not registered here — that is Phase 2. This script checks:
//   1. catalog/help are small and do not touch the legacy execute;
//   2. a real op delegates to the wrapped legacy tool (fake executor here);
//   3. unknown actions give did_you_mean, not a bare "unknown";
//   4. the surface schema is materially smaller than the four old schemas.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cad-inspect-surface-'));
process.env.DSH_HOME = home;
process.env.DSH_CAD_PYTHON = process.env.DSH_CAD_PYTHON || 'off';

const { buildCadInspectSurface } = await import('../src/host/surface-inspect.ts');
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  PASS ${name}`);
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

// Fake legacy defs prove delegation and forwarding without a CAD project.
const calls = [];
const fakeSpecs = [
  ['measure', 'measure'],
  ['list_features', 'features'],
  ['scan_attention', 'attention'],
  ['analyze', 'analyze'],
];
const fake = new Map(fakeSpecs.map(([tool, action]) => [tool, {
  name: tool,
  description: `legacy ${tool}`,
  parameters: { versionId: { type: 'string', required: true, description: 'version id' } },
  surface: { id: 'cad_inspect', action },
  execute: async (args, exec) => {
    calls.push({ tool, args, exec });
    return { op: action, forwarded: args };
  },
}]));
const surface = buildCadInspectSurface(fake);

const catalog = await surface.execute({ action: 'catalog' }, {});
check('catalog lists 4 ops', Array.isArray(catalog?.ops) && catalog.ops.length === 4, JSON.stringify(catalog).slice(0, 120));
check('catalog does not execute legacy tools', calls.length === 0);
check('catalog includes required fields',
  catalog.ops.every((row) => Array.isArray(row.required) && row.required.includes('versionId')));

const help = await surface.execute({ action: 'help', args: { op: 'measure' } }, {});
check('help returns the legacy description', help?.description === 'legacy measure');
check('help returns parameter rows', help?.parameters?.[0]?.name === 'versionId' && help.parameters[0].required === true);
const stringHelp = await surface.execute({ action: 'help', args: '{"op":"measure"}' }, {});
check('stringified help op resolves', stringHelp?.description === 'legacy measure');
check('help does not execute legacy tools', calls.length === 0);

const delegated = await surface.execute({ action: 'features', args: { versionId: 'v002' } }, { tag: 'exec' });
check('op delegates to the legacy tool', calls.length === 1 && calls[0].tool === 'list_features');
check('op forwards args unchanged', calls[0].args.versionId === 'v002');
check('op forwards exec unchanged', calls[0].exec.tag === 'exec');
check('op returns the legacy value', delegated?.op === 'features' && delegated?.forwarded?.versionId === 'v002');

// Models send the JSON-typed `args` as a JSON string as often as an object.
// Both must reach the legacy body; this was the production failure mode.
const stringArgs = await surface.execute({ action: 'measure', args: '{"versionId":"v003"}' }, {});
check('stringified args reach the legacy tool', calls.length === 2 && calls[1].tool === 'measure' && calls[1].args.versionId === 'v003');
check('stringified args return the legacy value', stringArgs?.op === 'measure' && stringArgs?.forwarded?.versionId === 'v003');

let unknown = '';
try { await surface.execute({ action: 'mesure', args: {} }, {}); } catch (error) { unknown = String(error?.message ?? error); }
check('unknown action suggests the nearest op', /did you mean "measure"/.test(unknown), unknown.slice(0, 160));
check('unknown action does not execute legacy tools', calls.length === 2);

let unknownHelp = '';
try { await surface.execute({ action: 'help', args: { op: 'mesure' } }, {}); } catch (error) { unknownHelp = String(error?.message ?? error); }
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
const realSurface = buildCadInspectSurface(tools);
const inspectTools = [...tools.values()].filter((definition) => definition.surface?.id === 'cad_inspect');
const oldChars = inspectTools.reduce((sum, definition) => {
  return sum + JSON.stringify({ name: definition.name, description: definition.description, parameters: definition.parameters }).length;
}, 0);
const newChars = JSON.stringify({ name: realSurface.name, description: realSurface.description, parameters: realSurface.parameters }).length;
check('real four tools declare cad_inspect', inspectTools.length === 4, String(inspectTools.length));
check('surface schema is less than half the four old schemas', newChars * 2 < oldChars, `${newChars} vs ${oldChars}`);
console.log(`  INFO cad_inspect schema: ${newChars} chars; four legacy schemas: ${oldChars} chars`);

rmSync(home, { recursive: true, force: true });
console.log(failed ? `\naccept-cad-inspect-surface: ${failed} FAILURE(S)` : '\naccept-cad-inspect-surface: PASS');
process.exit(failed ? 1 : 0);
