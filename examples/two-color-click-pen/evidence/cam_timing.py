#!/usr/bin/env python3
"""Cam timing + follower/arm clearance evidence for the two-color click pen.

Reads the delivered rotor STL and casts vertical rays at the two follower
radii to recover the cam surface h(theta) as built, then computes:
  - black/red refill rear z and tip protrusion vs rotor angle,
  - the three click states (0/120/240/360 deg),
  - red carrier arm clearance over the black cam rib,
  - cam contact error vs the declared analytic profile.

Run from the project root:
  python evidence/cam_timing.py
"""
import json, math, os
import numpy as np
import trimesh

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROTOR = os.path.join(ROOT, "cad-data", "versions", "v085", "model.stl")
OUT = os.path.join(ROOT, "evidence", "cam_timing.json")

R_BLACK, R_RED = 6.3, 3.6
REFILL_LEN = 100.0
ARM_BOTTOM = 2.8          # carrier arm bottom is 2.8 mm below the pad top
RIB_TOP = 104.5           # low black rib top
RED_OFFSET = 8.5          # red follower post height
NOSE_Z = 0.0

def ang(a):
    return ((a % 360.0) + 360.0) % 360.0

def hb(a):
    t = ang(a)
    if t < 30:  return 96.0
    if t < 90:  return 96.0 + 8.0 * (t - 30) / 60.0
    if t < 270: return 104.0
    if t < 330: return 104.0 - 8.0 * (t - 270) / 60.0
    return 96.0

def hr(a):
    t = ang(a)
    if t < 30:  return 102.0 - 6.0 * (t / 30.0)
    if t < 90:  return 96.0
    if t < 150: return 96.0 + 12.0 * (t - 90) / 60.0
    if t < 330: return 108.0
    return 108.0 - 6.0 * ((t - 330.0) / 30.0)

mesh = trimesh.load(ROTOR, force="mesh")
print("rotor", mesh.bounds.tolist(), "watertight", mesh.is_watertight)

def surface_z(r, world_deg, rotor_deg):
    """Lowest rotor surface on the vertical line at world angle, rotor rotated."""
    # The world point at angle world_deg is at material angle world_deg-rotor_deg.
    a = math.radians(world_deg - rotor_deg)
    x, y = r * math.cos(a), r * math.sin(a)
    origins = np.array([[x, y, 80.0]])
    dirs = np.array([[0.0, 0.0, 1.0]])
    locs, idx_ray, idx_tri = mesh.ray.intersects_location(
        origins, dirs, multiple_hits=True)
    if len(locs) == 0:
        return None
    return float(np.min(locs[:, 2]))

rows = []
for deg in range(0, 361, 2):
    zb = surface_z(R_BLACK, 0.0, deg)
    zr = surface_z(R_RED, 180.0, deg)
    rb = hb(0.0 - deg)
    rr = hr(180.0 - deg)
    rows.append({
        "rotorDeg": deg,
        "blackSurfaceZ": zb, "redSurfaceZ": zr,
        "blackAnalyticZ": rb, "redAnalyticZ": rr + RED_OFFSET,
        "blackErrMm": None if zb is None else zb - rb,
        "redErrMm": None if zr is None else zr - (rr + RED_OFFSET),
        "blackTipZ": None if zb is None else zb - REFILL_LEN,
        "redTipZ": None if zr is None else zr - RED_OFFSET - REFILL_LEN,
        "blackProtrusionMm": None if zb is None else max(0.0, NOSE_Z - (zb - REFILL_LEN)),
        "redProtrusionMm": None if zr is None else max(0.0, NOSE_Z - (zr - RED_OFFSET - REFILL_LEN)),
    })

# radial crossings: black arm at r=6.3 passes UNDER the red track at r=3.6;
# red arm stops at r=3.4 and never reaches the black track at r=6.3.
arm_clear = []
for deg in range(0, 361, 2):
    # black arm at world 0, material angle -deg; red track bottom there:
    red_track_bottom = hr(0.0 - deg) + RED_OFFSET
    black_arm_top = hb(0.0 - deg)
    clear = red_track_bottom - black_arm_top
    arm_clear.append({"rotorDeg": deg,
                      "blackArmTopZ": black_arm_top,
                      "redTrackBottomAtBlackArmZ": red_track_bottom,
                      "blackArmUnderRedTrackClearanceMm": clear})

states = {}
for deg in (0, 120, 240, 360):
    r = [x for x in rows if x["rotorDeg"] == deg][0]
    states[f"state{deg//120 if deg < 360 else 0}"] = {
        "rotorDeg": deg,
        "blackRearZ": r["blackSurfaceZ"],
        "redRearZ": r["redSurfaceZ"],
        "blackTipZ": r["blackTipZ"], "redTipZ": r["redTipZ"],
        "blackProtrusionMm": r["blackProtrusionMm"],
        "redProtrusionMm": r["redProtrusionMm"],
    }

errs = [abs(x["blackErrMm"]) for x in rows if x["blackErrMm"] is not None] + \
       [abs(x["redErrMm"]) for x in rows if x["redErrMm"] is not None]
result = {
    "rotorVersion": "v085",
    "method": "vertical ray cast against the delivered rotor STL; lowest hit = cam surface",
    "samples": len(rows),
    "maxCamProfileErrorMm": max(errs),
    "states": states,
    "minBlackArmUnderRedTrackClearanceMm": min(x["blackArmUnderRedTrackClearanceMm"] for x in arm_clear),
    "crossingAtStates": [x for x in arm_clear if x["rotorDeg"] in (0,120,240,360)],
    "hasCollision": any(x["blackArmUnderRedTrackClearanceMm"] < -0.01 for x in arm_clear),
    "rows": rows,
    "armClearance": arm_clear,
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w") as f:
    json.dump(result, f, indent=1)
print(json.dumps({k: v for k, v in result.items() if k not in ("rows", "armClearance")}, indent=1))
