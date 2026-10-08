// 探针：体素（hex8）线弹性 FEM 能不能给出可用的应力数字？
//
// 背景：`M4-M5-REVIEW.md §7` 查明三个现有引擎都做不了静力应力，但 `sdf.ts` 已经把
// 实体体素化了（solidMask + solidNormal + 规则网格），恰是 hex8 所需的网格。
// 本探针不去建"车道"，只用最少的代码验证：**这条路值不值得走**。
//
// 做法：矩形悬臂梁，一端固定、端部集中载荷，与梁理论对拍。
//   δ      = F L³ / (3 E I)
//   σ_max  = 6 F L / (B H²)      （固定端外纤维）
//   内力矩  = F L                  （独立不变量，不受固定端应力集中影响）
//
// 三档分辨率看收敛，另加一档"半格偏移"看阶梯边界的代价。
//
//   node scripts/probe-cantilever-fem.mjs

import { writeFileSync } from 'node:fs';
import { compileStlOnly } from '../src/host/compile.ts';
import { buildSdfFromStl } from '../src/host/sdf.ts';

// ---------- 算例 ----------
const L = 100, B = 10, H = 10;            // mm
const E = 200_000, NU = 0.3;              // MPa
const F = 100;                            // N，端部向下
const I = (B * H ** 3) / 12;
const DELTA_REF = (F * L ** 3) / (3 * E * I);
const SIGMA_REF = (6 * F * L) / (B * H * H);
const MOMENT_REF = F * L;                 // N·mm

// ---------- hex8 单元刚度（所有单元都是同尺寸立方体 ⇒ 只算一次）----------
const GP = [-1 / Math.sqrt(3), 1 / Math.sqrt(3)];
const XI = [-1, 1, 1, -1, -1, 1, 1, -1];
const ETA = [-1, -1, 1, 1, -1, -1, 1, 1];
const ZETA = [-1, -1, -1, -1, 1, 1, 1, 1];

function elementStiffness(h) {
  const lam = (E * NU) / ((1 + NU) * (1 - 2 * NU));
  const mu = E / (2 * (1 + NU));
  // D（Voigt：xx yy zz xy yz zx）
  const D = Array.from({ length: 6 }, () => new Float64Array(6));
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) D[i][j] = i === j ? lam + 2 * mu : lam;
  D[3][3] = D[4][4] = D[5][5] = mu;

  const KE = new Float64Array(24 * 24);
  const detJ = (h / 2) ** 3;
  for (const gx of GP) for (const gy of GP) for (const gz of GP) {
    const B = Array.from({ length: 6 }, () => new Float64Array(24));
    for (let i = 0; i < 8; i++) {
      const dNdX = (XI[i] * (1 + ETA[i] * gy) * (1 + ZETA[i] * gz)) / 8 * (2 / h);
      const dNdY = (ETA[i] * (1 + XI[i] * gx) * (1 + ZETA[i] * gz)) / 8 * (2 / h);
      const dNdZ = (ZETA[i] * (1 + XI[i] * gx) * (1 + ETA[i] * gy)) / 8 * (2 / h);
      const c = 3 * i;
      B[0][c] = dNdX; B[1][c + 1] = dNdY; B[2][c + 2] = dNdZ;
      B[3][c] = dNdY; B[3][c + 1] = dNdX;
      B[4][c + 1] = dNdZ; B[4][c + 2] = dNdY;
      B[5][c] = dNdZ; B[5][c + 2] = dNdX;
    }
    // KE += Bᵀ D B detJ
    const DB = Array.from({ length: 6 }, () => new Float64Array(24));
    for (let r = 0; r < 6; r++) for (let c = 0; c < 24; c++) {
      let s = 0; for (let k = 0; k < 6; k++) s += D[r][k] * B[k][c];
      DB[r][c] = s;
    }
    for (let a = 0; a < 24; a++) for (let b = 0; b < 24; b++) {
      let s = 0; for (let k = 0; k < 6; k++) s += B[k][a] * DB[k][b];
      KE[a * 24 + b] += s * detJ;
    }
  }
  return { KE, D };
}

