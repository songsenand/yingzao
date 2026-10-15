#!/usr/bin/env python3
"""Probe: DXF/STEP import chain for dsh-cad-harness (2026-10-15).

Validates, with numbers, the three conversion routes before they are wired into
`op_import_mesh`:
  A. STEP  --cascadio(OCCT)--> GLB --trimesh--> numpy arrays   (units? bodies? tolerance?)
  B. IGES  --cascadio--> ???                                  (expected: NOT supported)
  C. DXF   --ezdxf--> loops/meshes --> manifold3d CrossSection.extrude / soup+weld
Units policy probes: STEP native unit after OCCT, DXF $INSUNITS handling.

Run: .tmp-cadprobe/venv/bin/python probe.py > probe.log 2>&1
"""
import json
import os
import time
import traceback

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT = {}
STEP_FILES = ["colored.step", "material.stp", "featuretype.STEP", "multibody.step"]


def section(title):
    print(f"\n{'=' * 8} {title} {'=' * 8}")


# ---------- A. STEP -> GLB -> trimesh ----------
section("A. STEP chain")
import cascadio
import trimesh

OUT["cascadio_version"] = __import__("importlib").metadata.version("cascadio")

for name in STEP_FILES:
    path = os.path.join(DATA, name)
    glb = os.path.join(HERE, f"{name}.glb")
    t0 = time.perf_counter()
    cascadio.step_to_glb(path, glb)
    dt = time.perf_counter() - t0
    scene = trimesh.load(glb, process=False)
    mesh = scene.to_mesh() if hasattr(scene, "to_mesh") else scene
    entry = {
        "convert_s": round(dt, 3),
        "bodies_in_glb": len(scene.geometry) if hasattr(scene, "geometry") else 1,
        "triangles": int(len(mesh.faces)),
        "vertices_merged": int(len(mesh.vertices)),
        "volume_mm3_reported_by_trimesh": round(float(mesh.volume), 1),
        "watertight": bool(mesh.is_watertight),
        "bbox": [round(float(v), 2) for v in mesh.extents],
        "units_attr": mesh.units,
    }
    # direct high-level load must land in the same place
    direct = trimesh.load(path, force="mesh", process=False)
    entry["direct_step_load_same_triangles"] = bool(len(direct.faces) == len(mesh.faces))
    OUT[name] = entry
    print(name, json.dumps(entry))

# tolerance sweep on the big one
section("A2. tolerance sweep (multibody)")
sweep = {}
for tol in [None, 0.5, 0.1]:
    glb = os.path.join(HERE, "sweep.glb")
    t0 = time.perf_counter()
    if tol is None:
        cascadio.step_to_glb(os.path.join(DATA, "multibody.step"), glb)
    else:
        cascadio.step_to_glb(os.path.join(DATA, "multibody.step"), glb, tol_linear=tol)
    dt = time.perf_counter() - t0
    mesh = trimesh.load(glb, force="mesh", process=False)
    sweep[str(tol)] = {
        "convert_s": round(dt, 3),
        "triangles": int(len(mesh.faces)),
        "volume": round(float(mesh.volume), 1),
        "bbox": [round(float(v), 2) for v in mesh.extents],
    }
OUT["tolerance_sweep"] = sweep
print(json.dumps(sweep, indent=1))

# ---------- B. IGES negative test ----------
section("B. IGES through cascadio (expect failure)")
try:
    cascadio.step_to_glb(os.path.join(DATA, "microstrip.igs"), os.path.join(HERE, "igs.glb"))
    OUT["iges"] = "UNEXPECTEDLY SUCCEEDED"
except Exception as exc:  # noqa: BLE001
    OUT["iges"] = f"raised {type(exc).__name__}: {exc}"
print(OUT["iges"])

# ---------- C. DXF chain ----------
section("C. DXF chain")
import ezdxf
from manifold3d import CrossSection, FillRule, Manifold

OUT["ezdxf_version"] = ezdxf.__version__


def flatten(path_, distance=0.01):
    pts = [np.array([v.x, v.y], dtype=np.float64) for v in path_.flattening(distance)]
    a = np.asarray(pts)
    if not np.allclose(a[0], a[-1]):
        a = np.vstack([a, a[0]])
    return a


def loops_to_crosssection(loops):
    return CrossSection([np.asarray(lp, dtype=np.float32) for lp in loops], fillrule=FillRule.EvenOdd)


