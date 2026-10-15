#!/usr/bin/env python3
"""叶片几何复核：从 STL 反测桨距角 / 弦长 / 半径 / 轴向占用。

为什么需要它：渲染图能看出"像不像螺旋桨"，但看不出**螺距扭转的符号**——
OpenSCAD 的 linear_extrude(twist=) 转向与 2D rotate() 相反，方向搞反了图上
同样是"一片有扭转的桨叶"（本设计第一版就反了，桨距随半径从 16.6° 涨到 24.2°）。
这里沿径向切片，用截面的主轴（PCA）反解弦线与旋转平面的夹角，与设计值逐站对比。

正桨（HAND=+1）：在方位 0（+x）处前缘在 +y，测得桨距角应为 **正** 且随半径递减。
反桨（HAND=-1）：同一方位上前缘在 −y，测得的应为 **负** 值、绝对值相同。

用法： <runtime venv>/python tools/check-pitch.py <model.stl> [--cw]
"""
import sys
import numpy as np
import trimesh

BLADE_LEN, R_ROOT, R_EMBED = 60.0, 12.0, 9.5
CHORD_ROOT, CHORD_TIP = 15.0, 8.0
PITCH_ROOT, PITCH_TIP = 17.0, 9.5
HUB_R = 13.0
R_TIP = R_ROOT + BLADE_LEN
SPAN = R_TIP - R_EMBED
C_EMBED = CHORD_ROOT / (1 + (CHORD_TIP / CHORD_ROOT - 1) * (R_ROOT - R_EMBED) / SPAN)
B_EMBED = PITCH_ROOT + (PITCH_TIP - PITCH_ROOT) * (R_ROOT - R_EMBED) / BLADE_LEN
STATIONS = (15, 20, 30, 40, 50, 60, 70, 71.5)


def design(r):
    c = C_EMBED + (CHORD_TIP - C_EMBED) * (r - R_EMBED) / SPAN
    b = B_EMBED + (PITCH_TIP - B_EMBED) * (r - R_EMBED) / SPAN
    return b, c


def main(path, cw):
    m = trimesh.load(path)
    V = m.vertices
    print("watertight=%s  volume=%.1f mm3  triangles=%d" % (m.is_watertight, m.volume, len(m.faces)))
    print("max radius from axis = %.3f mm   z = %.3f .. %.3f"
          % (np.hypot(V[:, 0], V[:, 1]).max(), V[:, 2].min(), V[:, 2].max()))
    print()
    print("  r      pitch_meas  pitch_design   chord_meas  chord_design   zmin    zmax")
    worst = 0.0
    for r in STATIONS:
        seg = trimesh.intersections.mesh_plane(
            m, plane_origin=[r, 0, 0], plane_normal=[1, 0, 0]).reshape(-1, 3)
        seg = seg[np.abs(seg[:, 1]) < 30]            # keep the blade at azimuth 0
        yz = seg[:, 1:3]
        _, _, vt = np.linalg.svd(yz - yz.mean(axis=0))
        d = vt[0]
        if d[0] < 0:
            d = -d                                    # orient the chord toward +y
        ang = float(np.degrees(np.arctan2(d[1], d[0])))
        bd, cd = design(r)
        # 反桨测到的是镜像截面：把设计值取负再比
        want = -bd if cw else bd
        # 截面只取弦向 y 跨度，等于 弦长×cos(桨距角)
        chord = float(yz[:, 0].max() - yz[:, 0].min())
        worst = max(worst, abs(ang - want))
        print("%5.1f  %10.3f  %12.3f   %10.3f  %12.3f   %6.3f  %6.3f"
              % (r, ang, want, chord, cd * np.cos(np.radians(bd)), seg[:, 2].min(), seg[:, 2].max()))
    print()
    print("r > 桨毂半径 %.0fmm 的各站：max |pitch_meas - pitch_design| = %.3f deg"
          % (HUB_R, worst))
    print("（x < %.0fmm 的截面会同时切到桨毂，PCA 被污染，故不计入）" % HUB_R)
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1], "--cw" in sys.argv))
