---
name: cad-art
description: "Use when the job is sculpture, decorative or organic form, art direction, materials/lighting, color design, a hero render, or an interior-decoration visual — i.e. when the part's job is how it looks, not whether it fits. This is the OPTIONAL Blender/bpy lane: user-installed, 3/7 platforms, GPL-3.0; it is not the precision-part lane and a render is not a printability certificate."
whenToUse: "Before writing bpy/Blender code, or when the user asks for a sculpted/artistic/decorative result, material/color design, a material preview, or a presentation render. Do not load it for functional parts, fits, tolerances, or printability alone."
---

# Art lane: what Blender is for here, and what it is not

**The site has a Blender bay, not a Blender product line.** bpy is **user-installed**
into the Python overlay; it is never shipped in the plugin's lock. You get a map,
a preflight, a baseline studio script, a QC handoff and one example. You do not get
"all platforms, all scenes, all outcomes" — and you must say so when it matters.

## 1. Decide first: is this an art job at all?

| The user is asking for | Use | Do not |
|---|---|---|
| a sculpted figurine, organic shell, ornament, decorative panel, moulding, set piece | **bpy / Blender** (this skill) | force it through OpenSCAD primitives |
| a bracket, enclosure, adapter, hole pattern, fit, tolerance, printable functional part | **OpenSCAD + the core CAD tools** | reach for bpy because it is "more powerful" |
| a precise decorative panel with parametric slots | **OpenSCAD/BOSL2** first; bpy only for a material/render pass | model it in bpy when dimensions must be exact |
| "make it look like the reference", materials, lighting, a presentation image | **bpy** for the render; keep the geometry source wherever it already lives | re-model the part just to get a nicer picture |
| "design colors / different material regions" | **bpy/Blender materials** → `.blend` + GLB → `attach_appearance` → `render_part({appearance:true})` (or raw `--keep-materials`) | assume STL carries the color |
| "can this be printed?" | the truth engine: `import_part` → `measure_part` / `check_printability` | treat a render as evidence |

**The dividing line is the job, not the tool.** A decorative panel can stay in
OpenSCAD and only borrow Blender's camera; a figurine may need bpy for the mesh.
When both are true, keep the geometry in its authoritative source and use bpy as a
**render/material stage**, not a second source of truth.

## 2. Before installing: preflight (do not download 403 MB blind)

Resolve `preflight.py` **relative to this skill's directory** (the loader prints it).
Run it through the project runtime, not the system Python:

```text
run_python({ script: "<skill-dir>/preflight.py", args: ["--json"], cwd: "<project>" })
```

Read `status`:

| status | meaning | next |
|---|---|---|
| `ready` | bpy imports on this machine | skip to §4 |
| `not-installed` | platform/Python are fine, bpy is absent | install in §3 |
| `unsupported` | no bpy wheel (musl, Linux arm64, macOS Intel) | use §7 alternatives; do not download |
| `unsupported-python` | runtime is not CPython 3.13 | do not install; bpy 5.2.x requires `==3.13.*` |
| `low-disk` | less than ~1.5 GB free | free space, then retry |
| `version-mismatch` | bpy imports but is not the tested 5.2.3 | best effort; say the version in the result |

The report also gives the Blender CLI path/version. That is the fallback for macOS
Intel (Blender 4.5 LTS) and a useful cross-check everywhere else.

## 3. Install it into the USER overlay (never the lock)

```text
python_runtime({ action: "install", packages: ["bpy==5.2.3"] })
```

- **403 MB download / ~1 GB installed**; mirror 1–2 min, direct PyPI can be 10–20 min.
  The installer's default timeout is 15 min; if it fails on a slow link, say so and
  retry from the mirror — do not silently switch to a system Python.
- The package lands in `$DSH_HOME/cad/runtime/user-site/`, a sibling of `venv/`, so a
  runtime repair/upgrade cannot erase it. It is recorded in `installed.json`, in
  `python_runtime` status and in run provenance.
- **Do not use `override: true`** for bpy. Nothing in the lock is named bpy; an
  override would be a false claim.
- **GPL-3.0**: bpy is Blender as a module. The user installs it; the plugin does not
  distribute it. `render_studio.py` itself is Apache-2.0. State this if the user asks
  about licensing; do not describe bpy as "just another MIT package".

After install, run preflight again. A `ready` here is an **import** check; §4's
smoke render is the "it can actually produce a PNG" check.

## 4. Render: prefer `render_part` for saved versions

If the geometry already has a version id, **do not go through `run_python` first**.
The native tool resolves the version, runs the same `render_studio.py` in a child
process, writes `<project>/render/...`, and returns the PNGs as **attachments**:

```text
render_part({ versionId: "v012", engine: "bpy", mode: "views", imgSize: 1024 })
render_part({ versionId: "v012", engine: "bpy", mode: "hero",
              material: "plastic", samples: 64, imgSize: 1024 })
```

