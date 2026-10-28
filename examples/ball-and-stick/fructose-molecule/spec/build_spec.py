#!/usr/bin/env python3
"""Build the beta-D-fructofuranose ball-and-stick spec.

Reads the PubChem 3D SDF (CID 439709), maps its atom order to standard
fructose numbering, scales it, and emits:
  - molecule.json          authoritative atom/bond/interface/placement data
  - scad/<part>.scad       one self-contained OpenSCAD source per unique part
  - catalog.csv            human part list
  - assembly_plan.json     manifest skeleton (versions filled later)

Geometry is generated in millimetres.  Each part is authored in its own local
frame; placements live in molecule.json and the later assembly manifest.
"""
from __future__ import annotations

import csv
import json
import math
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SDF = HERE / "fructofuranose_pubchem_439709.sdf"

SCALE = 35.0  # mm per angstrom
RADII = {"C": 14.0, "O": 12.5, "H": 6.5}

# Interface dimensions (mm).  All are declared constants, not fitted numbers.
HEAVY = dict(
    boss_d=11.0, boss_r=5.5, boss_len=7.0,
    groove_d=10.4, groove_r=5.2, groove_w=1.3, groove_from_face=5.0,
    cup_id=11.2, cup_r=5.6, cup_od=12.8, cup_or=6.4, cup_len=7.0,
    bead_id=10.75, bead_r=5.375, bead_w=1.2, bead_from_bottom=5.0,
    slit_n=4, slit_w=0.5, slit_len=6.0, body_r=5.25,
    rib_n=12, rib_r1=2.9, rib_r2=5.2, rib_w=0.65, rib_h=0.6, rib_cham=0.2,
    slot_w=0.75, slot_depth=0.65, lead=0.6,
)
LIGHT = dict(
    boss_d=6.5, boss_r=3.25, boss_len=4.5,
    groove_d=6.1, groove_r=3.05, groove_w=1.1, groove_from_face=3.5,
    cup_id=6.7, cup_r=3.35, cup_od=8.3, cup_or=4.15, cup_len=4.5,
    bead_id=6.35, bead_r=3.175, bead_w=1.0, bead_from_bottom=3.5,
    slit_n=3, slit_w=0.45, slit_len=4.3, body_r=3.0,
    rib_n=0, rib_r1=0.0, rib_r2=0.0, rib_w=0.0, rib_h=0.0, rib_cham=0.0,
    slot_w=0.0, slot_depth=0.0, lead=0.4,
)

# PubChem atom-index (1-based) -> fructose label.
ATOM_MAP = {
    11: "C1", 8: "C2", 7: "C3", 9: "C4", 10: "C5", 12: "C6",
    5: "O1", 3: "O2", 2: "O3", 4: "O4", 1: "O5", 6: "O6",
    16: "H01", 17: "H02", 21: "H03", 13: "H04", 20: "H05", 14: "H06",
    22: "H07", 15: "H08", 18: "H09", 19: "H10", 23: "H11", 24: "H12",
}

# Bond list in the order used on the drawings.  a/b are fructose labels.
BONDS = [
    ("B01", "C1", "C2"), ("B02", "C2", "C3"), ("B03", "C3", "C4"),
    ("B04", "C4", "C5"), ("B05", "C5", "O5"), ("B06", "O5", "C2"),
    ("B07", "C1", "O1"), ("B08", "C2", "O2"), ("B09", "C3", "O3"),
    ("B10", "C4", "O4"), ("B11", "C5", "C6"), ("B12", "C6", "O6"),
    ("B13", "C1", "H01"), ("B14", "C1", "H02"), ("B15", "C3", "H04"),
    ("B16", "C4", "H06"), ("B17", "C5", "H08"), ("B18", "C6", "H09"),
    ("B19", "C6", "H10"), ("B20", "O1", "H11"), ("B21", "O2", "H03"),
    ("B22", "O3", "H05"), ("B23", "O4", "H07"), ("B24", "O6", "H12"),
]


