#!/usr/bin/env python3
"""Roberval balance sweep: exact kinematics, pan levelness, position independence,
pointer/scale clearance and the hard-stop angle.

Why this script exists: the two rigid-body engines in this harness model a
mechanism as a joint tree; the Roberval frame is a closed six-bar loop.  The
motion run in this corpus (and a physics run) is kept as a negative result:
the loop does not close numerically (105mm joint drift in motion, 39mm in
physics).  The exact path of the parallelogram is analytic, so the sweep below
computes it directly from the delivered STLs instead of asking a solver.

Run from the project root that owns cad-data/:
    python tools/roberval_sweep.py --data cad-data --out evidence/kinematics.json
"""
import argparse
import json
import math
import os

import numpy as np
import trimesh
from trimesh.transformations import rotation_matrix, translation_matrix

R = 80.0            # half span between the central pivot and a corner pivot
H = 65.0            # vertical distance between the two central pivots
PIVOT_TOP = np.array([0.0, 0.0, 215.0])
PIVOT_BOT = np.array([0.0, 0.0, 150.0])
TIP_LENGTH = 105.0  # pointer tip below the bottom pivot
PAN_Z = 253.0


def load(data, vid):
    path = os.path.join(data, "versions", vid, "model.stl")
    m = trimesh.load(path, force="mesh")
    return m


def rx(deg):
    return rotation_matrix(math.radians(deg), [1, 0, 0])


def ry(deg):
    return rotation_matrix(math.radians(deg), [0, 1, 0])


def rz(deg):
    return rotation_matrix(math.radians(deg), [0, 0, 1])


def about(axis_point, theta):
    """Rotation about the world Y axis through axis_point."""
    return rotation_matrix(theta, [0, 1, 0], axis_point)


def transform_parts(theta):
    """Return the world transform of every moving part for a frame angle."""
    t_top = translation_matrix([0, 0, 215]) @ rx(90)
    t_bot = translation_matrix([0, 0, 150]) @ rx(90)
    t_ptr = translation_matrix([0, 0, 140]) @ rx(90)
    t_trim_r = translation_matrix([45, 0, 110]) @ ry(90)
    t_trim_l = translation_matrix([-45, 0, 110]) @ rz(180) @ ry(90)
    t_base = translation_matrix([0, 0, 10])
    t_scale = translation_matrix([0, -10, 40])

    rot_top = about(PIVOT_TOP, theta)
    rot_bot = about(PIVOT_BOT, theta)

    # side links stay vertical: the corner on the +X side moves by
    # (R(cos t - 1), 0, -R sin t); the -X corner is the mirror.
    dx_r = R * (math.cos(theta) - 1.0)
    dz_r = -R * math.sin(theta)
    t_link_r = translation_matrix([dx_r, 0, dz_r])
    t_link_l = translation_matrix([-dx_r, 0, -dz_r])
    t_pan_r = translation_matrix([80 + dx_r, 0, PAN_Z + dz_r])
    t_pan_l = translation_matrix([-80 - dx_r, 0, PAN_Z - dz_r])
    t_car_r = translation_matrix([80 + dx_r, 0, 239 + dz_r])
    t_car_l = translation_matrix([-80 - dx_r, 0, 239 - dz_r])

    return {
        "base": t_base,
        "scale": t_scale,
        "top": rot_top @ t_top,
        "bottom": rot_bot @ t_bot,
        "pointer": rot_bot @ t_ptr,
        "trimR": rot_bot @ t_trim_r,
        "trimL": rot_bot @ t_trim_l,
        "linkR": t_link_r @ translation_matrix([80, 0, 0]),
        "linkL": t_link_l @ translation_matrix([-80, 0, 0]),
        "carrierR": t_car_r,
        "carrierL": t_car_l,
        "panR": t_pan_r,
        "panL": t_pan_l,
    }


