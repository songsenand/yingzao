import cadquery as cq

result = (
    cq.Workplane("XY")
    .box(60, 40, 6)
    .translate((0, 0, 3))
    .edges("|Z")
    .fillet(4)
    .faces(">Z")
    .workplane()
    .rect(44, 26, forConstruction=True)
    .vertices()
    .hole(4.5)
)

datum("top", [0, 0, 6])
datum_plane("top_plane", [0, 0, 6], [0, 0, 1])
datum_axis("hole_axis", [22, 13, 0], [0, 0, 1])
datum_cyl("hole", [22, 13, 0], [0, 0, 1], 2.25)
