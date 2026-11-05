#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""八仙桌参数化模型生成器（单位 mm，z 轴向上，桌面中心为原点）。

单一尺寸源：零件 SCAD、装配布局、下料表、工程图都从这里取数。

坐标约定
    桌面外廓 900 x 900，台面顶 z = 800，地面 z = 0。
    四条腿位于四角：x,y 均为 390..450（外皮与边框外皮平齐）。
    0° 基准件：+y 侧边框 / +y 侧牙板 / (+x,+y) 角腿 / -y 半边板。
    其余实例由绕 z 轴旋转 0/90/180/270 得到（面板边板另用 180° 镜像位）。

竖向分层（关键，榫卯在此层叠）
    750..800  边框（50 厚）；面板 778..800 平镶；面板槽 785.8..792.2
    774..784  格角暗榫（10 厚，位于槽下、腿榫上）
    750..770  腿顶方榫（40x40x20，闷榫）
    680..750  牙板（70 高）
"""
import json
import math
import os

# ---------------------------------------------------------------- 总尺寸
T = 900                 # 桌面外廓
H = 800                 # 桌面高

# 边框（攒边）
FW = 80                 # 边框宽（进深）
FT = 50                 # 边框厚
FZ = 750                # 边框底面
OPEN = 370              # 边框内口半宽（内口 740）
GROOVE_D = 14           # 面板槽深（370 -> 384），留面板胀缩
GROOVE_H = 6.4          # 面板槽高
GROOVE_Z = 785.8        # 槽底标高

# 面板
PH = 22                 # 面板厚（778..800，平镶）
PZ = 778
PHALF = 365             # 面板板身边缘（与内口留 5mm 胀缩量）
TONGUE_OUT = 14         # 舌榫伸出（365 -> 379），槽深 14 留 5mm
TONGUE_T = 6            # 舌榫厚
TONGUE_Z = 786          # 舌榫底（与槽居中）

# 腿
LEG = 60                # 腿断面
LX0 = T / 2 - LEG       # 390
LEG_H = 750             # 腿高（到边框底）
TEN_W = 40              # 腿顶榫断面
TEN_H = 20              # 腿顶榫高（750..770）

# 格角暗榫
MITRE_Z0 = 774          # 774..784，10 厚
MITRE_T = 10

# 牙板（无束腰直牙板）
AP_H = 70               # 牙板高（680..750）
AP_T = 20               # 牙板厚
AP_Z0 = 680
AP_INSET = 6            # 牙板外皮比腿外皮缩进
AP_Y0 = T / 2 - AP_INSET - AP_T      # 424
AP_Y1 = T / 2 - AP_INSET             # 444
TEN2_T = 14             # 牙板榫厚（427..441）
TEN2_Z0 = 700           # 牙板榫高（700..740）
TEN2_Z1 = 740
THRU_LEN = 70           # 透榫长（390..460）
BLIND_LEN = 22          # 闷榫长

# 穿带
CL_W = 40               # 带宽
CL_H = 26               # 带身高（752..778）
CL_Z0 = 752
CL_LEN = 726            # 长（两端距边框 7mm，容面板胀 5mm）
CL_X = [-244, 0, 244]
DT_H = 6                # 燕尾高（778..784）
DT_W0 = 30              # 燕尾下宽
DT_W1 = 44              # 燕尾上宽
DT_Z0 = 778

# 拼板
BOARD_W = 246           # 单板宽（3 x 246 = 738）
BOARD_L = 738
SPL_G = 8               # 龙凤榫槽深
SPL_T = 6.2             # 槽高
SPL_SPINE = 15.6        # 穿簧宽
SPL_SPINE_T = 5.8       # 穿簧厚
SPL_SPINE_L = 720

# 紧固
WEDGE_KERF = 3.2        # 楔槽高
WEDGE_W = 13.2          # 楔宽
PIN_R = 4.0             # 竹销半径
PIN_L = 34              # 竹销长（750..784）

CLEAR = 0.2             # 榫卯单边配合间隙

# ---------------------------------------------------------------- SCAD 片段
def box(x0, x1, y0, y1, z0, z1):
    return (f"translate([{x0:.3f},{y0:.3f},{z0:.3f}]) "
            f"cube([{x1-x0:.3f},{y1-y0:.3f},{z1-z0:.3f}]);")


def wedge_prism(x0, x1, y0, y1, z_bot0, z_bot1, h0, h1):
    """x 向渐厚的斜楔（hull 两块薄板）。"""
    return ("hull(){ "
            + box(x0, x0 + 1, y0, y1, z_bot0, z_bot0 + h0) + " "
            + box(x1 - 1, x1, y0, y1, z_bot1, z_bot1 + h1) + " }")


# ---- 腿 -------------------------------------------------------------------
def scad_leg():
    return f"""
