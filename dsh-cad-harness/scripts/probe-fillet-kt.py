"""探针 3（2026-10-08 报告里列了但从没跑）：带圆角的台阶试件，圆角处会不会收敛？

问的不是"我们的 Kt 和手册差多少"，而是 10-08 那个判据本身：
  * "取最大单元应力"在圆角这种**凸/圆滑**边界上，是否像圆孔那样随加密发散？
  * 我们报的量（声明深度采样 + 沿深度外推的表面应力）在 r/dx = 4 / 8 / 16 下是否停住？
  * 停住需要多少 r/dx——即"局部细化到底要不要做、要做几级"。

不需要外部 Kt 表：收敛性是可自证的判据（加密后读数不再移动）。
名义应力按净截面 σ_nom = F/(t·d)（Peterson 对受拉台阶件的口径），报的是"表观 Kt"。

    python scripts/probe-fillet-kt.py            # 全部
    python scripts/probe-fillet-kt.py --quick    # 只跑最便宜的几档
"""

import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "python", "cad_worker"))

import numpy as np  # noqa: E402
import trimesh  # noqa: E402
from shapely.geometry import Polygon  # noqa: E402

import stress_fem  # noqa: E402

# ---- 试件（线弹性无重力 ⇒ 尺度无关，用小件把 r/dx 做上去）-------------------
# 线弹性、无重力 ⇒ 力学与尺度无关（σ 不随尺寸变、δ 与尺寸成正比），所以试件取小：
# 保持所有比值（D/d、r/d、r/dx）不变而把格数降 ~15 倍，才可能把 r/dx 做到 16。
D_WIDE = 6.4      # 宽端高
D_NARROW = 3.2    # 窄端高（净截面）
THICK = 1.2       # 厚度
L_WIDE = 4.0      # 宽端长
L_NARROW = 8.0    # 窄端长
SIGMA_NOM = 10.0  # MPa
F = SIGMA_NOM * THICK * D_NARROW  # 240 N


def fillet_profile(radius: float, steps: int = 24) -> Polygon:
    """上下对称的台阶件，两处再入角(270°)用半径 r 的圆弧填实（即肩部圆角）。"""
    d, D = D_NARROW / 2.0, D_WIDE / 2.0
    # 两处再入角(270°)填成肩部圆角。弧的扫描方向是关键：圆心在 (r, ±(d+r))，
    # 下侧从 (0,-(d+r)) [角度 π] 扫到 (r,-d) [角度 π/2]，上侧从 (r,d) [角度 -π/2]
    # 扫到 (0,d+r) [角度 -π]。方向反了弧就跑到材料外面，挤出体不闭合
    # （第一版就是这个 bug：euler=4、watertight=false）。
    steps_n = 24
    pts = [(-L_WIDE, -D), (0.0, -D)]
    for i in range(steps_n + 1):
        a = math.pi - (math.pi / 2.0) * (i / steps_n)
        pts.append((radius + radius * math.cos(a), -(d + radius) + radius * math.sin(a)))
    pts += [(L_NARROW, -d), (L_NARROW, d)]
    for i in range(steps_n + 1):
        a = -math.pi / 2.0 - (math.pi / 2.0) * (i / steps_n)
        pts.append((radius + radius * math.cos(a), (d + radius) + radius * math.sin(a)))
    pts += [(0.0, D), (-L_WIDE, D)]
    return Polygon(pts)


def make_specimen(radius: float) -> trimesh.Trimesh:
    poly = fillet_profile(radius)
    if not poly.is_valid:
        poly = poly.buffer(0)
    mesh = trimesh.creation.extrude_polygon(poly, height=THICK)
    mesh.apply_translation([0, 0, -THICK / 2.0])
    return mesh


