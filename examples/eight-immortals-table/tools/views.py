#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""出图用视图：剖面 / 细部。只读 parts.scad，不改几何。"""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAD = os.path.join(ROOT, "cad")

COL = {
    "leg": "0.42,0.28,0.16", "rail": "0.54,0.37,0.21", "apron": "0.49,0.33,0.19",
    "panel_outer": "0.82,0.66,0.45", "panel_middle": "0.85,0.70,0.49",
    "cleat": "0.62,0.44,0.26", "spline": "0.88,0.78,0.58",
    "wedge": "0.30,0.19,0.10", "pin": "0.86,0.80,0.55",
}


def c(name, ang=0, tr=(0, 0, 0)):
    return (f"color([{COL[name]}]) translate([{tr[0]},{tr[1]},{tr[2]}]) "
            f"rotate([0,0,{ang}]) {name}();")


def write(name, body):
    with open(os.path.join(CAD, name), "w", encoding="utf-8") as f:
        f.write("include <parts.scad>\n" + body + "\n")


# A. 角部竖剖：只取角部构件，过腿中心 x=420 切掉外侧，再限制在角部范围内
body = ("difference(){\n intersection(){\n  union(){\n"
        + c("leg") + c("rail") + c("rail", 270) + c("apron") + c("apron", 270)
        + c("wedge") + c("pin", 0, (418, 384, 0))
        + "\n  }\n  translate([340,340,600]) cube([140,170,230]);\n }\n"
        + " translate([420,300,590]) cube([300,300,260]);\n}\n")
write("v_leg_section.scad", body)

# B. 角部水平剖面：切在 z=779（格角暗榫层），保留四角
body = ("difference(){\n union(){\n"
        + "".join(c("rail", a) for a in (0, 90, 180, 270))
        + "".join(c("leg", a) for a in (0, 90, 180, 270))
        + "".join(c("apron", a) for a in (0, 90, 180, 270))
        + "\n }\n translate([-600,-600,779]) cube([1200,1200,400]);\n}\n")
write("v_frame_plan.scad", body)

# C. 角部爆炸细部
lay = (c("leg", 0) + c("rail", 0, (0, 0, 300)) + c("rail", 270, (0, 0, 300))
       + c("apron", 0, (0, 80, 0)) + c("apron", 270, (80, 0, 0))
       + c("wedge", 0, (40, 0, 0)) + c("pin", 0, (0, 0, 330)))
write("v_corner_explode.scad", lay)

# D. 底面（穿带 / 燕尾）
body = "".join(c("cleat", 0, (x, 0, 0)) for x in (-244, 0, 244))
body += c("panel_outer") + c("panel_outer", 180) + c("panel_middle")
write("v_bottom_detail.scad", body)
print("views written")