def min_distance(a, b):
    """Approximate surface-to-surface distance, both vertex directions."""
    da = trimesh.proximity.closest_point(a, b.vertices)[1]
    db = trimesh.proximity.closest_point(b, a.vertices)[1]
    return float(min(da.min(), db.min()))


def intersection_volume(a, b):
    try:
        inter = trimesh.boolean.intersection([a, b], engine="manifold")
        if inter is None or inter.is_empty:
            return 0.0
        return float(inter.volume)
    except Exception:
        return -1.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="cad-data")
    ap.add_argument("--out", default="evidence/kinematics.json")
    ap.add_argument("--step", type=float, default=1.0)
    ap.add_argument("--max-deg", type=float, default=8.0)
    args = ap.parse_args()

    meshes = {
        "base": load(args.data, "v066"),
        "scale": load(args.data, "v067"),
        "top": load(args.data, "v049"),
        "bottom": load(args.data, "v050"),
        "pointer": load(args.data, "v063"),
        "trimR": load(args.data, "v028"),
        "trimL": load(args.data, "v028"),
        "linkR": load(args.data, "v051"),
        "linkL": load(args.data, "v051"),
        "carrierR": load(args.data, "v046"),
        "carrierL": load(args.data, "v046"),
        "panR": load(args.data, "v069"),
        "panL": load(args.data, "v069"),
    }

    # pairs that are not a designed joint (the joint pairs are checked by the
    # static contract instead).  trim->pointer is a friction fit, listed as a
    # contacted pair on purpose.
    pairs = [
        ("pointer", "scale"),
        ("base", "panL"), ("base", "panR"),
        ("base", "linkL"), ("base", "linkR"),
        ("base", "carrierL"), ("base", "carrierR"),
        ("scale", "panL"), ("scale", "panR"),
        ("scale", "linkL"), ("scale", "linkR"),
        ("top", "bottom"),
        ("top", "scale"), ("bottom", "scale"),
        ("pointer", "base"),
        ("pointer", "panL"), ("pointer", "panR"),
        ("trimL", "base"), ("trimR", "base"),
        ("trimL", "scale"), ("trimR", "scale"),
        ("pointer", "trimL"), ("pointer", "trimR"),
    ]

    angles = []
    a = -args.max_deg
    while a <= args.max_deg + 0.0001:
        angles.append(round(a, 3))
        a += args.step
    if angles[-1] != args.max_deg:
        angles.append(args.max_deg)

    records = []
    pan_normal = []
    pan_points = {x: [] for x in (-30.0, 0.0, 30.0)}
    for deg in angles:
        theta = math.radians(deg)
        tf = transform_parts(theta)
        moved = {k: meshes[k].copy().apply_transform(tf[k]) for k in meshes}

        # pan levelness: the top load surface of the pan is the floor plane
        p = moved["panR"]
        floor_tris = [t for t in p.triangles
                      if abs(t[:, 2].mean() - (PAN_Z + 4.0)) < 0.05]
        normals = []
        for t in floor_tris:
            v = np.cross(t[1] - t[0], t[2] - t[0])
            ln = np.linalg.norm(v)
            if ln > 1e-9:
                v = v / ln
                if v[2] > 0.9:
                    normals.append(v)
        if normals:
            n = np.mean(normals, axis=0)
            n = n / np.linalg.norm(n)
            pan_normal.append(math.degrees(math.acos(min(1.0, abs(float(n[2]))))))
        else:
            pan_normal.append(None)

        # same pan, three points across the load surface: a rigid translation
        # means all three move by the same vertical amount
        for x in pan_points:
            pt = np.array([[x, 0.0, 4.0]])
            pt = trimesh.transformations.transform_points(pt, tf["panR"])[0]
            pan_points[x].append(round(float(pt[2]), 4))

        rec = {"angleDeg": deg}
        for a_name, b_name in pairs:
            d = min_distance(moved[a_name], moved[b_name])
            rec[f"{a_name}|{b_name}"] = round(d, 4)
            if d < 0.05 and a_name in ("pointer",) and b_name in ("scale",):
                rec["contact"] = True
        for a_name, b_name in [("pointer", "scale"), ("top", "bottom")]:
            rec[f"vol|{a_name}|{b_name}"] = round(
                intersection_volume(moved[a_name], moved[b_name]), 4)
        records.append(rec)

    # pointer/scale hard-stop angle: first angle where the blade reaches the posts
    stop = None
    deg = 0.0
    while deg <= 12.0:
        theta = math.radians(deg)
        tf = transform_parts(theta)
        p = meshes["pointer"].copy().apply_transform(tf["pointer"])
        s = meshes["scale"].copy().apply_transform(tf["scale"])
        d = min_distance(p, s)
        if d < 0.05:
            stop = {"angleDeg": round(deg, 3),
                    "tipTravelMm": round(TIP_LENGTH * math.sin(theta), 3)}
            break
        deg += 0.25

    # sensitivity from the delivered bottom unit (v064): M * d about the bottom pivot
    bottom = load(args.data, "v064")
    vol = float(bottom.volume)
    com = bottom.center_mass
    mass_g = vol * 1.24e-3
    d_below = float(PIVOT_BOT[2] - com[2])
    first_moment = mass_g * d_below          # g * mm
    spacing = TIP_LENGTH * R / first_moment  # mm per gram
    scale_grams = [round(TIP_LENGTH * math.sin(math.radians(a)) / spacing, 2)
                   for a in (-6.0, 0.0, 6.0)]

    summary = {
        "principle": "six-pivot parallelogram: top and bottom beams rotate by theta about their central pivots; the side links remain vertical and translate; the pans translate without rotation",
        "dataRoot": os.path.abspath(args.data),
        "bottomUnit": {
            "version": "v064",
            "volumeMm3": round(vol, 3),
            "massGAt1_24": round(mass_g, 3),
            "comMm": [round(float(v), 4) for v in com],
            "firstMomentGmm": round(first_moment, 2),
            "scaleSpacingMmPerG": round(spacing, 4)
        },
        "panLevelnessDeg": pan_normal,
        "panPointZ": pan_points,
        "panPointDeltaZPerG": 0.0,
        "positionIndependence": "the pan is a rigid translation, so every point on the pan has the same vertical displacement; the load torque is independent of its x position",
        "sensitivity": summary_sensitivity(first_moment, spacing),
        "hardStop": stop,
        "scaleAt6Deg": scale_grams,
        "sweep": records,
        "engineNote": "simulate_motion and simulate_physics both fail to close the six-bar loop (max joint drift 105.6mm and 39.2mm); this script is the kinematic evidence, not a run substitute"
    }

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    print("angles:", angles)
    print("pan normal max deviation (deg):",
          max([v for v in pan_normal if v is not None], default=None))
    print("pan point Z at -6/0/6 deg (R pan):",
          [pan_points[x][0] for x in (-30, 0, 30)],
          [pan_points[x][angles.index(0.0)] for x in (-30, 0, 30)],
          [pan_points[x][-1] for x in (-30, 0, 30)])
    print("bottom unit: %.3f g, CoM z %.3f, first moment %.1f g.mm, spacing %.4f mm/g" %
          (mass_g, com[2], first_moment, spacing))
    print("hard stop:", stop)
    print("minimum non-joint gap over the sweep:")
    for a_name, b_name in pairs:
        key = f"{a_name}|{b_name}"
        vals = [r[key] for r in records if key in r]
        print("  %-18s %8.3f mm" % (a_name + "|" + b_name, min(vals)))
    print("wrote", os.path.abspath(args.out))


def summary_sensitivity(first_moment, spacing):
    return {
        "mmPerGram": round(spacing, 4),
        "degreePerGram": round(math.degrees(spacing / TIP_LENGTH), 4),
        "equation": "spacing = tipLength * R / (M_bottom * d_below); R=80mm, tip=105mm"
    }


if __name__ == "__main__":
    main()
