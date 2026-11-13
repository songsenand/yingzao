# Advanced usage

[中文](../../user/advanced.md) | English

## Install extra Python packages

Tell the agent which library you need. Packages go into the **user overlay** (`$DSH_HOME/cad/runtime/user-site/`): it is your machine, your network, and upgrades of the runtime **do not wipe it**. All calculation tools can use it, and every verification records it in provenance.

- **Default: add, do not override.** Packages already in the lock stay at the locked version, so numpy does not fork silently.
- **Forcing a locked dependency to change**: say explicitly “override locked X because …”. The package goes into a separate directory placed first on `sys.path` (a real replacement, not just a report); the reason is written to the install record and to each verification's provenance.

## Appearance / colour (GLB sidecar)

If you have a self-contained GLB, the agent can attach it to a version (`appearance.glb` + `appearance.json`).

- `model.stl` remains the **geometry truth**; the panel still previews STL only.
- The GLB opens in an external viewer; an in-panel viewer is not implemented.
- Colour is not a geometry pass condition: a coloured render does not mean a printed colour, and does not affect printability.

## Import existing files

The **📂** control at the top of the panel (or **Unregistered** in the category dropdown) lists geometry in the workspace that has no version (STL / STEP / 3MF / DXF).

- Select to preview: no version, no measurement, no agent context.
- When satisfied, fill in **part name and unit**, then “Import as version”. Only then can it be measured, assembled and delivered.
- 3MF must contain exactly one object; DXF needs an extrusion depth.
- If the file is outside the workspace, use “📂 Import by path…”.

## Multiple projects / working directories

When a large project has several components (`components/*/`) or several example corpora coexist, use the **working directory** dropdown at the top of the panel to switch what you are looking at.

- This is **read-only browsing**: agent writes always stay in the session directory.
- Switching does not change the session's corpus root; it only changes which corpus you view in the panel.
