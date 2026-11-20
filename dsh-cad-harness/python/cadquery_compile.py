#!/usr/bin/env python3
"""Compile one CadQuery authoring script to STL + the shared DatumSet schema.

Invoked by src/host/backends/cadquery.ts in a subprocess with the pack on
PYTHONPATH. The result file is ALWAYS written (success or classified failure)
so the Node side can report a code + fix instead of guessing from stderr.

Authoring contract for L1.2 (L1.5 documents it for users):
  result = cq.Workplane(...) ...        # or show_object(result)
  datum("name", [x, y, z])
  datum_axis("name", [x,y,z], [dx,dy,dz])
  datum_plane("name", [x,y,z], [nx,ny,nz])
  datum_cyl("name", [x,y,z], [dx,dy,dz], radius)
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import traceback
from pathlib import Path
from typing import Any


def write_result(path: str, payload: dict[str, Any]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def vec3(value: Any, what: str) -> list[float]:
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise ValueError(f"{what} must be [x, y, z], got {value!r}")
    out = [float(v) for v in value]
    if not all(math.isfinite(v) for v in out):
        raise ValueError(f"{what} must be finite numbers, got {value!r}")
    return out


def failure(code: str, message: str, fix: str, **extra: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {"ok": False, "error_code": code, "message": message, "fix": fix}
    payload.update(extra)
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--stl", required=True)
    parser.add_argument("--result", required=True)
    parser.add_argument("--tolerance", type=float, default=0.01)
    parser.add_argument("--angular-tolerance", type=float, default=0.1)
    parser.add_argument("--step", default=None, help="optional native STEP output path")
    args = parser.parse_args()

    try:
        import cadquery as cq
    except Exception as error:  # noqa: BLE001 - every import failure is classified
        write_result(args.result, failure(
            "cadquery_import",
            f"cannot import cadquery from the pack: {error}",
            "reinstall the CadQuery pack (dsh-cad-doctor prints the exact command)",
            traceback=traceback.format_exc()[-4000:],
        ))
        return 0

    datums: dict[str, list[dict[str, Any]]] = {
        "points": [], "axes": [], "planes": [], "cylinders": [],
    }

    def datum(name: Any, point: Any) -> None:
        datums["points"].append({"name": str(name), "point": vec3(point, f"datum({name!r}) point")})

    def datum_axis(name: Any, point: Any, direction: Any) -> None:
        datums["axes"].append({
            "name": str(name),
            "point": vec3(point, f"datum_axis({name!r}) point"),
            "dir": vec3(direction, f"datum_axis({name!r}) direction"),
        })

    def datum_plane(name: Any, point: Any, normal: Any) -> None:
        datums["planes"].append({
            "name": str(name),
            "point": vec3(point, f"datum_plane({name!r}) point"),
            "normal": vec3(normal, f"datum_plane({name!r}) normal"),
        })

    def datum_cyl(name: Any, point: Any, direction: Any, radius: Any) -> None:
        datums["cylinders"].append({
            "name": str(name),
            "point": vec3(point, f"datum_cyl({name!r}) point"),
            "dir": vec3(direction, f"datum_cyl({name!r}) direction"),
            "radius": float(radius),
        })

    namespace: dict[str, Any] = {
        "__name__": "__main__",
        "__file__": args.source,
        "cadquery": cq,
        "cq": cq,
        "result": None,
        "datum": datum,
        "datum_axis": datum_axis,
        "datum_plane": datum_plane,
        "datum_cyl": datum_cyl,
    }

    def show_object(obj: Any, name: Any = None, **kwargs: Any) -> None:  # noqa: ARG001
        namespace["result"] = obj

    namespace["show_object"] = show_object

    source = Path(args.source).read_text(encoding="utf-8")
    try:
        code = compile(source, args.source, "exec")
    except SyntaxError as error:
        write_result(args.result, failure(
            "cadquery_syntax",
            f"Python syntax error: {error.msg}",
            f"fix the syntax at line {error.lineno or '?'}, column {error.offset or '?'}",
            line=error.lineno, column=error.offset, traceback=traceback.format_exc()[-4000:],
        ))
        return 0

    try:
        exec(code, namespace)  # noqa: S102 - this is the authoring contract
    except SystemExit as error:
        # `sys.exit()` is a normal Python gesture but a provider contract break:
        # without a result.json the host can only report "crash (exit 0)".
        write_result(args.result, failure(
            "cadquery_exit",
            f"the script called sys.exit({error.code!r}); it must leave a result instead",
            "remove sys.exit() and assign `result` or call show_object(...)",
            traceback=traceback.format_exc()[-4000:],
        ))
        return 0
    except Exception as error:  # noqa: BLE001 - classify every model failure
        tb = traceback.extract_tb(error.__traceback__)
        line = tb[-1].lineno if tb else None
        write_result(args.result, failure(
            "cadquery_exception",
            f"{type(error).__name__}: {error}",
            "read the traceback; the model script raised before producing a shape",
            line=line, traceback=traceback.format_exc()[-4000:],
        ))
        return 0

    result = namespace.get("result")
    if result is None:
        write_result(args.result, failure(
            "cadquery_no_result",
            "the script produced no result",
            "set `result = ...` or call `show_object(...)`",
        ))
        return 0
    if not isinstance(result, (cq.Workplane, cq.Shape)):
        write_result(args.result, failure(
            "cadquery_bad_result",
            f"result is {type(result).__name__}, not a CadQuery Workplane/Shape",
            "assign a Workplane or Shape to `result` (an Assembly is not supported in L1.2)",
        ))
        return 0

    try:
        shape = result.val() if isinstance(result, cq.Workplane) else result
        sketch_only = shape.ShapeType() in ("WIRE", "EDGE", "VERTEX")
        if sketch_only:
            raise ValueError("result is a sketch/wire, not a solid; extrude/revolve it first")
        cq.exporters.export(
            result,
            args.stl,
            tolerance=args.tolerance,
            angularTolerance=args.angular_tolerance,
        )
    except Exception as error:  # noqa: BLE001 - export is part of the provider contract
        write_result(args.result, failure(
            "cadquery_export",
            f"STL export failed: {error}",
            "check that the result is a closed solid and that the pack is complete",
            traceback=traceback.format_exc()[-4000:],
        ))
        return 0

    if not os.path.exists(args.stl) or os.path.getsize(args.stl) == 0:
        write_result(args.result, failure(
            "cadquery_export",
            "STL export produced no bytes",
            "check that the result is a solid with non-zero volume",
        ))
        return 0

    warnings: list[str] = []
    brep_valid: bool | None = None
    try:
        from OCP.BRepCheck import BRepCheck_Analyzer
        brep_valid = bool(BRepCheck_Analyzer(shape.wrapped).IsValid())
        if not brep_valid:
            warnings.append("OCP BRepCheck reports the resulting B-rep as invalid")
    except Exception as error:  # noqa: BLE001 - validity is reported, not hidden
        warnings.append(f"BRepCheck unavailable: {error}")

    if args.step:
        if brep_valid is False:
            write_result(args.result, failure(
                "cadquery_invalid_brep",
                "OCP BRepCheck reports the B-rep as invalid; refusing to export STEP",
                "repair the model (unclosed shell / self-intersection) before requesting STEP",
                brepValid=False,
            ))
            return 0
        try:
            cq.exporters.export(result, args.step, "STEP")
        except Exception as error:  # noqa: BLE001 - STEP is a provider artifact
            write_result(args.result, failure(
                "cadquery_step_export",
                f"STEP export failed: {error}",
                "check that the result is a solid and the pack includes OCP.STEPControl",
                traceback=traceback.format_exc()[-4000:],
            ))
            return 0
        if not os.path.exists(args.step) or os.path.getsize(args.step) == 0:
            write_result(args.result, failure(
                "cadquery_step_export",
                "STEP export produced no bytes",
                "check that the result is a solid with non-zero volume",
            ))
            return 0

    write_result(args.result, {
        "ok": True,
        "version": getattr(cq, "__version__", "unknown"),
        "datums": datums,
        "warnings": warnings,
        "brepValid": brep_valid,
        "toleranceMm": args.tolerance,
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
