import cadquery as cq
from math import sqrt

def box(cx, cy, cz, sx, sy, sz):
    return cq.Solid.makeBox(sx, sy, sz, cq.Vector(cx-sx/2, cy-sy/2, cz-sz/2))
def cyl(p, d, r, h):
    return cq.Solid.makeCylinder(r, h, cq.Vector(*p), cq.Vector(*d))

parts = []
parts.append(box(0.0, -7.5, 2.0, 12.0, 5.0, 58.0))            # plate z -27..31
parts.append(cyl((-10.0, -20.0, -6.0), (1,0,0), 14.0, 20.0))  # mount boss
parts.append(box(7.5, -6.5, 20.0, 15.0, 3.0, 18.0))           # upper ear z 11..29
parts.append(box(7.5, -6.5, -20.0, 15.0, 3.0, 18.0))          # lower ear z -29..-11
parts.append(box(8.0, 1.5, 29.0, 10.0, 19.0, 4.0))            # return tube bracket y -8..11, z 27..31
parts.append(cyl((8.0, 11.0, 29.0), (0,0,1), 7.5, 31.0))      # return tube z 29..60
parts.append(box(8.0, 11.0, 61.5, 20.0, 20.0, 3.0))          # top flange z 60..63, cap seat
parts.append(box(-12.0, 11.75, 12.25, 8.0, 5.5, 6.5))           # low stop arm x -13..-8, z 9..16
parts.append(box(-12.0, 11.75, 29.7, 8.0, 5.5, 6.0))           # high stop arm z 26.7..32.7
parts.append(box(-7.0, 2.75, 7.75, 4.0, 21.5, 3.5))            # low stop bridge x -9..-5, z 6..9.5
parts.append(box(-7.0, 2.75, 29.5, 4.0, 21.5, 3.0))            # high stop bridge z 28..31
parts.append(box(-4.0, 4.5, 39.75, 4.0, 25.0, 18.5))          # cable bracket y -8..17, z 30.5..49
parts.append(box(-10.0, 9.75, 43.0, 16.0, 14.5, 12.0))        # cable boss z 37..49
s = parts[0].fuse(*parts[1:])
# mount bore / counterbores
s = s.cut(cyl((-11.0, -20.0, -6.0), (1,0,0), 5.25, 22.0))
s = s.cut(cyl((4.0, -20.0, -6.0), (1,0,0), 8.5, 6.0))
s = s.cut(cyl((-10.0, -20.0, -6.0), (1,0,0), 8.5, 6.0))
# ear pin bores
s = s.cut(cyl((0.0, -9.0, 20.0), (0,1,0), 3.0, 5.0))
s = s.cut(cyl((0.0, -9.0, -20.0), (0,1,0), 3.0, 5.0))
# return spring cavity and stem hole
s = s.cut(cyl((8.0, 11.0, 32.0), (0,0,1), 6.25, 28.0))
s = s.cut(cyl((8.0, 11.0, 60.0), (0,0,1), 6.25, 3.0))         # open the top: plunger/spring insert from +Z
s = s.cut(cyl((8.0, 11.0, 27.0), (0,0,1), 3.0, 5.0))
# stop holes + spot faces
s = s.cut(cyl((-12.0, 11.75, 9.0), (0,0,1), 1.65, 6.5))
s = s.cut(cyl((-12.0, 11.75, 26.7), (0,0,1), 1.65, 6.0))
# cable housing / cable along the lever line
dd = (-10.0, 0.0, -21.0); nn = sqrt(sum(v*v for v in dd)); du = tuple(v/nn for v in dd)
s = s.cut(cyl((-10.0, 6.75, 41.0), du, 3.0, 30.0))
s = s.cut(cyl((-10.0, 6.75, 41.0), du, 1.0, 40.0))
res = cq.Workplane(obj=s)
res = res.edges(cq.selectors.BoxSelector((-16.1, 8.9, 32.6), (-15.9, 14.6, 32.8))).chamfer(0.5)
result = res
datum_axis("upper_pivot",[0,0,20],[0,1,0])
datum_axis("lower_pivot",[0,0,-20],[0,1,0])
datum_axis("mount_axis",[0,-20,-6],[1,0,0])
datum_axis("return_spring_axis",[8,11,32],[0,0,1])
datum("return_spring_seat",[8,11,60])
datum("cap_seat",[8,11,63])
datum_cyl("cap_bore",[8,11,60],[0,0,1],6.25)
datum("cable_stop",[-10,6.75,41])
datum("low_stop",[-12,11.75,16])
datum("high_stop",[-12,11.75,26.7])
datum_plane("inboard_face",[0,-10,0],[0,-1,0])
datum_cyl("upper_bore",[0,0,20],[0,1,0],3)
datum_cyl("lower_bore",[0,0,-20],[0,1,0],3)
