"""探针 3 修正版 + 估计子对比：把加载端从报告里排除，测真正的圆角，比几个估计子。

第一版（probe-fillet-kt.py）有一个归因错误：受拉件的载荷加在整个端面上，而端面与侧面
的交角本身就是一个应力集中点；体素化又把它变成阶梯。于是"全场最大"落在加载端角
（实测 atMm x≈7.95 = 窄端自由端 x=8），**不是圆角**（圆角在 x≈0.8）。所以那组
"Kt_boundaryMax 随 dx 涨、与 r 无关"的数虽然真实，但它测的是加载端的网格伪影。

修正：`excludeFromReport` 把加载端一个球（半径 3mm，覆盖 x>5）排除掉，再取圆角附近的
区域；然后比四个估计子在这条深度路径上的**跨分辨率稳定性**——这才是"该报什么"的判据：

  E0 边界最大值（被禁的那个）           —— 对照
  E1 线性外推到 d=0（悬臂梁上验证过的）
  E2 固定物理距离读数 σ(d=d_c)          —— d_c = 0.1/0.2/0.3/0.4 mm
  E3 幂律 σ(d) = A·(d)^(-p) + B 的 A,B,p（log-log 拟合）

    python scripts/probe-fillet-estimators.py [--quick]
"""

import importlib.util
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "python", "cad_worker"))

import numpy as np  # noqa: E402

import stress_fem  # noqa: E402

# 复用第一版的几何（它是干净的：已验 watertight）
spec = importlib.util.spec_from_file_location("pf", os.path.join(HERE, "probe-fillet-kt.py"))
pf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pf)

D_C = [0.1, 0.2, 0.3, 0.4]  # 固定物理采样距离 mm
EXCLUDE_END_R = 3.0          # 加载端排除球半径 mm


def fillet_region(res):
    """圆角附近的区域：取 atMm[0] 最小（最靠近 x≈0 的台阶）且峰值最高的那个。"""
    cands = [g for g in res["regions"] if g["surfaceExtrapolatedMPa"] is not None or g["pathSamples"] > 0]
    if not cands:
        cands = res["regions"]
    if not cands:
        return None
    return min(cands, key=lambda g: (g["atMm"][0], -g["peakVonMisesMPa"]))


def estimate(path_d, path_v, sigma_nom):
    out = {}
    d = np.asarray(path_d, dtype=float)
    v = np.asarray(path_v, dtype=float)
    if d.size >= 2:
        # E1 线性外推到 0
        slope, intercept = np.polyfit(d, v, 1)
        pred = slope * d + intercept
        ss_tot = float(((v - v.mean()) ** 2).sum())
        out["E1_linear"] = float(intercept)
        out["E1_R2"] = float(1 - ((v - pred) ** 2).sum() / ss_tot) if ss_tot > 0 else 0.0
        # E2 固定物理距离（线性插值，外插到最近点之外时用最近点）
        out["E2"] = {f"{dc}": float(np.interp(dc, d, v)) for dc in D_C}
        # E3 幂律 + 常数项：拟合 v = A d^-p + B（先减掉远端 B 的估计 = 最深两点均值）
        far = float(v[-2:].mean()) if d.size >= 2 else float(v[-1])
        y = v - far
        ok = (y > 0) & (d > 0)
        if ok.sum() >= 3:
            p_slope, p_int = np.polyfit(np.log(d[ok]), np.log(y[ok]), 1)
            out["E3_p"] = float(-p_slope)
            out["E3_farfield"] = far
    out["farfield"] = float(v[-1])
    out["ratio_boundary"] = float(v[0]) / sigma_nom
    return out


