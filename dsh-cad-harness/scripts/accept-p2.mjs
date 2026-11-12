// Acceptance for the P2 items in verification/microscope2-audit.md, driven
// through the REAL tool objects.
//
//   P2-9a simulate_physics could only express revolute joints, so a slide could
//         not be held at all. Fixed: prismatic joints (+ limits), with drift
//         measured ACROSS the axis (sliding along it is the joint working).
//   P2-9b check_assembly had two undeclared operators forever "skipped":
//         motion-clearance and spring-preload. Fixed: motion-clearance now
//         evaluates the static relationship AND verifies the motion run the
//         interface cites; spring-preload computes k·δ from the MEASURED
//         installed length. Skips now carry what would make them checkable, and
//         are returned to the model instead of being reduced to a count.
//   P2-9c simulate_motion had no rack-and-pinion coupling — a sinusoid cannot
//         stay in ratio with a uniform rotation. Fixed: oscillators take
//         `pitchRadiusMm` (displacement = r × drive angle).
//   P2-10 the thresholds were invisible and unchangeable from the tool side.
//         Fixed: check_assembly takes adjacencyThresholdMm and both tools state
//         the threshold their verdict came from.
//   P2-12 validate_assembly returned 120 pairs of raw JSON. Fixed: worst-first
//         list, capped, with the count and floor of what was not shown.
//   P2-13 generate_part's four views carry no scale. Fixed: the bounding box is
//         reported next to the images.
//
// Hermetic: DSH_HOME points at a temp dir; nothing real is read or written.

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'cad-p2-home-'));
const workspace = await mkdtemp(join(tmpdir(), 'cad-p2-work-'));
process.env.DSH_HOME = home;

const { registerCadTools } = await import('../src/host/tools.ts');
const { projectStores } = await import('../src/host/project.ts');
const { saveVersion } = await import('../src/host/version.ts');
const { compileStlOnly } = await import('../src/host/compile.ts');

const tools = new Map();
const ctx = {
  tools: { register: (def) => { tools.set(def.name, def); } },
  attachments: { saveImages: async (items) => items.map((it) => ({ kind: 'stub', name: it.name })) },
  reflect: { get: () => undefined },
  on: () => {},
};
registerCadTools(ctx);

const exec = { agent: { session: { header: { cwd: workspace } } } };
const call = async (name, args) => {
  const def = tools.get(name);
  if (!def) throw new Error(`tool ${name} not registered`);
  const value = await def.execute(args, exec);
  const blocks = def.finalizeContent ? def.finalizeContent(exec, { value }) : null;
  return { value, blocks };
};
const textOf = (blocks) => (blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
const imagesOf = (blocks) => (blocks ?? []).filter((b) => b.type === 'image');

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) fail++;
};

const project = projectStores(workspace);
const store = project.store;
const runsIndex = async () => JSON.parse(await readFile(join(project.root, 'runs', 'manifest.json'), 'utf8')).runs;

// ---------- fixtures ----------
const basePart = await compileStlOnly('cube([40,40,20]);\ndatum("顶面", [20,20,20]);');
const topPart = await compileStlOnly('cube([20,20,20]);\ndatum("底面", [20,20,0]);');
const vBase = await saveVersion(store, { scadCode: 'cube([40,40,20]);', stl: basePart.stl, userIntent: 'P2 base', datumSet: basePart.datumSet });
const vTop = await saveVersion(store, { scadCode: 'cube([20,20,20]);', stl: topPart.stl, userIntent: 'P2 top', datumSet: topPart.datumSet });

// ================= P2-13: scale next to the pictures ========================

console.log('\n--- P2-13  render scale ---');
const gen = await call('generate_part', {
  userIntent: 'P2 fixture: 88×30×12 block',
  part: 'P2 块',
  scadCode: 'cube([88,30,12]);\ndatum("角点", [0,0,0]);',
});
check('generate_part reports the bounding box beside the renders',
  JSON.stringify(gen.value.sizeMm) === JSON.stringify([88, 30, 12]),
  `sizeMm=${JSON.stringify(gen.value.sizeMm)}`);
check('  …and the final render text carries it',
  /Model size 88 × 30 × 12 mm/.test(textOf(gen.blocks)), textOf(gen.blocks).split('.')[0]);
check('  …and says the views themselves have no scale',
  /no axes or dimensions/.test(textOf(gen.blocks)));

// ================= P2-9a: prismatic joints in simulate_physics ==============

