// Acceptance for the three P0 defects found in the microscope2 retrospective
// (verification/microscope2-audit.md), exercised through the REAL tool objects
// (registerCadTools + execute + finalizeContent), not through the host modules
// underneath them — the bugs were in the tool layer.
//
//   P0-1  check_assembly required its manifest under the plugin data root, i.e.
//         outside the session workspace, so using it at all forced the session
//         out of the sandbox. Fixed: relative paths resolve against the session
//         workspace first, the data root stays as a fallback.
//   P0-2  simulate_motion / simulate_physics / simulate_fluid returned their
//         metrics structurally and then threw them away in finalizeContent.
//         Fixed: the numbers are in the text block the model actually sees.
//   P0-3  validate_assembly had every part in one scene and rendered nothing.
//         Fixed: it renders the assembly (iso/front/side) into the run's frames
//         and attaches them to the result.
//
// Hermetic: DSH_HOME points at a temp dir, so no real corpus is read or written.

import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'cad-p0-home-'));
const workspace = await mkdtemp(join(tmpdir(), 'cad-p0-work-'));
process.env.DSH_HOME = home; // must precede the first dshHome() call

const { registerCadTools } = await import('../src/host/tools.ts');
const { projectStores } = await import('../src/host/project.ts');
const { saveVersion } = await import('../src/host/version.ts');
const { compileStlOnly } = await import('../src/host/compile.ts');

// ---------- fake cordis ctx: capture the tools instead of serving them ----------

const tools = new Map();
const savedImages = [];
const ctx = {
  tools: { register: (def) => { tools.set(def.name, def); } },
  attachments: {
    saveImages: async (items) => items.map((it) => {
      savedImages.push({ name: it.name, bytes: it.data.length, data: it.data });
      return { kind: 'stub-attachment', name: it.name };
    }),
  },
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
const textOf = (blocks) =>
  (blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
const imagesOf = (blocks) => (blocks ?? []).filter((b) => b.type === 'image');
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) fail++;
};
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

// ---------- corpus: a plate and a post, post placed ON the plate ----------

const store = projectStores(workspace).store;
const plate = await compileStlOnly('cube([60,40,10]);\ndatum("顶面", [30,20,10]);');
const post = await compileStlOnly('cylinder(r=5, h=30, $fn=48);\ndatum("底面", [0,0,0]);');
if (!plate.success || !post.success) { console.error('FAIL: test parts did not compile'); process.exit(1); }

const vPlate = await saveVersion(store, {
  scadCode: 'cube([60,40,10]);', stl: plate.stl, userIntent: 'P0 fixture: plate', datumSet: plate.datumSet,
});
const vPost = await saveVersion(store, {
  scadCode: 'cylinder(r=5, h=30, $fn=48);', stl: post.stl, userIntent: 'P0 fixture: post', datumSet: post.datumSet,
});

const manifest = {
  schemaVersion: 1,
  name: 'P0 fixture assembly',
  unit: 'mm',
  up: 'z',
  root: {
    id: 'fixture',
    name: 'P0 fixture',
    kind: 'assembly',
    children: [
      { id: 'plate', name: '底板', kind: 'part', version: vPlate },
      { id: 'post', name: '立柱', kind: 'part', version: vPost, transform: { translate: [30, 20, 10] } },
    ],
    interfaces: [
      {
        id: 'if-seat', a: 'plate.顶面', b: 'post.底面', type: '贴合',
        nominal: { quantity: '距离', value: 0 }, tolerance: { min: -0.2, max: 0.2 },
        severity: 'hard', layer: 'L0', check: 'distance',
      },
    ],
  },
};

// ================= P0-1: the manifest no longer has to leave the workspace ====

console.log('\n--- P0-1  manifest resolution ---');
const dataManifest = join(projectStores(workspace).root, 'assembly', 'assembly.json');

// (a) legacy corpus: manifest ONLY in the data root → still found (back-compat)
await mkdir(join(projectStores(workspace).root, 'assembly'), { recursive: true });
await writeFile(dataManifest, JSON.stringify(manifest));
const legacy = await call('check_assembly', {});
check('data-root fallback still works', legacy.value.overallStatus === 'pass',
  `status=${legacy.value.overallStatus} path=${legacy.value.manifestPath}`);
