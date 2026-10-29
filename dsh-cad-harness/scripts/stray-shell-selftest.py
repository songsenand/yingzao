"""Self-test for the G3 hole-core stray-shell classification (2026-10-29).

The roberval bottom beam shipped with two 3.4×17×3.4 plugs ("孔芯") left INSIDE
the part by a horizontal closed boolean difference — bodies=3 with no word about
why. `connectivity` now CLASSIFIES them: a tiny positive-volume shell strictly
inside the main body's bbox is a stray shell. Detection, not removal — auto-
dropping shells can mask a real modelling error.

    python scripts/stray-shell-selftest.py
"""

import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "python", "cad_worker"))
import worker  # noqa: E402

failures = 0


def check(ok, label, detail=""):
    global failures
    if not ok:
        failures += 1
    print(f"{'PASS' if ok else 'FAIL'}  {label}{('  — ' + detail) if detail else ''}")


def box_mesh(low, high):
    """A closed 12-triangle box, consistently wound outward."""
    l = np.asarray(low, dtype=float)
    h = np.asarray(high, dtype=float)
    v = np.array([
        l, [h[0], l[1], l[2]], [h[0], h[1], l[2]], [l[0], h[1], l[2]],
        l + [0, 0, h[2] - l[2]], [h[0], l[1], h[2]], h, [l[0], h[1], h[2]],
    ])
    quads = [
        (0, 3, 2, 1),  # bottom (-z)
        (4, 5, 6, 7),  # top (+z)
        (0, 1, 5, 4),  # front (-y)
        (2, 3, 7, 6),  # back (+y)
        (1, 2, 6, 5),  # right (+x)
        (3, 0, 4, 7),  # left (-x)
    ]
    faces = []
    for a, b, c, d in quads:
        faces.append([a, b, c])
        faces.append([a, c, d])
    return v, np.asarray(faces, dtype=np.int64)


def combine(*meshes):
    verts = []
    faces = []
    off = 0
    for v, f in meshes:
        verts.append(v)
        faces.append(f + off)
        off += len(v)
    return np.vstack(verts), np.vstack(faces)


def run(v, f):
    import tempfile
    import trimesh
    p = tempfile.mktemp(suffix=".stl")
    trimesh.Trimesh(vertices=v, faces=f, process=False).export(p)
    try:
        return worker.op_connectivity({"path": p})
    finally:
        os.unlink(p)


# 1. the hole core: a 100³ box with a 3.4×17×3.4 plug floating in its cavity
v1, f1 = box_mesh([0, 0, 0], [100, 100, 100])
v2, f2 = box_mesh([40, 40, 40], [43.4, 57, 43.4])
r = run(*combine((v1, f1), (v2, f2)))
check(r["count"] == 2, "box + plug reads as 2 bodies", f"count={r['count']}")
check(len(r.get("strayShells", [])) == 1, "the plug is classified as a stray shell",
      json.dumps(r.get("strayShells")))
check(abs(r["strayShells"][0]["volumeMm3"] - 3.4 * 17 * 3.4) < 0.5,
      "the stray's volume matches the plug", str(r["strayShells"][0]["volumeMm3"]))

# 2. a legitimate second body that sticks OUT is not a stray
v3, f3 = box_mesh([100, 40, 40], [140, 60, 60])  # a boss on the box's face
r = run(*combine((v1, f1), (v3, f3)))
check(len(r.get("strayShells", [])) == 0, "an attached boss outside the main bbox is NOT a stray",
      json.dumps(r.get("strayShells")))

# 3. a comparable-size second body inside (two boxes in one file, one within the
#    other's bbox but LARGE) is not a stray either
v4, f4 = box_mesh([10, 10, 10], [60, 60, 60])  # 50³ = 12.5% of the main volume
r = run(*combine((v1, f1), (v4, f4)))
check(len(r.get("strayShells", [])) == 0, "a large interior body is not flagged", json.dumps(r.get("strayShells")))

# 4. a single clean box: no strays, no voids
r = run(v1, f1)
check(r["count"] == 1 and r.get("strayShells") == [], "a single body reports no strays")

print()
sys.exit(1 if failures else 0)