def parse_sdf(path: Path):
    lines = path.read_text().splitlines()
    for i, line in enumerate(lines):
        if line.rstrip().endswith("V2000"):
            na, nb = int(line[0:3]), int(line[3:6])
            start = i + 1
            break
    else:
        raise RuntimeError("no V2000 counts line")
    raw = []
    for i in range(na):
        line = lines[start + i]
        xyz = np.array([float(line[0:10]), float(line[10:20]), float(line[20:30])])
        el = line[31:34].strip()
        raw.append((el, xyz))
    bonds = []
    for i in range(nb):
        line = lines[start + na + i]
        a, b = int(line[0:3]), int(line[3:6])
        bonds.append((a, b))
    return raw, bonds


def unit(v):
    n = np.linalg.norm(v)
    return v / n


def perp_ref(u):
    """Deterministic reference perpendicular to u (project global Z, fallback X)."""
    z = np.array([0.0, 0.0, 1.0])
    n = z - u * float(np.dot(z, u))
    if np.linalg.norm(n) < 1e-6:
        x = np.array([1.0, 0.0, 0.0])
        n = x - u * float(np.dot(x, u))
    return unit(n)


def frame_matrix(u, n):
    """4x4 matrix columns X=n, Y=u x n, Z=u (row-major for OpenSCAD multmatrix)."""
    y = np.cross(u, n)
    return [
        [float(n[0]), float(y[0]), float(u[0]), 0.0],
        [float(n[1]), float(y[1]), float(u[1]), 0.0],
        [float(n[2]), float(y[2]), float(u[2]), 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]


def fmt(x, nd=4):
    s = f"{float(x):.{nd}f}"
    if s.startswith("-0.0000"):
        s = s[1:]
    return s


def vec(v, nd=4):
    return "[" + ",".join(fmt(x, nd) for x in v) + "]"


def mat4(M):
    return "[" + ",".join("[" + ",".join(fmt(x, 6) for x in row) + "]" for row in M) + "]"


def scad_common() -> str:
    return r"""
$fn=64;
// ---- shared interface modules: edit the numbers only here ----
module rib_pos(r1,r2,w,h,cham) {
  hull() {
    translate([r1,-w/2,0]) cube([r2-r1,w,h-cham]);
    translate([r1+cham,-w/2+cham,h-cham]) cube([r2-r1-2*cham,w-2*cham,cham]);
  }
}
module spline_pos(n,r1,r2,w,h,cham,phase=0,wkey=1.0,hkey=0.7) {
  // rib 0 is the key rib: wider and taller, so only one angular position seats
  for (i=[0:n-1])
    rotate([0,0,phase+i*360/n])
      if (i==0) rib_pos(r1,r2,wkey,hkey,cham); else rib_pos(r1,r2,w,h,cham);
}
module spline_neg(n,r1,r2,w,h,depth,phase=0,wkey=1.0,hkey=0.7,depthkey=0.75) {
  // rectangular pockets, 0.1mm wider / 0.05mm deeper than the ribs
  for (i=[0:n-1])
    rotate([0,0,phase+i*360/n])
      if (i==0)
        translate([r1-0.05,-(wkey+0.1)/2,-depthkey]) cube([r2-r1+0.1,wkey+0.1,depthkey+0.01]);
      else
        translate([r1-0.05,-(w+0.1)/2,-depth]) cube([r2-r1+0.1,w+0.1,depth+0.01]);
}
"""


def build():
    raw, raw_bonds = parse_sdf(SDF)
    coords = np.array([xyz for _, xyz in raw])
    coords = coords - coords.mean(axis=0)
    coords_mm = coords * SCALE

    by_pub = {}
    for i, (el, _) in enumerate(raw, start=1):
        label = ATOM_MAP[i]
        by_pub[i] = label
    atoms = {}
    for i, (el, _) in enumerate(raw, start=1):
        label = by_pub[i]
        atoms[label] = dict(
            id=label, element=el, pos_mm=coords_mm[i - 1], pubchem=i,
            instance_translate=[float(x) for x in coords_mm[i - 1]],
            instance_rotation=[0.0, 0.0, 0.0],
        )

    # check the mapping against the SDF bonds
    mapped_bonds = {(by_pub[a], by_pub[b]) for a, b in raw_bonds}
    mapped_bonds |= {(b, a) for a, b in mapped_bonds}
    for bid, a, b in BONDS:
        if (a, b) not in mapped_bonds:
            raise RuntimeError(f"bond {bid} {a}-{b} not in SDF")

    # attach bonds / bosses
    for label, atom in atoms.items():
        atom["bonds"] = []
        atom["bosses"] = []
    bonds = []
    for bid, a, b in BONDS:
        pa, pb = atoms[a]["pos_mm"], atoms[b]["pos_mm"]
        d = float(np.linalg.norm(pb - pa))
        u = unit(pb - pa)
        kind = "heavy" if atoms[a]["element"] != "H" and atoms[b]["element"] != "H" else "light"
        P = HEAVY if kind == "heavy" else LIGHT
        n = perp_ref(u)
        L = d - RADII[atoms[a]["element"]] - RADII[atoms[b]["element"]]
        gap_mid = pa + u * (RADII[atoms[a]["element"]] + L / 2.0)
        R = np.column_stack([n, np.cross(u, n), u])
        euler = Rotation.from_matrix(R).as_euler("xyz", degrees=True)
        # B-end slot clocking, in the rod frame.  The 12-rib pattern is 30-deg periodic.
        nB = perp_ref(-u)  # boss at B points from B to A = -u
        phaseB = math.degrees(math.atan2(float(np.dot(nB, np.cross(u, n))), float(np.dot(nB, n)))) % 30.0
        if phaseB > 29.999:
            phaseB = 0.0
        rod = dict(
            id=bid, a=a, b=b, kind=kind, D_mm=d, L_mm=L,
            u=[float(x) for x in u], nA=[float(x) for x in n], nB=[float(x) for x in nB],
            phaseB_deg=float(phaseB),
            gap_mid=[float(x) for x in gap_mid],
            rotate=[float(x) for x in euler],
            placement=[float(x) for x in gap_mid],
        )
        bonds.append(rod)
        atoms[a]["bonds"].append(bid)
        atoms[b]["bonds"].append(bid)
        # Boss on A (points toward B): datum names are per neighbour.
        atoms[a]["bosses"].append(dict(to=b, bond=bid, kind=kind, u=[float(x) for x in u], n=[float(x) for x in n]))
        # Boss on B points toward A.
        ub = -u
        nb = perp_ref(ub)
        atoms[b]["bosses"].append(dict(to=a, bond=bid, kind=kind, u=[float(x) for x in ub], n=[float(x) for x in nb]))

    # All H atoms are one part: canonical local frame (+Z boss), placed by rotation.
    for label, atom in atoms.items():
        if atom["element"] != "H":
            continue
        bond = next((x for x in bonds if x["id"] == atom["bonds"][0]), None) if len(atom["bonds"]) == 1 else None
        if bond is None:
            raise RuntimeError(f"H {label} has {len(atom['bonds'])} bonds")
        other = bond["b"] if bond["a"] == label else bond["a"]
        u = unit(np.array(atoms[other]["pos_mm"]) - np.array(atom["pos_mm"]))
        n = perp_ref(u)
        Rm = np.column_stack([n, np.cross(u, n), u])
        atom["instance_rotation"] = [float(x) for x in Rotation.from_matrix(Rm).as_euler("xyz", degrees=True)]
        atom["canonical_h"] = True
        atom["part"] = "Fru-H"
        atom["bosses"] = [dict(to="heavy", bond=bond["id"], kind="light",
                               u=[0.0, 0.0, 1.0], n=[1.0, 0.0, 0.0])]
    # datum coordinates (C/O in the molecular frame; H in its canonical local frame)
    for label, atom in atoms.items():
        atom["datums"] = []
        for boss in atom["bosses"]:
            u = np.array(boss["u"])
            P = HEAVY if boss["kind"] == "heavy" else LIGHT
            base = np.zeros(3)
            face = base + u * (RADII[atom["element"]] + P["boss_len"])
            boss["face_mm"] = [float(x) for x in face]
            boss["radius"] = P["boss_r"]
            names = ("to_heavy", "ax_heavy", "cyl_heavy") if atom.get("canonical_h") else (f"to_{boss['to']}", f"ax_{boss['to']}", f"cyl_{boss['to']}")
            atom["datums"] += [
                dict(name=names[0], kind="point", point=[float(x) for x in face]),
                dict(name=names[1], kind="axis", point=[float(x) for x in face], dir=[float(x) for x in u]),
                dict(name=names[2], kind="cylinder", point=[float(x) for x in face], dir=[float(x) for x in u], radius=float(P["boss_r"])),
            ]
        atom["pos_mm"] = [float(x) for x in atom["pos_mm"]]

    # part groups
    part_ids = {label: ("Fru-H" if atom["element"] == "H" else f"Fru-{label}") for label, atom in atoms.items()}
    for rod in bonds:
        rod["part"] = f"Fru-{rod['id']}"
        if rod["kind"] == "heavy":
            end_len = HEAVY["cup_len"]
        else:
            end_len = LIGHT["cup_len"]
        rod["cup_len"] = end_len
        rod["datums"] = []
        for end, sign, other in (("A", -1.0, rod["a"]), ("B", 1.0, rod["b"])):
            face_z = sign * (rod["L_mm"] / 2.0 - end_len)
            P = HEAVY if rod["kind"] == "heavy" else LIGHT
            rod["datums"] += [
                dict(name=f"{end}_face", kind="point", point=[0.0, 0.0, float(face_z)]),
                dict(name=f"{end}_axis", kind="axis", point=[0.0, 0.0, float(face_z)], dir=[0.0, 0.0, float(sign)]),
                dict(name=f"{end}_cyl", kind="cylinder", point=[0.0, 0.0, float(face_z)], dir=[0.0, 0.0, float(sign)], radius=float(P["cup_r"])),
            ]

    # expected assembly values
    for rod in bonds:
        rod["expected"] = dict(
            center_distance_mm=rod["D_mm"],
            rod_length_mm=rod["L_mm"],
            cup_face_distance_mm=rod["L_mm"] - 2 * rod["cup_len"],
            phaseB_deg=rod["phaseB_deg"],
        )

    molecule = dict(
        name="beta-D-fructofuranose",
        common_name="果糖（β-D-呋喃果糖）",
        formula="C6H12O6",
        pubchem_cid=439709,
        source=SDF.name,
        scale_mm_per_angstrom=SCALE,
        radii_mm=RADII,
        interface=dict(heavy=HEAVY, light=LIGHT),
        atoms=list(atoms.values()),
        bonds=bonds,
        counts=dict(atoms=len(atoms), bonds=len(bonds), heavy_rods=sum(1 for b in bonds if b["kind"] == "heavy"), light_rods=sum(1 for b in bonds if b["kind"] == "light")),
    )

    (HERE / "molecule.json").write_text(json.dumps(molecule, indent=2, ensure_ascii=False))

    # ---------------- SCAD per part ----------------
    scad_dir = HERE / "scad"
    for old in scad_dir.glob("*.scad"):
        old.unlink()

    written_atoms = set()
    for label, atom in atoms.items():
        part = part_ids[label]
        if part in written_atoms:
            continue
        written_atoms.add(part)
        R = RADII[atom["element"]]
        lines = [scad_common(), f"R={fmt(R)};", "sphere(R);"]
        for boss in atom["bosses"]:
            u, n = np.array(boss["u"]), np.array(boss["n"])
            M = mat4(frame_matrix(u, n))
            P = HEAVY if boss["kind"] == "heavy" else LIGHT
            if boss["kind"] == "heavy":
                lines.append(f"heavy_boss({M});")
            else:
                lines.append(f"light_boss({M});")
        lines.append("")
        lines.append("// ---- datums ----")
        for d in atom["datums"]:
            if d["kind"] == "point":
                lines.append(f"datum(\"{d['name']}\",{vec(d['point'])});")
            elif d["kind"] == "axis":
                lines.append(f"datum_axis(\"{d['name']}\",{vec(d['point'])},{vec(d['dir'])});")
            elif d["kind"] == "cylinder":
                lines.append(f"datum_cyl(\"{d['name']}\",{vec(d['point'])},{vec(d['dir'])},{fmt(d['radius'])});")
        # shared boss modules are emitted per file so it is self-contained
        lines.append(heavy_boss_module(atom))
        lines.append(light_boss_module(atom))
        (scad_dir / f"{part}.scad").write_text("\n".join(lines) + "\n")

    for rod in bonds:
        lines = [scad_common(), f"L={fmt(rod['L_mm'])};", f"phaseB={fmt(rod['phaseB_deg'])};"]
        if rod["kind"] == "heavy":
            lines.append("heavy_rod(L,phaseB);")
            lines.append(heavy_rod_module())
        else:
            lines.append("light_rod(L);")
            lines.append(light_rod_module())
        lines.append("")
        lines.append("// ---- datums ----")
        for d in rod["datums"]:
            if d["kind"] == "point":
                lines.append(f"datum(\"{d['name']}\",{vec(d['point'])});")
            elif d["kind"] == "axis":
                lines.append(f"datum_axis(\"{d['name']}\",{vec(d['point'])},{vec(d['dir'])});")
            elif d["kind"] == "cylinder":
                lines.append(f"datum_cyl(\"{d['name']}\",{vec(d['point'])},{vec(d['dir'])},{fmt(d['radius'])});")
        (scad_dir / f"{rod['part']}.scad").write_text("\n".join(lines) + "\n")

    # ---------------- catalog ----------------
    with (HERE / "catalog.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["part", "kind", "element_or_bond", "instances", "notes"])
        for label, atom in sorted(atoms.items()):
            if atom["element"] == "H":
                continue
            w.writerow([part_ids[label], "atom", atom["element"], 1, f"{len(atom['bosses'])} bosses"])
        for rod in bonds:
            w.writerow([rod["part"], "rod", f"{rod['a']}-{rod['b']}", 1, f"{rod['kind']}, L={rod['L_mm']:.3f} mm"])
        w.writerow(["Fru-H", "atom", "H", 12, "one light boss; all 12 H atoms identical"])

    # ---------------- assembly plan skeleton ----------------
    nodes = []
    for label, atom in sorted(atoms.items()):
        nodes.append(dict(id=label, kind="part", name=label, part=part_ids[label], version="VERSION", transform=dict(translate=atom["instance_translate"], rotate=atom["instance_rotation"])))
    for rod in bonds:
        nodes.append(dict(id=rod["id"], kind="part", name=f"{rod['a']}-{rod['b']}", part=rod["part"], version="VERSION", transform=dict(translate=rod["placement"], rotate=rod["rotate"])))
    # interfaces, both ends: coaxial + face distance, plus one diameter match per bond
    def endpoint(atom_label, other, kind):
        atom = atoms[atom_label]
        if atom["element"] == "H":
            return f"{atom_label}.{kind}_heavy"
        return f"{atom_label}.{kind}_{other}"

    interfaces = []
    for rod in bonds:
        a, b = rod["a"], rod["b"]
        interfaces.append(dict(id=f"I_{rod['id']}_A_axis", a=endpoint(a, b, "ax"), b=f"{rod['id']}.A_axis", type="贴合", check="coaxial", severity="hard", nominal=dict(quantity="同轴度", value=0.0), tolerance=dict(min=0.0, max=0.25), note=f"{rod['id']} A 端同轴"))
        interfaces.append(dict(id=f"I_{rod['id']}_A_face", a=endpoint(a, b, "to"), b=f"{rod['id']}.A_face", type="贴合", check="distance", severity="hard", nominal=dict(quantity="距离", value=0.0), tolerance=dict(min=0.0, max=0.25), note=f"{rod['id']} A 端贴合面"))
        interfaces.append(dict(id=f"I_{rod['id']}_B_axis", a=endpoint(b, a, "ax"), b=f"{rod['id']}.B_axis", type="贴合", check="coaxial", severity="hard", nominal=dict(quantity="同轴度", value=0.0), tolerance=dict(min=0.0, max=0.25), note=f"{rod['id']} B 端同轴"))
        interfaces.append(dict(id=f"I_{rod['id']}_B_face", a=endpoint(b, a, "to"), b=f"{rod['id']}.B_face", type="贴合", check="distance", severity="hard", nominal=dict(quantity="距离", value=0.0), tolerance=dict(min=0.0, max=0.25), note=f"{rod['id']} B 端贴合面"))
        P = HEAVY if rod["kind"] == "heavy" else LIGHT
        interfaces.append(dict(id=f"I_{rod['id']}_fit", a=f"{rod['id']}.A_cyl", b=endpoint(a, b, "cyl"), type="紧固", check="diameter-match", severity="hard", nominal=dict(quantity="直径", value=float(P["cup_id"] - P["boss_d"])), tolerance=dict(min=0.05, max=0.35), note=f"{rod['id']} 孔径/轴径"))
    plan = dict(schemaVersion=1, name="β-D-呋喃果糖球棍模型", root=dict(id="fructose", name="果糖球棍模型", kind="assembly", children=nodes, interfaces=interfaces))
    (ROOT / "assembly" / "assembly_plan.json").write_text(json.dumps(plan, indent=2, ensure_ascii=False))

    print(f"atoms {len(atoms)}, bonds {len(bonds)}, heavy {molecule['counts']['heavy_rods']}, light {molecule['counts']['light_rods']}")
    print(f"extent mm: {np.ptp(coords_mm, axis=0)}")
    print(f"max pair mm: {max(np.linalg.norm(a-b) for a in coords_mm for b in coords_mm):.2f}")
    print(f"wrote {len(list(scad_dir.glob('*.scad')))} SCAD files")


def heavy_boss_module(atom) -> str:
    P = HEAVY
    return f"""
// heavy boss: {P['boss_d']} mm OD, {P['boss_len']} mm exposed, 12-rib face spline, annular groove
module heavy_boss(M) {{
  multmatrix(M) {{
    difference() {{
      union() {{
        translate([0,0,R-2]) cylinder(h={fmt(P['boss_len']+2)},r={fmt(P['boss_r'])});
        translate([0,0,R+{fmt(P['boss_len'])}])
          spline_pos({P['rib_n']},{fmt(P['rib_r1'])},{fmt(P['rib_r2'])},{fmt(P['rib_w'])},{fmt(P['rib_h'])},{fmt(P['rib_cham'])},0,1.0,0.7);
      }}
      translate([0,0,R+{fmt(P['boss_len']-P['groove_from_face']-P['groove_w']/2)}])
        difference() {{
          cylinder(h={fmt(P['groove_w'])},r={fmt(P['boss_r']+0.15)});
          cylinder(h={fmt(P['groove_w'])},r={fmt(P['groove_r'])});
        }}
    }}
  }}
}}
"""


def light_boss_module(atom) -> str:
    P = LIGHT
    return f"""
// light boss: {P['boss_d']} mm OD, {P['boss_len']} mm exposed, round (terminal H only)
module light_boss(M) {{
  multmatrix(M) {{
    difference() {{
      translate([0,0,R-2]) cylinder(h={fmt(P['boss_len']+2)},r={fmt(P['boss_r'])});
      translate([0,0,R+{fmt(P['boss_len']-P['groove_from_face']-P['groove_w']/2)}])
        difference() {{
          cylinder(h={fmt(P['groove_w'])},r={fmt(P['boss_r']+0.15)});
          cylinder(h={fmt(P['groove_w'])},r={fmt(P['groove_r'])});
        }}
    }}
  }}
}}
"""


def heavy_rod_module() -> str:
    P = HEAVY
    return f"""
// one heavy cup, opening +Z, origin on the seating face
module cup_h(phase=0) {{
  difference() {{
    union() {{
      difference() {{
        cylinder(h={fmt(P['cup_len'])},r={fmt(P['cup_or'])});
        translate([0,0,-0.01]) cylinder(h={fmt(P['cup_len']+0.02)},r={fmt(P['cup_r'])});
      }}
      translate([0,0,-2]) cylinder(h=2,r={fmt(P['cup_or'])});
      translate([0,0,{fmt(P['bead_from_bottom'])}])
        rotate_extrude(convexity=10)
          polygon([[{fmt(P['cup_r']+0.15)},-{fmt(P['bead_w']/2)}],[{fmt(P['bead_r'])},0],[{fmt(P['cup_r']+0.15)},{fmt(P['bead_w']/2)}]]);
    }}
    // lead-in at the rim
    translate([0,0,{fmt(P['cup_len']-P['lead'])}])
      cylinder(h={fmt(P['lead']+0.01)},r1={fmt(P['cup_r'])},r2={fmt(P['cup_r']+0.55)});
    // 12-rib face spline pockets
    spline_neg({P['rib_n']},{fmt(P['rib_r1'])},{fmt(P['rib_r2'])},{fmt(P['rib_w'])},{fmt(P['rib_h'])},{fmt(P['slot_depth'])},phase,1.0,0.7,0.75);
    // four relief slits through the bead ring
    for (a=[45,135,225,315]) rotate([0,0,a])
      translate([{fmt(P['cup_r']-0.6)},-{fmt(P['slit_w']/2)},1.0]) cube([2.0,{fmt(P['slit_w'])},{fmt(P['slit_len'])}]);
  }}
}}
module heavy_rod(L,phaseB) {{
  translate([0,0,-L/2+{fmt(P['cup_len'])}]) rotate([180,0,0]) cup_h(0);
  translate([0,0, L/2-{fmt(P['cup_len'])}]) cup_h(phaseB);
  translate([0,0,-L/2+{fmt(P['cup_len']+1.5)}]) cylinder(h=max(0.1,L-{fmt(2*(P['cup_len']+1.5))}),r={fmt(P['body_r'])});
  translate([0,0,-L/2+{fmt(P['cup_len']+1.5)}]) cylinder(h=1.5,r1={fmt(P['cup_or'])},r2={fmt(P['body_r'])});
  translate([0,0, L/2-{fmt(P['cup_len']+3.0)}]) cylinder(h=1.5,r1={fmt(P['body_r'])},r2={fmt(P['cup_or'])});
}}
"""


def light_rod_module() -> str:
    P = LIGHT
    return f"""
// one light cup, opening +Z, origin on the seating face
module cup_l() {{
  difference() {{
    union() {{
      difference() {{
        cylinder(h={fmt(P['cup_len'])},r={fmt(P['cup_or'])});
        translate([0,0,-0.01]) cylinder(h={fmt(P['cup_len']+0.02)},r={fmt(P['cup_r'])});
      }}
      translate([0,0,-1.8]) cylinder(h=1.8,r={fmt(P['cup_or'])});
      translate([0,0,{fmt(P['bead_from_bottom'])}])
        rotate_extrude(convexity=10)
          polygon([[{fmt(P['cup_r']+0.15)},-{fmt(P['bead_w']/2)}],[{fmt(P['bead_r'])},0],[{fmt(P['cup_r']+0.15)},{fmt(P['bead_w']/2)}]]);
    }}
    translate([0,0,{fmt(P['cup_len']-P['lead'])}])
      cylinder(h={fmt(P['lead']+0.01)},r1={fmt(P['cup_r'])},r2={fmt(P['cup_r']+0.40)});
    for (a=[60,180,300]) rotate([0,0,a])
      translate([{fmt(P['cup_r']-0.5)},-{fmt(P['slit_w']/2)},0.5]) cube([1.6,{fmt(P['slit_w'])},{fmt(P['slit_len'])}]);
  }}
}}
module light_rod(L) {{
  translate([0,0,-L/2+{fmt(P['cup_len'])}]) rotate([180,0,0]) cup_l();
  translate([0,0, L/2-{fmt(P['cup_len'])}]) cup_l();
  translate([0,0,-L/2+{fmt(P['cup_len']+1.3)}]) cylinder(h=max(0.1,L-{fmt(2*(P['cup_len']+1.3))}),r={fmt(P['body_r'])});
  translate([0,0,-L/2+{fmt(P['cup_len']+1.3)}]) cylinder(h=0.8,r1={fmt(P['cup_or'])},r2={fmt(P['body_r'])});
  translate([0,0, L/2-{fmt(P['cup_len']+2.1)}]) cylinder(h=0.8,r1={fmt(P['body_r'])},r2={fmt(P['cup_or'])});
}}
"""


if __name__ == "__main__":
    build()
