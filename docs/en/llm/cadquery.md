# CadQuery authoring guide (L1.5)

> Short rules live in `skills/cad-modeling-measure/SKILL.md`. This page is the
> contract for a script that compiles.

## Choose a kernel

The session prompt states `CAD authoring kernel: cadquery|openscad` (from the project marker or global `backend.json`); `cad_session` action `info` confirms it. Do not guess.

- OpenSCAD: `generate_part({ scadCode })`.
- CadQuery: `generate_part({ code })`.
- Give exactly one. The version records `sourceFile: model.py` and
  `backend: {kernel:"cadquery"}`; switching kernels never rewrites old versions.
- `cad_session` action `info` reports the effective kernel: a project's
  `cad-data/project.json` `defaultKernel` wins over global `backend.json`.

## Switching the kernel in place (`cad_session` action `kernel`)

`cad_session({ action: "kernel", args: { kernel: "cadquery" } })` changes the **project default authoring kernel**; it does not create a new project:

- Existing versions keep their own `backend.kernel` and `sourceFile`; only later `cad_part generate` calls follow the new kernel.
- `dir` defaults to the session's bound project; returns `previous` / `kernel` / `note`.
- The session prompt updates on the next turn. Do not create a second project just to switch engines — the design, versions and evidence would be split into two corpora, and merging them is more expensive than switching.

## Script contract

```python
import cadquery as cq

result = (
    cq.Workplane("XY").box(60, 40, 6)
    .edges("|Z").fillet(4)
    .faces(">Z").workplane()
    .rect(44, 26, forConstruction=True).vertices().hole(4.5)
)

datum("top", [0, 0, 6])
datum_plane("top_plane", [0, 0, 6], [0, 0, 1])
datum_axis("hole_axis", [22, 13, 0], [0, 0, 1])
datum_cyl("hole", [22, 13, 0], [0, 0, 1], 2.25)
```

- Leave a `Workplane`/`Shape` in `result`, or call `show_object(result)`.
- Do not export artifacts yourself; the provider writes STL (and optional STEP).
- Do not import trame/vtk/pyvista; rendering uses the shared STL→OpenSCAD path.
- Datum order is point first: `(name, point, dir)`; Python positional calls can
  silently compile a swapped direction.
- **`box()` is centered at the origin**: for “bottom face at z=0”, translate by `h/2`. Datums do not enforce this; `datum_outside_bbox` is only a warning.
- mm, Z-up. Assembly constraint solving is outside the L1.5 contract.

## Error codes

`cadquery_pack_missing`, `cadquery_pack_broken`, `cadquery_syntax`,
`cadquery_exception`, `cadquery_timeout`, `cadquery_no_result`,
`cadquery_export`, `cadquery_invalid_brep`, `cadquery_step_export`.
Every failure carries a `fix`. A missing pack is installed explicitly
(`DSH_CAD_CQ_PACK` or `$DSH_HOME/cad/packs/cadquery`); nothing auto-downloads.

## Example

`dsh-cad-harness/examples/cadquery/bracket.py`, with the end-to-end README
beside it.
