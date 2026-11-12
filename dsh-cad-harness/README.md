# dsh-cad-harness

Installable half of **ToyMarker**: an LLM-driven CAD harness with a verification
loop (OpenSCAD/Manifold compile + render, layered geometry/assembly/physics/
fluid/process checks, immutable versions, and an evidence policy).

This package is normally installed as a dsh plugin bundle, not imported as a
library.

## Install (preview)

```bash
dsh plugin --profile <profile> add -w /path/to/dsh-cad-harness
npx dsh-cad-setup          # writes this machine's skill path into the preset
# restart dsh; then choose the 「造物模式」 preset for a new session
```

`npx dsh-cad-setup --check` reports whether the preset is stale. The package
ships with the CAD skill path omitted on purpose: an absolute path from the
packing machine would be wrong here.

## Requirements

- Node.js >= 20
- dsh, with the CAD bundle enabled for the profile
- OpenSCAD on `PATH` (or `CAD_OPENSCAD_BIN`); 2025.06+ enables the Manifold backend
- BOSL2 optional, under `lib/BOSL2/` in the source checkout
- Python runtime is provisioned on first use (about 400 MB)

## Documentation

The user guide, Agent reference, and maintainer notes live in the source
repository under `docs/` (`docs/user/`, `docs/llm/`, `docs/dev/`). This tarball
keeps the package-local `docs/` (tool contracts) so the bundle is inspectable.

## License

Apache-2.0. Third-party notices are in the repository `NOTICE`.
