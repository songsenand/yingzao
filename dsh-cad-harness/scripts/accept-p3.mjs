// Acceptance for the microscope3-audit P0/P1/P2 items, driven through the REAL
// tool objects (execute + finalizeContent), hermetic (temp DSH_HOME):
//
//   P0-1 generate_part did not report watertightness, so microscope3 shipped a
//        non-closed, wrong-toothed gear through nine versions until a human
//        screenshot caught it. Fixed: every save reports watertight/triangles/
//        shells, and the finalize text screams on a false one.
//   P0-2 (skill) OpenSCAD degrees-in-degrees-out vs radian gear math — now a
//        named trap in SKILL.md (asserted by grep, like a doc test).
//   P0-3 measure_closest reported a fake 0.05mm "clearance" on that open mesh.
//        Fixed: both measure tools warn loudly on non-watertight inputs.
//   P1-1 coaxial operator: microscope3's interfaces 14/15 degenerated into
//        two-point distances. Fixed: axis-to-axis line distance + tilt flag.
//   P1-2 assembly pose: a meshing angle written as transform.rotate drags the
//        D-flat and every datum with it. Fixed: transform.pose {datum,
//        angleDeg} rotates about the part's OWN datum axis, datums following.
//   P1-3 physics penetration on a many-shell body was reported without telling
//        the model it is unreliable. Fixed: shell-count input diagnostics.
//   P1-4 "will the slide hold?" — rapier joints have no friction. Fixed:
//        staticFriction param + labelled quasi-static hold analysis.
//   P2-1 thread polygonisation noise: interferenceEpsilonMm3 on validate_assembly.
//   P2-2 slope gravity vector by hand → tiltDeg.

import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = await mkdtemp(join(tmpdir(), 'cad-p3-home-'));
const workspace = await mkdtemp(join(tmpdir(), 'cad-p3-work-'));
process.env.DSH_HOME = home;

const { registerCadTools } = await import('../src/host/tools.ts');
const { projectStores } = await import('../src/host/project.ts');
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

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) fail++;
};

const project = projectStores(workspace);
const store = project.store;

// ================= P0-1: generate_part reports mesh truth ===================

console.log('\n--- P0-1  generate_part watertight ---');
const closed = await call('generate_part', {
  userIntent: 'P3 closed cube',
  part: 'P3 闭合块',
  scadCode: 'cube([20,20,20]);',
});
check('a closed cube reports watertight: true',
  closed.value.watertight === true && closed.value.triangles === 12 && closed.value.shells === 1,
  JSON.stringify({ wt: closed.value.watertight, tri: closed.value.triangles, shells: closed.value.shells }));
check('  …and the happy text does not scream', !/NOT WATERTIGHT/.test(textOf(closed.blocks)));

// one open triangle: a mesh that is not a solid
const open = await call('generate_part', {
  userIntent: 'P3 open triangle (deliberately not a solid)',
  part: 'P3 开口片',
  scadCode: 'polyhedron(points=[[0,0,0],[30,0,0],[0,30,0]], faces=[[0,1,2]]);',
});
check('an open mesh reports watertight: false', open.value.watertight === false,
  JSON.stringify({ wt: open.value.watertight, shells: open.value.shells }));
check('  …the result text carries a loud warning',
  /NOT WATERTIGHT/.test(textOf(open.blocks)) && /false premise|lie/.test(textOf(open.blocks)),
  textOf(open.blocks).split('\n')[0]);
check('  …and the structured warnings array carries it too',
  (open.value.warnings ?? []).some((w) => /NOT watertight/.test(w)));

// ================= P0-3: measure tools roar on open meshes ==================

console.log('\n--- P0-3  measure_* warnings on open meshes ---');
const vClosed = closed.value.versionId;
const vOpen = open.value.versionId;
const closest = await call('measure_gap', { aVersionId: vOpen, bVersionId: vClosed });
check('measure_gap: a solid/solid pair needs no base part', closest.ok !== false, JSON.stringify(closest.value).slice(0, 80));
check('measure_gap (solid/solid) warns when an input is not watertight',
  (closest.value.warnings ?? []).some((w) => /NOT watertight/.test(w)),
  JSON.stringify(closest.value.warnings ?? []));
const closestClosed = await call('measure_gap', { aVersionId: vClosed, bVersionId: vClosed });
check('  …and stays silent on closed solids',
  (closestClosed.value.warnings ?? []).length === 0);
const dist = await call('measure_gap', {
  versionId: vOpen, aPoint: [5, 5, 0], bOn: vClosed, bPoint: [10, 10, 20],
});
check('measure_gap (point/point) warns on open-mesh surface snapping too',
  (dist.value.warnings ?? []).some((w) => /NOT watertight/.test(w)),
  JSON.stringify(dist.value.warnings ?? []));
const distDatum = await call('measure_gap', {
  versionId: vClosed, aPoint: [0, 0, 20], bPoint: [0, 0, 0],
});
check('  …with clean inputs there are no warnings',
  (distDatum.value.warnings ?? []).length === 0 && distDatum.value.distanceMm === 20,
  `d=${distDatum.value.distanceMm}`);

// ================= P0-2: the skill names the radians trap ===================

console.log('\n--- P0-2  SKILL.md degrees/radians trap ---');
const skillPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'cad-toolbox', 'SKILL.md');
const skill = await readFile(skillPath, 'utf8');
// CONTENT assertions read the WHOLE skills tree; only the "names every registered
// tool" assertion stays pinned to the router, because naming every tool IS the
// router's contract. The skill is layered now (tier-1 router + per-job skills +
// reference files), so prose moves between files — a doc test pinned to one path
// either breaks loudly for no reason or, worse, silently stops testing anything.
const { readdirSync: rdSkills, statSync: stSkills } = await import('node:fs');
const { join: joinSkills } = await import('node:path');
const skillsRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const walkSkills = (dir) => rdSkills(dir).flatMap((e) => {
  const full = joinSkills(dir, e);
  return stSkills(full).isDirectory() ? walkSkills(full) : full.endsWith('.md') ? [full] : [];
});
const skillTree = (await Promise.all(walkSkills(skillsRoot).map((f) => readFile(f, 'utf8')))).join('\n');
check('the skill set names the OpenSCAD degrees in / radians out trap',
  /DEGREES in/i.test(skillTree) && /inv\(α\)/.test(skillTree) && /d2r/.test(skillTree));
check('the skill set orders watertight over pretty',
  /Watertight beats pretty/.test(skillTree) && /NOT WATERTIGHT/.test(skillTree));

