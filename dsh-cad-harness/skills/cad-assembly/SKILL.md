---
name: cad-assembly
description: "Assembly contracts: assembly-check judgement, datums as endpoints, pose vs rotate, undeclared adjacency, stock/imported parts. Full operator/threshold detail: docs/llm/assembly.md."
whenToUse: "Writing or debugging an assembly manifest, declaring datums, checking fit / coaxiality / interference, or reading an assembly-check report."
---

# Assembly contracts: the short rules

Router: `skills/cad-toolbox/SKILL.md` — this file assumes you loaded it.

A green assembly check means the declared interfaces were machine-checked against their operators. It is not a statement that the parts are manufacturable, printable or strong.

## Kickoff alignment (before the first part)

Three questions, once, then record the answers in `assembly.json` → `brief`:

1. **Buy vs make** — gears, bearings, springs, motors, fasteners. Propose a default list; never assume "we machine/print everything".
2. **Allowed processes** — a SET the user permits (FDM / sheet metal / CNC / moulding), multi-select. The user allows the set; **you** pick per part and state which part got which.
3. **What "working" means** — assembly / motion / strength. This decides which runs the delivery must carry.

Each entry carries `by: "user"` or `by: "assumed"`; `cad_deliver` (`action: "audit"`) prints the assumed ones. Unasked assumptions are how a delivery drifts from the brief.

A constraint YOU inferred ("this process can't do X") is a question, not a premise: name what it eliminates before letting it eliminate anything.

## Rules

- **Read `judgement`, not `overallStatus`.** Any `hardViolation` → `excluded`; any `skipped` or `intentFlag` → `difficult` (a skipped check is never a pass); none of those → `not-excluded` (never "ok", never "safe"). `judgedBy` counts them.
- **No `tolerance` → `skipped`, never pass.** Read the `skipped` list before quoting a green verdict.
- **`spring-behaviour` reports facts, not product limits.** It measures installed length, computes deflection/force from `elastic.freeLengthMm` + `elastic.stiffnessNPerMm`, and checks direction, solid height, travel, the force at the travel endpoint (not just the preload), and a slenderness attention. `elastic.standardId` fills missing spring fields from a **curated spring seed catalog** (one pen spring), not the 99-item `library/` standard-parts catalogue; explicit fields win, unknown ids are invalid, and the source is reported. See `docs/llm/assembly.md` and `docs/llm/library.md` for the distinction. Force carries an **order-of-magnitude band** (`forceDecadeN`, e.g. 18.7 N → 10–100 N) and, when declared, a k-tolerance band. Pass/fail only against the user-declared `elastic.forceBudgetN` / `tolerance` / `elastic.requiredTravelMm`; with no threshold it is `skipped`. Never invent child/adult or product thresholds.
- **`snap-fit` (卡扣) is a beam screening, not a contact sim.** Declare `lobeCount`, `lobeWidthMm`, `lobeThicknessMm`, `leverArmMm`, `radialInterferenceMm`, `youngModulusMPa`; add `leadAngleDeg`/`frictionCoeff` to get insertion force, `maxStrainPct` for strain, `retentionLoadN` for retention. Default output is L1 (headline + worst + `nextLook`); `detail:"checks"` adds the L2 utilization rows. `forceBudgetN` is the **insertion** budget. Complex undercut/self-contact is outside the domain.
- **Alignment uses `"check": "coaxial"` with `datum_axis` / `datum_cyl` endpoints.** Two well-chosen points can pass while a bore is tilted; that is not a coaxial check.
- **A meshing angle is a `pose`, not a whole-part `rotate`.** `"transform": {"pose": {"datum": "<axis>", "angleDeg": -40.1}}` rotates about the part's own datum axis and the datums follow; a whole-part `rotate` swings the D-flat/keyway too.
- **Write the manifest with `cad_assembly` (`action: "write"`), not a generic write or `cad_python` (`action: "run"`).** It is the only write entry: the contract is sealed, every write needs a non-empty `reason` and the current `expectedRevision` (0 for `create`), and a generic write/edit to `assembly/assembly.json` is refused. It validates child versions, datum endpoints and direct-child ownership, returns a `diff` + `changeId`, and does not compute distances or judge fit. `cad_assembly` actions `datums` → `write` → `check` is the contract path. A direct edit is rejected by the seal; `dsh-cad-contract rebuild` restores the last recorded revision.
- **Batch the visual review.** `cad_see` (`action: "review"`) takes `items: [{versionId, note}]`; one call for the delivered BOM is the same evidence as N calls. Use it when the audit asks for visual review, not per part as you go.
- **`cad_assembly` (`action: "validate"`) measures; `cad_assembly` (`action: "check"`) judges.** `clearanceThreshold` (default 0.75mm) and `adjacencyThresholdMm` are choices — state them. `interferenceEpsilonMm3` (default 1e-3) separates discretisation residual from a clash.
- **Before a motion run, screen the declared sweep.** `cad_check` (`action: "sweep"`) takes one moving version, the static versions, and a declared joint range (revolute degrees / prismatic mm). It uses a continuous swept AABB envelope, closest-point clearance samples and adaptive refinement, and returns `collision` / `suspect` / `uncovered` / `clean` per pair. **It is a screen, not a verdict**: a positive clearance is not a pass, and `uncovered` means the sample budget ran out before the target arc step (never read it as clean). Follow with `cad_simulate` (`action: "motion"`) for the pass/fail timeline.
- **Imported parts have no datums until you declare them.** Use `cad_part` (`action: "import"`)'s `datums` or `cad_assembly` (`action: "datums"`) afterwards; `cad_assembly` (`action: "datums"`) in write mode creates a NEW version — point the manifest at the returned id. A stock part **with** a version is an ordinary part (checked, and an endpoint); a stock part **without** one is BOM-only and cannot be an endpoint.
- **`features` are check-only.** Declare `hole-pattern` (`axis`, `centerMm`, `pcdMm`, `count`, `diameterMm`, optional `toleranceMm`/`through`) on a part; `cad_assembly` (`action: "check"`) verifies it against the version mesh and never generates geometry from it. A missing/off-PCD/wrong-diameter/not-through hole is a feature failure; a BOM-only stock feature is `skipped`, not passed. v1 reads holes on **planar faces** and checks count/PCD/diameter/axis/through — **not angular spacing**; a curved-surface opening is outside v1.
- **Undeclared adjacency is a manifest gap, not noise.** Declare the interface or move the parts apart.
- **`cad_deliver` (`action: "preflight"`) runs the assembly job and, when `pearl-profile.json` exists, the six-pearl gate.** It still is not a substitute for a deliberate `cad_assembly` (`action: "check"`) when you are testing a BOM change; a claim with no fresh check comes back as `claim-without-evidence`.

Full document shape, the operator list, threshold details and the traps: `docs/llm/assembly.md`.
