import cadquery as cq
from math import sin, cos, pi, radians, sqrt
L = 40.0; PHI = radians(22.0)
B = (0.0, 0.0, -20.0)
P = (L*sin(PHI), 0.0, -20.0 - L*cos(PHI))
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
    cyl((B[0], -3.0, B[2]), (0,1,0), 7.0, 6.0),
    cyl((P[0], -3.0, P[2]), (0,1,0), 7.0, 6.0))
s = s.cut(cyl((0.0,-4.0,-20.0),(0,1,0),5.0,8.0))
s = s.cut(cyl((P[0],-4.0,P[2]),(0,1,0),5.0,8.0))
s = s.cut(cyl((0.0,-3.0,-20.0),(0,1,0),7.0,1.5))
s = s.cut(cyl((P[0],1.5,P[2]),(0,1,0),7.0,1.5))
res = cq.Workplane(obj=s)
res = res.edges(cq.selectors.BoxSelector((7.8, 2.8, -64.2), (22.2, 3.2, -50.0))).chamfer(0.3)
result = res
datum_axis("B_axis",[0,0,-20],[0,1,0])
datum_axis("P_axis",[14.984,0,-57.087],[0,1,0])
datum_cyl("B_bore",[0,0,-20],[0,1,0],5)
datum_cyl("P_bore",[14.984,0,-57.087],[0,1,0],5)
