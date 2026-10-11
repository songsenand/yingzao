#!/usr/bin/env node
// 04-rack-connector · 基准真值（**评分方脚本**）
//
//   export DSH_CAD_PYTHON_ROOT=<repo>/.tmp-measure-runtime
//   node examples/bench/graders/04-rack-connector/materialize.mjs --out <dir> --with-reference
//   node examples/bench/graders/04-rack-connector/measure-04.mjs --parts <dir> [--reference <stl>]
//
// 判据里的数字**必须来自工具实测**：这一节的每一条都记 `sources`（op / 参数 /
// 原始返回），复核者照参数重跑即可，不必相信出题人。
//
// 这一卷的判据是**功能性**的：补出来的接头只要"装得上、锁得住、印得出"就算过，
// 不要求复刻参考件。所以真值里主要记的是**配合尺寸的量级与容差带**，
// 参考件的精确尺寸只作为"这个量级是合理的"的证据。

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

const partsDir = resolve(opt('--parts', join(REPO, '.tmp-04-test')));
const referencePath = resolve(opt('--reference', join(REPO, '.tmp-bench04-cache', 'stl', 'reference-stackConnectorBottom.stl')));

const worker = await ensurePythonWorker();
const sources = {};
const record = (key, op, params, value) => { sources[key] = { op, params, value }; return value; };
const r3 = (x) => Math.round(x * 1000) / 1000;

const extentOf = async (label, path, axis) => {
  const out = await worker.request('measure_extent', { path, axis });
  record(`${label}.extent.${axis}`, 'measure_extent', { path: `${label}.stl`, axis },
    { minMm: out.minMm, maxMm: out.maxMm, sizeMm: out.sizeMm });
  return { min: r3(out.minMm), max: r3(out.maxMm), sizeMm: r3(out.sizeMm) };
};

/** 面/孔清单：把每个面的孔按直径归并，便于人读。 */
const featuresOf = async (label, path) => {
  const lf = await worker.request('list_features', { path });
  record(`${label}.list_features`, 'list_features', { path: `${label}.stl` },
    { faceCount: lf.faceCount, holeCount: lf.holeCount, cylinderCount: lf.cylinderCount,
      warnings: lf.warnings, cylinders: lf.cylinders, facesOmitted: lf.facesOmitted });
  const holes = [];
  for (const face of lf.faces) {
    for (const hole of face.holes) {
      holes.push({ diameterMm: r3(hole.diameterMm ?? 0), through: hole.through ?? null,
        depthMm: hole.depthMm == null ? null : r3(hole.depthMm), centerMm: hole.centerMm.map(r3) });
    }
  }
  const through = holes.filter((h) => h.through === true);
  const diameters = [...new Set(through.map((h) => h.diameterMm))].sort((a, b) => a - b);
  return { faceCount: lf.faceCount, holeCount: lf.holeCount, cylinderCount: lf.cylinderCount,
    warnings: lf.warnings, throughHoles: through, throughDiametersMm: diameters,
    /// 成对锁孔的水平间距 = 通孔 x 的**跨度**。
    /// 不能取"前两个孔之差"：同族 rackJoiner 的前两个孔 x 相同、z 相反，
    /// 那样会算出 0（实测踩到），而家族的真实间距是 2.4。
    pairSpacingMm: through.length >= 2
      ? r3(Math.max(...through.map((h) => h.centerMm[0])) - Math.min(...through.map((h) => h.centerMm[0])))
      : null };
};

const rail = join(partsDir, 'mainRail.stl');
const joiner = join(partsDir, 'rackJoiner.stl');
const railExtent = { x: await extentOf('rail', rail, 'x'), y: await extentOf('rail', rail, 'y'), z: await extentOf('rail', rail, 'z') };
const railFeatures = await featuresOf('rail', rail);
const joinerExtent = { x: await extentOf('joiner', joiner, 'x'), y: await extentOf('joiner', joiner, 'y'), z: await extentOf('joiner', joiner, 'z') };
const joinerFeatures = await featuresOf('joiner', joiner);
const referenceExtent = { x: await extentOf('reference', referencePath, 'x'), y: await extentOf('reference', referencePath, 'y'), z: await extentOf('reference', referencePath, 'z') };
const referenceFeatures = await featuresOf('reference', referencePath);
const referenceSolid = record('reference.connectivity', 'connectivity', { path: 'reference.stl' },
  await worker.request('connectivity', { path: referencePath }));

