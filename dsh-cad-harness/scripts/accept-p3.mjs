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
const closest = await call('measure_closest', { aVersionId: vOpen, bVersionId: vClosed });
check('measure_closest warns when an input is not watertight',
  (closest.value.warnings ?? []).some((w) => /NOT watertight/.test(w)),
  JSON.stringify(closest.value.warnings ?? []));
const closestClosed = await call('measure_closest', { aVersionId: vClosed, bVersionId: vClosed });
check('  …and stays silent on closed solids',
  (closestClosed.value.warnings ?? []).length === 0);
const dist = await call('measure_distance', {
  versionId: vOpen, aPoint: [5, 5, 0], bVersionId: vClosed, bPoint: [10, 10, 20],
});
check('measure_distance warns on open-meth surface snapping too',
  (dist.value.warnings ?? []).some((w) => /NOT watertight/.test(w)),
  JSON.stringify(dist.value.warnings ?? []));
const distDatum = await call('measure_distance', {
  versionId: vClosed, aPoint: [0, 0, 20], bPoint: [0, 0, 0],
});
check('  …with clean inputs there are no warnings',
  (distDatum.value.warnings ?? []).length === 0 && distDatum.value.distanceMm === 20,
  `d=${distDatum.value.distanceMm}`);

// ================= P0-2: the skill names the radians trap ===================

console.log('\n--- P0-2  SKILL.md degrees/radians trap ---');
const skillPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'cad-toolbox', 'SKILL.md');
const skill = await readFile(skillPath, 'utf8');
check('SKILL.md names the OpenSCAD degrees in / radians out trap',
  /DEGREES in/i.test(skill) && /inv\(α\)/.test(skill) && /d2r/.test(skill));
check('SKILL.md orders watertight over pretty',
  /Watertight beats pretty/.test(skill) && /NOT WATERTIGHT/.test(skill));

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
const reportPath = join(workspace, 'assembly', 'assembly-check-report.json');
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
check('SKILL.md teaches the image-budget economy (views on numeric iterations)',
  /Images are the biggest context spend/.test(skillNow) && /views: \["iso"\]/.test(skillNow));

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

const extent = await call('measure_extent', { versionId: vMeasure, axis: 'x' });
check('measure_extent: the tool layer projects on an axis and hands back extremal points',
  extent.value.sizeMm > 39 && extent.value.minPointMm.length === 3 && extent.value.maxPointMm.length === 3,
  `size=${extent.value.sizeMm} points=${JSON.stringify([extent.value.minPointMm, extent.value.maxPointMm])}`);
const diagonalExtent = await call('measure_extent', { versionId: vMeasure, axisVector: [1, 1, 0] });
check('measure_extent: axisVector reaches the worker as a vector',
  Math.abs(diagonalExtent.value.sizeMm - (40 + 40) / Math.SQRT2) < 0.1,
  `size=${diagonalExtent.value.sizeMm}`);

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
const vCeil = (await call('generate_part', {
  userIntent: 'P3 slab on a post (huge unsupported ceiling)', part: 'P3 天花板',
  scadCode: 'cube([4,4,10]);\ntranslate([0,0,10]) cube([30,30,4]);',
})).value.versionId;

const good = await call('check_printability', { versionId: vGood });
check('a chunky cube screens ok (min wall 12mm, no overhang)',
  good.value.verdict === 'ok' && Math.abs(good.value.minWallMm - 12) < 0.5 && good.value.findings.length === 0,
  JSON.stringify(good.value));
const thin = await call('check_printability', { versionId: vThin });
check('a 0.4mm plate is flagged unprintable with min wall ≈0.4 and a located finding',
  thin.value.verdict === 'unprintable' && Math.abs(thin.value.minWallMm - 0.4) < 0.1 &&
    /最薄壁/.test(thin.value.findings[0] ?? ''),
  JSON.stringify({ v: thin.value.verdict, w: thin.value.minWallMm, f: thin.value.findings }));
const ceil = await call('check_printability', { versionId: vCeil });
check('a 30×30 slab on a 4×4 post is flagged for its unsupported ceiling',
  ceil.value.verdict === 'check' && ceil.value.overhangAreaMm2 > 700 &&
    /悬垂/.test(ceil.value.findings.find((f) => /悬垂/.test(f)) ?? ''),
  JSON.stringify({ v: ceil.value.verdict, area: ceil.value.overhangAreaMm2, f: ceil.value.findings }));
const openShot = await call('check_printability', { versionId: vOpen });
check('an open mesh carries the watertight warning into its findings',
  openShot.value.watertight === false && openShot.value.findings.some((f) => /NOT watertight/.test(f)));
check('SKILL.md carries the delivery-discipline section (green numbers ≠ done)',
  /Delivery discipline/.test(skillNow) && /check_printability/.test(skillNow));
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
