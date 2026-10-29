// Measure simulate_stress wall time across all fructose versions at the default dx.
// Run from the repo root:
//   DSH_CAD_PYTHON_ROOT=<writable runtime> node experiments/scripts/stress_timing_batch.mjs
// The load case is a placeholder (1 N compression, z-min support); it is for timing,
// not for an engineering conclusion.
import { readdirSync } from 'node:fs';
import { registerCadTools } from '../../dsh-cad-harness/src/host/tools.ts';

const PROJECT = new URL('../../examples/ball-and-stick/fructose-molecule', import.meta.url).pathname;
const versions = readdirSync(`${PROJECT}/cad-data/versions`).filter((x) => /^v\d+$/.test(x)).sort();

const tools = new Map();
const ctx = {
  tools: { register: (d) => { tools.set(d.name, d); return d; } },
  attachments: { saveImages: async () => [] },
  reflect: { get: () => undefined },
  logger: console,
  on: () => {},
};
registerCadTools(ctx);
const def = tools.get('simulate_stress');
const exec = { agent: { session: { header: { cwd: PROJECT } } } };

const rows = [];
for (const version of versions) {
  const t0 = Date.now();
  try {
    const v = await def.execute({
      versionId: version,
      loads: [{ forceN: [0, 0, -1], face: { axis: 'z', side: 'max' } }],
      supports: [{ face: { axis: 'z', side: 'min' } }],
      mode: 'scan',
      runConvergence: false,
    }, exec);
    const m = v?.method ?? {};
    rows.push({ version, ms: Date.now() - t0, dx: m.dxMm, solid: m.solidCells, cg: m.cgIterations, ok: true });
  } catch (e) {
    rows.push({ version, ms: Date.now() - t0, ok: false, err: String(e.message).slice(0, 120) });
  }
  process.stdout.write('.');
}
console.log('');

const ok = rows.filter((r) => r.ok);
const bad = rows.filter((r) => !r.ok);
const total = rows.reduce((a, r) => a + r.ms, 0);
const sorted = ok.map((r) => r.ms).sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
console.log(`versions=${rows.length} ok=${ok.length} fail=${bad.length} ` +
  `total=${(total / 1000).toFixed(1)}s avg=${(total / rows.length / 1000).toFixed(2)}s ` +
  `median=${(pct(0.5) / 1000).toFixed(2)}s p90=${(pct(0.9) / 1000).toFixed(2)}s ` +
  `max=${(sorted[sorted.length - 1] / 1000).toFixed(2)}s`);
console.log('slowest:', ok.sort((a, b) => b.ms - a.ms).slice(0, 5)
  .map((r) => `${r.version}:${(r.ms / 1000).toFixed(1)}s(${r.solid}c,${r.cg}cg,dx${r.dx})`).join(' '));
if (bad.length) console.log('failures:', bad.slice(0, 5).map((r) => `${r.version}:${r.err}`).join(' | '));
