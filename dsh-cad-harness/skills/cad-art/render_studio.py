#!/usr/bin/env python3
"""A baseline studio renderer for the optional Blender/bpy art lane.

It is deliberately a *baseline*, not a scene language: import one mesh, normalize
units, put it on a neutral ground, light it with a three-point area rig, and render
either four views (fast, for judgment) or one hero (materials, for presentation).

Dual entry — the same file runs two ways:

    # 1) bpy module (user-installed overlay, the L1 path)
    python skills/cad-art/render_studio.py -- input.stl --out renders --mode views

    # 2) Blender CLI (works when bpy is not installable; e.g. macOS Intel + 4.5 LTS)
    blender -b --factory-startup -noaudio -P skills/cad-art/render_studio.py -- \
        input.stl --out renders --mode hero --engine cycles --size 1024 --samples 64

The output is PNGs plus `metadata.json` (engine, size, unit, bbox, files).  It does
not judge the picture; it only produces it.  For printable art, import the exported
mesh through `import_part` and run the truth-engine checks — a render is not a
manufacturability certificate.

License: Apache-2.0 (this script). bpy itself is GPL-3.0 and user-installed.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
import warnings
from pathlib import Path

SCRIPT_VERSION = "1.0"

# Blender 5.x warns that use_nodes will go away in 6.0; it is still the supported
# way to build a node material here, and the warning only adds noise to run_python.
warnings.filterwarnings("ignore", message="'Material.use_nodes' is expected to be removed")
warnings.filterwarnings("ignore", message="'World.use_nodes' is expected to be removed")


def _argv_after_ddash() -> list[str]:
    """Blender CLI puts its own flags before `--`; module form has no `--`."""
    return sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]


def _safe_label(text: str) -> str:
    cleaned = re.sub(r"[^\w.-]+", "_", text, flags=re.UNICODE).strip("._")
    return cleaned or "render"


def _parse_color(text: str | None) -> tuple[float, float, float] | None:
    if not text:
        return None
    parts = [p.strip() for p in text.split(",")]
    if len(parts) != 3:
        raise argparse.ArgumentTypeError("--color expects R,G,B (0..1 or 0..255)")
    values = [float(p) for p in parts]
    if max(values) > 1.0:
        values = [v / 255.0 for v in values]
    return tuple(max(0.0, min(1.0, v)) for v in values)  # type: ignore[return-value]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="bpy/Blender baseline studio renderer")
    parser.add_argument("input", help="STL / OBJ / GLB / GLTF mesh")
    parser.add_argument("--out", default="renders", help="output directory (default: renders)")
    parser.add_argument("--mode", choices=["single", "views", "hero"], default="hero")
    parser.add_argument("--engine", choices=["workbench", "cycles"], default=None,
                        help="default: workbench for views, cycles for hero")
    parser.add_argument("--size", type=int, default=1024, help="square resolution (default 1024)")
    parser.add_argument("--samples", type=int, default=32, help="Cycles samples (default 32)")
    parser.add_argument("--view", choices=["front", "side", "top", "iso"], default="iso",
                        help="single mode: camera direction (default iso)")
    parser.add_argument("--exposure", type=float, default=0.0, help="view exposure in stops (default 0)")
    parser.add_argument("--zoom", type=float, default=1.0, help="camera zoom over auto-fit (default 1)")
    parser.add_argument("--rig", choices=["sun", "area"], default="sun",
                        help="hero light rig: sun (scale-stable, default) or area (softbox)")
    parser.add_argument("--unit", choices=["mm", "m", "auto"], default="mm",
                        help="input unit (default mm, the project's unit). auto is a heuristic.")
    parser.add_argument("--material", choices=["plastic", "metal", "clay", "none"], default="plastic")
    parser.add_argument("--keep-materials", action="store_true",
                        help="preserve imported OBJ/GLB/GLTF materials (color design) instead of "
                             "applying one studio material; STL has no materials, so it falls back")
    parser.add_argument("--color", type=_parse_color, default=None,
                        help="R,G,B (0..1 or 0..255); overrides the material's base color; ignored with --keep-materials")
    parser.add_argument("--background", choices=["light", "dark", "transparent"], default="light")
    parser.add_argument("--ground", dest="ground", action="store_true", default=None,
                        help="force a ground plane (default: hero only)")
    parser.add_argument("--no-ground", dest="ground", action="store_false")
    parser.add_argument("--shade", choices=["auto", "smooth", "flat"], default="auto")
    parser.add_argument("--label", default=None, help="output filename prefix (default: input stem)")
    parser.add_argument("--json", default=None, help="metadata path (default: <out>/metadata.json)")
    parser.add_argument("--glb", default=None, help="optional GLB export path")
    parser.add_argument("--quiet", action="store_true")
    return parser


def fail(message: str, code: int = 2) -> "NoReturn":  # noqa: F821
    print(f"render_studio: {message}", file=sys.stderr)
    raise SystemExit(code)


def import_mesh(path: Path, bpy) -> None:
    suffix = path.suffix.lower()
    if suffix == ".stl":
        try:
            bpy.ops.wm.stl_import(filepath=str(path))
        except Exception:
            bpy.ops.import_mesh.stl(filepath=str(path))  # Blender < 4.1 fallback
    elif suffix == ".obj":
        bpy.ops.wm.obj_import(filepath=str(path))
    elif suffix in {".glb", ".gltf"}:
        try:
            bpy.ops.import_scene.gltf(filepath=str(path))
        except Exception as error:
            fail(
                f"glTF import is unavailable ({error}); export the mesh as STL/OBJ, "
                "or use `run_python` with the glTF add-on enabled",
            )
    else:
        fail(f"unsupported input format {suffix!r}; use STL, OBJ, GLB or GLTF")


def join_meshes(bpy) -> object:
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        fail("the file contains no mesh objects")
    if len(meshes) == 1:
        return meshes[0]
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    return bpy.context.view_layer.objects.active


def normalize_units(bpy, obj, unit: str) -> tuple[float, float]:
    """Apply a scale so the scene is in metres. Returns (scale, diagonal_m)."""
    from mathutils import Vector

    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="OBJECT")
    # Apply any scale/rotation the importer left on the object, so bound_box is
    # already in world units and the camera math below cannot double-apply it.
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)

    bb = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    diagonal = (Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
                - Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))).length
    if diagonal <= 1e-9:
        fail("the mesh has a zero-size bounding box")

    chosen = unit
    if unit == "auto":
        # Project files are mm; a 10 km part is not a thing. This is a heuristic,
        # not a claim: pass --unit explicitly when it matters.
        chosen = "mm" if diagonal > 10.0 else "m"
    scale = 0.001 if chosen == "mm" else 1.0
    if scale != 1.0:
        obj.scale = (obj.scale.x * scale, obj.scale.y * scale, obj.scale.z * scale)
        bpy.context.view_layer.update()
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bb = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    diagonal = (Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
                - Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))).length
    return scale, diagonal


def shade_object(bpy, obj, mode: str) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    if mode == "flat":
        for polygon in obj.data.polygons:
            polygon.use_smooth = False
        return
    if mode == "smooth":
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
        return
    # auto: keep hard edges hard, smooth the rest
    try:
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(30))
    except Exception:
        for polygon in obj.data.polygons:
            polygon.use_smooth = True


def make_material(bpy, kind: str, color: tuple[float, float, float] | None):
    if kind == "none":
        return None
    presets = {
        "plastic": ((0.12, 0.42, 0.85), 0.35, 0.0),
        "metal": ((0.72, 0.74, 0.78), 0.25, 1.0),
        "clay": ((0.78, 0.70, 0.62), 0.72, 0.0),
    }
    base, roughness, metallic = presets[kind]
    if color is not None:
        base = color
    material = bpy.data.materials.new(f"studio-{kind}")
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (*base, 1.0)
        bsdf.inputs["Roughness"].default_value = roughness
        bsdf.inputs["Metallic"].default_value = metallic
    material.diffuse_color = (*base, 1.0)  # Workbench's MATERIAL color type
    return material


def add_ground(bpy, center, min_z: float, diagonal: float, dark: bool):
    bpy.ops.mesh.primitive_plane_add(size=diagonal * 10.0, location=(center.x, center.y, min_z - 0.0002))
    ground = bpy.context.active_object
    material = bpy.data.materials.new("studio-ground")
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    tint = (0.06, 0.06, 0.07) if dark else (0.9, 0.9, 0.9)
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (*tint, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.6
    material.diffuse_color = (*tint, 1.0)
    ground.data.materials.append(material)
    return ground


def sync_viewport_colors(obj) -> None:
    """Workbench's MATERIAL mode reads material.diffuse_color, not the shader."""
    for material in obj.data.materials:
        if material is None or not material.use_nodes:
            continue
        bsdf = material.node_tree.nodes.get("Principled BSDF")
        if bsdf is None:
            continue
        base = bsdf.inputs["Base Color"].default_value
        material.diffuse_color = (base[0], base[1], base[2], 1.0)


