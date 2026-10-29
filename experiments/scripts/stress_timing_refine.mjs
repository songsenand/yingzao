// Compare simulate_stress wall time at refined dx (and one runConvergence=true).
// Run from the repo root:
//   DSH_CAD_PYTHON_ROOT=<writable runtime> node experiments/scripts/stress_timing_refine.mjs
// The load case is a placeholder (1 N compression, z-min support); it is for timing,
// not for an engineering conclusion.
import { registerCadTools } from '../../dsh-cad-harness/src/host/tools.ts';

const BASE = new URL('../../examples', import.meta.url).pathname;
const CASES = [
  { label: 'fructose B03 dx0.8', project: `${BASE}/ball-and-stick/fructose-molecule`, version: 'v016', dxMm: 0.8, runConvergence: false },
  { label: 'fructose B03 dx0.8 +conv', project: `${BASE}/ball-and-stick/fructose-molecule`, version: 'v016', dxMm: 0.8, runConvergence: true },
  { label: 'fructose C3 dx2.0', project: `${BASE}/ball-and-stick/fructose-molecule`, version: 'v001', dxMm: 2.0, runConvergence: false },
  { label: 'balance2 base dx2.0', project: `${BASE}/toy-balance2`, version: 'v001', dxMm: 2.0, runConvergence: false },
  { label: 'balance2 panL dx0.5', project: `${BASE}/toy-balance2`, version: 'v007', dxMm: 0.5, runConvergence: false },
];

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

for (const c of CASES) {
  const exec = { agent: { session: { header: { cwd: c.project } } } };
  const t0 = Date.now();
  try {
    const v = await def.execute({
      versionId: c.version,
      loads: [{ forceN: [0, 0, -1], face: { axis: 'z', side: 'max' } }],
      supports: [{ face: { axis: 'z', side: 'min' } }],
      mode: 'scan',
      dxMm: c.dxMm,
      runConvergence: c.runConvergence,
    }, exec);
    const m = v?.method ?? {};
    console.log(`${c.label}\t${Date.now() - t0} ms\tdx=${m.dxMm} grid=${m.gridCells} ` +
      `solid=${m.solidCells} cg=${m.cgIterations} conv=${c.runConvergence}`);
  } catch (e) {
    console.log(`${c.label}\tERR after ${Date.now() - t0} ms\t${e.message}`);
  }
}
