---
name: cad-simulation
description: "Simulation engines in short: motion (kinematics + interference), physics (rigid bodies + gravity), fluid (fixed-boundary MPM), LBM (lattice channel), stress (linear-elastic, the only one with a force). Full model boundaries: docs/llm/engines.md."
whenToUse: "Before running any `cad_simulate` action, or when asked whether a mechanism moves, topples, holds under friction, fills with fluid, or what the velocity profile in a duct looks like."
---

# Simulation: the short rules

Router: `skills/cad-toolbox/SKILL.md` — this file assumes you loaded it.

**A run is a VISUAL artifact: the panel plays its `trajectory.json` (pause, scrub, event markers, chart) — that is how motion is shown. An image is a snapshot; never export a GIF or frame sequence.** The reply carries `runId` + `playback`.

Motion is kinematics + an exact interference timeline; physics is rigid bodies under gravity; fluid is a fixed-boundary MPM; LBM is a lattice channel (box walls, no embedded solids); stress is linear-elastic. **None of the first four reports a force; stress does, but it is not a safety factor.**

## Motion (`cad_simulate` action `motion`)

- **Pivot, not world origin.** The tool re-bases each part on a pivot (default: the first joint's anchor naming it, else the geometry centre) and reports `pivots`. Pass `pivot` only when the axis passes through neither.
- **Anchors are measured before stepping.** A joint gap > 2mm is refused, naming the joint and both anchors; `initialJointGaps` / `jointToleranceMm` are in the reply. Do not widen the tolerance.
- **A joint between differently-oriented bodies needs per-body axes.** `axis` is one local vector for both and only right for parallel frames; use `axisA`/`axisB`, or `axisWorld` (resolved to each body). r001's 105mm drift was file-frame anchors + a single axis, not a closed-loop impossibility.
- **Coverage is part of the verdict.** At least 24 sampled poses and the final pose; `interferenceChecks` / `samplingSatisfied` / `maxSampleGapDeg` are reported. **0 checks is not 0 collisions.**
- **Revolute-jointed pairs are excluded by default** (a bearing is designed to overlap). Turn on `scanJointPairs: true` to put them in the timeline: overlap inside a declared `overlapEnvelope` + `fit` is listed as a fit and `jointFitsUnresolved` gates the run; overlap outside is interference. Every event carries `overlapBboxMm` (min/max XYZ), so a swept clash can be located without replaying the run.
- **A gear is a ratio coupling, not a contact result.** `joints: [{ type: 'gear', bodyA, bodyB, ratio, axisA, axisB }]` prescribes turns of B per turn of A (signed; external mesh = −z_A/z_B). It needs no anchors, is exact/timestep-independent, transfers no torque, and `metrics.gears` reports declared vs measured. Unlike physics, the pair is **not** contact-disabled here: it stays in the interference timeline ("do the teeth collide at this ratio"). "Do the teeth actually drive it" is still a contact run without the gear joint. `cycles` accepts fractions.
- No gravity. A rack is driven by `pitchRadiusMm`, never a sinusoid; `phaseRad` offsets by `r × phaseRad`.
- **`drive` is kinematic: it prescribes a crank angle and resolves no contact force.** It answers "does the linkage collide / how far does it travel", never "can a motor carry this load" — that is `cad_simulate` (`action: "physics"`) with `motor`.
- **A crank is not required.** `drive` is optional: when every mover is an `oscillator` (a guide/valve on a prescribed path) the time base is the oscillator period and the reply says `hasCrank: false`. Only "no drive AND no oscillator" is refused (nothing would move).
- **Geometry sanity is a fact, not a verdict.** A part whose gap to the nearest part ÷ its own bbox diagonal > 5 is listed as 离群; ≤24 triangles is listed as 简单盒体. Neither changes pass/fail, but a non-empty `geometrySuspects` means "interference 0" may have proven nothing (two dummies parked 500mm away). The rule travels with the result as `geometrySuspectRule`.
- **`closedLoop` is a fact, not a verdict.** `loopJoints` names the edges that close a cycle (union-find); a tree is false/[] and the Roberval balance is true/2. A closed loop can pass.

## Physics (`cad_simulate` action `physics`)

- **`tiltDeg` for slopes**, not a hand-built gravity vector; `gravity` only when tiltDeg cannot say it.
- **"Will it hold?" is `staticFriction`**, not the solver: give the prismatic joint `staticFriction: μ` and read the analytic hold analysis; without it the slider always falls.
- A prismatic joint is checked across its axis only; sliding along it is the joint working.
- **Contact model: concave dynamic parts use their EXACT mesh, convex parts a hull.** A single hull fills a fork/cavity and reports phantom penetration (r002: 12,140mm³ at each hinge where the real overlap was 0). `colliders` says which shape each body got.
- **Jointed pairs do not collide by default.** A bearing is designed to overlap in clearance; `contactsDisabled` lists the pairs. `jointContacts: true` is the explicit opt-in for a stopper that really must collide on that pair.
- **t=0 is gated.** A joint anchor gap > 2mm is REFUSED with both world anchors (`initialJointGaps`), never warmed up. Same rule as motion.
- **A joint between differently-oriented bodies needs per-body axes (and anchors).** `axis` is one local vector for both and is only correct for parallel frames; use `axisA`/`axisB`, or `axisWorld` (resolved to each body), and prefer `anchorWorld` over hand-converted local anchors. A bare `axis` on a [90,0,0]-rotated beam is how the Roberval frame got twisted.
- **Topple is relative to the authored pose**, not world up: a beam authored at 90° is not "toppled" at t=0. 30° labels the event, 60° sets `fellOver`.
- **A mechanism that is supposed to RUN needs a `motor`.** Without one the only input is `initialAngularVelocity` — an impulse, not a drive — so it coasts, spends the backlash (0.056mm in the reducer) and stops on the first tooth face; six keyframes then show one pose. Read that as "nothing drove it", never as "it slips". `motor: { targetVelocityRadPerSec, maxTorqueNm }` on a revolute joint drives it and keeps driving; `metrics.motors` echoes commanded vs measured (`measuredRadPerSec`, `turnedDeg`, `reachedTarget`), so a stall is a number, and a stall note appears in `notes`.
- **A gear ratio is a CONSTRAINT, not a contact result.** `joints: [{ type: 'gear', bodyA, bodyB, ratio, axisA, axisB }]` prescribes turns of B per turn of A (signed; external mesh = −z_A/z_B, a 12:1 worm = −1/12). It is exact and timestep-independent because it is not solved — `metrics.gears` prints the ratio the run produced and it will equal the one you asked for. Two things it is NOT: it transfers no torque (a slipping mesh is out of scope), and its pair does not collide (that is why it is listed in `contactsDisabled`). "Do the teeth actually drive it" is a contact run WITHOUT the gear joint; "do they collide at this ratio" is the interference timeline of `cad_simulate` (`action: "motion"`).
- **Declare `friction` — the default 0.5 is a number nobody chose.** It is per part, and it is echoed in `metrics.frictions`. A single-start worm (lead 7.1°) at μ=0.5 has a 26.6° friction angle and is deep in self-locking (η≈19%); POM-on-POM μ≈0.15 is a different machine (η≈40%). Without a declared μ, "it stalls" is a claim about rapier's default, not about your design.
- **`timestepSec` is an input, and 1/60 is only safe for slow contact.** A surface moving v mm/s advances v·dt per step; when that is comparable to the clearance (0.03–0.15mm backlash), the solver resolves teeth as interpenetration. Keep v·dt ≤ clearance/10 — a 20 rad/s shaft on a 4mm pitch radius needs ~1/2000. Steps (and runtime) scale linearly; `stepsRun` tells you what you got.
- **The torque cap is what makes a stall honest.** `maxTorqueNm` is a hard cap in N·m (internally ×1e6 to the mm/mN world). Cap below the load → the drive loses and `reachedTarget:false`; the marginal band is real (a 3 rad/s drive with a 5e-4 N·m cap against a 5.3e-4 N·m pendulum reaches 1.87 rad/s). A cap of 0 or a missing cap is refused: an uncapped motor is not a model of anything.
- **A motor at target 0 is a brake, not a clamp.** It resists but creeps under a constant load (a force-capped velocity servo). For "will it stay put?" use `staticFriction` / `cad_assembly` (`action: "check"`), not a target-0 motor.
- **`closedLoop` / `loopJoints`** are graph facts (union-find), not gates; a closed loop can pass.
- No force/torque output: a motor is an INPUT, not a measurement. For an axial spring's installed/travel-endpoint force, use `spring-behaviour` on `cad_assembly` (`action: "check"`) (a static contract check, not physics).
- **The same geometry-sanity rule runs here** (`geometrySuspects`): a body dropped 500mm from everything reports a penetration number that describes nothing. Same criterion, same "fact, not a gate".

## Fluid (`cad_simulate` action `fluid`)

- Fixed-boundary MPM: flow direction, dead zones, pressure trend. **No fluid–structure coupling**; split into a rigid check + a fluid check, or say the limitation.
- Trend, not industrial CFD.
- **Give `versionId` for a registered solid; `pipeScad` is inline.** `versionId` records provenance and wins when both are given. The output carries `runId`; quote it.
- **Arrival = escaped / initial particles, not a flow split.** Compare against a straight-pipe calibration; `active` particles are still trapped and `mass error` is particle bookkeeping, not a physical conservation proof.

## LBM (`cad_simulate` action `lbm`)

- **Lattice units**, not millimetres: keep `latticeVelocity ≤ 0.1`, state your length/viscosity conversion; compare `metrics.peakUx` to `1.5×latticeVelocity`.
- `overallStatus: developing` → quote shape/symmetry only, not drag/shear, until `developed`; raise `steps` with `reynolds`.
- Stage A has box walls only: no part in the flow, no heat, no free surface. `overallStatus: diverged` is not a partial answer.

## Stress (`cad_simulate` action `stress`)

- **Declare the case** (supports + loads; `loads` is optional when `includeSelfWeight` is true, which is the default). `supports:[{ground:true}]` holds the lowest z face (a held face, not a contact law). `loadCase` reports `gravity` / `service` / `combined`. An unsupported load is refused. `mode`: `judge` (default), `scan` (field, **no verdict**), `both`; `judge` returns `nextLook` where to look.
- **Deliver against `delivery`, not `verdict`**; `unevaluable` is not a pass; `attention` is detection, not evidence.
- **No "largest element stress" and no safety factor** (isotropic; the tiers are a colour scale). Quote `stats.peakAtDeclaredDistanceMPa`; `surfaceExtrapolatedMPa` only when the cross-resolution check passes.
- **`trustworthy` / `whyUntrustworthy` decides what may be quoted**; a member thinner than the voxel comes back `check` with zero trustworthy regions and `meshIndependence: drifting`.
- `excludeFromReport` drops support/load patches; cut sections away from supports and check `M = F·L`.

Full model boundaries, refusal conditions and field semantics: `docs/llm/engines.md`.