def setup_scene(bpy, args, obj, diagonal: float, scale: float):
    from mathutils import Vector

    scene = bpy.context.scene
    engine = args.engine or ("workbench" if args.mode == "views" else "cycles")
    scene.render.engine = "BLENDER_WORKBENCH" if engine == "workbench" else "CYCLES"
    scene.render.resolution_x = scene.render.resolution_y = max(16, args.size)
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = args.background == "transparent"
    scene.render.image_settings.color_mode = "RGBA" if scene.render.film_transparent else "RGB"
    scene.view_settings.exposure = args.exposure

    bb = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    mn = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
    mx = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
    center = (mn + mx) / 2.0

    source_materials = [m for m in obj.data.materials if m is not None]
    keep_materials = bool(args.keep_materials and source_materials)
    if keep_materials:
        if engine == "workbench":
            sync_viewport_colors(obj)
    else:
        material = make_material(bpy, args.material, args.color)
        if material is not None:
            obj.data.materials.clear()
            obj.data.materials.append(material)
        else:
            obj.color = (0.6, 0.6, 0.6, 1.0)

    ground = args.ground if args.ground is not None else args.mode == "hero"
    if args.background == "transparent":
        ground = False
    if ground:
        add_ground(bpy, center, mn.z, diagonal, args.background == "dark")

    camera_data = bpy.data.cameras.new("studio-camera")
    camera = bpy.data.objects.new("studio-camera", camera_data)
    bpy.context.scene.collection.objects.link(camera)
    camera_data.lens = 55.0
    camera_data.clip_start = max(diagonal * 0.001, 0.0001)
    camera_data.clip_end = diagonal * 100.0
    scene.camera = camera

    if engine == "cycles":
        background = (0.8, 0.83, 0.88) if args.background != "dark" else (0.02, 0.025, 0.035)
        world = bpy.data.worlds.new("studio-world")
        world.use_nodes = True
        background_node = world.node_tree.nodes.get("Background")
        if background_node is not None:
            background_node.inputs["Color"].default_value = (*background, 1.0)
            background_node.inputs["Strength"].default_value = 0.25 if args.background != "dark" else 0.08
        scene.world = world
        # Sun rig: irradiance does not depend on object size, so a 30 mm ornament
        # and a 1.2 m decorative panel get the same exposure. Area lights are
        # available via --rig area for softer highlights, but their power has to
        # be tuned per size; that is why they are not the default.
        if args.rig == "sun":
            def sun(name: str, rotation, energy: float, angle_deg: float, color) -> None:
                data = bpy.data.lights.new(name, "SUN")
                data.energy = energy
                data.angle = math.radians(angle_deg)
                data.color = color
                light = bpy.data.objects.new(name, data)
                bpy.context.scene.collection.objects.link(light)
                light.rotation_euler = tuple(math.radians(v) for v in rotation)
            if args.background != "dark":
                sun("key", (50, 0, 30), 3.0, 12, (1.0, 0.96, 0.9))
                sun("fill", (60, 0, -120), 1.0, 25, (0.85, 0.9, 1.0))
                sun("rim", (30, 0, 180), 2.0, 8, (1.0, 1.0, 1.0))
            else:
                sun("key", (50, 0, 30), 4.0, 12, (1.0, 0.97, 0.92))
                sun("fill", (60, 0, -120), 0.6, 25, (0.8, 0.86, 1.0))
                sun("rim", (30, 0, 180), 3.0, 8, (1.0, 1.0, 1.0))
        # Three-point area rig (optional). Power scales with diagonal^2.
        def area(name: str, direction, size_factor: float, power: float, color) -> None:
            data = bpy.data.lights.new(name, "AREA")
            data.shape = "SQUARE"
            data.size = max(diagonal * size_factor, 0.01)
            data.energy = max(power * diagonal * diagonal, 0.01)
            data.color = color
            light = bpy.data.objects.new(name, data)
            bpy.context.scene.collection.objects.link(light)
            light.location = center + Vector(direction) * diagonal
            light.rotation_euler = (center - light.location).to_track_quat("-Z", "Y").to_euler()

        if args.rig == "area" and args.background != "dark":
            area("key", (1.2, -1.0, 1.6), 1.2, 1250.0, (1.0, 0.96, 0.9))
            area("fill", (-1.5, -0.6, 0.8), 1.5, 470.0, (0.85, 0.9, 1.0))
            area("rim", (0.2, 1.6, 1.2), 1.0, 940.0, (1.0, 1.0, 1.0))
        elif args.rig == "area":
            area("key", (1.2, -1.0, 1.6), 1.2, 1800.0, (1.0, 0.97, 0.92))
            area("fill", (-1.5, -0.6, 0.8), 1.5, 500.0, (0.8, 0.86, 1.0))
            area("rim", (0.2, 1.6, 1.2), 1.0, 1200.0, (1.0, 1.0, 1.0))

    if engine == "workbench":
        shading = scene.display.shading
        shading.light = "STUDIO"
        shading.color_type = "MATERIAL" if (keep_materials or args.material != "none") else "OBJECT"
        shading.show_shadows = True
        shading.show_cavity = True
        shading.cavity_type = "WORLD"
        shading.show_object_outline = True
        shading.show_specular_highlight = True
        shading.background_type = "VIEWPORT"
        shading.background_color = (0.08, 0.08, 0.09) if args.background == "dark" else (0.92, 0.92, 0.92)
        scene.display.render_aa = "8"
        scene.view_settings.view_transform = "Standard"
    else:
        scene.cycles.device = "CPU"
        scene.cycles.samples = max(1, args.samples)
        scene.cycles.use_denoising = True
        scene.cycles.use_adaptive_sampling = True
        scene.view_settings.view_transform = "AgX"
    return engine, center, camera


