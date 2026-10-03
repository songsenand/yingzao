// SDF boundary-link smoke: straight pipe, analytic ground truth assertions.
//
// Pipe: OpenSCAD `difference` of two cylinders, z axis, centred:
//   inner r=20 (cavity), outer r=24 (wall), h=200.
// Grid: dx=2mm, origin (-25,-25,-101), cells 26×26×102 (covers bbox + 1 cell margin).
//
// Assertions: cavity/wall/void signs, analytic distance at known radii,
// left-right symmetry, occupancy volume vs Manifold volume, and mpm.ts
// hook compatibility (mask/normal codes).

import { compileStlOnly } from '../src/host/compile.ts';
import { buildSdfFromStl, sdfAt } from '../src/host/sdf.ts';

const SCAD = `
$fn = 64;
difference() {
  cylinder(h = 200, d = 48, center = true);
  cylinder(h = 210, d = 40, center = true);
}
`;

const t0 = performance.now();
const compiled = await compileStlOnly(SCAD);
if (!compiled.success || !compiled.stl) {
  console.error('FAIL: pipe compile failed:', compiled.errors.join('; '));
  process.exit(1);
}
console.log(`compile: ${compiled.stl.length} bytes stl in ${(performance.now() - t0).toFixed(0)}ms`);

const field = await buildSdfFromStl(compiled.stl, {
  cells: [26, 26, 102],
  dxMm: 2,
  originMm: [-25, -25, -101],
});
const { stats } = field;
console.log(`sdf build: ${stats.buildMs.toFixed(0)}ms  cells=${stats.cells}  solidCells=${stats.solidCells}  boundary=${stats.boundaryCells}  min=${stats.minSdf.toFixed(1)} max=${stats.maxSdf.toFixed(1)}`);

let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) fail++;
};

// 1. signs: cavity / wall / outside
const sCavity = sdfAt(field, 0, 0, 0);
const sWall = sdfAt(field, 22, 0, 0);
const sVoid = sdfAt(field, 40, 0, 0);
check('cavity sign (+)', sCavity > 0, `sdf(0,0,0)=${sCavity.toFixed(2)}`);
check('wall sign (−)', sWall < 0, `sdf(22,0,0)=${sWall.toFixed(2)}`);
check('void beyond pipe (+)', sVoid > 0, `sdf(40,0,0)=${sVoid.toFixed(2)}`);

// 2. analytic distance at inner wall (r_wall = 20mm)
const s19 = sdfAt(field, 19, 0, 0);   // 1mm inside cavity from wall → expect ≈ +1
const s21 = sdfAt(field, 21, 0, 0);   // 1mm inside wall material → expect ≈ −1
check('near-wall distance (+1mm)', Math.abs(s19 - 1) < 0.8, `sdf(19,0,0)=${s19.toFixed(2)} expect ≈1`);
check('near-wall distance (−1mm)', Math.abs(s21 + 1) < 0.8, `sdf(21,0,0)=${s21.toFixed(2)} expect ≈−1`);

// 3. symmetry across the pipe axis
const sym = Math.abs(sdfAt(field, 22, 0, 0) - sdfAt(field, -22, 0, 0));
check('radial symmetry', sym < 0.5, `|Δ|=${sym.toFixed(3)}`);

// 4. occupancy volume vs analytic π(R²−r²)h = π(576−400)·200 ≈ 110,584 mm³
const analytic = Math.PI * (24 * 24 - 20 * 20) * 200;
const occupancy = stats.solidCells * (field.dxMm ** 3);
const ratio = occupancy / analytic;
check('occupancy volume ±25%', ratio > 0.75 && ratio < 1.3, `occupancy=${occupancy.toFixed(0)}mm³ analytic=${analytic.toFixed(0)}mm³ ratio=${ratio.toFixed(2)}`);

// 5. mpm.ts hook compatibility
const total = 26 * 26 * 102;
check('array lengths', field.solidMask.length === total && field.solidNormal.length === total && field.sdf.length === total, `${total}`);
const badCodes = [...field.solidNormal].filter((c) => c > 6).length;
check('normal codes ⊆ 0..6', badCodes === 0, `${badCodes} invalid`);
// inner-wall boundary cells near (21,0,0): normal must be x-axis (code 1 or 2)
const [ox, oy, oz] = field.originMm;
const probe = sdfAt(field, 21, 0, 0) < 0;
const codeAt = (x, y, z) => {
  const ix = Math.round((x - ox) / 2), iy = Math.round((y - oy) / 2), iz = Math.round((z - oz) / 2);
  return field.solidNormal[ix * 26 * 102 + iy * 102 + iz];
};
const code = codeAt(21, 0, 0);
check('wall normal axis = x', probe && (code === 1 || code === 2), `code=${code} (1|2 = ±x)`);

console.log(fail === 0 ? '\nSDF SMOKE PASSED' : `\nSDF SMOKE FAILED (${fail})`);
process.exit(fail === 0 ? 0 : 1);
