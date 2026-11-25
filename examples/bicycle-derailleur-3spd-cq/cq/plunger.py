import cadquery as cq
s = cq.Solid.makeCylinder(6.0, 3.0, cq.Vector(0,0,0), cq.Vector(0,0,1))
s = s.fuse(cq.Solid.makeCylinder(3.0, 5.0, cq.Vector(0,0,-5), cq.Vector(0,0,1)))
s = s.fuse(cq.Solid.makeSphere(3.0, cq.Vector(0,0,-2)))
result = cq.Workplane(obj=s)
datum_axis("axis",[0,0,0],[0,0,1])
datum("spring_seat",[0,0,3])
datum("tip",[0,0,-5])
