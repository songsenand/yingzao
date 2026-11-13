[English](../en/llm/modeling.md) | 中文

# 建模与测量：作者陷阱与工具选择

> 长解释参考；短规则在 `skills/cad-modeling-measure/SKILL.md`。


The hard part is almost never the arithmetic — it is naming the thing you want measured. `list_features` gives you coordinates for geometry you did not author.

## Facts that are not obvious from the tool descriptions

- **`import_part` refuses a mesh that is not a closed solid, and that is a
  feature.** It runs Manifold on the file first; if the surface has holes,
  T-junctions or inside-out winding, nothing is stored. Storing it would let
  `measure_part`, `validate_assembly` and the simulators report confident numbers
  about a shape that is not a body. `allowNonSolid:true` exists only to look at
  broken geometry, and it brands the version so the geometric tools refuse it.
- **STL has no unit.** `import_part`'s `unit` (mm/cm/m/inch) and `scale` are your
  declaration, applied once before measurement and recorded in the version's
  provenance. A 25.4x wrong part is the classic failure here, so check the
  reported `sizeMm` against what you expected before trusting anything else.
  STEP, 3MF and DXF carry their own units: STEP self-declares and 3MF declares
  `model@unit` (both accept only `mm`/omitted — the file wins; `scale` still
  works); DXF `$INSUNITS` wins when set, otherwise your `unit`.
- **Formats: STL / STEP / 3MF / DXF in — IGES and OBJ/OFF out.** `import_part`
  reads STEP/STP (tessellated through OpenCASCADE in the worker), 3MF (trimesh's
  reader: build transforms and `<components>` are baked; the result is a mesh, so
  accuracy is bounded by the tessellation) and DXF (closed 2D profiles become a
  solid only when you pass `depthMm` — a profile is not a body; 3D mesh entities
  come in as-is). **A 3MF must contain ONE object**: a slicer's "plate of parts"
  is refused with the body count, because this harness's unit is one connected
  part. **IGES is not readable**: the tool says so with the conversion route
  (re-export STEP or STL) instead of failing mysteriously.
- **Color is not an import format here.** GLB/OBJ are not `import_part` inputs;
  3MF is read as geometry, and the color/material payload is not validated. A GLB
  color design can be stored as a sidecar with `attach_appearance`; it is not a
  render path and the panel still previews STL. Do not use `import_part` as a color
  handoff.
- **Tessellation is a choice you own for STEP/3MF.** `tolLinear` (mm) and
  `tolAngular` (rad) trade triangles for fidelity: at 0.01 mm a small bracket was
  3074 triangles, at 0.002 mm 12254, with <0.3% volume change — so the default is
  fine for measurement and you lower it only when curvature IS the question (a
  thread, a fillet radius). STL/DXF ignore both (the mesh is already given).
- **`merge_parts` is for "one rigid body", not for tidying a corpus.** Use it when
  a whole machine has to be a single body (`simulate_physics` topple, a
  whole-assembly `measure_part`), because `simulate_physics` takes only
  revolute/prismatic joints and cannot hold a machine together by itself. It reports
  the number of **shells**: more than one means the parts you merged do not all
  touch, so the body is not a machine but a pile.
- **`genus` is only meaningful for ONE connected solid.** A multi-body mesh
  reports a negative genus; use `measure_part` (its `bodies` uses the shared-edge
  criterion — two solids touching at a single vertex are two bodies) for the count.
- **`// PARAMS`** turns a top-level `name = number; // PARAMS <label>` line into a
  panel tunable for that version.

## Traps that have cost real iterations

- **OpenSCAD trigonometry is DEGREES in and DEGREES out — gear and thread math
  is radians.** `sin/cos/tan` take degrees; `asin/acos/atan` return degrees;
  involute (`inv(α) = tanα − α`), helix pitch and cam tables need radians.
  Convert explicitly (`d2r` / `r2d`) at the boundary, never inline. The lethal
  part: on the pitch circle the mixed-up terms cancel, so one self-check number
  looks right while the whole flank is garbage (microscope3 shipped a gear with
  `ph(rb) = −19.6` "radians" that passed its pitch-radius spot check, then fed
  that gear as the hob for its rack — nine rework versions before anyone looked).
- **OpenSCAD's `linear_extrude(twist=)` turns the OPPOSITE way to 2D `rotate()`.**
  A positive twist rotates the section **clockwise** (viewed from +Z) as it rises,
  so a blade built as `rotate(β_root) linear_extrude(twist = β_tip − β_root)`
  comes out twisted the WRONG WAY — and it still *looks* like a twisted blade in
  every render. The propeller example shipped that for one version: pitch rose
  16.6°→24.2° with radius instead of falling, and only a radial slice with a
  solved chord angle caught it
  (`examples/multirotor-propeller/tools/check-pitch.py`). Same family as the
  degrees/radians trap: a convention invisible in the picture, so the check has
  to be numeric.
- **A render that exits 0 is not a render that did what you asked.** OpenSCAD
  reports an unknown parameter as `WARNING:` and carries on — `rotate(m=…)`
  (there is no such parameter; a matrix goes through `multmatrix`) silently
  degenerated to the identity, so every `simulate_motion` keyframe was the same
  picture until 2026-10-11. Read the renderer's warnings, or you will attach
  evidence that shows nothing.
- **Old images are pruned oldest-first, and the user's reference image is
  always the oldest.** When you see a block like
  `image omitted; 参考图.png; path=/…/attachments/…` and the task depends on
  that picture (matching proportions, colors, a bought part's shape), call
  `recall_reference_image({ path })` — do not work "from memory". The recalled
  image becomes the newest in context, so it survives for the following rounds;
  recall again whenever you need to look at it once more. Before delivering
  anything claimed to "match the reference", make sure the reference is
  actually in vision at that moment — if it is not, recall it first.