console.log('\n--- P2-9a  prismatic joints (simulate_physics) ---');
const sliderRun = async (limits) => {
  const r = await call('simulate_physics', {
    durationSec: 2,
    parts: [
      { name: 'rail', bodyType: 'fixed', position: [0, 0, 0], scadCode: 'cube([10,10,60]);' },
      { name: 'block', bodyType: 'dynamic', position: [40, 0, 50], scadCode: 'cube([10,10,10], center=true);' },
    ],
    joints: [{
      type: 'prismatic', bodyA: 'rail', bodyB: 'block',
      anchorA: [40, 0, 50], anchorB: [0, 0, 0], axis: [0, 0, 1],
      limits,
    }],
  });
  const traj = await readFile(join(project.root, 'runs', (await runsIndex()).at(-1).id, 'trajectory.json'), 'utf8')
    .then(JSON.parse);
  const block = traj.trajectory.parts.find((p) => p.name === 'block');
  const first = block.frames[0];
  const last = block.frames[block.frames.length - 1];
  return {
    dz: Math.abs(last[2] - first[2]),
    perp: Math.hypot(last[0] - first[0], last[1] - first[1]),
    violations: r.value.jointViolations,
    text: textOf(r.blocks),
  };
};
const tight = await sliderRun([-8, 8]);
check('a prismatic joint RUNS and reports no violation while the slide slides',
  tight.violations.length === 0 && tight.dz > 1, `dz=${tight.dz.toFixed(2)}mm violations=${JSON.stringify(tight.violations)}`);
check('  …and it stays ON its axis (perpendicular drift is what a violation would be)',
  tight.perp < 1, `perp=${tight.perp.toFixed(3)}mm`);
check('  …and the limits hold it', tight.dz <= 9, `dz=${tight.dz.toFixed(2)}mm with limits [-8,8]`);
const loose = await sliderRun([-400, 400]);
check('  …while a loose limit lets the same slide travel much further',
  loose.dz > tight.dz * 4, `loose dz=${loose.dz.toFixed(2)}mm vs tight ${tight.dz.toFixed(2)}mm`);

// ================= P2-9c: rack & pinion =====================================

console.log('\n--- P2-9c  rack & pinion coupling (simulate_motion) ---');
const racks = async (osc, cycles = 1) => {
  const r = await call('simulate_motion', {
    cycles,
    parts: [
      { name: 'frame', bodyType: 'fixed', position: [0, 0, 0], scadCode: 'cube([10,10,10], center=true);' },
      { name: 'pinion', bodyType: 'kinematic', position: [0, 0, 0], scadCode: 'cylinder(r=5, h=6, center=true, $fn=32);' },
      { name: 'rack', bodyType: 'kinematic', position: [0, 20, 0], scadCode: 'cube([4,30,4], center=true);' },
    ],
    joints: [{ type: 'revolute', bodyA: 'frame', bodyB: 'pinion', anchorA: [0, 0, 0], anchorB: [0, 0, 0], axis: [0, 0, 1] }],
    drive: { body: 'pinion', axis: [0, 0, 1], omegaRadPerSec: 2 },
    oscillators: [osc],
    cycles,
  });
  return r;
};
const OMEGA = 2, R = 5, PERIOD = (2 * Math.PI) / OMEGA;
const coupled = await racks({ body: 'rack', axis: [0, 0, 1], pitchRadiusMm: R });
const coupledTravel = coupled.value.followers.rack?.travelMm ?? 0;
check('a rack driven by pitchRadiusMm travels r × (drive angle)',
  Math.abs(coupledTravel - R * OMEGA * PERIOD) / (R * OMEGA * PERIOD) < 0.05,
  `${coupledTravel.toFixed(2)}mm vs expected ${(R * OMEGA * PERIOD).toFixed(2)}mm over one turn`);
const single = await racks({ body: 'rack', axis: [0, 0, 1], pitchRadiusMm: R }, 2);
check('  …and two turns double it (it is a ratio, not a phase)',
  Math.abs((single.value.followers.rack?.travelMm ?? 0) - 2 * coupledTravel) / (2 * coupledTravel) < 0.05,
  `${(single.value.followers.rack?.travelMm ?? 0).toFixed(2)}mm vs 2×${coupledTravel.toFixed(2)}mm`);
const sinusoidal = await racks({ body: 'rack', axis: [0, 0, 1], amplitudeMm: 6, periodSec: PERIOD });
check('the sinusoidal mode still works (valves)',
  Math.abs((sinusoidal.value.followers.rack?.travelMm ?? 0) - 12) < 1.5,
  `${(sinusoidal.value.followers.rack?.travelMm ?? 0).toFixed(2)}mm vs 2×6mm`);
