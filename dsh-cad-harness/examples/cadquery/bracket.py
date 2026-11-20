# CadQuery bracket example (L1.5). Pass this file's contents as
# generate_part({ code: ... }), or run it with the CQ pack for a direct probe.
#
# Contract: leave a Workplane/Shape in `result` (or call show_object), and
# declare datums at top level. The mesh is exported by the provider; rendering
# stays on the shared STL -> OpenSCAD path.
import cadquery as cq

result = (
    cq.Workplane("XY")
    .box(60, 40, 6)
    .translate((0, 0, 3))
    .edges("|Z").fillet(4)
    .faces(">Z").workplane()
    .rect(44, 26, forConstruction=True).vertices().hole(4.5)
)

# Datum names are contract addresses: keep them stable across iterations.
datum("top", [0, 0, 6])
datum_plane("top_plane", [0, 0, 6], [0, 0, 1])
datum_axis("hole_axis", [22, 13, 0], [0, 0, 1])
datum_cyl("hole", [22, 13, 0], [0, 0, 1], 2.25)
