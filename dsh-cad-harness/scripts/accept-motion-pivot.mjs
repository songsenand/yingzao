// Acceptance for `simulate_motion`'s pivot rebasing (the fix for the
// microscope2/microscope5 motion defect).
//
//   Why this exists: a rapier body rotates about its OWN origin, but every part
//   in a corpus is modelled in WORLD coordinates and placed with position
//   [0,0,0]. A gear modelled at z=265 therefore did not spin on its shaft — it
//   swung on a 265mm arm. The microscope2 motion runs did exactly that and still
//   reported "0 interference" and "0.03mm joint drift", because the swing swept
//   empty space and the drift was sampled only at the final, whole-turn pose.
//
//   microscope5's manifest interface 7 records the same family of symptoms in
//   prose ("齿轮轴 … 零件被甩出 176mm") with no test behind it. This script is
//   that test. The other two faults recorded on interface 7 are covered
//   elsewhere: rack ratio → accept-p2.mjs, pose about a datum axis →
//   accept-p3.mjs.
//
//   What is pinned here:
//     1. Default pivot = the anchor of the FIRST joint naming the part (its own
//        axis), not the world origin and not the geometry centre.
//     2. A part named by no joint falls back to its geometry's own centre.
//     3. An explicit `pivot` overrides both.
//     4. The re-basing actually reaches the stored geometry: the run's part STL
//        is shifted so its bbox is centred on the pivot, i.e. the body turns in
//        place instead of orbiting the origin.
//     5. Joint anchors are shifted by the same amount, so joint drift stays
//        small through a full turn.
//
//   Hermetic: DSH_HOME and the workspace live in temp dirs.
//
//   node scripts/accept-motion-pivot.mjs

import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'cad-pivot-home-'));
const workspace = await mkdtemp(join(tmpdir(), 'cad-pivot-work-'));
process.env.DSH_HOME = home;

const { registerCadTools } = await import('../src/host/tools.ts');
const { projectStores } = await import('../src/host/project.ts');
const { parseBinaryStl } = await import('../src/host/mesh.ts');

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
  return { value, blocks: def.finalizeContent ? def.finalizeContent(exec, { value }) : null };
};

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) fail++;
};

const project = projectStores(workspace);
const runsIndex = async () =>
  JSON.parse(await readFile(join(project.root, 'runs', 'manifest.json'), 'utf8')).runs;

const bboxCentreOfStl = (bytes) => {
  const mesh = parseBinaryStl(bytes);
  const v = mesh.vertProperties;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const x = v[i + k];
      if (x < lo[k]) lo[k] = x;
      if (x > hi[k]) hi[k] = x;
    }
  }
  return [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
};
const close = (a, b, tol) => Math.abs(a - b) <= tol;
const closeTo = (a, b, tol) => a.length === b.length && a.every((x, i) => close(x, b[i], tol));
const fmt = (a) => `[${a.map((x) => x.toFixed(2)).join(', ')}]`;

// ---------- fixtures ----------
// `bar` is modelled 120mm away from the origin — the exact shape of the defect.
const crankScad = 'cube([10,10,10], center=true);\ndatum_axis("轴", [0,0,0], [0,0,1]);';
const barScad = 'translate([120,0,0]) cube([8,40,8], center=true);';
const freeScad = 'translate([50,0,0]) cube([10,10,10], center=true);';

const run = async (extraParts = [], joints = null, pivotForBar = undefined) =>
  call('simulate_motion', {
    cycles: 1,
    parts: [
      { name: 'crank', bodyType: 'kinematic', position: [0, 0, 0], scadCode: crankScad },
      { name: 'bar', bodyType: 'dynamic', position: [0, 0, 0], scadCode: barScad, ...(pivotForBar ? { pivot: pivotForBar } : {}) },
      ...extraParts,
    ],
    joints: joints ?? [
      { type: 'revolute', bodyA: 'crank', bodyB: 'bar', anchorA: [0, 0, 0], anchorB: [120, 0, 0], axis: [0, 0, 1] },
    ],
    drive: { body: 'crank', axis: [0, 0, 1], omegaRadPerSec: 1 },
  });

// ---------- 1. default pivot = the part's own joint anchor ----------
console.log('\n--- 1  default pivot comes from the joint, not the origin ---');
const r1 = await run();
const piv1 = r1.value.pivots ?? {};
check('pivots is reported per part', Object.keys(piv1).length >= 2, JSON.stringify(piv1));
check('bar turns about its own joint anchor [120,0,0]', closeTo(piv1.bar ?? [], [120, 0, 0], 0.01), fmt(piv1.bar ?? []));
check('  …and NOT about the world origin', !closeTo(piv1.bar ?? [], [0, 0, 0], 0.01), fmt(piv1.bar ?? []));
check('crank turns about its own axis [0,0,0]', closeTo(piv1.crank ?? [], [0, 0, 0], 0.01), fmt(piv1.crank ?? []));

// ---------- 2. re-basing reaches the stored geometry ----------
console.log('\n--- 2  the stored geometry is physically shifted onto the pivot ---');
const runs = await runsIndex();
const motionRuns = runs.filter((r) => r.kind === 'motion');
const newest = motionRuns[motionRuns.length - 1];
const partsDir = join(project.root, 'runs', newest?.id ?? 'r000', 'parts');
const barStlPath = join(partsDir, 'bar.stl');
check('the motion run stored its part STLs', existsSync(barStlPath), barStlPath);
if (existsSync(barStlPath)) {
  const c = bboxCentreOfStl(new Uint8Array(await readFile(barStlPath)));
  check('bar.stl is centred on the pivot (turns in place)', closeTo(c, [0, 0, 0], 0.5), `bbox centre ${fmt(c)}`);
  check('  …i.e. it is no longer parked at x≈120', !close(c[0], 120, 1), `x = ${c[0].toFixed(2)}`);
}

// ---------- 3. fallback: geometry centre when no joint names the part ----------
console.log('\n--- 3  a part named by no joint falls back to its own centre ---');
const r3 = await run([{ name: 'free', bodyType: 'dynamic', position: [0, 0, 0], scadCode: freeScad }]);
check('free pivot = geometry centre [50,0,0]', closeTo(r3.value.pivots?.free ?? [], [50, 0, 0], 0.05),
  fmt(r3.value.pivots?.free ?? []));

// ---------- 4. explicit pivot overrides the joint anchor ----------
console.log('\n--- 4  explicit pivot wins over the joint anchor ---');
const r4 = await run([], undefined, [7, 8, 9]);
check('bar pivot = the explicit [7,8,9]', closeTo(r4.value.pivots?.bar ?? [], [7, 8, 9], 0.01),
  fmt(r4.value.pivots?.bar ?? []));

// ---------- 5. joints stay together through a full turn ----------
console.log('\n--- 5  joint anchors are shifted too, so nothing drifts ---');
check('max joint drift through a full turn is sub-0.05mm', (r1.value.maxJointDriftMm ?? 99) < 0.05,
  `${(r1.value.maxJointDriftMm ?? NaN).toFixed(4)}mm`);
check('no joint violations', (r1.value.jointViolations ?? []).length === 0,
  JSON.stringify(r1.value.jointViolations ?? []));
check('a full turn actually ran', (r1.value.stepsRun ?? 0) > 10, `${r1.value.stepsRun} steps`);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
