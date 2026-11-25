import cadquery as cq
from math import sin, cos, pi, radians
N = 10
R_TIP = 22.5
R_ROOT = 18.0
W = 12.0
pts = []
for i in range(N):
    a = 2*pi*i/N
    for da, r in [(-18, R_ROOT), (-12, R_ROOT), (-9, R_TIP), (9, R_TIP), (12, R_ROOT)]:
        ang = a + radians(da)
        pts.append((r*cos(ang), r*sin(ang)))
w = cq.Workplane("YZ").polyline(pts).close().extrude(W).translate((-W/2,0,0))
s = w.val()
# bearing bore 26 through, shoulders 22 x 2 deep each side
s = s.cut(cq.Solid.makeCylinder(13.0, W+2, cq.Vector(-W/2-1,0,0), cq.Vector(1,0,0)))
s = s.cut(cq.Solid.makeCylinder(11.0, 2.0, cq.Vector(-W/2,0,0), cq.Vector(1,0,0)))
s = s.cut(cq.Solid.makeCylinder(11.0, 2.0, cq.Vector(W/2-2,0,0), cq.Vector(1,0,0)))
result = cq.Workplane(obj=s)
datum_axis("axis",[0,0,0],[1,0,0])
datum_cyl("bearing_seat",[0,0,0],[1,0,0],13)
datum_plane("face",[6,0,0],[1,0,0])