check('  …and reports the data-root path',
  typeof legacy.value.manifestPath === 'string' && legacy.value.manifestPath.includes(`${projectStores(workspace).root}`),
  legacy.value.manifestPath);

// (b) the fix: a manifest inside the session workspace, no escalation required
await mkdir(join(workspace, 'assembly'), { recursive: true });
await writeFile(join(workspace, 'assembly', 'assembly.json'), JSON.stringify(manifest));
const inWorkspace = await call('check_assembly', {});
check('workspace manifest is used', inWorkspace.value.overallStatus === 'pass',
  `status=${inWorkspace.value.overallStatus}`);
check('  …and wins over the data-root copy',
  inWorkspace.value.manifestPath === join(workspace, 'assembly', 'assembly.json'),
  inWorkspace.value.manifestPath);
check('  …and its report is written beside it (inside the workspace)',
  await exists(join(workspace, 'assembly', 'assembly-check-report.json')));

// (c) an explicitly named missing manifest names every place it looked
let missing = null;
try { await call('check_assembly', { manifestPath: 'assembly/nope.json' }); } catch (e) { missing = String(e?.message ?? e); }
check('missing manifest error names both candidates',
  !!missing && missing.includes(join(workspace, 'assembly', 'nope.json')) && missing.includes(projectStores(workspace).root),
  missing ?? '(no error thrown)');

// (d) an absolute path is honoured as given
const absDir = await mkdtemp(join(tmpdir(), 'cad-p0-abs-'));
await writeFile(join(absDir, 'elsewhere.json'), JSON.stringify(manifest));
const absolute = await call('check_assembly', { manifestPath: join(absDir, 'elsewhere.json') });
check('absolute manifestPath used as given',
  absolute.value.overallStatus === 'pass' && absolute.value.manifestPath === join(absDir, 'elsewhere.json'));

// ================= P0-3: validate_assembly renders the assembly ==============

console.log('\n--- P0-3  assembly render ---');
const va = await call('validate_assembly', {
  clearanceThreshold: 0.75,
  parts: [
    { name: 'plate', versionId: vPlate },
    { name: 'post', versionId: vPost, translate: [30, 20, 10] },
    // both transforms at once: the plugin convention is `world = t + R·local`,
    // and OpenSCAD needs it written `translate(t) rotate(R)` — the reverse order
    // teleports the part (it did, on the real microscope2 manifest).
    { name: 'post2', versionId: vPost, translate: [10, 20, 10], rotate: [0, 0, 90] },
  ],
});
check('validate_assembly still returns the numeric verdict',
  typeof va.value.overallStatus === 'string' && va.value.pairs.length === 3,
  `status=${va.value.overallStatus} pairs=${va.value.pairs.length}`);

const runsRoot = join(projectStores(workspace).root, 'runs');
const runIds = (await readFile(join(runsRoot, 'manifest.json'), 'utf8').then(JSON.parse)).runs.map((r) => r.id);
const assemblyRun = runIds.at(-1);
const framesDir = join(runsRoot, assemblyRun, 'frames');
const frameFiles = ['assembly_iso.png', 'assembly_front.png', 'assembly_side.png'];
const present = [];
for (const f of frameFiles) if (await exists(join(framesDir, f))) present.push(f);
check('three assembly views rendered into the run frames dir',
  present.length === 3, `${present.join(', ')} in ${framesDir}`);

