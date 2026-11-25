import cadquery as cq

# ===== 下轴 lower_shaft : 加长到 z=74, 手轮键上移到 66..72 (让开Ø44旋梭体) =====
Z0, Z1 = 13.5, 74.0
s = cq.Workplane("XY").circle(7.0).extrude(Z1 - Z0).translate((0, 0, Z0))
s = s.union(cq.Workplane("XY").box(1.6, 2.4, 6.0).translate((7.2, 0, 69.0)))
result = s

datum_axis("shaft_axis", [0, 0, Z0], [0, 0, 1])
datum_cyl("journal", [0, 0, 21.0], [0, 0, 1], 7.0)
datum_plane("top", [0, 0, Z1], [0, 0, 1])
datum_plane("gear_seat", [0, 0, 14.4], [0, 0, 1])
datum_axis("crank_key", [8.0, 0, 66.0], [0, 0, 1])