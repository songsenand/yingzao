---
name: cad-assembly
description: "Assembly contracts: check_assembly's judgement, datums as endpoints, pose vs rotate, undeclared adjacency, stock/imported parts. Full operator/threshold detail: docs/llm/assembly.md."
whenToUse: "Writing or debugging an assembly manifest, declaring datums, checking fit / coaxiality / interference, or reading an assembly-check report."
---

# Assembly contracts: the short rules

Router: `skills/cad-toolbox/SKILL.md` — this file assumes you loaded it.

A green assembly check means the declared interfaces were machine-checked against their operators. It is not a statement that the parts are manufacturable, printable or strong.

## Rules

- **Read `judgement`, not `overallStatus`.** Any `hardViolation` → `excluded`; any `skipped` or `intentFlag` → `difficult` (a skipped check is never a pass); none of those → `not-excluded` (never "ok", never "safe"). `judgedBy` counts them.
- **No `tolerance` → `skipped`, never pass.** Read the `skipped` list before quoting a green verdict.
- **`spring-behaviour` reports facts, not product limits.** It measures installed length, computes deflection/force from `elastic.freeLengthMm` + `elastic.stiffnessNPerMm`, and checks direction, solid height, travel, the force at the travel endpoint (not just the preload), and a slenderness attention. `elastic.standardId` fills missing spring fields from a **curated seed catalog**; explicit fields win, unknown ids are invalid, and the source is reported. See `docs/llm/assembly.md` for what belongs in the catalog. Force carries an **order-of-magnitude band** (`forceDecadeN`, e.g. 18.7 N → 10–100 N) and, when declared, a k-tolerance band. Pass/fail only against the user-declared `elastic.forceBudgetN` / `tolerance` / `elastic.requiredTravelMm`; with no threshold it is `skipped`. Never invent child/adult or product thresholds.
- **`snap-fit` (卡扣) is a beam screening, not a contact sim.** Declare `lobeCount`, `lobeWidthMm`, `lobeThicknessMm`, `leverArmMm`, `radialInterferenceMm`, `youngModulusMPa`; add `leadAngleDeg`/`frictionCoeff` to get insertion force, `maxStrainPct` for strain, `retentionLoadN` for retention. Default output is L1 (headline + worst + `nextLook`); `detail:"checks"` adds the L2 utilization rows. `forceBudgetN` is the **insertion** budget. Complex undercut/self-contact is outside the domain.
- **Alignment uses `"check": "coaxial"` with `datum_axis` / `datum_cyl` endpoints.** Two well-chosen points can pass while a bore is tilted; that is not a coaxial check.
- **A meshing angle is a `pose`, not a whole-part `rotate`.** `"transform": {"pose": {"datum": "<axis>", "angleDeg": -40.1}}` rotates about the part's own datum axis and the datums follow; a whole-part `rotate` swings the D-flat/keyway too.
- **Write the manifest with `write_assembly`, not a generic write or `run_python`.** It validates child versions, datum endpoints, direct-child ownership and `expectedHash`; it does not compute distances or judge fit. `set_datums → write_assembly → check_assembly` is the contract path.
- **`validate_assembly` measures; `check_assembly` judges.** `clearanceThreshold` (default 0.75mm) and `adjacencyThresholdMm` are choices — state them. `interferenceEpsilonMm3` (default 1e-3) separates discretisation residual from a clash.
- **Imported parts have no datums until you declare them.** Use `import_part`'s `datums` or `set_datums` afterwards; `set_datums` in write mode creates a NEW version — point the manifest at the returned id. Stock parts without a version cannot be endpoints.
- **Undeclared adjacency is a manifest gap, not noise.** Declare the interface or move the parts apart.
- **`preflight` runs the assembly job and, when `pearl-profile.json` exists, the six-pearl gate.** It still is not a substitute for a deliberate `check_assembly` when you are testing a BOM change; a claim with no fresh check comes back as `claim-without-evidence`.

Full document shape, the operator list, threshold details and the traps: `docs/llm/assembly.md`.
