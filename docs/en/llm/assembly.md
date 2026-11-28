# Assembly contracts: what datums, fits and the manifest can prove

[中文](../../llm/assembly.md) | English
> Long-form reference; short rules live in `skills/cad-assembly/SKILL.md`.

A green assembly check means the declared interfaces were machine-checked against their operators. It is not a statement that the parts are manufacturable, printable or strong.

## Writing the contract: one entry, a reason, and a revision

`assembly/assembly.json` is a **sealed contract**, not a scratch JSON file. The only write
entry is `cad_assembly` (`action: "write"`); generic `write`/`edit`/`apply_patch` to it is
refused by the CAD filesystem policy, and a direct edit made through a shell is rejected by
`assembly/assembly.seal` on the next read.

Every write needs:

- `reason` — why the contract is changing (non-empty; recorded in `assembly/changes/`);
- `expectedRevision` — the current revision (0 for `create`), returned by the previous
  write/check; a stale revision is refused rather than silently overwriting;
- `mode` — `create` / `merge` / `replace`.

`cad_assembly` (`action: "check"`) also returns the current `contractRevision` / `contractHash`; use that revision for the next write.

It returns `changeId`, `contractRevision`, `contractHash` and a structured `diff`
(children/interfaces/root mutations). Use `dryRun: true` to preview the diff without
writing. If a direct edit is detected, run `dsh-cad-contract rebuild` to restore the last
recorded revision, then re-read and write with the current revision. `dsh-cad-contract
verify` checks the seal and the change chain.

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
      { "id": "base", "name": "base", "kind": "part", "version": "v001" },
      { "id": "beam", "name": "beam", "kind": "part", "version": "v002",
        "transform": { "translate": [0, 0, 50] } }
    ],
    "interfaces": [
      { "id": "I1", "a": "base.V-axis", "b": "beam.knife-edge",
        "type": "revolute", "severity": "hard", "check": "coaxial",
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
- a part node names its version with `version` (e.g. `"v003"`). A purchased part is
  `source: "stock"`: with a `version` it has geometry and is checked like any other part; with no
  `version` it is BOM-only and cannot be an endpoint.
- `process` on a part (or on the assembly root as the default) is
  `{id, source: "user" | "policy" | "agent", rationale?, confirmedBy?, confirmedAt?}`. The usual
  path is `source: "policy"`: the project has a top-level
  `manufacturing: {allowed: [{id}], approvedBy, mixApprovedBy?, preference?, delegate?}` — **one
  user decision on the allowed process set**, after which the agent assigns each part from that
  set; `mixApprovedBy` records the second decision (the `M:mix` summary). That is the 0–3 key-node
  model (policy, mix, exceptions), not a per-part confirmation loop. `source: "user"`
  is an explicit per-part decision; `source: "agent"` is a recommendation that needs confirmation
  unless an approved `delegate` policy covers it. An unconfirmed policy/recommendation is
  `unobserved` in `cad_deliver` (`action: "plan"`); it never runs a printability verdict on it. This is the field that
  lets "the user only has an FDM printer" narrow the allowed set once, instead of being asked at
  every part. The id vocabulary and the **supported / partial / planned** status live in
  [`processes.md`](processes.md): `allowed` is the decision space, an evaluator is a separate fact,
  and a planned process is recorded but reported `unobserved`, never a pass.

**Part datums: the version store is the authority.** For a `kind: "part"` endpoint, `a`/`b` resolve
against the datums the version declared (points/axes/planes/cylinders). A node's inline `datums`
array is an optional human hint and is often shorter — do **not** conclude an endpoint is dangling
from the inline list alone. When an endpoint resolves only against the version, `verify` reports
`model.datum-list-drift` as `info`; the model row stays `pass`.

## Kickoff alignment: `brief` (2026-11-14)

Settle three things with the user BEFORE the first part, write them into the root's `brief`,
then model:

- **buyVsMake** — gears, bearings, springs, motors, fasteners: bought or made. The default is to
  ASK, never to assume "make";
- **processes** — the SET of processes the user allows (multi-select: FDM / sheet metal / CNC /
  moulding). The user allows the set; YOU pick per part and record who chose it in that part's
  `process` (`process.source` already carries that provenance);
- **verify** — what "working" means here: assembly / motion / strength. It decides which runs the
  delivery must carry.

Every entry carries `by: "user"` or `by: "assumed"`. `cad_deliver` (`action: "audit"`) lists the assumed ones
(`info`) — an unasked assumption is how a delivery drifts from the brief.

**Part colour**: any child may carry `color` (`#rrggbb`). It is a COMMUNICATION label — not a
material, finish or spec: the panel's assembly view and playback render with it, so you and the
human are naming the same part. A part without `color` keeps the old palette (no invented colour);
reports, tables and contracts never use it. Worth setting when a machine has coaxial compound
gears or mating pairs, which are exactly the parts people misname by colour.

**`verify` is enforced; everything else is a record.** Declaring `motion` / `strength` requires a
FRESH run of that kind citing the newest version, or `cad_deliver` (`action: "audit"`) is `blocked`
(`verify-required-motion` / `verify-required-strength`). **With no `brief` at all**, any
`转动副` / `滑动副` / `弹簧` interface makes `motion` required by derivation (`verify-derived` says
so) — the patch for the wind-up frog shipping with “未测 live simulation” in its README. Narrowing
the scope means the USER writes `brief.verify` (e.g. `["assembly"]`); the audit then prints
`verify-waived`: that is a DECISION, never a pass.

## Where this sits in the delivery discipline (updated 2026-10-20)

`cad_assembly` (`action: "check"`) is a **delivery tool**: `cad_assembly` (`action: "validate"`) measures, this one judges against
the contract. Read its **`judgement`**, not `overallStatus`:

| what happened | judgement |
|---|---|
| any `hardViolation` | **excluded** — a witness contradicts the contract |
| any `skipped` or `intentFlag` | **difficult** — an interface nobody evaluated, or a soft signal. A skipped check is exactly "unevaluable" and never a pass |
| none of the above | **not-excluded** — no counter-example; never "ok", never "safe" |

`judgedBy` breaks those counts down so the reader does not have to re-count the arrays.

**`cad_deliver` (`action: "preflight"`) does not orchestrate this yet** (its contract evaluation lives inside the tool
closure; extracting it is gated on this lane being quiet). Until then: run `cad_assembly` (`action: "check"`)
yourself and declare the result as an `assembly` claim to `cad_deliver` (`action: "audit"`) / `cad_deliver` (`action: "preflight"`) —
a claim with no fresh check comes back as `claim-without-evidence`, which is the gate
working, not an error.

## Facts that are not obvious from the tool descriptions

- **`cad_assembly` (`action: "check"`) machine-checks seven operators.** `distance` is datum-kind
  aware: **plane/plane → perpendicular plane distance** (lateral anchor offset is
  not a gap), **plane/point → point-to-plane**, anything else → point-to-point.
  `diameter-match` (`datum_cyl`) is pure geometry. `coaxial` measures the
  offset between two axis datums (line-to-line) and flags non-parallel axes —
  the operator for "these two bores line up". `motion-clearance`
  evaluates the static distance AND records whether motion was evidenced, so
  cite the run that proved it: `"evidence": {"runId": "r020"}` (legacy
  `"params": {"runId": "r020"}` is still accepted). A cited run that is missing,
  not a motion run, or not passing turns the interface into a hard-violation. `spring-preload` computes force = stiffness × (free length −
  measured installed length), so it needs `params.freeLengthMm` and
  `params.stiffnessNPerMm` and the spring's **own two ends** as `a` and `b`.
  `spring-behaviour` is the richer axial-spring check: it measures the installed
  length and reports deflection, force, direction, solid-height clash, travel,
  and the force at the travel endpoint (not just the installed preload), plus a
  slenderness attention. Its `elastic` object is the general envelope
  (`behavior`, `standardId`, `direction`, `freeLengthMm`, `stiffnessNPerMm`,
  `solidHeightMm`, `outerDiameterMm`, `guided`, `forceBudgetN`,
  `requiredTravelMm`, `stiffnessTolerancePct`, `source`). `standardId` fills only
  fields the manifest did not declare; explicit fields win. It always reports an
  order-of-magnitude band (`forceDecadeN`, e.g. 18.7 N → `[10, 100]`), plus a
  k-tolerance band when `stiffnessTolerancePct` is declared. It compares against
  the **user-declared** `forceBudgetN` / `tolerance` / `requiredTravelMm`; with none of those it comes
  back `skipped`, not passed. When `direction` + `requiredTravelMm` allow it, it
  reports `forceAtTravelN` and checks that endpoint force too — the installed
  preload is not the force at full press. It never invents child/adult or product
  thresholds.
  `standardId` is a **curated spring seed catalogue**, not the 99-item `library/`
  standard-parts catalogue (`docs/en/llm/library.md`): the seed is deliberately small (the
  pen spring is the first entry). An entry is added only for a purchased, reused part with a
  source/tolerance; self-designed flexures stay formula/family checks; a one-off stays
  `skipped` + agent.
  Explicit manifest fields win; an unknown id is a validation error, never a
  silent fallback.
  `snap-fit` is the **snap-fit** operator: `lobeCount`, `lobeWidthMm`,
  `lobeThicknessMm`, `leverArmMm`, `radialInterferenceMm`, `youngModulusMPa`,
  optional `leadAngleDeg` / `frictionCoeff` / `retentionAngleDeg`, and the
  user-declared `forceBudgetN` (insertion) / `maxStrainPct` / `retentionLoadN`.
  It reports a beam-model radial force, wedge-model insertion force, root strain
  and self-lock; its default output is one headline + worst + `nextLook`, with
  the L2 utilization rows behind `detail: "checks"`. The beam model is an
  upper-bound estimate, not a contact simulation; complex undercuts/self-contact
  are outside its domain. Anything else is reported as `skipped` — and the skip
  text says what would make it checkable. Do not read a green verdict as
  "everything in the manifest was verified"; read the `skipped` list.
- **A meshing angle is a `pose`, not a `transform`.** A part that must sit at a
  engagement/tooth phase (gear in its rack, cam on its lobe) gets
  `"transform": {"pose": {"datum": "<axis datum>", "angleDeg": -40.1}}` in the
  manifest node: the part rotates about its OWN datum axis and the datums follow.
  A whole-part `rotate` would also swing the D-flat, the keyway and every anchor
  with it — microscope3 rejected that route for exactly that reason.
  `cad_assembly` (`action: "validate"`) parts accept the same `pose` argument.
- **A threshold is a choice, so the report states it.** The `clearanceThreshold` of
  `cad_assembly` (`action: "validate"`) (default 0.75mm) decides what counts as "too tight", and
  `adjacencyThresholdMm` on `cad_assembly` (`action: "check"`) decides what counts as "near" in the
  undeclared-pair discovery. A 1.0mm deliberate gap is invisible at 0.75: raise
  the threshold when the design keeps clearance gaps you want listed, and say
  which threshold a verdict came from. Printed threads polygonise: a sub-µm³
  interference residual is discretisation, and `interferenceEpsilonMm3`
  (default 1e-3) tells `cad_assembly` (`action: "validate"`) where residual ends and clash begins.
- **An imported part has no datums until you declare them.** Generated parts get
  them from `datum()` / `datum_cyl()` in their SCAD; an STL carries none, so
  either the `datums` argument of `cad_part` (`action: "import"`) or `cad_assembly` (`action: "datums"`) afterwards makes the
  part an interface endpoint. `cad_assembly` (`action: "datums"`) in write mode creates a NEW version
  (the mesh is copied, not changed) — point the manifest at the returned id.
  Without either, the part is still fully measurable and assemblable, just not
  *addressable* by `cad_assembly` (`action: "check"`).
- **Stock (purchased) parts WITH a version are ordinary parts.** Give the node a
  version (import, library release, or a copied vendor model) and it is measured,
  checked for interference and usable as an interface endpoint — `source:
  "stock"` only marks it purchased (no printability/process expectations). A
  stock part **without** a version is BOM-only: no geometry, no endpoint.
- **`features` are CHECK-ONLY declarations.** v1 supports `hole-pattern`:
  `{kind:"hole-pattern", axis:[x,y,z], centerMm:[x,y,z], pcdMm, count,
  diameterMm, toleranceMm?, through?}` on a part node. `cad_assembly` (`action: "check"`) compares
  the declaration with the version's mesh via `cad_inspect` (`action: "features"`) and reports
  missing/off-PCD/wrong-diameter/not-through holes; it **never generates
  geometry** from the declaration. A BOM-only stock part's feature is
  `skipped`, not passed, and a skipped feature makes the judgement `difficult`.
  v1 matches holes that `cad_inspect` (`action: "features"`) reports on **planar faces**; it checks
  count / PCD / diameter / axis / through, **not angular spacing**. A hole whose
  opening is on a curved surface is outside v1, and an even angular distribution
  still needs a datum/coaxial interface if orientation matters.
- **Undeclared adjacency is a feature, not noise.** A warning about a
  near-touching pair that is not in any interface means the manifest has a gap:
  either declare the interface or move the parts apart. It is the one check that
  catches what nobody thought to declare.

## Traps that have cost real iterations

- **A coaxial claim checked as two points is not checked.** Two well-chosen
  points pass while one bore is tilted. Interfaces about alignment use
  `"check": "coaxial"` with `datum_axis`/`datum_cyl` endpoints — it measures
  axis-to-axis offset AND flags non-parallel axes.

- **“Process X can only do Y” is a constraint to confirm, not a conclusion.** The
  reducer session never asked about purchased parts or which processes were allowed,
  and took “FDM, therefore a worm drive” as a premise — the design space was narrowed
  silently and only surfaced as rework. A constraint you inferred has to name what it
  eliminates and hand the options back to the user; `brief.processes` records the SET
  the user allows, not one process.

## Early sweep screen (2026-11-25)

- **`cad_check` (`action: "sweep"`) is the pre-motion screen.** Give one moving
  version, the static versions, and a declared joint range (`revolute` degrees or
  `prismatic` mm). It computes a continuous swept AABB envelope, then closest-point
  clearance samples, and refines only where clearance is below `2×minFeatureMm` until
  the arc step is `<= minFeatureMm/2` or `maxSamples` is exhausted.
- **It returns `collision` / `suspect` / `uncovered` / `clean`, not a delivery
  verdict.** `uncovered` means the budget ran out before the target arc step; never
  read it as clean. A positive clearance is not a pass.
- **The declared range is the assumption.** If the real linkage swings less, the
  screen can be conservative; if it swings more, the screen proves nothing. State the
  range, then run `cad_simulate` (`action: "motion"`) for the pass/fail timeline.

## Interface suggestions (`cad_assembly` action `suggest`, 2026-11-25)

The assembly check reports “52 undeclared” but not which datums to use, so every contact had to be hand-written. `suggest` runs the same adjacency pass, reads each part's datums, and proposes **ready-to-edit interface templates**: a distance interface with the measured gap and a symmetric tolerance.

- The template is a starting point: it uses the first point datum (or first axis/plane/cylinder) on each part, so review the chosen datums.
- It **never writes the contract**; write through `cad_assembly` action `write`.
- `skipped` names pairs it could not template (missing datums, etc.), not passes.
- Threshold defaults to 0.75 mm; `maxSuggestions` defaults to 20 (max 60).
