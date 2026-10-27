#!/usr/bin/env python3
"""从 molecule.json 生成 7 个零件的 SCAD 源文件 + spec/instances.json（装配实例表）。

接口（全零件统一，任意球与任意棍可互插）：
  socket = 小平台（定心平面，Ø6.8）+ 直孔 Ø5.20 + 卡槽 Ø5.90 + 泪滴排屑
  peg    = 台肩 Ø6.20（坐在平台上）+ 圆柱 Ø5.00 定心段 + 卡珠 Ø5.40 + 四瓣开缝 + 通气孔

定位原理：台肩面 ↔ 平台 = 轴向 + 两个倾角自由度；Ø5.00/Ø5.20 短圆柱 = 两个横向自由度。
卡珠只负责"不松脱"，不参与定位（就位时卡珠落在 Ø5.90 卡槽里，径向自由）。
"""
from __future__ import annotations

import json
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent
MOL = json.loads((HERE / "molecule.json").read_text(encoding="utf-8"))
P = MOL["params"]

# ------------------------------------------------------------------ 接口参数（唯一真源）
SOCK = {
    "spot_r": 3.40,     # 定心平台刀径（实际平台被球面截成 Ø6.32~6.80）
    "spot_d": 0.90,     # 平台距切点的深度（沿 socket 轴）
    "bore_r": 2.60,     # 直孔半径 Ø5.20
    "depth": 3.40,      # 自平台起的盲孔深（= peg 3.2 + 0.2 端隙）
    "groove_r": 2.95,   # 卡槽半径 Ø5.90
    "groove_z0": 2.15,   # 卡槽口侧面与卡珠口侧面同面（台肩落座即止退，无轴向游隙）
    "groove_z1": 3.05,
    "tear_r": 0.50,     # 泪滴排屑孔半径
    "tear_off": 2.85,   # 泪滴偏心（朝 +Z"屋顶"方向）
    "tear_z0": 0.50,
}
PEG = {
    "rod_r": 3.10,      # 杆 Ø6.20（= 台肩外径，坐在平台上）
    "land_r": 2.50,     # 定心圆柱 Ø5.00
    "land_to": 2.00,
    "bead_r": 2.70,     # 卡珠 Ø5.40 → 过 Ø5.20 喉口单边挤压 0.10
    "bead_z0": 2.18,    # 与卡槽口侧面留 0.03 装配余隙
    "bead_z1": 2.68,
    "chamf_to": 2.88,   # 卡珠前侧 45° 导入
    "tip_z": 3.20,      # 有效插深（socket 深 3.4，端隙 0.2）
    "tip_r": 1.60,
    "bore_r": 2.10,     # 通气/弹性孔 Ø4.20
    "bore_z0": 0.40,
    "bore_z1": 2.60,
    "slot_w": 0.60,
    "slot_z0": 0.00,    # 开缝从尖端开始（若从 0.4 起，槽端面会与导入锥面夹出 0.04mm 薄唇）
    "slot_z1": 2.80,    # 到距台肩 0.4 止 → 台肩定位环保持整圆
}
SEAT = SOCK["spot_d"]
ENGAGE = PEG["tip_z"]

FN = 72