def build_profile_dxf(path, units_code):
    doc = ezdxf.new("R2010")
    doc.units = units_code
    doc.header["$INSUNITS"] = units_code
    msp = doc.modelspace()
    msp.add_lwpolyline([(0, 0), (40, 0), (40, 40), (0, 40)], close=True, dxfattribs={"layer": "outer"})
    msp.add_circle((20, 20), radius=6, dxfattribs={"layer": "hole"})
    doc.saveas(path)
    return path


build_profile_dxf(os.path.join(DATA, "profile-mm.dxf"), 4)      # mm
build_profile_dxf(os.path.join(DATA, "profile-inch.dxf"), 1)    # inch

results = {}
for fname in ["profile-mm.dxf", "profile-inch.dxf"]:
    doc = ezdxf.readfile(os.path.join(DATA, fname))
    msp = doc.modelspace()
    t0 = time.perf_counter()
    loops = []
    for e in msp:
        loops.append(flatten(ezdxf.path.make_path(e)))
    dt = time.perf_counter() - t0
    cs = loops_to_crosssection(loops)
    solid = cs.extrude(10.0)
    m = solid.to_mesh()
    entry = {
        "doc_units": doc.units,
        "loops": len(loops),
        "extrude_s": round(time.perf_counter() - t0, 3),
        "volume": round(float(solid.volume()), 1),
        "genus": int(solid.genus()),
        "triangles": int(len(m.tri_verts)),
        "status_ok": bool(solid.status() == 0 if hasattr(solid, "status") else True),
    }
    results[fname] = entry
    print(fname, json.dumps(entry))

expected_mm = (40 * 40 - np.pi * 6 * 6) * 10
results["_expected_mm3"] = round(expected_mm, 1)
results["_inch_ratio_expected"] = round(25.4**3, 2)
OUT["dxf_profiles"] = results

# 3D mesh entity: POLYFACE mesh box 20mm
section("C2. DXF 3D polyface")
doc = ezdxf.new("R2010")
doc.units = 4
msp = doc.modelspace()
s = 20.0
V = [(0, 0, 0), (s, 0, 0), (s, s, 0), (0, s, 0), (0, 0, s), (s, 0, s), (s, s, s), (0, s, s)]
F = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
polyface = msp.add_polyface()
for f in F:
    polyface.append_faces([[V[i] for i in f]])
dxf3d = os.path.join(DATA, "polyface-box.dxf")
doc.saveas(dxf3d)

doc2 = ezdxf.readfile(dxf3d)
from ezdxf.disassemble import recursive_decompose, to_primitives  # noqa: E402

prims = list(to_primitives(recursive_decompose(doc2.modelspace())))
soup = []
for p in prims:
    if p.mesh is not None:
        mb = p.mesh
        for face in mb.faces:
            idx = list(face)
            for k in range(1, len(idx) - 1):  # fan triangulation of the n-gon
                soup.append([mb.vertices[idx[0]], mb.vertices[idx[k]], mb.vertices[idx[k + 1]]])
soup = np.asarray([(v.x, v.y, v.z) for tri in soup for v in tri], dtype=np.float64)
welded, faces, degenerate = np.unique(soup.round(6), axis=0, return_inverse=True), None, 0
# simple weld: unique verts -> faces by index
uniq, inv = np.unique(soup.round(6), axis=0, return_inverse=True)
faces2 = inv.reshape(-1, 3)
man = Manifold.__new__(Manifold)  # placeholder to keep import; real check below
from manifold3d import Mesh as M3Mesh  # noqa: E402

solid3d = Manifold(M3Mesh(uniq.astype(np.float32), faces2.astype(np.uint32)))
OUT["dxf_polyface"] = {
    "soup_triangles": int(len(soup)),
    "welded_vertices": int(len(uniq)),
    "status_ok": bool(solid3d.status() == 0),
    "volume": round(float(solid3d.volume()), 1),
    "genus": int(solid3d.genus()),
    "expected_volume": float(s**3),
}
print(json.dumps(OUT["dxf_polyface"]))

# binary DXF round-trip
section("C3. binary DXF round-trip")
doc = ezdxf.readfile(os.path.join(DATA, "profile-mm.dxf"))
bin_path = os.path.join(DATA, "profile-bin.dxf")
try:
    doc.write(bin_path, fmt="binary")
    doc3 = ezdxf.readfile(bin_path)
    OUT["dxf_binary"] = {"written": True, "entities_after_read": len(doc3.modelspace())}
except Exception as exc:  # noqa: BLE001
    OUT["dxf_binary"] = f"raised {type(exc).__name__}: {exc}"
print(OUT["dxf_binary"])

with open(os.path.join(HERE, "result.json"), "w") as handle:
    json.dump(OUT, handle, indent=1)
print("\nresult.json written")