// ================= P1-1: coaxial operator ====================================

console.log('\n--- P1-1  coaxial operator (check_assembly) ---');
await mkdir(join(workspace, 'assembly'), { recursive: true });
const vLower = (await call('generate_part', {
  userIntent: 'P3 lower block with a datum axis',
  part: 'P3 下块',
  scadCode: 'cube([40,40,10]);\ndatum_axis("轴线",[0,0,0],[0,0,1]);\ndatum("顶面",[20,20,10]);',
})).value.versionId;
const vUpper = (await call('generate_part', {
  userIntent: 'P3 upper block with a datum axis, offset on purpose',
  part: 'P3 上块',
  scadCode: 'cube([40,40,10]);\ndatum_axis("轴线",[0,0,0],[0,0,1]);\ndatum("底面",[20,20,0]);',
})).value.versionId;

const manifestWith = async (ifaces, children) => {
  const m = {
    schemaVersion: 1, name: 'P3 fixture', unit: 'mm', up: 'z',
    root: { id: 'fx', name: 'P3 fixture', kind: 'assembly', children, interfaces: ifaces },
  };
  await writeFile(join(workspace, 'assembly', 'assembly.json'), JSON.stringify(m));
};
const plainChildren = [
  { id: 'lower', name: '下块', kind: 'part', version: vLower },
  // 0.5mm sideways offset: the two axis LINES are 0.5mm apart even though both
  // anchor points sit at their own block's origin, and the point distance
  // between 顶面/底面 would say 10.
  { id: 'upper', name: '上块', kind: 'part', version: vUpper, transform: { translate: [0.5, 0, 10] } },
];

// (a) parallel axes, 0.5mm offset — inside a 0.6 tolerance
await manifestWith([{
  id: 'if-ax', a: 'lower.轴线', b: 'upper.轴线', type: '贴合', check: 'coaxial',
  nominal: { quantity: '同轴度', value: 0 }, tolerance: { min: 0, max: 0.6 }, severity: 'hard',
}], plainChildren);
const coax = await call('check_assembly', {});
const coaxR = coax.value;
check('coaxial measures the axis-to-axis offset (0.5mm parallel axes)',
  coaxR.summary.pass === 1 && coaxR.summary.skipped === 0,
  `pass=${coaxR.summary.pass} skipped=${coaxR.summary.skipped}`);
// The file beside the manifest is a POINTER to the immutable run (FIX-C1); follow it.
const reportPointer = JSON.parse(await readFile(join(workspace, 'assembly', 'assembly-check-report.json'), 'utf8'));
const reportPath = join(project.runStore.root, reportPointer.runId, 'report.json');
const coaxReport = JSON.parse(await readFile(reportPath, 'utf8'));
const axResult = coaxReport.results.find((r) => r.interfaceId === 'if-ax');
check('  …measured 0.5mm, not a point distance (points are 10mm apart)',
  axResult.verdict === 'pass' && Math.abs(axResult.measured - 0.5) < 1e-6,
  `measured=${axResult.measured} — ${axResult.detail}`);

// (b) out-of-tolerance offset is a hard violation
await manifestWith([{
  id: 'if-ax', a: 'lower.轴线', b: 'upper.轴线', type: '贴合', check: 'coaxial',
  nominal: { quantity: '同轴度', value: 0 }, tolerance: { min: 0, max: 0.2 }, severity: 'hard',
}], [
  plainChildren[0],
  { ...plainChildren[1], transform: { translate: [0.8, 0, 10] } },
]);
await call('check_assembly', {});
const coaxBad2 = JSON.parse(await readFile(reportPath, 'utf8'));
check('  …an 0.8mm offset against a 0.2 tolerance is a hard-violation',
  coaxBad2.results.find((r) => r.interfaceId === 'if-ax').verdict === 'hard-violation',
  coaxBad2.results.find((r) => r.interfaceId === 'if-ax').detail);

// (c) a point datum cannot be coaxial — say what is missing
await manifestWith([{
  id: 'if-ax', a: 'lower.顶面', b: 'upper.底面', type: '贴合', check: 'coaxial',
  nominal: { quantity: '同轴度', value: 0 }, tolerance: { min: 0, max: 0.6 }, severity: 'hard',
}], plainChildren);
await call('check_assembly', {});
const coaxPoint = JSON.parse(await readFile(reportPath, 'utf8'));
check('  …a point endpoint is skipped with instructions, not silently passed',
  coaxPoint.results.find((r) => r.interfaceId === 'if-ax').verdict === 'skipped' &&
    /datum_axis|datum_cyl/.test(coaxPoint.results.find((r) => r.interfaceId === 'if-ax').detail),
  coaxPoint.results.find((r) => r.interfaceId === 'if-ax').detail.slice(0, 90));

// ================= P1-2: assembly pose about a datum axis ====================

console.log('\n--- P1-2  transform.pose (rotate about the part\'s own datum axis) ---');
const vArm = (await call('generate_part', {
  userIntent: 'P3 long arm along +x, rotating about a z datum axis at the origin',
  part: 'P3 摇臂',
  scadCode: 'translate([15,0,0]) cube([30,6,10]);\ndatum_axis("轴",[0,0,5],[0,0,1]);\ndatum("标记",[15,45,5]);',
})).value.versionId;
const vTarget = (await call('generate_part', {
  userIntent: 'P3 target block with a datum where the rotated arm tip should land',
  part: 'P3 靶块',
  scadCode: 'translate([-55,10,0]) cube([10,10,10]);\ndatum("靶",[-45,15,5]);',
})).value.versionId;
const vObstacle = (await call('generate_part', {
  userIntent: 'P3 obstacle in the rotated arm\'s path',
  part: 'P3 障碍块',
  scadCode: 'translate([-5,18,0]) cube([30,6,10]);',
})).value.versionId;

// pose 90° about z through the origin: arm tip (15,45,5) → (−45,15,5) = 靶;
// rotated arm occupies x∈[−6,0], y∈[15,45] → overlaps the obstacle.
await manifestWith([{
  id: 'if-tip', a: 'arm.标记', b: 'target.靶', type: '贴合',
  nominal: { quantity: '距离', value: 0 }, tolerance: { min: 0, max: 0.001 }, severity: 'hard',
}], [
  { id: 'arm', name: '摇臂', kind: 'part', version: vArm, transform: { pose: { datum: '轴', angleDeg: 90 } } },
  { id: 'target', name: '靶块', kind: 'part', version: vTarget },
  { id: 'obstacle', name: '障碍块', kind: 'part', version: vObstacle },
]);
await call('check_assembly', {});
const poseReport = JSON.parse(await readFile(reportPath, 'utf8'));
const tip = poseReport.results.find((r) => r.interfaceId === 'if-tip');
check('the pose rotates DATUMS with the part (tip lands exactly on the target datum)',
  tip.verdict === 'pass' && tip.measured < 1e-6,
  `measured=${tip.measured} — ${tip.detail}`);