// ---------- 一次算例 ----------
async function runCase(dx, offsetCells = 0, label = '') {
  const nx = Math.round(L / dx), ny = Math.round(B / dx), nz = Math.round(H / dx);
  // SCAD：梁在 x∈[0,L]、y∈[-5,5]、z∈[-5,5]；offsetCells 让它整体挪半格造成阶梯边界
  const off = offsetCells * dx / 2;
  const scad = `translate([0, ${-5 + off}, ${-5 + off}]) cube([${L}, ${B}, ${H}]);`;
  const stl = (await compileStlOnly(scad)).stl;
  // SDF 采样点是"单元中心" ⇒ 原点挪半格
  const { sdf } = await (async () => {
    const f = await buildSdfFromStl(stl, {
      cells: [nx, ny, nz], dxMm: dx, originMm: [dx / 2, -5 + dx / 2, -5 + dx / 2],
    });
    return { sdf: f };
  })();

  // 节点编号（单元角点）
  const nn = (i, j, k) => i * (ny + 1) * (nz + 1) + j * (nz + 1) + k;
  const solid = [];
  for (let ix = 0; ix < nx; ix++) for (let iy = 0; iy < ny; iy++) for (let iz = 0; iz < nz; iz++) {
    if (sdf.solidMask[ix * ny * nz + iy * nz + iz]) solid.push([ix, iy, iz]);
  }

  // 自由度：固定面 x=0 全约束；其余为自由
  const nodeActive = new Uint8Array((nx + 1) * (ny + 1) * (nz + 1));
  for (const [ix, iy, iz] of solid) {
    for (const [a, b, c] of [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]]) {
      nodeActive[nn(ix + a, iy + b, iz + c)] = 1;
    }
  }
  const isFixed = (i) => i === 0;                       // ix==0 的那层节点
  const dofOf = new Int32Array(nodeActive.length * 3).fill(-1);
  let nFree = 0;
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) for (let k = 0; k <= nz; k++) {
    const nd = nn(i, j, k);
    if (!nodeActive[nd]) continue;
    for (let c = 0; c < 3; c++) if (!isFixed(i)) dofOf[nd * 3 + c] = nFree++;
  }

  const { KE, D } = elementStiffness(dx);

  // 元素 → 24 个全局自由度（固定者为 -1）
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
      fe.fill(0);
      for (let a = 0; a < 24; a++) {
        const row = a * 24; let s = 0;
        for (let b = 0; b < 24; b++) s += KE[row + b] * ue[b];
        fe[a] = s;
      }
      for (let a = 0; a < 24; a++) if (d[a] >= 0) y[d[a]] += fe[a];
    }
    return y;
  };
  const diag = new Float64Array(nFree);
  for (let e = 0; e < elemDofs.length; e++) {
    const d = elemDofs[e];
    for (let a = 0; a < 24; a++) if (d[a] >= 0) diag[d[a]] += KE[a * 24 + a];
  }

  // 载荷：端面（ix=nx）节点均分 F，方向 -y
  const rhs = new Float64Array(nFree);
  const tipNodes = [];
  for (let j = 0; j <= ny; j++) for (let k = 0; k <= nz; k++) {
    const nd = nn(nx, j, k);
    if (nodeActive[nd]) tipNodes.push(nd);
  }
  for (const nd of tipNodes) { const d = dofOf[nd * 3 + 1]; if (d >= 0) rhs[d] += -F / tipNodes.length; }

  // CG（Jacobi 预条件）
  const t0 = performance.now();
  const u = new Float64Array(nFree);
  let r = Float64Array.from(rhs), z = new Float64Array(nFree), p = new Float64Array(nFree);
  for (let i = 0; i < nFree; i++) z[i] = r[i] / diag[i];
  p.set(z);
  let rz = 0; for (let i = 0; i < nFree; i++) rz += r[i] * z[i];
  const norm = (v) => { let t = 0; for (let i = 0; i < v.length; i++) t += v[i] * v[i]; return Math.sqrt(t); };
  const r0 = norm(r) || 1;
  let iter = 0;
  for (; iter < 20000; iter++) {
    const Ap = matvec(p);
    let pAp = 0; for (let i = 0; i < nFree; i++) pAp += p[i] * Ap[i];
    if (!(pAp > 0)) break;
    const alpha = rz / pAp;
    for (let i = 0; i < nFree; i++) { u[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; }
    const rn = norm(r);
    if (rn / r0 < 1e-8) { iter++; break; }
    for (let i = 0; i < nFree; i++) z[i] = r[i] / diag[i];
    let rzNew = 0; for (let i = 0; i < nFree; i++) rzNew += r[i] * z[i];
    const beta = rzNew / rz; rz = rzNew;
    for (let i = 0; i < nFree; i++) p[i] = z[i] + beta * p[i];
  }
  const ms = performance.now() - t0;

  // 端部位移（端面节点的平均 -u_y）
  let delta = 0;
  for (const nd of tipNodes) { const d = dofOf[nd * 3 + 1]; delta += d >= 0 ? -u[d] : 0; }
  delta /= tipNodes.length;

  // 应力恢复：固定端那一列的 Gauss 点 σ_xx ~ y 线性回归，外推到 y=±5
  const samples = [];
  let momentFem = 0, area = 0, volume = 0, I_vox = 0;
  for (let e = 0; e < solid.length; e++) {
    const [ix, iy, iz] = solid[e];
    const d = elemDofs[e];
    const ue = new Float64Array(24);
    for (let a = 0; a < 24; a++) ue[a] = d[a] >= 0 ? u[d[a]] : 0;
    const cellArea = dx * dx;
    volume += dx ** 3;
    // 固定端截面的一次矩（每单元只累加一次；用单元中心 + 自身惯性）
    if (ix === 0) {
      const yC = -5 + dx / 2 + iy * dx;
      area += cellArea;
      I_vox += (yC * yC + dx * dx / 12) * cellArea;
    }
    let sxxSum = 0, gpN = 0;
    for (const gx of GP) for (const gy of GP) for (const gz of GP) {
      gpN++;
      const yc = -5 + dx / 2 + iy * dx + gy * dx / 2;
      const zc = -5 + dx / 2 + iz * dx + gz * dx / 2;
      const B = Array.from({ length: 6 }, () => new Float64Array(24));
      for (let i = 0; i < 8; i++) {
        const dNdX = (XI[i] * (1 + ETA[i] * gy) * (1 + ZETA[i] * gz)) / 8 * (2 / dx);
        const dNdY = (ETA[i] * (1 + XI[i] * gx) * (1 + ZETA[i] * gz)) / 8 * (2 / dx);
        const dNdZ = (ZETA[i] * (1 + XI[i] * gx) * (1 + ETA[i] * gy)) / 8 * (2 / dx);
        const c = 3 * i;
        B[0][c] = dNdX; B[1][c + 1] = dNdY; B[2][c + 2] = dNdZ;
        B[3][c] = dNdY; B[3][c + 1] = dNdX;
        B[4][c + 1] = dNdZ; B[4][c + 2] = dNdY;
        B[5][c] = dNdZ; B[5][c + 2] = dNdX;
      }
      let sxx = 0;
      for (let a = 0; a < 24; a++) sxx += D[0][0] * B[0][a] * ue[a] + D[0][1] * B[1][a] * ue[a] + D[0][2] * B[2][a] * ue[a];
      sxxSum += sxx;
      if (ix <= 1) samples.push([yc, sxx]);
      // 内力矩：∫ σ_xx · y dA（在固定端截面）
    }
    if (ix === 0) momentFem += (sxxSum / gpN) * (-5 + dx / 2 + iy * dx) * cellArea;
  }
  // 按体素化后的实际截面算参考值：把"几何误差"与"方法误差"分开
  const deltaRefVox = (F * L ** 3) / (3 * E * I_vox);
  const yMaxVox = (Math.max(...solid.filter(([i]) => i === 0).map(([, j]) => j)) + 1) * dx - 5;
  const sigmaRefVox = (MOMENT_REF * yMaxVox) / I_vox;
  // 线性回归 σ_xx = a + b y
  const n = samples.length;
  let sy = 0, sxx_ = 0, syy = 0, sxy = 0;
  for (const [y, s] of samples) { sy += y; sxx_ += s; syy += y * y; sxy += y * s; }
  const b = (n * sxy - sy * sxx_) / (n * syy - sy * sy);
  const a = (sxx_ - b * sy) / n;
  const sigmaSurface = Math.abs(a + b * 5);

  return { label, dx, nx, ny, nz, elements: solid.length, free: nFree, iter, ms,
           delta, sigmaSurface, momentFem, volume, I_vox, yMaxVox, deltaRefVox, sigmaRefVox,
           deltaRef: DELTA_REF, sigmaRef: SIGMA_REF, momentRef: MOMENT_REF };
}

