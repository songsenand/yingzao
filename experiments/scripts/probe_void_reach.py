#!/usr/bin/env python
"""体素可达性探针（S2-b 通道瓶颈 / S4 非圆槽共用的引擎）。

验证 op_void_reach 在**已知答案**的用例上是否正确，并把两个曾经产出"看着合理"数字的
错误变体作为阴性对照一起跑出来 —— 报告里的结论因此是**被演示的**，不是被声称的。

运行：
    ~/.dsh/cad/runtime/venv/bin/python experiments/scripts/probe_void_reach.py

依赖：trimesh / scipy / numpy（插件自带运行时已含）。
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'dsh-cad-harness', 'python'))
import numpy as np                                            # noqa: E402
import trimesh                                                # noqa: E402
from scipy import ndimage                                     # noqa: E402
from cad_worker import worker                                 # noqa: E402

PITCH = 0.2
REQUIRED = 1.5            # 球半径 mm（= Ø3 刀具 / Ø3 通道要求）


def stl(mesh):
    path = tempfile.mktemp(suffix='.stl')
    mesh.export(path)
    return path


def slot_part(width_mm):
    """20x20x10 方块，中间开一条 width 宽、20 长（贯通）、6 高的槽。"""
    return trimesh.creation.box(extents=[20, 20, 10]).difference(
        trimesh.creation.box(extents=[width_mm, 40, 6]))


def hollow_sphere(r_outer=10.0, r_inner=9.0):
    """封闭内腔：外球 + 反向内球（内壳法线朝腔内）。"""
    outer = trimesh.creation.icosphere(subdivisions=3, radius=r_outer)
    inner = trimesh.creation.icosphere(subdivisions=3, radius=r_inner)
    inner.faces = np.fliplr(inner.faces)
    return trimesh.util.concatenate([outer, inner])


def ball(rv):
    g = np.ogrid[-rv:rv + 1, -rv:rv + 1, -rv:rv + 1]
    return (g[0] ** 2 + g[1] ** 2 + g[2] ** 2) <= rv * rv


def _edges(lab):
    s = set()
    for face in (lab[0, :, :], lab[-1, :, :], lab[:, 0, :], lab[:, -1, :], lab[:, :, 0], lab[:, :, -1]):
        s |= set(np.unique(face).tolist())
    s.discard(0)
    return s


def variant_bug1_dt_lt_r(mesh, pitch, r):
    """BUG 1：把 'dt < r 的空隙' 当成不可达。整个贴壁空隙层都被算成腔。"""
    solid = np.pad(mesh.voxelized(pitch=pitch).fill().matrix, int(np.ceil((r + 4 * pitch) / pitch)),
                   constant_values=False)
    dt = ndimage.distance_transform_edt(~solid) * pitch
    return float((~solid & ~(dt >= r)).sum()) * pitch ** 3


def variant_bug2_diamond(mesh, pitch, r):
    """BUG 2：膨胀用 binary_dilation 默认结构元（菱形/L1，不是球）。"""
    solid = np.pad(mesh.voxelized(pitch=pitch).fill().matrix, int(np.ceil((r + 4 * pitch) / pitch)),
                   constant_values=False)
    void = ~solid
    dt = ndimage.distance_transform_edt(void) * pitch
    lab0, _ = ndimage.label(void)
    outside = np.isin(lab0, list(_edges(lab0)))
    labr, _ = ndimage.label(dt >= r)
    centres = np.isin(labr, list(_edges(labr)))
    swept = ndimage.binary_dilation(centres, iterations=int(np.ceil(r / pitch)))     # ← 菱形
    raw = outside & ~swept
    return float(ndimage.binary_erosion(raw, structure=ball(1)).sum()) * pitch ** 3


def main():
    print("pitch=%.2fmm  requiredRadius=%.2fmm  (球=Ø%.1f)\n" % (PITCH, REQUIRED, 2 * REQUIRED))
    print("%-22s %12s %10s %10s %10s" % ("用例", "不可达mm³", "区域数", "瓶颈mm", "真值"))
    print("-" * 70)
    for width in (0.8, 3.0, 4.0):
        path = stl(slot_part(width))
        try:
            out = worker.op_void_reach({"path": path, "pitchMm": PITCH, "requiredRadiusMm": REQUIRED})
            regions = out.get("unreachable", [])
            bottleneck = regions[0].get("bottleneckRadiusMm") if regions else None
            truth = "排除" if width < 2 * REQUIRED else ("零间隙" if width == 2 * REQUIRED else "不排除")
            print("%-22s %12.3f %10d %10s %10s" % (
                "槽宽 %.1fmm" % width, out.get("unreachableVolumeMm3", -1), len(regions),
                ("%.3f" % bottleneck) if bottleneck is not None else "-", truth))
        finally:
            os.unlink(path)

    path = stl(hollow_sphere())
    try:
        out = worker.op_void_reach({"path": path, "pitchMm": PITCH, "requiredRadiusMm": REQUIRED})
        print("%-22s %12s %10s %10s %10s" % ("封闭内腔(实心球对照)", "-", "-", "-", "见 S2-a"))
        conn = worker.op_connectivity({"path": path})
        print("   └ op_connectivity: bodies=%d voids=%d 体积=%.1fmm³（解析 %.1f）" % (
            conn["count"], len(conn.get("voids", [])),
            (conn.get("voids") or [{}])[0].get("volumeMm3", -1),
            4.0 / 3.0 * np.pi * (9.0 ** 3)))
    finally:
        os.unlink(path)

    print("\n阴性对照：两个错误变体的输出（应当与上面正确值明显不同）")
    print("-" * 70)
    for width in (0.8, 4.0):
        path = stl(slot_part(width))
        try:
            print("槽宽 %.1fmm  BUG1(dt<r当不可达)=%9.3f mm³   BUG2(菱形膨胀)=%9.3f mm³" % (
                width, variant_bug1_dt_lt_r(trimesh.load(path, process=True), PITCH, REQUIRED),
                variant_bug2_diamond(trimesh.load(path, process=True), PITCH, REQUIRED)))
        finally:
            os.unlink(path)


if __name__ == "__main__":
    main()