check('  …and rotates the GEOMETRY too (posed arm collides with the obstacle → undeclared pair)',
  poseReport.undeclared.some((u) => (u.partA === 'arm' && u.partB === 'obstacle') || (u.partA === 'obstacle' && u.partB === 'arm')),
  JSON.stringify(poseReport.undeclared));

// same manifest WITHOUT the pose: tip stays at (15,45,5), far from the target;
// arm stays along +x, clear of the obstacle.
await manifestWith([{
  id: 'if-tip', a: 'arm.标记', b: 'target.靶', type: '贴合',
  nominal: { quantity: '距离', value: 0 }, tolerance: { min: 0, max: 0.001 }, severity: 'hard',
}], [
  { id: 'arm', name: '摇臂', kind: 'part', version: vArm },
  { id: 'target', name: '靶块', kind: 'part', version: vTarget },
  { id: 'obstacle', name: '障碍块', kind: 'part', version: vObstacle },
]);
await call('check_assembly', {});
const noPoseReport = JSON.parse(await readFile(reportPath, 'utf8'));
check('  …and without the pose nothing lines up (control)',
  noPoseReport.results.find((r) => r.interfaceId === 'if-tip').verdict === 'hard-violation' &&
    noPoseReport.undeclared.length === 0,
  `tip=${noPoseReport.results.find((r) => r.interfaceId === 'if-tip').measured} undeclared=${noPoseReport.undeclared.length}`);

// validate_assembly accepts the same pose argument
const posed = await call('validate_assembly', {
  parts: [
    { name: 'arm', versionId: vArm, pose: { datum: '轴', angleDeg: 90 } },
    { name: 'obstacle', versionId: vObstacle },
  ],
});
check('validate_assembly parts accept pose too (posed arm interferes with the obstacle)',
  posed.value.pairs.some((p) => p.status === 'interference' && (p.partA === 'arm' || p.partB === 'arm')),
  JSON.stringify(posed.value.pairs));
const unposed = await call('validate_assembly', {
  parts: [{ name: 'arm', versionId: vArm }, { name: 'obstacle', versionId: vObstacle }],
});
check('  …while the unposed arm clears it (control)',
  unposed.value.pairs.every((p) => p.status !== 'interference'),
  JSON.stringify(unposed.value.pairs.map((p) => p.status)));

// ================= P1-3 + P1-4 + P2-2: physics honesty =======================

console.log('\n--- P1-3/P1-4/P2-2  physics diagnostics, hold analysis, tilt ---');
const multiShell = await call('simulate_physics', {
  durationSec: 1,
  parts: [{ name: 'pile', bodyType: 'dynamic', position: [0, 0, 5],
    scadCode: 'translate([0,0,0]) cube([10,10,10], center=true);\ntranslate([100,0,0]) cube([10,10,10], center=true);\ntranslate([0,100,0]) cube([10,10,10], center=true);\ntranslate([100,100,0]) cube([10,10,10], center=true);' }],
});
check('a 4-shell input gets an honest penetration-reliability note',
  (multiShell.value.notes ?? []).some((n) => /4 disconnected shells/.test(n) && /artefact|artifacts|artefact/.test(n)),
  JSON.stringify(multiShell.value.notes ?? []));
check('  …and the finalize text carries the note',
  /disconnected shells/.test(textOf(multiShell.blocks)));
const single = await call('simulate_physics', {
  durationSec: 0.5,
  parts: [{ name: 'cube', bodyType: 'dynamic', position: [0, 0, 5], scadCode: 'cube([10,10,10]);' }],
});
check('  …a single-shell input gets no such note',
  !(single.value.notes ?? []).some((n) => /disconnected shells/.test(n)));

const slide = await call('simulate_physics', {
  durationSec: 1,
  parts: [
    { name: 'rail', bodyType: 'fixed', position: [0, 0, 0], scadCode: 'cube([10,10,60]);' },
    { name: 'block', bodyType: 'dynamic', position: [40, 0, 50], scadCode: 'cube([10,10,10], center=true);' },
  ],
  joints: [{ type: 'prismatic', bodyA: 'rail', bodyB: 'block', anchorA: [40, 0, 50], anchorB: [0, 0, 0], axis: [0, 0, 1], staticFriction: 0.5 }],
});
const hold = (slide.value.holdAnalysis ?? [])[0];
check('staticFriction produces a labelled hold analysis',
  !!hold && /QUASI-STATIC/.test(JSON.stringify(slide.value.notes)),
  JSON.stringify(slide.value.holdAnalysis ?? slide.value.notes));
check('  …a VERTICAL slide under gravity can never hold (no normal force)',
  hold && hold.holds === false && hold.frictionCapN === 0 && hold.axialDriveN > 0,
  JSON.stringify(hold ?? {}));
check('  …and the finalize text says so in words',
  /SLIDES under gravity/.test(textOf(slide.blocks)), textOf(slide.blocks).split('\n').find((l) => /HOLD/.test(l)) ?? '');

// tiltDeg: same block on a big floor — flat it stays, 45° tilt it slides away
const flat = await call('simulate_physics', {
  durationSec: 1.5,
  parts: [
    { name: 'floor', bodyType: 'fixed', position: [0, 0, -5], scadCode: 'cube([200,200,10], center=true);' },
    { name: 'block', bodyType: 'dynamic', position: [0, 0, 5], scadCode: 'cube([20,20,10], center=true);' },
  ],
});
const tilted = await call('simulate_physics', {
  durationSec: 1.5, tiltDeg: 45,
  parts: [
    { name: 'floor', bodyType: 'fixed', position: [0, 0, -5], scadCode: 'cube([200,200,10], center=true);' },
    { name: 'block', bodyType: 'dynamic', position: [0, 0, 5], scadCode: 'cube([20,20,10], center=true);' },
  ],
});
// use the persisted reports for maxHorizontalDisplacementMm
const lastRuns = async () => JSON.parse(await readFile(join(project.root, 'runs', 'manifest.json'), 'utf8')).runs;
const runsNow = await lastRuns();
const reportOf = async (id) => JSON.parse(await readFile(join(project.root, 'runs', id, 'report.json'), 'utf8'));
const tiltedReport = await reportOf(runsNow.at(-1).id);
const flatReport = await reportOf(runsNow.at(-2).id);
const disp = (rep) => Math.max(...Object.values(rep.metrics.maxHorizontalDisplacementMm ?? { a: 0 }));
check('tiltDeg: a block on a flat floor stays put',
  disp(flatReport) < 5, `disp=${disp(flatReport).toFixed(1)}mm`);
