"""Author a three-material panel in Blender and save .blend + GLB.

Run:
  blender -b --factory-startup -P make_colored_panel.py -- panel.stl panel-colors.blend panel-colors.glb

The material assignment is geometric, not hand-painted: bottom faces ivory, side/outer
top faces azure, inner top lattice gold. The point is to produce a color DESIGN that
survives a GLB round trip, not to make a print-color claim.
"""
import sys
from pathlib import Path

import bpy


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1:]
    if len(argv) != 3:
        raise SystemExit("usage: make_colored_panel.py -- <panel.stl> <out.blend> <out.glb>")
    stl, blend, glb = (Path(value).expanduser().resolve() for value in argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.wm.stl_import(filepath=str(stl))
    obj = next(o for o in bpy.context.scene.objects if o.type == "MESH")
    obj.name = "decor-panel"

    def material(name: str, rgb: tuple[float, float, float]) -> bpy.types.Material:
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf is not None:
            bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
            bsdf.inputs["Roughness"].default_value = 0.45
        mat.diffuse_color = (*rgb, 1.0)
        return mat

    obj.data.materials.clear()
    for name, rgb in (
        ("panel-base-ivory", (0.82, 0.78, 0.68)),
        ("panel-rim-azure", (0.05, 0.22, 0.62)),
        ("panel-lattice-gold", (0.86, 0.55, 0.12)),
    ):
        obj.data.materials.append(material(name, rgb))

    lo = [min(v.co[i] for v in obj.data.vertices) for i in range(3)]
    hi = [max(v.co[i] for v in obj.data.vertices) for i in range(3)]
    border = 8.0
    for poly in obj.data.polygons:
        normal = poly.normal
        center = poly.center
        if normal.z < -0.5:
            index = 0  # bottom (hidden from the hero camera)
        elif abs(normal.z) <= 0.5:
            index = 1  # side walls: azure
        elif (center.x < lo[0] + border or center.x > hi[0] - border
              or center.y < lo[1] + border or center.y > hi[1] - border):
            index = 0  # outer top rim: ivory, visible next to the sides
        else:
            index = 2  # inner lattice: gold
        poly.material_index = index

    bpy.ops.wm.save_as_mainfile(filepath=str(blend))
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(filepath=str(glb), export_format="GLB", use_selection=True)
    print(f"WROTE {blend} {glb} ({len(obj.data.materials)} materials, {len(obj.data.polygons)} faces)")


if __name__ == "__main__":
    main()
