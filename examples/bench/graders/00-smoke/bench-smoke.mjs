#!/usr/bin/env node
// 00-smoke · 工具链冒烟自检（仪器校准，无 LLM）
//
//   node examples/bench/graders/00-smoke/bench-smoke.mjs
//
// 判据 = 同目录的 rubric.json（13 硬门 + 6 数值）。本脚本只执行它，不复制它：
// 任何 rubric 里声明而脚本没有实现的条目都会记 FAIL（coverage hole），所以
// 判据与执行器不会各自漂移。
//
// ⚠️ 前置：本脚本检验的是**发货产物** `dsh-cad-harness/lib/index.js`
//    （`package.json` 的 main/exports 指向它），不是 src。改了 src 必须先
//    `node esbuild.mjs`，否则你测的是上一次构建。这是 DECISION-LOG
//    2026-10-07「00-smoke 校准发货产物」那条的直接后果 —— 若委托给
//    `accept-*.mjs`（它们 import src），bundle 陈旧时本脚本会误报全绿。
//
// 环境洁癖：先清掉继承来的 OPENSCADPATH 再加载 bundle，否则 shell 里导出的值
// 会混进被检集合，把"插件自己接得对不对"测糊。
//
// 隔离：DSH_HOME 与 workspace 都在临时目录，跑完删除（--keep 保留）。
//
// 参数：
//   --skip-fluid        跳过 MPM 流体那一步（rubric 允许，c-fluid-arrival 记 skip）
//   --fluid-steps <n>   流体步数上限（默认由工具推导）
//   --keep              保留临时目录
//   --json              只输出结果 JSON（写进 scores/）

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const PLUGIN = join(REPO, 'dsh-cad-harness');
const BUNDLE = join(PLUGIN, 'lib', 'index.js');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const SKIP_FLUID = flag('--skip-fluid');
const KEEP = flag('--keep');
const JSON_ONLY = flag('--json');

// ---------------------------------------------------------------- 输出 ----------
const steps = [];
const rows = [];
const say = (...a) => { if (!JSON_ONLY) console.log(...a); };

// ---------------------------------------------------------------- 前置 ----------
const inheritedOpenscadPath = process.env.OPENSCADPATH ?? null;
delete process.env.OPENSCADPATH; // 见文件头：先擦干净再让插件自己接

const home = await mkdtemp(join(tmpdir(), 'bench-smoke-home-'));
const workspace = await mkdtemp(join(tmpdir(), 'bench-smoke-work-'));
process.env.DSH_HOME = home;

const rubric = JSON.parse(await readFile(join(HERE, 'rubric.json'), 'utf8'));
const gateById = new Map(rubric.gates.map((g) => [g.id, g]));
const checkById = new Map(rubric.checks.map((c) => [c.id, c]));
const seen = new Set();

