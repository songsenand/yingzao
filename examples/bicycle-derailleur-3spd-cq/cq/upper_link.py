import cadquery as cq
from math import sin, cos, pi, radians, sqrt

L = 40.0; PHI = radians(22.0)
B = (0.0, 0.0, 20.0)
P = (L*sin(PHI), 0.0, 20.0 - L*cos(PHI))

def box(cx, cy, cz, sx, sy, sz):
    return cq.Solid.makeBox(sx, sy, sz, cq.Vector(cx-sx/2, cy-sy/2, cz-sz/2))
def cyl(p, d, r, h):
    return cq.Solid.makeCylinder(r, h, cq.Vector(*p), cq.Vector(*d))
def bar(p0, p1, w, t):
    dx = p1[0]-p0[0]; dz = p1[2]-p0[2]
    n = sqrt(dx*dx+dz*dz); ux, uz = dx/n, dz/n; nx, nz = -uz, ux
    pts = [(p0[0]+nx*w/2, p0[2]+nz*w/2), (p1[0]+nx*w/2, p1[2]+nz*w/2),
           (p1[0]-nx*w/2, p1[2]-nz*w/2), (p0[0]-nx*w/2, p0[2]-nz*w/2)]
    return cq.Workplane("XZ").polyline(pts).close().extrude(t).translate((0, t/2, 0)).val()

s = bar(B, P, 8.0, 6.0).fuse(
    cyl((0.0, -3.0, 20.0), (0,1,0), 7.0, 15.0),
    cyl((P[0], -3.0, P[2]), (0,1,0), 7.0, 6.0))
s = s.fuse(box(-6.0, 10.0, 20.0, 28.0, 4.0, 8.0))             # lever bar y 8..12, z 16..24
s = s.fuse(box(-20.0, 6.75, 20.0, 12.0, 3.5, 12.0))          # clamp block z 14..26
s = s.fuse(box(8.0, 10.0, 25.5, 10.0, 4.0, 3.0))              # spring pad z 24..27
s = s.cut(cyl((0.0,-4.0,20.0),(0,1,0),5.0,17.0))
s = s.cut(cyl((P[0],-4.0,P[2]),(0,1,0),5.0,8.0))
s = s.cut(cyl((0.0,-3.0,20.0),(0,1,0),7.0,1.5))
s = s.cut(cyl((P[0],1.5,P[2]),(0,1,0),7.0,1.5))
dd = (-10.0,0.0,-21.0); nn = sqrt(sum(v*v for v in dd)); du = tuple(v/nn for v in dd)
s = s.cut(cyl((-10.0,6.75,41.0), du, 1.0, 40.0))
s = s.cut(cyl((-20.0,4.0,20.0),(0,1,0),1.25,7.0))
res = cq.Workplane(obj=s)
res = res.edges(cq.selectors.BoxSelector((-7.2, -3.2, 12.8), (7.2, -2.8, 27.2))).chamfer(0.3)
result = res
datum_axis("B_axis",[0,0,20],[0,1,0])
datum_axis("P_axis",[14.984,0,-17.087],[0,1,0])
datum_cyl("B_bore",[0,0,20],[0,1,0],5)
datum_cyl("P_bore",[14.984,0,-17.087],[0,1,0],5)
datum("spring_pad",[8,10,27])
datum("spring_pad_contact",[8,11,27])
datum("cable_anchor",[-20,6.75,20])
datum("low_stop_face",[-12,10,16])
datum_plane("B_inboard",[0,-3,20],[0,-1,0])
