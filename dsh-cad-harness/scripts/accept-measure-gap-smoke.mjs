// Smoke for the Python-canonical gap measurement (the TS measureDistance solver
// was retired 2026-11-25). Two 10mm cubes, the second modelled 20mm away → gap 10mm.
//
//   node --experimental-strip-types scripts/accept-measure-gap-smoke.mjs

import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const localRuntime = join(REPO, '.tmp-measure-runtime');
if (!process.env.DSH_CAD_PYTHON_ROOT?.trim() && existsSync(join(localRuntime, 'venv'))) {
  process.env.DSH_CAD_PYTHON_ROOT = localRuntime;
}
const captured = [];
const noop = () => {};
const ctx = {
  tools: { register: (def) => { captured.push(def); return { dispose: noop }; } },
  attachments: { saveImages: async (items) => items.map((it) => ({ kind: 'stub', name: it.name })) },
  reflect: { get: () => undefined }, on: noop,
  logger: { info: noop, warn: noop, error: noop, debug: noop },
};
const { registerCadTools } = await import('../src/host/tools.ts');
registerCadTools(ctx);
const tools = new Map(captured.map((d) => [d.name, d]));
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const root = await mkdtemp(join(tmpdir(), 'cad-measure-gap-'));
const exec = { agent: { session: { header: { id: `measure-gap-${process.pid}-${Date.now()}`, cwd: root } } } };
const call = async (name, args) => tools.get(name).execute(args, exec);
await call('init_project', { dir: root });
const a = await call('generate_part', { scadCode: 'cube([10,10,10], center=true);', userIntent: 'gap cube A', views: ['iso'] });
const b = await call('generate_part', { scadCode: 'translate([20,0,0]) cube([10,10,10], center=true);', userIntent: 'gap cube B', views: ['iso'] });
check(a.saved && b.saved, 'both cubes exist', `${a.versionId}/${b.versionId}`);
const m = await call('measure', { kind: 'gap', aVersionId: a.versionId, bVersionId: b.versionId });
check(Math.abs((m.distanceMm ?? -1) - 10) < 1e-6, 'surface gap is 10mm', String(m.distanceMm));
check(Array.isArray(m.pointA) && Array.isArray(m.pointB), 'the witness pair is present', JSON.stringify({ a: m.pointA, b: m.pointB }));
console.log(failures === 0 ? '\nOK' : `\nFAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
