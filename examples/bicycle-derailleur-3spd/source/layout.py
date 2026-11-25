#!/usr/bin/env python3
"""3 档后拨链器 — 布局参数（唯一数值来源）。

坐标系（零件建模帧，所有零件共用；装配时整体绕 Z 转 -TILT_DEG）：
    X = 换档方向（向外为正，向小飞轮）
    Y = 枢轴轴向（板厚方向）
    Z = 上（连杆中位方向）

装配位姿：机构按 1 档建模（theta = -THETA_M），运动仿真的驱动从 1 档扫到 3 档。
所有尺寸 mm。运行：python3 source/layout.py
"""
from __future__ import annotations

import math

# ---- 总体参数 -------------------------------------------------------------
TILT_DEG = 16.0            # 机构平面相对飞轮轴的倾角
L = 30.0                   # 连杆枢轴距（A-C, B-D）
S = 12.0                   # 底座两枢轴 X 向间距（A-B）
THETA_M = 9.5941           # 半行程摆角（度，=asin(1/6)）；X_body = L*sin(theta)
CABLE_R = 30.0             # 钢缆夹半径（相对 A 枢轴）；总缆移 = 2R·sinθm = 10.0

COG_PITCH = 5.0            # 飞轮片间距（1/8" 三速）
GEARS = (0.0, 5.0, 10.0)   # 三档目标横向位移

# 弹簧库件: (库ID, 线径, 外径, 自由长, 有效圈数[估算])
SPRINGS = {
    "main":   ("din2098.1.5x16x40", 1.5, 16.0, 40.0, 13),
    "detent": ("din2098.0.8x8x20",  0.8,  8.0, 20.0,  8),
    "cage":   ("din2098.1.0x10x25", 1.0, 10.0, 25.0,  8),
}
G_MPA = 79300.0            # 弹簧钢剪切模量

MAIN_INSTALLED_G1 = 34.0   # 1 档安装长度（free 40 → 预压 6）
DETENT_INSTALLED = 14.0    # free 20 → 预压 6
DETENT_TRAVEL = 2.0
CAGE_INSTALLED = 20.0      # free 25 → 预压 5
CAGE_TRAVEL = 3.0
CAGE_LEVER_MM = 14.0       # 凸轮接触半径

BEARING_ID = "iso15.6000"  # 10 × 26 × 8
BEARING_OD, BEARING_ID_MM, BEARING_W = 26.0, 10.0, 8.0
PULLEY_OD = 42.0
PULLEY_W = 9.0

# ---- 关键点（建模帧，1 档位姿）--------------------------------------------

def rot(theta_deg: float, x: float, z: float) -> tuple[float, float]:
    """绕 +Y 轴旋转（右手：+theta 把 +X 转向 -Z）。"""
    t = math.radians(theta_deg)
    return (x * math.cos(t) + z * math.sin(t), -x * math.sin(t) + z * math.cos(t))


THETA1, THETA2, THETA3 = -THETA_M, 0.0, +THETA_M

PIVOT_A = (0.0, 0.0, 0.0)
PIVOT_B = (S, 0.0, 0.0)
_cx, _cz = rot(THETA1, 0.0, L)
PIVOT_C = (_cx, 0.0, _cz)
PIVOT_D = (S + _cx, 0.0, _cz)

CLAMP_X, CLAMP_Z = rot(THETA1, CABLE_R, 0.0)
CLAMP = (CLAMP_X, 0.0, CLAMP_Z)
CABLE_X = CABLE_R * math.cos(math.radians(THETA_M))   # 两端同 X，钢缆竖直
CABLE_PULL_TOTAL = 2 * CABLE_R * math.sin(math.radians(THETA_M))

X_GEARS = [round(L * math.sin(math.radians(t)) - L * math.sin(math.radians(THETA1)), 3)
           for t in (THETA1, THETA2, THETA3)]

# 导轮架（cage）：绕 X 轴，枢轴在活动座 C 的外侧
CAGE_PIVOT = (PIVOT_C[0] + 9.5, 0.0, 30.0)
GUIDE_PULLEY = (CAGE_PIVOT[0], -16.0, 12.0)
TENSION_PULLEY = (CAGE_PIVOT[0], -34.0, -18.0)


def rate(wire: float, od: float, coils: int) -> float:
    """k = G d^4 / (8 D^3 n)，D 取中径。"""
    return G_MPA * wire ** 4 / (8 * (od - wire) ** 3 * coils)


def _report() -> None:
    print("== 布局 ==")
    print(f"tilt β = {TILT_DEG}° (横向 {math.cos(math.radians(TILT_DEG)):.3f}, 前后 {math.sin(math.radians(TILT_DEG)):.3f})")
    print(f"L = {L}, s = {S}, θm = {THETA_M}° → 总摆角 {2*THETA_M}°")
    print(f"PIVOT A = {PIVOT_A}\nPIVOT B = {PIVOT_B}")
    print(f"PIVOT C (gear1) = ({PIVOT_C[0]:.3f}, {PIVOT_C[2]:.3f})")
    print(f"PIVOT D (gear1) = ({PIVOT_D[0]:.3f}, {PIVOT_D[2]:.3f})")
    print(f"三档 X 位移 = {X_GEARS}")
    print(f"clamp = ({CLAMP[0]:.3f}, {CLAMP[2]:.3f})  clampX = {CABLE_X:.3f}")
    print(f"钢缆总位移 = {CABLE_PULL_TOTAL:.3f} mm (每档 {CABLE_PULL_TOTAL/2:.3f})")

    print("\n== 弹簧 ==")
    for name, (sid, wire, od, free, coils) in SPRINGS.items():
        print(f"{name:6s} {sid:22s} wire={wire} od={od} free={free} n={coils} "
              f"k≈{rate(wire, od, coils):.2f} N/mm solid≈{(coils+1)*wire:.1f}")

    _, mw, mod, mfree, mn = SPRINGS["main"]
    k_main = rate(mw, mod, mn)
    len1 = MAIN_INSTALLED_G1
    len3 = MAIN_INSTALLED_G1 - CABLE_PULL_TOTAL
    print(f"主弹簧 安装 {len1:.2f} → {len3:.2f}；力 {k_main*(mfree-len1):.1f} → "
          f"{k_main*(mfree-len3):.1f} N（钢缆张力同值，同半径）")
    print(f"主弹簧 3 档离并圈余量 = {len3 - (mn+1)*mw:.1f} mm")

    _, dw, dod, dfree, dn = SPRINGS["detent"]
    k_det = rate(dw, dod, dn)
    print(f"定位弹簧 力 {k_det*(dfree-DETENT_INSTALLED):.1f} → "
          f"{k_det*(dfree-DETENT_INSTALLED+DETENT_TRAVEL):.1f} N")
    _, cw, cod, cfree, cn = SPRINGS["cage"]
    k_cage = rate(cw, cod, cn)
    fc = k_cage * (cfree - CAGE_INSTALLED + CAGE_TRAVEL)
    print(f"张紧弹簧 力 {fc:.1f} N → 凸轮扭矩 {fc*CAGE_LEVER_MM/1000:.3f} N·m")

    print("\n== 导轮 ==")
    print(f"轴承 {BEARING_ID}: Ø{BEARING_OD} × {BEARING_W} W, 内孔 Ø{BEARING_ID_MM}")
    print(f"导轮 OD {PULLEY_OD}（轮缘壁 {(PULLEY_OD-BEARING_OD)/2:.1f}）")


if __name__ == "__main__":
    _report()
