import cadquery as cq

# ===== 开梭钩 opener_lever : 不锈锉 1.5 激光切平板. 铰轴 (y=26,z=33), 跟踪旋梭底部凸轮 =====
ol = [(24.0, 30.0), (24.0, 36.2), (22.55, 36.2), (22.55, 44.2), (23.6, 45.2), (23.6, 64.4),
      (19.6, 64.4), (19.6, 66.6), (28.8, 66.6), (28.8, 30.0)]
lv = cq.Workplane("YZ").moveTo(*ol[0]).polyline(ol[1:]).close().extrude(1.5)
lv = lv.cut(cq.Workplane("YZ").circle(2.1).extrude(4).translate((0, 26.0, 33.0)))
lv = lv.translate((-0.5, 0, 0))
result = lv

datum_axis("hinge", [0, 26.0, 33.0], [1, 0, 0])
datum_plane("shoe", [0, 22.55, 40.0], [0, 1, 0])
datum("prong", [0, 21.0, 66.6])
datum_plane("tab_top", [0, 0, 66.6], [0, 0, 1])