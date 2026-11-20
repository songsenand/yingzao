# Limits

[中文](../../user/limits.md) | English

These are **known limits**, not bug reports waiting to be fixed. Knowing them is what keeps “not checked” from becoming “no problem”.

## Accuracy and certification

- **No industrial tolerances, engineering drawings or production BOM.** This is a design-verification tool, not a production release system.
- **No certified accuracy.** Numbers come from meshes and sampling. Reports state the measurement conditions; they are not a certificate.
- **Millimetres, Z up.** There is no unit parameter; imported parts must declare their unit.

## Analysis

- **No exact FEA / stress analysis.** Trends and hot spots, not a safety factor.
- **Fluid is a trend judgement, not industrial CFD.** Flow direction, dead zones and pressure-drop trends; do not use it as acceptance data.
- **Rigid body / mechanism is kinematics plus an interference timeline.** It answers “will it collide, is the stroke enough”, not “how much force”. The exception is the assembly check's axial spring/snap static screening: installation force, end-stop force and snap insertion/retention force, but not contact, fatigue or certification.

## Meshes

- **Bad meshes are not repaired.** Open, non-manifold or multi-body parts are **rejected** with the location of the problem; you do not get a confident wrong number.
- **One part must be one connected solid.** Merge fragments or split them into separate parts.
- **3MF must contain exactly one object.** A slicer's “plate of parts” export is rejected with the body count.

## Versions

- **Browse, pin and compare.** The agent can propose a revert; approving it in the panel creates a new version (history is not rewritten). There is no separate version sign-off workflow.
- Every generation/edit is a new version; old versions remain. Which one is “official” is your record, not the tool's seal.

## Import formats

| Format | Status |
|---|---|
| STL / STEP / 3MF / DXF | Available (DXF needs an extrusion depth) |
| IGES, OBJ/OFF | **Not supported**; rejected with a conversion suggestion |

- Local preview reads **STL only**; STEP/3MF go through “import as version” and server-side conversion.
- An imported part can participate in assemblies and checks but has **no datums** unless declared at import or added later.

## Appearance / colour

- GLB is stored only as a **sidecar**; the panel still previews STL.
- Colour is not a geometry pass condition: a coloured render does not mean a printed colour, and does not affect printability.

## CadQuery (optional kernel)

- **CadQuery is optional and never replaces OpenSCAD.** Four-view rendering, sections, motion/assembly keyframes, and mesh export still use OpenSCAD.
- **The pack is 1.4–1.6 GiB**, installed explicitly at `$DSH_HOME/cad/packs/cadquery` (or `DSH_CAD_CQ_PACK`); it is not shipped in the npm tarball and `setup` does not download it.
- **CadQuery scripts are Python executed with your user privileges**, not sandboxed. The pack's VTK/OCP are import/B-rep dependencies; they are not the renderer.
- **One authoring kernel per project.** New versions pin `backend.kernel`; old versions are never rewritten and keep their own pin.
- **STEP is a native artifact, not design evidence.** Design checks still use the STL mesh; a valid B-rep is not a pass.
- **Windows/macOS status:** the Linux-only `xvfb-run`/path assumptions were removed in code, but no real-machine smoke has been run; do not claim cross-platform verification.

## Platform differences

| Platform | Difference |
|---|---|
| Linux x64, macOS arm64, Windows x64 | Full capability |
| macOS Intel (x64) | **Not supported**: no bundled Python runtime build for this platform (retired 2026-11-16); use Apple Silicon, Linux or Windows |
| musl (Alpine etc.) | STEP import and general CFD unavailable; the rest works |

## Other

- **A session must explicitly select a project** (the agent selects or creates one) and stays there; `cd` does not switch it. Start a new session to change projects.
- **No multi-user, permissions, cloud or mobile.** Local single-user tool.
- **Very image-heavy sessions may be rejected upstream.** The default window keeps 24 images; headless sessions can lower it.

## What to do at a limit

1. **Look for “not evaluated / skipped” in the report** — that is usually where the limit is.
2. **Do not substitute “no error” for “checked”.** Even inside the supported area, read the evidence.
3. **For guarantees outside the boundary** (certification, exact FEA, engineering drawings), say “this tool does not provide it” and use a professional tool instead of pretending.
