#!/usr/bin/env python
"""拔模可行抽芯方向锥探针（S3）。

验证 op_check_printability 的 draft 块在**已知答案**的用例上是否正确，并把两个
**被撤回的设计**作为阴性对照跑出来：
  变体 A（26 方向搜索）：对零拔模立方体报 0 mm² 违规 —— 同义反复；
  变体 B（只查成对矛盾）：对 δ=45° 的立方体报 0 对矛盾 —— 但锥确实是空的。

运行：
    ~/.dsh/cad/runtime/venv/bin/python experiments/scripts/probe_draft_cone.py
"""
import math
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'dsh-cad-harness', 'python'))
import numpy as np                                            # noqa: E402
import trimesh                                                # noqa: E402
from cad_worker import worker                                 # noqa: E402


def cube_path(size=20.0):
    path = tempfile.mktemp(suffix='.stl')
    trimesh.creation.box(extents=[size, size, size]).export(path)
    return path


def variant_a_26_directions(normals, areas, delta_deg):
    """被撤回的设计 1：在 26 个候选方向里取违规面积最小者。"""
    dirs = []
    for dx in (-1.0, 0.0, 1.0):
        for dy in (-1.0, 0.0, 1.0):
            for dz in (-1.0, 0.0, 1.0):
                if dx or dy or dz:
                    v = np.array([dx, dy, dz], dtype=float)
                    dirs.append(v / np.linalg.norm(v))
    limit = math.radians(90.0 - delta_deg)
    best = None
    for d in dirs:
        phi = np.arccos(np.clip(np.abs(normals @ d), 0.0, 1.0))
        area = float(np.sum(areas[phi > limit + 1e-9]))
        if best is None or area < best:
            best = area
    return best


def variant_b_pairwise(normals, delta_deg):
    """被撤回的设计 2：只查成对矛盾（充分但不完备）。"""
    rho = 90.0 - delta_deg
    dot = np.clip(normals @ normals.T, -1.0, 1.0)
    acute = np.degrees(np.arccos(np.abs(dot)))
    bad = np.triu(acute > 2.0 * rho + 1e-9, k=1)
    return int(bad.sum())


def main():
    path = cube_path()
    try:
        mesh = trimesh.load(path, process=True)
        normals = np.asarray(mesh.face_normals, dtype=float)
        areas = np.asarray(mesh.area_faces, dtype=float)
        # 合并同朝向（与 worker 内部一致：~0.3° 分桶）
        key = np.round(normals * 200.0).astype(np.int32)
        _uniq, inv = np.unique(key, axis=0, return_inverse=True)
        nf = int(inv.max()) + 1
        acc = np.zeros((nf, 3))
        area_f = np.zeros(nf)
        np.add.at(area_f, inv, areas)
        np.add.at(acc, inv, normals * areas[:, None])
        dirs_f = acc / np.linalg.norm(acc, axis=1, keepdims=True)

        print("立方体 20³，朝向数 k=%d\n" % nf)
        print("%-8s %8s %9s %11s %11s %12s %12s" % (
            "δ", "锥空", "候选数", "采样可行%", "采样余量°", "最差面拔模°", "成对矛盾数"))
        print("-" * 78)
        for delta in (1.0, 45.0, 50.0):
            dr = worker.op_check_printability({"path": path, "samples": 300, "draftMinDeg": delta})["draft"]
            print("%-8s %8s %9d %11.2f %11.2f %12.2f %12d" % (
                "%.1f°" % delta, dr["coneEmpty"], dr["candidatesChecked"], dr["feasiblePct"],
                dr["bestMarginDeg"], dr["bestWorstDraftDeg"],
                variant_b_pairwise(dirs_f, delta)))
        print("\n真值：δ<45° 锥非空；δ≥45° 锥为空（三面联合：|d·x|²+|d·y|²+|d·z|² ≥ 1.5 > 1）")

        print("\n阴性对照（两个被撤回的设计在 δ=45° 上的表现）")
        print("-" * 78)
        print("变体 A（26 方向搜索）在 δ=1° 的零拔模立方体上：违规面积 = %.3f mm²（应为 0 才对，"
              "但它报 0 是**同义反复**：总有一个候选方向与每个面平行）"
              % variant_a_26_directions(dirs_f, area_f, 1.0))
        print("变体 B（只查成对）在 δ=45° 上：矛盾对 = %d（真值是锥为空，但成对永远抓不到）"
              % variant_b_pairwise(dirs_f, 45.0))
    finally:
        os.unlink(path)


if __name__ == "__main__":
    main()
