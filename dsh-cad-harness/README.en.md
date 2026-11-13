# dsh-cad-harness (Yingzao / 营造)

Installable half of **Yingzao (营造)**: an LLM-driven CAD harness with a verification
loop (OpenSCAD/Manifold compile + render, layered geometry/assembly/physics/
fluid/process checks, immutable versions, and an evidence policy).

This package is normally installed as a dsh plugin bundle, not imported as a
library.

## Install (preview)

Tarball release (no build; `lib/` is included):

```bash
tar -xzf dsh-cad-harness-0.1.0.tgz
dsh plugin --profile <profile> add -w "$PWD/package"
cd package
node scripts/setup.mjs          # writes this machine's skill path into the preset
node scripts/doctor.mjs         # kind=ok, or an explained degraded
node scripts/backend.mjs --show # kernel=openscad, compileBackend=auto
# restart dsh; then choose the 「营造模式」 preset for a new session
```

Source checkout (development):

```bash
dsh plugin --profile <profile> add -w /path/to/dsh-cad-harness
cd /path/to/dsh-cad-harness && pnpm install && pnpm run build
npm run setup
```

`node scripts/setup.mjs --check` reports whether the preset is stale. The package
ships with the CAD skill path omitted on purpose: an absolute path from the
packing machine would be wrong here.

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
- No second geometry kernel in this preview; CadQuery/FreeCAD are planned.

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

## Documentation

The English preview entry is `README.en.md` (this file). The full user, agent and
maintainer docs live in the repository and remain Chinese for this preview;
`README.md` is the Chinese package entry.
