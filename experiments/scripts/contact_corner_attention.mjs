// Reproduce the contact-corner attention check (2026-10-29).
// Generates two fixtures, runs scan_attention, then simulate_stress in two cases:
//   * ground + self-weight (the part resting on its contact face)
//   * a bending load through the V-notch root
// Run from the repo root:
//   DSH_CAD_PYTHON_ROOT=<writable runtime> node experiments/scripts/contact_corner_attention.mjs
import { readFileSync } from 'node:fs';
import { registerCadTools } from '../../dsh-cad-harness/src/host/tools.ts';

const PROJECT = new URL('../../examples/attention-contact-corner', import.meta.url).pathname;
const L_BRACKET = readFileSync(new URL('../../examples/attention-contact-corner/l-bracket.scad', import.meta.url), 'utf8');
const V_NOTCH = readFileSync(new URL('../../examples/attention-contact-corner/v-notch.scad', import.meta.url), 'utf8');

const tools = new Map();
const ctx = {
  tools: { register: (d) => { tools.set(d.name, d); return d; } },
  attachments: { saveImages: async () => [] },
  reflect: { get: () => undefined },
  logger: console,
  on: () => {},
};
registerCadTools(ctx);
const exec = { agent: { session: { header: { cwd: PROJECT } } } };

const gen = tools.get('generate_part');
const scan = tools.get('scan_attention');
const stress = tools.get('simulate_stress');

const l = await gen.execute({
  scadCode: L_BRACKET,
  userIntent: 'L-bracket with a right-angle reentrant corner on a ground contact',
  part: 'l-bracket',
  views: [],
}, exec);
const v = await gen.execute({
  scadCode: V_NOTCH,
  userIntent: 'Block with a sharp V-notch on the ground contact face',
  part: 'v-notch-block',
  views: [],
}, exec);
console.log('versions', { l: l.versionId, v: v.versionId, lBodies: l.shells, vBodies: v.shells });

const scanAt = async (versionId, concaveMinDeg) => {
  // `undefined` is not a lossless JSON value: omit the key for the default threshold.
  const args = concaveMinDeg === undefined ? { versionId } : { versionId, concaveMinDeg };
  const s = await scan.execute(args, exec);
  return {
    threshold: concaveMinDeg ?? 100,
    stats: s.stats,
    suspects: (s.suspects ?? []).map((x) => ({
      kind: x.kind, at: x.where?.atMm, severity: x.severity, why: x.why,
    })),
  };
};
console.log('scan L 100', JSON.stringify(await scanAt(l.versionId, undefined)));
console.log('scan L 80 ', JSON.stringify(await scanAt(l.versionId, 80)));
console.log('scan V 100', JSON.stringify(await scanAt(v.versionId, undefined)));

const gravity = await stress.execute({
  versionId: v.versionId,
  supports: [{ ground: true }],
  includeSelfWeight: true,
  mode: 'scan',
  dxMm: 2.0,
  runConvergence: false,
}, exec);
const bending = await stress.execute({
  versionId: v.versionId,
  supports: [{ face: { axis: 'x', side: 'min' } }],
  loads: [{ forceN: [0, 0, -10], face: { axis: 'x', side: 'max' } }],
  includeSelfWeight: true,
  mode: 'scan',
  dxMm: 2.0,
  runConvergence: false,
}, exec);

const summarize = (st) => ({
  loadCase: st.loadCase,
  totalWeightN: st.selfWeight?.totalWeightN,
  layers: (st.attention?.layers ?? []).map((layer) => ({
    id: layer.id,
    peaks: (layer.peaks ?? []).slice(0, 6).map((p) => ({ at: p.atMm, value: p.value })),
    regions: (layer.regions ?? []).slice(0, 4).map((r) => ({ at: r.atMm, tier: r.tier })),
  })),
});
console.log('gravity', JSON.stringify(summarize(gravity), null, 2));
console.log('bending', JSON.stringify(summarize(bending), null, 2));
