#!/usr/bin/env python3
"""Leaf-spring beam probe for the two-color click pen.

This is NOT the plugin's stress/FEA result. It recomputes the hand estimate in
README.md §2.3 under four boundary conditions, because the barrel web does not
declare whether the 0.8 mm PP leaf is a cantilever, simply supported, or
fixed-fixed. The spread is the point: the same 8 mm travel gives very different
force and root strain.

Inputs from scad/leaf_spring.scad:
  L = 13 mm, w = 4 mm, t = 0.8 mm; loads at x=+4.8 (black) and x=-5.0 (red).
E = 1500 MPa is a PP assumption, not a measured grade.

Run: python3 evidence/leaf_spring.py
"""
from __future__ import annotations

import json
import math
from pathlib import Path

E = 1500.0  # MPa, assumed PP; not measured
L = 13.0
W = 4.0
T = 0.8
DELTA = 8.0  # mm of carrier travel the leaf is asked to absorb
A = 4.8  # black pusher
B = L - A

I = W * T**3 / 12.0


def cantilever(lever: float) -> dict:
    k = 3 * E * I / lever**3
    force = k * DELTA
    strain = 1.5 * T * DELTA / lever**2
    return {
        "model": f"cantilever L={lever:.1f}mm",
        "k_N_per_mm": round(k, 4),
        "force_N_at_8mm": round(force, 2),
        "root_strain_pct": round(strain * 100, 2),
        "delta_over_L": round(DELTA / lever, 3),
        "linear_beam_valid": DELTA / lever <= 0.1,
    }


def simply_supported() -> dict:
    k = 3 * E * I * L / (A**2 * B**2)
    force = k * DELTA
    moment = force * A * B / L
    stress = 6 * moment / (W * T**2)
    strain = stress / E
    return {
        "model": "simply supported, load at x=+4.8mm",
        "k_N_per_mm": round(k, 4),
        "force_N_at_8mm": round(force, 2),
        "max_strain_pct": round(strain * 100, 2),
        "delta_over_L": round(DELTA / L, 3),
        "linear_beam_valid": DELTA / L <= 0.1,
    }


def fixed_fixed() -> dict:
    k = 3 * E * I * L**3 / (A**3 * B**3)
    force = k * DELTA
    moment = 2 * force * A**2 * B**2 / L**3
    stress = 6 * moment / (W * T**2)
    strain = stress / E
    return {
        "model": "fixed-fixed, load at x=+4.8mm",
        "k_N_per_mm": round(k, 4),
        "force_N_at_8mm": round(force, 2),
        "max_strain_pct": round(strain * 100, 2),
        "delta_over_L": round(DELTA / L, 3),
        "linear_beam_valid": DELTA / L <= 0.1,
    }


result = {
    "inputs": {"E_MPa": E, "L_mm": L, "w_mm": W, "t_mm": T, "delta_mm": DELTA, "load_at_mm": A},
    "second_moment_mm4": round(I, 5),
    "cases": [cantilever(11.3), cantilever(13.0), simply_supported(), fixed_fixed()],
    "warnings": [
        "E=1500 MPa is an assumption; PP grade is not declared.",
        "pusher-post and carrier-arm compliance are not included.",
        "the barrel web's actual support condition is not declared in CAD.",
        "delta/L > 0.1 means the linear beam result is not a valid answer.",
    ],
}
out = Path(__file__).with_suffix(".json")
out.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
print(json.dumps(result, indent=2))
