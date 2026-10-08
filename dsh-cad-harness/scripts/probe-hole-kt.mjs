// 探针 2：体素 FEM 能不能抓住**应力集中**？（带中心圆孔的受拉平板 vs Kt）
//
// 探针 1（悬臂梁）测的是光滑线性应力场，δ 差 0.2%、σ 差 0.8%、内力矩差 1.0%。
// 但"哪里会断"问的是**应力集中**——而峰值应力就在**曲面边界**上，正是
// 体素阶梯误差最大的地方。所以本探针才是决定车道边界的那一个。
//
// 算例：矩形平板，中心圆孔，两端受均布拉伸。
//   W=40, L=50, t=5, d=8  ⇒ d/W = 0.2
//   有限宽 Kt（Peterson/Roark，基准为毛截面应力）：
//     Kt = 3 − 3.13(d/W) + 3.66(d/W)² − 1.53(d/W)³
//   σ_gross = 10 MPa ⇒ 峰值参考 = Kt × 10
//
// 三个层次的判据（从最干净到最难）：
//   ① 净截面平均应力（**积分不变量**，不关心应力集中）—— 远场 10 MPa / 过孔截面 12.5 MPa
//   ② 全局平衡：x=0 面反力 = 施加拉力
//   ③ 峰值应力：模型内最大 σ_xx（单元中心，**未外推**）vs Kt×10
//
//   node scripts/probe-hole-kt.mjs

import { writeFileSync } from 'node:fs';
import { compileStlOnly } from '../src/host/compile.ts';
import { buildSdfFromStl, sdfAt } from '../src/host/sdf.ts';

// ---------- 算例 ----------
const WP = 40, LP = 50, TP = 5;        // 宽(y) 长(x) 厚(z)，mm
const D = Number(process.env.HOLE_D ?? 8);   // 孔径 mm（可用 HOLE_D 扫参）
const E = 200_000, NU = 0.3;            // MPa
const SIG = 10;                         // 毛截面应力 MPa
const DW = D / WP;
const KT = 3 - 3.13 * DW + 3.66 * DW ** 2 - 1.53 * DW ** 3;
const SIG_PEAK_REF = KT * SIG;
const F_TOTAL = SIG * WP * TP;          // N
const AREA = WP * TP;
const SIG_NET_REF = SIG * WP / (WP - D);

const GP = [-1 / Math.sqrt(3), 1 / Math.sqrt(3)];
const XI = [-1, 1, 1, -1, -1, 1, 1, -1];
const ETA = [-1, -1, 1, 1, -1, -1, 1, 1];
const ZETA = [-1, -1, -1, -1, 1, 1, 1, 1];

function elementStiffness(h) {
  const lam = (E * NU) / ((1 + NU) * (1 - 2 * NU)), mu = E / (2 * (1 + NU));
  const Dm = Array.from({ length: 6 }, () => new Float64Array(6));
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) Dm[i][j] = i === j ? lam + 2 * mu : lam;
  Dm[3][3] = Dm[4][4] = Dm[5][5] = mu;
  const KE = new Float64Array(24 * 24), detJ = (h / 2) ** 3;
  for (const gx of GP) for (const gy of GP) for (const gz of GP) {
    const B = Array.from({ length: 6 }, () => new Float64Array(24));
    for (let i = 0; i < 8; i++) {
      const dX = (XI[i] * (1 + ETA[i] * gy) * (1 + ZETA[i] * gz)) / 8 * (2 / h);
      const dY = (ETA[i] * (1 + XI[i] * gx) * (1 + ZETA[i] * gz)) / 8 * (2 / h);
      const dZ = (ZETA[i] * (1 + XI[i] * gx) * (1 + ETA[i] * gy)) / 8 * (2 / h);
      const c = 3 * i;
      B[0][c] = dX; B[1][c + 1] = dY; B[2][c + 2] = dZ;
      B[3][c] = dY; B[3][c + 1] = dX; B[4][c + 1] = dZ; B[4][c + 2] = dY;
      B[5][c] = dZ; B[5][c + 2] = dX;
    }
    const DB = Array.from({ length: 6 }, () => new Float64Array(24));
    for (let r = 0; r < 6; r++) for (let c = 0; c < 24; c++) {
      let s = 0; for (let k = 0; k < 6; k++) s += Dm[r][k] * B[k][c];
      DB[r][c] = s;
    }
    for (let a = 0; a < 24; a++) for (let b = 0; b < 24; b++) {
      let s = 0; for (let k = 0; k < 6; k++) s += B[k][a] * DB[k][b];
      KE[a * 24 + b] += s * detJ;
    }
  }
  return { KE, Dm };
}

