"""Render an STL with Blender, either as a Python module (`import bpy`) or via
`blender -b -P render_views.py -- ...`.

Usage (both forms accept the same arguments after `--`):
    python render_views.py -- model.stl OUTDIR ENGINE SIZE SAMPLES MODE
    blender -b --factory-startup -noaudio -P render_views.py -- model.stl OUTDIR ENGINE SIZE SAMPLES MODE

ENGINE: BLENDER_WORKBENCH | CYCLES | BLENDER_EEVEE
MODE:   views (4 orthographic-ish views) | art (one material/lighting hero) | single
"""
import bpy, sys, os, time, math
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
path, outdir, engine, size, samples, mode = argv[0], argv[1], argv[2], int(argv[3]), int(argv[4]), argv[5]
os.makedirs(outdir, exist_ok=True)
t0 = time.time()

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.stl_import(filepath=path)
objs = [o for o in bpy.context.scene.objects if o.type == 'MESH']
if len(objs) > 1:
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
ob = bpy.context.view_layer.objects.active if len(objs) > 1 else objs[0]

# STL has no unit; the project works in mm. Normalize to metres so Cycles'
# light physics is sane (a 60 mm part is 0.06 m, not 60 m).
if mode == 'art':
    ob.scale = (0.001, 0.001, 0.001)
    bpy.context.view_layer.update()

bb = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
mn = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
mx = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
center, diag = (mn + mx) / 2, (mx - mn).length

cam_data = bpy.data.cameras.new('Cam')
cam = bpy.data.objects.new('Cam', cam_data)
bpy.context.scene.collection.objects.link(cam)
bpy.context.scene.camera = cam
cam_data.lens = 55

sun_data = bpy.data.lights.new('Sun', 'SUN')
sun_data.energy = 4
sun = bpy.data.objects.new('Sun', sun_data)
bpy.context.scene.collection.objects.link(sun)
sun.rotation_euler = (math.radians(50), 0, math.radians(30))

if mode == 'art':
    mat = bpy.data.materials.new('ToyPlastic')
    mat.use_nodes = True
    b = mat.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (0.12, 0.42, 0.85, 1)
    b.inputs['Roughness'].default_value = 0.35
    ob.data.materials.clear(); ob.data.materials.append(mat)
    for p in ob.data.polygons:
        p.use_smooth = True
    bpy.ops.mesh.primitive_plane_add(size=diag * 10, location=(center.x, center.y, mn.z - 0.0002))
    g = bpy.context.active_object
    gm = bpy.data.materials.new('Ground'); gm.use_nodes = True
    gb = gm.node_tree.nodes.get('Principled BSDF')
    gb.inputs['Base Color'].default_value = (0.9, 0.9, 0.9, 1)
    gb.inputs['Roughness'].default_value = 0.55
    g.data.materials.append(gm)
    def area(name, loc, size_m, energy, color):
        d = bpy.data.lights.new(name, 'AREA'); d.shape = 'SQUARE'; d.size = size_m
        d.energy = energy; d.color = color
        o = bpy.data.objects.new(name, d); bpy.context.scene.collection.objects.link(o)
        o.location = loc; o.rotation_euler = (center - loc).to_track_quat('-Z', 'Y').to_euler()
    area('Key', center + Vector((1.2, -1.0, 1.6)) * diag, diag * 1.2, 8, (1.0, 0.96, 0.9))
    area('Fill', center + Vector((-1.5, -0.6, 0.8)) * diag, diag * 1.5, 3, (0.85, 0.9, 1.0))
    area('Rim', center + Vector((0.2, 1.6, 1.2)) * diag, diag * 1.0, 6, (1.0, 1.0, 1.0))
    w = bpy.data.worlds.new('W'); bpy.context.scene.world = w; w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.8, 0.83, 0.88, 1)
    w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.25

sc = bpy.context.scene
sc.render.engine = engine
sc.render.resolution_x = sc.render.resolution_y = size
sc.render.resolution_percentage = 100
sc.render.image_settings.file_format = 'PNG'
if engine == 'CYCLES':
    sc.cycles.device = 'CPU'; sc.cycles.samples = samples; sc.cycles.use_denoising = True
if engine == 'BLENDER_WORKBENCH':
    sc.display.shading.light = 'STUDIO'; sc.display.shading.color_type = 'MATERIAL'
if mode == 'art':
    sc.view_settings.view_transform = 'AgX'

if mode in ('views',):
    views = {'front': (0, -1, 0), 'side': (-1, 0, 0), 'top': (0, 0, 1), 'iso': (1, -1, 0.8)}
else:
    views = {'iso': (1, -1.25, 0.75)}

for name, d in views.items():
    v = Vector(d).normalized()
    cam.location = center + v * diag * 2.0
    cam.rotation_euler = (center - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.render.filepath = os.path.join(outdir, f'{name}.png')
    t = time.time()
    bpy.ops.render.render(write_still=True)
    print(f'VIEW {name} {time.time() - t:.2f}s', flush=True)
print(f'BATCH_TOTAL {time.time() - t0:.2f}s engine={engine} size={size} mode={mode}', flush=True)
