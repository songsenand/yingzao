#!/usr/bin/env node
// 05-rack-assembly · 基准真值（**评分方脚本**）
//
//   export DSH_CAD_PYTHON_ROOT=<repo>/.tmp-measure-runtime
//   node examples/bench/graders/05-rack-assembly/materialize.mjs --out <dir> --with-reference
//   node examples/bench/graders/05-rack-assembly/measure-05.mjs --parts <dir> [--reference <stl>]
//
// 判据数字全部来自工具实测，每项记 `sources`（op / 参数 / 原始返回）。
//
// 这一卷测的是**装配**：给两件已画好的零件（横杆 xBar、立杆 yBar），要求把它们的
// 相对位姿摆对、装成机架的一角，并证明装得上（不干涉）。参考位姿来自语料**自己的**
// 装配代码（`attachXBarWithYBar`），所以真值里最关键的一条是：
// **装配后的整体包络**（两件都摆对时，合起来的包围盒）。
//
// 为什么用包络而不是逐点比对：合法的装配只有**一个**（配合特征唯一确定了位姿），
// 而包络对位姿误差是敏感的——摆错一个面，包络立刻差出几十毫米。

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePythonWorker, resetPythonWorker } from '../../../../dsh-cad-harness/src/host/python-worker.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
process.env.DSH_CAD_PYTHON_ROOT = process.env.DSH_CAD_PYTHON_ROOT ?? join(REPO, '.tmp-measure-runtime');
const partsDir = resolve(opt('--parts', join(REPO, '.tmp-05-test')));
const referencePath = resolve(opt('--reference', join(REPO, '.tmp-bench05-cache', 'stl', 'reference-assembly.stl')));

const worker = await ensurePythonWorker();
const sources = {};
const record = (key, op, params, value) => { sources[key] = { op, params, value }; return value; };
const r3 = (x) => Math.round(x * 1000) / 1000;

/** 三轴尺寸 + 包围盒角点；装配判据看的是这个。 */
const boxOf = async (label, path) => {
  const out = {};
  for (const axis of ['x', 'y', 'z']) {
    const r = await worker.request('measure_extent', { path, axis });
    out[axis] = { min: r3(r.minMm), max: r3(r.maxMm), sizeMm: r3(r.sizeMm) };
  }
  record(`${label}.extent`, 'measure_extent', { path: `${label}.stl`, axis: 'x|y|z' }, out);
  return out;
};
const solidOf = async (label, path) => {
  const conn = await worker.request('connectivity', { path });
  const part = await worker.request('measure_part', { path });
  record(`${label}.solid`, 'connectivity+measure_part', { path: `${label}.stl` },
    { bodies: conn.count, watertight: conn.watertight, volumeMm3: part.volumeMm3, triangles: part.triangles });
  return { bodies: conn.count, watertight: conn.watertight, volumeMm3: r3(part.volumeMm3), triangles: part.triangles };
};

const xBar = { extentMm: await boxOf('xBar', join(partsDir, 'xBar.stl')), solid: await solidOf('xBar', join(partsDir, 'xBar.stl')) };
const yBar = { extentMm: await boxOf('yBar', join(partsDir, 'yBar.stl')), solid: await solidOf('yBar', join(partsDir, 'yBar.stl')) };
const reference = { extentMm: await boxOf('reference', referencePath), solid: await solidOf('reference', referencePath) };

/** 参考包络：装配正确的判据就是"合起来长这样"。 */
const envelope = (box) => ({
  x: box.x.sizeMm, y: box.y.sizeMm, z: box.z.sizeMm,
  originMm: [box.x.min, box.y.min, box.z.min],
});

const truth = {
  schemaVersion: 1,
  example: '05-rack-assembly',
  note: '判据是"位姿对不对"：参考包络来自语料自己的装配入口（attachXBarWithYBar）。'
    + '全部数字工具实测，来源见 sources；不要手改。',
  upstream: { repo: 'jazwa/rackstack', commit: '8e296e935aad89a6d1a5023da79becc634c10c2d', license: 'MIT' },
  given: { xBar, yBar },
  reference: { ...reference, note: '语料的装配入口，含插装的螺母/磁铁模块，实测 13 体——只用来定包络与量级' },
  acceptance: {
    envelopeMm: {
      tolerance: 2.0,
      target: envelope(reference.extentMm),
      why: '两件都摆对时合起来的包络是唯一的。参考件自带插装件但都在两件内部，不改变包络；'
        + `容差 ±2mm 用来吸收合并/坐标取整，摆错一个面会差出几十毫米，判据仍然敏感。`,
    },
    noInterference: {
      why: '摆对了是"贴合"，摆错了十有八九是"插进去"——所以干涉数必须为 0。',
    },
    bodiesAfterMerge: {
      target: 1,
      why: '两件装好后 `merge_parts` 应当得到**一个**连通体（它们本来就是靠配合特征连起来的）；'
        + '若得到 2 体，说明两件根本没接触——位姿差得远。',
    },
  },
  sources,
};
await writeFile(join(HERE, 'ground-truth.json'), `${JSON.stringify(truth, null, 2)}\n`);

const line = (k, v) => console.log(`  ${k.padEnd(24)} ${v}`);
console.log('05-rack-assembly 基准真值（全部来自工具返回）\n');
line('给定：xBar', `${xBar.extentMm.x.sizeMm} × ${yBar.extentMm.y.sizeMm ? xBar.extentMm.y.sizeMm : 0} × ${xBar.extentMm.z.sizeMm}，${xBar.solid.bodies} 体，${xBar.solid.triangles} 三角`);
line('给定：yBar', `${yBar.extentMm.x.sizeMm} × ${yBar.extentMm.y.sizeMm} × ${yBar.extentMm.z.sizeMm}，${yBar.solid.bodies} 体，${yBar.solid.triangles} 三角`);
line('参考装配包络', `${truth.acceptance.envelopeMm.target.x} × ${truth.acceptance.envelopeMm.target.y} × ${truth.acceptance.envelopeMm.target.z}`);
line('参考装配起点', JSON.stringify(truth.acceptance.envelopeMm.target.originMm));
line('参考件体数', `${reference.solid.bodies}（含插装件）`);
line('接受带', `包络 ±${truth.acceptance.envelopeMm.tolerance}mm；干涉 0；合并后 ${truth.acceptance.bodiesAfterMerge.target} 体`);
console.log(`\n→ ${join(HERE, 'ground-truth.json')}`);

await resetPythonWorker();