def solve(radius: float, dx: float, tag: str):
    mesh = make_specimen(radius)
    path = os.path.join(HERE, "..", ".tmp-stress", f"fillet-r{radius}-dx{dx}.stl")
    mesh.export(path)
    t0 = time.time()
    res = stress_fem.run(
        {
            "path": path,
            "dxMm": dx,
            "youngModulusMPa": 3500.0,
            "poissonRatio": 0.35,
            "yieldMPa": 25.0,
            # 受拉：宽端固定，窄端面拉 +x
            "fixedFaces": [{"axis": "x", "side": "min"}],
            "loads": [{"face": {"axis": "x", "side": "max"}, "forceN": [F, 0, 0]}],
            "probeAtMm": [L_NARROW, 0, 0],
            "runConvergence": False,
        }
    )
    dt = time.time() - t0
    ext = [r["surfaceExtrapolatedMPa"] for r in res["regions"] if r["trustworthy"] and r["surfaceExtrapolatedMPa"]]
    r2 = [r["fitR2"] for r in res["regions"] if r["trustworthy"] and r["fitR2"]]
    thick = [r["localThicknessCells"] for r in res["regions"] if r["trustworthy"]]
    at = [r["atMm"] for r in res["regions"] if r["trustworthy"]]
    return {
        "tag": tag,
        "radiusMm": radius,
        "dxMm": dx,
        "rOverDx": radius / dx,
        "watertight": bool(mesh.is_watertight),
        "solidCells": res["solidCells"],
        "freeDof": res["freeDof"],
        "seconds": round(dt, 1),
        "sigmaNomMPa": SIGMA_NOM,
        "ktBoundaryMax": res["maxVonMisesBoundaryMPa"] / SIGMA_NOM,
        "ktDeclaredDepth": res["peakDeclaredDepthMPa"] / SIGMA_NOM,
        "ktExtrapolated": (max(ext) / SIGMA_NOM) if ext else None,
        "fitR2": max(r2) if r2 else None,
        "localThicknessCells": max(thick) if thick else None,
        "trustworthyRegions": res["regionsTrustworthy"],
        "regions": len(res["regions"]),
        "hotspotAtMm": at[:2],
        "equilibriumErrorPct": res["equilibriumErrorPct"],
        "energyBalancePct": res["energyBalancePct"],
    }


def main() -> int:
    quick = "--quick" in sys.argv
    # r/d = 0.25 / 0.125 / 0.05 三档圆角锐度；r/dx 是"圆角半径有几个单元"。
    radii = [0.8, 0.4] if quick else [0.8, 0.4, 0.16]
    levels = [4, 8] if quick else [4, 8, 16]
    # 细小圆角要拿到同样的 r/dx 就得整体加密，格数是 (1/r)^3 级别，所以按半径收窄档位。
    cap_cells = 2_000_000
    def affordable(r: float, lv: int) -> bool:
        dx = r / lv
        n = 1
        for size in (L_WIDE + L_NARROW, D_WIDE, THICK):
            n *= int(size / dx) + 2
        return n <= cap_cells
    radii_levels = [(r, lv) for r in radii for lv in levels if affordable(r, lv)]
    print(f"可跑的 (r, r/dx) 组合：{radii_levels}（上限 {cap_cells/1e6:.0f}M 包围盒格）")
    rows = []
    print(f"试件 {L_WIDE + L_NARROW}x{D_WIDE}x{THICK} mm，净截面 {D_NARROW}mm，σ_nom={SIGMA_NOM}MPa（F={F:.0f}N）")
    for r, lv in radii_levels:
            row = solve(r, r / lv, f"r={r} r/dx={lv}")
            rows.append(row)
            print(
                f"  r={r:>4}mm r/dx={lv:>2}  dx={row['dxMm']:.4f}  cells={row['solidCells']:>7} "
                f"({row['seconds']:>6}s)  Kt_boundaryMax={row['ktBoundaryMax']:>6.3f}  "
                f"Kt_declared={row['ktDeclaredDepth']:>6.3f}  Kt_extrap={row['ktExtrapolated']}  "
                f"R²={row['fitR2']}  thkCells={row['localThicknessCells']}",
                flush=True,
            )
    out = os.path.join(HERE, "..", ".tmp-stress", "probe-fillet-kt.json")
    with open(out, "w", encoding="utf-8") as handle:
        json.dump({"sigmaNomMPa": SIGMA_NOM, "specimen": {"D": D_WIDE, "d": D_NARROW, "t": THICK}, "rows": rows}, handle, indent=1)
    print(f"\n→ {out}")

    # 收敛性判定：同一半径下，最细两档的 Kt 差多少
    print("\n收敛性（同一 r，最细两档之比）：")
    for r in radii:
        series = [x for x in rows if x["radiusMm"] == r]
        series.sort(key=lambda x: x["dxMm"])
        fine = [x for x in series if x["ktExtrapolated"]]
        if len(fine) >= 2:
            a, b = fine[-2], fine[-1]
            d = 100 * abs(b["ktExtrapolated"] - a["ktExtrapolated"]) / a["ktExtrapolated"]
            print(f"  r={r}mm: r/dx {a['rOverDx']}→{b['rOverDx']}, Kt_extrap {a['ktExtrapolated']:.3f}→{b['ktExtrapolated']:.3f} ({d:+.1f}%)")
        bmax = [x["ktBoundaryMax"] for x in series]
        if len(bmax) >= 2:
            d = 100 * (bmax[-1] - bmax[-2]) / bmax[-2]
            print(f"           Kt_boundaryMax {bmax[-2]:.3f}→{bmax[-1]:.3f} ({d:+.1f}%)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
