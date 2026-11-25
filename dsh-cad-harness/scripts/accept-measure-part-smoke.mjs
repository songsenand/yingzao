// Smoke for the Python-canonical whole-part measure (the TS oracle was retired
// 2026-11-25). A 20mm cube must report 8000mm³, a 20mm bbox, watertight, one body.
//
//   node --experimental-strip-types scripts/accept-measure-part-smoke.mjs

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
const root = await mkdtemp(join(tmpdir(), 'cad-measure-smoke-'));
const exec = { agent: { session: { header: { id: `measure-smoke-${process.pid}-${Date.now()}`, cwd: root } } } };
const call = async (name, args) => tools.get(name).execute(args, exec);
await call('init_project', { dir: root });
const made = await call('generate_part', { scadCode: 'cube([20,20,20], center=true);', userIntent: 'measure smoke cube', views: ['iso'] });
check(made.saved === true, 'the cube version exists', String(made.versionId));
const m = await call('measure', { versionId: made.versionId, kind: 'part' });
check(Math.abs(m.volumeMm3 - 8000) < 1e-6, 'volume is 8000mm³', String(m.volumeMm3));
check(m.watertight === true, 'the cube is watertight', String(m.watertight));
check((m.bodies ?? []).length === 1 || m.bodies === 1, 'the cube is one body', JSON.stringify(m.bodies));
check(Math.abs(m.sizeMm[0] - 20) < 1e-6, 'bbox x is 20mm', String(m.sizeMm?.[0]));

console.log(failures === 0 ? '\nOK' : `\nFAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