check('  …the same block at tiltDeg 45 slides (gravity vector actually tilted)',
  disp(tiltedReport) > 20, `disp=${disp(tiltedReport).toFixed(1)}mm`);

// ================= P2-1: interference epsilon ================================
console.log('\n--- P2-1  interferenceEpsilonMm3 ---');
const vA = (await call('generate_part', {
  userIntent: 'P3 epsilon block A', part: 'P3 块A', scadCode: 'cube([10,10,10]);',
})).value.versionId;
const vB = (await call('generate_part', {
  userIntent: 'P3 epsilon block B, 1mm³ whisper-overlap into A', part: 'P3 块B',
  scadCode: 'translate([9.9,0,0]) cube([10,10,10]);',
})).value.versionId;
const strict = await call('validate_assembly', {
  parts: [{ name: 'a', versionId: vA }, { name: 'b', versionId: vB }],
});
const forgiving = await call('validate_assembly', {
  parts: [{ name: 'a', versionId: vA }, { name: 'b', versionId: vB }],
  interferenceEpsilonMm3: 100,
});
check('a ~1mm³ overlap IS interference at the default epsilon',
  strict.value.pairs.some((p) => p.status === 'interference'),
  JSON.stringify(strict.value.pairs.map((p) => [p.status, p.intersectionVolume])));
check('  …and is a non-failing residual at epsilon 100 (volume still visible)',
  forgiving.value.overallStatus === 'pass' &&
    forgiving.value.pairs.some((p) => p.intersectionVolume > 0 && p.status === 'ok'),
  JSON.stringify(forgiving.value.pairs.map((p) => [p.status, p.intersectionVolume])));

// ================= context economy: views param + screenshot dialog =========

console.log('\n--- context  views param + screenshot dialog ---');
const isoOnly = await call('generate_part', {
  userIntent: 'P3 budget iteration (single view)',
  part: 'P3 省图块',
  scadCode: 'cube([10,10,10]);',
  views: ['iso'],
});
check('generate_part views:["iso"] attaches exactly one image',
  JSON.stringify(isoOnly.value.views) === '["iso"]' && textOf(isoOnly.blocks).includes('iso') && !/front, /.test(textOf(isoOnly.blocks)),
  JSON.stringify(isoOnly.value.views));
const defaultViews = await call('generate_part', {
  userIntent: 'P3 default (all four views)',
  part: 'P3 省图块',
  scadCode: 'cube([10,10,10]);',
});
check('generate_part default still attaches all four views',
  defaultViews.value.views.length === 4, JSON.stringify(defaultViews.value.views));
const bogusViews = await call('generate_part', {
  userIntent: 'P3 bogus view names must not attach nothing',
  part: 'P3 省图块',
  scadCode: 'cube([10,10,10]);',
  views: ['bogus', 'nonsense'],
});
check('generate_part with only unknown view names falls back to all four',
  bogusViews.value.views.length === 4, JSON.stringify(bogusViews.value.views));
const skillNow = await readFile(skillPath, 'utf8');
check('the skill set teaches the image-budget economy (views on numeric iterations)',
  /Images are the biggest context spend/.test(skillTree) && /views: \["iso"\]/.test(skillTree));

// ============ the measurement tools, driven through the REAL tool objects ============
// Each new op is covered by its own truth acceptance (accept-measure-thickness /
// -list-features / -measure-section / -measure-extent), but those drive the WORKER.
// Nothing yet proved the tool layer wires version ids to worker paths for them, so a
// schema or forwarding mistake could sit there unobserved. This closes that gap with
// a part that has a bore and a boss, through `execute` exactly as the agent calls it.
console.log('\n--- measurement tools end to end (tool layer) ---');
const vMeasure = (await call('generate_part', {
  userIntent: 'P3 measured part (plate with a bore and a boss)',
  part: 'P3 测量件',
  scadCode: 'difference(){ cube([40,40,8], center=true);'
    + ' translate([-12,0,0]) cylinder(h=20, d=6, center=true, $fn=48); }'
    + ' translate([12,0,7]) cylinder(h=8, d=10, center=true, $fn=48);',
  views: ['iso'],
})).value.versionId;

const thickness = await call('measure_thickness', {
  versionId: vMeasure, from: [-30, 0, 0], direction: '+x',
});
check('measure_thickness: the tool layer forwards an axis string and returns spans',
  thickness.value.spans.length >= 2 && thickness.value.spans.every((span) => span.thicknessMm > 0)
    && JSON.stringify(thickness.value.direction) === JSON.stringify([1, 0, 0]),
  `spans=${thickness.value.spans.length} thinnest=${thickness.value.thinnestSpanMm} dir=${JSON.stringify(thickness.value.direction)}`);
check('measure_thickness: the datum-free path still reports watertightness for the warning',
  thickness.value.watertightA === true && !('watertightB' in thickness.value),
  `watertightA=${thickness.value.watertightA} watertightB=${'watertightB' in thickness.value}`);

const features = await call('list_features', { versionId: vMeasure });
check('list_features: the tool layer returns faces, holes and the bore/boss classification',
  features.value.watertight === true && features.value.faceCount > 0
    && features.value.cylinders.some((cylinder) => cylinder.kind === 'bore')
    && features.value.cylinders.some((cylinder) => cylinder.kind === 'boss'),
  `faces=${features.value.faceCount} holes=${features.value.holeCount} cyls=${JSON.stringify(features.value.cylinders.map((c) => `${c.kind}:Ø${c.diameterMm}`))}`);
check('list_features: thresholds are echoed so a filtered list is readable',
  features.value.thresholds.minFaceAreaMm2 > 0 && typeof features.value.facesOmitted === 'number');

const section = await call('measure_section', { versionId: vMeasure, axis: 'z' });
check('measure_section: the tool layer sections a version and reports the plane frame',
  section.value.empty === false && section.value.polygons.length > 0
    && Array.isArray(section.value.uAxisMm) && typeof section.value.atMm === 'number',
  `polys=${section.value.polygons.length} holes=${section.value.holeCount} at=${section.value.atMm}`);
