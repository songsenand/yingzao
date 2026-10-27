#!/usr/bin/env python3
"""六元环的闭合公差预算（蒙特卡洛）。

问的问题：**打印出来的**六元环还能闭合吗？
CAD 里环是精确的（键长全等、角全四面体，残差 0），但打印件有误差：
  * 每个 socket 的方向相对 CAD 有 σ_ang 的角度误差（球体打印变形 + 孔的椭圆化）；
  * 每根棍的台肩面间距有 σ_len 的误差（打印 + 落座重复性）。

做法：把环当成 "socket 方向 + 棍长" 的 6 步串联链。理想情况走 6 步回到起点（闭合）。
把 σ_ang、σ_len 抽成随机量，看走完一圈后**回到起点差多少** —— 这个残差必须由 6 个关节的
间隙吸收，否则最后一个接头插不进去。

间隙预算（每个关节）：
  * 径向 0.20 mm 直径间隙 → 单边 0.10 mm
  * 轴向：台肩面落座，卡珠留 0.03 mm 推入余隙
6 个关节合计可吸收 ≈ 6 × 0.10 = 0.6 mm 的径向残差（保守取最不利方向同向叠加）。

运行：/home/songsenand/.dsh/cad/runtime/venv/bin/python spec/tolerance_ring.py
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
MOL = json.loads((HERE / "molecule.json").read_text(encoding="utf-8"))

SEED = 20261027
N = 20000
SIGMA_ANG_DEG = 0.5      # 声明：球体 socket 轴的角度误差（未实测，按 FDM 球 Ø12–17 估）
SIGMA_LEN_MM = 0.05      # 声明：棍长/落座重复性（FDM 尺寸 ±0.1 → 取 1σ=0.05）
JOINT_RADIAL_PLAY_MM = 0.10
JOINTS_IN_RING = 6


def ring_atoms() -> list[str]:
    return ["O5", "C1", "C2", "C3", "C4", "C5"]


def main() -> None:
    atoms = {a["id"]: a for a in MOL["atoms"]}
    order = ring_atoms()
    # 环上每条键：(i, j, 理想方向 u, 理想长度)
    bonds = []
    for k in range(6):
        a, b = order[k], order[(k + 1) % 6]
        pa, pb = np.array(atoms[a]["pos"]), np.array(atoms[b]["pos"])
        u = (pb - pa) / np.linalg.norm(pb - pa)
        bonds.append((a, b, u, float(np.linalg.norm(pb - pa))))
    assert abs(sum(b[3] for b in bonds) - 6 * 22.0) < 1e-9

    rng = np.random.default_rng(SEED)
    # 每步：绕某个随机横轴偏转 σ_ang，长度加 σ_len
    sig = math.radians(SIGMA_ANG_DEG)
    resid = np.zeros(N)
    for t in range(N):
        p = np.zeros(3)
        for a, b, u, L in bonds:
            axis = rng.normal(size=3)
            axis /= np.linalg.norm(axis)
            ang = rng.normal(0.0, sig)
            # Rodrigues 转 u
            K = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
            R = np.eye(3) + math.sin(ang) * K + (1 - math.cos(ang)) * (K @ K)
            step = L + rng.normal(0.0, SIGMA_LEN_MM)
            p = p + step * (R @ u)
        resid[t] = np.linalg.norm(p)

    budget = JOINTS_IN_RING * JOINT_RADIAL_PLAY_MM
    q = {f"P{p_}": round(float(np.percentile(resid, p_)), 3) for p_ in (50, 90, 95, 99)}
    out = {
        "seed": SEED, "trials": N,
        "assumptions": {"sigma_ang_deg": SIGMA_ANG_DEG, "sigma_len_mm": SIGMA_LEN_MM,
                        "joint_radial_play_mm": JOINT_RADIAL_PLAY_MM,
                        "joints_in_ring": JOINTS_IN_RING},
        "closure_residual_mm": q,
        "closure_residual_max_mm": round(float(resid.max()), 3),
        "closable_budget_mm": budget,
        "P_residual_le_budget": round(float((resid <= budget).mean()), 4),
        "P_residual_le_2x_budget": round(float((resid <= 2 * budget).mean()), 4),
        "cad_closure_residual_mm": MOL["ring_closure_residual_mm"],
    }
    (HERE / "tolerance_ring.json").write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