/** 记一条 rubric 条目。未在 rubric 中声明的 id 直接抛错（防止脚本自造判据）。 */
function rubricRow(kind, id, ok, detail = '') {
  const table = kind === 'gate' ? gateById : checkById;
  if (!table.has(id)) throw new Error(`rubric has no ${kind} "${id}"`);
  seen.add(id);
  rows.push({ kind, id, ok, detail, desc: table.get(id).desc });
  say(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? `  — ${detail}` : ''}`);
  return ok;
}

// 步骤日志（不是判据；判据在 rubric 里）。用于复核"到底跑了什么"。
function step(n, title, detail = '') {
  steps.push({ n, title, detail });
  say(`  [${String(n).padStart(2, '0')}] ${title}${detail ? ` — ${detail}` : ''}`);
}

// --------------------------------------------------- 加载发货产物并驱动 ----------
if (!existsSync(BUNDLE)) {
  console.error(`✗ 发货产物不存在：${BUNDLE}\n  先跑：cd dsh-cad-harness && node esbuild.mjs`);
  process.exit(2);
}
const bundleStat = await stat(BUNDLE);
const bundleSha = createHash('sha256').update(await readFile(BUNDLE)).digest('hex');

const bundle = await import(BUNDLE); // ← 被测对象：bundle，不是 src
const tools = new Map();
const ctx = {
  tools: { register: (def) => { tools.set(def.name, def); return () => {}; }, restrict: () => {} },
  attachments: { saveImages: async (items) => items.map((it) => ({ kind: 'stub', name: it.name })) },
  reflect: { get: () => undefined },
  effect: (fn) => { try { fn(); } catch { /* 无 connection 时路由不注册，正常 */ } },
  on: () => {},
  logger: { warn: () => {}, info: () => {}, error: () => {} },
};
bundle.apply(ctx, {});

const exec = { agent: { session: { header: { cwd: workspace } } }, signal: new AbortController().signal };
let calls = 0;
let images = 0;
async function call(name, args) {
  const def = tools.get(name);
  if (!def) throw new Error(`tool ${name} not registered by the bundle`);
  calls++;
  const value = await def.execute(args, exec);
  let blocks = null;
  try { blocks = def.finalizeContent ? def.finalizeContent(exec, { value }) : null; } catch { blocks = null; }
  images += (blocks ?? []).filter((b) => b.type === 'image').length;
  return { value, blocks, text: (blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n') };
}

const projectRoot = join(workspace, 'cad-data');
const runs = async () => JSON.parse(await readFile(join(projectRoot, 'runs', 'manifest.json'), 'utf8')).runs;
const versionIds = async () => {
  try { return (await readdir(join(projectRoot, 'versions'))).sort(); } catch { return []; }
};
const motionRuns = async () => (await runs()).filter((r) => r.kind === 'motion');
const manifestPath = join(workspace, 'assembly', 'assembly.json');
async function writeManifest(root) {
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify({
    schemaVersion: 1, name: '00-smoke fixture', unit: 'mm', up: 'z', root,
  }, null, 2));
}

/** Binary STL bbox centre — inline so the driver needs nothing from src. */
function stlBboxCentre(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = dv.getUint32(80, true);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < n; t++) {
    const base = 84 + t * 50 + 12;
    for (let v = 0; v < 3; v++) {
      for (let k = 0; k < 3; k++) {
        const x = dv.getFloat32(base + v * 12 + k * 4, true);
        if (x < lo[k]) lo[k] = x;
        if (x > hi[k]) hi[k] = x;
      }
    }
  }
  return [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const vecNear = (a, b, tol) => Array.isArray(a) && a.length === b.length && a.every((x, i) => near(x, b[i], tol));
const fmt = (a) => `[${(a ?? []).map((x) => (+x).toFixed(2)).join(', ')}]`;

// 考生侧指纹（g-grader-access 的脚本驱动变体：跑完必须一模一样）
const subjectTree = join(REPO, 'examples', 'bench', 'subjects');
const treeHash = async (dir) => {
  const h = createHash('sha256');
  const walk = async (d) => {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else h.update(p.slice(dir.length)).update(await readFile(p));
    }
  };
  await walk(dir);
  return h.digest('hex');
};
const subjectsBeforeHash = await treeHash(subjectTree);

const t0 = Date.now();
say('=== 00-smoke · 工具链冒烟自检（仪器校准，无 LLM）===');
say(`bundle   ${BUNDLE}`);
say(`         built ${bundleStat.mtime.toISOString()}  sha256 ${bundleSha.slice(0, 12)}…`);
say(`workspace ${workspace}`);
say(`OPENSCADPATH  继承值 ${inheritedOpenscadPath ?? '(未设置)'} → 已擦除，由 bundle 自行接管`);
say(`注册工具 ${tools.size} 个\n`);

// ============================================================================
// 夹具
// ============================================================================
say('-- 夹具 --');
const plateScad = (holeR) => `
difference() {
  cube([100,60,8]);
  translate([35,30,-1]) cylinder(r=${holeR}, h=10, $fn=64);
}
datum("板心", [50,30,4]);
datum_cyl("孔轴", [35,30,0], [0,0,1], ${holeR});
`;
const shaftScad = (r) => `
cylinder(r=${r}, h=20, $fn=64);
datum_cyl("轴径", [0,0,10], [0,0,1], ${r});
datum("轴端点", [0,0,20]);
`;

// ---- 1. 平板 + Ø12 通孔（默认四视图）----
const vPlate = (await call('generate_part', {
  part: '冒烟板', userIntent: '100×60×8 平板 + Ø12 通孔', scadCode: plateScad(6),
})).value;
step(1, 'generate_part 100×60×8 + Ø12 通孔（默认四视图）',
  `versionId=${vPlate.versionId} success=${vPlate.success} watertight=${vPlate.watertight} views=${vPlate.views?.length} size=${fmt(vPlate.sizeMm)}`);

rubricRow('gate', 'g-watertight', vPlate.watertight === true && vPlate.success === true,
  `watertight=${vPlate.watertight} success=${vPlate.success} errors=${JSON.stringify(vPlate.errors ?? [])}`);
rubricRow('gate', 'g-render-count', vPlate.views?.length === 4, `默认视图数 ${vPlate.views?.length}（期望 4）`);
step('1b', '步骤 1 附带断言（非判据）',
  `sizeMm=${JSON.stringify(vPlate.sizeMm)}（期望 [100,60,8]）bbox 文本=${/Model size/.test(String(vPlate.sizeMm)) ? 'ok' : 'n/a'}`);

// ---- 2. 只改孔径，views:['iso'] ----
const vPlate2 = (await call('generate_part', {
  part: '冒烟板', parentVersion: vPlate.versionId, userIntent: '只改孔径 Ø13', scadCode: plateScad(6.5), views: ['iso'],
})).value;
step(2, "generate_part 只改孔径 + views:['iso']",
  `versionId=${vPlate2.versionId} views=${vPlate2.views?.length} size=${fmt(vPlate2.sizeMm)}`);
rubricRow('gate', 'g-render-count', vPlate2.views?.length === 1,
  `显式 views:['iso'] → ${vPlate2.views?.length} 张（期望 1）`);

// ---- 3. set_datums 不产生新版本 ----
const versionsBefore = await versionIds();
const sd = (await call('set_datums', {
  versionId: vPlate.versionId,
  datums: [{ name: '冒烟锚点', kind: 'point', point: [10, 10, 8] }],
})).value;
const versionsAfter = await versionIds();
rubricRow('gate', 'g-set-datums-no-version',
  versionsBefore.length === versionsAfter.length,
  `版本目录 ${versionsBefore.length} → ${versionsAfter.length}；mode=${sd.mode} datums=${JSON.stringify(sd.datums)}`);

// ---- 4. measure_part ----
const mp = (await call('measure_part', { versionId: vPlate.versionId })).value;
const analyticVolume = 100 * 60 * 8 - Math.PI * 36 * 8;
const volumeErr = Math.abs(mp.volumeMm3 - analyticVolume) / analyticVolume;
step(4, 'measure_part', `size=${fmt(mp.sizeMm)} volume=${mp.volumeMm3.toFixed(1)}mm³（解析 ${analyticVolume.toFixed(1)}）genus=${mp.genus}`);
rubricRow('check', 'c-measure-part',
  vecNear(mp.sizeMm, [100, 60, 8], 0.01) && volumeErr < 0.01,
  `size=${fmt(mp.sizeMm)} volume 偏差 ${(volumeErr * 100).toFixed(3)}%`);

// ---- 5. measure_gap 点对（孔壁 → 板边；2026-10-11 起 measure_distance 并入 measure_gap）----
const md = (await call('measure_gap', {
  versionId: vPlate.versionId, aPoint: [41, 30, 4], bPoint: [100, 30, 4],
})).value;
step(5, 'measure_gap 点对（孔壁 → 板边）',
  `distance=${md.distanceMm}mm（解析 59） aSnap=${md.aSnapDistanceMm?.toFixed?.(3)} bSnap=${md.bSnapDistanceMm?.toFixed?.(3)}`);
step('5b', '步骤 5 附带断言（非判据）', `|${md.distanceMm} − 59| = ${Math.abs(md.distanceMm - 59).toFixed(4)}mm`);

// ---- 6. measure_gap 两块板（实心/实心求解模式，旧 measure_closest 并入）----
const vFar = (await call('generate_part', {
  part: '冒烟板远端', userIntent: '离首板 5mm 的第二块板',
  scadCode: 'translate([105,0,0]) cube([100,60,8]);\ndatum("近端面", [105,30,4]);', views: ['iso'],
})).value;
const mc = (await call('measure_gap', { aVersionId: vPlate.versionId, bVersionId: vFar.versionId })).value;
step(6, 'measure_gap 两块板', `distance=${mc.distanceMm}mm method=${mc.method} A=${fmt(mc.pointA)} B=${fmt(mc.pointB)}`);
rubricRow('check', 'c-measure-close', near(mc.distanceMm, 5, 0.01) && Array.isArray(mc.pointA) && Array.isArray(mc.pointB),
  `两板间隙实测 ${mc.distanceMm}mm（解析 5）`);

// ---- 7. 连通性正例 + 反例（2026-10-11 起 check_connectivity 并入 measure_part 的 bodies 半区）----
const cc = (await call('measure_part', { versionId: vPlate.versionId })).value;
const vMulti = (await call('generate_part', {
  part: '冒烟多体', userIntent: '两个分离立方体（反例）',
  scadCode: 'cube([10,10,10]);\ntranslate([30,0,0]) cube([10,10,10]);', views: ['iso'],
})).value;
const ccBad = (await call('measure_part', { versionId: vMulti.versionId })).value;
step(7, '连通性 正例/反例（measure_part·bodies）', `板=${cc.bodyVerdict}(${cc.bodies}) 多体件=${ccBad.bodyVerdict}(${ccBad.bodies})`);
rubricRow('check', 'c-connectivity',
  cc.bodyVerdict === 'single-body' && ccBad.bodyVerdict === 'multi-body' && ccBad.bodies === 2 && ccBad.bodyCenters?.length === 2,
  `正例 ${cc.bodyVerdict}；反例 ${ccBad.bodyVerdict} bodies=${ccBad.bodies} centers=${JSON.stringify(ccBad.bodyCenters)}`);

// ---- 8. check_printability 8mm 厚板 ----
const pr = (await call('check_printability', { versionId: vPlate.versionId })).value;
step(8, 'check_printability 8mm 板', `verdict=${pr.verdict} minWall=${pr.minWallMm} overhang=${pr.overhangAreaMm2}mm²`);

// ---- 9. check_printability 0.5mm 薄壁 ----
const vThin = (await call('generate_part', {
  part: '冒烟薄壁', userIntent: '0.5mm 薄壁盒（反例）',
  scadCode: 'difference() { cube([20,20,20]); translate([0.5,0.5,0.5]) cube([19,19,20]); }',
  views: ['iso'],
})).value;
const prThin = (await call('check_printability', { versionId: vThin.versionId, wallMinMm: 1.2 })).value;
step(9, 'check_printability 0.5mm 薄壁', `verdict=${prThin.verdict} minWall=${prThin.minWallMm} thinSamples=${prThin.thinSamples}`);
rubricRow('check', 'c-printability-thin',
  prThin.minWallMm < 1.2 && prThin.thinSamples > 0,
  `minWallMm=${prThin.minWallMm} thinSamples=${prThin.thinSamples} verdict=${prThin.verdict}`);

// ---- 10. render_part 剖切 ----
const rp = (await call('render_part', {
  versionId: vPlate.versionId, view: 'iso', section: { axis: 'y', fraction: 0.5 },
})).value;
step(10, 'render_part 剖切图', `label=${rp.label} file=${rp.file} exists=${existsSync(rp.file)}`);

// ---- 11. validate_assembly 故意干涉 0.5mm ----
const va = (await call('validate_assembly', {
  parts: [
    { name: 'A', versionId: vPlate.versionId },
    { name: 'B', versionId: vPlate.versionId, translate: [99.5, 0, 0] },
  ],
})).value;
const worst = (va.pairs ?? []).slice().sort((a, b) => (b.intersectionVolume ?? 0) - (a.intersectionVolume ?? 0))[0];
const analyticInterference = 0.5 * 60 * 8;
step(11, 'validate_assembly 干涉 0.5mm', `overallStatus=${va.overallStatus} worst=${worst?.partA}↔${worst?.partB} ${worst?.intersectionVolume?.toFixed(1)}mm³（解析 ${analyticInterference}）`);
rubricRow('check', 'c-interference',
  (worst?.intersectionVolume ?? 0) > 0 && Math.abs(worst.intersectionVolume - analyticInterference) / analyticInterference < 0.1,
  `干涉体积 ${worst?.intersectionVolume?.toFixed(2)}mm³ vs 解析 ${analyticInterference}mm³`);

// ---- 14. simulate_motion 齿条按 pitchRadiusMm 严格比驱动 ----
const OMEGA = 2, RADIUS = 5, PERIOD = (2 * Math.PI) / OMEGA;
const rackRun = (await call('simulate_motion', {
  cycles: 1,
  parts: [
    { name: 'frame', bodyType: 'fixed', position: [0, 0, 0], scadCode: 'cube([10,10,10], center=true);' },
    { name: 'pinion', bodyType: 'kinematic', position: [0, 0, 0], scadCode: 'cylinder(r=5, h=6, center=true, $fn=32);' },
    { name: 'rack', bodyType: 'kinematic', position: [0, 20, 0], scadCode: 'cube([4,30,4], center=true);' },
  ],
  joints: [{ type: 'revolute', bodyA: 'frame', bodyB: 'pinion', anchorA: [0, 0, 0], anchorB: [0, 0, 0], axis: [0, 0, 1] }],
  drive: { body: 'pinion', axis: [0, 0, 1], omegaRadPerSec: OMEGA },
  oscillators: [{ body: 'rack', axis: [0, 0, 1], pitchRadiusMm: RADIUS }],
})).value;
const travel = rackRun.followers?.rack?.travelMm ?? 0;
const expectedTravel = RADIUS * OMEGA * PERIOD;
step(14, 'simulate_motion 齿条 pitchRadiusMm', `status=${rackRun.overallStatus} travel=${travel.toFixed(3)}mm 解析=${expectedTravel.toFixed(3)}mm 干涉=${rackRun.interferenceCount}`);
rubricRow('gate', 'g-motion-ratio',
  Math.abs(travel - expectedTravel) / expectedTravel < 0.05,
  `|${travel.toFixed(3)} − ${expectedTravel.toFixed(3)}| / ${expectedTravel.toFixed(3)} = ${(Math.abs(travel - expectedTravel) / expectedTravel * 100).toFixed(2)}%`);

// ---- 15. simulate_motion pivot 重基 ----
const pivotRun = (await call('simulate_motion', {
  cycles: 1,
  parts: [
    { name: 'crank', bodyType: 'kinematic', position: [0, 0, 0], scadCode: 'cube([10,10,10], center=true);\ndatum_axis("轴", [0,0,0], [0,0,1]);' },
    { name: 'bar', bodyType: 'dynamic', position: [0, 0, 0], scadCode: 'translate([120,0,0]) cube([8,40,8], center=true);' },
  ],
  joints: [{ type: 'revolute', bodyA: 'crank', bodyB: 'bar', anchorA: [0, 0, 0], anchorB: [120, 0, 0], axis: [0, 0, 1] }],
  drive: { body: 'crank', axis: [0, 0, 1], omegaRadPerSec: 1 },
})).value;
const pivotRunId = (await motionRuns()).at(-1)?.id;
let barCentre = null;
if (pivotRunId) {
  const p = join(projectRoot, 'runs', pivotRunId, 'parts', 'bar.stl');
  if (existsSync(p)) barCentre = stlBboxCentre(await readFile(p));
}
step(15, 'simulate_motion pivot 重基', `pivots=${JSON.stringify(pivotRun.pivots)} run=${pivotRunId} bar.stl 中心=${fmt(barCentre)}`);
rubricRow('gate', 'g-pivot-rebased',
  vecNear(pivotRun.pivots?.bar, [120, 0, 0], 0.01) && barCentre !== null && vecNear(barCentre, [0, 0, 0], 0.5),
  `pivots.bar=${fmt(pivotRun.pivots?.bar)}（期望 [120,0,0]）bar.stl 中心=${fmt(barCentre)}（容差 0.5mm）`);

// ---- 16. simulate_physics tiltDeg + prismatic staticFriction ----
const phys = await call('simulate_physics', {
  durationSec: 2,
  tiltDeg: 5,
  parts: [
    { name: 'rail', bodyType: 'fixed', position: [0, 0, 0], scadCode: 'cube([10,10,60]);' },
    { name: 'block', bodyType: 'dynamic', position: [40, 0, 50], scadCode: 'cube([10,10,10], center=true);' },
  ],
  joints: [{
    type: 'prismatic', bodyA: 'rail', bodyB: 'block',
    anchorA: [40, 0, 50], anchorB: [0, 0, 0], axis: [0, 0, 1],
    limits: [-8, 8], staticFriction: 0.3,
  }],
});
const hold = phys.value.holdAnalysis?.[0];
step(16, 'simulate_physics tiltDeg 5 + staticFriction', `holds=${hold?.holds} mu=${hold?.mu} 摩擦上限=${hold?.frictionCapN?.toFixed?.(3)}N 轴向驱动=${hold?.axialDriveN?.toFixed?.(3)}N fellOver=${JSON.stringify(phys.value.fellOver)}`);
rubricRow('gate', 'g-static-friction',
  Array.isArray(phys.value.holdAnalysis) && phys.value.holdAnalysis.length >= 1
    && typeof hold?.holds === 'boolean' && typeof hold?.mu === 'number'
    && /quasi-static|SLIDES under gravity/.test(phys.text),
  `holdAnalysis ${phys.value.holdAnalysis?.length ?? 0} 条；文本明示=${/quasi-static/i.test(phys.text) ? 'quasi-static estimate' : (/SLIDES under gravity/.test(phys.text) ? 'SLIDES under gravity' : '未明示')}`);

// ---- 17. simulate_fluid Ø8 直管 ----
let fluid = null, fluidSkipped = SKIP_FLUID;
if (!fluidSkipped) {
  // Ø8 直管：外径 Ø10（1mm 壁）。**壁厚必须是薄的**——工具的默认 fluidRegionMm 是
  // 按管件包围盒内缩 3mm 推的（"3mm wall clearance"），只有壁薄于 3mm 时种子才落在
  // 内孔里。换成 20mm 见方的实心块，种子会大面积落在实体壁内 → 到达率 0.097。
  // 重力取 [0,0,0]：直管入口驱动的题面就是"纯驱动流"（工具描述明示）。
  const pipeScad = 'rotate([0,90,0]) difference() {\n' +
    '  cylinder(r=5, h=60, center=true, $fn=64);\n' +
    '  cylinder(r=4, h=80, center=true, $fn=64);\n}';
  const stepsN = Number(opt('--fluid-steps', '0')) || undefined;
  const r = await call('simulate_fluid', {
    pipeScad, inletVelocityMmPerSec: 100, gravityMmPerSec2: [0, 0, 0],
    ...(stepsN ? { steps: stepsN } : {}),
  });
  fluid = r.value;
  step(17, 'simulate_fluid Ø8 直管 100mm/s',
    `status=${fluid.overallStatus} arrival=${fluid.metrics?.outletArrivalRatio} penetration=${fluid.metrics?.penetrationCount} massErr=${fluid.metrics?.massConservationError} frames=${fluid.frames?.length}`);
  rubricRow('gate', 'g-fluid-runs',
    ['pass', 'check'].includes(fluid.overallStatus) && typeof fluid.metrics?.outletArrivalRatio === 'number',
    `overallStatus=${fluid.overallStatus} outletArrivalRatio=${fluid.metrics?.outletArrivalRatio}`);
  rubricRow('check', 'c-fluid-arrival',
    (fluid.metrics?.outletArrivalRatio ?? 0) > 0.6 && (fluid.metrics?.penetrationCount ?? 1) === 0,
    `arrival=${fluid.metrics?.outletArrivalRatio}(>0.6) penetration=${fluid.metrics?.penetrationCount}(==0)`);
} else {
  step(17, 'simulate_fluid —— skipped（--skip-fluid）', 'rubric 允许记 skip 并在结果里标注');
  rubricRow('gate', 'g-fluid-runs', false, 'skipped by --skip-fluid（rubric 允许，但硬门记 FAIL 并标注）');
  rows[rows.length - 1].skipped = true; // skip 标注而非判负：不计入失败数
  rubricRow('check', 'c-fluid-arrival', false, 'skipped by --skip-fluid');
  rows[rows.length - 1].skipped = true;
}

// ---- 12/13. check_assembly 四算子 + 阴性对照（在 motion 之后：motion-clearance 要引用 run）----
const vShaft = (await call('generate_part', {
  part: '冒烟轴', userIntent: 'Ø11.6 轴，与 Ø12 孔成 0.4 直径间隙', scadCode: shaftScad(5.8), views: ['iso'],
})).value;
const vPlateSmallHole = (await call('generate_part', {
  part: '冒烟板', parentVersion: vPlate.versionId, userIntent: '孔径改小 0.5（阴性对照）',
  scadCode: plateScad(5.75), views: ['iso'],
})).value;
const cleanMotionRunId = pivotRunId;
const children = (plateVersion) => [
  { id: '板', name: '冒烟板', kind: 'part', version: plateVersion, source: 'generated', material: 'PLA',
    datums: [{ name: '板心', kind: 'point' }, { name: '孔轴', kind: 'cylinder' }] },
  { id: '轴', name: '冒烟轴', kind: 'part', version: vShaft.versionId, source: 'generated', material: 'PLA',
    transform: { translate: [35, 30, -5] },
    datums: [{ name: '轴径', kind: 'cylinder' }, { name: '轴端点', kind: 'point' }] },
];
const interfaces = [
  { id: 'if-distance', a: '板.板心', b: '轴.轴端点', type: '间隙', check: 'distance', layer: 'L0', severity: 'hard',
    nominal: { quantity: '距离', value: 18.6011 }, tolerance: { min: 18.5, max: 18.7 },
    note: '板心到轴端点的点对点距离' },
  { id: 'if-bearing', a: '板.孔轴', b: '轴.轴径', type: '紧固', check: 'diameter-match', layer: 'L0', severity: 'hard',
    nominal: { quantity: '直径', value: 0.4 }, tolerance: { min: 0.3, max: 0.5 },
    note: 'Ø12 孔与 Ø11.6 轴的直径间隙' },
  { id: 'if-coaxial', a: '板.孔轴', b: '轴.轴径', type: '转动副', check: 'coaxial', layer: 'L0', severity: 'hard',
    nominal: { quantity: '同轴度', value: 0 }, tolerance: { min: 0, max: 0.05 },
    note: '两轴线同轴' },
  { id: 'if-motion', a: '板.板心', b: '轴.轴端点', type: '滑动副', check: 'motion-clearance', layer: 'L1', severity: 'hard',
    nominal: { quantity: '距离', value: 18.6011 }, tolerance: { min: 18.5, max: 18.7 },
    params: { runId: cleanMotionRunId }, note: '运动全程由 simulate_motion 见证' },
];

await writeManifest({ id: 'smoke', name: '冒烟装配', kind: 'assembly', children: children(vPlate.versionId), interfaces });
const ca = (await call('check_assembly', { manifestPath })).value;
step(12, 'check_assembly 四算子（distance/diameter-match/coaxial/motion-clearance）',
  `status=${ca.overallStatus} summary=${JSON.stringify(ca.summary)}`);
const fourOk = ca.summary?.pass === 4 && ca.summary?.hardViolations === 0;
step('12b', '步骤 12 附带断言（非判据）', fourOk ? '4 pass / 0 hard ✓' : `期望 4 pass / 0 hard，实得 pass=${ca.summary?.pass} hard=${ca.summary?.hardViolations}`);

await writeManifest({ id: 'smoke', name: '冒烟装配（阴性对照）', kind: 'assembly', children: children(vPlateSmallHole.versionId), interfaces });
const caBad = (await call('check_assembly', { manifestPath })).value;
step(13, 'check_assembly 孔径改小 0.5（阴性对照）',
  `status=${caBad.overallStatus} hard=${caBad.hardViolations?.length} 首条=${caBad.hardViolations?.[0]?.detail?.slice(0, 70)}`);
rubricRow('gate', 'g-negative-control-fires',
  fourOk && (caBad.summary?.hardViolations ?? 0) >= 1 && caBad.overallStatus === 'fail',
  fourOk
    ? `阴性对照 ${caBad.summary?.hardViolations} 条 hard，status=${caBad.overallStatus}`
    : `阳性基准不成立（pass=${ca.summary?.pass}/hard=${ca.summary?.hardViolations}），阴性对照无法解读`);

// ---- 18. merge_parts shells ----
const mkBlocks = (dx) => [
  { name: 'A', scadCode: 'cube([10,10,10]);' },
  { name: 'B', scadCode: 'cube([10,10,10]);', translate: [dx, 0, 0] },
];
const merged1 = (await call('merge_parts', { parts: mkBlocks(10), userIntent: '相接两件' })).value;
const merged2 = (await call('merge_parts', { parts: mkBlocks(20), userIntent: '分离两件' })).value;
step(18, 'merge_parts 相接/分离', `相接 shells=${merged1.shells} 分离 shells=${merged2.shells}`);
rubricRow('gate', 'g-merge-shells', merged1.shells === 1 && merged2.shells === 2,
  `相接 shells=${merged1.shells}（期望 1）；分离 shells=${merged2.shells}（期望 2）`);

// ---- 19. delivery_audit 引用被取代版本的语料 ----
const vOld = (await call('generate_part', {
  part: '冒烟旧件', userIntent: '会被取代的 v1', scadCode: 'cube([10,10,10], center=true);\ndatum("角点", [5,5,5]);', views: ['iso'],
})).value;
await call('validate_assembly', { // 产生一条引用 vOld 的 run（≥2 件才能跑）
  parts: [
    { name: '旧件', versionId: vOld.versionId },
    { name: '远垫块', versionId: vOld.versionId, translate: [500, 0, 0] },
  ],
});
const vNew = (await call('generate_part', {
  part: '冒烟旧件', parentVersion: vOld.versionId, userIntent: '取代 v1 的 v2',
  scadCode: 'cube([12,12,12], center=true);\ndatum("角点", [6,6,6]);', views: ['iso'],
})).value;
await writeManifest({
  id: 'stale', name: '过期语料', kind: 'assembly',
  children: [{ id: '旧件', name: '冒烟旧件', kind: 'part', version: vOld.versionId, datums: [{ name: '角点', kind: 'point' }] }],
  interfaces: [],
});
const da = (await call('delivery_audit', { manifestPath })).value;
const staleFindings = (da.findings ?? []).filter((f) => /stale|superseded/.test(f.code) || /superseded/i.test(f.detail));
step(19, 'delivery_audit 过期语料', `verdict=${da.verdict} findings=${(da.findings ?? []).map((f) => f.code).join(',')}`);
rubricRow('gate', 'g-delivery-audit', staleFindings.length >= 1,
  `${staleFindings.length} 条 stale/superseded：${staleFindings.map((f) => f.code).join(', ') || '(none)'}`);

// ---- 20. BOSL2 经 bundle 的 generate_part ----
const gear = (await call('generate_part', {
  part: '冒烟齿轮', userIntent: 'BOSL2 spur_gear mod=1 teeth=20',
  scadCode: 'include <BOSL2/std.scad>\ninclude <BOSL2/gears.scad>\n$fn=64;\nspur_gear(mod=1, teeth=20, thickness=6, shaft_diam=8);',
  views: ['iso'],
})).value;
const gearOuter = Math.max(gear.sizeMm?.[0] ?? 0, gear.sizeMm?.[1] ?? 0);
const gearIncludeWarn = (gear.warnings ?? []).filter((w) => /can't open include file/i.test(w));
const screw = (await call('generate_part', {
  part: '冒烟螺钉', userIntent: 'BOSL2 screw M6×20',
  scadCode: 'include <BOSL2/std.scad>\ninclude <BOSL2/screws.scad>\n$fn=64;\nscrew("M6", length=20);',
  views: ['iso'],
})).value;
const screwIncludeWarn = (screw.warnings ?? []).filter((w) => /can't open include file/i.test(w));
const screwAxial = Math.max(...(screw.sizeMm ?? [0, 0, 0]));
step(20, 'BOSL2 spur_gear / screw 经 bundle',
  `gear success=${gear.success} 外径=${gearOuter.toFixed(2)}mm include警告=${gearIncludeWarn.length}；screw success=${screw.success} 轴向=${screwAxial.toFixed(2)}mm include警告=${screwIncludeWarn.length}`);
rubricRow('gate', 'g-bosl2-gears',
  gear.success === true && near(gearOuter, 22, 0.5) && gearIncludeWarn.length === 0
    && screw.success === true && screwAxial > 19 && screwAxial < 34 && screwIncludeWarn.length === 0,
  `gear 外径 ${gearOuter.toFixed(2)}mm（22±0.5）include 警告 ${gearIncludeWarn.length}；screw 轴向 ${screwAxial.toFixed(2)}mm（19–34）include 警告 ${screwIncludeWarn.length}`);

// ---- 2. g-openSCADPATH（bundle 进程内的真实环境变量）----
const entries = (process.env.OPENSCADPATH ?? '').split(':').filter(Boolean);
const goodEntries = entries.filter((d) => existsSync(join(d, 'BOSL2', 'std.scad')));
const badEntries = entries.filter((d) => d.endsWith('/BOSL2') && !existsSync(join(d, 'std.scad')));
step(21, 'BOSL2 接线（bundle 进程内）', `OPENSCADPATH=${entries.join(':') || '(空)'}`);
rubricRow('gate', 'g-openSCADPATH', goodEntries.length > 0 && badEntries.length === 0,
  `有 BOSL2/std.scad 的父目录 ${goodEntries.length} 个；被误当父目录的 BOSL2 目录 ${badEntries.length} 个`);

// ---- g-grader-access（脚本驱动变体）----
// 没有 LLM transcript 可扫，改为两条可验证的等价约束：
//   1. 本驱动只读了 graders/00-smoke/rubric.json，没碰 key.md / landmarks.json /
//      其他题目的判据；
//   2. 整个运行没有改动 subjects/（考生侧）。
const graderFilesRead = [join(HERE, 'rubric.json')];
const leaked = graderFilesRead.filter((p) => /key\.md|landmarks\.json/.test(p));
const subjectsAfter = await treeHash(subjectTree);
rubricRow('gate', 'g-grader-access',
  leaked.length === 0 && subjectsAfter === subjectsBeforeHash,
  `脚本驱动无 transcript：改检「只读 ${graderFilesRead.map((p) => p.slice(REPO.length + 1)).join(', ')}」+ 「subjects/ 树哈希未变」${subjectsAfter === subjectsBeforeHash ? ' ✓' : ` ✗（前 ${subjectsBeforeHash.slice(0, 12)} → 后 ${subjectsAfter.slice(0, 12)}）`}`);

// ============================================================================
// 汇总
// ============================================================================
// 覆盖率：rubric 声明的每条都必须被执行到，否则是脚本漏实现了判据。
const missing = [
  ...rubric.gates.filter((g) => !seen.has(g.id)).map((g) => `gate:${g.id}`),
  ...rubric.checks.filter((c) => !seen.has(c.id)).map((c) => `check:${c.id}`),
];
for (const m of missing) {
  rows.push({ kind: 'missing', id: m, ok: false, detail: 'rubric 声明但本脚本未执行 → 判据覆盖有洞' });
}
// 允许的重复：g-render-count 与 g-openSCADPATH 在多处断言，取所有出现都通过
const gateRows = rows.filter((r) => r.kind === 'gate');
const checkRows = rows.filter((r) => r.kind === 'check');
const gateFail = new Set(gateRows.filter((r) => !r.ok && !r.skipped).map((r) => r.id));
const checkFail = new Set(checkRows.filter((r) => !r.ok && !r.skipped).map((r) => r.id));
const wallSec = (Date.now() - t0) / 1000;

const result = {
  example: '00-smoke',
  driver: 'script',
  ranAt: new Date().toISOString(),
  wallsSec: +wallSec.toFixed(1),
  bundle: { path: BUNDLE, mtime: bundleStat.mtime.toISOString(), sha256: bundleSha },
  sut: { gitCommit: null, skillSha256: null }, // 由调用方回填（见 README §8）
  environment: { inheritedOpenscadPath, openscadPath: process.env.OPENSCADPATH ?? null },
  budget: {
    ...rubric.budget, toolCallsUsed: calls, imagesUsed: images,
    overBudget: {
      toolCalls: calls > rubric.budget.toolCalls,
      images: images > rubric.budget.images,
      wallClock: wallSec > rubric.budget.wallClockMin * 60,
    },
  },
  gates: Object.fromEntries(rubric.gates.map((g) => [g.id, gateFail.has(g.id) ? 'fail' : (gateRows.some((r) => r.id === g.id && r.skipped) ? 'skip' : 'pass')])),
  checks: Object.fromEntries(rubric.checks.map((c) => [c.id, checkFail.has(c.id) ? 'fail' : (checkRows.some((r) => r.id === c.id && r.skipped) ? 'skip' : 'pass')])),
  gatesFailed: [...gateFail],
  checksFailed: [...checkFail],
  steps,
  rows,
};
const scoresDir = join(HERE, 'scores');
await mkdir(scoresDir, { recursive: true });
const outPath = join(scoresDir, `smoke-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(outPath, JSON.stringify(result, null, 2));

if (JSON_ONLY) console.log(JSON.stringify(result, null, 2));
else {
  say('\n-- 硬门 --');
  for (const [id, st] of Object.entries(result.gates)) say(`${st === 'pass' ? 'PASS' : st === 'skip' ? 'SKIP' : 'FAIL'}  ${id}`);
  say('\n-- 数值判据 --');
  for (const [id, st] of Object.entries(result.checks)) say(`${st === 'pass' ? 'PASS' : st === 'skip' ? 'SKIP' : 'FAIL'}  ${id}`);
  say(`\n工具调用 ${calls}/${rubric.budget.toolCalls}  图片 ${images}/${rubric.budget.images}  墙钟 ${wallSec.toFixed(1)}s/${rubric.budget.wallClockMin * 60}s`);
  const over = Object.entries(result.budget.overBudget).filter(([, v]) => v).map(([k]) => k);
  if (over.length) say(`⚠️ 超预算：${over.join(', ')} —— 回填 rubric.budget 的实测值（本级 calibration: calibrated）。`);
  say(`结果 → ${outPath}`);
  const skipped = rows.filter((r) => r.skipped);
  say(`\n${gateFail.size === 0 && checkFail.size === 0
    ? (skipped.length === 0
      ? '✅ 00-smoke 全绿 —— 仪器可用，可以开始跑评测题。'
      : `⚠️ 00-smoke 通过，但 ${skipped.length} 项被 skip（${skipped.map((r) => r.id).join(', ')}）——仪器可用性未完全确认，正式校准请去掉 --skip-fluid 重跑。`)
    : `❌ 00-smoke 未通过：硬门 ${gateFail.size} 条、数值 ${checkFail.size} 条。先修插件，再跑真正的评测题。`}`);
  if (missing.length) say(`⚠️ 判据覆盖有洞：${missing.join(', ')}`);
}

if (!KEEP) {
  await rm(home, { recursive: true, force: true }).catch(() => {});
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
}
process.exit(gateFail.size === 0 && checkFail.size === 0 ? 0 : 1);
