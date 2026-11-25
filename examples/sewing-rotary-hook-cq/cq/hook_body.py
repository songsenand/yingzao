import cadquery as cq
import math

# ===== 旋梭体 hook_body : 2x 演示尺度. 圆弧凸角(0.4升程), 梭尖顶63.6 =====
R_HOOK, R_CUP = 22.0, 18.0
Z_BOT, Z_FLOOR, Z_RIM, Z_BEAK = 37.0, 39.2, 62.0, 63.0
G_R, G_Z0, G_Z1 = 20.4, 56.0, 60.4
BORE, KEY_X, KEY_W = 14.2, 5.5, 3.0
CAM_R, CAM_Z0, CAM_Z1 = 22.4, 37.5, 43.5
CAM_A0, CAM_A1 = 170.0, 235.0
GAPE_A0, GAPE_A1 = 60.0, 120.0
BEAK_A0, BEAK_A1 = 30.0, 59.0

def P(r, a):
    a = math.radians(a)
    return (r * math.cos(a), r * math.sin(a))

def ann(r0, r1, a0, a1, n=16):
    o = [P(r1, a0 + (a1 - a0) * i / n) for i in range(n + 1)]
    i_ = [P(r0, a1 - (a1 - a0) * i / n) for i in range(n + 1)]
    return [o[0]] + o[1:] + i_

h = Z_RIM - Z_BOT
body = cq.Workplane("XY").circle(R_HOOK).extrude(h)
body = body.cut(cq.Workplane("XY").workplane(offset=Z_FLOOR - Z_BOT).circle(R_CUP).extrude(h))
body = body.cut((cq.Workplane("XY").circle(G_R).circle(R_CUP - 0.1)
                 .extrude(G_Z1 - G_Z0)).translate((0, 0, G_Z0 - Z_BOT)))
lobe = (cq.Workplane("XY").moveTo(*P(CAM_R, CAM_A0))
        .polyline(ann(21.0, CAM_R, CAM_A0, CAM_A1)[1:]).close()
        .extrude(CAM_Z1 - CAM_Z0)).translate((0, 0, CAM_Z0 - Z_BOT))
body = body.union(lobe)
prof = cq.Workplane("XZ").polyline([(22.0, Z_BEAK - 1.5 - Z_BOT), (R_CUP, Z_BEAK + 0.6 - Z_BOT),
                                     (R_CUP, Z_RIM - 2.0 - Z_BOT), (22.0, Z_RIM - 2.0 - Z_BOT)]).close()
prism = prof.extrude(40).translate((0, 20, 0)).rotate((0, 0, 0), (0, 0, 1), 45.0)
sect = (cq.Workplane("XY").moveTo(*P(21.9, BEAK_A0))
        .polyline(ann(18.0, 21.9, BEAK_A0, BEAK_A1)[1:]).close()
        .extrude(8)).translate((0, 0, Z_RIM - 2.0 - Z_BOT))
body = body.union(sect.intersect(prism))
body = body.cut((cq.Workplane("XY").moveTo(0, 0).lineTo(*P(32, GAPE_A0))
                 .lineTo(*P(32, GAPE_A1)).close()
                 .extrude((Z_BEAK + 6) - Z_FLOOR)).translate((0, 0, Z_FLOOR - Z_BOT)))
body = body.cut(cq.Workplane("XY").circle(BORE / 2.0).extrude(h + 8).translate((0, 0, -4)))
body = body.cut(cq.Workplane("XY").box(3.5, KEY_W, h + 8).translate((KEY_X + 1.75, 0, h / 2.0)))

result = body.translate((0, 0, Z_BOT))

datum_axis("hook_axis", [0, 0, Z_BOT], [0, 0, 1])
datum_cyl("bore", [0, 0, Z_BOT], [0, 0, 1], BORE / 2.0)
datum_plane("race_bottom", [0, 0, G_Z0], [0, 0, 1])
datum_cyl("cam_base", [0, 0, CAM_Z0], [0, 0, 1], R_HOOK)
datum("beak_tip", [R_CUP, 0, Z_BEAK + 0.6])
datum_cull_dummy = None