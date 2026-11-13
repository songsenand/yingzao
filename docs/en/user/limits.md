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
- **Rigid body / mechanism is kinematics plus an interference timeline.** It answers “will it collide, is the stroke enough”, not “how much force”. The exception is `check_assembly`'s axial spring/snap static screening: installation force, end-stop force and snap insertion/retention force, but not contact, fatigue or certification.

## Meshes

- **Bad meshes are not repaired.** Open, non-manifold or multi-body parts are **rejected** with the location of the problem; you do not get a confident wrong number.
- **One part must be one connected solid.** Merge fragments or split them into separate parts.
- **3MF must contain exactly one object.** A slicer's “plate of parts” export is rejected with the body count.

## Versions

- **Browse, pin and compare; there is no approve or rollback action.** Approval and one-click rollback are not implemented.
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

## Platform differences

| Platform | Difference |
|---|---|
| Linux x64, macOS arm64, Windows x64 | Full capability |
| macOS Intel | Physics/motion use the built-in engine (usable results); no Python physics library |
| musl (Alpine etc.) | STEP import and general CFD unavailable; the rest works |

## Other

- **A session must explicitly select a project** (`bind_project` / `init_project`) and stays there; `cd` does not switch it. Start a new session to change projects.
- **No multi-user, permissions, cloud or mobile.** Local single-user tool.
- **Very image-heavy sessions may be rejected upstream.** The default window keeps 24 images; headless sessions can lower it.

## What to do at a limit

1. **Look for “not evaluated / skipped” in the report** — that is usually where the limit is.
2. **Do not substitute “no error” for “checked”.** Even inside the supported area, read the evidence.
3. **For guarantees outside the boundary** (certification, exact FEA, engineering drawings), say “this tool does not provide it” and use a professional tool instead of pretending.