const truth = {
  schemaVersion: 1,
  example: '04-rack-connector',
  note: '判据是功能性的：装得上、锁得住、印得出。参考件只用来证明"这个量级合理"。'
    + '全部数字来自工具实测，来源见 sources；不要手改。',
  upstream: { repo: 'jazwa/rackstack', commit: '8e296e935aad89a6d1a5023da79becc634c10c2d', license: 'MIT' },
  given: {
    mainRail: { extentMm: railExtent, features: railFeatures },
    rackJoiner: { extentMm: joinerExtent, features: joinerFeatures },
  },
  reference: { // 评分方一侧：原件的实测，用来定义"合理量级"
    extentMm: referenceExtent,
    features: referenceFeatures,
    bodies: referenceSolid.count ?? referenceSolid.bodies?.length ?? null,
    watertight: referenceSolid.watertight,
  },
  // ---- 功能判据的容差带（每条都写明"为什么"） -------------------------------
  acceptance: {
    crossSectionMm: {
      min: 9.4, max: 9.9,
      why: '接头要插进/套上导轨的 9.8mm 方口：比 9.4 还小会晃、锁不住；比 9.9 大就插不进去。'
        + `参考件实测 ${referenceExtent.x.sizeMm} × ${referenceExtent.y.sizeMm}。`,
    },
    lengthMm: {
      min: 10, max: 18,
      why: '要跨过两段导轨的对接缝（太短锁不住、太长会撞到同族的 rackJoiner）；'
        + `参考件 ${referenceExtent.z.sizeMm}、同族 rackJoiner ${joinerExtent.z.sizeMm}。`,
    },
    throughHoleDiameterMm: {
      min: 3.0, max: 3.6,
      why: `M3 螺钉过孔：导轨上的锁孔实测 Ø${railFeatures.throughDiametersMm.join('/')}，`
        + `参考件与同族件都是 Ø${referenceFeatures.throughDiametersMm.join('/')}。`,
    },
    throughHoleCount: { min: 1, why: '至少一个通孔把接头锁在导轨上；参考件 2 个、同族件 4 个。' },
    pairSpacingMm: {
      nominal: referenceFeatures.pairSpacingMm, tolerance: 0.4,
      why: `接头家族成对锁孔的水平间距（参考件 ${referenceFeatures.pairSpacingMm}、同族件 ${joinerFeatures.pairSpacingMm}）。`,
    },
  },
  sources,
};
await writeFile(join(HERE, 'ground-truth.json'), `${JSON.stringify(truth, null, 2)}\n`);

const line = (k, v) => console.log(`  ${k.padEnd(26)} ${v}`);
console.log('04-rack-connector 基准真值（全部来自工具返回）\n');
line('给定：导轨', `${railExtent.x.sizeMm} × ${railExtent.y.sizeMm} × ${railExtent.z.sizeMm}，`
  + `${railFeatures.faceCount} 面 / ${railFeatures.holeCount} 孔，孔径 ${railFeatures.throughDiametersMm.join('/')}`);
line('给定：同族接头', `${joinerExtent.x.sizeMm} × ${joinerExtent.y.sizeMm} × ${joinerExtent.z.sizeMm}，`
  + `通孔 Ø${joinerFeatures.throughDiametersMm.join('/')} × ${joinerFeatures.throughHoles.length}，成对间距 ${joinerFeatures.pairSpacingMm}`);
line('参考件（评分方）', `${referenceExtent.x.sizeMm} × ${referenceExtent.y.sizeMm} × ${referenceExtent.z.sizeMm}，`
  + `通孔 Ø${referenceFeatures.throughDiametersMm.join('/')} × ${referenceFeatures.throughHoles.length}，成对间距 ${referenceFeatures.pairSpacingMm}`);
line('接受带：截面', `${truth.acceptance.crossSectionMm.min} – ${truth.acceptance.crossSectionMm.max} mm`);
line('接受带：长度', `${truth.acceptance.lengthMm.min} – ${truth.acceptance.lengthMm.max} mm`);
line('接受带：通孔', `Ø${truth.acceptance.throughHoleDiameterMm.min} – ${truth.acceptance.throughHoleDiameterMm.max}，至少 ${truth.acceptance.throughHoleCount.min} 个`);
console.log(`\n→ ${join(HERE, 'ground-truth.json')}`);

await resetPythonWorker();
