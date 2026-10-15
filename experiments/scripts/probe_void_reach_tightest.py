#!/usr/bin/env python
"""定位 `op_void_reach` 的 `tightestPassageRadiusMm` 在宽槽上的 1.600mm 平台。

背景（2026-10-11 执行摘要 §"整合进展"）：`tightest()` 对 3.0/4.0/6.0mm 贯槽全部返回
**1.600**（= 8 × 0.2 = `ceil(1.5/0.2)`）。当时首要嫌疑是"`ball()` 半径取整 `ceil(mid/pitch)`
的台阶"，真因未定位。

本探针把那次怀疑变成可指认的机制。它按顺序做六件事：

  A. 复刻 `tightest()` 的每一步谓词（rv / 可达 / 膨胀 / 残余 / 腐蚀后残余）→ 看平台落在哪。
  B. 解耦：把结构元半径 `rv` 与门限 `mid` 分开强制，判断翻转是被"膨胀半径台阶"还是被
     "`reachable(mid)` 掉了一层体素"驱动的。
  C. 定位残余：把腐蚀后残余换算回 mesh 坐标（**必须加 voxel grid origin**），看它在哪。
  D. 对照 1：把球形结构元换成 L∞（立方）—— 如果平台消失，说明病灶是"球 vs 方角"。
  E. 对照 2：把方槽换成圆槽（同样宽度）—— 如果没有平台，同样说明是角的问题。
  F. 越界扫描：余量半边的病灶是否也污染**排除半边**（不同 r 下的不可达区域）。

运行：
    ~/.dsh/cad/runtime/venv/bin/python experiments/scripts/probe_void_reach_tightest.py
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
REQUIRED = 1.5
CEILING = max(2.0 * REQUIRED, 4.0 * PITCH)
WIDTHS = (3.0, 4.0, 6.0)


def stl(mesh):
    path = tempfile.mktemp(suffix='.stl')
    mesh.export(path)
    return path


def square_tunnel(width_mm):
    """2026-10-11 探针的同一个夹具：20x20x10 方块 + width 宽、贯通、6 高的槽。"""
    return trimesh.creation.box(extents=[20, 20, 10]).difference(
        trimesh.creation.box(extents=[width_mm, 40, 6]))


def round_tunnel(width_mm):
    """对照夹具：同样的宽度，但截面是圆（无角）。"""
    cyl = trimesh.creation.cylinder(radius=width_mm / 2.0, height=40, sections=96)
    cyl.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, [1, 0, 0]))
    return trimesh.creation.box(extents=[20, 20, 10]).difference(cyl)


def ball(rv):
    g = np.ogrid[-rv:rv + 1, -rv:rv + 1, -rv:rv + 1]
    return (g[0] ** 2 + g[1] ** 2 + g[2] ** 2) <= rv * rv


def cube(rv):
    return np.ones((2 * rv + 1,) * 3, dtype=bool)


def reachable_of(mask):
    lab, _ = ndimage.label(mask)
    edge = set()
    for face in (lab[0, :, :], lab[-1, :, :], lab[:, 0, :], lab[:, -1, :], lab[:, :, 0], lab[:, :, -1]):
        edge |= set(np.unique(face).tolist())
    edge.discard(0)
    return np.isin(lab, list(edge))


def voxel_field(mesh):
    """复刻 op_void_reach 的体素化 + padding + EDT，并交出 origin/pad。"""
    grid = mesh.voxelized(pitch=PITCH).fill()
    solid = np.asarray(grid.matrix)
    origin = np.asarray(grid.transform[:3, 3], dtype=float)
    pad = int(np.ceil((CEILING + 4.0 * PITCH) / PITCH))
    solid = np.pad(solid, pad, constant_values=False)
    void = ~solid
    dt = ndimage.distance_transform_edt(void) * PITCH
    return dt, reachable_of(dt > 0.0), origin, pad


def trace(width):
    """A：逐步谓词表。"""
    mesh = trimesh.load(stl(square_tunnel(width)), process=True)
    dt, outside, origin, pad = voxel_field(mesh)
    out = worker.op_void_reach({"path": stl(square_tunnel(width)), "pitchMm": PITCH, "requiredRadiusMm": REQUIRED})
    print("=" * 104)
    print(f"槽宽 {width}mm  pitch={PITCH} required={REQUIRED} ceiling={CEILING} pad={pad} dims={dt.shape}")
    print(f"  op 输出: tightestPassageRadiusMm={out['tightestPassageRadiusMm']!r}  "
          f"不可达={out['unreachableVolumeMm3']}mm³")
    print(f"  {'mid':>6} {'rv':>3} {'rv*pitch':>9} {'可达体素':>10} {'膨胀后':>10} {'残余':>8} {'腐蚀后':>8}  谓词")
    for mid in (0.4, 0.8, 1.2, 1.4, 1.5, 1.59, 1.60, 1.601, 1.61, 1.8, 2.5, 3.0):
        rv = int(np.ceil(mid / PITCH))
        reach = reachable_of(dt >= mid)
        residual = outside & ~ndimage.binary_dilation(reach, structure=ball(rv))
        eroded = ndimage.binary_erosion(residual, structure=ball(1))
        print(f"  {mid:6.3f} {rv:3d} {rv*PITCH:9.2f} {int(reach.sum()):10d} "
              f"{int((outside & ndimage.binary_dilation(reach, structure=ball(rv))).sum()):10d} "
              f"{int(residual.sum()):8d} {int(eroded.sum()):8d}  {'有残余' if eroded.any() else '—'}")
    return mesh, dt, outside, origin, pad


def decouple(width):
    """B：rv 与 mid 解耦。"""
    mesh = trimesh.load(stl(square_tunnel(width)), process=True)
    dt, outside, _origin, _pad = voxel_field(mesh)
    print(f"  ── B 解耦（槽宽 {width}mm）：翻转是被 rv 台阶驱动，还是被 reachable(mid) 掉层驱动？")
    print(f"  {'mid':>7} {'rv':>3} {'可达':>9} {'残余':>8} {'腐蚀后':>8}")
    for mid in (1.50, 1.60, 1.601, 1.61, 1.70):
        for rv in (int(np.ceil(mid / PITCH)), 8, 9):
            reach = reachable_of(dt >= mid)
            residual = outside & ~ndimage.binary_dilation(reach, structure=ball(rv))
            eroded = ndimage.binary_erosion(residual, structure=ball(1))
            print(f"  {mid:7.3f} {rv:3d} {int(reach.sum()):9d} {int(residual.sum()):8d} {int(eroded.sum()):8d}")


def locate(width, mid):
    """C：残余在哪儿（加 voxel origin，换算回 mesh 坐标）。"""
    mesh = trimesh.load(stl(square_tunnel(width)), process=True)
    dt, outside, origin, pad = voxel_field(mesh)
    _rp = mesh.voxelized(pitch=PITCH)
    rv = int(np.ceil(mid / PITCH))
    eroded = ndimage.binary_erosion(
        outside & ~ndimage.binary_dilation(reachable_of(dt >= mid), structure=ball(rv)), structure=ball(1))
    co = np.argwhere(eroded)
    mm = (co - pad) * PITCH + origin
    print(f"  ── C 槽宽 {width}mm mid={mid} 腐蚀后残余 {len(co)} 体素（mesh 坐标）")
    print("     bbox mm: x[%.2f,%.2f] y[%.2f,%.2f] z[%.2f,%.2f]" % (
        mm[:, 0].min(), mm[:, 0].max(), mm[:, 1].min(), mm[:, 1].max(), mm[:, 2].min(), mm[:, 2].max()))
    in_corner = ((np.abs(mm[:, 0]) > width / 2 - 1.0) & (np.abs(mm[:, 2]) > 2.0)).mean()
    print(f"     位于槽四角（|x|>{width/2-1.0:.1f} 且 |z|>2.0）的比例 = {in_corner:.1%}")


def tightest_with(dt, outside, struct):
    lo, hi = 0.0, CEILING
    for _ in range(10):
        mid = (lo + hi) / 2
        rv = int(np.ceil(mid / PITCH))
        residual = outside & ~ndimage.binary_dilation(reachable_of(dt >= mid), structure=struct(rv))
        if ndimage.binary_erosion(residual, structure=ball(1)).any():
            hi = mid
        else:
            lo = mid
    return lo


def controls():
    """D/E：球 vs 立方；方槽 vs 圆槽。"""
    print("=" * 104)
    print("D/E 对照：结构元形状 × 通道截面形状（真值 = min(宽/2, 3.0)，即球能通过的最大半径）")
    print(f"  {'夹具':<24} {'op 输出':>9} {'球结构元':>10} {'立方结构元':>11} {'真值':>7}")
    for name, mk in (("方槽", square_tunnel), ("圆槽", round_tunnel)):
        for w in WIDTHS:
            mesh = trimesh.load(stl(mk(w)), process=True)
            dt, outside, _o, _p = voxel_field(mesh)
            out = worker.op_void_reach({"path": stl(mk(w)), "pitchMm": PITCH, "requiredRadiusMm": REQUIRED})
            print(f"  {name}{w:<19} {str(out['tightestPassageRadiusMm']):>9} "
                  f"{tightest_with(dt, outside, ball):10.3f} {tightest_with(dt, outside, cube):11.3f} "
                  f"{min(w/2.0, CEILING):7.2f}")


def exclusion_scan():
    """F：排除半边在不同 r 下是否也被角污染。"""
    print("=" * 104)
    print("F 排除半边越界扫描：球半径 = 槽半宽时，几何上球恰好塞满 ⇒ 不应报不可达")
    print(f"  {'截面':<6} {'宽':>5} {'required':>9} {'应判':>7} {'不可达mm³':>11} {'区域数':>7} {'瓶颈mm':>8}")
    for name, mk in (("方槽", square_tunnel), ("圆槽", round_tunnel)):
        for w in (3.0, 4.0, 6.0):
            for d in (0.0, +0.2):
                req = w / 2.0 + d
                p = stl(mk(w))
                out = worker.op_void_reach({"path": p, "pitchMm": PITCH, "requiredRadiusMm": req})
                regs = out.get("unreachable", [])
                print(f"  {name:<6} {w:5.1f} {req:9.2f} {'放得下' if d == 0 else '放不下':>7} "
                      f"{out.get('unreachableVolumeMm3', -1):11.3f} {len(regs):7d} "
                      f"{(regs[0].get('bottleneckRadiusMm') if regs else float('nan')):8.3f}")


def origin_check():
    """验证 centerMm 已加回 voxel grid origin。"""
    print("=" * 104)
    print("G centerMm 的 origin 修正：0.8mm 槽（排除半边）报出的腔心应落在槽内 (|x|≲0.5, |z|≲3)")
    for w in (0.8, 3.0):
        out = worker.op_void_reach({"path": stl(square_tunnel(w)), "pitchMm": PITCH, "requiredRadiusMm": REQUIRED})
        regs = out.get("unreachable", [])
        print(f"  槽宽 {w}mm: {len(regs)} 个区域", end="")
        for r in regs[:2]:
            print(f"  centerMm={r['centerMm']} v={r['volumeMm3']}mm³ 瓶颈={r.get('bottleneckRadiusMm')}", end="")
        print()


def main():
    print(f"pitch={PITCH}mm  required={REQUIRED}mm  ceiling={CEILING}mm")
    print("\n### A 逐步谓词表：平台落在哪")
    for width in WIDTHS:
        trace(width)
    print("\n### B 解耦：rv 台阶 vs reachable 掉层")
    for width in WIDTHS:
        decouple(width)
    print("\n### C 残余定位")
    for width in WIDTHS:
        locate(width, 1.61)
    controls()
    exclusion_scan()
    origin_check()
    print()
    print("=" * 104)
    print("结论：1.600 不是通道宽度，是'球的扫掠在方角上留下的残片'跨过 2 体素噪声地板的那一点；")
    print("      它落在 pitch 的整数倍上，且与通道宽度无关（矩形角沿每条边退让 mid，与边长无关）。")


if __name__ == "__main__":
    main()
