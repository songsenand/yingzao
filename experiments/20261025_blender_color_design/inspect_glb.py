import bpy, sys
from collections import Counter
argv = sys.argv[sys.argv.index('--')+1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=argv[0])
obj = next(o for o in bpy.context.scene.objects if o.type=='MESH')
print('MATS', [(i, m.name if m else None) for i,m in enumerate(obj.data.materials)])
print('FACE_COUNTS', Counter(p.material_index for p in obj.data.polygons))
for i,m in enumerate(obj.data.materials):
    print('MAT', i, m.name if m else None, tuple(round(v,3) for v in m.diffuse_color) if m else None)
