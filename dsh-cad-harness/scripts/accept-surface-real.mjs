#!/usr/bin/env node
// Real-CAD smoke for the generated surfaces: cad_session.init -> cad_see.render.
// It uses OpenSCAD (already required by the preview) and does NOT need Python.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cad-surface-real-'));
process.env.DSH_HOME = home;
process.env.DSH_CAD_PYTHON = 'off';
const { registerCadToolsWithSurfaces } = await import('../src/host/register-with-surfaces.ts');
const { saveVersion } = await import('../src/host/version.ts');
const { ensurePart, attachVersion } = await import('../src/host/parts.ts');
const { projectStores } = await import('../src/host/project.ts');

let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  PASS ${name}`);
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const savedImages = [];
const tools = new Map();
const ctx = {
  tools: { register: (definition) => { tools.set(definition.name, definition); return () => {}; } },
  connection: { fetch: { register: () => (() => {}) } },
  attachments: { saveImages: async (images) => { savedImages.push(...images); return images.map((image, index) => ({ id: `img-${index}`, ...image })); } },
  reflect: { get: () => undefined },
  on: () => () => {},
  effect: (fn) => { try { fn(); } catch { /* ignore */ } },
  logger: { debug() {}, info() {}, warn() {}, error() {} },
};
registerCadToolsWithSurfaces(ctx, {
  toolSurfaces: ['session', 'part', 'assembly', 'check', 'simulate', 'inspect', 'see', 'python', 'deliver'],
  hideLegacy: 'all',
});
const session = tools.get('cad_session');
const see = tools.get('cad_see');
check('nine surfaces registered', tools.size === 9, String(tools.size));
check('cad_session and cad_see exist', Boolean(session && see));

const workspace = join(home, 'workspace');
const exec = { agent: { session: { header: { id: 'cad-surface-real', cwd: workspace } } } };
const init = await session.execute({ action: 'init', args: JSON.stringify({ dir: workspace }) }, exec);
check('cad_session.init creates a project', init?.created === true || init?.bound === true, JSON.stringify(init).slice(0, 160));

function boxStl(dx, dy, dz) {
  const hx = dx / 2, hy = dy / 2, hz = dz / 2;
  const v = [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
    [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buf = Buffer.alloc(84 + 12 * 50);
  buf.write('surface real fixture', 0);
  buf.writeUInt32LE(12, 80);
  let o = 84;
  for (const [i, j, k] of faces) {
    const a = v[i], b = v[j], c = v[k];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(...n) || 1;
    for (const p of [n.map((x) => x / len), a, b, c]) for (const x of p) { buf.writeFloatLE(x, o); o += 4; }
    o += 2;
  }
  return buf;
}

const stores = projectStores(workspace);
const part = await ensurePart(stores.partStore, 'box', 'surface-real');
const version = await saveVersion(stores.store, {
  stl: boxStl(20, 20, 20),
  userIntent: 'surface real render fixture',
  partId: part.id,
});
await attachVersion(stores.partStore, part.id, version);

const rendered = await see.execute({ action: 'render', args: { versionId: version } }, exec);
check('cad_see.render returns a file', typeof rendered?.file === 'string' && rendered.file.endsWith('.png'), JSON.stringify(rendered).slice(0, 160));
check('cad_see.render attached an image', savedImages.length === 1 && savedImages[0].mediaType === 'image/png');

rmSync(home, { recursive: true, force: true });
console.log(failed ? `\naccept-surface-real: ${failed} FAILURE(S)` : '\naccept-surface-real: PASS');
process.exit(failed ? 1 : 0);
