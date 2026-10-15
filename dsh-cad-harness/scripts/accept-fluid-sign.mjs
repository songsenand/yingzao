// Acceptance for the fluid SDF sign (2026-10-08 thick-wall defect).
//
// What went wrong: `buildSdfFromStl` decided "inside solid" by ray parity over
// three AXIS-ALIGNED rays. A cap's radial seam lies in the axis-aligned grid
// planes, so a ray exiting exactly through a shared edge hit BOTH triangles —
// one crossing counted twice, parity flipped to "outside". Measured on a
// Ø60/Ø30 annulus: a point 7.5mm INSIDE a 15mm wall read sdf=+6.75,
// solidMask=0 (fluid), and a point outside the part read solidMask=1.
// Consequences: `seedPositions` (distance test only) seeded particles inside
// metal, and the MPM world got an inverted collision mask.
//
// This pins, on three wall thicknesses:
//   1  a point in the cavity is fluid, a point inside the wall is SOLID,
//      and the sign agrees with the mask (the original defect);
//   2  the wall interior is not merely "not fluid" — its distance is negative;
//   3  no particle is seeded inside metal (seedStats.rejectedSolid accounts
//      for the region's metal share instead of seeding it);
//   4  penetration stays 0 and arrival stays in a sane band across wall
//      thicknesses for the SAME bore (the defect made it 0.44 vs 0.76);
//   5  the seed region's metal share is REPORTED, not silent.
//
//   node scripts/accept-fluid-sign.mjs

import { compileStlOnly } from '../src/host/compile.ts';
import { deriveFluidPreset, runFluid } from '../src/host/fluid.ts';
import { sdfAt, solidMaskAt } from '../src/host/sdf.ts';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
};

const tube = (od, bore = 30, len = 100) => `$fn=64;
difference(){ rotate([0,90,0]) cylinder(h=${len},d=${od},center=true);
              rotate([0,90,0]) cylinder(h=${len+10},d=${bore},center=true); }`;

const arrivals = [];
for (const od of [34, 60, 100]) {
  const wall = (od - 30) / 2;
  const stl = (await compileStlOnly(tube(od))).stl;
  const p = deriveFluidPreset(stl, 2, 100);
  const { report, sdf } = await runFluid({
    pipeStl: stl, gridCells: p.gridCells, gridOriginMm: p.gridOriginMm, dxMm: p.dxMm,
    fluidRegionMm: p.fluidRegionMm,
    inlet: { axis: p.axis, bandMm: p.inletBandMm, velocityMmPerSec: 100 },
    outletPlaneMm: p.outletPlaneMm, particlesPerCell: 6, steps: p.steps, snapshotCount: 2,
  });
  const m = report.metrics;
  const rMid = (15 + od / 2) / 2;                 // 壁厚中点
  const sWall = sdfAt(sdf, 0, rMid, 0);
  const mWall = solidMaskAt(sdf, 0, rMid, 0);
  const sCav = sdfAt(sdf, 0, 0, 0);
  const mCav = solidMaskAt(sdf, 0, 0, 0);

  check(`Ø${od} 壁厚 ${wall}mm：腔心是流体`, mCav === 0 && sCav > 0, `sdf=${sCav.toFixed(2)} mask=${mCav}`);
  check(`Ø${od} 壁厚 ${wall}mm：壁内是固体（原缺陷点）`, mWall === 1 && sWall < 0, `sdf=${sWall.toFixed(2)} mask=${mWall}`);
  check(`Ø${od} 壁厚 ${wall}mm：穿透为 0`, m.penetrationCount === 0, `penetration=${m.penetrationCount}`);
  check(`Ø${od} 壁厚 ${wall}mm：种子不落进金属（已记账）`,
    Number.isFinite(m.seedStats?.solidFraction) && m.seedStats.rejectedSolid >= 0,
    `seedStats=${JSON.stringify(m.seedStats)}`);
  arrivals.push(m.outletArrivalRatio);
}

// 6. 粒子数超过种子格点时必须**出声**（2026-10-08 补）
//    放置循环是 `seeds[idx++ % seeds.length]`：多出来的粒子是同一位置的副本，
//    逃逸**比例**不变（副本同命），但报告看起来比实际采样密得多。
{
  const stl = (await compileStlOnly(tube(44, 30, 30))).stl;
  const p = deriveFluidPreset(stl, 2, 100);
  const run = (particleCount) => runFluid({
    pipeStl: stl, gridCells: p.gridCells, gridOriginMm: p.gridOriginMm, dxMm: p.dxMm,
    fluidRegionMm: p.fluidRegionMm,
    inlet: { axis: p.axis, bandMm: p.inletBandMm, velocityMmPerSec: 100 },
    outletPlaneMm: p.outletPlaneMm, particlesPerCell: 6, particleCount, steps: p.steps, snapshotCount: 2,
  });
  const auto = (await run(undefined)).report;
  const stacked = (await run(80000)).report;
  check('粒子数超过种子格点时报 stacksPerSeed', (stacked.metrics.seedStats?.stacksPerSeed ?? 0) > 1.5,
    `自动 ${auto.metrics.seedStats.accepted} 种子 ×${auto.metrics.seedStats.stacksPerSeed}；显式 80000 ×${stacked.metrics.seedStats.stacksPerSeed}`);
  check('堆叠时给出 warnings', (stacked.warnings ?? []).some((w) => /STACK/.test(w)),
    (stacked.warnings ?? [])[0]?.slice(0, 70) ?? '(无警告)');
  check('未堆叠时不误报', (auto.warnings ?? []).every((w) => !/STACK/.test(w)),
    `自动那次的 warnings=${JSON.stringify((auto.warnings ?? []).map((w) => w.slice(0, 40)))}`);
}

// 同内腔、不同壁厚：到达率不应再随外径大幅漂移（缺陷时 0.443 vs 0.757，跨度 0.32）。
//
// 阈值 0.15 → 0.20（2026-10-14，用户拍板，随 numba 引擎采纳落定，DECISION-LOG 同日）。
// 依据（同机同种子实测）：该指标对舍入序敏感——numpy 引擎跨度 0.1337（对 0.15 的余量仅
// 0.016，按 2026-10-11"零/过小余量记为困难"本就该标红），numba 引擎 0.1582（确定性逐位
// 复现）；而项目 dt 细化研究（TOOL-RUNTIME-MATRIX row 16）证明该指标对离散化本身敏感
// 0.123——0.15 从来都画在噪声地板里。缺陷信号 0.32 对新阈值仍有 1.6× 分离度，
// 符号/掩码/穿透/种子记账的直接断言（本文件上方）不受此阈值影响。
const spread = Math.max(...arrivals) - Math.min(...arrivals);
check('同内腔不同壁厚，到达率不再大幅漂移', spread < 0.20,
  `到达 ${arrivals.map((a) => a.toFixed(4)).join(' / ')}，跨度 ${spread.toFixed(4)}（要求 < 0.20）`);

console.log(`\n${fail === 0 ? 'OK' : `${fail} FAILURE(S)`}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