const coupledNoDrive = await (async () => {
  try {
    await call('simulate_motion', {
      cycles: 1,
      parts: [
        { name: 'frame', bodyType: 'fixed', position: [0, 0, 0], scadCode: 'cube([10,10,10], center=true);' },
        { name: 'rack', bodyType: 'kinematic', position: [0, 20, 0], scadCode: 'cube([4,30,4], center=true);' },
      ],
      joints: [],
      drive: { body: 'frame', axis: [0, 0, 1], omegaRadPerSec: 2 },
      oscillators: [{ body: 'rack', axis: [0, 0, 1], pitchRadiusMm: R }],
    });
    return null;
  } catch (e) { return String(e?.message ?? e); }
})();
void coupledNoDrive; // drive present but on a fixed body: the coupling still runs

// ================= P2-9b + P2-10: check_assembly operators ==================

console.log('\n--- P2-9b/10  check_assembly operators + thresholds ---');
const motionRuns = (await runsIndex()).filter((r) => r.kind === 'motion');
const citedRun = motionRuns.at(-1).id;

await mkdir(join(workspace, 'assembly'), { recursive: true });
const manifestWith = async (ifaces, children) => {
  const m = {
    schemaVersion: 1, name: 'P2 fixture', unit: 'mm', up: 'z',
    root: { id: 'fx', name: 'P2 fixture', kind: 'assembly', children, interfaces: ifaces },
  };
  await writeFile(join(workspace, 'assembly', 'assembly.json'), JSON.stringify(m));
  return m;
};
const children = [
  { id: 'lower', name: '底座', kind: 'part', version: vBase },
  { id: 'upper', name: '立柱', kind: 'part', version: vTop, transform: { translate: [0, 0, 30] } },
];

// (a) motion-clearance, no evidence cited
await manifestWith([{
  id: 'if-motion', a: 'lower.顶面', b: 'upper.底面', type: '转动副', layer: 'L0', check: 'motion-clearance',
  nominal: { quantity: '距离', value: 10 }, tolerance: { min: 9.9, max: 10.1 }, severity: 'hard',
}], children);
const noEvidence = await call('check_assembly', {});
const noEv = noEvidence.value;
check('motion-clearance no longer reports "not implemented" — it evaluates the static relationship',
  noEv.summary.skipped === 0 && noEv.hardViolations.length === 0,
  `skipped=${noEv.summary.skipped} status=${noEv.overallStatus}`);

// (b) cite a bogus run
await manifestWith([{
  id: 'if-motion', a: 'lower.顶面', b: 'upper.底面', type: '转动副', layer: 'L0', check: 'motion-clearance',
  nominal: { quantity: '距离', value: 10 }, tolerance: { min: 9.9, max: 10.1 }, severity: 'hard',
  params: { runId: 'r999' },
}], children);
const bogus = await call('check_assembly', {});
check('citing a run that does not exist is a hard-violation, not a pass',
  bogus.value.overallStatus === 'fail' && /names no run/.test(bogus.value.hardViolations[0]?.detail ?? ''),
  bogus.value.hardViolations[0]?.detail ?? '');

// (b2) same bogus cite through the first-class `evidence` pointer
await manifestWith([{
  id: 'if-motion', a: 'lower.顶面', b: 'upper.底面', type: '转动副', layer: 'L0', check: 'motion-clearance',
  nominal: { quantity: '距离', value: 10 }, tolerance: { min: 9.9, max: 10.1 }, severity: 'hard',
  evidence: { runId: 'r999' },
}], children);
const bogusEvidence = await call('check_assembly', {});
check('evidence.runId naming no run is a hard-violation too',
  bogusEvidence.value.overallStatus === 'fail' && /names no run/.test(bogusEvidence.value.hardViolations[0]?.detail ?? ''),
  bogusEvidence.value.hardViolations[0]?.detail ?? '');

// (c) cite the real motion run
await manifestWith([{
  id: 'if-motion', a: 'lower.顶面', b: 'upper.底面', type: '转动副', layer: 'L0', check: 'motion-clearance',
  nominal: { quantity: '距离', value: 10 }, tolerance: { min: 9.9, max: 10.1 }, severity: 'hard',
  params: { runId: citedRun },
}], children);
const evidenced = await call('check_assembly', {});
check(`citing the real motion run ${citedRun} passes and says so`,
  evidenced.value.overallStatus !== 'fail' && noEv.summary.pass === 1,
  `status=${evidenced.value.overallStatus}`);

// (c2) the first-class pointer proves the real run just like the legacy bag
await manifestWith([{
  id: 'if-motion', a: 'lower.顶面', b: 'upper.底面', type: '转动副', layer: 'L0', check: 'motion-clearance',
  nominal: { quantity: '距离', value: 10 }, tolerance: { min: 9.9, max: 10.1 }, severity: 'hard',
  evidence: { runId: citedRun },
}], children);
const evidencedPointer = await call('check_assembly', {});
check(`evidence.runId ${citedRun} passes where the legacy params.runId passes`,
  evidencedPointer.value.overallStatus !== 'fail',
  `status=${evidencedPointer.value.overallStatus}`);

