# 0.1.1-preview.1 preview notes

[中文](../../user/preview.md) | English

> **This is a preview, not a production release gate.** It installs, diagnoses itself, verifies and delivers, but it does not promise industrial tolerances, certified accuracy or long-term support. Treat it as a usable instrument, not a certificate.

## What is in this release

- Natural language → OpenSCAD part → compile, render, version store;
- The model-facing catalog is compressed from 39 tools to **9 job surfaces**
  (`cad_session`/`cad_part`/`cad_assembly`/`cad_check`/`cad_simulate`/`cad_inspect`/
  `cad_see`/`cad_python`/`cad_deliver`), with arguments under `action`;
- Standard-parts library v0: 99 catalogue items with pre-generated STEP/STL
  (fit and visual LOD), shipped in the package;
- Five verification layers: geometry / assembly / rigid body & mechanism / fluid / process;
- Assembly contract (BOM + executable ICD), delivery audit, evidence CLI;
- Risk-annotated export: a blocked delivery can still be exported, but the panel asks for confirmation, the filename carries `_UNVERIFIED`, and the project `exports/<id>/` keeps a manifest and the findings;
- Playback export: the motion toolbar has **GIF** and **WebM**, exporting the whole trajectory from the **current camera** in the browser (nothing is uploaded); GIF uses the built-in 256-colour encoder;
- Two places a screenshot can go: **Shot** sends the current frame (annotations baked in) into the session; **Save** downloads that same image as a PNG;
- Environment self-check: `dsh-cad-doctor` distinguishes “not installed / not configured / broken project / missing capability” and gives the next step.

## Install

See [install](install.md). The minimum path:

```bash
tar -xzf dsh-cad-harness-0.1.1-preview.1.tgz
dsh plugin --profile <profile> add -w "$PWD/package"
cd package
npx dsh-cad-setup
npx dsh-cad-backend --show
npx dsh-cad-doctor
npx dsh-cad-verify <project> --advisory
# restart dsh
```

OpenSCAD is prepared by `setup --openscad=auto`: an existing 2025.06+ system install is used as-is; otherwise the official snapshot is tried first and the OSS mirror is used only when the official source is unreachable or too slow. 2021.01 works but `doctor` reports `degraded`. The plugin does not ship OpenSCAD, and OpenSCAD is the default kernel, not the only possible one. This release ships OpenSCAD and CadQuery; CadQuery needs the optional ~1.6 GiB pack installed explicitly (setup does not download it). FreeCAD remains `planned` and cannot be selected.

## Known limits

- **Approval/rollback**: browse, pin and compare versions. The agent can propose a revert; approving it in the panel creates a new version. There is no separate version sign-off workflow.
- **Python runtime**: the first use downloads about 400 MB and may take minutes; offline failure gives the next step.
- **BOSL2**: optional; standard parts need it, and a missing copy is reported rather than silently producing empty geometry.
- **Kernel**: OpenSCAD plus optional CadQuery; one authoring kernel per project, old versions keep their pin. OpenSCAD remains the rendering/export dependency.
- **Long tasks**: background **compile** jobs have submit/status/cancel/timeout/restart recovery; rendering and simulation are still synchronous. A timeout is reported, never treated as a pass.
- **English UI**: all client-visible strings go through i18n (same keys in zh/en;
  `accept:ui-i18n` scans literals), and the deep panel is English too as of preview.2.
  Host-side model-facing tool output/diagnostics remain Chinese.
- **English docs**: the complete English user set is available under `docs/en/user/`; HARNESS also has an English version. `docs/llm` has an English version too; `docs/dev` stays Chinese for now.
- **Export**: `_UNVERIFIED` is a warning, not a security boundary; renaming the file does not change the manifest verdict. A `difficult` export shows one warning before the download but keeps the original filename.
- **Schema/migration**: old projects open; an unknown newer `schemaVersion` is refused by `doctor`; there is no automatic migrator, so back up before migrating.
- **CI**: the GitHub Actions workflow is written but was not run from this machine (network); `rehearse:preview` is the local equivalent.

## Reporting a problem

Please include:

1. `npx dsh-cad-doctor --json` (or at least `kind` and the failing checks);
2. OS, dsh version, OpenSCAD version;
3. reproduction steps (the sentence, the button);
4. the original error text, not just “it failed”.

## Where data lives

- Project corpus: `<project>/cad-data/` (versions, runs, export records under `exports/`);
- Runtime: `$DSH_HOME/cad/runtime/`;
- Kernel/compile backend: `$DSH_HOME/cad/backend.json`;
- Uninstalling the plugin does not delete project data; deleting the project directory does. Back up first.

## After this release

Near term: render/simulation jobs, Python first-run progress; re-running the example
corpora (windup and friends) is scheduled for 0.2.
First mid-term item: a second geometry kernel (CadQuery first). Full order: [`docs/dev/TODO.md`](../../dev/TODO.md) (Chinese).