# ------------------------------------------------------------------ 几何小工具
def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def axang(axis, ang):
    x, y, z = axis
    c, s = math.cos(ang), math.sin(ang)
    C = 1 - c
    return [
        [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
        [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
        [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
    ]


def f(x: float) -> str:
    s = f"{x:.4f}".rstrip("0").rstrip(".")
    return "0" if s in ("", "-0") else s


def socket_transform(d):
    """(rot_axis, rot_deg, roof_deg)：把 socket 局部 +Z 转到 -d（朝材料内部）。"""
    inward = [-x for x in d]
    axis = cross([0.0, 0.0, 1.0], inward)
    n = math.sqrt(sum(x * x for x in axis))
    if n < 1e-9:  # 轴与 +Z 共线：inward=+Z 则不转，inward=-Z 则翻 180°
        ax, ang = [1.0, 0.0, 0.0], (0.0 if inward[2] > 0 else 180.0)
    else:
        ax = [x / n for x in axis]
        ang = math.degrees(math.acos(max(-1.0, min(1.0, inward[2]))))
    R = axang(ax, math.radians(ang))
    up_local = [sum(R[j][i] * (1.0 if j == 2 else 0.0) for j in range(3)) for i in range(3)]
    up_local[2] = 0.0
    roof = 0.0 if math.hypot(up_local[0], up_local[1]) < 1e-9 else \
        math.degrees(math.atan2(up_local[1], up_local[0]))
    return ax, ang, roof


def socket_module() -> str:
    """socket 局部坐标：+Z 朝材料内部，定心平台在 z=0。"""
    return f"""// ---- socket（定心平台在 z=0，+Z 朝材料内部）----
module socket_cut(roofDeg = 0) {{
  // 定心平台：自平台外侧切到 z=0
  translate([0, 0, -2]) cylinder(h = 2, r = {f(SOCK['spot_r'])}, $fn = {FN});
  // 直孔
  cylinder(h = {f(SOCK['depth'])}, r = {f(SOCK['bore_r'])}, $fn = {FN});
  // 卡槽
  translate([0, 0, {f(SOCK['groove_z0'])}])
    cylinder(h = {f(SOCK['groove_z1'] - SOCK['groove_z0'])}, r = {f(SOCK['groove_r'])}, $fn = {FN});
  // 泪滴排屑（朝"屋顶"偏心，让近水平孔的上壁不塌）
  rotate([0, 0, roofDeg])
    translate([{f(SOCK['tear_off'])}, 0, {f(SOCK['tear_z0'])}])
      cylinder(h = {f(SOCK['depth'] - SOCK['tear_z0'])}, r = {f(SOCK['tear_r'])}, $fn = {FN});
}}
"""


def ball_part(element: str, radius: float, dirs: list[list[float]], title: str) -> str:
    r_mouth = radius - SEAT
    lines = [f"// {title}",
             f"// 球半径 R={f(radius)}；定心平台在球面下 {f(SEAT)}mm；打印姿态：按本文件姿态（+Z 朝上）",
             f"$fn = {FN};", ""]
    lines.append(socket_module())
    lines.append("difference() {")
    lines.append(f"  sphere(r = {f(radius)});")
    for d in dirs:
        ax, ang, roof = socket_transform(d)
        p = [r_mouth * x for x in d]
        lines.append(f"  // socket 轴 ({f(d[0])}, {f(d[1])}, {f(d[2])})")
        lines.append(f"  translate([{f(p[0])}, {f(p[1])}, {f(p[2])}])")
        lines.append(f"    rotate(a = {f(ang)}, v = [{f(ax[0])}, {f(ax[1])}, {f(ax[2])}])")
        lines.append(f"      socket_cut({f(roof)});")
    lines.append("}")
    lines.append("")
    for i, d in enumerate(dirs):
        p = [r_mouth * x for x in d]
        lines.append(f'datum_cyl("sock{i}", [{f(p[0])}, {f(p[1])}, {f(p[2])}], '
                     f'[{f(d[0])}, {f(d[1])}, {f(d[2])}], {f(SOCK["bore_r"])});')
    return "\n".join(lines) + "\n"


def stick_part(length: float, label: str) -> str:
    half = length / 2.0
    bore_len = PEG["bore_z1"] - PEG["bore_z0"]
    slot_len = PEG["slot_z1"] - PEG["slot_z0"]
    return f"""// {label}：两端台肩面间距 {f(length)}mm，两端另各伸出 {f(PEG['tip_z'])}mm 卡脚
// 杆 Ø{2*PEG['rod_r']:.1f}；卡脚 Ø{2*PEG['land_r']:.1f}，四瓣弹性（0.6 开缝），通气孔 Ø{2*PEG['bore_r']:.1f}
// 打印姿态：竖立，一端卡脚朝下（首层是 Ø5 环，建议 2mm brim）
$fn = {FN};
L = {f(length)};

// 卡脚：z=0 台肩面（定位面），+Z 朝外，尖端在 z=3.2
module peg() {{
  // 自 z=-0.4 起，与杆重叠 0.4（共面接触会让 union 变成多个 body）
  translate([0, 0, -0.4])
    cylinder(h = {f(PEG['bead_z0'] + 0.4)}, r = {f(PEG['land_r'])}, $fn = {FN});
  translate([0, 0, {f(PEG['bead_z0'])}])
    cylinder(h = {f(PEG['bead_z1'] - PEG['bead_z0'])}, r = {f(PEG['bead_r'])}, $fn = {FN});
  translate([0, 0, {f(PEG['bead_z1'])}])
    cylinder(h = {f(PEG['chamf_to'] - PEG['bead_z1'])}, r1 = {f(PEG['bead_r'])}, r2 = {f(PEG['land_r'])}, $fn = {FN});
  translate([0, 0, {f(PEG['chamf_to'])}])
    cylinder(h = {f(PEG['tip_z'] - PEG['chamf_to'])}, r1 = {f(PEG['land_r'])}, r2 = {f(PEG['tip_r'])}, $fn = {FN});
}}

// 去料：z=0 是尖端，+Z 朝台肩
module peg_relief() {{
  translate([0, 0, {f(PEG['bore_z0'])}]) cylinder(h = {f(bore_len)}, r = {f(PEG['bore_r'])}, $fn = {FN});
  for (r = [0, 90]) rotate([0, 0, r])
    translate([{f(-PEG['slot_w'] / 2)}, {f(-PEG['rod_r'] - 1)}, {f(PEG['slot_z0'])}])
      cube([{f(PEG['slot_w'])}, {f(2 * PEG['rod_r'] + 2)}, {f(slot_len)}], center = false);
}}

difference() {{
  union() {{
    cylinder(h = L, r = {f(PEG['rod_r'])}, $fn = {FN}, center = true);
    translate([0, 0, {f(-half)}]) rotate([180, 0, 0]) peg();
    translate([0, 0, {f(half)}]) peg();
  }}
  translate([0, 0, {f(-half - PEG['tip_z'])}]) peg_relief();
  translate([0, 0, {f(half + PEG['tip_z'])}]) rotate([180, 0, 0]) peg_relief();
}}

datum_cyl("pegA", [0, 0, {f(-half)}], [0, 0, -1], {f(PEG['land_r'])});
datum_cyl("pegB", [0, 0, {f(half)}], [0, 0, 1], {f(PEG['land_r'])});
datum("seatA", [0, 0, {f(-half)}]);
datum("seatB", [0, 0, {f(half)}]);
"""


# ------------------------------------------------------------------ 输出
def main() -> None:
    parts_dir = HERE / "parts"
    parts_dir.mkdir(exist_ok=True)

    R = P["RADII"]
    (parts_dir / "atom_C.scad").write_text(
        ball_part("C", R["C"], MOL["local_frames"]["C"],
                  "碳原子 C：四面体 4 孔（环上 5 个碳与 C6 共用此件）"), encoding="utf-8")
    (parts_dir / "atom_O.scad").write_text(
        ball_part("O", R["O"], MOL["local_frames"]["O"],
                  "氧原子 O：2 孔，夹角 109.47°（环氧 O5 与 5 个羟基氧共用）"), encoding="utf-8")
    (parts_dir / "atom_H.scad").write_text(
        ball_part("H", R["H"], MOL["local_frames"]["H"], "氢原子 H：单孔"), encoding="utf-8")

    lens: dict[float, list[str]] = {}
    for b in MOL["bonds"]:
        lens.setdefault(round(b["stick_len"], 2), []).append(b["kind"])
    stick_files = []
    for L in sorted(lens, reverse=True):
        name = f"stick_{L:.1f}"
        kinds = sorted(set(lens[L]))
        label = f"键棒 {name}：{'/'.join(kinds)}"
        (parts_dir / f"{name}.scad").write_text(stick_part(L, label), encoding="utf-8")
        stick_files.append({"file": f"parts/{name}.scad", "key": name, "length": L,
                            "kinds": kinds, "count": len(lens[L]), "label": label})

    instances = []
    for a in MOL["atoms"]:
        instances.append({
            "name": a["name"], "part_key": f"atom_{a['element']}", "kind": "atom",
            "element": a["element"], "atom": a["id"],
            "translate": [round(v, 4) for v in a["pos"]], "rotate": [round(v, 4) for v in a["rot"]],
        })
    sock_of = {}
    for a in MOL["atoms"]:
        for sm in a["socket_map"]:
            sock_of[(a["id"], sm["partner"])] = sm["local"]
    bond_instances = []
    for b in MOL["bonds"]:
        bond_instances.append({
            "name": f"键 {b['id']}", "part_key": f"stick_{b['stick_len']:.1f}", "kind": "stick",
            "bond": b["id"], "kind_of_bond": b["kind"], "length": b["length"],
            "translate": b["mid"], "rotate": b["rot"], "dir": b["dir"],
            "pegA_atom": b["atom_i"], "pegB_atom": b["atom_j"],
            "pegA_sock": sock_of[(b["atom_i"], b["atom_j"])],
            "pegB_sock": sock_of[(b["atom_j"], b["atom_i"])],
        })

    out = {"sock": SOCK, "peg": PEG, "seat": SEAT, "radii": R, "stick_files": stick_files,
           "instances": instances, "bond_instances": bond_instances,
           "counts": MOL["counts"], "bbox_mm": MOL["bbox_mm"]}
    (HERE / "instances.json").write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("sticks:", [(s["key"], s["count"], s["kinds"]) for s in stick_files])
    print("instances:", len(instances), "bonds:", len(bond_instances))


if __name__ == "__main__":
    main()
