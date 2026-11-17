# Standard parts library — catalog v0

This directory is the **data-only** v0 of the standard-parts library. It contains
the 99-spec core selection and its schema; **no STEP/STL geometry is generated
yet**. Members with `status: "planned"` and `model: null` are the contract for
the next generator step.

## Layout

```text
library/
  catalog.json            # 99 core specs; package + frequency + LOD metadata
  catalog.schema.json     # JSON Schema 2020-12
  README.md
```

## What v0 is

- **Core = 99 specs / 14 families**, under the `core.maxSpecs: 100` budget.
- Every spec carries both LOD slots:
  - `fit` — contract/fit geometry (simplified; not generated yet);
  - `visual` — render geometry (not generated yet), or `alias-fit` where the
    visual model would add nothing (washers, keys, pins, O-rings, retaining
    rings).
- `frequency.source: "assumed"` on every spec. **This is an experience
  baseline, not usage data.** No `score` is invented.
- `package` is metadata, never part of the ID:
  - `iso4014.M16x60` is stable;
  - `core/iso4014.M16x60` is forbidden.
- No geometry paths exist before generation. Do not add fake hashes or empty
  model files.

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

The M16 sizes are included for DN100 ball-valve coverage; DN100 gaskets are
deliberately left to the optional `full` bundle because they are
application-specific.

## Package movement

The `core` and `full` packages are two **ID lists**, not two copies of a part.

- **full → core (promotion)**: safe. Keep the ID; add it to core and remove it
  from full. Existing assemblies keep resolving.
- **core → full (demotion)**: breaking. Only in a major release, with an alias
  or deprecation window, because users without `full` would lose the part.
- Core has a soft budget of 100. A promotion can briefly exceed it; rebalance
  in the next release, and do not silently demote.
- `full` is currently empty. The optional data bundle will contain only specs
  **not** in core; the resolver merges by ID and rejects duplicates.

## Frequency data

`frequency` is reserved for real usage data. The eventual resolver can write a
local, opt-in ledger keyed by `libRef` and project hash; do not upload geometry.
Until then, every entry stays `assumed`.

Ranking should count **distinct projects/assemblies**, not raw quantity in one
BOM, and should preserve family coverage and mating sets.

## LOD selection

The library exposes both LODs; the agent chooses at use time. The library does
not declare one LOD universally authoritative:

- checks/measurement default to `fit`;
- rendering/screenshots default to `visual`;
- an explicit `lod` wins;
- a missing requested LOD is an error listing the available LODs, not a silent
  fallback;
- using `visual` for a contract check is allowed but must be reported as
  render-only, not as fit evidence.

## Validation

```bash
cd dsh-cad-harness
node scripts/accept-library-catalog.mjs
```

The script checks the 99/14 counts, core budget, stable IDs, package
disjointness, assumed-frequency labelling, fit/visual presence and the
"no geometry yet" state.

JSON Schema validation (optional, requires Python `jsonschema`):

```bash
python3 - <<'EOF'
import json, jsonschema
schema = json.load(open('library/catalog.schema.json'))
data = json.load(open('library/catalog.json'))
print(len(list(jsonschema.Draft202012Validator(schema).iter_errors(data))))
EOF
```

## Next

1. Generate the 99 core specs (fit + visual) with CadQuery; fill `model` and
   `status: "generated"` only after validation.
2. Add the resolver/catalog merge and `library.lock` (no runtime CAD kernel).
3. Build the optional `full` data bundle from the same catalog source; full
   excludes core IDs.
4. Replace `frequency.source: "assumed"` with observed data only after real
   project usage.
