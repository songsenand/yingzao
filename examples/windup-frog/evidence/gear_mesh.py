"""齿轮啮合扫掠：按实际中心距把三只齿轮转满一个齿距，测干涉体积。
运行：run_python(script="examples/windup-frog/evidence/gear_mesh.py")
输出：examples/windup-frog/evidence/gear_mesh.json
"""
import json, math
from pathlib import Path
import trimesh
from trimesh.transformations import rotation_matrix

ROOT = Path(__file__).resolve().parents[1]
V = ROOT / "cad-data" / "versions"
OUT = Path(__file__).resolve().parent / "gear_mesh.json"

A = (4.0, 0.0)
B = (15.6906, 8.1826)
C = (22.6701, -1.7857)
CD_AB = 14.2719     # gear_dist(30T,10T, m=0.7, auto shift)
CD_BC = 12.1692     # gear_dist(24T,10T)

def load(v):
    return trimesh.load(V / v / "model.stl")

def rot(m, pt, deg):
    T = rotation_matrix(math.radians(deg), [0, 0, 1], point=[pt[0], pt[1], 0])
    return m.copy().apply_transform(T)

def inter(m1, m2):
    out = trimesh.boolean.intersection([m1, m2], engine="manifold")
    return 0.0 if out is None else float(out.volume)

lid, gb, fly = load("v044"), load("v045"), load("v046")

# 一对齿轮：主动轮转过 1 个齿距（360/30 = 12°）
ab, bc = [], []
N = 24
for i in range(N + 1):
    phi = 12.0 * i / N
    a = rot(lid, A, phi)
    b = rot(gb, B, -3.0 * phi)
    c = rot(fly, C, 7.2 * phi)          # -2.4 * (-3 phi)
    ab.append(inter(a, b))
    bc.append(inter(b, c))

result = {
    "module": 0.7,
    "teeth": {"A": 30, "B": 10, "C": 10, "B_big": 24},
    "centre_distance_mm": {"A-B": CD_AB, "B-C": CD_BC},
    "calculated_centre_distance_mm": {
        "A-B": (30 + 10) * 0.7 / 2,
        "B-C": (24 + 10) * 0.7 / 2,
    },
    "samples": N + 1,
    "sweep_deg": 12.0,
    "A-B_max_interference_mm3": round(max(ab), 6),
    "B-C_max_interference_mm3": round(max(bc), 6),
    "A-B_all_zero": all(v < 1e-6 for v in ab),
    "B-C_all_zero": all(v < 1e-6 for v in bc),
}
OUT.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
print(json.dumps(result, indent=2, ensure_ascii=False))
