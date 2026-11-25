import cadquery as cq

# ===== 梭芯 bobbin : PLA FDM. 座位抬到 41.8 (梭壳底板实际顶面 41.8) =====
FL_R, BAR_R, BORE_R = 13.5, 6.5, 5.1
Z0 = 41.8
fl1 = cq.Workplane("XY").circle(FL_R).circle(BORE_R).extrude(1.6).translate((0, 0, Z0))
bar = cq.Workplane("XY").circle(BAR_R).circle(BORE_R).extrude(2.8).translate((0, 0, Z0 + 1.6))
fl2 = cq.Workplane("XY").circle(FL_R).circle(BORE_R).extrude(1.6).translate((0, 0, Z0 + 4.4))
result = fl1.union(bar).union(fl2)

datum_axis("bob_axis", [0, 0, Z0], [0, 0, 1])
datum_cyl("bore", [0, 0, Z0], [0, 0, 1], BORE_R)
datum_plane("seat", [0, 0, Z0], [0, 0, 1])
datum_cyl("wind", [0, 0, Z0 + 1.6], [0, 0, 1], FL_R)