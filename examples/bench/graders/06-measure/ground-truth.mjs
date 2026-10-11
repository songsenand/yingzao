#!/usr/bin/env node
// 06-measure · 基准真值（**评分方脚本**）
//
//   export DSH_CAD_PYTHON_ROOT=<repo>/.tmp-measure-runtime
//   node examples/bench/graders/06-measure/ground-truth.mjs
//
// 这个脚本存在的唯一理由：rubric 里的期望值**必须是被工具量出来的**，
// 不能是我按图纸算出来的。按图纸算的值只能证明"我的算术对"，证明不了
// "工具能把这个量量对"——而后者才是这道题要测的东西。
//
// 每一行真值都记 `sources`：哪个 op、什么参数、原始返回是什么，
// 出题人复核时不必相信我，照着参数重跑即可。
//
// 同时测负面对照件 part-b（只改圆筒内径 16 → 14），于是 `delta` 也是实测的，
// 并且它同时压住 c-tube-wall（壁厚）与 list_features（孔径）两条判据。

import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePythonWorker, resetPythonWorker } from '../../../../dsh-cad-harness/src/host/python-worker.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
process.env.DSH_CAD_PYTHON_ROOT = process.env.DSH_CAD_PYTHON_ROOT
  ?? join(REPO, '.tmp-measure-runtime');

const SUBJECT = join(REPO, 'examples', 'bench', 'subjects', '06-measure');
const PART = join(SUBJECT, 'part.stl');
const PART_B = join(SUBJECT, 'part-b.stl');

const worker = await ensurePythonWorker();
const sources = {};
const record = (key, op, params, value) => {
  sources[key] = { op, params, value };
  return value;
};
const r3 = (x) => Math.round(x * 1000) / 1000;

// ---- list_features：孔径、孔心、bore/boss --------------------------------
const features = await worker.request('list_features', { path: PART });
record('cylinders', 'list_features', { path: 'part.stl' }, features.cylinders);
const cylinders = features.cylinders ?? [];
const bores = cylinders.filter((c) => c.kind === 'bore');
const bosses = cylinders.filter((c) => c.kind === 'boss');
// 两个"板上的通孔" = 轴线落在板中面（y=0）且长度等于板厚（8mm）的那两个孔。
// 不用 `through` 字段：那是**面**上的孔记录才有的标记，圆柱记录里没有——
// 按不存在的字段筛会得到一个空集（第一次就这么写的，实测报 undefined）。
const plateBores = bores.filter((b) => Math.abs(b.centerMm[1]) < 1e-9 && Math.abs(b.lengthMm - 8) < 1e-6);
const holeX = plateBores.map((b) => r3(b.centerMm[0])).sort((a, b) => a - b);
const holeCentreDistanceMm = holeX.length >= 2 ? r3(holeX[holeX.length - 1] - holeX[0]) : null;
record('holeCentreDistanceMm', 'list_features', { path: 'part.stl' }, holeCentreDistanceMm);

// ---- measure_thickness：圆筒壁厚（从筒轴出发沿 +x，正好穿壁一次） ----------
const wall = await worker.request('measure_thickness', {
  meshes: [PART], from: [0, -12, 14], direction: '+x',
});
record('tubeWallThicknessMm', 'measure_thickness',
  { meshes: ['part.stl'], from: [0, -12, 14], direction: '+x' }, wall.spans);
const tubeWallThicknessMm = wall.spans.length === 1 ? r3(wall.spans[0].thicknessMm) : null;

// ---- measure_angle：斜面与底板 --------------------------------------------
// 斜面中点 (0,15,13.7735)，外法线 (-0.5,0,0.866)，探针沿法线外移 3mm；
// 另一个探针在板底下方，最近面必是底面。
const angle = await worker.request('measure_angle', {
  meshes: [PART, PART], aProbe: [0, 0, -4], bProbe: [-1.5, 15, 16.371],
});
record('slopeAngle', 'measure_angle',
  { aProbe: [0, 0, -4], bProbe: [-1.5, 15, 16.371] },
  { angleDeg: angle.angleDeg, acuteDeg: angle.acuteDeg, supplementDeg: angle.supplementDeg, aSource: angle.aSource, bSource: angle.bSource });

// ---- measure_extent：三轴 + 对角线 ----------------------------------------
const extents = {};
for (const axis of ['x', 'y', 'z']) {
  const out = await worker.request('measure_extent', { path: PART, axis });
  extents[axis] = { min: r3(out.minMm), max: r3(out.maxMm), sizeMm: r3(out.sizeMm) };
  record(`extent${axis.toUpperCase()}`, 'measure_extent', { path: 'part.stl', axis },
    { minMm: out.minMm, maxMm: out.maxMm, sizeMm: out.sizeMm, minPointMm: out.minPointMm, maxPointMm: out.maxPointMm });
}
const diagonal = await worker.request('measure_extent', { path: PART, axis: [1, 1, 0] });
record('diagonalExtent', 'measure_extent', { path: 'part.stl', axis: [1, 1, 0] },
  { minMm: diagonal.minMm, maxMm: diagonal.maxMm, sizeMm: diagonal.sizeMm });

