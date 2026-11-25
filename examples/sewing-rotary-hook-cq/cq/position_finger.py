import cadquery as cq

# ===== 定位钩 finger : 不锈锉 1.5 钣金 冲剪+折弯. 固定梭壳不随旋梭转 =====
fg = cq.Workplane("XY").box(12.0, 2.5, 2.2).translate((0, 30.75, 30.1))
fg = fg.union(cq.Workplane("XY").box(12.0, 1.5, 37.2).translate((0, 30.4, 49.4)))
fg = fg.union(cq.Workplane("XY").box(4.0, 14.4, 1.4).translate((0, 24.0, 67.9)))
for x in (-4.0, 4.0):
    fg = fg.cut(cq.Workplane("XY").circle(1.7).extrude(4).translate((x, 30.4, 28.0)))
result = fg

datum("mount_face", [0, 30.4, 29.0])
datum_axis("blade_axis", [0, 20.0, 67.9], [0, 0, 1])
datum("blade_tip", [0, 17.2, 67.9])
datum_plane("blade_under", [0, 0, 67.2], [0, 0, 1])