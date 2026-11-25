import cadquery as cq

# ===== 铜衬套 bushing : 黄铜 CNC 车. 压入机架 Ø18 孔, 顶端法兰坐入沉孔 =====
b = cq.Workplane("XY").circle(9.0).extrude(14.0).translate((0, 0, 21.0))
b = b.union(cq.Workplane("XY").circle(12.0).extrude(2.0).translate((0, 0, 35.0)))
b = b.cut(cq.Workplane("XY").circle(7.2).extrude(20.0).translate((0, 0, 19.0)))
result = b

datum_axis("bush_axis", [0, 0, 21.0], [0, 0, 1])
datum_cyl("bore", [0, 0, 21.0], [0, 0, 1], 7.2)
datum_cyl("od", [0, 0, 21.0], [0, 0, 1], 9.0)
datum_plane("flange_top", [0, 0, 37.0], [0, 0, 1])