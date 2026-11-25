import cadquery as cq
import math

# ===== 梭壳 bobbin_case : 黄铜 CNC 车+铣, 2x 尺度 =====
def P(r, a):
    a = math.radians(a)
    return (r * math.cos(a), r * math.sin(a))

def ann(r0, r1, a0, a1, n=24):
    o = [P(r1, a0 + (a1 - a0) * i / n) for i in range(n + 1)]
    i_ = [P(r0, a1 - (a1 - a0) * i / n) for i in range(n + 1)]
    return [o[0]] + o[1:] + i_

OD, BORE = 16.4, 14.0                     # 外径32.8 / 内孔28 (旋梭杯内径36)
Z0, Z_FLOOR = 40.0, 41.6
LIP_R0, LIP_R1, LIP_Z0, LIP_Z1 = 16.4, 20.2, 56.6, 59.6   # 梭档唇边 (坐在旋梭环槽里)
RIS_R1 = 16.4
BRIM_Z0, BRIM_Z1, BRIM_R1 = 67.0, 69.0, 23.0
BRIM_A0, BRIM_A1 = 25.0, 155.0            # 顶部压边弧
NOTCH_A0, NOTCH_A1 = 82.0, 98.0           # 定位钩缺口
POST_R, POST_TOP = 5.0, 47.5              # 中心柱 (梭芯套在上面)
TSLOT_A0, TSLOT_A1, TSLOT_Z = 84.0, 96.0, 53.0

b = cq.Workplane("XY").circle(OD).circle(BORE).extrude(LIP_Z0 - Z0)
b = b.union(cq.Workplane("XY").circle(BORE + 0.4).extrude(Z_FLOOR - Z0 + 0.2))
b = b.union(cq.Workplane("XY").circle(POST_R).extrude(POST_TOP - 41.4).translate((0, 0, 41.4 - Z0)))
b = b.union((cq.Workplane("XY").circle(LIP_R1).circle(LIP_R0)
             .extrude(LIP_Z1 - LIP_Z0 + 0.2)).translate((0, 0, LIP_Z0 - 0.2 - Z0)))
b = b.union((cq.Workplane("XY").circle(RIS_R1).circle(BORE)
             .extrude(BRIM_Z0 - LIP_Z1 + 0.2)).translate((0, 0, LIP_Z1 - 0.2 - Z0)))
b = b.union((cq.Workplane("XY").moveTo(*P(BRIM_R1, BRIM_A0))
             .polyline(ann(14.0, BRIM_R1, BRIM_A0, BRIM_A1)[1:]).close()
             .extrude(BRIM_Z1 - BRIM_Z0 + 0.2)).translate((0, 0, BRIM_Z0 - 0.2 - Z0)))
b = b.cut((cq.Workplane("XY").moveTo(0, 0).lineTo(*P(24, NOTCH_A0))
           .lineTo(*P(24, NOTCH_A1)).close().extrude(4)).translate((0, 0, BRIM_Z0 - 1.5 - Z0)))
b = b.cut((cq.Workplane("XY").moveTo(0, 0).lineTo(*P(18, TSLOT_A0))
           .lineTo(*P(18, TSLOT_A1)).close().extrude(3.0)).translate((0, 0, TSLOT_Z - Z0)))

result = b.translate((0, 0, Z0))

datum_axis("case_axis", [0, 0, Z0], [0, 0, 1])
datum_cyl("bore", [0, 0, Z0], [0, 0, 1], BORE)
datum_plane("lip_plane", [0, 0, LIP_Z0], [0, 0, 1])
datum_plane("brim_under", [0, 0, BRIM_Z0], [0, 0, 1])
datum_cyl("post", [0, 0, Z_FLOOR], [0, 0, 1], POST_R)
datum("notch_center", [0, 20.0, 68.0])