def render_views(bpy, args, scene, camera, center, diagonal: float, label: str, out: Path) -> list[str]:
    from mathutils import Vector

    views = {
        "front": (0.0, -1.0, 0.0),
        "side": (-1.0, 0.0, 0.0),
        "top": (0.0, 0.0, 1.0),
        "iso": (1.0, -1.0, 0.8),
    }
    files: list[str] = []
    for name, direction in views.items():
        vector = Vector(direction).normalized()
        camera.location = center + vector * (diagonal * 2.0 / max(args.zoom, 0.01))
        camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
        path = out / f"{label}-{name}.png"
        scene.render.filepath = str(path)
        started = time.time()
        bpy.ops.render.render(write_still=True)
        files.append(str(path))
        if not args.quiet:
            print(f"VIEW {name} {time.time() - started:.2f}s -> {path}", flush=True)
    return files


def render_single(bpy, args, scene, camera, center, diagonal: float, label: str, out: Path) -> list[str]:
    from mathutils import Vector

    directions = {
        "front": (0.0, -1.0, 0.0),
        "side": (-1.0, 0.0, 0.0),
        "top": (0.0, 0.0, 1.0),
        "iso": (1.0, -1.0, 0.8),
    }
    vector = Vector(directions[args.view]).normalized()
    camera.location = center + vector * (diagonal * 2.0 / max(args.zoom, 0.01))
    camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
    path = out / f"{label}-{args.view}.png"
    scene.render.filepath = str(path)
    started = time.time()
    bpy.ops.render.render(write_still=True)
    if not args.quiet:
        print(f"SINGLE {args.view} {time.time() - started:.2f}s -> {path}", flush=True)
    return [str(path)]


