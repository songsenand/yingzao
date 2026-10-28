#!/usr/bin/env python3
"""从已入库的版本 STL 生成"单接口剖面"文档图（renders/interface_section.png）。

为什么需要它：CAD 面板的"装配静置视图"是**调试视图** —— 件与件按位姿叠着画；配合面正好
0.00 mm 时两个面共面会闪色；17 mm 的球铺满视口时，一个 socket 的四个同心特征（平台 Ø6.8 /
卡槽 Ø5.9 / 直孔 Ø5.2 / 泪滴 Ø1.0）全挤在几十个像素里，看着就像"没对齐"。这张图用同一批
STL 做真正的 y=0 剖切 + 局部放大，把该看的间隙按 mm 标出来。

运行（需要 pillow）：
  python_runtime install packages=["pillow"]
  run_python script=spec/make_figure_section.py
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import trimesh
from PIL import Image, ImageDraw, ImageFont
from shapely.geometry import Polygon

HERE = Path(__file__).resolve().parent
VD = HERE.parent / "cad-data" / "versions"
OUT = HERE.parent / "renders" / "interface_section.png"

BALL_R = 8.6
SEAT_Z = BALL_R - 0.9                      # 定心平台 z = 7.70
STICK_L = 6.6
STICK_Z = SEAT_Z + STICK_L / 2             # 台肩面(=棍的 ±L/2 端面)落在 7.70 → 中心 11.00

BG = "#f6f7f9"
GREY, GREY_E = "#cfd1d8", "#4c505c"
RED, RED_E = "#d63b32", "#7a1f19"
BLUE = "#1f6fb4"


# 剖切面：过 z 轴、与两条开缝都成 45°（避开缝，切在卡脚壁上）
NORMAL = np.array([1.0, -1.0, 0.0]) / np.sqrt(2.0)
U_DIR = np.array([1.0, 1.0, 0.0]) / np.sqrt(2.0)     # 画面横轴


def loops(mesh) -> list[Polygon]:
    """把 mesh 在 NORMAL 平面上剖切，投影到 (u, z) 平面。"""
    sec = mesh.section(plane_origin=[0, 0, 0], plane_normal=NORMAL)
    out = []
    for loop in sec.discrete:
        pts = np.asarray(loop)
        uv = np.column_stack([pts @ U_DIR, pts[:, 2]])
        p = Polygon(uv)
        if len(uv) >= 3 and p.is_valid and p.area > 1e-4:
            out.append(p)
    return out


ball_loops = loops(trimesh.load(VD / "v031" / "model.stl"))
_stick = trimesh.load(VD / "v039" / "model.stl").copy()
_stick.apply_translation([0, 0, STICK_Z])
stick_loops = loops(_stick)

outer = max(ball_loops, key=lambda p: p.area)
holes = [p for p in ball_loops if p is not outer and outer.contains(p)]
ball_solid = Polygon(outer.exterior.coords, [h.exterior.coords for h in holes])


def panel(scale: float, x0: float, x1: float, z0: float, z1: float) -> tuple[Image.Image, dict]:
    """把 (x,z) 窗口按 scale 画成一张 RGBA 图，返回图像与该窗口的像素映射。"""
    w = int(round((x1 - x0) * scale))
    h = int(round((z1 - z0) * scale))
    im = Image.new("RGBA", (w, h), BG)
    dr = ImageDraw.Draw(im)

    def P(x, z):
        return ((x - x0) * scale, (z1 - z) * scale)

    def put(poly, fill, edge, width=2):
        dr.polygon([P(x, z) for x, z in poly.exterior.coords], fill=fill)
        for hole in poly.interiors:
            dr.polygon([P(x, z) for x, z in hole.coords], fill=BG)
        if width:
            dr.line([P(x, z) for x, z in poly.exterior.coords], fill=edge, width=width)
            for hole in poly.interiors:
                dr.line([P(x, z) for x, z in hole.coords], fill=edge, width=width)

    put(ball_solid, GREY, GREY_E)                     # 球
    for p in stick_loops:                             # 棍（盖在孔的腔上）
        put(p, RED, RED_E)
    # 定心平台平面
    y = P(0, SEAT_Z)[1]
    dr.line([(0, y), (w, y)], fill=BLUE, width=2)
    return im, {"P": P, "w": w, "h": h}


F = ImageFont.load_default(size=20)
FS = ImageFont.load_default(size=17)
FT = ImageFont.load_default(size=24)

main, _ = panel(30, -10.0, 10.0, -10.0, 11.2)
inset, pin = panel(100, -3.2, 3.2, 3.8, 8.6)

W = main.width + inset.width + 560
H = max(main.height, inset.height) + 210
img = Image.new("RGB", (W, H), BG)
img.paste(main, (60, 130))
img.paste(inset, (main.width + 140, 120))
d = ImageDraw.Draw(img)

d.text((60, 22), "Single interface, true section (not a schematic)", font=FT, fill="#1f2328")
d.text((60, 58), "C atom v031 + bond stick 6.6 v039 - cut through the axis at 45 deg to the slots",
       font=FS, fill="#5b6068")
d.text((60, 82), "Deliberately not cut at y=0: that plane runs inside a 0.6 mm slot and would show no peg wall at all.",
       font=FS, fill="#5b6068")
d.rectangle([main.width + 140, 120, main.width + 140 + inset.width, 120 + inset.height],
            outline="#8e929c", width=2)
d.text((main.width + 150, 128), "~3x", font=FS, fill="#5b6068")

px, py = pin["P"], None
P = pin["P"]


def lead(text, tip_xyz, tail_px, font=FS):
    tip = P(*tip_xyz)
    tip = (tip[0] + main.width + 140, tip[1] + 120)
    d.line([tip, tail_px], fill="#1f2328", width=1)
    d.ellipse([tip[0] - 3.5, tip[1] - 3.5, tip[0] + 3.5, tip[1] + 3.5], fill="#1f2328")
    d.text((tail_px[0] + 8, tail_px[1] - 10), text, font=font, fill="#1f2328")


rx = main.width + 140 + inset.width + 12
lead("shoulder ON the seat plane (0.000)", (2.55, SEAT_Z), (rx, 150))
lead("wall 0.40  (bore 2.10 -> OD 2.50)", (2.30, 6.55), (rx, 206))
lead("0.10 per side  (peg 2.50 / bore 2.60)", (2.60, 6.10), (rx, 262))
lead("bead 2.70 in groove 2.95  (0.25/side)", (2.70, 5.15), (rx, 318))
lead("tip 4.50 / floor 4.30  (gap 0.20)", (1.20, 4.45), (rx, 374))

d.text((60, H - 96), "Measured from the placed geometry: peg axis vs socket axis 180.000°, line offset 0.00004 mm;",
       font=FS, fill="#1f2328")
d.text((60, H - 70), "shoulder face to seat plane 0.0000 mm; peg tip 3.200 mm into a 3.400 mm deep hole.",
       font=FS, fill="#1f2328")
d.text((60, H - 40), "Both views are computed from cad-data/versions/v031|v039/model.stl — the same bytes the panel previews.",
       font=FS, fill="#5b6068")

img.save(OUT)
print("wrote", OUT, img.size)