- `engine` defaults to `openscad` (the old fast path). `bpy` is the material/lighting
  lane; `auto` prefers bpy and falls back to OpenSCAD for single/views only when bpy
  or the runtime is unavailable — a failed render is reported, not silently downgraded.
  A `hero` render is never downgraded either — it needs bpy.
- `mode`: `single` (default, one frame; `view` picks front/side/top/iso),
  `views` (four, Workbench ~1.3 s at 1024), `hero` (one material shot, Cycles;
  1024/64 ~13 s / 1.3 GB on 16 cores).
- `rotate`/`section` are **OpenSCAD single only**; `zoom` works on both. A section
  cut with bpy is rejected, not ignored.
- The result carries `files`, `engine`, `mode`, `fallback`, `fallbackReason`,
  `metadata`, `warnings`. **If `fallback: true`**, say which backend actually ran and
  do not describe materials/lighting that OpenSCAD did not produce.
- The images are already attachments; **no `read_image` call is needed**. If the
  result has four views, describe what you see in them, not what you expected.

## 4.5 Color design: Blender materials, GLB, and what this lane carries

Color design is **design data**, not a print instruction. Blender can assign material
slots per object/face, vertex colors, UV textures and shader nodes; `.blend` is the
authoritative source, GLB is the appearance carrier. STL is geometry only — a color
disappears at that boundary.

`render_studio.py --keep-materials` preserves materials from OBJ/GLB/GLTF instead of
clearing them and applying one studio material:

```text
run_python({
  script: "<skill-dir>/render_studio.py",
  args: ["design.glb", "--out", "renders", "--mode", "hero",
         "--engine", "cycles", "--keep-materials"],
  cwd: "<project>"
})
```

- `--keep-materials` is a no-op on STL (there are no materials); it falls back to
  `--material`. `--color` is ignored when materials are preserved.
- The metadata records `materials_preserved` and `source_materials`; read them. A
  render with `materials_preserved: false` is a fallback, not a color design.
- **A saved version can carry an appearance sidecar.** Attach the GLB with
  `attach_appearance({versionId, file})`; it becomes `versions/<id>/appearance.glb`
  plus `appearance.json`. Then
  `render_part({versionId, appearance:true, engine:"bpy", mode:"views"})` renders it
  with materials preserved. `model.stl` remains the geometry truth.
- `engine:"auto"` with `appearance:true` still uses bpy; it does **not** fall back to
  STL (that would silently drop the color). `engine:"openscad"` is rejected.
- Use the raw script when the design has no version yet; use the sidecar when it does.
- No slicing or 3MF is needed for a color design review: `.blend` (source), GLB
  (appearance), PNG (review). If the user asks for **print** color, that is a separate
  process decision; `check_printability` does not check color.

### Raw mesh or direct script (not a saved version)


Use `run_python` when the input is a user-provided STL/GLB that has no version, or
when you are still iterating on a separate script. Resolve `render_studio.py`
relative to this skill's directory and keep the project as `cwd`:

```text
run_python({
  script: "<skill-dir>/render_studio.py",
  args: ["<model.stl>", "--out", "renders", "--mode", "views",
         "--engine", "workbench", "--size", 1024],
  cwd: "<project>"
})
```

- `--mode views` (default engine `workbench`): front/side/top/iso at 1024 in ~1.3 s,
  ~0.7 GB RSS. This is the **iteration** image.
- `--mode hero` (default engine `cycles`, `--samples 32`): one three-quarter material
  shot. 1024/64 is ~13 s on a 16-core CPU and ~1.3 GB; use 512/32 for iteration,
  1024/64 for the final. On a 4-core laptop it is noticeably slower.
- `--unit mm` is the project default. An STL has no unit; Blender treats its numbers
  as metres. `--unit m` is for meter files; `--unit auto` is only a heuristic.
- `--rig sun` (default) keeps exposure stable across a 30 mm ornament and a 1.2 m
  panel; `--rig area` gives softer highlights but its power must be tuned per size.
  `--exposure -1..-3` is the quick fix when a very flat, top-lit panel clips.
- `--material plastic|metal|clay|none`, `--color R,G,B`, `--keep-materials`,
  `--background light|dark|transparent`, `--shade auto|smooth|flat`, `--glb out.glb`
  are the supported knobs. Do not grow a scene DSL in the skill; if a real job needs a
  different set, write a **separate** script and keep it as the user's raw material.
- The metadata file (`<out>/metadata.json`) records engine, size, unit, bbox,
  polygon count and output paths. Read it; do not describe the image from memory.
- **On this raw path `run_python` returns stdout, not an image block.** If your tool
  catalog has `read_image`, call it on the PNG path; otherwise state the absolute
  path and ask the human to open it. Only the native `render_part` path attaches.