module leg(){{
  difference(){{
    union(){{
      {box(LX0, LX0+LEG, LX0, LX0+LEG, 0, LEG_H)}
      {box(T/2-50, T/2-10, T/2-50, T/2-10, LEG_H, LEG_H+TEN_H)}
    }}
    // 牙板透榫槽（沿 +x，+y 侧牙板 A 端穿入）
    {box(LX0-1, LX0+LEG+1, 427-CLEAR, 441+CLEAR, TEN2_Z0-CLEAR, TEN2_Z1+CLEAR)}
    // 牙板闷榫槽（沿 +y，+x 侧牙板 B 端）
    {box(427-CLEAR, 441+CLEAR, LX0-1, LX0+BLIND_LEN+CLEAR, TEN2_Z0-CLEAR, TEN2_Z1+CLEAR)}
  }}
}}
"""


# ---- 边框 -----------------------------------------------------------------
def scad_rail():
    pts = f"[[-{OPEN},{OPEN}],[{OPEN},{OPEN}],[{T/2},{T/2}],[-{T/2},{T/2}]]"
    d = math.cos(math.radians(45))
    # 格角暗榫：中心在45°面中点，向邻框伸 32
    ten = (f"translate([{410+15*d:.3f},{410-15*d:.3f},{MITRE_Z0+MITRE_T/2}]) "
           f"rotate([0,0,-45]) cube([34,40,{MITRE_T}],center=true);")
    mor = (f"translate([{-410+16.2*d:.3f},{410+16.2*d:.3f},{MITRE_Z0+MITRE_T/2}]) "
           f"rotate([0,0,45]) cube([34.4,40.4,{MITRE_T+0.4}],center=true);")
    return f"""
module rail(){{
  difference(){{
    union(){{
      translate([0,0,{FZ}]) linear_extrude(height={FT}) polygon(points={pts});
      {ten}
    }}
    // 面板槽：全长开通至 45° 端面（角部两框的槽合起来成 L 形）
    {box(-T/2, T/2, OPEN, OPEN+GROOVE_D, GROOVE_Z, GROOVE_Z+GROOVE_H)}
    // 腿顶榫卯（两端各半，合起来 40x40x20）
    {box(T/2-50-CLEAR, T/2-10+CLEAR, T/2-50-CLEAR, T/2-10+CLEAR, FZ, FZ+TEN_H+0.4)}
    {box(-(T/2-10)-CLEAR, -(T/2-50)+CLEAR, T/2-50-CLEAR, T/2-10+CLEAR, FZ, FZ+TEN_H+0.4)}
    // 格角暗榫卯
    {mor}
    // 竹销孔：+x 端穿暗榫，-x 端穿本体
    translate([418,384,{FZ}]) cylinder(h={PIN_L},r={PIN_R},$fn=40);
    translate([-384,418,{FZ}]) cylinder(h={PIN_L},r={PIN_R},$fn=40);
  }}
}}
"""


# ---- 牙板 -----------------------------------------------------------------
def scad_apron():
    sh_p = ("hull(){ " + box(375, 390, AP_Y0-0.5, AP_Y1+0.5, AP_Z0, AP_Z0+0.2)
            + " " + box(389.8, 390, AP_Y0-0.5, AP_Y1+0.5, AP_Z0, AP_Z0+15) + " }")
    sh_m = ("hull(){ " + box(-390, -375, AP_Y0-0.5, AP_Y1+0.5, AP_Z0, AP_Z0+0.2)
            + " " + box(-390, -389.8, AP_Y0-0.5, AP_Y1+0.5, AP_Z0, AP_Z0+15) + " }")
    return f"""
