---
name: cad-assembly
description: "Depth for the assembly contract machinery: check_assembly's five operators, validate_assembly's per-pair interference, datums as interface endpoints, pose vs transform for a meshing angle, undeclared adjacency, and stock parts. Explains what a manifest can and cannot prove, and why an interface COUNT is not evidence."
whenToUse: "Writing or debugging an assembly manifest, declaring datums, checking fit / coaxiality / interference, or reading an assembly-check report."
---

# Assembly contracts: datums, fit, and what a manifest proves

Router: `skills/cad-toolbox/SKILL.md` — this file assumes you loaded it.

A green assembly check means the declared interfaces were machine-checked against their operators. It is not a statement that the parts are manufacturable, printable or strong.

## The document shape: do not guess it — the validator prints it

The manifest is a contract with a published schema (`schemas/assembly-manifest.schema.json`).
An invalid document is rejected with **path-addressed issues** (`/root/kind: expected "assembly",
got ...`) plus a **minimal valid example** and the endpoint syntax. When that happens, fix the
named path; do not try another shape.

The minimum that parses (same as the example in every validation error):

```json
{
  "schemaVersion": 1,
  "name": "example",
  "unit": "mm",
  "up": "z",
  "root": {
    "id": "machine",
    "kind": "assembly",
    "children": [
      { "id": "base", "name": "底座", "kind": "part", "version": "v001" },
      { "id": "beam", "name": "横梁", "kind": "part", "version": "v002",
        "transform": { "translate": [0, 0, 50] } }
    ],
    "interfaces": [
      { "id": "I1", "a": "base.V轴", "b": "beam.刀口",
        "type": "转动副", "severity": "hard", "check": "coaxial",
        "tolerance": { "min": -0.05, "max": 0.05 } }
    ]
  }
}
```

Four facts the shape does not make obvious:

- the node discriminator is `kind` (`"assembly"` | `"part"`), **not** `type`;
- interfaces sit on the node whose **DIRECT** children they connect (`root.interfaces`), and an
  endpoint is `"<childId>.<datumName>"` — a dot, not `:` or `/`;
- `tolerance: {min,max}` is the pass/fail criterion — **no tolerance means skipped, never pass**;
- a part node names its version with `version` (e.g. `"v003"`), or `source: "stock"` if it has no
  geometry.

## Where this sits in the delivery discipline (updated 2026-10-20)

`check_assembly` is a **delivery tool**: `validate_assembly` measures, this one judges against
the contract. Read its **`judgement`**, not `overallStatus`:

| what happened | judgement |
|---|---|
| any `hardViolation` | **excluded** — a witness contradicts the contract |
| any `skipped` or `intentFlag` | **difficult** — an interface nobody evaluated, or a soft signal. A skipped check is exactly "unevaluable" and never a pass |
| none of the above | **not-excluded** — no counter-example; never "ok", never "safe" |

`judgedBy` breaks those counts down so the reader does not have to re-count the arrays.

**`preflight` does not orchestrate this yet** (its contract evaluation lives inside the tool
closure; extracting it is gated on this lane being quiet). Until then: run `check_assembly`
yourself and declare the result as an `assembly` claim to `delivery_audit` / `preflight` —
a claim with no fresh check comes back as `claim-without-evidence`, which is the gate
working, not an error.

## Facts that are not obvious from the tool descriptions

- **`check_assembly` machine-checks five operators.** `distance` (point datums)
  and `diameter-match` (`datum_cyl`) are pure geometry. `coaxial` measures the
  offset between two axis datums (line-to-line) and flags non-parallel axes —
  the operator for "these two bores line up". `motion-clearance`
  evaluates the static distance AND records whether motion was evidenced, so
  cite the run that proved it: `"params": {"runId": "r020"}` — a cited run that
  is missing, not a motion run, or not passing turns the interface into a
  hard-violation. `spring-preload` computes force = stiffness × (free length −
  measured installed length), so it needs `params.freeLengthMm` and
  `params.stiffnessNPerMm` and the spring's **own two ends** as `a` and `b`.
  Anything else is reported as `skipped` — and the skip text says what would make
  it checkable. Do not read a green verdict as "everything in the manifest was
  verified"; read the `skipped` list.
- **A meshing angle is a `pose`, not a `transform`.** A part that must sit at a
  engagement/tooth phase (gear in its rack, cam on its lobe) gets
  `"transform": {"pose": {"datum": "<axis datum>", "angleDeg": -40.1}}` in the
  manifest node: the part rotates about its OWN datum axis and the datums follow.
  A whole-part `rotate` would also swing the D-flat, the keyway and every anchor
  with it — microscope3 rejected that route for exactly that reason.
  `validate_assembly` parts accept the same `pose` argument.
- **A threshold is a choice, so the report states it.** `validate_assembly`'s
  `clearanceThreshold` (default 0.75mm) decides what counts as "too tight", and
  `check_assembly`'s `adjacencyThresholdMm` decides what counts as "near" in the
  undeclared-pair discovery. A 1.0mm deliberate gap is invisible at 0.75: raise
  the threshold when the design keeps clearance gaps you want listed, and say
  which threshold a verdict came from. Printed threads polygonise: a sub-µm³
  interference residual is discretisation, and `interferenceEpsilonMm3`
  (default 1e-3) tells `validate_assembly` where residual ends and clash begins.
- **An imported part has no datums until you declare them.** Generated parts get
  them from `datum()` / `datum_cyl()` in their SCAD; an STL carries none, so
  either `import_part`'s `datums` argument or `set_datums` afterwards makes the
  part an interface endpoint. `set_datums` in write mode creates a NEW version
  (the mesh is copied, not changed) — point the manifest at the returned id.
  Without either, the part is still fully measurable and assemblable, just not
  *addressable* by `check_assembly`.
- **Stock (purchased) parts without a version cannot be interface endpoints**:
  they have no geometry to measure. Their influence has to be folded into the
  datums of the parts that surround them, and that assumption should be written
  down where a human will see it. **This stops applying the moment you import the
  part** — an imported part has a version, so it is checked like any other.
- **Undeclared adjacency is a feature, not noise.** A warning about a
  near-touching pair that is not in any interface means the manifest has a gap:
  either declare the interface or move the parts apart. It is the one check that
  catches what nobody thought to declare.

## Traps that have cost real iterations

- **A coaxial claim checked as two points is not checked.** Two well-chosen
  points pass while one bore is tilted. Interfaces about alignment use
  `"check": "coaxial"` with `datum_axis`/`datum_cyl` endpoints — it measures
  axis-to-axis offset AND flags non-parallel axes.
