import cadquery as cq

# ===== 手轮 crank : 抬到 z=68..76, 跨在旋梭顶上方 =====
k = cq.Workplane("XY").circle(17.0).extrude(8.0).translate((0, 0, 68.0))
k = k.union(cq.Workplane("XY").box(12.0, 28.0, 6.0).translate((0, -26.0, 72.0)))
k = k.union(cq.Workplane("XY").circle(5.5).extrude(18.0).translate((0, -40.0, 70.0)))
k = k.cut(cq.Workplane("XY").circle(7.2).extrude(12.0).translate((0, 0, 67.0)))
x0, x1 = 6.7, 8.5
k = k.cut(cq.Workplane("XY").box(x1 - x0, 3.2, 14.0).translate(((x0 + x1) / 2.0, 0, 71.0)))
result = k

datum_axis("crank_axis", [0, 0, 68.0], [0, 0, 1])
datum_cyl("bore", [0, 0, 68.0], [0, 0, 1], 7.2)
datum("handle", [0, -40.0, 88.0])
datum_plane("face", [0, 0, 76.0], [0, 0, 1])