async function runCase(dx) {
  const nx = Math.round(LP / dx), ny = Math.round(WP / dx), nz = Math.round(TP / dx);
  // 平板 x∈[0,LP] y∈[0,WP] z∈[0,TP]；孔轴沿 z，中心 (LP/2, WP/2)，$fn 取高让圆尽量圆
  const scad = `$fn=128; difference(){
  cube([${LP}, ${WP}, ${TP}]);
  translate([${LP / 2}, ${WP / 2}, -1]) cylinder(h=${TP + 2}, d=${D});
}`;
  const stl = (await compileStlOnly(scad)).stl;
  const sdf = await buildSdfFromStl(stl, {
    cells: [nx, ny, nz], dxMm: dx, originMm: [dx / 2, dx / 2, dx / 2],
  });

  const nn = (i, j, k) => i * (ny + 1) * (nz + 1) + j * (nz + 1) + k;
  const nNodes = (nx + 1) * (ny + 1) * (nz + 1);
  const solid = [];
  for (let ix = 0; ix < nx; ix++) for (let iy = 0; iy < ny; iy++) for (let iz = 0; iz < nz; iz++)
    if (sdf.solidMask[ix * ny * nz + iy * nz + iz]) solid.push([ix, iy, iz]);

  const nodeActive = new Uint8Array(nNodes);
  for (const [ix, iy, iz] of solid)
    for (const [a, b, c] of [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]])
      nodeActive[nn(ix + a, iy + b, iz + c)] = 1;

  // 约束：x=0 面只约束 u_x（不约束 y/z，避免压死泊松收缩）；
  // 另加两个单点约束消掉 y/z 刚体位移。
  const fixed = new Uint8Array(nNodes * 3);
  for (let j = 0; j <= ny; j++) for (let k = 0; k <= nz; k++) fixed[nn(0, j, k) * 3 + 0] = 1;
  const pin = nn(0, Math.round(ny / 2), Math.round(nz / 2));
  fixed[pin * 3 + 1] = 1; fixed[pin * 3 + 2] = 1;

  const dofOf = new Int32Array(nNodes * 3).fill(-1);
  let nFree = 0;
  for (let nd = 0; nd < nNodes; nd++) {
    if (!nodeActive[nd]) continue;
    for (let c = 0; c < 3; c++) if (!fixed[nd * 3 + c]) dofOf[nd * 3 + c] = nFree++;
  }

  const { KE, Dm } = elementStiffness(dx);
  // ① 填充比加权：中心在实体内但部分是空气的格点，按 SDF 线性估占比
  //    α = clamp(0.5 − d_center/dx, 0.05, 1)；深部实体 α=1。α 只是标量 ⇒ KE 仍全局共用。
  const alpha = solid.map(([ix, iy, iz]) => {
    const dc = sdfAt(sdf, (ix + 0.5) * dx, (iy + 0.5) * dx, (iz + 0.5) * dx);
    return dc < -dx / 2 ? 1 : Math.min(1, Math.max(0.05, 0.5 - dc / dx));
  });
  const elemDofs = solid.map(([ix, iy, iz]) => {
    const nds = [[ix,iy,iz],[ix+1,iy,iz],[ix+1,iy+1,iz],[ix,iy+1,iz],[ix,iy,iz+1],[ix+1,iy,iz+1],[ix+1,iy+1,iz+1],[ix,iy+1,iz+1]];
    const d = new Int32Array(24);
    nds.forEach(([i, j, k], a) => { const nd = nn(i, j, k); for (let c = 0; c < 3; c++) d[3 * a + c] = dofOf[nd * 3 + c]; });
    return d;
  });

  const matvec = (x) => {
    const y = new Float64Array(nFree);
    const ue = new Float64Array(24), fe = new Float64Array(24);
    for (let e = 0; e < elemDofs.length; e++) {
      const d = elemDofs[e];
      for (let a = 0; a < 24; a++) ue[a] = d[a] >= 0 ? x[d[a]] : 0;
      const al = alpha[e];
      for (let a = 0; a < 24; a++) {
        const row = a * 24; let s = 0;
        for (let b = 0; b < 24; b++) s += KE[row + b] * ue[b];
        fe[a] = s * al;
      }
      for (let a = 0; a < 24; a++) if (d[a] >= 0) y[d[a]] += fe[a];
    }
    return y;
  };
  const diag = new Float64Array(nFree);
  for (let e = 0; e < elemDofs.length; e++) {
    const d = elemDofs[e];
    for (let a = 0; a < 24; a++) if (d[a] >= 0) diag[d[a]] += KE[a * 24 + a] * alpha[e];
  }

  // 载荷：x=LP 面均布拉伸 σ（+x）
  const rhs = new Float64Array(nFree);
  const endNodes = [];
  for (let j = 0; j <= ny; j++) for (let k = 0; k <= nz; k++) {
    const nd = nn(nx, j, k);
    if (nodeActive[nd]) endNodes.push(nd);
  }
  const fNode = F_TOTAL / endNodes.length;
  for (const nd of endNodes) { const d = dofOf[nd * 3 + 0]; if (d >= 0) rhs[d] += fNode; }

  const t0 = performance.now();
  const u = new Float64Array(nFree);
  const r = Float64Array.from(rhs), z = new Float64Array(nFree), p = new Float64Array(nFree);
  for (let i = 0; i < nFree; i++) z[i] = r[i] / diag[i];
  p.set(z);
  let rz = 0; for (let i = 0; i < nFree; i++) rz += r[i] * z[i];
  const norm = (v) => { let t = 0; for (let i = 0; i < v.length; i++) t += v[i] * v[i]; return Math.sqrt(t); };
  const r0 = norm(r) || 1;
  let iter = 0, relRes = 1;
  for (; iter < 20000; iter++) {
    const Ap = matvec(p);
    let pAp = 0; for (let i = 0; i < nFree; i++) pAp += p[i] * Ap[i];
    if (!(pAp > 0)) break;
    const alpha = rz / pAp;
    for (let i = 0; i < nFree; i++) { u[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; }
    relRes = norm(r) / r0;
    if (relRes < 1e-7) { iter++; break; }
    for (let i = 0; i < nFree; i++) z[i] = r[i] / diag[i];
    let rzNew = 0; for (let i = 0; i < nFree; i++) rzNew += r[i] * z[i];
    const beta = rzNew / rz; rz = rzNew;
    for (let i = 0; i < nFree; i++) p[i] = z[i] + beta * p[i];
  }
  const ms = performance.now() - t0;

  // 应力恢复 + 判据
  let maxSxx = -Infinity, maxAt = null, reaction = 0;
  let sumMid = 0, nMid = 0, sumFar = 0, nFar = 0, sumEnd = 0, nEnd = 0;
  const iMid = Math.round(LP / 2 / dx) - 1, iFar = Math.round(10 / dx) - 1;
  const nearHole = [];
  for (let e = 0; e < solid.length; e++) {
    const [ix, iy, iz] = solid[e];
    const d = elemDofs[e], ue = new Float64Array(24);
    for (let a = 0; a < 24; a++) ue[a] = d[a] >= 0 ? u[d[a]] : 0;
    let sxx = 0;
    for (const gx of GP) for (const gy of GP) for (const gz of GP) {
      const B = Array.from({ length: 6 }, () => new Float64Array(24));
      for (let i = 0; i < 8; i++) {
        const dX = (XI[i] * (1 + ETA[i] * gy) * (1 + ZETA[i] * gz)) / 8 * (2 / dx);
        const dY = (ETA[i] * (1 + XI[i] * gx) * (1 + ZETA[i] * gz)) / 8 * (2 / dx);
        const dZ = (ZETA[i] * (1 + XI[i] * gx) * (1 + ETA[i] * gy)) / 8 * (2 / dx);
        const c = 3 * i;
        B[0][c] = dX; B[1][c + 1] = dY; B[2][c + 2] = dZ;
        B[3][c] = dY; B[3][c + 1] = dX; B[4][c + 1] = dZ; B[4][c + 2] = dY;
        B[5][c] = dZ; B[5][c + 2] = dX;
      }
      let s = 0;
      for (let a = 0; a < 24; a++)
        s += Dm[0][0] * B[0][a] * ue[a] + Dm[0][1] * B[1][a] * ue[a] + Dm[0][2] * B[2][a] * ue[a];
      sxx += s / 8;
    }
    const xc = (ix + 0.5) * dx, yc = (iy + 0.5) * dx, zc = (iz + 0.5) * dx;
    if (sxx > maxSxx) { maxSxx = sxx; maxAt = [xc, yc, zc]; }
    const dA = dx * dx;
    if (ix === 0) { reaction += sxx * dA; sumEnd += sxx; nEnd++; }
    if (ix === iFar) { sumFar += sxx; nFar++; }
    if (ix === iMid) { sumMid += sxx; nMid++; }
    // 过孔赤道附近（x、z 都在孔心层，y > WP/2）的采样，供逐点对照
    if (Math.abs(xc - LP / 2) < dx && Math.abs(zc - TP / 2) < dx && yc > WP / 2) nearHole.push([yc, sxx]);
  }
  nearHole.sort((a, b) => a[0] - b[0]);

  return {
    dx, elements: solid.length, free: nFree, iter, relRes, ms,
    maxSxx, maxAt,
    reaction, reactionRef: F_TOTAL,
    avgFar: sumFar / Math.max(1, nFar), farRef: SIG,
    avgNet: sumMid / Math.max(1, nMid), netRef: SIG_NET_REF,
    nearest: nearHole[0] ?? null,      // 最靠近孔边的实心单元中心
    peakRef: SIG_PEAK_REF, kt: KT, dw: DW,
  };
}

