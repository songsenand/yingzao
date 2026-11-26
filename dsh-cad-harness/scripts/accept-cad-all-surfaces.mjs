#!/usr/bin/env node
// Phase 3d acceptance: all nine job surfaces, opt-in and full cutover.
//
// Contract (revised 2026-11-26, Q2): the counts here come from the surface
// METADATA, never from literals. The previous version asserted "39 tools",
// "48 (39 + 9)", and a per-surface op count typed into a table; adding one tool
// turned it red in six places and taught nothing (the real question is "is every
// tool routed, and did anything frozen disappear?"). The freeze itself lives in
// docs/TOOL-SURFACE-V1.json — this script checks the live ledger against it and
// fails only on a REMOVAL, which is what the 0.2.0 contract forbids.
//
// No CAD/Python is needed: registration and catalog/help are pure metadata.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER_PATH = join(ROOT, 'docs/TOOL-SURFACE-V1.json');

const home = mkdtempSync(join(tmpdir(), 'cad-all-surfaces-'));
process.env.DSH_HOME = home;
process.env.DSH_CAD_PYTHON = 'off';
const { registerCadToolsWithSurfaces } = await import('../src/host/register-with-surfaces.ts');

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

let ledger = null;
try { ledger = JSON.parse(readFileSync(LEDGER_PATH, 'utf8')); } catch { /* reported below */ }
check('freeze ledger loads (docs/TOOL-SURFACE-V1.json)', ledger !== null);

const base = capture(undefined);
check('default path still registers no surface', SURFACE_NAMES.every((name) => !base.has(name)));

// Coverage: the surface map is only trustworthy if every registered tool says
// where it lives. This replaces the old "default: 39 tools" literal.
const unlabelled = [...base.values()].filter((definition) => !definition.surface?.id).map((definition) => definition.name);
check('every registered tool declares a surface', unlabelled.length === 0, unlabelled.join(', '));
check('the ledger covers every registered tool',
  ledger !== null && [...base.keys()].every((name) => Object.hasOwn(ledger.tools, name)),
  [...base.keys()].filter((name) => !Object.hasOwn(ledger?.tools ?? {}, name)).join(', '));

const legacyNames = [...base.values()].map((definition) => definition.name);
const optIn = capture({ toolSurfaces: ALL });
check(`opt-in registers the nine surfaces on top of the ${base.size} legacy tools`,
  optIn.size === base.size + SURFACE_NAMES.length, `${optIn.size} vs ${base.size} + ${SURFACE_NAMES.length}`);
check('opt-in: all nine surfaces registered', SURFACE_NAMES.every((name) => optIn.has(name)));

const cutover = capture({ toolSurfaces: ALL, hideLegacy: legacyNames });
check('cutover: exactly one tool per surface', cutover.size === SURFACE_NAMES.length, String(cutover.size));
check('cutover: the tools are exactly the nine surface names',
  [...cutover.keys()].sort().join(',') === [...SURFACE_NAMES].sort().join(','),
  [...cutover.keys()].join(','));
check('cutover: no legacy tool leaks', legacyNames.every((name) => !cutover.has(name)));

const before = chars(base);
const after = chars(cutover);
check('cutover: schema is materially smaller', after < before / 2, `${after} vs ${before}`);
console.log(`  INFO nine-surface cutover: ${before} chars (${base.size}) -> ${after} chars (9), delta ${after - before}`);
if (ledger?.schemaCharsBudget) {
  check(`cutover: nine-surface schema within budget (${ledger.schemaCharsBudget} chars)`, after <= ledger.schemaCharsBudget, String(after));
}

// Per-surface op counts come from the metadata of the tools that declared the
// surface — the same source buildSurfaceFromToolMeta reads. A mismatch means a
// declared tool did not reach the catalog (or vice versa), not "someone added a
// tool and forgot to edit a table".
const declared = new Map(SURFACE_NAMES.map((name) => [name, []]));
for (const definition of base.values()) {
  const surface = definition.surface?.id;
  if (declared.has(surface)) declared.get(surface).push(definition.surface.action);
}
for (const [name, actions] of declared) {
  const definition = cutover.get(name);
  let catalog = null;
  try { catalog = await definition.execute({ action: 'catalog' }, {}); } catch { /* reported below */ }
  check(`${name}: catalog lists its ${actions.length} declared ops`,
    catalog?.ops?.length === actions.length, `${catalog?.ops?.length} vs ${actions.length}`);
  check(`${name}: catalog op names match the declaration`,
    JSON.stringify((catalog?.ops ?? []).map((row) => row.op).sort()) === JSON.stringify([...actions].sort()),
    (catalog?.ops ?? []).map((row) => row.op).join(','));

  // "Every action has an example" (Q2): catalog/help used to give required NAMES
  // only, so a caller still guessed the call shape.
  const missingExample = (catalog?.ops ?? []).filter((row) => typeof row.example !== 'string' || !row.example.includes(name));
  check(`${name}: every catalog action carries an example`, missingExample.length === 0,
    missingExample.map((row) => row.op).join(', '));
  const first = (catalog?.ops ?? [])[0];
  if (first) {
    const help = await definition.execute({ action: 'help', args: { op: first.op } }, {});
    check(`${name}: help repeats the example`, typeof help?.example === 'string' && help.example.includes(first.op));
  }

  // Frozen pairs are a floor, never a ceiling: additions are allowed (and are
  // reported by --write), a removal is the thing 0.2.0 forbids.
  const frozen = ledger?.surfaces?.[name];
  if (Array.isArray(frozen)) {
    const live = new Set(actions);
    const removed = frozen.filter((action) => !live.has(action));
    check(`${name}: no frozen action removed`, removed.length === 0, removed.join(', '));
    // The count in the description is derived; a spelled-out numeral means a
    // literal came back and will be wrong again with the next op.
    check(`${name}: description counts ops by derivation`, /\b\d+ ops?\b/.test(definition.description ?? ''),
      definition.description);
  }
}

const deliverCatalog = await cutover.get('cad_deliver').execute({ action: 'catalog' }, {});
check('cad_deliver is marked as the gate', deliverCatalog?.gate === true);

rmSync(home, { recursive: true, force: true });
console.log(failed ? `\naccept-cad-all-surfaces: ${failed} FAILURE(S)` : '\naccept-cad-all-surfaces: PASS');
process.exit(failed ? 1 : 0);
