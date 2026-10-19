"""Self-test driver for `simulate_stress` — the numbers `accept-stress.mjs` asserts on.

Two cases, because the lane has two halves and they fail differently:

  * the CANTILEVER is the analytic judge (beam theory), and it is also where the
    "largest element stress is not a result" rule was measured;
  * the TOY-BALANCE BEAM is the real part whose members are thinner than the voxel.
    There the tool must REFUSE (drifting, zero trustworthy regions) while its
    integrals still match hand analysis — the negative control for the honesty half.

Prints one JSON object on stdout. Run it with the provisioned runtime python:

    python/stress-selftest  (see accept-stress.mjs for the exact interpreter)
"""

import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "python", "cad_worker"))
import trimesh  # noqa: E402

import stress_fem  # noqa: E402

OUT = {}

# ---- 1. cantilever vs beam theory -----------------------------------------
L, B, H = 100.0, 10.0, 10.0
E, NU, F = 200_000.0, 0.3, 100.0
I = B * H**3 / 12
delta_ref = F * L**3 / (3 * E * I)
sigma_ref = 6 * F * L / (B * H**2)

with tempfile.TemporaryDirectory() as tmp:
    beam = trimesh.creation.box(extents=[L, B, H])
    beam.apply_translation([L / 2, 0, 0])
    path = os.path.join(tmp, "cantilever.stl")
    beam.export(path)
    res = stress_fem.run(
        {
            "path": path,
            "dxMm": 1.25,
            "youngModulusMPa": E,
            "poissonRatio": NU,
            "yieldMPa": 50.0,
            "fixedFaces": [{"axis": "x", "side": "min"}],
            "loads": [{"face": {"axis": "x", "side": "max"}, "forceN": [0, -F, 0]}],
            "probeAtMm": [L, 0, 0],
            "resultants": [{"axis": "x", "atMm": 50.0}],
            "runConvergence": False,
            "fieldPath": os.path.join(tmp, "field.json"),
        }
    )
    with open(os.path.join(tmp, "field.json"), encoding="utf-8") as handle:
        field = json.load(handle)

    bad = [r for r in res["regions"] if r["tier"] == "bad" and r["surfaceExtrapolatedMPa"]]
    OUT["cantilever"] = {
        "dxMm": res["dxMm"],
        "solidCells": res["solidCells"],
        "deltaMm": -res["probeDisplacementMm"][1],
        "deltaRefMm": delta_ref,
        "deltaErrPct": 100 * (-res["probeDisplacementMm"][1] - delta_ref) / delta_ref,
        "momentNmm": res["resultants"][0]["momentNmm"]["z"],
        "momentRefNmm": -F * L / 2,
        "sigmaRefMPa": sigma_ref,
        "boundaryMaxMPa": res["maxVonMisesBoundaryMPa"],
        "peakDeclaredDepthMPa": res["peakDeclaredDepthMPa"],
        "surfaceExtrapolatedMPa": max((r["surfaceExtrapolatedMPa"] for r in bad), default=None),
        "surfaceFitR2": max((r["fitR2"] or 0 for r in bad), default=None),
        "equilibriumErrorPct": res["equilibriumErrorPct"],
        "energyBalancePct": res["energyBalancePct"],
        "fieldLayer": list(field["samples"].keys()),
        "fieldSamples": len(field["samples"]["von-mises"]),
        "fieldNormalization": field["normalization"]["von-mises"],
    }

    # coarser grid: the tool must refuse to certify a hot spot when the wall is thin
    coarse = stress_fem.run(
        {
            "path": path,
            "dxMm": 2.5,
            "youngModulusMPa": E,
            "poissonRatio": NU,
            "yieldMPa": 50.0,
            "fixedFaces": [{"axis": "x", "side": "min"}],
            "loads": [{"face": {"axis": "x", "side": "max"}, "forceN": [0, -F, 0]}],
            "runConvergence": False,
        }
    )
    OUT["cantileverCoarse"] = {
        "dxMm": coarse["dxMm"],
        "trustworthyRegions": coarse["regionsTrustworthy"],
        "surfaceExtrapolatedMPa": max(
            (r["surfaceExtrapolatedMPa"] for r in coarse["regions"] if r["surfaceExtrapolatedMPa"]),
            default=None,
        ),
    }

# ---- 2. toy-balance beam: integrals fine, peak refused ---------------------
repo = os.path.abspath(os.path.join(HERE, "..", ".."))
beam_stl = os.path.join(repo, "examples", "toy-balance", "cad-data", "versions", "v050", "model.stl")
if os.path.exists(beam_stl):
    w = 80e-3 * 9.81
    res = stress_fem.run(
        {
            "path": beam_stl,
            "youngModulusMPa": 3500.0,
            "poissonRatio": 0.35,
            "yieldMPa": 25.0,
            "fixedPoints": [{"atMm": [0, 86.1213, 5], "radiusMm": 3.0}],
            "loads": [
                {"atMm": [-80, 82.1213, 5], "forceN": [0, -w, 0], "radiusMm": 3.0},
                {"atMm": [80, 82.1213, 5], "forceN": [0, -w, 0], "radiusMm": 3.0},
            ],
            "probeAtMm": [80, 82.1213, 5],
            "resultants": [{"axis": "x", "atMm": 40.0}, {"axis": "x", "atMm": -40.0}],
            "excludeFromReport": [
                {"atMm": [0, 86.1213, 5], "radiusMm": 5.0},
                {"atMm": [-80, 82.1213, 5], "radiusMm": 5.0},
                {"atMm": [80, 82.1213, 5], "radiusMm": 5.0},
            ],
            "runConvergence": True,
        }
    )
    OUT["toyBalanceBeam"] = {
        "dxMm": res["dxMm"],
        "sectionAreaMm2": res["resultants"][0]["areaMm2"],
        "sectionIzMm4": res["resultants"][0]["secondMomentMm4"]["z"],
        "momentPlus40": res["resultants"][0]["momentNmm"]["z"],
        "momentMinus40": res["resultants"][1]["momentNmm"]["z"],
        "momentRefNmm": -w * 40,
        "shearPlus40": res["resultants"][0]["shearN"]["y"],
        "shearRefN": -w,
        "axialForce": res["resultants"][0]["axialForceN"],
        "equilibriumErrorPct": res["equilibriumErrorPct"],
        "energyBalancePct": res["energyBalancePct"],
        "trustworthyRegions": res["regionsTrustworthy"],
        "meshVerdict": res["meshIndependence"].get("verdict"),
        "excludedCells": res["excludedCells"],
        "maxStressMPa": res["maxVonMisesBoundaryMPa"],
    }

print(json.dumps(OUT))
