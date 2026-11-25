import cadquery as cq
s = cq.Solid.makeCylinder(5.0, 21.0, cq.Vector(0,0,0), cq.Vector(0,1,0))
s = s.cut(cq.Solid.makeCylinder(3.0, 23.0, cq.Vector(0,-1,0), cq.Vector(0,1,0)))
result = cq.Workplane(obj=s)
datum_axis("axis",[0,0,0],[0,1,0])
datum("inboard_face",[0,0,0])
datum("outboard_face",[0,21,0])
datum_cyl("od",[0,0,0],[0,1,0],5)
datum_cyl("id",[0,0,0],[0,1,0],3)
