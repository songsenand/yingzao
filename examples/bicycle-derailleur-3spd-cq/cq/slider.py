import cadquery as cq
s = cq.Solid.makeBox(12.0, 12.0, 4.0, cq.Vector(-6.0, -8.0, 0.0))
prof = cq.Workplane("YZ").polyline([(-8,4),(0,4),(4,2),(4,4)]).close().extrude(12.0).translate((-6,0,0)).val()
s = s.cut(prof)
s = s.fuse(cq.Solid.makeCylinder(1.8, 2.0, cq.Vector(0,-10,2), cq.Vector(0,1,0)))
result = cq.Workplane(obj=s)
datum_plane("spring_seat",[0,-8,2],[0,-1,0])
datum("nose",[0,0,4])
datum("axis",[0,-2,2])
