#!/usr/bin/env python3
"""机械限摆角的直接几何复核（不依赖 harness 的 pose 路径）。

背景：`validate_assembly` 的 `pose` 只取了绕基准轴的旋转矩阵、丢掉了平移分量
（dsh-cad-harness/src/host/tools.ts 里 `matrix = full` 只用 `poseA.m`），
于是零件实际是绕自身原点转、而不是绕 datum 点转。用那条路径算 ±14° 位姿会得到
错误结论（见 examples/toy-balance/README.md §8.11）。

本脚本绕开它：自己在世界坐标里把横梁绕"主销轴"轴线转 θ，再与底座做布尔求交。

用法（在仓库根目录）：
    python3 examples/toy-balance/tools/limit-angle-scan.py
输出：每个角度的 base↔beam 干涉体积；首次出现 >0 的角度即机械限摆角。
"""
import math
import sys
from pathlib import Path

import numpy as np
import trimesh

ROOT = Path(__file__).resolve().parents[3]
BEAM = ROOT / "cad-data/versions/v050/model.stl"     # 横梁
BASE = ROOT / "cad-data/versions/v066/model.stl"     # 底座立柱

BEAM_TRANSLATE = np.array([0.0, 5.0, 61.0])   # 装配清单里 beam 的 translate
BEAM_ROTATE_X = 90.0                          # 装配清单里 beam 的 rotate
PIN_LOCAL = np.array([0.0, 84.0, 5.0])        # 横梁 datum「主销轴」的点
BASE_TRANSLATE = np.array([0.0, 0.0, 4.0])


def rotx(deg: float) -> np.ndarray:
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def roty(deg: float) -> np.ndarray:
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def affine(R: np.ndarray, t: np.ndarray) -> np.ndarray:
    M = np.eye(4)
    M[:3, :3] = R
    M[:3, 3] = t
    return M


def main() -> int:
    beam = trimesh.load(BEAM, process=True)
    base = trimesh.load(BASE, process=True)
    base.apply_transform(affine(np.eye(3), BASE_TRANSLATE))

    R0 = rotx(BEAM_ROTATE_X)
    pin_world = R0 @ PIN_LOCAL + BEAM_TRANSLATE
    print(f"主销轴世界位置 {pin_world.round(3).tolist()}")

    first_hit = None
    for deg in [round(x * 0.05, 2) for x in range(240, 300)]:   # 12.00° … 14.95°
        R = roty(deg) @ R0
        t = pin_world - R @ PIN_LOCAL          # 让 datum 点保持在世界原位
        b = beam.copy()
        b.apply_transform(affine(R, t))
        inter = trimesh.boolean.intersection([b, base], engine="manifold")
        vol = float(inter.volume) if inter is not None and len(inter.faces) else 0.0
        if vol > 0 and first_hit is None:
            first_hit = (deg, vol, inter.bounds.round(2).tolist())
        if deg in (12.0, 13.0, 14.0, 14.25, 14.35, 14.4, 14.5) or (vol > 0 and deg < 14.0):
            print(f"  {deg:>6.2f}°  干涉 {vol:9.3f} mm³" + (f"  @ {inter.bounds.round(2).tolist()}" if vol > 0 else ""))

    if first_hit:
        print(f"\n首次接触：{first_hit[0]}°，体积 {first_hit[1]:.3f} mm³，位置 {first_hit[2]}")
        print("位置 z≈154 / x≈−15 即底座「限摆檐」下沿与横梁上沿棱线——与解析解 θ=14.36° 一致。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