check('measure_section: a bad axis is refused by the worker, not silently defaulted',
  await call('measure_section', { versionId: vMeasure, axis: 'diagonal' }).then(() => false, () => true));

const extent = await call('measure_part', { versionId: vMeasure, axis: 'x' });
check('measure_part(axis): the tool layer projects on an axis and hands back extremal points',
  extent.value.extent.sizeMm > 39 && extent.value.extent.minPointMm.length === 3 && extent.value.extent.maxPointMm.length === 3,
  `size=${extent.value.extent.sizeMm} points=${JSON.stringify([extent.value.extent.minPointMm, extent.value.extent.maxPointMm])}`);
const diagonalExtent = await call('measure_part', { versionId: vMeasure, axisVector: [1, 1, 0] });
check('measure_part(axisVector): reaches the worker as a vector',
  Math.abs(diagonalExtent.value.extent.sizeMm - (40 + 40) / Math.SQRT2) < 0.1,
  `size=${diagonalExtent.value.extent.sizeMm}`);

const angleByProbe = await call('measure_angle', {
  versionId: vMeasure, aProbe: [30, 0, 0], bProbe: [0, 0, 10],
});
check('measure_angle: two probes reach the worker and report the convention trio',
  Math.abs(angleByProbe.value.acuteDeg - 90) < 0.01
    && Math.abs(angleByProbe.value.angleDeg + angleByProbe.value.supplementDeg - 180) < 0.01
    && angleByProbe.value.perpendicular === true,
  `${angleByProbe.value.angleDeg}/${angleByProbe.value.acuteDeg}/${angleByProbe.value.supplementDeg}`);

const vRail = (await call('generate_part', {
  userIntent: 'P3 datum rail', part: 'P3 导轨', scadCode: 'datum_axis("rail", [0,0,0], [0,0,1]); cube(8, center=true);',
  views: ['iso'],
})).value.versionId;
const angleByDatum = await call('measure_angle', { versionId: vRail, aDatum: 'rail', bDir: [1, 0, 0] });
check('measure_angle: a datum axis resolves through the tool layer and says so',
  Math.abs(angleByDatum.value.acuteDeg - 90) < 0.01
    && /datum axis "rail"/.test(angleByDatum.value.aSource),
  angleByDatum.value.aSource);
check('measure_angle: naming one side two ways is refused, not silently resolved',
  await call('measure_angle', { versionId: vRail, aDatum: 'rail', aDir: [1, 0, 0], bDir: [1, 0, 0] })
    .then(() => false, () => true));
check('measure_angle: a POINT datum is refused with a way forward (it has no direction)',
  await call('measure_angle', { versionId: vMeasure, aDatum: 'nope', bDir: [1, 0, 0] })
    .then(() => false, (error) => /not found|POINT/.test(String(error?.message ?? error))));

const panelSrc = await readFile(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'panel.ts'), 'utf8');
check('panel: 📸 opens a compose dialog (draft + send/park), text travels with the image',
  /shotDraft/.test(panelSrc) && /发送到会话/.test(panelSrc) && /只存托盘/.test(panelSrc) &&
    /userText: text/.test(panelSrc));
check('panel: the auto caption is READ-ONLY and always sent; the user types a separate note',
  /只读展示，随图必发/.test(panelSrc) && /\[d\.auto, note\]/.test(panelSrc));
