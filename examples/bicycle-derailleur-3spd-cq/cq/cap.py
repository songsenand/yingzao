import cadquery as cq

plug = cq.Solid.makeCylinder(6.3, 3.0, cq.Vector(0.0, 0.0, 0.0), cq.Vector(0, 0, 1))
rim = cq.Solid.makeCylinder(10.0, 2.0, cq.Vector(0.0, 0.0, 3.0), cq.Vector(0, 0, 1))
s = plug.fuse(rim)
result = cq.Workplane(obj=s)
datum("seat", [0, 0, 0])
datum("rim_bottom", [0, 0, 3])
datum("top", [0, 0, 5])
datum_cyl("plug", [0, 0, 0], [0, 0, 1], 6.3)
datum_cyl("rim", [0, 0, 3], [0, 0, 1], 10)
