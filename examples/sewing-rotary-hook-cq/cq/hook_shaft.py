import cadquery as cq

# ===== 旋梭轴 hook_shaft : Ø14, 顶部 2.4×1.0 平键 (在衬套上方, 可穿入衬套) =====
Z0, Z1 = 13.5, 39.0
s = cq.Workplane("XY").circle(7.0).extrude(Z1 - Z0).translate((0, 0, Z0))
s = s.union(cq.Workplane("XY").box(1.6, 2.4, 2.0).translate((7.2, 0, 38.0)))
result = s

datum_axis("shaft_axis", [0, 0, Z0], [0, 0, 1])
datum_cyl("journal", [0, 0, 21.0], [0, 0, 1], 7.0)
datum_plane("top", [0, 0, Z1], [0, 0, 1])
datum_plane("gear_seat", [0, 0, 14.4], [0, 0, 1])
datum_axis("hook_key", [8.0, 0, 37.0], [0, 0, 1])