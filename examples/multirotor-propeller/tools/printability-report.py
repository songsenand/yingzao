#!/usr/bin/env python3
"""把 check_printability 的两条结论落到可复核的数字上（全量，不抽样）。

check_printability 对三角面**抽样**（triangles/samples 的步长），本件 2.6 万个面、
默认 600~2500 个采样面，悬垂面积会被低估好几倍。这里全量复算：

  1. 朝下悬垂面积，按与水平面的夹角分带。FDM 的判据是"面比 45° 更平就要支撑"，
     桨叶下表面按桨距角倾斜 10~17°，必然计入——这是螺旋桨的固有属性，不是缺陷。
  2. 叶片截面厚度随半径的分布（弦向法向），用来回答"薄壁"这条 finding：
     桨叶是**实心翼型**，中段 1.9~3.2mm，只有前后缘的收敛楔形会薄到 0.6mm；
     那不是"薄壳"，是钝缘。

用法： <runtime venv>/python tools/printability-report.py <model.stl>
"""
import sys
import numpy as np
import trimesh

R_EMBED, R_ROOT, R_TIP = 6.0, 12.0, 72.0
C_EMBED, C_TIP = 15.7, 8.0
B_EMBED, B_TIP = 16.1, 9.5


def main(path):
    m = trimesh.load(path)
    n, area = m.face_normals, m.area_faces
    z_floor = m.vertices[:, 2].min()
    down = n[:, 2] < 0
    theta = np.degrees(np.arccos(np.clip(-n[:, 2], -1.0, 1.0)))   # 0°=水平天花板, 90°=竖墙
    need = down & (theta < 45.0) & ((m.triangles_center[:, 2] - z_floor) > 0.8)

    print("== %s" % path)
    print("triangles=%d  surface=%.1f mm2  watertight=%s  bbox=%s"
          % (len(m.faces), m.area, m.is_watertight, np.round(m.extents, 2)))
    print()
    print("朝下悬垂（全量三角面，不抽样）")
    print("  朝下总面积                    = %8.1f mm2" % area[down].sum())
    print("  其中比 45° 更平 → 需要支撑    = %8.1f mm2" % area[need].sum())
    for lo, hi in ((0, 15), (15, 30), (30, 45), (45, 90)):
        b = down & (theta >= lo) & (theta < hi)
        print("      倾角 %2d~%2d° 朝下面积      = %8.1f mm2" % (lo, hi, area[b].sum()))
    if need.any():
        zz = m.triangles_center[need][:, 2]
        print("      分布高度 z = %.2f .. %.2f mm（桨毂 0~7mm，桨叶嵌在其中）"
              % (zz.min(), zz.max()))
    print()
    print("叶片截面厚度（垂直于弦，沿半径切片实测）")
    print("   r     弦长    截面最大厚   前/后缘厚")
    for r in (12.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 71.5):
        seg = trimesh.intersections.mesh_plane(
            m, plane_origin=[r, 0, 0], plane_normal=[1, 0, 0]).reshape(-1, 3)
        seg = seg[np.abs(seg[:, 1]) < 30]
        yz = seg[:, 1:3]
        _, _, vt = np.linalg.svd(yz - yz.mean(axis=0))
        d = vt[0]
        if d[0] < 0:
            d = -d
        t = -(yz - yz.mean(axis=0)) @ np.array([-d[1], d[0]])   # 弦法向坐标
        c = C_EMBED + (C_TIP - C_EMBED) * (r - R_EMBED) / (R_TIP - R_EMBED)
        # 缘厚取两端各 1% 弦长窗口内的法向跨度
        s = (yz - yz.mean(axis=0)) @ d
        w = 0.01 * c
        e_lo = t[s < s.min() + w]
        e_hi = t[s > s.max() - w]
        edge = max(e_lo.max() - e_lo.min(), e_hi.max() - e_hi.min())
        print("%6.1f  %6.2f    %6.2f      %6.2f" % (r, c, t.max() - t.min(), edge))
    print()
    print("桨毂壁厚（由设计尺寸直接给出，非抽样）")
    print("  轴孔Ø5.2 到 M2孔Ø2.4 的最小壁      = (16/2−1.2) − 5.2/2 = %.2f mm" % (8 - 1.2 - 2.6))
    print("  M2孔外缘到桨毂外圆 Ø26            = 13 − (8+1.2)      = %.2f mm" % (13 - 9.2))
    print("  沉台面(z=5)到桨毂顶面(z=7)        = %.2f mm（螺母压的是这一圈）" % 2.0)
    print("  沉台面到 M2 沉头锥底(z=6.05)      = %.2f mm" % (7 - 0.95 - 5.0))
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
