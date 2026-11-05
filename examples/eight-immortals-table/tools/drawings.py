#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""八仙桌施工图（SVG + PNG）。尺寸取自 tools/gen.py，图与模型同源。

坐标：画板以 mm 计，scale 为图上 1mm 代表实际多少 mm。
"""
import os
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle, Polygon
from matplotlib.lines import Line2D

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "drawings")
os.makedirs(OUT, exist_ok=True)

plt.rcParams["font.family"] = ["Noto Sans CJK JP", "DejaVu Sans"]
plt.rcParams["axes.unicode_minus"] = False
INK = "#1a1a1a"
HID = "#7d7d7d"
WOOD = "#f2e4cd"
CUT = "#e6d3b3"


class Sheet:
    def __init__(self, w_mm, h_mm, scale):
        self.scale = scale
        self.W, self.H = w_mm * scale, h_mm * scale
        self.fig = plt.figure(figsize=(w_mm / 25.4, h_mm / 25.4), dpi=220)
        self.ax = self.fig.add_axes([0, 0, 1, 1])
        self.ax.set_xlim(0, self.W)
        self.ax.set_ylim(0, self.H)
        self.ax.set_aspect("equal")
        self.ax.axis("off")

    def rect(self, x, y, w, h, lw=0.8, fc="none", ec=INK, ls="-", z=2):
        self.ax.add_patch(Rectangle((x, y), w, h, lw=lw, fc=fc, ec=ec, ls=ls, zorder=z))

    def poly(self, pts, lw=0.8, fc="none", ec=INK, ls="-", z=2):
        self.ax.add_patch(Polygon(pts, closed=True, lw=lw, fc=fc, ec=ec, ls=ls, zorder=z))

    def line(self, x1, y1, x2, y2, lw=0.7, c=INK, ls="-", z=3):
        self.ax.add_line(Line2D([x1, x2], [y1, y2], lw=lw, color=c, ls=ls, zorder=z))

    def text(self, x, y, s, size=7, ha="center", va="center", c=INK, rot=0, weight="normal"):
        self.ax.text(x, y, s, fontsize=size, ha=ha, va=va, color=c, rotation=rot,
                     zorder=9, weight=weight)

    def dimh(self, x1, x2, y, s=None, size=6.5, gap=10):
        t = 6
        self.line(x1, y, x2, y, lw=0.45)
        for x in (x1, x2):
            self.line(x, y - t, x, y + t, lw=0.45)
            self.line(x, y, x + (t if x == x1 else -t), y, lw=0.45)
        self.line(x1, y + 4, x1, y + gap, lw=0.35, c=HID)
        self.line(x2, y + 4, x2, y + gap, lw=0.35, c=HID)
        self.text((x1 + x2) / 2, y + 7, s if s else f"{abs(x2-x1):.0f}", size=size)

    def dimv(self, y1, y2, x, s=None, size=6.5, gap=10):
        t = 6
        self.line(x, y1, x, y2, lw=0.45)
        for y in (y1, y2):
            self.line(x - t, y, x + t, y, lw=0.45)
            self.line(x, y, x, y + (t if y == y1 else -t), lw=0.45)
        self.line(x - 4, y1, x - gap, y1, lw=0.35, c=HID)
        self.line(x - 4, y2, x - gap, y2, lw=0.35, c=HID)
        self.text(x - 7, (y1 + y2) / 2, s if s else f"{abs(y2-y1):.0f}", size=size, rot=90)

    def title(self, s, sub, x=None, y=None):
        self.text(x or self.W / 2, y or self.H - 14 * 10, s, size=11, weight="bold")
        self.text(x or self.W / 2, (y or self.H - 14 * 10) - 18, sub, size=7, c="#555")

    def save(self, name):
        self.fig.savefig(os.path.join(OUT, name + ".svg"), format="svg", facecolor="white")
        self.fig.savefig(os.path.join(OUT, name + ".png"), format="png", facecolor="white")
        plt.close(self.fig)
        print("drawing", name)


def dims():
    return gen


# ============================================================ 01 总体
def sheet_views():
    s = Sheet(594, 420, scale=5)  # A2, 1:5
    s.title("八仙桌 900×900×800 · 总体尺寸", "单位 mm · 比例 1:5 · 图号 01")

    # ---- 俯视 ----
    ox, oy = 620, 1180
    s.rect(ox - 450, oy - 450, 900, 900, lw=1.1)
    s.rect(ox - 370, oy - 370, 740, 740, lw=0.8)
    for y in (-123, 123):
        s.line(ox - 369, oy + y, ox + 369, oy + y, lw=0.4, c=HID)
    for x in (-244, 0, 244):
        s.line(ox + x, oy - 368, ox + x, oy + 368, lw=0.4, c=HID, ls=(0, (6, 3)))
    for sx in (-1, 1):
        for sy in (-1, 1):
            s.line(ox + sx * 370, oy + sy * 370, ox + sx * 450, oy + sy * 450, lw=0.4)
    s.text(ox, oy + 40, "面板：3 块拼板 244+242+244", size=7, c="#444")
    s.text(ox, oy, "穿带 3 根（虚线）", size=7, c="#444")
    s.text(ox, oy - 545, "俯视 1:5", size=8)
    s.dimh(ox - 450, ox + 450, oy - 510, "900")
    s.dimh(ox - 370, ox + 370, oy - 475, "740 内口")
    s.dimv(oy - 450, oy + 450, ox - 520, "900")

    # ---- 正视 ----
    fx, fy = 1900, 820
    s.rect(fx - 450, fy, 900, 50, lw=1.1, fc=WOOD)
    s.rect(fx - 390, fy - 70, 780, 70, lw=0.9, fc=WOOD)
    for sx in (-1, 1):
        s.rect(fx + sx * 450 - (60 if sx > 0 else 0), fy - 750, 60, 750, lw=1.0, fc=WOOD)
    s.text(fx, fy - 810, "正视 1:5", size=8)
    s.dimv(fy, fy + 800, fx - 560, "800")
    s.dimv(fy, fy + 50, fx + 560, "50")
    s.dimv(fy - 70, fy, fx + 560, "70")
    s.dimh(fx - 390, fx + 390, fy - 150, "780")
    s.dimh(fx - 450, fx - 390, fy - 200, "60 腿")
    s.dimv(fy - 750, fy, fx - 560, "750 腿高")

    # ---- 说明 ----
    s.text(70, 380, "材料  1000×300×300 方木 2 根（含余量）\n"
           "构件  最长毛料 930（边框），全部 < 1000\n"
           "连接  榫卯 + 木楔 + 竹销，无金属件\n"
           "胶    仅拼板缝用动物胶（骨胶），非承力",
           size=8, ha="left", va="top")
    s.save("01-views")


# ============================================================ 02 角部
def sheet_corner():
    s = Sheet(420, 297, scale=2)  # A3, 1:2 -> 数据空间 840 x 594（即实际 mm）
    s.title("角部节点：格角榫 / 腿顶榫 / 抱肩透榫", "1:2 · 单位 mm · 图号 02", y=560)

    # ---- 平面（角部，实际 mm）----
    ox, oy = 245, 430
    s.rect(ox - 140, oy - 80, 140, 80, fc=WOOD, lw=0.8, z=1)    # +y 边框（向左伸）
    s.rect(ox - 80, oy - 140, 80, 140, fc=WOOD, lw=0.8, z=1)    # +x 边框（向下伸）
    s.line(ox, oy, ox - 80, oy - 80, lw=0.9)                    # 45° 格角
    s.line(ox - 140, oy - 80, ox - 80, oy - 80, lw=0.8)
    s.line(ox - 80, oy - 140, ox - 80, oy - 80, lw=0.8)
    s.line(ox - 140, oy, ox, oy, lw=0.8)
    s.line(ox, oy - 140, ox, oy, lw=0.8)
    s.rect(ox - 60, oy - 60, 60, 60, lw=0.8, ls=(0, (5, 3)), fc="none")   # 腿（虚）
    s.rect(ox - 40, oy - 40, 40, 40, lw=0.6, ls=(0, (2, 2)), fc="none")   # 腿榫
    s.line(ox - 69, oy - 69, ox - 81, oy - 81, lw=0.4, c="#b06a2a")
    s.dimh(ox - 80, ox, oy + 18, "80 边框")
    s.dimh(ox - 60, ox, oy + 42, "60 腿")
    s.text(ox - 44, oy - 44, "40×40 腿榫", size=5.5, c=HID, rot=-40)
    s.text(ox - 96, oy - 96, "45° 格角缝", size=6, rot=-45, ha="right")
    s.text(ox - 40, oy - 165, "平面 1:2", size=8)

    # ---- 竖剖：只画腿顶 300mm 段（z 500..800），下口折断线 ----
    lx, yb = 560, 80           # yb 对应 z=500
    def zy(z):
        return yb + (z - 500)
    s.rect(lx - 30, zy(500), 60, zy(750) - zy(500), lw=1.0, fc=WOOD)      # 腿
    s.rect(lx - 50, zy(680), 20, zy(750) - zy(680), lw=0.9, fc=CUT)       # 牙板（左）
    s.rect(lx + 30, zy(680), 20, zy(750) - zy(680), lw=0.9, fc=CUT)       # 牙板（右）
    s.rect(lx + 30, zy(700), 40, zy(740) - zy(700), lw=0.9, fc=CUT)       # 透榫出10
    s.poly([(lx + 70, zy(718.4)), (lx + 79, zy(718.4)),
            (lx + 79, zy(721.6)), (lx + 70, zy(721.6))], fc="#8a5522", lw=0.4)
    s.line(lx + 30, zy(720), lx + 70, zy(720), lw=0.4, c=HID, ls=(0, (2, 2)))
    s.rect(lx - 52, zy(700), 22, zy(740) - zy(700), lw=0.6, ls=(0, (2, 2)), fc="none")
    s.text(lx - 26, zy(760), "腿顶榫 40×40×20", size=5.5, ha="left", c=HID)
    # 边框（局部）
    s.rect(lx - 250, zy(750), 500, 50, lw=1.0, fc=WOOD)
    s.line(lx - 20, zy(750), lx - 20, zy(800), lw=0.5)
    s.line(lx + 20, zy(750), lx + 20, zy(800), lw=0.5)
    s.line(lx - 30, zy(774), lx + 30, zy(774), lw=0.5, c=HID, ls=(0, (2, 2)))
    s.line(lx - 30, zy(784), lx + 30, zy(784), lw=0.5, c=HID, ls=(0, (2, 2)))
    s.text(lx + 26, zy(779), "格角暗榫 40×10×32", size=5.5, ha="left", c=HID)
    s.text(lx + 76, zy(714), "木楔", size=6, ha="left")
    s.text(lx - 56, zy(690), "闷榫 22", size=5.5, ha="right", c=HID)
    s.text(lx + 52, zy(670), "45° 抱肩", size=5.5, ha="left")
    # 标注
    s.dimv(zy(680), zy(750), lx - 78, "70")
    s.dimv(zy(700), zy(740), lx + 90, "40")
    s.dimv(zy(750), zy(800), lx + 90, "50")
    s.dimh(lx - 30, lx + 30, zy(480), "60")
    # 折断线
    for i in range(6):
        xx = lx - 30 + i * 10
        s.line(xx, zy(500) - 4, xx + 6, zy(500) + 4, lw=0.4, c=HID)
    s.text(lx, zy(455), "腿足纵剖 1:2（示牙板榫、腿顶榫）", size=8)

    s.text(40, 200, "① 边框两端 45° 格角，各自在 45° 面正中出暗榫 40×10×32，互插。\n"
           "② 腿顶 40×40×20 方榫上插，跨压两条边框的格角缝——三向交圈，角部主受力。\n"
           "③ 牙板一端透榫（穿腿 60、出 10，横楔撑紧），另一端闷榫 22；端头 45° 抱肩。\n"
           "④ Ø8 竹销自底面打入格角暗榫，锁住角部，不外露于台面。",
           size=7.2, ha="left", va="top")
    s.save("02-corner")


# ============================================================ 03 穿带
def sheet_cleat():
    s = Sheet(420, 297, scale=2)  # A3, 1:2
    s.title("攒边打槽装面板 · 穿带防翘", "1:2 · 单位 mm · 图号 03", y=560)

    ox, yb = 110, 380           # yb 对应 z=750
    def zy(z):
        return yb + (z - 750)
    s.rect(ox, zy(750), 80, 50, lw=1.0, fc=CUT)                 # 边框
    s.rect(ox + 80, zy(778), 400, 22, lw=1.0, fc=WOOD)          # 面板
    s.rect(ox + 70, zy(786), 10, 6, lw=1.0, fc=WOOD)            # 舌榫
    s.line(ox + 80, zy(786), ox + 80, zy(792), lw=0.6)
    s.rect(ox + 200, zy(752), 40, zy(778) - zy(752), lw=1.0, fc=CUT)   # 穿带身
    s.poly([(ox + 205, zy(778)), (ox + 235, zy(778)),
            (ox + 240, zy(784)), (ox + 200, zy(784))], lw=1.0, fc=CUT)  # 燕尾
    s.line(ox + 240, zy(778), ox + 272, zy(778), lw=0.5, c=HID, ls=(0, (3, 2)))
    s.text(ox + 276, zy(766), "两端距边框 7mm\n胀缩缝，不顶死", size=6, ha="left")
    s.text(ox + 180, zy(806), "面板 22", size=6)
    s.text(ox + 150, zy(742), "穿带 40×26", size=6)
    s.dimv(zy(778), zy(800), ox + 470, "22")
    s.dimv(zy(750), zy(800), ox - 26, "50")
    s.dimh(ox, ox + 80, zy(720), "80")
    s.dimh(ox + 200, ox + 240, zy(720), "40")
    s.text(ox + 200, zy(690), "面板—边框—穿带 竖剖 1:2", size=8)

    # 燕尾 1:1
    bx, by = 520, 300
    s.poly([(bx, by), (bx + 60, by), (bx + 74, by + 24), (bx - 14, by + 24)], lw=1.0, fc=CUT)
    s.poly([(bx, by), (bx + 60, by), (bx + 46, by - 24), (bx + 14, by - 24)], lw=1.0, fc=WOOD)
    s.text(bx + 30, by + 42, "燕尾 30→44 × 高 6", size=6.5)
    s.text(bx + 30, by - 46, "面板底开燕尾槽，穿带挂住面板", size=6.5)
    s.text(bx + 30, by - 68, "穿带断面 1:1", size=7)

    s.text(40, 120, "面板三条板（244+242+244）以龙凤榫拼接，穿簧 15.6×5.8 卧入；拼缝只起密闭找平作用，不承担结构拉力。\n"
           "面板出 6×14 舌榫落入边框 14 深槽内：肩部留 5mm、槽底留 5mm 胀缩量；不胶、不钉、不顶死。\n"
           "穿带三根（x=-244/0/+244）：燕尾挂住面板，两端距边框 7mm——只校平防翘、不撑紧，面板可胀 5mm。",
           size=7.2, ha="left", va="top")
    s.save("03-cleat")


if __name__ == "__main__":
    sheet_views()
    sheet_corner()
    sheet_cleat()
