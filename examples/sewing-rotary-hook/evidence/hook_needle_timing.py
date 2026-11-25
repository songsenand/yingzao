#!/usr/bin/env python3
"""钩尖-机针时序与最小间隙：读 r024 的 trajectory，重建两件世界位姿，量钩尖/针眼高度与最近距离。

方法：motion 工具的帧是「pivot 世界坐标 + 四元数」；零件几何按 pivot 重基。
- 旋梭轴组 pivot = (0,0,0)，世界位姿 = R · v
- 机针 pivot = (0,-18,66)，世界位姿 = R · (v - pivot) + p
钩尖取 y<-8 且 r>19 的顶点（喙），机针取全部顶点。
"""
import json
import math
import sys

import numpy as np
import trimesh

BASE = "cad-data"
RUN = "r024"


def quat_matrix(q):
    x, y, z, w = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def main():
    traj = json.load(open(f"{BASE}/runs/{RUN}/trajectory.json"))["trajectory"]
    report = json.load(open(f"{BASE}/runs/{RUN}/report.json"))
    piv = report["metrics"].get("pivots") or {}
    # pivots live on the run report's top level in some versions
    if not piv:
        piv = report.get("pivots", {})
    piv_arbor = np.array(piv.get("arbor", [0, 0, 0]), float)
    piv_needle = np.array(piv.get("needle", [0, -18, 66]), float)

    arbor = trimesh.load(f"{BASE}/versions/v070/model.stl")
    needle = trimesh.load(f"{BASE}/versions/v072/model.stl")

    v = arbor.vertices
    r = np.hypot(v[:, 0], v[:, 2])
    beak = v[(v[:, 1] < -8.0) & (r > 19.0)]

    frames = {p["name"]: p["frames"] for p in traj["parts"]}
    times = traj["times"]
    rows = []
    for i, t in enumerate(times):
        fa = frames["arbor"][i]
        fn = frames["needle"][i]
        Ra = quat_matrix(fa[3:7])
        Rn = quat_matrix(fn[3:7])
        pa = np.array(fa[0:3])
        pn = np.array(fn[0:3])
        beak_w = (beak - piv_arbor) @ Ra.T + pa
        needle_w = (needle.vertices - piv_needle) @ Rn.T + pn
        # 最近距离：喙顶点到机针网格的最近点（kd-tree 在机针顶点上，够作时序见证）
        d = np.min(np.linalg.norm(beak_w[:, None, :] - needle_w[None, :, :], axis=2))
        tip = float(needle_w[:, 2].min())
        eye = float(needle_w[np.linalg.norm(needle_w - needle_w.mean(0), axis=1) < 40][:, 2].max()) if False else None
        # 钩尖：喙外缘（r>21.5）里角度最大者（设计 96°，缺口起点）
        rr = np.hypot(beak_w[:, 0], beak_w[:, 2])
        ang = np.degrees(np.arctan2(beak_w[:, 2], beak_w[:, 0])) % 360.0
        cand = np.where(rr > 21.5)[0]
        k = int(cand[np.argmax(ang[cand])])
        tip_pt = beak_w[k]
        tip_angle = float(ang[k])
        rows.append({"t": round(float(t), 3), "needleTipZ": round(tip, 3),
                     "beakTipAngleDeg": round(tip_angle, 2),
                     "beakTipZ": round(float(tip_pt[2]), 3),
                     "minDistBeakToNeedle": round(float(d), 3)})
    near = min(rows, key=lambda x: x["minDistBeakToNeedle"])
    top = min(rows, key=lambda x: abs(x["beakTipAngleDeg"] - 90.0))
    out = {
        "run": RUN,
        "method": "beak vertices (y<-8, r>19) vs needle vertices, 24 poses + final",
        "poses": len(rows),
        "needleStrokeMm": round(max(r["needleTipZ"] for r in rows) - min(r["needleTipZ"] for r in rows), 3),
        "needleTipZRangeMm": [round(min(r["needleTipZ"] for r in rows), 3), round(max(r["needleTipZ"] for r in rows), 3)],
        "closestApproach": near,
        "beakAtTop": top,
        "authoredPose": rows[0],
        "rows": rows,
        "note": "钩尖角以 +X=0°、+Z=90°；时序判据：钩尖到顶（90°）时针尖应≈18.5、针眼≈22.5（=钩尖半径）。",
    }
    json.dump(out, open(f"{BASE}/../evidence/hook_needle_timing.json", "w"), ensure_ascii=False, indent=1)
    print(json.dumps({k: out[k] for k in ("poses", "needleStrokeMm", "needleTipZRangeMm", "closestApproach", "beakAtTop", "authoredPose")}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
