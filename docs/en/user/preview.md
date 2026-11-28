# 0.2.0-preview.1 preview notes

> **Unreleased**: the latest published npm version is 0.1.2-preview.1; this page describes the repository version 0.2.0-preview.1. Install the published version through the npm path; use the release page for the exact tarball name.

[中文](../../user/preview.md) | English

> **This is a preview, not a production release gate.** It installs, diagnoses itself, verifies and delivers, but it does not promise industrial tolerances, certified accuracy or long-term support. Treat it as a usable instrument, not a certificate.

## What is in this release

- Natural language → OpenSCAD or CadQuery part → compile, render, version store;
- The model-facing catalog is compressed from 45 legacy tools to **9 job surfaces**
  (`cad_session`/`cad_part`/`cad_assembly`/`cad_check`/`cad_simulate`/`cad_inspect`/
  `cad_see`/`cad_python`/`cad_deliver`), with arguments under `action`;
- Standard-parts catalogue v0: 99 catalogue items with pre-generated STEP/STL
  (fit and visual LOD), shipped in the package; **this release has no
  `cad_part` catalogue select/import action yet** — see
  [the catalogue reference](../llm/library.md). This is not the optional BOSL2 modelling library;
- Five verification layers: geometry / assembly / rigid body & mechanism / fluid / process;
- **Check before you save**: `cad_part generate` takes `dryRun` (compile + measure, write nothing) and `preflight` (save only when the mesh is watertight and a single body; sub-1.2mm walls are a warning);
- **Sweep screen and fit envelopes**: `cad_check` `sweep` finds suspects over a declared joint range before a motion run; revolute joints can declare `overlapEnvelope` / `fit`, and motion supports a `gear` ratio;
- **Overhang is a support cost**: reported as a finding by default; only a process profile with `overhangDeg.hard: true` lowers the verdict to `difficult`;
- **Panel**: heat-map layers (fused risk / thickness / overhang / von Mises) and a light/dark theme that follows the host;
- **Four measurement families + history**: distance / three-point angle / section area / bore diameter; entries can be renamed, deleted, and travel with the screenshot caption;
- **Viewport navigation**: one 「View」 menu with front/back/left/right/top/bottom + iso, perspective↔orthographic, restore/Home; per-part hide / isolate / highlight in the assembly preview;
- **Audit view**: the machine page answers "which step has not been run", and a row jumps to the run or version it names;
- **Checks can be re-run**: manufacturing/assembly in one click, stress replayed (version re-pinned); a run that never saved its request is refused with the missing list;
- **Fluid progress and cancel**: a long run shows steps done / total and Cancel stops the solver process; the flow axis of a stubby part now comes from its cavity;
- **BOM CSV**: seven columns (part / version / qty / material / process / source / stock id), unconfirmed processes marked;
- **Examples**: sewing rotary hook and 3-speed derailleur, each with a CadQuery variant; per "new in, old out", 3 older examples moved to the history table while keeping their directories and corpora;
- Assembly contract (BOM + executable ICD), delivery audit, evidence CLI;
- Risk-annotated export: a blocked delivery can still be exported, but the panel asks for confirmation, the filename carries `_UNVERIFIED`, and the project `exports/<id>/` keeps a manifest and the findings;
- Playback export: the motion toolbar has **GIF** and **WebM**, exporting the whole trajectory from the **current camera** in the browser (nothing is uploaded); GIF uses the built-in 256-colour encoder;
- Two places a screenshot can go: **Shot** sends the current frame (annotations baked in) into the session; **Save** downloads that same image as a PNG;
- Environment self-check: `dsh-cad-doctor` distinguishes “not installed / not configured / broken project / missing capability” and gives the next step.

## Install

See [install](install.md). The minimum path:

```bash
dsh plugin --profile <profile> add dsh-cad-harness   # npm; tarball is the offline fallback (see install)
npx dsh-cad-setup --openscad=auto # write this machine's skill path and prepare OpenSCAD
npx dsh-cad-backend --show
npx dsh-cad-doctor
npx dsh-cad-verify <project> --advisory
# restart dsh
```

OpenSCAD is prepared by `setup --openscad=auto`: an existing 2025.06+ system install is used as-is; otherwise the official snapshot is tried first and the OSS mirror is used only when the official source is unreachable or too slow. 2021.01 works but `doctor` reports `degraded`. The plugin does not ship OpenSCAD, and OpenSCAD is the default kernel, not the only possible one. This release ships OpenSCAD and CadQuery; CadQuery needs the optional ~1.6 GiB pack installed explicitly (setup does not download it). FreeCAD remains `planned` and cannot be selected.

## Known limits

- **Approval/rollback**: browse, pin and compare versions. The agent can propose a revert; approving it in the panel creates a new version. There is no separate version sign-off workflow.
- **Python runtime**: the first use downloads about 400 MB and may take minutes; offline failure gives the next step.
- **BOSL2**: optional OpenSCAD modelling library; needed when using its threads/gears/screws modules, and a missing copy is reported rather than silently producing empty geometry.
- **Kernel**: OpenSCAD plus optional CadQuery; one authoring kernel per project, old versions keep their pin. OpenSCAD remains the rendering/export dependency.
- **Long tasks**: background **compile** jobs have submit/status/cancel/timeout/restart recovery; rendering and simulation are still synchronous. A timeout is reported, never treated as a pass.
- **English UI**: all client-visible strings go through i18n (same keys in zh/en;
  `accept:ui-i18n` scans literals), and the deep panel is English too as of preview.2.
  Host-side model-facing tool output/diagnostics remain Chinese.
- **English docs**: the complete English user set is available under `docs/en/user/`; HARNESS also has an English version. `docs/llm` has an English version too; `docs/dev` stays Chinese for now.
- **Export**: `_UNVERIFIED` is a warning, not a security boundary; renaming the file does not change the manifest verdict. A `difficult` export shows one warning before the download but keeps the original filename.
- **Schema/migration**: old projects open; an unknown newer `schemaVersion` is refused by `doctor`; there is no automatic migrator, so back up before migrating.
- **CI**: GitHub Actions now runs in tiers (fast / nightly full / tag release gate); a tag runs the Ubuntu + macOS full matrix, Windows smoke and the CadQuery pack. This machine runs Linux only.
- **Example display**: current examples follow "new in, old out"; a moved example keeps its directory, corpus and evidence and is only no longer shown as current.
- **Carried over from the 0.1.2 line, not in this release**: visual sign-off, recorded clean-environment example runs, the full STEP path, async render/simulation jobs and the catalogue tool entry; viewport picking is deferred.

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

Near term: the remaining 0.1.2-line items (recorded example runs, the full STEP path,
async render/simulation jobs, the catalogue tool entry) and visual sign-off; viewport
part picking waits until the viewport itself is more complete. Mid term is depth/quality
(assembly v2, criterion calibration, example corpus reruns) and evaluating a third
engine. Full order: [`docs/dev/TODO.md`](../../dev/TODO.md) (Chinese).
