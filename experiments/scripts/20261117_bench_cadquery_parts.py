#!/usr/bin/env python3
"""Benchmark CadQuery generation/export for representative standard parts.

Run with the bundled Python and the benchmark install:
  PYTHONPATH=$PWD/.tmp-cadquery /home/songsenand/.dsh/cad/runtime/venv/bin/python \
    .tmp-bench/bench_cadquery.py

No repository files are written; artifacts go under .tmp-bench/out.
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

T_PROCESS = time.perf_counter()
import cadquery as cq  # noqa: E402
T_IMPORT = time.perf_counter() - T_PROCESS

OUT = Path(os.environ.get("BENCH_OUT", Path(tempfile.gettempdir()) / "cad-bench-parts"))
OUT.mkdir(parents=True, exist_ok=True)


def hex_bolt():
    af = 24.0       # M16 across flats
    head_h = 10.0
    d = 16.0
    length = 60.0
    head = cq.Workplane("XY").polygon(6, af).extrude(head_h)
    shank = cq.Workplane("XY").circle(d / 2).extrude(length)
    return head.union(shank)


def hex_nut():
    af = 24.0
    h = 13.0
    bore = 14.7
    body = cq.Workplane("XY").polygon(6, af).extrude(h)
    hole = cq.Workplane("XY").circle(bore / 2).extrude(h + 2)
    return body.cut(hole)


def flat_washer():
    return cq.Workplane("XY").circle(30 / 2).circle(17 / 2).extrude(3)


def parallel_key():
    return cq.Workplane("XY").box(70, 14, 9)


def dowel_pin():
    return cq.Workplane("XY").circle(5).extrude(40).edges(">Z").chamfer(0.5)


def bearing_fit():
    # 6005: 25 x 47 x 12; simplified rings only
    outer = cq.Workplane("XY").circle(47 / 2).circle(47 / 2 - 4).extrude(12)
    inner = cq.Workplane("XY").circle(25 / 2 + 5).circle(25 / 2).extrude(12)
    return outer.union(inner)


def bearing_visual():
    part = bearing_fit()
    pitch_r = (25 / 2 + 5 + 47 / 2 - 4) / 2
    for i in range(9):
        a = 2 * math.pi * i / 9
        ball = cq.Workplane("XY").sphere(3.5).translate((pitch_r * math.cos(a), pitch_r * math.sin(a), 0))
        part = part.union(ball)
    return part


def oring():
    # ID 50, CS 3 -> torus center radius 26.5
    return cq.Workplane("XY").add(cq.Solid.makeTorus(26.5, 1.5))


def compression_spring():
    helix = cq.Wire.makeHelix(pitch=5, height=50, radius=10)
    profile = cq.Workplane("XZ").center(10, 0).circle(1)
    return profile.sweep(helix, isFrenet=True)


def threaded_bolt_proxy():
    # A helical thread proxy: shank + swept circular profile around it.
    shank = cq.Workplane("XY").circle(8).extrude(60)
    helix = cq.Wire.makeHelix(pitch=2, height=50, radius=8.5)
    profile = cq.Workplane("XZ").center(8.5, 0).circle(1.2)
    thread = profile.sweep(helix, isFrenet=True)
    return shank.union(thread)


CASES = [
    ("hex_bolt_M16x60_fit", hex_bolt),
    ("hex_nut_M16_fit", hex_nut),
    ("flat_washer_M16_fit", flat_washer),
    ("parallel_key_14x9x70_fit", parallel_key),
    ("dowel_pin_10x40_fit", dowel_pin),
    ("bearing_6005_fit", bearing_fit),
    ("bearing_6005_visual", bearing_visual),
    ("oring_50x3_fit", oring),
    ("compression_spring_2x20x50_visual", compression_spring),
    ("threaded_bolt_M16_proxy_visual", threaded_bolt_proxy),
]


def export(shape, stem):
    step = OUT / f"{stem}.step"
    stl = OUT / f"{stem}.stl"
    t = time.perf_counter()
    cq.exporters.export(shape, str(step), exportType="STEP")
    step_s = time.perf_counter() - t
    t = time.perf_counter()
    cq.exporters.export(shape, str(stl), exportType="STL", tolerance=0.05, angularTolerance=0.3)
    stl_s = time.perf_counter() - t
    return step_s, stl_s, step.stat().st_size, stl.stat().st_size


def main():
    results = []
    for name, fn in CASES:
        # Warm-up: first OCP tessellation and exporter call are not representative.
        t = time.perf_counter()
        try:
            shape = fn()
            warm_build = time.perf_counter() - t
            t = time.perf_counter()
            valid = bool(shape.val().isValid())
            warm_valid = time.perf_counter() - t
            warm = export(shape, f"{name}_warm")
        except Exception as e:  # noqa: BLE001
            results.append({"name": name, "error": f"{type(e).__name__}: {e}"})
            print(f"ERROR {name}: {type(e).__name__}: {e}", file=sys.stderr)
            continue

        builds, steps, stls = [], [], []
        step_sizes, stl_sizes = [], []
        for i in range(3):
            t = time.perf_counter()
            shape = fn()
            builds.append(time.perf_counter() - t)
            ss, ts, szs, szt = export(shape, f"{name}_{i}")
            steps.append(ss)
            stls.append(ts)
            step_sizes.append(szs)
            stl_sizes.append(szt)

        rec = {
            "name": name,
            "valid": valid,
            "warm_build_s": round(warm_build, 4),
            "warm_export_step_s": round(warm[0], 4),
            "warm_export_stl_s": round(warm[1], 4),
            "build_s_median": round(statistics.median(builds), 4),
            "export_step_s_median": round(statistics.median(steps), 4),
            "export_stl_s_median": round(statistics.median(stls), 4),
            "step_bytes": int(statistics.median(step_sizes)),
            "stl_bytes": int(statistics.median(stl_sizes)),
            "build_s": [round(x, 4) for x in builds],
            "export_step_s": [round(x, 4) for x in steps],
            "export_stl_s": [round(x, 4) for x in stls],
        }
        results.append(rec)
        print(json.dumps(rec, ensure_ascii=False))

    # Compressed artifact pack: all measured STEP+STL, deflated.
    zip_path = OUT / "artifacts.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for p in sorted(OUT.iterdir()):
            if p.suffix in (".step", ".stl"):
                z.write(p, arcname=p.name)
    raw_bytes = sum(p.stat().st_size for p in OUT.iterdir() if p.suffix in (".step", ".stl"))
    zip_bytes = zip_path.stat().st_size

    payload = {
        "python": sys.version,
        "cadquery": cq.__version__,
        "cpu_count": os.cpu_count(),
        "import_s": round(T_IMPORT, 4),
        "max_rss_kb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        "results": results,
        "raw_artifact_bytes": raw_bytes,
        "zip_artifact_bytes": zip_bytes,
        "zip_ratio": round(zip_bytes / raw_bytes, 4) if raw_bytes else None,
    }
    (OUT / "results.json").write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    print(json.dumps({k: v for k, v in payload.items() if k != "results"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
