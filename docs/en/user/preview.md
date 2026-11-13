# 0.1.0 preview notes

[中文](../../user/preview.md) | English

> **This is a preview, not a production release gate.** It installs, diagnoses itself, verifies and delivers, but it does not promise industrial tolerances, certified accuracy or long-term support. Treat it as a usable instrument, not a certificate.

## What is in this release

- Natural language → OpenSCAD part → compile, render, version store;
- Five verification layers: geometry / assembly / rigid body & mechanism / fluid / process;
- Assembly contract (BOM + executable ICD), delivery audit, evidence CLI;
- Risk-annotated export: a blocked delivery can still be exported, but the panel asks for confirmation, the filename carries `_UNVERIFIED`, and the project `exports/<id>/` keeps a manifest and the findings;
- Environment self-check: `dsh-cad-doctor` distinguishes “not installed / not configured / broken project / missing capability” and gives the next step.

## Install

See [install](install.md). The minimum path:

```bash
tar -xzf dsh-cad-harness-0.1.0.tgz
dsh plugin --profile <profile> add -w "$PWD/package"
cd package
node scripts/setup.mjs
node scripts/backend.mjs --show
node scripts/doctor.mjs
node scripts/verify-cli.mjs <project> --advisory
# restart dsh
```

OpenSCAD is installed by you: 2021.01 works but `doctor` reports `degraded`; 2025.06+ is recommended for Manifold. The plugin does not ship OpenSCAD, and OpenSCAD is the default kernel, not the only possible one. The preview ships only the OpenSCAD adapter; CadQuery/FreeCAD are listed as `planned`, cannot be selected, and are never silently substituted.

## Known limits

- **Approval/rollback**: browse, pin and compare versions; there is no approve or one-click rollback.
- **Python runtime**: the first use downloads about 400 MB and may take minutes; offline failure gives the next step.
- **BOSL2**: optional; standard parts need it, and a missing copy is reported rather than silently producing empty geometry.
- **Kernel**: OpenSCAD only in this preview. A second kernel is the first mid-term item, not a promise for this release.
- **Long tasks**: background **compile** jobs have submit/status/cancel/timeout/restart recovery; rendering and simulation are still synchronous. A timeout is reported, never treated as a pass.
- **English UI**: this release covers the tab title, environment notices, export dialog and main empty states. The deep panel is still mostly Chinese; full bilingual UI is preview.2.
- **English docs**: the complete English user set is available under `docs/en/user/`; HARNESS also has an English version. `docs/llm` and `docs/dev` stay Chinese for now.
- **Export**: `_UNVERIFIED` is a warning, not a security boundary; renaming the file does not change the manifest verdict.

## Reporting a problem

Please include:

1. `node scripts/doctor.mjs --json` (or at least `kind` and the failing checks);
2. OS, dsh version, OpenSCAD version;
3. reproduction steps (the sentence, the button);
4. the original error text, not just “it failed”.

## Where data lives

- Project corpus: `<project>/cad-data/` (versions, runs, export records under `exports/`);
- Runtime: `$DSH_HOME/cad/runtime/`;
- Kernel/compile backend: `$DSH_HOME/cad/backend.json`;
- Uninstalling the plugin does not delete project data; deleting the project directory does. Back up first.

## After this release

Near term: full bilingual UI, the full English user-doc set, Python first-run progress.
First mid-term item: a second geometry kernel (CadQuery first). Full order: [`docs/dev/TODO.md`](../../dev/TODO.md) (Chinese).
