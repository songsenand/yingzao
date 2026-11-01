"""整机包络与质量：按交付版本 STL 求和，判断能否塞进巴掌大青蛙。
运行：run_python(script="examples/windup-frog/evidence/envelope.py")
"""
import json
from pathlib import Path
import numpy as np
import trimesh

ROOT = Path(__file__).resolve().parents[1]
V = ROOT / "cad-data" / "versions"
OUT = Path(__file__).resolve().parent / "envelope.json"

PARTS = {
    "base": "v032", "top": "v034", "drum": "v043", "lid": "v044",
    "arbor": "v048", "cam": "v049", "slider": "v033", "gearB": "v045",
    "fly": "v046", "key": "v040", "click": "v047", "spring": "v026",
}
RHO_PLA = 1.24e-3   # g/mm3，假设值

meshes, vols, boxes = {}, {}, {}
for k, v in PARTS.items():
    m = trimesh.load(V / v / "model.stl")
    meshes[k] = m
    vols[k] = float(m.volume)
    boxes[k] = [m.bounds[0].tolist(), m.bounds[1].tolist()]

def bbox(keys):
    lo = np.min([boxes[k][0] for k in keys], axis=0)
    hi = np.max([boxes[k][1] for k in keys], axis=0)
    return lo, hi

body = [k for k in PARTS if k not in ("key", "spring", "slider")]
lo_b, hi_b = bbox(body)
lo_a, hi_a = bbox(list(PARTS))
lo_k, hi_k = bbox(["key"])

printed = [k for k in PARTS if k != "spring"]
result = {
    "versions": PARTS,
    "bbox_body_mm": {"min": lo_b.round(2).tolist(), "max": hi_b.round(2).tolist(),
                     "size": (hi_b - lo_b).round(2).tolist()},
    "bbox_with_key_mm": {"min": lo_k.round(2).tolist(), "max": hi_k.round(2).tolist()},
    "bbox_all_mm": {"min": lo_a.round(2).tolist(), "max": hi_a.round(2).tolist(),
                    "size": (hi_a - lo_a).round(2).tolist()},
    "volume_mm3": {k: round(vols[k], 1) for k in PARTS},
    "printed_volume_mm3": round(sum(vols[k] for k in printed), 1),
    "printed_mass_g_estimated": round(sum(vols[k] for k in printed) * RHO_PLA, 2),
    "target_mm": {"outer_frog": [75, 45, 36], "movement": [60, 36, 26]},
}
# The target is the MOVEMENT body (<= 60 x 36 x 26). The output pins are an
# interface that deliberately protrudes below the movement; judge them in their
# own field instead of quietly loosening the target to 28.5.
body_size = hi_b - lo_b
all_size = hi_a - lo_a
result["fits_movement_target"] = bool(
    body_size[0] <= 60.5 and body_size[1] <= 36.5 and body_size[2] <= 26.5
)
result["fits_with_output_pins"] = bool(
    all_size[0] <= 60.5 and all_size[1] <= 36.5 and all_size[2] <= 28.5
)
OUT.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
print(json.dumps(result, indent=2, ensure_ascii=False))
