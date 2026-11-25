// Acceptance for check_sweep: the early sweep screen whose geometry lives in
// python/cad_worker/worker.py (screen_sweep). The TypeScript side only resolves
// version paths and forwards the declared joint; this test proves the tool path.
//
// Fixture: a 10mm cube at the origin, a static 10mm cube at x=12, and a revolute
// range 0..-90° about +Y. The moving corner sweeps to x≈7.07, so the continuous
// envelope must reach the static block and the clearance must go to 0.
//
//   node --experimental-strip-types scripts/accept-check-sweep.mjs

import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const localRuntime = join(REPO, '.tmp-measure-runtime');
if (!process.env.DSH_CAD_PYTHON_ROOT?.trim() && existsSync(join(localRuntime, 'venv'))) {
  process.env.DSH_CAD_PYTHON_ROOT = localRuntime;
}

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

/** Binary STL cube centred at (cx,cy,cz) with side s. */
function cubeStl(cx, cy, cz, s) {
  const h = s / 2;
  const v = [[-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h], [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]]
    .map(([x, y, z]) => [x + cx, y + cy, z + cz]);
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buf = Buffer.alloc(84 + 12 * 50);
  buf.write('check-sweep cube', 0);
  buf.writeUInt32LE(12, 80);
  let o = 84;
  for (const [i, j, k] of faces) {
    const a = v[i], b = v[j], c = v[k];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(...n) || 1;
    n = n.map((x) => x / len);
    for (const p of [n, a, b, c]) for (const x of p) { buf.writeFloatLE(x, o); o += 4; }
    o += 2;
  }
  return buf;
}

const root = await mkdtemp(join(tmpdir(), 'cad-check-sweep-'));
await mkdir(join(root, 'cad-data', 'versions', 'v001'), { recursive: true });
await mkdir(join(root, 'cad-data', 'versions', 'v002'), { recursive: true });
await mkdir(join(root, 'cad-data', 'versions', 'v003'), { recursive: true });
await writeFile(join(root, 'cad-data', 'versions', 'v001', 'model.stl'), cubeStl(0, 0, 0, 10));
await writeFile(join(root, 'cad-data', 'versions', 'v002', 'model.stl'), cubeStl(12, 0, 0, 10));
await writeFile(join(root, 'cad-data', 'versions', 'v003', 'model.stl'), cubeStl(40, 0, 0, 10));

const { registerCadTools } = await import('../src/host/tools.ts');
const tools = new Map();
const ctx = {
  tools: { register: (def) => { tools.set(def.name, def); } },
  attachments: { saveImages: async (items) => items.map((it) => ({ kind: 'stub', name: it.name })) },
  reflect: { get: () => undefined }, on: () => {},
};
registerCadTools(ctx);
const exec = { agent: { session: { header: { id: `check-sweep-${process.pid}-${Date.now()}`, cwd: root } } } };
const call = async (name, args) => {
  const def = tools.get(name);
  if (!def) throw new Error(`tool ${name} is not registered`);
  return def.execute(args, exec);
};
await call('init_project', { dir: root });

check(tools.has('check_sweep'), 'check_sweep is registered');
const joint = { type: 'revolute', anchorMm: [0, 0, 0], axis: [0, 1, 0], from: 0, to: -90 };

const hit = await call('check_sweep', {
  versionId: 'v001', againstVersionIds: ['v002'], joint, minFeatureMm: 0.5, maxSamples: 40,
});
check(hit.overall === 'collision', 'the swept block collision is reported', hit.overall);
check(hit.rows?.[0]?.envelopeHit === true, 'the continuous envelope reaches the static block', String(hit.rows?.[0]?.envelopeHit));
check(hit.rows?.[0]?.samples > 1, 'the clearance curve has samples', String(hit.rows?.[0]?.samples));
check(hit.rows?.[0]?.minClearanceMm <= 0, 'the minimum clearance is at/below touching', String(hit.rows?.[0]?.minClearanceMm));
check(typeof hit.rows?.[0]?.at === 'number' && hit.rows[0].at < 0 && hit.rows[0].at > -90,
  'the collision has a pose inside the declared range', String(hit.rows?.[0]?.at));
check(typeof hit.rule === 'string' && /UNCOVERED/.test(hit.rule), 'the report states the UNCOVERED rule');

const far = await call('check_sweep', {
  versionId: 'v001', againstVersionIds: ['v003'], joint, minFeatureMm: 0.5, maxSamples: 20,
});
check(far.overall === 'clean', 'a far static part does not become a suspect', far.overall);
check(far.rows?.[0]?.status === 'skipped', 'the continuous envelope skips it', String(far.rows?.[0]?.status));
check(far.rows?.[0]?.samples === 0, 'no clearance samples were spent on it', String(far.rows?.[0]?.samples));

console.log(failures === 0 ? '\nOK' : `\nFAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
