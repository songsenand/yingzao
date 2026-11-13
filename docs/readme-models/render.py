"""Headless product render for the README examples.

Usage:
  blender -b -P render.py -- input.stl output.png color_hex
"""
import bpy
import sys
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
stl_path, out_path = argv[0], argv[1]
color = argv[2] if len(argv) > 2 else "#8f9ba8"
hex_rgb = [int(color[i:i + 2], 16) / 255 for i in (1, 3, 5)]

# empty scene
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
for block in (bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras):
    for item in list(block):
        if item.users == 0:
            block.remove(item)

bpy.ops.wm.stl_import(filepath=stl_path)
obj = bpy.context.selected_objects[0]
obj.name = "part"

mat = bpy.data.materials.new("Part")
mat.use_nodes = True
bsdf = mat.node_tree.nodes.get("Principled BSDF")
bsdf.inputs["Base Color"].default_value = (*hex_rgb, 1.0)
bsdf.inputs["Roughness"].default_value = 0.42
bsdf.inputs["Metallic"].default_value = 0.05
obj.data.materials.append(mat)

# bounds and centre
corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
mn = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
mx = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
center = (mn + mx) / 2
size = max((mx - mn).x, (mx - mn).y, (mx - mn).z)

bpy.ops.object.camera_add(location=center + Vector((1.15, -1.45, 1.55)) * size)
cam = bpy.context.object
cam.data.type = "ORTHO"
cam.data.ortho_scale = size * 1.75
cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
bpy.context.scene.camera = cam

# three-point lighting
def area(name, loc, energy, size_l):
    bpy.ops.object.light_add(type="AREA", location=center + Vector(loc) * size)
    light = bpy.context.object
    light.name = name
    light.data.energy = energy
    light.data.size = size * size_l
    light.rotation_euler = (center - light.location).to_track_quat("-Z", "Y").to_euler()

area("key", (1.3, -1.5, 2.6), 1100, 1.1)
area("fill", (-1.8, -1.0, 1.2), 320, 1.6)
area("rim", (0.4, 2.0, 2.2), 650, 1.0)

world = bpy.context.scene.world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.92, 0.93, 0.95, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 0.55

# soft studio floor
bpy.ops.mesh.primitive_plane_add(size=size * 14, location=(center.x, center.y, mn.z - size * 0.02))
floor = bpy.context.object
floor.name = "floor"
fmat = bpy.data.materials.new("Floor")
fmat.use_nodes = True
fb = fmat.node_tree.nodes.get("Principled BSDF")
fb.inputs["Base Color"].default_value = (0.84, 0.86, 0.88, 1)
fb.inputs["Roughness"].default_value = 0.75
floor.data.materials.append(fmat)

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 48
scene.cycles.use_denoising = True
scene.cycles.device = "CPU"
scene.render.resolution_x = 1200
scene.render.resolution_y = 900
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = out_path
scene.render.film_transparent = False
scene.view_settings.view_transform = "Standard"
scene.view_settings.look = "None"

bpy.ops.render.render(write_still=True)
