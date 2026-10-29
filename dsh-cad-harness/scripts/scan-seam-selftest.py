"""Deterministic self-test for the boolean-seam / mesh-health layers of `scan_attention`.

Builds two meshes that do not need OpenSCAD or a corpus:

  * a cylinder with a radial through-hole -> the two rims are CLOSED NON-PLANAR
    sharp loops; the scan must report `boolean-seam` (and must not report the
    flat hole rims of a plate as seams).
  * two disjoint boxes -> `multi-body`, and `analyze` (JS side) can fuse it.

Run with the provisioned python:

    python/scan-seam-selftest  (or the venv python used by accept-stress)
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "python", "cad_worker"))
import numpy as np  # noqa: E402
import trimesh  # noqa: E402

from worker import op_scan_attention  # noqa: E402

OUT = {}

with tempfile.TemporaryDirectory() as tmp:
    # 1. radial hole through a cylinder: non-planar rims
    body = trimesh.creation.cylinder(radius=10.0, height=20.0, sections=64)
    hole = trimesh.creation.cylinder(radius=3.0, height=40.0, sections=64)
    rot = trimesh.transformations.rotation_matrix(np.pi / 2, [0, 1, 0])
    hole.apply_transform(rot)
    holed = body.difference(hole)
    path = os.path.join(tmp, "side-hole.stl")
    holed.export(path)
    scan = op_scan_attention({"path": path})
    seams = [s for s in scan["suspects"] if s["kind"] == "boolean-seam"]
    OUT["sideHole"] = {
        "watertight": scan["stats"]["watertight"],
        "bodies": scan["stats"]["bodies"],
        "nonplanarSeamLoops": scan["stats"]["nonplanar_seam_loops"],
        "seams": [{"atMm": s["where"]["atMm"], "why": s["why"]} for s in seams[:3]],
    }

    # 2. two disjoint boxes: multi-body
    a = trimesh.creation.box(extents=[10, 10, 10])
    b = trimesh.creation.box(extents=[10, 10, 10])
    b.apply_translation([20, 0, 0])
    two = trimesh.util.concatenate([a, b])
    path2 = os.path.join(tmp, "two-bodies.stl")
    two.export(path2)
    scan2 = op_scan_attention({"path": path2})
    OUT["twoBodies"] = {
        "bodies": scan2["stats"]["bodies"],
        "kinds": [s["kind"] for s in scan2["suspects"]],
    }

print(json.dumps(OUT, ensure_ascii=False))

failures = []
def check(ok, label, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  — {detail}" if detail else ""))
    if not ok:
        failures.append(label)

check(OUT["sideHole"]["watertight"], "the radial-hole mesh is watertight")
check(OUT["sideHole"]["bodies"] == 1, "the radial-hole mesh is one body")
check(OUT["sideHole"]["nonplanarSeamLoops"] >= 1,
      "the non-planar rims are reported as boolean-seam",
      str(OUT["sideHole"]["nonplanarSeamLoops"]))
check(len(OUT["sideHole"]["seams"]) >= 1, "at least one seam carries a coordinate")
check(OUT["twoBodies"]["bodies"] == 2, "two disjoint boxes are two bodies",
      str(OUT["twoBodies"]["bodies"]))
check("multi-body" in OUT["twoBodies"]["kinds"], "and the scan reports multi-body",
      ",".join(OUT["twoBodies"]["kinds"]))

sys.exit(1 if failures else 0)