console.log(`d/W = ${DW.toFixed(3)} ⇒ Kt(毛截面) = ${KT.toFixed(4)}`);
console.log(`参考：峰值 = ${SIG_PEAK_REF.toFixed(2)} MPa · 过孔净截面均值 = ${SIG_NET_REF.toFixed(2)} MPa · 远场 = ${SIG} MPa · 总拉力 = ${F_TOTAL} N\n`);

const rows = [];
const DXS = (process.env.HOLE_DX ?? '1.0,0.5').split(',').map(Number);
for (const dx of DXS) rows.push(await runCase(dx));

console.log('dx(mm)  单元数   自由DOF  CG迭代 残差     耗时s | ①反力/参考  ②远场/参考  ②净截面/参考 | ③最大σxx  比值  (位置)');
for (const r of rows) {
  const pc = (v, ref) => `${((100 * (v - ref)) / ref >= 0 ? '+' : '')}${((100 * (v - ref)) / ref).toFixed(1)}%`.padStart(7);
  console.log(
    `${r.dx.toFixed(2)} ${String(r.elements).padStart(8)} ${String(r.free).padStart(9)} ${String(r.iter).padStart(6)}`
    + ` ${r.relRes.toExponential(1)} ${(r.ms / 1000).toFixed(1).padStart(6)}`
    + ` | ${r.reaction.toFixed(0).padStart(6)}${pc(r.reaction, r.reactionRef)}`
    + `  ${r.avgFar.toFixed(2).padStart(5)}${pc(r.avgFar, r.farRef)}`
    + `  ${r.avgNet.toFixed(2).padStart(5)}${pc(r.avgNet, r.netRef)}`
    + ` | ${r.maxSxx.toFixed(2).padStart(6)} ${(r.maxSxx / r.peakRef).toFixed(3)}`
    + ` (${r.maxAt.map((v) => v.toFixed(1)).join(',')})`);
}
console.log('\n最靠近孔边的实心单元中心（未外推）：');
for (const r of rows) {
  const [y, s] = r.nearest;
  console.log(`  dx=${r.dx}  y=${y.toFixed(2)}（孔边在 ${(WP / 2 + D / 2).toFixed(1)}）  σ_xx=${s.toFixed(2)} MPa`
    + `  ⇒ 占参考峰值 ${(100 * s / r.peakRef).toFixed(1)}%`);
}
writeFileSync(new URL(`./probe-hole-kt-d${D}.json`, import.meta.url), JSON.stringify({ d: D, kt: KT, peakRef: SIG_PEAK_REF, netRef: SIG_NET_REF, rows }, null, 2));
console.log(`\n→ scripts/probe-hole-kt-d${D}.json`);
