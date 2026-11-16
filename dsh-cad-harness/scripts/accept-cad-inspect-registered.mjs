#!/usr/bin/env node
// Phase 2 acceptance: opt-in registration of cad_inspect next to the legacy tools.
//
//   no flag  -> 39 legacy tools, no cad_inspect (production unchanged)
//   flag     -> 40 tools: 39 legacy + cad_inspect (transition, not yet a cutover)
//
// Registration is the Phase 2 subject. A real measure needs the shared Python runtime;
// this acceptance deliberately keeps DSH_CAD_PYTHON=off and reports SKIP, while the
// dispatcher delegation itself is covered by accept-cad-inspect-facade.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cad-inspect-reg-'));
process.env.DSH_HOME = home;
process.env.DSH_CAD_PYTHON = 'off';

const { registerCadToolsWithFacades } = await import('../src/host/register-with-facades.ts');
const { saveVersion } = await import('../src/host/version.ts');
const { ensurePart, attachVersion } = await import('../src/host/parts.ts');
const { projectStores } = await import('../src/host/project.ts');

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

const before = capture(undefined);
check('default: 39 legacy tools', before.size === 39, String(before.size));
check('default: cad_inspect is NOT registered', !before.has('cad_inspect'));

const after = capture({ toolFacades: ['inspect'] });
check('opt-in: 40 tools (39 legacy + facade)', after.size === 40, String(after.size));
check('opt-in: cad_inspect is registered', after.has('cad_inspect'));
check('opt-in: four legacy inspect tools remain',
  ['measure', 'list_features', 'scan_attention', 'analyze'].every((name) => after.has(name)));

const facade = after.get('cad_inspect');
const catalog = await facade.execute({ action: 'catalog' }, {});
check('facade catalog lists four ops', catalog?.ops?.length === 4, JSON.stringify(catalog).slice(0, 100));
const help = await facade.execute({ action: 'help', args: { op: 'measure' } }, {});
check('facade help exposes measure kind', help?.parameters?.some((row) => row.name === 'kind' && row.required));
let unknown = '';
try { await facade.execute({ action: 'mesure', args: {} }, {}); } catch (error) { unknown = String(error?.message ?? error); }
check('facade unknown action suggests measure', /did you mean "measure"/.test(unknown), unknown.slice(0, 120));

// A minimal box version, written directly (no Python / OpenSCAD dependency).
function boxStl(dx, dy, dz) {
  const hx = dx / 2, hy = dy / 2, hz = dz / 2;
  const v = [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
    [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buf = Buffer.alloc(84 + 12 * 50);
  buf.write('cad-inspect-reg fixture', 0);
  buf.writeUInt32LE(12, 80);
  let o = 84;
  for (const [i, j, k] of faces) {
    const a = v[i], b = v[j], c = v[k];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(...n) || 1;
    for (const p of [n.map((x) => x / len), a, b, c]) {
      for (const x of p) { buf.writeFloatLE(x, o); o += 4; }
    }
    o += 2;
  }
  return buf;
}

const workspace = join(home, 'workspace');
const exec = { agent: { session: { header: { id: 'cad-inspect-reg', cwd: workspace } } } };
const init = await after.get('init_project').execute({ dir: workspace }, exec);
check('fixture project is selected', init?.bound === true, JSON.stringify(init).slice(0, 120));

const stores = projectStores(workspace);
const part = await ensurePart(stores.partStore, 'box', 'accept-cad-inspect');
const version = await saveVersion(stores.store, {
  stl: boxStl(20, 20, 20),
  userIntent: 'cad_inspect registration fixture',
  partId: part.id,
});
await attachVersion(stores.partStore, part.id, version);

console.log('  SKIP real measure — the Python runtime is intentionally off here;');
console.log('       delegation is covered by accept-cad-inspect-facade (fake legacy execute),');
console.log('       and the default tool surface still uses the old tools until Phase 3.');

// Transition accounting: adding the facade necessarily adds one schema until the
// four legacy tools are hidden. Record the delta rather than pretending it is a cut.
const chars = (definition) => JSON.stringify({
  name: definition.name,
  description: definition.description,
  parameters: definition.parameters,
}).length;
const oldChars = ['measure', 'list_features', 'scan_attention', 'analyze']
  .reduce((sum, name) => sum + chars(after.get(name)), 0);
console.log(`  INFO transition: legacy four=${oldChars} chars; cad_inspect=${chars(facade)} chars; both visible=${oldChars + chars(facade)}`);

rmSync(home, { recursive: true, force: true });
console.log(failed ? `\naccept-cad-inspect-registered: ${failed} FAILURE(S)` : '\naccept-cad-inspect-registered: PASS');
process.exit(failed ? 1 : 0);