// ---- measure_section：板中高处（z = 4，占 z 范围 0..20 的 0.2） ------------
// 参数是 `fraction` / `atMm`（不是 `pos`——写错会被静默忽略，取默认 0.5，
// 于是"板中高"实际切在零件中高 z=10，量出来的是别处的剖面）。
const section = await worker.request('measure_section', { path: PART, axis: 'z', atMm: 4 });
// 剖面自己就会算孔距（holeSpacing）与材料面积——不要自己从环点里再算一遍：
// 那是另一个实现，迟早与工具的数字对不上。
record('section', 'measure_section', { path: 'part.stl', axis: 'z', atMm: 4 },
  { atMm: section.atMm, holeCount: section.holeCount, areaMm2: section.areaMm2, holeSpacing: section.holeSpacing, polygons: section.polygons?.length, empty: section.empty });

// ---- 负面对照件：只改圆筒内径 ---------------------------------------------
const wallB = await worker.request('measure_thickness', {
  meshes: [PART_B], from: [0, -12, 14], direction: '+x',
});
record('negativeWall', 'measure_thickness',
  { meshes: ['part-b.stl'], from: [0, -12, 14], direction: '+x' }, wallB.spans);
const tubeWallB = wallB.spans.length === 1 ? r3(wallB.spans[0].thicknessMm) : null;
const featuresB = await worker.request('list_features', { path: PART_B });
const bossBoreB = (featuresB.cylinders ?? []).filter((c) => c.kind === 'bore')
  .map((c) => r3(c.diameterMm)).sort((a, b) => b - a);
record('negativeCylinders', 'list_features', { path: 'part-b.stl' }, featuresB.cylinders);

const truth = {
  schemaVersion: 1,
  example: '06-measure',
  note: '全部数字来自工具实测；每一项的来源见 sources。不要手改：改了就不再是"实测真值"，判据会变成空的。',
  measuredWith: { workerOps: Object.values(sources).map((s) => s.op).filter((v, i, a) => a.indexOf(v) === i) },
  part: 'part.stl',
  negativePart: 'part-b.stl',
  cylinders: {
    count: cylinders.length,
    bores: bores.length,
    bosses: bosses.length,
    list: cylinders.map((c) => ({ kind: c.kind, diameterMm: r3(c.diameterMm), centerMm: c.centerMm.map(r3), lengthMm: r3(c.lengthMm) })),
  },
  holeCentreDistanceMm,
  tubeWallThicknessMm,
  slopeAngleAcuteDeg: angle.acuteDeg,
  slopeAngleAsGivenDeg: angle.angleDeg,
  slopeAngleConventionNote: 'acuteDeg 是"斜面与底面"的夹角；angleDeg 取决于探针落在哪个面上（法线朝向），'
    + '所以 rubric 按 acuteDeg 判定，并要求考生自己声明口径。',
  extentX: extents.x, extentY: extents.y, extentZ: extents.z,
  diagonalExtent: { axis: [1, 1, 0], min: r3(diagonal.minMm), max: r3(diagonal.maxMm), lengthMm: r3(diagonal.sizeMm) },
  section: {
    atZMm: r3(section.atMm),
    holeCount: section.holeCount,
    holeCentreDistanceMm: section.holeSpacing?.length ? r3(section.holeSpacing[0].centerDistanceMm) : null,
    materialAreaMm2: r3(section.areaMm2),
  },
  delta: {
    what: '圆筒壁厚（boss 内径 Ø16 → Ø14）',
    beforeMm: tubeWallThicknessMm,
    afterMm: tubeWallB,
    toleranceMm: 0.05,
    bossBoreDiametersMm: bossBoreB,
  },
  tolerances: {
    lengthMm: 0.02,
    wallMm: 0.05,
    angleDeg: 0.5,
    areaMm2: 1.0,
    countExact: true,
  },
  sources,
};
await writeFile(join(HERE, 'ground-truth.json'), `${JSON.stringify(truth, null, 2)}\n`);

// ---- 人类可读清单 ---------------------------------------------------------
const line = (k, v) => console.log(`  ${k.padEnd(26)} ${v}`);
console.log('06-measure 基准真值（全部来自工具返回）\n');
line('圆柱特征数', `${truth.cylinders.count}（孔 ${truth.cylinders.bores} / 凸台 ${truth.cylinders.bosses}）`);
for (const c of truth.cylinders.list) line(`  ${c.kind}`, `Ø${c.diameterMm} @ x=${c.centerMm[0]}, length ${c.lengthMm}`);
line('通孔孔心距', `${truth.holeCentreDistanceMm} mm`);
line('圆筒壁厚', `${truth.tubeWallThicknessMm} mm（spans: ${JSON.stringify(wall.spans.map((s) => [s.enterMm, s.exitMm, s.thicknessMm]))}）`);
line('斜面夹角', `acute ${truth.slopeAngleAcuteDeg}° / as-given ${truth.slopeAngleAsGivenDeg}°`);
line('extent X / Y / Z', `${truth.extentX.sizeMm} / ${truth.extentY.sizeMm} / ${truth.extentZ.sizeMm} mm`);
line('沿 [1,1,0]', `${truth.diagonalExtent.lengthMm} mm（${truth.diagonalExtent.min} → ${truth.diagonalExtent.max}）`);
line('剖面 z', `${truth.section.atZMm} mm，孔 ${truth.section.holeCount} 个，材料 ${truth.section.materialAreaMm2} mm²，孔距 ${truth.section.holeCentreDistanceMm} mm`);
line('负面对照 壁厚', `${truth.delta.beforeMm} → ${truth.delta.afterMm} mm（Δ${r3(truth.delta.afterMm - truth.delta.beforeMm)}）`);
line('负面对照 孔径', `bore Ø ${JSON.stringify(truth.delta.bossBoreDiametersMm)}`);
console.log(`\n→ ${join(HERE, 'ground-truth.json')}`);

await resetPythonWorker();
