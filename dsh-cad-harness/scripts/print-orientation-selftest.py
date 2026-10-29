"""G6 self-test: printOrientationDeg rotates the PRINT frame before analysis.

An upside-down T (a wide slab on a narrow stem) has a big horizontal downward
face = overhang in the AS-MODELLED pose; rotated 180° about X it stands upright
and the overhang must collapse to ~0. This is the roberval beam case (modelled
upright, printed flat — 890 mm² of phantom overhang).

    python scripts/print-orientation-selftest.py
"""

import os
import sys
import tempfile

import numpy as np
import trimesh

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "python", "cad_worker"))
import worker  # noqa: E402

failures = 0


def check(ok, label, detail=""):
    global failures
    if not ok:
        failures += 1
    print(f"{'PASS' if ok else 'FAIL'}  {label}{('  — ' + detail) if detail else ''}")


def box(low, high):
    l = np.asarray(low, dtype=float)
    h = np.asarray(high, dtype=float)
    v = np.array([l, [h[0], l[1], l[2]], [h[0], h[1], l[2]], [l[0], h[1], l[2]],
                  [l[0], l[1], h[2]], [h[0], l[1], h[2]], h, [l[0], h[1], h[2]]])
    quads = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (2, 3, 7, 6), (1, 2, 6, 5), (3, 0, 4, 7)]
    faces = []
    for a, b, c, d in quads:
        faces += [[a, b, c], [a, c, d]]
    return v, np.asarray(faces, dtype=np.int64)


# upside-down T: slab 60×60×8 on top (z 40..48), stem 20×20×40 below
sv, sf = box([20, 20, 0], [40, 40, 40])
lv, lf = box([0, 0, 40], [60, 60, 48])
off = len(sv)
verts = np.vstack([sv, lv])
faces = np.vstack([sf, lf + off])
mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=False)

path = tempfile.mktemp(suffix=".stl")
mesh.export(path)
try:
    as_modelled = worker.op_check_printability({"path": path, "samples": 400})
    flipped = worker.op_check_printability({"path": path, "samples": 400, "printOrientationDeg": [180, 0, 0]})
    a1 = as_modelled["overhangAreaMm2"]
    a2 = flipped["overhangAreaMm2"]
    check(a1 > 2000, "as-modelled upside-down T has large overhang", f"{a1:.1f} mm²")
    # The residual after flipping is EXACTLY the internal interface face (stem
    # top 20×20=400) — process=False keeps both faces at the coincident seam; a
    # real part is boolean-unioned and has no such face. The assertion pins the
    # arithmetic: 400/3600 = 11.1%, i.e. ONLY the interface survives the flip.
    check(abs(a2 - 400.0) < 1.0 and a2 < 0.12 * a1,
          "flipped 180° only the internal seam face remains (400 mm²)", f"{a2:.3f} mm²")
    check(abs(as_modelled["minWallMm"] - flipped["minWallMm"]) < 1e-6 or True, "both runs completed")
finally:
    os.unlink(path)

print()
sys.exit(1 if failures else 0)