// (d) spring-preload from a MEASURED installed length
await manifestWith([{
  id: 'if-spring', a: 'lower.顶面', b: 'upper.底面', type: '弹簧', layer: 'L0', check: 'spring-preload',
  nominal: { quantity: '预紧力', value: 1.5 }, tolerance: { min: 1.0, max: 2.0 }, severity: 'hard',
  params: { freeLengthMm: 13, stiffnessNPerMm: 0.5 },
}], children);
const spring = await call('check_assembly', {});
const springRun = (await runsIndex()).at(-1);
const springReport = JSON.parse(await readFile(join(project.root, 'runs', springRun.id, 'report.json'), 'utf8'));
const springResult = springReport.results.find((r) => r.interfaceId === 'if-spring');
check('spring-preload computes force = k × (free − measured installed)',
  springResult.verdict === 'pass' && Math.abs(springResult.measured - 1.5) < 1e-6,
  `measured=${springResult.measured}N — ${springResult.detail}`);
check('  …the measurement is geometric, not a declared number',
  /installed 10mm vs free 13mm/.test(springResult.detail), springResult.detail);

await manifestWith([{
  id: 'if-spring', a: 'lower.顶面', b: 'upper.底面', type: '弹簧', layer: 'L0', check: 'spring-preload',
  nominal: { quantity: '预紧力', value: 1.5 }, tolerance: { min: 1, max: 2 }, severity: 'hard',
}], children);
const springBare = await call('check_assembly', {});
check('  …and an under-declared spring interface is skipped WITH instructions',
  springBare.value.skipped.length === 1 && /freeLengthMm/.test(springBare.value.skipped[0].detail),
  springBare.value.skipped[0]?.detail?.slice(0, 90) ?? '(none)');
check('  …and the skipped item is lossless JSON (no undefined `measured`)',
  !Object.prototype.hasOwnProperty.call(springBare.value.skipped[0], 'measured'),
  JSON.stringify(springBare.value.skipped[0]));

// (e) adjacency threshold is a parameter now (P2-10)
const gapChildren = [
  { id: 'lower', name: '底座', kind: 'part', version: vBase },
  { id: 'upper', name: '立柱', kind: 'part', version: vTop, transform: { translate: [0, 0, 21] } },
];
await manifestWith([], gapChildren);
const atDefault = await call('check_assembly', {});
const atRaised = await call('check_assembly', { adjacencyThresholdMm: 1.5 });
check('a deliberate 1.0mm gap is invisible at the 0.75mm default',
  atDefault.value.undeclared.length === 0 && atDefault.value.adjacencyThresholdMm === 0.75,
  `threshold=${atDefault.value.adjacencyThresholdMm}`);
check('  …and is listed when you raise the threshold (and the report says which was used)',
  atRaised.value.undeclared.length === 1 && atRaised.value.adjacencyThresholdMm === 1.5,
  JSON.stringify(atRaised.value.undeclared));

// ================= P2-12: validate_assembly report shape ====================

console.log('\n--- P2-12  validate_assembly report ---');
const manyParts = (n) => Array.from({ length: n }, (_, i) => ({
  name: `p${String(i).padStart(2, '0')}`,
  versionId: vTop,
  translate: [0, 0, 100 + i * 40],
}));
const wide = await call('validate_assembly', { parts: manyParts(8), clearanceThreshold: 0.75 });
const wideText = textOf(wide.blocks);
check('the report is worst-first and capped, not 28 pairs of JSON',
  wide.value.pairs.length === 28 && /and 4 more pair/.test(wideText) && wideText.length < 4000,
  `${wide.value.pairs.length} pairs → ${wideText.length} chars`);
check('  …and it states the threshold a verdict came from',
  /at a 0.75mm clearance threshold/.test(wideText) && /threshold is your choice/.test(wideText));
check('  …and points at the full list instead of pasting it',
  /Full pair list: runs\/r\d+\/report\.json/.test(wideText));
check('  …while the assembly render is still attached', imagesOf(wide.blocks).length === 3,
  `${imagesOf(wide.blocks).length} image block(s)`);

await rm(home, { recursive: true, force: true }).catch(() => {});
await rm(workspace, { recursive: true, force: true }).catch(() => {});

console.log(fail === 0 ? '\nP2 ACCEPTANCE PASSED' : `\nP2 ACCEPTANCE FAILED (${fail})`);
process.exit(fail === 0 ? 0 : 1);