module apron(){{
  difference(){{
    union(){{
      {box(-390, 390, AP_Y0, AP_Y1, AP_Z0, FZ)}
      // A 端：透榫（390..460）
      {box(390, 390+THRU_LEN, 427, 441, TEN2_Z0, TEN2_Z1)}
      // B 端：闷榫（-412..-390）
      {box(-390-BLIND_LEN, -390, 427, 441, TEN2_Z0, TEN2_Z1)}
    }}
    {sh_p}
    {sh_m}
    // 透榫楔槽（横槽，撑开榫头上下两片）
    {box(428, 460.2, 426.9, 441.1, (TEN2_Z0+TEN2_Z1)/2-WEDGE_KERF/2, (TEN2_Z0+TEN2_Z1)/2+WEDGE_KERF/2)}
  }}
}}
"""


# ---- 面板 -----------------------------------------------------------------
def scad_panel_outer():
    # 边板：y -365..-121；外长边 y=-365 与两短边出舌；内侧 y=-121 开穿簧槽
    poly = ("[[-379,-121],[-379,-377],[-377,-379],[377,-379],[379,-377],"
            "[379,-121],[365,-121],[365,-365],[-365,-365],[-365,-121]]")
    grooves = "\n    ".join(
        ["hull(){ " + box(x-DT_W0/2-CLEAR, x+DT_W0/2+CLEAR, -365, -121, DT_Z0, DT_Z0+0.1)
         + " " + box(x-DT_W1/2-CLEAR, x+DT_W1/2+CLEAR, -365, -121, DT_Z0+DT_H-0.1, DT_Z0+DT_H) + " }"
         for x in CL_X])
    return f"""
module panel_outer(){{
  difference(){{
    union(){{
      {box(-PHALF, PHALF, -365, -121, PZ, H)}
      translate([0,0,{TONGUE_Z}]) linear_extrude(height={TONGUE_T}) polygon(points={poly});
    }}
    // 内侧龙凤榫槽（向板内 8 深：y -129..-121）
    {box(-PHALF, PHALF, -121-SPL_G, -121, GROOVE_Z, GROOVE_Z+GROOVE_H)}
    // 穿带燕尾槽
    {grooves}
  }}
}}
"""


def scad_panel_middle():
    grooves = "\n    ".join(
        ["hull(){ " + box(x-DT_W0/2-CLEAR, x+DT_W0/2+CLEAR, -121, 121, DT_Z0, DT_Z0+0.1)
         + " " + box(x-DT_W1/2-CLEAR, x+DT_W1/2+CLEAR, -121, 121, DT_Z0+DT_H-0.1, DT_Z0+DT_H) + " }"
         for x in CL_X])
    return f"""
module panel_middle(){{
  difference(){{
    union(){{
      {box(-PHALF, PHALF, -121, 121, PZ, H)}
      {box(365, 379, -121, 121, TONGUE_Z, TONGUE_Z+TONGUE_T)}
      {box(-379, -365, -121, 121, TONGUE_Z, TONGUE_Z+TONGUE_T)}
    }}
    // 两侧龙凤榫槽（各向板内 8 深）
    {box(-PHALF, PHALF, -121, -121+SPL_G, GROOVE_Z, GROOVE_Z+GROOVE_H)}
    {box(-PHALF, PHALF, 121-SPL_G, 121, GROOVE_Z, GROOVE_Z+GROOVE_H)}
    {grooves}
  }}
}}
"""


# ---- 穿带 -----------------------------------------------------------------
def scad_cleat():
    return f"""
