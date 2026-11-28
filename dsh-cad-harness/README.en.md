# dsh-cad-harness (Yingzao / 营造)

Installable half of **Yingzao (营造)**: an LLM-driven CAD harness with a verification
loop (OpenSCAD/Manifold compile + render, layered geometry/assembly/physics/
fluid/process checks, immutable versions, and an evidence policy).

This package is normally installed as a dsh plugin bundle, not imported as a
library.

## Install (preview)

npm (recommended; no build, `lib/` is included):

```bash
dsh plugin --profile <profile> add dsh-cad-harness
npx dsh-cad-setup --openscad=auto   # preset + OpenSCAD
npx dsh-cad-doctor                  # kind=ok, or an explained degraded
npx dsh-cad-backend --show          # kernel=openscad, compileBackend=auto
# restart dsh; then choose the 「营造模式」 preset for a new session
```

Tarball (offline / intranet fallback; no build):

```bash
tar -xzf dsh-cad-harness-<version>.tgz   # use the release page version
dsh plugin --profile <profile> add -w "$PWD/package"
cd package
npx dsh-cad-setup --openscad=auto
npx dsh-cad-doctor
npx dsh-cad-backend --show
```

Source checkout (development):

```bash
dsh plugin --profile <profile> add -w /path/to/dsh-cad-harness
cd /path/to/dsh-cad-harness && pnpm install && pnpm run build
node scripts/setup.mjs --openscad=auto
```

`npx dsh-cad-setup --check` reports whether the preset is stale. The package
ships with the CAD skill path omitted on purpose: an absolute path from the
packing machine would be wrong here.

**After a dsh upgrade, run `npx dsh-cad-setup` again and restart.** The preset is
a verbatim copy of dsh's `standard.patch.yml`, and dsh removes or renames internal
rows between releases. A preset mounts as a whole: one stale row and the 「营造模式」
mode does not appear at all — no error, just a missing mode. `npx dsh-cad-doctor`
reports `preset-standard-drift` and names this fix.

## Requirements

- Node.js >= 20
- dsh, with the CAD bundle enabled for the profile
- OpenSCAD on `PATH` (or `CAD_OPENSCAD_BIN`); 2021.01 works but `doctor` reports
  `degraded`; 2025.06+ enables the Manifold backend
- BOSL2 optional, under `lib/BOSL2/` in the source checkout
- Python runtime is provisioned on first use (about 400 MB, not shipped)

## Preview limits

- Export is **risk-annotated**, not an approval: a blocked delivery can be
  exported only after confirmation, with `_UNVERIFIED` in the filename and a
  manifest under the project `exports/` directory.
- Background jobs cover **OpenSCAD compile only**; rendering and simulation are
  still synchronous.
- UI English covers the tab title, environment notices, export dialog and main
  empty states; the deep panel is still mostly Chinese.
- OpenSCAD 2021.01 works but has no Manifold backend; 2025.06+ is recommended.
- OpenSCAD is the default kernel; CadQuery is an optional B-rep pack (about 1.6 GiB, installed explicitly), and FreeCAD remains planned.

## Commands

```bash
node scripts/doctor.mjs --json
node scripts/backend.mjs --show
node scripts/verify-cli.mjs <project> --advisory
node scripts/clean.mjs            # dry-run; --apply to remove stale temp dirs
```

The `dsh-cad-*` binaries are declared in `package.json`; they are on `PATH` when
the package is linked into a profile/tool installation. From an unpacked tarball,
`node scripts/*.mjs` is the reliable form.

## What's new in 0.2.0-preview.1 (unreleased)

- **Measurement**: distance, three-point angle, section area and hole diameter, with a renameable/deletable measurement history that travels with the screenshot.
- **Viewport**: one 「View」 menu with front/back/left/right/top/bottom + iso, perspective↔orthographic, restore/Home; per-part hide/isolate/highlight.
- **Checks**: `run.json` records the request, so manufacturing/assembly can re-run and stress can replay on the current version; missing inputs are refused by name.
- **Fluid**: the flow axis follows the cavity; long runs show progress and can be cancelled; outside particles are pushed back (penetration 7,098→0).
- **Delivery**: audit view in the panel, BOM CSV export, and the risk-annotated export gate.
- `generate` still takes `dryRun` / `preflight`; `cad_check` `sweep` screens a joint range before a motion run; motion supports a `gear` ratio.
- Full notes, evidence and known issues: `docs/dev/RELEASE-NOTES-0.2.0-preview.1.md` in the source repository.

## Documentation

The full user, agent and maintainer docs live in the source repository under
`docs/` (`docs/user/` with English mirrors, `docs/llm/`, `docs/dev/`); the
maintainer docs remain Chinese for this preview.
