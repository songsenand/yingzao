import cadquery as cq
def box(cx, cy, cz, sx, sy, sz):
    return cq.Solid.makeBox(sx, sy, sz, cq.Vector(cx-sx/2, cy-sy/2, cz-sz/2))
def cyl(p, d, r, h):
    return cq.Solid.makeCylinder(r, h, cq.Vector(*p), cq.Vector(*d))
parts = []
parts.append(box(15.0, 17.75, -42.5, 30.0, 4.5, 71.0))          # body z -78..-7
parts.append(box(2.0, 3.25, -77.5, 4.0, 26.5, 31.0))            # inboard cage ear z -93..-55
parts.append(box(28.0, 3.25, -77.5, 4.0, 26.5, 31.0))           # outboard cage ear
parts.append(box(15.0, 21.5, -17.0, 20.0, 4.0, 20.0))           # upper link ear z -27..-7
parts.append(box(15.0, 21.5, -57.0, 20.0, 4.0, 20.0))           # lower link ear z -67..-47
s = parts[0].fuse(*parts[1:])
s = s.cut(cyl((14.984, 14.0, -17.087), (0,1,0), 3.0, 11.0))
s = s.cut(cyl((14.984, 14.0, -57.087), (0,1,0), 3.0, 11.0))
s = s.cut(cyl((0.0, 0.0, -73.0), (1,0,0), 3.0, 30.0))           # cage pin bore
s = s.cut(cyl((0.0, 0.0, -87.0), (1,0,0), 3.0, 30.0))           # cam pin bore
result = cq.Workplane(obj=s)
datum_axis("upper_pivot",[14.984,21.5,-17.087],[0,1,0])
datum_axis("lower_pivot",[14.984,21.5,-57.087],[0,1,0])
datum_axis("cage_pivot",[15,0,-73],[1,0,0])
datum_axis("cam_axis",[2,0,-87],[1,0,0])
datum("cam_contact",[15,0,-90])
datum_plane("body_face",[15,15.5,-42.5],[0,-1,0])
datum_cyl("upper_bore",[14.984,21.5,-17.087],[0,1,0],3)
datum_cyl("lower_bore",[14.984,21.5,-57.087],[0,1,0],3)
datum_cyl("cage_bore",[15,0,-73],[1,0,0],3)
datum_cyl("cam_bore",[15,0,-87],[1,0,0],3)
