---
name: cad-modeling-measure
description: "Authoring/importing/measuring geometry in short: OpenSCAD degree-vs-radian and twist traps, import formats and units, merge_parts vs separate parts, genus/bodies. Full detail: docs/llm/modeling.md."
whenToUse: "Authoring or importing a part, measuring geometry you did not create, or debugging a measurement that looks wrong."
---

# Modeling and measurement: the short rules

Router: `skills/cad-toolbox/SKILL.md` — this file assumes you loaded it.

The hard part is naming the thing you want measured. `list_features` gives coordinates for geometry you did not author.

## Import

- **`import_part` refuses a mesh that is not a closed solid.** `allowNonSolid:true` is only for looking at broken geometry; it brands the version so geometric tools refuse it.
- **STL has no unit.** `unit` (mm/cm/m/inch) and `scale` are your declaration, applied once and recorded. Check `sizeMm` before trusting anything else.
- STEP/3MF/DXF carry units: STEP self-declares, 3MF `model@unit` wins, DXF `$INSUNITS` wins when set. `scale` still works.
- **Formats: STL / STEP / 3MF / DXF in; IGES and OBJ/OFF are refused** with a conversion route. **A 3MF must contain ONE object**; a slicer "plate of parts" is refused with the body count. DXF needs `depthMm`.
- **Tessellation is yours for STEP/3MF**: `tolLinear` (mm) / `tolAngular` (rad); lower them only when curvature is the question. STL/DXF ignore them.
- **Color is not an import format.** A GLB color design is a sidecar via `attach_appearance`; the panel still previews STL.

## Modeling

- **`merge_parts` is for "one rigid body", not tidying a corpus.** It reports **shells**: more than one means the merged parts do not all touch — a pile, not a machine.
- **`genus` is meaningful only for ONE connected solid.** For multi-body use `measure_part` (`bodies` uses shared edges; two solids touching at a vertex are two bodies).
- **`// PARAMS`** turns a top-level `name = number; // PARAMS <label>` into a panel tunable for that version.

## Traps

- **OpenSCAD trig is DEGREES in and out; gear/thread math is radians.** Convert with `d2r`/`r2d` at the boundary. On the pitch circle the mixed terms cancel, so a spot check can pass while the flank is garbage.
- **`linear_extrude(twist=)` turns opposite to 2D `rotate()`.** A positive twist rotates the section clockwise viewed from +Z; a blade built as `rotate(β_root) linear_extrude(twist = β_tip − β_root)` is twisted the wrong way and still looks plausible. Check a radial slice numerically.
- **A render that exits 0 may not have done what you asked.** OpenSCAD warns on unknown parameters and carries on (`rotate(m=…)` silently became identity). Read the renderer's warnings.
- **The user's reference image is the oldest and gets pruned first.** When it is omitted, call `recall_reference_image({ path })`; do not work from memory. Before claiming "matches the reference", make sure it is in vision.

Full authoring traps, unit rules, format details and the microscope3/propeller cases: `docs/llm/modeling.md`.
