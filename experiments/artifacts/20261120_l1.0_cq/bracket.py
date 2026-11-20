import json, time, sys
import cadquery as cq

start = time.perf_counter()
result = (
    cq.Workplane("XY")
    .box(60, 40, 6)
    .translate((0, 0, 3))
    .edges("|Z").fillet(4)
    .faces(">Z").workplane()
    .rect(44, 26, forConstruction=True).vertices().hole(4.5)
)
build_s = time.perf_counter() - start

shape = result.val()
bb = shape.BoundingBox()
export_start = time.perf_counter()
cq.exporters.export(result, "bracket_cq.stl", tolerance=0.01, angularTolerance=0.1)
export_s = time.perf_counter() - export_start

# Datum probe: CQ exposes geometry, not the harness datum schema yet. Record the
# values a provider will have to map into that schema.
top = result.faces(">Z").val()
print(json.dumps({
    "version": cq.__version__,
    "build_s": round(build_s, 4),
    "export_s": round(export_s, 4),
    "bbox": {"x": [bb.xmin, bb.xmax], "y": [bb.ymin, bb.ymax], "z": [bb.zmin, bb.zmax],
             "xlen": bb.xlen, "ylen": bb.ylen, "zlen": bb.zlen},
    "volume_mm3": shape.Volume(),
    "valid": shape.isValid(),
    "faces": len(shape.Faces()),
    "edges": len(shape.Edges()),
    "top_face_center": list(top.Center().toTuple()),
    "top_face_normal": list(top.normalAt().toTuple()),
    "modules": {m: (m in sys.modules) for m in ["trame", "vtk", "vtkmodules", "matplotlib", "pyvista", "numba", "casadi"]},
}, indent=2))
