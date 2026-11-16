#!/usr/bin/env node
// Phase 4 validation: can a surface be generated from tool-owned metadata?
//
// Production is unchanged. This captures the real 39 definitions, annotates only
// the four inspect tools with `surface`, and compares the generated surface with
// the hand-written cad_inspect surface. If they agree, the 9 hand tables can later
// be deleted.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cad-surface-meta-'));
process.env.DSH_HOME = home;
process.env.DSH_CAD_PYTHON = 'off';
const { registerCadTools } = await import('../src/host/tools.ts');
const { buildCadInspectSurface } = await import('../src/host/surface-inspect.ts');
const { buildSurfaceFromToolMeta } = await import('../src/host/surface.ts');

let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  PASS ${name}`);
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

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
registerCadTools(ctx);
check('real catalogue has 39 tools', tools.size === 39, String(tools.size));

const META = {
  measure: { id: 'cad_inspect', action: 'measure', summary: 'geometry truth' },
  list_features: { id: 'cad_inspect', action: 'features', summary: 'feature inventory' },
  scan_attention: { id: 'cad_inspect', action: 'attention', summary: 'where to look' },
  analyze: { id: 'cad_inspect', action: 'analyze', summary: 'point map' },
};
const annotated = tools;
const declared = [...annotated.values()].filter((tool) => tool.surface?.id === 'cad_inspect');
check('four tools declare cad_inspect', declared.length === 4, String(declared.length));

const generated = buildSurfaceFromToolMeta(
  'cad_inspect',
  'generated from tool metadata',
  annotated,
);
const hand = buildCadInspectSurface(annotated);
const generatedCatalog = await generated.execute({ action: 'catalog' }, {});
const handCatalog = await hand.execute({ action: 'catalog' }, {});

const normalize = (catalog) => catalog.ops
  .map((entry) => `${entry.op}->${entry.summary === undefined ? '' : entry.op}`)
  .sort();
const actionToTool = (catalog) => Object.fromEntries(catalog.ops.map((entry) => [entry.op, entry.summary]));
check('generated catalog has four ops', generatedCatalog.ops.length === 4);
check('generated and hand catalogs agree on ops',
  JSON.stringify(generatedCatalog.ops.map((entry) => entry.op).sort()) === JSON.stringify(handCatalog.ops.map((entry) => entry.op).sort()),
  JSON.stringify(generatedCatalog.ops));
check('generated help exposes the legacy measure fields',
  (await generated.execute({ action: 'help', args: { op: 'measure' } }, {}))?.parameters?.some((row) => row.name === 'kind' && row.required));
check('generated unknown action gets did-you-mean',
  await (async () => {
    try { await generated.execute({ action: 'mesure' }, {}); return false; }
    catch (error) { return /did you mean "measure"/.test(String(error?.message ?? error)); }
  })());
check('a surface with no metadata fails loudly',
  await (async () => {
    try { buildSurfaceFromToolMeta('cad_missing', 'x', tools); return false; }
    catch (error) { return /no tool declares/.test(String(error?.message ?? error)); }
  })());

rmSync(home, { recursive: true, force: true });
console.log(failed ? `\naccept-surface-meta: ${failed} FAILURE(S)` : '\naccept-surface-meta: PASS');
process.exit(failed ? 1 : 0);
