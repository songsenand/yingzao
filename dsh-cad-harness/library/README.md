# Standard-parts catalogue — catalog + geometry v0

v0 core: **99 specs / 14 families**, each with a `fit` LOD and a `visual` LOD.
Geometry is generated and committed; the files are self-contained (STEP/STL +
`part.json`), and no CAD kernel is needed to inspect or import them.

## Access status (0.1.1-preview.1)

The catalogue **ships**, but the production tool surface has **no first-class
catalogue action** (`cad_part` is still create/generate/import/merge/role/
appearance). There is no `libRef`/`library.lock`, no list/get/import-by-ID, and
no way for the agent to select `fit` vs `visual` through a tool. Do not describe
the catalogue as a usable API until that entry exists. See `docs/llm/library.md` for the current
facts and the proposed interface.

## File count

- 99 specs × 2 formats = **198 files** if only one LOD is shipped.
- 99 specs × 2 LODs × 2 formats = **396 files** if every visual is distinct.
- Actual v0: **286 geometry files + 99 `part.json` = 385 files**
  - 55 specs use `visual.mode: "alias-fit"` (washers/keys/pins/O-rings/retaining
    rings/collars/set screws): visual points at the fit files, no duplicate.
  - 44 specs have distinct visual geometry (threaded fasteners, bearings,
    springs).
  - 286 = 143 STEP + 143 STL; 143 = 99 fit + 44 distinct visual.

Total size: about **22 MB** in `library/parts`.

## Layout

```text
library/
  catalog.json                 # 99 specs, package + frequency + LOD metadata
  catalog.schema.json          # JSON Schema 2020-12
  parts/<id>/
    fit/model.step
    fit/model.stl
    visual/model.step          # only for distinct visuals
    visual/model.stl
    part.json                  # datums, bbox, volume, generator, hashes
  generator/generate.py        # CadQuery authoring tool (not runtime)
  generator/dimensions.py      # nominal v0 dimension tables
  generator/requirements.txt   # cadquery==2.8.0
```

Every generated spec has `status: "generated"`; `lod.fit.model` and
`lod.visual.model` carry relative paths and SHA-256 hashes. `part.json` carries
the datums and measured bbox/volume.

## What v0 is

- **Core = 99 specs**, under the `core.maxSpecs: 100` budget.
- **fit** is the assembly/contract representation: simplified, nominal
  dimensions, no helical threads, no bearing balls, spring envelope.
- **visual** is display-only: thread relief/chamfers, bearing balls, real spring
  coils; a visual bbox must stay inside the fit envelope.
- **LOD is intended to be chosen by the agent at use time**, not by package membership. That is
  a design target for the future catalogue action, not a capability of 0.1.1-preview.1. When the
  action lands, checks default to fit, rendering to visual; explicit selection wins; a missing
  LOD is an error, not a silent fallback.
- `frequency.source: "assumed"` on every spec. This is an experience baseline,
  not usage data. No score is invented.
- `package` is metadata, never part of the ID: `iso4014.M16x60` is stable;
  `core/iso4014.M16x60` is forbidden.

## Family coverage (v0)

| family | specs | family | specs |
|---|---:|---|---:|
| `iso4014` hex bolt | 16 | `iso15` deep-groove bearing | 6 |
| `iso4762` socket cap | 7 | `iso3601` O-ring | 10 |
| `iso4026` set screw | 5 | `din471` shaft retaining ring | 8 |
| `iso4032` hex nut | 8 | `din6885` parallel key | 7 |
| `iso7040` lock nut | 1 | `iso2338` dowel pin | 5 |
| `iso7089` flat washer | 8 | `din2098` compression spring | 6 |
| `din127` spring washer | 7 | `shaft-collar` | 5 |

M16 sizes cover DN100 ball-valve flanges; DN100 gaskets are left to the optional
`full` bundle because they are application-specific.

## Package movement

The `core` and `full` packages are two **ID lists**, not two copies.

- **full → core (promotion)**: safe; keep the ID, add to core, remove from full.
- **core → full (demotion)**: breaking; major release + alias/deprecation only.
- Core has a soft budget of 100. A promotion can briefly exceed it; do not
  silently demote.
- `full` is currently empty. The optional data bundle will contain only specs
  **not** in core; resolver merges by ID and rejects duplicates.

Frequency data is not collected yet. The eventual ledger should count distinct
projects/assemblies per `libRef`, not raw quantity in one BOM.

## Regenerate

```bash
cd dsh-cad-harness/library/generator
uv pip install --python .venv/bin/python \
  --index-url https://mirrors.aliyun.com/pypi/simple -r requirements.lock
.venv/bin/python generate.py
```

`library/generator/.venv/` is the persistent local build environment (about
1.7 GB, gitignored). It is not needed by the plugin runtime; the generated STEP/STL
are what ship.

The generator deletes `library/parts` and regenerates all 99 specs, then updates
`catalog.json`. It fails if a visual bbox escapes its fit envelope. Nominal
dimensions are in `generator/dimensions.py`; each `part.json` records
`dimensionSource` (v0 is **not** a compliance certificate).

## Validate

```bash
node scripts/accept-library-catalog.mjs
```

Checks: 99/14 counts, core budget, stable IDs, package disjointness,
assumed-frequency labelling, generated fit+visual models, file existence and
SHA-256, visual bbox containment, alias-fit reuse, and the 286 + 99 = 385 file
count.

Optional JSON Schema check:

```bash
python3 - <<'EOF'
import json, jsonschema
schema = json.load(open('library/catalog.schema.json'))
data = json.load(open('library/catalog.json'))
print(len(list(jsonschema.Draft202012Validator(schema).iter_errors(data))))
EOF
```

## Next

1. Resolver/catalog merge + `library.lock`.
2. Optional `full` data bundle built from the same catalog source, excluding core IDs.
3. Replace `frequency.source: "assumed"` only after real usage data exists.
