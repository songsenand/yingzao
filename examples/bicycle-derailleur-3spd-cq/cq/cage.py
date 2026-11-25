import cadquery as cq
from math import sqrt
G = (15.0, 30.0, -103.0)
T = (15.0, -20.0, -123.0)
C = (15.0, 0.0, -73.0)
def box(cx, cy, cz, sx, sy, sz):
    return cq.Solid.makeBox(sx, sy, sz, cq.Vector(cx-sx/2, cy-sy/2, cz-sz/2))
def cyl(p, d, r, h):
    return cq.Solid.makeCylinder(r, h, cq.Vector(*p), cq.Vector(*d))
def yz_bar(p0, p1, w, t, x0):
    dy = p1[0]-p0[0]; dz = p1[1]-p0[1]
    n = sqrt(dy*dy+dz*dz); uy, uz = dy/n, dz/n; ny, nz = -uz, uy
    pts = [(p0[0]+ny*w/2, p0[1]+nz*w/2), (p1[0]+ny*w/2, p1[1]+nz*w/2),
           (p1[0]-ny*w/2, p1[1]-nz*w/2), (p0[0]-ny*w/2, p0[1]-nz*w/2)]
    return cq.Workplane("YZ").polyline(pts).close().extrude(t).translate((x0,0,0)).val()
parts = []
for x0 in (4.5, 21.5):
    parts.append(cyl((x0, 0.0, C[2]), (1,0,0), 8.5, 4.0))       # hub disc
    parts.append(yz_bar((0.0, C[2]), (G[1], G[2]), 14.0, 4.0, x0))
    parts.append(yz_bar((0.0, C[2]), (T[1], T[2]), 14.0, 4.0, x0))
    parts.append(box(x0+2.0, -16.5, -94.0, 4.0, 41.0, 8.0))      # channel side wall y -37..+4, z -98..-90
    parts.append(box(x0+2.0, -4.0, -77.5, 4.0, 16.0, 25.0))      # web y -12..+4, z -90..-65
    parts.append(cyl((x0, G[1], G[2]), (1,0,0), 10.0, 4.0))
    parts.append(cyl((x0, T[1], T[2]), (1,0,0), 10.0, 4.0))
parts.append(box(15.0, -16.5, -96.0, 13.0, 41.0, 4.0))           # channel floor
parts.append(box(15.0, -35.0, -92.0, 13.0, 4.0, 4.0))            # spring back wall
parts.append(cyl((4.0, 0.0, C[2]), (1,0,0), 7.0, 22.0))          # hub OD14
s = parts[0].fuse(*parts[1:])
s = s.cut(cyl((4.0, 0.0, C[2]), (1,0,0), 5.0, 22.0))
s = s.cut(cyl((4.0, G[1], G[2]), (1,0,0), 5.0, 22.0))
s = s.cut(cyl((4.0, T[1], T[2]), (1,0,0), 5.0, 22.0))
s = s.cut(box(15.0, 0.0, -88.0, 22.0, 12.0, 10.0))               # cam pin slot through plates
result = cq.Workplane(obj=s)
datum_axis("cage_axis",[15,0,-73],[1,0,0])
datum_axis("guide_axle",[15,30,-103],[1,0,0])
datum_axis("tension_axle",[15,-20,-123],[1,0,0])
datum("spring_seat",[15,-33,-91])
datum("slider_stop",[15,4,-91])
datum_cyl("hub_bore",[15,0,-73],[1,0,0],5)
datum_cyl("guide_bore",[15,30,-103],[1,0,0],5)
datum_cyl("tension_bore",[15,-20,-123],[1,0,0],5)
