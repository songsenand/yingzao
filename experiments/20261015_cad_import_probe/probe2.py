#!/usr/bin/env python3
"""Probe round 2: settle the five open questions from probe.py."""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = {}

from manifold3d import CrossSection, Error, FillRule, Manifold, Mesh  # noqa: E402
import trimesh  # noqa: E402

print("Error.NoError =", Error.NoError, "| eq-self:", Error.NoError == Error.NoError)


def weld(soup):
    uniq, inv = np.unique(np.asarray(soup, dtype=np.float64).round(6), axis=0, return_inverse=True)
    return uniq, inv.reshape(-1, 3)


def manifold_verdict(verts, faces):
    m = Manifold(Mesh(verts.astype(np.float32), faces.astype(np.uint32)))
    status = m.status()
    ok = status == Error.NoError
    return {
        "status": str(status),
        "ok": bool(ok),
        "volume": round(float(m.volume()), 1) if ok else None,
        "genus": int(m.genus()) if ok else None,
    }


# ---- 1. STEP per-body truth: why did trimesh volume read 0? ----
print("\n== 1. STEP bodies ==")
for name in ["colored.step", "material.stp", "multibody.step"]:
    glb = os.path.join(HERE, f"{name}.glb")
    scene = trimesh.load(glb, process=False)
    per = {}
    for key, g in scene.geometry.items():
        v, f = np.asarray(g.vertices), np.asarray(g.faces)
        uniq, faces = weld(v[f].reshape(-1, 3))
        per[key[:24]] = manifold_verdict(uniq, faces) | {"tris": int(len(f))}
    # whole scene, welded, scaled meters->mm
    whole = scene.to_mesh()
    uniq, faces = weld(np.asarray(whole.vertices)[np.asarray(whole.faces)].reshape(-1, 3) * 1000.0)
    verdict = manifold_verdict(uniq, faces)
    OUT[name] = {
        "bodies": len(scene.geometry),
        "per_body": per,
        "x1000_mm": verdict,
        "bad_edges": None,
    }
    print(name, json.dumps(OUT[name], ensure_ascii=False))

# ---- 2. IGES produced what? ----
print("\n== 2. igs.glb content ==")
igs = os.path.join(HERE, "igs.glb")
OUT["igs_glb_bytes"] = os.path.getsize(igs) if os.path.exists(igs) else None
try:
    scene = trimesh.load(igs, process=False)
    geo = scene.geometry if hasattr(scene, "geometry") else {}
    OUT["igs_glb"] = {"bodies": len(geo), "triangles": int(sum(len(g.faces) for g in geo.values()))}
except Exception as exc:  # noqa: BLE001
    OUT["igs_glb"] = f"raised {type(exc).__name__}: {exc}"
print(json.dumps(OUT["igs_glb"]))

# ---- 3. tolerance semantics on a mm-scale part (colored.step = 10x10x20 mm) ----
print("\n== 3. tolerance sweep on colored.step ==")
import cascadio  # noqa: E402

sweep = {}
for tol in [None, 0.01, 0.002, 0.0005]:
    glb = os.path.join(HERE, "tol.glb")
    kwargs = {} if tol is None else {"tol_linear": tol}
    cascadio.step_to_glb(os.path.join(HERE, "data", "colored.step"), glb, **kwargs)
    mesh = trimesh.load(glb, force="mesh", process=False)
    uniq, faces = weld(np.asarray(mesh.vertices)[np.asarray(mesh.faces)].reshape(-1, 3) * 1000.0)
    v = manifold_verdict(uniq, faces)
    sweep[str(tol)] = {"tris": int(len(faces)), "volume_mm3": v["volume"]}
OUT["tol_sweep_mm_part"] = sweep
print(json.dumps(sweep))

# ---- 4. binary DXF via stream ----
print("\n== 4. binary DXF ==")
import ezdxf  # noqa: E402

doc = ezdxf.readfile(os.path.join(HERE, "data", "profile-mm.dxf"))
bin_path = os.path.join(HERE, "data", "profile-bin.dxf")
with open(bin_path, "wb") as stream:
    doc.write(stream, fmt="binary")
doc3 = ezdxf.readfile(bin_path)
OUT["dxf_binary"] = {"bytes": os.path.getsize(bin_path), "entities": len(doc3.modelspace())}
print(json.dumps(OUT["dxf_binary"]))

# ---- 5. proper status check for the extrude path ----
print("\n== 5. extrude status ==")
doc = ezdxf.readfile(os.path.join(HERE, "data", "profile-mm.dxf"))
loops = []
for e in doc.modelspace():
    pts = [np.array([v.x, v.y], dtype=np.float64) for v in ezdxf.path.make_path(e).flattening(0.01)]
    a = np.asarray(pts)
    if not np.allclose(a[0], a[-1]):
        a = np.vstack([a, a[0]])
    loops.append(a.astype(np.float32))
cs = CrossSection(loops, fillrule=FillRule.EvenOdd)
solid = cs.extrude(10.0)
print("status:", solid.status(), "| ok:", solid.status() == Error.NoError, "| volume:", solid.volume())

with open(os.path.join(HERE, "result2.json"), "w") as handle:
    json.dump(OUT, handle, indent=1)
print("\nresult2.json written")