// The section (剖切) has no geometry of its own — a clip plane is a shader effect —
// so the three things that make it MEASURABLE have to stay wired: the click is
// constrained to the plane, it snaps to a vertex, and the cut is drawn as a cap.
// Losing any one of them silently returns the old behaviour (clicks landing on the
// far interior wall, i.e. "two points in the section measure the part's diagonal").
check('panel: a click in the section is constrained to the cut plane, capped, and snaps to vertices AND hole centres',
  /projectToCutPlane\(/.test(panelSrc) && /nearestVertex\(/.test(panelSrc)
    && /capTriangles\(/.test(panelSrc) && /sectionSegments\(/.test(panelSrc)
    && /loopCentroids\(/.test(panelSrc) && /planeToWorld\(/.test(panelSrc)
    && /SNAP_PX/.test(panelSrc));
check('panel: measuring in a section says so in the caption the agent receives',
  /测量点已约束在该剖切面内/.test(panelSrc));

// ================= check_printability + delivery discipline =================

console.log('\n--- check_printability + delivery discipline ---');
const vGood = (await call('generate_part', {
  userIntent: 'P3 printable cube', part: 'P3 可打印块', scadCode: 'cube([12,12,12]);',
})).value.versionId;
const vThin = (await call('generate_part', {
  userIntent: 'P3 unprintably thin plate', part: 'P3 薄片', scadCode: 'cube([30,30,0.4]);',
})).value.versionId;
// S2-b fixtures: a BLIND narrow dimple (the negative control — it must never exclude a
// part), and a bore that exactly matches the requirement (the marginal band).
const vDimple = (await call('generate_part', {
  userIntent: 'P3 blind dimple (Ø0.5 x 0.3, cosmetic)', part: 'P3 盲凹陷',
  scadCode: 'difference() { cube([20,20,10], center=true); translate([0,0,4.85]) cylinder(r=0.25, h=0.3, center=true, $fn=32); }',
})).value.versionId;
const vExactBore = (await call('generate_part', {
  userIntent: 'P3 bore exactly at the requirement (Ø2.0)', part: 'P3 等宽孔',
  scadCode: 'difference() { cube([20,20,10], center=true); cylinder(r=1, h=30, center=true, $fn=48); }',
})).value.versionId;
// CNC tool-reach fixtures: a bore narrower than the declared cutter, one wide enough,
// and one so deep for its diameter that a drill would wander.
const vNarrowBore = (await call('generate_part', {
  userIntent: 'P3 narrow bore (Ø1.5)', part: 'P3 细孔',
  scadCode: 'difference() { cube([20,20,10], center=true); cylinder(r=0.75, h=30, center=true, $fn=48); }',
})).value.versionId;
const vWideBore = (await call('generate_part', {
  userIntent: 'P3 wide bore (Ø4)', part: 'P3 宽孔',
  scadCode: 'difference() { cube([20,20,10], center=true); cylinder(r=2, h=30, center=true, $fn=48); }',
})).value.versionId;
// S2-b non-circular passages: a rectangular through slot. Before 2026-10-13 these never
// reached the rule at all (the hole list filtered out anything without a diameter), so a
// narrow non-circular drain was silently absent rather than measured. Now each opening of the
// slot names a passage and the worker measures its bottleneck.
const vNarrowSlot = (await call('generate_part', {
  userIntent: 'P3 narrow through slot (1.5mm wide)', part: 'P3 窄槽',
  // The slot must NOT reach the face edge: an opening that runs out to the boundary is not a
  // closed loop, so list_features finds no hole to anchor at (measured: a 1.5×40 slot in a 20mm
  // block reports holeCount 0). 1.5 × 8 keeps the opening inside the z faces.
  scadCode: 'difference() { cube([20,20,10], center=true); cube([1.5,8,40], center=true); }',
})).value.versionId;
const vWideSlot = (await call('generate_part', {
  userIntent: 'P3 wide through slot (6mm wide)', part: 'P3 宽槽',
  scadCode: 'difference() { cube([20,20,10], center=true); cube([6,8,40], center=true); }',
})).value.versionId;
const vDeepBore = (await call('generate_part', {
  userIntent: 'P3 deep bore (Ø3 x 20)', part: 'P3 深孔',
  scadCode: 'difference() { cube([20,20,20], center=true); cylinder(r=1.5, h=40, center=true, $fn=48); }',
})).value.versionId;
// A SEALED cavity: a hollow with no drain/escape hole. This is the one escape-passage
// failure a mesh can prove — see the escapePassageMinMm checks below.
const vVoid = (await call('generate_part', {
  userIntent: 'P3 sealed cavity (no escape passage)', part: 'P3 封闭内腔',
  scadCode: 'difference() { sphere(r=10, $fn=64); sphere(r=9, $fn=64); }',
})).value.versionId;
const vCeil = (await call('generate_part', {
  userIntent: 'P3 slab on a post (huge unsupported ceiling)', part: 'P3 天花板',
  scadCode: 'cube([4,4,10]);\ntranslate([0,0,10]) cube([30,30,4]);',
})).value.versionId;

const good = await call('check_printability', { versionId: vGood, profileIds: ['fdm-pla-0.4'] });
check('a chunky cube screens ok (min wall 12mm, no overhang)',
  good.value.verdict === 'not-excluded' && Math.abs(good.value.minWallMm - 12) < 0.5 && good.value.findings.length === 0,
  JSON.stringify(good.value));
const thin = await call('check_printability', { versionId: vThin });
check('a 0.4mm plate is flagged EXCLUDED with min wall ≈0.4 and a located finding',
  thin.value.verdict === 'excluded' && Math.abs(thin.value.minWallMm - 0.4) < 0.1 &&
    /最薄壁/.test(thin.value.findings[0] ?? ''),
  JSON.stringify({ v: thin.value.verdict, w: thin.value.minWallMm, f: thin.value.findings }));
const ceil = await call('check_printability', { versionId: vCeil });
check('a 30×30 slab on a 4×4 post is flagged for its unsupported ceiling',
  ceil.value.verdict === 'difficult' && ceil.value.overhangAreaMm2 > 700 &&
    /悬垂/.test(ceil.value.findings.find((f) => /悬垂/.test(f)) ?? ''),
  JSON.stringify({ v: ceil.value.verdict, area: ceil.value.overhangAreaMm2, f: ceil.value.findings }));
const openShot = await call('check_printability', { versionId: vOpen });
check('an open mesh carries the watertight warning into its findings',
  openShot.value.watertight === false && openShot.value.findings.some((f) => /NOT watertight/.test(f)));

// ---- process profiles: the two-valued judgment, and no silent default ---------
// A manufacturing screen may EXCLUDE a process (with a witness) or find no
// counter-example. It may never rank, score or recommend one — see DECISION-LOG
// 2026-10-11. These checks pin that vocabulary and the no-silent-default rule.
{
  // A clean part with NO declared profile must not read as a pass: the geometry is
  // fine, the DECLARATION is missing. Declaring a profile is what earns "ok".
  const cleanNoProfile = await call('check_printability', { versionId: vGood });
  check('no profile declared → a clean part reports DIFFICULT, not not-excluded',
    cleanNoProfile.value.verdict === 'difficult', String(cleanNoProfile.value.verdict));
  const cleanDeclared = await call('check_printability', { versionId: vGood, profileIds: ['fdm-pla-0.4'] });
  check('…and declaring a profile is what earns ok',
    cleanDeclared.value.verdict === 'not-excluded', String(cleanDeclared.value.verdict));

  const noProfile = await call('check_printability', { versionId: vThin });
  check('no profile declared → profileSource says so (no silent default)',
    noProfile.value.profileSource === 'builtin-default',
    String(noProfile.value.profileSource));
  check('…and the built-in fallback is NAMED, with a hash, in the findings',
    /builtin-default/.test(JSON.stringify(noProfile.value.profiles)) &&
    /内建默认档/.test(noProfile.value.findings.join(' ')),
    (noProfile.value.profiles[0] ?? {}).profileId);
  check('…and the fallback admits it is uncalibrated, not a recommendation',
    /不是推荐/.test(noProfile.value.findings.join(' ')));

  const declared = await call('check_printability', { versionId: vThin, profileIds: ['fdm-pla-0.4'] });
  const ev = declared.value.profiles[0] ?? {};
  check('a declared profile is judged two-valued: excluded for a 0.4mm wall vs 1.2mm',
    ev.verdict === 'excluded' && declared.value.profileSource === 'declared', String(ev.verdict));
  check('…and the exclusion carries a WITNESS (rule + location + measured vs required)',
    ev.witnesses?.[0]?.rule === 'wallMinMm' && typeof ev.witnesses[0].measured === 'number' &&
    typeof ev.witnesses[0].required === 'number' && Array.isArray(ev.witnesses[0].locationMm),
    JSON.stringify(ev.witnesses?.[0]));
  check('…and it echoes the profile hash (a verdict without its premise is not evidence)',
    typeof ev.profileHash === 'string' && ev.profileHash.length >= 8, String(ev.profileHash));
  check('…and it discloses what does NOT apply, and what a tool cannot decide',
    (ev.notApplicable ?? []).some((x) => /draftMinDeg/.test(x)) &&
    (ev.unevaluable ?? []).some((x) => /tolMm/.test(x)),
    `na=${(ev.notApplicable ?? []).length} un=${(ev.unevaluable ?? []).length}`);

  const permissive = JSON.stringify([{
    schemaVersion: 1, id: 'test-permissive-cnc', process: 'CNC-3axis',
    rules: {
      wallMinMm: { applies: true, decidable: 'geometry', value: 0.2, direction: 'min', source: { kind: 'assumed', ref: 'test fixture' } },
      overhangDeg: { applies: false, decidable: 'geometry', reason: 'machining has no overhang constraint' },
    },
  }]);
  const notExcluded = await call('check_printability', { versionId: vThin, profilesJson: permissive });
  const ev2 = notExcluded.value.profiles[0] ?? {};
  check('no counter-example → "not-excluded", never "ok"',
    ev2.verdict === 'not-excluded', String(ev2.verdict));
  check('…and the overhang rule is disclosed as not applicable, with its reason',
    (ev2.notApplicable ?? []).some((x) => /overhangDeg.*overhang constraint/.test(x)),
    JSON.stringify(ev2.notApplicable));

  const badProfile = JSON.stringify([{
    schemaVersion: 1, id: 'bad-no-source', process: 'FDM',
    rules: { wallMinMm: { applies: true, decidable: 'geometry', value: 1, direction: 'min' } },
  }]);
  const refused = await call('check_printability', { versionId: vThin, profilesJson: badProfile })
    .then(() => false, (e) => /wallMinMm.*source/.test(String(e.message ?? e)));
  check('an invalid profile is REFUSED, naming the offending rule', refused);

  // ---- S2: sealed cavities / escape passages ----------------------------------
  const slaProfile = JSON.stringify([{
    schemaVersion: 1, id: 'test-sla-drain', process: 'SLA', material: 'standard resin',
    rules: {
      wallMinMm: { applies: true, decidable: 'geometry', value: 0.4, direction: 'min', source: { kind: 'rule-of-thumb', ref: 'test fixture' } },
      escapePassageMinMm: { applies: true, decidable: 'geometry', value: 2, direction: 'min', source: { kind: 'rule-of-thumb', ref: 'test fixture' } },
    },
  }]);
  const sealed = await call('check_printability', { versionId: vVoid, profilesJson: slaProfile });
  const evSealed = sealed.value.profiles[0] ?? {};
  check('a sealed cavity EXCLUDES an SLA profile that requires an escape passage',
    evSealed.verdict === 'excluded', String(evSealed.verdict));
  check('…and the witness names the rule and the VOID location, not just a number',
    evSealed.witnesses?.[0]?.rule === 'escapePassageMinMm' &&
    evSealed.witnesses[0].measured === 0 && evSealed.witnesses[0].required === 2 &&
    Array.isArray(evSealed.witnesses[0].locationMm),
    JSON.stringify(evSealed.witnesses?.[0]));

  const solidSla = await call('check_printability', { versionId: vGood, profilesJson: slaProfile });
  const evSolid = solidSla.value.profiles[0] ?? {};
  check('a solid part does NOT get excluded by the escape rule', evSolid.verdict === 'not-excluded', String(evSolid.verdict));
  check('…and the report says the passage INTERIOR was not measured (never a pass)',
    (solidSla.value.findings ?? []).some((f) => /通道内部的截面没有被测量/.test(f)),
    (solidSla.value.findings ?? []).find((f) => /通道/.test(f)) ?? '(no such finding)');

  // ---- S4: CNC tool reach (exact for circular bores) --------------------------
  const cncProfile = JSON.stringify([{
    schemaVersion: 1, id: 'test-cnc-3axis', process: 'CNC-3axis',
    rules: {
      wallMinMm: { applies: true, decidable: 'geometry', value: 0.5, direction: 'min', source: { kind: 'rule-of-thumb', ref: 'test fixture' } },
      toolRadiusMm: { applies: true, decidable: 'geometry', value: 1.5, direction: 'min', source: { kind: 'vendor-spec', ref: 'test fixture: smallest cutter on hand' } },
      holeAspectMax: { applies: true, decidable: 'geometry', value: 5, direction: 'max', source: { kind: 'rule-of-thumb', ref: 'test fixture' } },
    },
  }]);
  const narrow = await call('check_printability', { versionId: vNarrowBore, profilesJson: cncProfile });
  const evNarrow = narrow.value.profiles[0] ?? {};
  check('a bore narrower than the declared cutter EXCLUDES the CNC profile',
    evNarrow.verdict === 'excluded', String(evNarrow.verdict));
  check('…with a witness in cutter-radius terms (measured 0.75 vs required 1.5), located at the bore',
    evNarrow.witnesses?.some((w) => w.rule === 'toolRadiusMm' && w.measured === 0.75 && w.required === 1.5 &&
      Array.isArray(w.locationMm)) === true,
    JSON.stringify(evNarrow.witnesses?.[0]));

  const wide = await call('check_printability', { versionId: vWideBore, profilesJson: cncProfile });
  check('a bore wide enough for the cutter does NOT exclude',
    (wide.value.profiles[0] ?? {}).verdict === 'not-excluded',
    String((wide.value.profiles[0] ?? {}).verdict));
  check('…and the report says only CIRCULAR bores were checked (slots are not covered)',
    (wide.value.findings ?? []).some((f) => /非圆形的槽/.test(f)));

  const deep = await call('check_printability', { versionId: vDeepBore, profilesJson: cncProfile });
  const evDeep = deep.value.profiles[0] ?? {};
  check('a bore too deep for its diameter (Ø3 × 20 = 6.67 > 5) EXCLUDES',
    evDeep.verdict === 'excluded' &&
    evDeep.witnesses?.some((w) => w.rule === 'holeAspectMax' && w.measured > 6.6 && w.required === 5) === true,
    JSON.stringify(evDeep.witnesses ?? []));

  // ---- S3: the feasible draw-direction cone (draft) ----------------------------
  const draftProfile = (d) => JSON.stringify([{
    schemaVersion: 1, id: `test-draft-${d}`, process: 'injection',
    rules: {
      wallMinMm: { applies: true, decidable: 'geometry', value: 0.5, direction: 'min', source: { kind: 'rule-of-thumb', ref: 'test fixture' } },
      draftMinDeg: { applies: true, decidable: 'geometry', value: d, direction: 'min', source: { kind: 'rule-of-thumb', ref: 'test fixture' } },
    },
  }]);
  const d45 = await call('check_printability', { versionId: vGood, profilesJson: draftProfile(45) });
  const ev45 = d45.value.profiles[0] ?? {};
  check('45° draft on a cube EXCLUDES — the empty cone a PAIRWISE test cannot prove',
    ev45.verdict === 'excluded', String(ev45.verdict));
  check('…and the witness is in degrees, carries the best achievable draft, and a face location',
    ev45.witnesses?.some((w) => w.rule === 'draftMinDeg' && w.unit === 'deg' && w.required === 45 &&
      typeof w.measured === 'number' && w.measured < 45 && Array.isArray(w.locationMm)) === true,
    JSON.stringify(ev45.witnesses ?? []));

  const d1 = await call('check_printability', { versionId: vGood, profilesJson: draftProfile(1) });
  check('1° draft on the same cube does NOT exclude (the cone is non-empty)',
    (d1.value.profiles[0] ?? {}).verdict === 'not-excluded',
    String((d1.value.profiles[0] ?? {}).verdict));

  const dMarg = await call('check_printability', { versionId: vGood, profilesJson: draftProfile(34.5) });
  check('a near-zero draft margin is recorded as DIFFICULT, not passed',
    (dMarg.value.profiles[0] ?? {}).verdict === 'not-excluded' &&
    (dMarg.value.findings ?? []).some((f) => /拔模余量过小/.test(f)),
    (dMarg.value.findings ?? []).find((f) => /拔模/.test(f)) ?? '(no draft finding)');

  // ---- S2-b: escape passages (exact for round through holes; UNDETERMINED otherwise)
  const escapeProfile = JSON.stringify([{
    schemaVersion: 1, id: 'test-sla-escape', process: 'SLA', material: 'standard resin',
    rules: {
      wallMinMm: { applies: true, decidable: 'geometry', value: 0.4, direction: 'min', source: { kind: 'rule-of-thumb', ref: 'test fixture' } },
      escapePassageMinMm: { applies: true, decidable: 'geometry', value: 2, direction: 'min', source: { kind: 'rule-of-thumb', ref: 'test fixture' } },
    },
  }]);
  const narrowEsc = await call('check_printability', { versionId: vNarrowBore, profilesJson: escapeProfile });
  const evEsc = narrowEsc.value.profiles[0] ?? {};
  check('a round THROUGH passage narrower than the requirement EXCLUDES (exact)',
    evEsc.verdict === 'excluded' &&
    evEsc.witnesses?.some((w) => w.rule === 'escapePassageMinMm' && w.measured === 1.5 && w.required === 2 &&
      Array.isArray(w.locationMm)) === true,
    JSON.stringify(evEsc.witnesses ?? []));

  const wideEsc = await call('check_printability', { versionId: vWideBore, profilesJson: escapeProfile });
  check('a wide enough through passage does NOT exclude',
    (wideEsc.value.profiles[0] ?? {}).verdict === 'not-excluded',
    String((wideEsc.value.profiles[0] ?? {}).verdict));

  // S2-b non-circular: the bottleneck of a rectangular through slot is MEASURED (worker op
  // passage_bottleneck anchored at the opening), so a narrow slot is a witness, not a silence.
  const narrowSlot = await call('check_printability', { versionId: vNarrowSlot, profilesJson: escapeProfile });
  const evSlot = narrowSlot.value.profiles[0] ?? {};
  check('a NON-CIRCULAR through slot narrower than the requirement EXCLUDES (measured, not silent)',
    evSlot.verdict === 'excluded'
    && evSlot.witnesses?.some((w) => w.rule === 'escapePassageMinMm' && w.measured === 1.5
      && w.required === 2 && Array.isArray(w.locationMm)) === true,
    JSON.stringify(evSlot.witnesses ?? []));
  const wideSlot = await call('check_printability', { versionId: vWideSlot, profilesJson: escapeProfile });
  check('a wide enough NON-CIRCULAR slot does NOT exclude (no false exclusion)',
    (wideSlot.value.profiles[0] ?? {}).verdict === 'not-excluded',
    String((wideSlot.value.profiles[0] ?? {}).verdict));

  // THE NEGATIVE CONTROL: a narrow BLIND dimple must never condemn the part.
  const dimple = await call('check_printability', { versionId: vDimple, profilesJson: escapeProfile });
  check('a narrow BLIND dimple must NOT exclude (no false exclusion from a cosmetic feature)',
    (dimple.value.profiles[0] ?? {}).verdict === 'not-excluded' &&
    (dimple.value.profiles[0] ?? {}).witnesses?.length === 0,
    JSON.stringify((dimple.value.profiles[0] ?? {}).witnesses ?? []));
  check('…and it is reported as UNDETERMINED, not silently passed',
    (dimple.value.findings ?? []).some((f) => /盲特征/.test(f) && /未判定/.test(f)),
    (dimple.value.findings ?? []).find((f) => /盲/.test(f)) ?? '(no blind-feature note)');

  const exactEsc = await call('check_printability', { versionId: vExactBore, profilesJson: escapeProfile });
  check('a passage exactly at the requirement is recorded as DIFFICULT, not passed',
    (exactEsc.value.profiles[0] ?? {}).verdict === 'not-excluded' &&
    (exactEsc.value.findings ?? []).some((f) => /通道余量过小/.test(f)),
    (exactEsc.value.findings ?? []).find((f) => /通道/.test(f)) ?? '(no margin note)');

  const surface = JSON.stringify(noProfile.value);
  check('the report has no rank / score / recommend field (structurally, not by promise)',
    !/"(rank|score|recommend|recommended|best)"\s*:/.test(surface));
}
check('the skill set carries the delivery-discipline section (green numbers ≠ done)',
  /Delivery discipline/.test(skillTree) && /check_printability/.test(skillTree));
// Every tool the agent can call must be NAMED in the manual. This replaces a
// literal "Fifteen tools" that had gone stale: it asserted a number from two
// catalog generations ago, so it failed for a reason unrelated to what it was
// guarding (the 2026-10-12 catalog is 20). Naming is the invariant that actually
// matters — a tool the router table never mentions is a tool the model will not
// reach for.
const undocumented = [...tools.keys()].filter((name) => !new RegExp(`\\b${name}\\b`).test(skillNow));
check(`SKILL.md names every registered CAD tool (${tools.size} of them)`, undocumented.length === 0, undocumented.join(', '));
const hostSrc = await readFile(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'host', 'tools.ts'), 'utf8');
check('validate_assembly finalize states the delivery gate (eyes + printability before done)',
  /交付前纪律/.test(hostSrc) && /check_printability/.test(hostSrc));

await rm(home, { recursive: true, force: true }).catch(() => {});
await rm(workspace, { recursive: true, force: true }).catch(() => {});

console.log(fail === 0 ? '\nP3 ACCEPTANCE PASSED' : `\nP3 ACCEPTANCE FAILED (${fail})`);
process.exit(fail === 0 ? 0 : 1);
