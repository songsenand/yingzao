#!/usr/bin/env python3
"""M1 sample probe: report AABB overlap between 'leg' and 'rail'.

This is deliberately small. A real checker would read STL and compute mesh
intersection; the protocol is the point here, not the geometry kernel.
"""
import json
import sys


def main() -> int:
    doc = json.load(sys.stdin)
    parts = {p["id"]: p for p in (doc.get("geometry", {}).get("parts") or [])}
    missing = [name for name in ("leg", "rail") if name not in parts]
    if missing:
        out = {
            "apiVersion": "checker/v1",
            "checker": {"id": "leg-fit", "version": "0.1.0"},
            "status": "blocked",
            "findings": [{
                "criterion": "fit.interference",
                "verdict": "blocked",
                "measured": 0,
                "limit": 0,
                "unit": "mm3",
                "witness": {"kind": "missing-input", "parts": missing},
                "attention": [{"kind": "input", "note": "geometry.parts must contain leg and rail"}],
                "message": "missing parts: " + ", ".join(missing),
            }],
            "coverage": {"criteria": [], "complete": False, "skipped": [
                {"criterion": "fit.interference", "reason": "missing geometry"}
            ]},
            "artifacts": [],
        }
        print(json.dumps(out))
        return 0

    a = parts["leg"]["aabb"]
    b = parts["rail"]["aabb"]
    dx = min(a["max"][0], b["max"][0]) - max(a["min"][0], b["min"][0])
    dy = min(a["max"][1], b["max"][1]) - max(a["min"][1], b["min"][1])
    dz = min(a["max"][2], b["max"][2]) - max(a["min"][2], b["min"][2])
    volume = max(0.0, dx) * max(0.0, dy) * max(0.0, dz)

    out = {
        "apiVersion": "checker/v1",
        "checker": {"id": "leg-fit", "version": "0.1.0"},
        "status": "pass" if volume == 0 else "fail",
        "findings": [],
        "coverage": {"criteria": ["fit.interference"], "complete": True, "skipped": []},
        "artifacts": [],
    }
    if volume > 0:
        out["status"] = "fail"
        out["findings"] = [{
            "criterion": "fit.interference",
            "verdict": "fail",
            "measured": volume,
            "limit": 0,
            "unit": "mm3",
            "witness": {
                "kind": "aabb-overlap",
                "parts": ["leg", "rail"],
                "volumeMm3": volume,
            },
            "attention": [{
                "kind": "part-pair",
                "a": "leg",
                "b": "rail",
                "where": [max(a["min"][0], b["min"][0]),
                          max(a["min"][1], b["min"][1]),
                          max(a["min"][2], b["min"][2])],
                "note": "leg/rail AABB overlap; inspect the top tenon fit",
            }],
            "message": "leg/rail AABB overlap",
        }]
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
