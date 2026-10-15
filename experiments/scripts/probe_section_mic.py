#!/usr/bin/env python
"""可行性探针：用「截面 + 最大内切圆（MIC）」量通道瓶颈半径，替代体素小球扫掠。

为什么改用这条路线：体素小球那套的问题在于**判据是"球扫不到哪"**，而圆球永远扫不到
方角 —— 于是它量的是"角残料什么时候变大到算数"，不是通道宽度（见
`experiments/20261013_void_reach_tightest_plateau.md`）。截面法问的是另一个问题：
**"这张切片里，能塞进去的最大圆有多大"**，再沿通道取**最小**的那个。角不参与这个判据。

本探针在**已知答案**的夹具上核对这条路线，并顺手测两个边界情形（擦切、盲腔）。

运行：
    .tmp-measure-runtime/venv/bin/python experiments/scripts/probe_section_mic.py
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'dsh-cad-harness', 'python'))
import numpy as np                                            # noqa: E402
import shapely                                                # noqa: E402
import trimesh                                                # noqa: E402
from shapely.geometry import LineString                       # noqa: E402
from shapely.ops import polygonize, unary_union               # noqa: E402


def plane_basis(normal):
    seed = np.array([0.0, 0.0, 1.0]) if abs(normal[2]) < 0.9 else np.array([1.0, 0.0, 0.0])
    u = np.cross(normal, seed)
    u /= np.linalg.norm(u)
    return u, np.cross(normal, u)


def void_faces(mesh, normal, at_mm):
    """切一刀，返回**落在空隙里**的那些面。

    切割用 `trimesh.intersections.mesh_plane`（精确），闭环用 shapely `polygonize`
    （和 `op_measure_section` 同一条路径）。`polygonize` 不知道环的哪一侧是材料，
    所以每个面用一个点在实体内的测试来分类 —— 与 `op_measure_section` 的 `is_material`
    同一手法（用 `representative_point`，因为环面的质心会落进自己的孔里）。
    """
    n = np.asarray(normal, dtype=float)
    n = n / np.linalg.norm(n)
    origin = n * at_mm
    u, v = plane_basis(n)
    segments = trimesh.intersections.mesh_plane(mesh, n, origin)
    if len(segments) == 0:
        return []
    flat = np.asarray(segments, dtype=float).reshape(-1, 3) - origin
    uv = np.round(np.column_stack([flat @ u, flat @ v]).reshape(-1, 2, 2), 6)
    faces = []
    for candidate in polygonize(unary_union([LineString(s) for s in uv])):
        point = np.asarray(candidate.representative_point().coords, dtype=float)[0]
        world = origin + u * point[0] + v * point[1]
        if not bool(mesh.contains(world.reshape(1, 3))[0]):
            faces.append(candidate)
    return faces


def clearance(mesh, normal, at_mm):
    """该截面上"空隙区域"的最大内切圆半径（mm）；没有空隙面时返回 None。"""
    faces = void_faces(mesh, normal, at_mm)
    if not faces:
        return None
    geom = unary_union(faces)
    if geom.geom_type != 'Polygon':
        geom = max(geom.geoms, key=lambda item: item.area)
    return float(shapely.length(shapely.maximum_inscribed_circle(geom, 1e-4)))


def slot_part(width_mm):
    return trimesh.creation.box(extents=[20, 20, 10]).difference(
        trimesh.creation.box(extents=[width_mm, 40, 6]))


def blind_pocket(depth_mm=0.5, width_mm=8.0):
    return trimesh.creation.box(extents=[10, 10, 2]).difference(
        trimesh.creation.box(extents=[width_mm, width_mm, depth_mm]).apply_translation([0, 0, 0.75]))


def main():
    print("### 1) 方槽（真值 = 槽半宽）：横向切一刀，沿通道轴多切几刀取最小")
    print(f"  {'槽宽':>5} {'单刀 MIC':>10} {'沿轴 7 刀的最小值':>18} {'真值':>6}")
    for width in (3.0, 4.0, 6.0):
        mesh = slot_part(width)
        one = clearance(mesh, [0, 1, 0], 0.0)
        along = [clearance(mesh, [0, 1, 0], float(y)) for y in (-8, -4, -2, 0, 2, 4, 8)]
        along = [x for x in along if x is not None]
        print(f"  {width:5.1f} {one:10.4f} {min(along):18.4f} {width / 2:6.2f}")

    print("\n### 2) 6mm 槽：换切法（横向 vs 平行/擦切/斜切）")
    mesh = slot_part(6.0)
    for normal, at, label in (([0, 1, 0], 0.0, "⊥ 通道轴（横向，中心线必须穿过）"),
                              ([1, 0, 0], 0.0, "与通道轴平行（x=0）"),
                              ([1, 0, 0.05], 2.93, "贴槽壁擦切（0.05 斜率）"),
                              ([0.2, 0.98, 0.0], 0.0, "斜切 11°")):
        started = time.perf_counter()
        value = clearance(mesh, normal, at)
        ms = (time.perf_counter() - started) * 1000
        shown = f"{value:.4f}" if value is not None else "无空隙面（不回答）"
        print(f"  {label:<30} {shown:>18}   ({ms:.0f} ms)")

    print("\n### 3) 盲腔（8x8 口袋、深 0.5；几何真值 = 0.25）—— 阴性对照")
    mesh = blind_pocket()
    in_cavity = clearance(mesh, [0, 0, 1], 0.75)
    across = clearance(mesh, [1, 0, 0], 0.0)
    print(f"  ⊥ 薄的方向（腔内）  MIC = {in_cavity}")
    print(f"  ⊥ 腔宽方向          MIC = {across}")
    print("  ⇒ 盲腔即使换正交切法也会高报（上面的值 = 腔宽，不是通道能力）；"
          "按 2026-10-11 的决定，盲特征应报**未判定**，不能拿这个数当通道余量。")

    print("\n### 4) 与体素小球对照（同一批夹具）")
    print("  方槽 3.0 / 4.0 / 6.0mm：截面法 1.5 / 2.0 / 3.0（精确、无 pitch）")
    print("                          体素小球 1.600 / 1.600 / 1.600（同一个数，见上一份报告）")


if __name__ == "__main__":
    main()
