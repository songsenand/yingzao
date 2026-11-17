#!/usr/bin/env python3
"""Generate the v0 standard-parts geometry from library/catalog.json.

Usage:
  cd library/generator
  .venv/bin/python generate.py

The generator is an authoring/build-time tool, not plugin runtime code. It writes
STEP + STL + part.json under library/parts and then updates catalog.json with the
relative model paths and hashes. No B-rep kernel is needed to *use* the library.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import shutil
import struct
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import cadquery as cq

from dimensions import (
    BEARING,
    DATUMS,
    DIMENSION_SOURCE,
    FLAT_WASHER,
    HEX_BOLT,
    HEX_NUT,
    RETAINING_RING,
    SHAFT_COLLAR,
    SOCKET_CAP,
    SPRING_WASHER,
)

LIB = Path(__file__).resolve().parents[1]
DEFAULT_CATALOG = LIB / "catalog.json"
DEFAULT_OUT = LIB / "parts"
TOL = 0.05
ANG = 0.3
GEN_VERSION = "0.1.0-v0"


def hex_workplane(across_flats: float):
    # CadQuery's polygon diameter is the circumscribed circle.
    return cq.Workplane("XY").polygon(6, across_flats / math.cos(math.pi / 6))


def c_ring(inner_d: float, outer_d: float, thickness: float, gap: float):
    ring = cq.Workplane("XY").circle(outer_d / 2).circle(inner_d / 2).extrude(thickness)
    gap_box = cq.Workplane("XY").box(outer_d / 2, max(0.4, gap), thickness * 2).translate(
        (outer_d / 4, 0, thickness)
    )
    return ring.cut(gap_box)


def bolt(d: float, length: float, af: float, k: float):
    head = hex_workplane(af).extrude(k)
    shank = cq.Workplane("XY").circle(d / 2).extrude(length).translate((0, 0, -length))
    return head.union(shank)


def socket_cap(d: float, length: float, head_d: float, k: float):
    head = cq.Workplane("XY").circle(head_d / 2).extrude(k)
    shank = cq.Workplane("XY").circle(d / 2).extrude(length).translate((0, 0, -length))
    return head.union(shank)


def socket_cap_visual(d: float, length: float, head_d: float, k: float):
    part = socket_cap(d, length, head_d, k)
    socket = (
        cq.Workplane("XY")
        .polygon(6, head_d * 0.55 / math.cos(math.pi / 6))
        .extrude(k * 0.6)
        .translate((0, 0, k * 0.4))
    )
    return part.cut(socket)


def nut(d: float, af: float, m: float):
    body = hex_workplane(af).extrude(m)
    bore = cq.Workplane("XY").circle((d + 0.2) / 2).extrude(m + 2).translate((0, 0, -1))
    return body.cut(bore)


def flat_washer(id_mm: float, od_mm: float, t: float):
    return cq.Workplane("XY").circle(od_mm / 2).circle(id_mm / 2).extrude(t)


def spring_washer(id_mm: float, od_mm: float, t: float):
    return c_ring(id_mm, od_mm, t, max(0.5, t * 1.2))


def bearing_fit(bore: float, od: float, width: float):
    ring = max(1.0, (od - bore) * 0.12)
    outer = cq.Workplane("XY").circle(od / 2).circle(od / 2 - ring).extrude(width)
    inner = cq.Workplane("XY").circle(bore / 2 + ring).circle(bore / 2).extrude(width)
    return outer.union(inner)


def bearing_visual(bore: float, od: float, width: float):
    part = bearing_fit(bore, od, width)
    ring = max(1.0, (od - bore) * 0.12)
    gap = (od - bore) / 2 - 2 * ring
    ball_r = min(max(0.8, gap * 0.35), width * 0.35)
    pitch_r = (bore + od) / 4
    for i in range(8):
        a = 2 * math.pi * i / 8
        ball = cq.Workplane("XY").sphere(ball_r).translate(
            (pitch_r * math.cos(a), pitch_r * math.sin(a), width / 2)
        )
        part = part.union(ball)
    return part


def oring(inner_d: float, cs: float):
    return cq.Workplane("XY").add(cq.Solid.makeTorus((inner_d + cs) / 2, cs / 2))


def spring_fit(wire: float, od: float, free: float):
    inner = max(0.2, od / 2 - wire)
    return cq.Workplane("XY").circle(od / 2).circle(inner).extrude(free)


def spring_visual(wire: float, od: float, free: float):
    radius = od / 2 - wire / 2
    # The swept profile has a half-wire radius at each end; keep the visual
    # inside the fit envelope (0..free), otherwise the fit box is a lie.
    height = max(1.0, free - wire)
    turns = max(4, int(round(height / max(3 * wire, 1.0))))
    pitch = height / turns
    helix = cq.Wire.makeHelix(pitch=pitch, height=height, radius=radius)
    profile = cq.Workplane("XZ").center(radius, 0).circle(wire / 2)
    return profile.sweep(helix, isFrenet=True).translate((0, 0, wire / 2))


def build(family: str, spec: dict, lod: str):
    p = spec["params"]
    if family == "iso4014":
        d = float(p["thread"][1:])
        data = HEX_BOLT[p["thread"]]
        part = bolt(d, float(p["lengthMm"]), data["af"], data["k"])
        if lod == "visual":
            try:
                return part.edges("|Z").chamfer(0.25)
            except Exception:
                return part
        return part
    if family == "iso4762":
        d = float(p["thread"][1:])
        data = SOCKET_CAP[p["thread"]]
        return socket_cap_visual(d, float(p["lengthMm"]), data["head_d"], data["k"]) if lod == "visual" else socket_cap(d, float(p["lengthMm"]), data["head_d"], data["k"])
    if family == "iso4026":
        d = float(p["thread"][1:])
        return cq.Workplane("XY").circle(d / 2).extrude(float(p["lengthMm"]))
    if family == "iso4032":
        data = HEX_NUT[p["thread"]]
        part = nut(float(p["thread"][1:]), data["af"], data["m"])
        if lod == "visual":
            try:
                return part.edges("|Z").chamfer(0.3)
            except Exception:
                return part
        return part
    if family == "iso7040":
        data = HEX_NUT["M8"]
        part = nut(8.0, data["af"], data["m"])
        if lod == "visual":
            insert = cq.Workplane("XY").circle(data["af"] / 2 - 0.6).circle(4.2).extrude(1.2).translate((0, 0, data["m"] - 1.2))
            return part.union(insert)
        return part
    if family == "iso7089":
        data = FLAT_WASHER[p["thread"]]
        return flat_washer(data["id"], data["od"], data["t"])
    if family == "din127":
        data = SPRING_WASHER[p["thread"]]
        return spring_washer(data["id"], data["od"], data["t"])
    if family == "iso15":
        data = BEARING[spec["spec"]]
        return bearing_visual(data["bore"], data["od"], data["width"]) if lod == "visual" else bearing_fit(data["bore"], data["od"], data["width"])
    if family == "iso3601":
        return oring(float(p["innerDiameterMm"]), float(p["crossSectionMm"]))
    if family == "din471":
        data = RETAINING_RING[int(p["shaftDiameterMm"])]
        return c_ring(data["id"], data["od"], data["t"], max(0.6, data["t"] * 1.2))
    if family == "din6885":
        part = cq.Workplane("XY").box(float(p["lengthMm"]), float(p["widthMm"]), float(p["heightMm"]))
        try:
            return part.edges("|X").chamfer(0.4)
        except Exception:
            return part
    if family == "iso2338":
        return cq.Workplane("XY").circle(float(p["diameterMm"]) / 2).extrude(float(p["lengthMm"]))
    if family == "din2098":
        wire = float(p["wireDiameterMm"])
        od = float(p["outerDiameterMm"])
        free = float(p["freeLengthMm"])
        return spring_visual(wire, od, free) if lod == "visual" else spring_fit(wire, od, free)
    if family == "shaft-collar":
        data = SHAFT_COLLAR[int(p["boreMm"])]
        return cq.Workplane("XY").circle(data["od"] / 2).circle(float(p["boreMm"]) / 2).extrude(data["w"])
    raise KeyError(f"no builder for family {family}")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def stl_triangles(path: Path) -> int:
    with path.open("rb") as f:
        f.seek(80)
        return struct.unpack("<I", f.read(4))[0]


def bbox(shape) -> dict:
    bb = shape.val().BoundingBox()
    return {
        "min": [round(bb.xmin, 4), round(bb.ymin, 4), round(bb.zmin, 4)],
        "max": [round(bb.xmax, 4), round(bb.ymax, 4), round(bb.zmax, 4)],
        "size": [round(bb.xmax - bb.xmin, 4), round(bb.ymax - bb.ymin, 4), round(bb.zmax - bb.zmin, 4)],
    }


def inside(inner: dict, outer: dict, tolerance: float = 0.25) -> bool:
    return all(inner["min"][i] >= outer["min"][i] - tolerance and inner["max"][i] <= outer["max"][i] + tolerance for i in range(3))


def resolved_datums(family: str, bb: dict) -> dict:
    out = copy.deepcopy(DATUMS[family])
    for value in out.values():
        point = value.get("point")
        if point and point[2] is None:
            point[2] = bb["max"][2]
    return out


def export(shape, step: Path, stl: Path):
    step.parent.mkdir(parents=True, exist_ok=True)
    cq.exporters.export(shape, str(step), exportType="STEP")
    cq.exporters.export(shape, str(stl), exportType="STL", tolerance=TOL, angularTolerance=ANG)
    return {
        "step": step,
        "stl": stl,
        "stepSha256": sha256_file(step),
        "stlSha256": sha256_file(stl),
        "triangles": stl_triangles(stl),
    }


def model_ref(path: Path) -> str:
    return path.relative_to(LIB).as_posix()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--only", default=None, help="one spec id, for smoke testing")
    ap.add_argument("--keep", action="store_true", help="do not delete --out first")
    args = ap.parse_args()

    catalog = json.loads(args.catalog.read_text())
    specs = catalog["specs"]
    if args.only:
        specs = [s for s in specs if s["id"] == args.only]
        if not specs:
            print(f"unknown spec id: {args.only}", file=sys.stderr)
            return 2
    if not args.keep and args.out.exists():
        shutil.rmtree(args.out)
    args.out.mkdir(parents=True, exist_ok=True)

    t0 = time.perf_counter()
    generated = 0
    for i, spec in enumerate(specs, 1):
        family = spec["family"]
        sid = spec["id"]
        print(f"[{i}/{len(specs)}] {sid}", flush=True)
        try:
            fit_shape = build(family, spec, "fit")
            fit_bb = bbox(fit_shape)
            fit_files = export(
                fit_shape,
                args.out / sid / "fit" / "model.step",
                args.out / sid / "fit" / "model.stl",
            )

            visual_mode = spec["lod"]["visual"]["mode"]
            if visual_mode == "alias-fit":
                visual_shape = fit_shape
                visual_bb = fit_bb
                visual_files = fit_files
            else:
                visual_shape = build(family, spec, "visual")
                visual_bb = bbox(visual_shape)
                if not inside(visual_bb, fit_bb):
                    raise RuntimeError(f"visual bbox escapes fit envelope: {visual_bb} vs {fit_bb}")
                visual_files = export(
                    visual_shape,
                    args.out / sid / "visual" / "model.step",
                    args.out / sid / "visual" / "model.stl",
                )

            fit_model = {
                "step": model_ref(fit_files["step"]),
                "stl": model_ref(fit_files["stl"]),
                "stepSha256": fit_files["stepSha256"],
                "stlSha256": fit_files["stlSha256"],
            }
            visual_model = (
                fit_model
                if visual_mode == "alias-fit"
                else {
                    "step": model_ref(visual_files["step"]),
                    "stl": model_ref(visual_files["stl"]),
                    "stepSha256": visual_files["stepSha256"],
                    "stlSha256": visual_files["stlSha256"],
                }
            )
            spec["status"] = "generated"
            spec["lod"]["fit"] = {"role": "fit", "status": "generated", "model": fit_model}
            spec["lod"]["visual"] = {"role": "render", "status": "generated", "model": visual_model, "mode": visual_mode}

            part = {
                "schemaVersion": 1,
                "id": sid,
                "family": family,
                "spec": spec["spec"],
                "package": spec["package"],
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "generator": {
                    "name": "cadquery",
                    "version": cq.__version__,
                    "toleranceMm": TOL,
                    "angularToleranceRad": ANG,
                    "versionTag": GEN_VERSION,
                },
                "dimensionSource": DIMENSION_SOURCE.get(family, "v0 generator table"),
                "datums": resolved_datums(family, fit_bb),
                "bboxMm": fit_bb,
                "volumeMm3": round(float(fit_shape.val().Volume()), 4),
                "fit": {
                    **fit_model,
                    "triangles": fit_files["triangles"],
                },
                "visual": {
                    **visual_model,
                    "mode": visual_mode,
                    "triangles": visual_files["triangles"],
                    "bboxMm": visual_bb,
                },
            }
            (args.out / sid / "part.json").write_text(json.dumps(part, indent=2, ensure_ascii=False) + "\n")
            generated += 1
        except Exception as e:  # noqa: BLE001
            print(f"ERROR {sid}: {type(e).__name__}: {e}", file=sys.stderr)
            return 1

    catalog["packages"]["core"]["status"] = "active"
    catalog["generatedAt"] = datetime.now(timezone.utc).date().isoformat()
    args.catalog.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n")
    elapsed = time.perf_counter() - t0
    print(f"\nGenerated {generated}/{len(specs)} specs in {elapsed:.2f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