module cleat(){{
  union(){{
    {box(-CL_W/2, CL_W/2, -CL_LEN/2, CL_LEN/2, CL_Z0, DT_Z0)}
    hull(){{
      {box(-DT_W0/2, DT_W0/2, -CL_LEN/2, CL_LEN/2, DT_Z0-0.1, DT_Z0-0.05)}
      {box(-DT_W1/2, DT_W1/2, -CL_LEN/2, CL_LEN/2, DT_Z0+DT_H-0.2, DT_Z0+DT_H-0.1)}
    }}
  }}
}}
"""


def scad_spline():
    return (f"module spline(){{ "
            f"{box(-SPL_SPINE_L/2, SPL_SPINE_L/2, -SPL_SPINE/2, SPL_SPINE/2, 786.1, 791.9)} }}")


def scad_wedge():
    zm = (TEN2_Z0 + TEN2_Z1) / 2
    return ("module wedge(){ " + wedge_prism(
        435, 468, 427.4, 440.6, zm-0.6, zm-1.5, 1.2, 3.0) + " }")


def scad_pin():
    return f"module pin(){{ translate([0,0,{FZ}]) cylinder(h={PIN_L},r={PIN_R},$fn=40); }}"


PARTS = [
    # (文件名, 模块名, 中文名, 颜色)
    ("leg", "leg", "桌腿", [0.42, 0.28, 0.16]),
    ("rail", "rail", "边框", [0.54, 0.37, 0.21]),
    ("apron", "apron", "牙板", [0.49, 0.33, 0.19]),
    ("panel_outer", "panel_outer", "面板-边板", [0.82, 0.66, 0.45]),
    ("panel_middle", "panel_middle", "面板-中板", [0.85, 0.70, 0.49]),
    ("cleat", "cleat", "穿带", [0.62, 0.44, 0.26]),
    ("spline", "spline", "穿簧", [0.88, 0.78, 0.58]),
    ("wedge", "wedge", "木楔", [0.30, 0.19, 0.10]),
    ("pin", "pin", "竹销", [0.86, 0.80, 0.55]),
]

PART_CODE = {
    "leg": scad_leg, "rail": scad_rail, "apron": scad_apron,
    "panel_outer": scad_panel_outer, "panel_middle": scad_panel_middle,
    "cleat": scad_cleat, "spline": scad_spline, "wedge": scad_wedge, "pin": scad_pin,
}

# ---------------------------------------------------------------- 装配实例
def instances():
    out = []
    names = {0: "pp", 90: "np", 180: "nn", 270: "pn"}
    for a in (0, 90, 180, 270):
        out.append((f"leg_{names[a]}", "leg", a, [0, 0, 0], [0, 0, -70]))
    for a in (0, 90, 180, 270):
        out.append((f"rail_{names[a]}", "rail", a, [0, 0, 0], [0, 0, 230]))
    for a in (0, 90, 180, 270):
        out.append((f"apron_{names[a]}", "apron", a, [0, 0, 0], [0, 0, 0]))
    out.append(("panel_outer_s", "panel_outer", 0, [0, 0, 0], [0, 0, 320]))
    out.append(("panel_outer_n", "panel_outer", 180, [0, 0, 0], [0, 0, 320]))
    out.append(("panel_middle", "panel_middle", 0, [0, 0, 0], [0, 0, 320]))
    for i, x in enumerate(CL_X):
        out.append((f"cleat_{i}", "cleat", 0, [x, 0, 0], [0, 0, 150]))
    out.append(("spline_s", "spline", 0, [0, -121, 0], [0, 0, 320]))
    out.append(("spline_n", "spline", 0, [0, 121, 0], [0, 0, 320]))
    for a in (0, 90, 180, 270):
        out.append((f"wedge_{names[a]}", "wedge", a, [0, 0, 0], [0, 0, 240]))
    for nm, x, y in (("pp", 418, 384), ("np", -384, 418), ("nn", -418, -384), ("pn", 384, -418)):
        out.append((f"pin_{nm}", "pin", 0, [x, y, 0], [0, 0, 240]))
    return out


INST = instances()

# ---------------------------------------------------------------- 输出
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAD = os.path.join(ROOT, "cad")


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def emit():
    os.makedirs(CAD, exist_ok=True)
    lib = "$fn=40;\n"
    for fn, mod, cn, col in PARTS:
        lib += f"\n// ---- {cn} ----\n" + PART_CODE[fn]()
    write(os.path.join(CAD, "parts.scad"), lib)

    for fn, mod, cn, col in PARTS:
        write(os.path.join(CAD, fn + ".scad"),
              f"// {cn}（0° 基准件，位于整机坐标系中）\n"
              f"include <parts.scad>\n{mod}();\n")

    def asm(offsets_too, name):
        body = "include <parts.scad>\n"
        cmap = dict((p[0], p[3]) for p in PARTS)
        for nm, mod, ang, tr, off in INST:
            o = off if offsets_too else [0, 0, 0]
            c = cmap[mod]
            body += (f"color([{c[0]},{c[1]},{c[2]}]) "
                     f"translate([{tr[0]+o[0]},{tr[1]+o[1]},{tr[2]+o[2]}]) "
                     f"rotate([0,0,{ang}]) {mod}();\n")
        write(os.path.join(CAD, name), body)

    asm(False, "assembly.scad")
    asm(True, "exploded.scad")

    # 角部细部（去掉面板）
    body = "include <parts.scad>\n"
    cmap = dict((p[0], p[3]) for p in PARTS)
    for nm, mod, ang, tr, off in INST:
        if "panel" in nm or "spline" in nm:
            continue
        c = cmap[mod]
        body += (f"color([{c[0]},{c[1]},{c[2]}]) "
                 f"translate([{tr[0]},{tr[1]},{tr[2]}]) rotate([0,0,{ang}]) {mod}();\n")
    write(os.path.join(CAD, "corner.scad"), body)

    # 竖向剖面（切掉 y>0 一半）
    body = "include <parts.scad>\n"
    for nm, mod, ang, tr, off in INST:
        c = cmap[mod]
        body += (f"color([{c[0]},{c[1]},{c[2]}]) "
                 f"translate([{tr[0]},{tr[1]},{tr[2]}]) rotate([0,0,{ang}]) {mod}();\n")
    inner = body.replace("include <parts.scad>\n", "")
    body = ("include <parts.scad>\ndifference(){\n union(){\n" + inner
            + " }\n translate([-600,-600,-10]) cube([1200,600,1000]);\n}\n")
    write(os.path.join(CAD, "section.scad"), body)

    write(os.path.join(ROOT, "assembly", "instances.json"),
          json.dumps([{"name": n, "part": m, "rotate": [0, 0, a], "translate": t}
                      for n, m, a, t, o in INST], ensure_ascii=False, indent=1))

    emit_cutlist()


# ---------------------------------------------------------------- 下料
PARTS_LIST = [
    ("边框", 4, (900, 80, 50), (930, 86, 56), "两端 45° 格角，一榫一卯；全长面板槽；腿榫卯"),
    ("桌腿", 4, (60, 60, 770), (70, 70, 780), "含 40×40×20 顶榫；牙板透榫/闷榫槽各一"),
    ("牙板", 4, (872, 20, 70), (900, 26, 76), "一端透榫一端闷榫；端头 45° 抱肩；楔槽"),
    ("面板-边板", 2, (730, 244, 22), (752, 256, 26), "外长边与两短边出舌；内侧龙凤榫槽"),
    ("面板-中板", 1, (730, 242, 22), (752, 254, 26), "两长边龙凤榫槽；两短边出舌"),
    ("穿带", 3, (726, 40, 32), (740, 46, 38), "燕尾 30/44×6；两端距边框 7mm 胀缩缝"),
    ("穿簧", 2, (720, 15.6, 5.8), (730, 20, 9), "龙凤榫内穿簧，隐蔽件"),
    ("木楔", 4, (33, 13.2, 3), (40, 16, 8), "透榫楔，硬木劈料，楔头外露 4mm"),
    ("竹销", 4, (34, 8, 8), (40, 10, 10), "Ø8 竹销，从底面打入角部暗榫"),
]


def emit_cutlist():
    rows = []
    vol = 0.0
    for name, qty, fin, rough, note in PARTS_LIST:
        v = fin[0] * fin[1] * fin[2] * qty / 1e9
        vol += v
        rows.append({"name": name, "qty": qty, "finished": fin, "rough": rough,
                     "note": note, "volume_m3": round(v, 6)})
    write(os.path.join(ROOT, "assembly", "cutlist.json"),
          json.dumps({"parts": rows, "netVolumeM3": round(vol, 5)}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    emit()
    print("generated ->", CAD)
