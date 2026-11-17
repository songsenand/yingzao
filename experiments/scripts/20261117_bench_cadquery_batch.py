#!/usr/bin/env python3
"""Batch benchmark: 300 realistic-ish library parts, fit vs visual LOD.

Run with:
  PYTHONPATH=$PWD/.tmp-cadquery .tmp-cadquery/... python .tmp-bench/bench_batch.py
"""
import json
import math
import os
import resource
import shutil
import statistics
import sys
import tempfile
import time
import zipfile
from pathlib import Path

T0 = time.perf_counter()
import cadquery as cq  # noqa: E402
IMPORT_S = time.perf_counter() - T0

OUT = Path(os.environ.get("BENCH_OUT", Path(tempfile.gettempdir()) / "cad-bench-batch"))
if OUT.exists():
    shutil.rmtree(OUT)
OUT.mkdir(parents=True)


def bolt(m, length):
    af = m * 1.5
    head_h = m * 0.65
    head = cq.Workplane("XY").polygon(6, af).extrude(head_h)
    shank = cq.Workplane("XY").circle(m / 2).extrude(length)
    return head.union(shank)


def nut(m):
    af = m * 1.5
    h = m * 0.8
    body = cq.Workplane("XY").polygon(6, af).extrude(h)
    hole = cq.Workplane("XY").circle(m * 0.46).extrude(h + 2)
    return body.cut(hole)


def washer(m):
    return cq.Workplane("XY").circle(m * 0.9).circle(m * 0.55).extrude(m * 0.15)


def bearing_fit(bore, od, w):
    outer = cq.Workplane("XY").circle(od / 2).circle(od / 2 - w * 0.3).extrude(w)
    inner = cq.Workplane("XY").circle(bore / 2 + w * 0.4).circle(bore / 2).extrude(w)
    return outer.union(inner)


def bearing_visual(bore, od, w):
    part = bearing_fit(bore, od, w)
    pitch = (bore / 2 + w * 0.4 + od / 2 - w * 0.3) / 2
    ball_r = (od - bore) * 0.08
    for i in range(9):
        a = 2 * math.pi * i / 9
        ball = cq.Workplane("XY").sphere(ball_r).translate((pitch * math.cos(a), pitch * math.sin(a), 0))
        part = part.union(ball)
    return part


def oring(center_r, cs):
    return cq.Workplane("XY").add(cq.Solid.makeTorus(center_r, cs / 2))


def spring_visual(wire, od, length):
    pitch = max(wire * 2.5, 2)
    helix = cq.Wire.makeHelix(pitch=pitch, height=length, radius=od / 2 - wire / 2)
    profile = cq.Workplane("XZ").center(od / 2 - wire / 2, 0).circle(wire / 2)
    return profile.sweep(helix, isFrenet=True)


def spring_fit(wire, od, length):
    return cq.Workplane("XY").circle(od / 2).circle(max(0.5, od / 2 - wire)).extrude(length)


def key(l, w, h):
    return cq.Workplane("XY").box(l, w, h)


def pin(d, l):
    return cq.Workplane("XY").circle(d / 2).extrude(l).edges(">Z").chamfer(d * 0.05)


def build_set(visual_bearings, visual_springs):
    jobs = []
    # 60 fasteners: 5 sizes x 4 lengths x (bolt, nut, washer)
    for m in (6, 8, 10, 12, 16):
        for length in (20, 30, 40, 60):
            jobs.append((f"bolt_M{m}x{length}", lambda m=m, length=length: bolt(m, length)))
            jobs.append((f"nut_M{m}", lambda m=m: nut(m)))
            jobs.append((f"washer_M{m}", lambda m=m: washer(m)))
    # 60 bearings: 20 sizes x fit/visual
    for i, (bore, od, w) in enumerate([(10, 26, 8), (12, 28, 8), (15, 32, 9), (17, 35, 10), (20, 42, 12),
                                       (25, 47, 12), (30, 55, 13), (35, 62, 14), (40, 68, 15), (45, 75, 16)] * 3):
        jobs.append((f"bearing_{bore}x{od}x{w}_fit_{i}", lambda b=bore, o=od, w=w: bearing_fit(b, o, w)))
        if visual_bearings:
            jobs.append((f"bearing_{bore}x{od}x{w}_visual_{i}", lambda b=bore, o=od, w=w: bearing_visual(b, o, w)))
        else:
            jobs.append((f"bearing_{bore}x{od}x{w}_fit_{i}_b", lambda b=bore, o=od, w=w: bearing_fit(b, o, w)))
    # 60 O-rings
    for i in range(60):
        cr = 15 + i * 1.25
        jobs.append((f"oring_{i}", lambda cr=cr: oring(cr, 3)))
    # 50 springs
    for i in range(50):
        wire = 1 + (i % 5) * 0.5
        od = 10 + (i % 6) * 4
        length = 25 + (i % 5) * 10
        if visual_springs:
            jobs.append((f"spring_{i}", lambda w=wire, o=od, l=length: spring_visual(w, o, l)))
        else:
            jobs.append((f"spring_{i}", lambda w=wire, o=od, l=length: spring_fit(w, o, l)))
    # 70 keys/pins
    for i in range(35):
        jobs.append((f"key_{i}", lambda i=i: key(20 + i, 6 + i % 5, 4 + i % 3)))
        jobs.append((f"pin_{i}", lambda i=i: pin(4 + i % 4, 20 + i)))
    return jobs


def run(label, visual_bearings, visual_springs):
    jobs = build_set(visual_bearings, visual_springs)
    assert len(jobs) == 300, len(jobs)
    t_all = time.perf_counter()
    total_build = total_step = total_stl = 0.0
    raw = 0
    for name, fn in jobs:
        t = time.perf_counter()
        shape = fn()
        total_build += time.perf_counter() - t
        t = time.perf_counter()
        cq.exporters.export(shape, str(OUT / f"{name}.step"), exportType="STEP")
        total_step += time.perf_counter() - t
        t = time.perf_counter()
        cq.exporters.export(shape, str(OUT / f"{name}.stl"), exportType="STL", tolerance=0.05, angularTolerance=0.3)
        total_stl += time.perf_counter() - t
    wall = time.perf_counter() - t_all
    for p in OUT.iterdir():
        raw += p.stat().st_size
    zip_path = OUT / f"{label}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for p in sorted(OUT.iterdir()):
            if p.suffix in (".step", ".stl"):
                z.write(p, arcname=p.name)
    rec = {
        "label": label,
        "parts": len(jobs),
        "wall_s": round(wall, 3),
        "build_s": round(total_build, 3),
        "step_s": round(total_step, 3),
        "stl_s": round(total_stl, 3),
        "raw_mb": round(raw / 1e6, 1),
        "zip_mb": round(zip_path.stat().st_size / 1e6, 1),
        "zip_ratio": round(zip_path.stat().st_size / raw, 3),
        "max_rss_kb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
    }
    print(json.dumps(rec, ensure_ascii=False))
    # remove artifacts so the next run is clean; keep zip only
    for p in OUT.iterdir():
        if p.suffix in (".step", ".stl"):
            p.unlink()
    return rec


if __name__ == "__main__":
    print(json.dumps({"import_s": round(IMPORT_S, 3), "cpu_count": os.cpu_count(), "cadquery": cq.__version__}))
    run("fit_300", visual_bearings=False, visual_springs=False)
    run("mixed_300", visual_bearings=True, visual_springs=True)