// ---------- 跑 ----------
console.log(`梁理论参考：δ = ${DELTA_REF.toFixed(4)} mm · σ_max = ${SIGMA_REF.toFixed(2)} MPa · M = ${MOMENT_REF} N·mm\n`);
const rows = [];
for (const dx of [2.5, 1.25, 0.625]) rows.push(await runCase(dx, 0));
rows.push(await runCase(1.25, 1, '阶梯（半格偏移）'));

console.log('算例                单元数   自由DOF   CG迭代   耗时s   δ(mm)  δvs理想  δvs体素   σ(MPa) σvs理想 σvs体素   M误差  体积比  I体素/理想');
for (const r of rows) {
  const f = (x) => `${x >= 0 ? ' ' : ''}${x.toFixed(1).padStart(5)}%`;
  console.log(
    `${r.label || `dx=${r.dx}mm`.padEnd(18)}`.padEnd(19)
    + `${String(r.elements).padStart(7)} ${String(r.free).padStart(8)} ${String(r.iter).padStart(7)} ${(r.ms / 1000).toFixed(1).padStart(6)}`
    + `  ${r.delta.toFixed(4)} ${f(100 * (r.delta - r.deltaRef) / r.deltaRef)} ${f(100 * (r.delta - r.deltaRefVox) / r.deltaRefVox)}`
    + `  ${r.sigmaSurface.toFixed(2).padStart(6)} ${f(100 * (r.sigmaSurface - r.sigmaRef) / r.sigmaRef)} ${f(100 * (r.sigmaSurface - r.sigmaRefVox) / r.sigmaRefVox)}`
    + `  ${f(100 * (r.momentFem - r.momentRef) / r.momentRef)}`
    + `  ${(r.volume / (L * B * H)).toFixed(3)}  ${(r.I_vox / (B * H ** 3 / 12)).toFixed(3)}`);
}
writeFileSync(new URL('./probe-cantilever-fem.json', import.meta.url), JSON.stringify({ refs: { DELTA_REF, SIGMA_REF, MOMENT_REF }, rows }, null, 2));
console.log('\n→ scripts/probe-cantilever-fem.json');
