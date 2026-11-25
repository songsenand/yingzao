import cadquery as cq

# ===== 底板 base_plate : 不锈锉 304 3mm 钣金 激光切割+两道折弯 =====
bp = cq.Workplane("XY").box(117.0, 96.0, 3.0).translate((0, -4.0, 1.5))
for sx in (-1, 1):
    bp = bp.union(cq.Workplane("XY").box(7.5, 96.0, 10.0).translate((sx * 61.25, -4.0, 6.9)))
for sx in (-1, 1):
    for y in (-40.0, 27.0):
        bp = bp.cut(cq.Workplane("XY").circle(1.7).extrude(20).translate((sx * 26.0, y, -2.0)))
result = bp

datum_plane("floor", [0, 0, 0], [0, 0, 1])
datum_plane("top", [0, 0, 3], [0, 0, 1])
datum("leg_fl", [-26.0, -40.0, 3.0])
datum("leg_fr", [26.0, -40.0, 3.0])
datum("leg_bl", [-26.0, 27.0, 3.0])
datum("leg_br", [26.0, 27.0, 3.0])