- bpy may print `Extensions: writing cache failed` or MESA/ZINK warnings even when the
  render succeeded. Judge by the exit code, the PNG and `metadata.json` — those lines
  are not a failure.

Smoke test when installing for the first time: `--mode views --engine workbench
--size 64` on a small mesh. It should finish in a few seconds and produce four
non-trivial PNGs. If it does not, stop and report the failure — do not proceed to a
13-second hero and call it "close enough".

## 5. QC: what we check, and what we refuse to call "quality"

The site inspects **deliverables**, not taste:

| Deliverable | QC | Not QC |
|---|---|---|
| render-only art image | PNG exists, declared engine/unit/camera, metadata matches | whether it is beautiful, on-brand, or "good art" |
| printable sculpture / ornament | `import_part` the STL; `measure_part` (watertight, bodies, volume); `check_printability` (wall, overhang, process) | whether the render looks printable |
| a bpy-generated mesh | same truth engine as any imported part; non-solid is rejected unless `allowNonSolid` is explicit and marked | "Blender made it, so it is a solid" |
| color/material design | `.blend`/GLB source, `materials_preserved: true`, render shows the declared material regions | whether the color prints; `check_printability` does not check color |

**A render is not a manufacturability certificate.** If the user wants to print,
export the mesh from the authoritative source, import it as a version, and run the
checks. bpy's remesh/boolean can produce a watertight mesh, but it can also produce
a beautiful non-manifold one; the truth engine decides.

## 6. Version and provenance (do not lose the source)

- A bpy **modeling** script is source: keep it with its version (seed, parameters,
  bpy version) so the result is reproducible. L2 does not add a modeling tool; if
  the user brings a bpy script, store the script next to the version and say what
  produced the mesh.
- A color design needs an **appearance artifact**: `.blend` (source) + GLB (carrier) +
  PNG (review). `attach_appearance` versions the GLB as `appearance.glb` +
  `appearance.json`; `render_part({appearance:true})` consumes it. The CAD panel still
  previews STL, so do not claim the panel is showing the color yet.
- A bpy **render** of an existing version is an artifact, not a new version. Name
  the PNGs with the version/part label; put them under the project's render area or
  a `renders/` directory, and state the path.
- Do not silently overwrite a version's canonical four views with art renders; those
  views are the review channel.

## 7. When bpy is unavailable

| situation | use |
|---|---|
| `unsupported` but a Blender CLI exists (macOS Intel with 4.5 LTS) | the **same** `render_studio.py` via `blender -b --factory-startup -noaudio -P <script> -- <args>` |
| Linux arm64 / musl, no official Blender | OpenSCAD/BOSL2 for the geometry; say the art lane is not available here; do not fake it |
| no bpy and no Blender | stay in OpenSCAD; a flat render is still a render; art lane is a site condition, not a promise |
| install failed | report the exact pip/preflight error; do not retry blindly or fall back to a system interpreter |

The CLI form is a **user-supplied raw material** path: the script is dual-entry, so
the user can bring their own Blender build. That is intentional; the project does
not need to bundle or auto-detect every Blender.

## 8. Hard limits (say them before they bite)

- **Platform 3/7**: bpy 5.2.3 has wheels for linux-x64, macOS arm64, Windows x64
  (and win-arm64, outside this project's targets). Linux arm64, musl and macOS Intel
  have no 5.2.x wheel.
- **Python 3.13 only**: bpy 5.2.x requires `==3.13.*`. Do not install it into a 3.14
  runtime; preflight will say `unsupported-python`.
- **No GPU guarantee**: Cycles uses CPU by default; headless EEVEE on software GL is
  ~12 s for 512 px, so do not choose EEVEE for CI or batch work.
- **No worker embedding**: bpy writes `Saved:`/`Timer` to stdout, and the resident
  worker's stdout is the JSON-lines protocol. The lane runs in a child process
  (`render_part` → `runPython`, or `run_python` directly); do not `import bpy` inside
  `worker.py`.
- **No aesthetic QC and no product promise**: the site provides utilities, a map,
  a baseline and a QC handoff; the user owns the art and its judgment.
- **No GLB panel preview yet**: `attach_appearance` + `render_part({appearance:true})`
  are versioned/renderable, but the panel still previews STL. GLB appearance in the
  panel is L4, not a promise of this lane.

## 9. Example

`examples/art-decor-panel/` is a render target, not a bpy modeling tutorial:
`panel.scad` (parametric decorative panel) → OpenSCAD STL → this skill's
`render_studio.py`. It shows the intended split: geometry stays in the authoritative
source; bpy supplies the camera, materials and light. For bpy-generated geometry,
the same QC path applies, but that is **L3** (not part of this lane's promise).
