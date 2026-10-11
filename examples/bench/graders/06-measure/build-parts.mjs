#!/usr/bin/env node
// 06-measure · 造件（**评分方脚本**，源码与生成物分开放）
//
//   node examples/bench/graders/06-measure/build-parts.mjs
//
// 为什么要这个脚本而不是把 STL 当"素材"直接入库：
//   * 题面只给 STL —— 模型要"量看不见的几何"；源码留在评分方一侧，否则等于给答案；
//   * 负面对照件必须与主件**只差一处**，所以两件由同一段源码 + 一个参数生成，
//     而不是手工画两遍（手工画的两件迟早会差出第二处，"只改一处"就成了假话）。
//
// 件的能力覆盖（对应 rubric 的每一条数值判据）：
//   * 两个通孔，直径不同（Ø8 / Ø14），孔心距 50.000 —— list_features / measure_section
//   * 一个圆筒，外 Ø22、内 Ø16 → 壁厚 3.000 —— measure_thickness
//   * 一处斜面与底板成 30° —— measure_angle
//   * 整体 80 × 50 × 20，可算沿 [1,1,0] 的起止 —— measure_extent
//
// 负面对照件 `part-b.stl`：**只把圆筒内径 16 → 14**（壁厚 3.000 → 4.000）。
// 选这一处是因为它同时动 measure_thickness 与 list_features 两条判据。

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileStlOnly } from '../../../../dsh-cad-harness/src/host/compile.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUBJECT = resolve(HERE, '..', '..', 'subjects', '06-measure');

/**
 * The part, parameterised by the ONE number the negative control moves.
 * `$fn = 96` so the tessellation is far finer than any tolerance the rubric asks for,
 * and the bore is a true circle to within 0.002mm.
 */
export const partSource = (bossBoreDiameter = 16) => `$fn = 96;

// ---- base plate: 80 (X) x 50 (Y) x 8 (Z), bottom at z=0 ----------------------
difference() {
  translate([0, 0, 4]) cube([80, 50, 8], center = true);
  // two through-bores, different diameters, centres 50mm apart on X
  translate([-25, 0, -1]) cylinder(h = 10, d = 8);
  translate([ 25, 0, -1]) cylinder(h = 10, d = 14);
}

// ---- boss on the plate top: OD 22, bore ${bossBoreDiameter} → wall ${(22 - bossBoreDiameter) / 2}mm --------
// y = -12 so the Ø22 boss (radius 11) stays inside the plate's y ∈ [-25, 25]:
// at y = -15 it reached y = -26 and the part's Y size read 51, not 50.
translate([0, -12, 8]) difference() {
  cylinder(h = 12, d = 22);
  translate([0, 0, -1]) cylinder(h = 14, d = ${bossBoreDiameter});
}

// ---- web whose slanted face makes 30° with the plate ------------------------
// rotate([90,0,0]) maps the polygon's own y onto world z, so the hypotenuse rises
// from the plate top at exactly 30°.
translate([-10, 20, 8]) rotate([90, 0, 0]) linear_extrude(height = 10)
  polygon(points = [[0, 0], [20, 0], [20, 20 * tan(30)]]);
`;

const build = async (name, source) => {
  const built = await compileStlOnly(source);
  if (!built.success || !built.stl) throw new Error(`${name} did not compile: ${built.errors?.join('; ')}`);
  await mkdir(SUBJECT, { recursive: true });
  const path = join(SUBJECT, name);
  await writeFile(path, built.stl);
  return { path, bytes: built.stl.length };
};

const main = await build('part.stl', partSource(16));
const negative = await build('part-b.stl', partSource(14));
console.log(`part.stl    ${main.bytes} bytes  → ${main.path}`);
console.log(`part-b.stl  ${negative.bytes} bytes  → ${negative.path}`);
console.log('only difference: boss bore Ø16 → Ø14 (wall 3.000 → 4.000)');
