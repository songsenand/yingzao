"""凸轮—滑块—输出销：一个周期的行程与干涉。
运行：run_python(script="examples/windup-frog/evidence/cam_slider.py")
输出：examples/windup-frog/evidence/cam_slider.json
"""
import json, math
from pathlib import Path
import trimesh
from trimesh.transformations import rotation_matrix

ROOT = Path(__file__).resolve().parents[1]
V = ROOT / "cad-data" / "versions"
OUT = Path(__file__).resolve().parent / "cam_slider.json"

A = (4.0, 0.0)
E = 2.0          # 偏心距
R_CAM = 6.0      # 凸轮半径
X_REST = A[0] + R_CAM - E   # 滑块面在 φ=180° 的位置 = 8

def load(v):
    return trimesh.load(V / v / "model.stl")

def rot(m, pt, deg):
    T = rotation_matrix(math.radians(deg), [0, 0, 1], point=[pt[0], pt[1], 0])
    return m.copy().apply_transform(T)

def move(m, dx):
    return m.copy().apply_transform(rotation_matrix(0, [0, 0, 1], point=[0, 0, 0]) if False else
                                    [[1, 0, 0, dx], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]])

def inter(m1, m2):
    out = trimesh.boolean.intersection([m1, m2], engine="manifold")
    return 0.0 if out is None else float(out.volume)

cam, slider, base, drum, fly = load("v049"), load("v033"), load("v032"), load("v043"), load("v046")

rows = []
N = 72
for i in range(N + 1):
    phi = 2 * math.pi * i / N
    s = E * (1.0 - math.cos(phi))         # 相对静止位（φ=180°）的位移
    c = rot(cam, A, math.degrees(phi))
    sl = move(slider, s)
    rows.append({
        "phi_deg": round(math.degrees(phi), 1),
        "slider_mm": round(s, 4),
        "cam_slider_mm3": round(inter(c, sl), 6),
        "slider_base_mm3": round(inter(sl, base), 6),
        "cam_drum_mm3": round(inter(c, drum), 6),
        "slider_fly_mm3": round(inter(sl, fly), 6),
    })

def rng(key):
    vals = [r[key] for r in rows]
    return {"min": min(vals), "max": max(vals)}

# 回位簧估算：悬臂梁（曲梁按等效长度）
E_PLA = 3000.0      # MPa（假设值，非实测）
H = 2.6; T = 0.8    # 簧截面（z 高，y 厚）
L_EFF = 20.0        # 曲梁展开长度估算（mm）
I = H * T**3 / 12
k = 3 * E_PLA * I / L_EFF**3
F4 = k * 4.0
sigma4 = 3 * E_PLA * (T / 2) * 4.0 / L_EFF**2

result = {
    "cam": {"R_mm": R_CAM, "e_mm": E, "stroke_mm": 2 * E},
    "slider_face_x_mm": {"rest": X_REST, "max": X_REST + 2 * E},
    "samples": N + 1,
    "stroke_measured_mm": round(max(r["slider_mm"] for r in rows) - min(r["slider_mm"] for r in rows), 4),
    "max_interference_mm3": {
        "cam_slider": max(r["cam_slider_mm3"] for r in rows),
        "slider_base": max(r["slider_base_mm3"] for r in rows),
        "cam_drum": max(r["cam_drum_mm3"] for r in rows),
        "slider_fly": max(r["slider_fly_mm3"] for r in rows),
    },
    "output_pin_travel_mm": {
        "x_rest": 11.5, "x_max": 15.5,
        "y": [-3.2, 3.2],
        "stroke": 4.0,
    },
    "return_spring_estimate": {
        "note": "悬臂梁估算，非实测；PLA E=3000MPa 为假设",
        "k_N_per_mm": round(k, 4),
        "F_at_4mm_N": round(F4, 3),
        "bending_stress_at_4mm_MPa": round(sigma4, 1),
    },
    "rows": rows,
}
OUT.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
print(json.dumps({k: v for k, v in result.items() if k != "rows"}, indent=2, ensure_ascii=False))