if (present.length > 0) {
  const png = await readFile(join(framesDir, 'assembly_iso.png'));
  check('  …and they are real PNGs', png.subarray(0, 4).equals(PNG_MAGIC), `${png.length} bytes`);
  const scad = await readFile(join(framesDir, 'assembly.scad'), 'utf8');
  check('  …scene places the post at its declared transform',
    scad.includes('translate([30,20,10]) import('), scad.split('\n')[2] ?? '');
  check('  …scene orders translate BEFORE rotate (world = t + R·local)',
    scad.includes('translate([10,20,10]) rotate([0,0,90]) import('),
    (scad.split('\n').find((l) => l.includes('post2')) ?? '').slice(0, 120));
  check('  …scene colours parts distinctly', (scad.match(/color\(\[/g) ?? []).length === 3);
}

const vaImages = imagesOf(va.blocks);
check('validate_assembly attaches the views to the conversation',
  vaImages.length === 3, `${vaImages.length} image block(s)`);
check('  …and still carries the numbers in text',
  /Assembly \w+: \d+ parts, \d+ pairs at a [\d.]+mm clearance threshold/.test(textOf(va.blocks)) &&
  /plate↔post/.test(textOf(va.blocks)),
  textOf(va.blocks).split('\n')[0]);

// ================= P0-2: simulators keep their metrics ======================

console.log('\n--- P0-2  metrics survive finalizeContent ---');

const cube = await compileStlOnly('cube([20,20,20]);');
const vCube = await saveVersion(store, { scadCode: 'cube([20,20,20]);', stl: cube.stl, userIntent: 'P0 fixture: cube' });

const motion = await call('simulate_motion', {
  cycles: 1,
  parts: [
    {
      name: 'frame', bodyType: 'fixed', position: [0, 0, 0],
      scadCode: 'cube([80,80,10], center=true);',
    },
    {
      name: 'crank', bodyType: 'kinematic', position: [0, 0, 30],
      scadCode: 'translate([0,16,0]) cube([6,32,10], center=true);',
    },
    {
      name: 'rod', bodyType: 'dynamic', position: [0, 24, 30],
      scadCode: 'cube([8,8,8], center=true);',
    },
  ],
  joints: [
    // the crank's axis is pinned to the frame; the rod is carried at an offset,
    // so it has to move — that is the "follower" whose travel we assert on.
    { type: 'revolute', bodyA: 'frame', bodyB: 'crank', anchorA: [0, 0, 30], anchorB: [0, 0, 0], axis: [0, 0, 1] },
    { type: 'revolute', bodyA: 'crank', bodyB: 'rod', anchorA: [0, 24, 0], anchorB: [0, 0, 0], axis: [0, 0, 1] },
  ],
  drive: { body: 'crank', axis: [0, 0, 1], omegaRadPerSec: 2 },
});
const motionText = textOf(motion.blocks);
check('simulate_motion text carries travel + interference + drift',
  /travel .*mm on/.test(motionText) && /Interference: \d+ event/.test(motionText) && /Max joint drift: /.test(motionText),
  motionText.split('\n').slice(0, 4).join(' | '));
check('  …and keeps the keyframe images', imagesOf(motion.blocks).length > 0,
  `${imagesOf(motion.blocks).length} image block(s)`);

const physics = await call('simulate_physics', {
  durationSec: 1,
  parts: [
    { name: 'ground', bodyType: 'fixed', position: [0, 0, -15], scadCode: 'cube([120,120,10], center=true);' },
    { name: 'block', bodyType: 'dynamic', position: [0, 0, 15], versionId: vCube },
  ],
});
const physicsText = textOf(physics.blocks);
check('simulate_physics text carries penetration + topple verdict',
  /Settled penetration .*mm/.test(physicsText) && /(stayed upright|FELL OVER|No body tipped)/.test(physicsText),
  physicsText.split('\n').slice(0, 3).join(' | '));

// ---------- attachment hygiene: every attached name is a real PNG payload ----------
const badImages = savedImages.filter((s) => !s.data.subarray(0, 4).equals(PNG_MAGIC));
check('every attached image payload is a PNG', badImages.length === 0,
  `${savedImages.length} attached, ${badImages.length} not PNG`);

await rm(home, { recursive: true, force: true }).catch(() => {});
await rm(workspace, { recursive: true, force: true }).catch(() => {});
await rm(absDir, { recursive: true, force: true }).catch(() => {});

console.log(fail === 0 ? '\nP0 ACCEPTANCE PASSED' : `\nP0 ACCEPTANCE FAILED (${fail})`);
process.exit(fail === 0 ? 0 : 1);