def run(radius, dx):
    mesh = pf.make_specimen(radius)
    path = os.path.join(HERE, "..", ".tmp-stress", f"est-r{radius}-dx{dx}.stl")
    mesh.export(path)
    res = stress_fem.run(
        {
            "path": path,
            "dxMm": dx,
            "youngModulusMPa": 3500.0,
            "poissonRatio": 0.35,
            "yieldMPa": 25.0,
            "fixedFaces": [{"axis": "x", "side": "min"}],
            "loads": [{"face": {"axis": "x", "side": "max"}, "forceN": [pf.F, 0, 0]}],
            "excludeFromReport": [{"atMm": [pf.L_NARROW, 0.0, 0.0], "radiusMm": EXCLUDE_END_R}],
            "criticalDistanceMm": 0.2,
            "runConvergence": False,
        }
    )
    g = fillet_region(res)
    est = estimate(g["pathDepthMm"], g["pathVonMisesMPa"], pf.SIGMA_NOM) if g else {}
    return {
        "radiusMm": radius,
        "dxMm": dx,
        "rOverDx": radius / dx,
        "solidCells": res["solidCells"],
        "excludedCells": res["excludedCells"],
        "regionAtMm": None if not g else g["atMm"],
        "regionPeakMPa": None if not g else g["peakVonMisesMPa"],
        "regionThkCells": None if not g else g["localThicknessCells"],
        "regionR2": None if not g else g["fitR2"],
        "trustworthy": None if not g else g["trustworthy"],
        "boundaryMaxMPa": res["maxVonMisesBoundaryMPa"],
        "pathD": None if not g else g["pathDepthMm"],
        "pathV": None if not g else g["pathVonMisesMPa"],
        "est": est,
        "equilibriumErrorPct": res["equilibriumErrorPct"],
        "energyBalancePct": res["energyBalancePct"],
    }


def main() -> int:
    quick = "--quick" in sys.argv
    combos = [(0.8, 4), (0.8, 8), (0.8, 16)] if quick else [
        (0.8, 4), (0.8, 8), (0.8, 16), (0.4, 4), (0.4, 8), (0.16, 4),
    ]
    rows = []
    print(f"σ_nom={pf.SIGMA_NOM} MPa；加载端排除球 r={EXCLUDE_END_R}mm；固定采样距离 {D_C} mm")
    for r, lv in combos:
        row = run(r, r / lv)
        rows.append(row)
        e = row["est"]
        print(
            f"\nr={r:>4} r/dx={lv:>2} dx={row['dxMm']:.3f} cells={row['solidCells']:>7} "
            f"excluded={row['excludedCells']:>6}  区域@x={None if not row['regionAtMm'] else round(row['regionAtMm'][0],2)} "
            f"peak={None if not row['regionPeakMPa'] else round(row['regionPeakMPa'],2)}MPa "
            f"thk={row['regionThkCells']} R²={row['regionR2']} trustworthy={row['trustworthy']}"
        )
        if row["pathD"]:
            print(f"   路径 d(mm)={[round(x,3) for x in row['pathD']]}")
            print(f"   路径 σ(MPa)={[round(x,3) for x in row['pathV']]}")
        if e:
            print(
                f"   E1线性外推={e.get('E1_linear', float('nan')):.3f} (R²={e.get('E1_R2', 0):.3f})  "
                + "  ".join(f"E2@{k}={v:.3f}" for k, v in e.get("E2", {}).items())
                + f"  E3: p={e.get('E3_p')} far={e.get('E3_farfield'):.3f}  "
                f"边界最大/σ_nom={e['ratio_boundary']:.3f}"
            )
    with open(os.path.join(HERE, "..", ".tmp-stress", "probe-fillet-estimators.json"), "w", encoding="utf-8") as h:
        json.dump(rows, h, indent=1)

    print("\n=== 跨分辨率稳定性（同一 r 下，最细两档相对差 %）===")
    for r in dict.fromkeys(r for r, _ in combos):
        series = sorted({x["dxMm"]: x for x in rows if x["radiusMm"] == r}.values(), key=lambda x: x["dxMm"])
        if len(series) < 2:
            continue
        # series 按 dx 升序 ⇒ 最细两档是 [0] 和 [1]（第一版取 [-2:]，比的是最粗两档）
        a, b = series[1], series[0]
        def rel(k):
            va, vb = a["est"].get(k), b["est"].get(k)
            return None if not isinstance(va, (int, float)) or not isinstance(vb, (int, float)) else 100 * abs(vb - va) / abs(va)
        parts = [f"r/dx {a['rOverDx']}→{b['rOverDx']}:"]
        for label, k in (("E0边界最大", "ratio_boundary"), ("E1线性", "E1_linear"), ("E3_p", "E3_p")):
            v = rel(k)
            parts.append(f"{label} {v:+.1f}%" if v is not None else f"{label} —")
        for dc in D_C:
            va = a["est"].get("E2", {}).get(f"{dc}")
            vb = b["est"].get("E2", {}).get(f"{dc}")
            if va and vb:
                parts.append(f"E2@{dc}mm {100 * abs(vb - va) / va:+.1f}%")
        print("  " + "  ".join(parts))
    return 0


if __name__ == "__main__":
    sys.exit(main())