def render_hero(bpy, args, scene, camera, center, diagonal: float, label: str, out: Path) -> list[str]:
    from mathutils import Vector

    camera.location = center + Vector((1.0, -1.25, 0.75)).normalized() * (diagonal * 2.0 / max(args.zoom, 0.01))
    camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
    path = out / f"{label}-hero.png"
    scene.render.filepath = str(path)
    started = time.time()
    bpy.ops.render.render(write_still=True)
    if not args.quiet:
        print(f"HERO {time.time() - started:.2f}s -> {path}", flush=True)
    return [str(path)]


def export_glb(bpy, obj, path: Path) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    try:
        bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB", use_selection=True)
    except Exception:
        try:
            bpy.ops.preferences.addon_enable(module="io_scene_gltf2")
            bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB", use_selection=True)
        except Exception as error:
            fail(f"GLB export failed: {error}", code=4)
    return str(path)


def main() -> int:
    started = time.time()
    args = build_parser().parse_args(_argv_after_ddash())
    source = Path(args.input).expanduser().resolve()
    if not source.exists():
        fail(f"input not found: {source}")

    try:
        import bpy  # noqa: PLC0415 - after argparse so --help works without bpy
        from mathutils import Vector  # noqa: F401
    except Exception as error:  # noqa: BLE001
        print(
            "bpy is not importable. This is the expected state before the user installs it:\n"
            '  python_runtime action=install packages:["bpy==5.2.3"]\n'
            "Run skills/cad-art/preflight.py for platform/Python/disk details; "
            "alternatively run this same file with `blender -b -P ... -- ...`.\n"
            f"({type(error).__name__}: {error})",
            file=sys.stderr,
        )
        return 3

    out = Path(args.out).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)
    label = _safe_label(args.label or source.stem)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    import_mesh(source, bpy)
    obj = join_meshes(bpy)
    scale, diagonal = normalize_units(bpy, obj, args.unit)
    shade_object(bpy, obj, args.shade)
    # Capture the imported materials BEFORE setup_scene may replace them; the metadata
    # must say what the source carried, not what the fallback material ended up being.
    source_materials = [m for m in obj.data.materials if m is not None]
    keep_materials = bool(args.keep_materials and source_materials)
    engine, center, camera = setup_scene(bpy, args, obj, diagonal, scale)

    if args.mode == "views":
        files = render_views(bpy, args, bpy.context.scene, camera, center, diagonal, label, out)
    elif args.mode == "hero":
        files = render_hero(bpy, args, bpy.context.scene, camera, center, diagonal, label, out)
    else:
        files = render_single(bpy, args, bpy.context.scene, camera, center, diagonal, label, out)

    glb = export_glb(bpy, obj, Path(args.glb).expanduser().resolve()) if args.glb else None

    bb = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    mn = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
    mx = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
    dims_mm = [(mx[i] - mn[i]) * 1000.0 for i in range(3)]
    metadata = {
        "ok": True,
        "script": {"name": "render_studio.py", "version": SCRIPT_VERSION},
        "mode": args.mode,
        "engine": engine,
        "size": args.size,
        "samples": args.samples if engine == "cycles" else 0,
        "unit": args.unit,
        "unit_scale_to_m": scale,
        "unit_resolved": "mm" if scale == 0.001 else "m",
        "bbox_mm": {"x": round(dims_mm[0], 4), "y": round(dims_mm[1], 4), "z": round(dims_mm[2], 4)},
        "diagonal_mm": round(diagonal * 1000.0, 4),
        "polygons": len(obj.data.polygons),
        "material": "preserved" if keep_materials else args.material,
        "materials_preserved": keep_materials,
        "source_materials": [m.name for m in source_materials],
        "background": args.background,
        "rig": args.rig if engine == "cycles" else None,
        "files": files,
        "glb": glb,
        "bpy_version": bpy.app.version_string,
        "elapsed_s": round(time.time() - started, 2),
    }
    metadata_path = Path(args.json).expanduser().resolve() if args.json else out / "metadata.json"
    metadata_path.parent.mkdir(parents=True, exist_ok=True)
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    if not args.quiet:
        print(f"METADATA {metadata_path}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
