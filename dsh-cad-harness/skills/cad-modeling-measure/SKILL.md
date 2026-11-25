---
name: cad-modeling-measure
description: "Authoring/importing/measuring geometry in short: CadQuery vs OpenSCAD authoring contracts, OpenSCAD degree-vs-radian traps, import formats and units, merge vs separate parts, genus/bodies. Full detail: docs/llm/modeling.md and docs/llm/cadquery.md."
whenToUse: "Authoring or importing a part, measuring geometry you did not create, or debugging a measurement that looks wrong."
---

# Modeling and measurement: the short rules

> **Kernel check first.** The session prompt states the effective kernel (`CAD authoring kernel: …`); `cad_session` (`action: "info"`) confirms it. If it is `cadquery`, author with `generate_part({code})` and read `docs/llm/cadquery.md`; the OpenSCAD-specific traps below apply only when the kernel is `openscad`. Do not load SCAD workarounds for a CQ part.

Router: `skills/cad-toolbox/SKILL.md` — this file assumes you loaded it.

The hard part is naming the thing you want measured. `cad_inspect` (`action: "features"`) gives coordinates for geometry you did not author.

## Import

- **`cad_part` (`action: "import"`) refuses a mesh that is not a closed solid.** `allowNonSolid:true` is only for looking at broken geometry; it brands the version so geometric tools refuse it.
- **STL has no unit.** `unit` (mm/cm/m/inch) and `scale` are your declaration, applied once and recorded. Check `sizeMm` before trusting anything else.
- STEP/3MF/DXF carry units: STEP self-declares, 3MF `model@unit` wins, DXF `$INSUNITS` wins when set. `scale` still works.
- **Formats: STL / STEP / 3MF / DXF in; IGES and OBJ/OFF are refused** with a conversion route. **A 3MF must contain ONE object**; a slicer "plate of parts" is refused with the body count. DXF needs `depthMm`.
- **Tessellation is yours for STEP/3MF**: `tolLinear` (mm) / `tolAngular` (rad); lower them only when curvature is the question. STL/DXF ignore them.
- **Color is not an import format.** A GLB color design is a sidecar via `cad_part` (`action: "appearance"`); the panel still previews STL.

## Measuring at a motion pose

- **`cad_inspect` (`action: "measure"`, `kind: "gap"`) can read a saved run's pose.** Pass `runId`, `aPart`, `bPart` and either `timeSec` or `step` (looked up in that run's interference events). It returns the closest surface distance and both witness points at that trajectory pose; no re-run and no hand-written trajectory math.
- **A closest-point number is surface clearance, not a collision test.** An embedded part can report a positive distance while the run's boolean reports a real overlap. When the cited run reports an overlap at that step, the reply carries a warning; use the event's `overlapBboxMm` for the overlap region.

## Preflight before spending a version

- **`dryRun: true` compiles and checks without creating anything.** It returns watertight / bodies / bbox / min-wall and writes no version, no image, no part row. Use it when you want to probe a script before committing it.
- **`preflight: true` saves only when the mesh is watertight AND one connected body.** A sub-1.2mm wall is a warning, not a refusal — legitimate thin ears exist. A refusal writes no version and no image, so the failed attempt does not pollute the part's history; the reply carries `preflight.ok / bodies / minWallMm`.
- **Do not batch design iterations.** The sewing session's 94 `parentVersion` generations were one-at-a-time feedback; preflight removes the bad ones, it does not make a batch of alternatives safe.

## Modeling

- **`cad_part` (`action: "merge"`) is for "one rigid body", not tidying a corpus.** It reports **shells**: more than one means the merged parts do not all touch — a pile, not a machine.
- **`genus` is meaningful only for ONE connected solid.** For multi-body use `cad_inspect` (`action: "measure"`) with `kind="part"` (`bodies` uses shared edges; two solids touching at a vertex are two bodies).
- **`// PARAMS`** turns a top-level `name = number; // PARAMS <label>` into a panel tunable for that version.

## Traps

- **OpenSCAD trig is DEGREES in and out; gear/thread math is radians.** Convert with `d2r`/`r2d` at the boundary. On the pitch circle the mixed terms cancel, so a spot check can pass while the flank is garbage; the involute function `inv(α) = tanα − α` is where the mixed units usually hide.
- **`linear_extrude(twist=)` turns opposite to 2D `rotate()`.** A positive twist rotates the section clockwise viewed from +Z; a blade built as `rotate(β_root) linear_extrude(twist = β_tip − β_root)` is twisted the wrong way and still looks plausible. Check a radial slice numerically.
- **A render that exits 0 may not have done what you asked.** OpenSCAD warns on unknown parameters and carries on (`rotate(m=…)` silently became identity). Read the renderer's warnings.
- **The user's reference image is the oldest and gets pruned first.** When it is omitted, call `cad_see({ action: "reference", args: { path } })`; do not work from memory. Before claiming "matches the reference", make sure it is in vision.

Full authoring traps, unit rules, format details and the microscope3/propeller cases: `docs/llm/modeling.md`.
