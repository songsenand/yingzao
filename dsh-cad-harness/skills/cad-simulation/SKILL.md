---
name: cad-simulation
description: "Simulation engines in short: motion (kinematics + interference), physics (rigid bodies + gravity), fluid (fixed-boundary MPM), LBM (lattice channel), stress (linear-elastic, the only one with a force). Full model boundaries: docs/llm/engines.md."
whenToUse: "Before running any simulate_* tool, or when asked whether a mechanism moves, topples, holds under friction, fills with fluid, or what the velocity profile in a duct looks like."
---

# Simulation: the short rules

Router: `skills/cad-toolbox/SKILL.md` — this file assumes you loaded it.

Motion is kinematics + an exact interference timeline; physics is rigid bodies under gravity; fluid is a fixed-boundary MPM; LBM is a lattice channel (box walls, no embedded solids); stress is linear-elastic. **None of the first four reports a force; stress does, but it is not a safety factor.**

## Motion (`simulate_motion`)

- **Pivot, not world origin.** The tool re-bases each part on a pivot (default: the first joint's anchor naming it, else the geometry centre) and reports `pivots`. Pass `pivot` only when the axis passes through neither.
- **Anchors are measured before stepping.** A joint gap > 2mm is refused, naming the joint and both anchors; `initialJointGaps` / `jointToleranceMm` are in the reply. Do not widen the tolerance.
- **Coverage is part of the verdict.** At least 24 sampled poses and the final pose; `interferenceChecks` / `samplingSatisfied` / `maxSampleGapDeg` are reported. **0 checks is not 0 collisions.**
- **Overlap between a revolute-jointed pair is not reported** (it is a bearing); a stopper on exactly that pair must be verified another way. `cycles` accepts fractions.
- No gravity. A rack is driven by `pitchRadiusMm`, never a sinusoid; `phaseRad` offsets by `r × phaseRad`.
- **A crank is not required.** `drive` is optional: when every mover is an `oscillator` (a guide/valve on a prescribed path) the time base is the oscillator period and the reply says `hasCrank: false`. Only "no drive AND no oscillator" is refused (nothing would move).
- **Geometry sanity is a fact, not a verdict.** A part whose gap to the nearest part ÷ its own bbox diagonal > 5 is listed as 离群; ≤24 triangles is listed as 简单盒体. Neither changes pass/fail, but a non-empty `geometrySuspects` means "interference 0" may have proven nothing (two dummies parked 500mm away). The rule travels with the result as `geometrySuspectRule`.

## Physics (`simulate_physics`)

- **`tiltDeg` for slopes**, not a hand-built gravity vector; `gravity` only when tiltDeg cannot say it.
- **"Will it hold?" is `staticFriction`**, not the solver: give the prismatic joint `staticFriction: μ` and read the analytic hold analysis; without it the slider always falls.
- A prismatic joint is checked across its axis only; sliding along it is the joint working.
- No force/torque output.
- **The same geometry-sanity rule runs here** (`geometrySuspects`): a body dropped 500mm from everything reports a penetration number that describes nothing. Same criterion, same "fact, not a gate".

## Fluid (`simulate_fluid`)

- Fixed-boundary MPM: flow direction, dead zones, pressure trend. **No fluid–structure coupling**; split into a rigid check + a fluid check, or say the limitation.
- Trend, not industrial CFD.

## LBM (`simulate_lbm`)

- **Lattice units**, not millimetres: keep `latticeVelocity ≤ 0.1`, state your length/viscosity conversion; compare `metrics.peakUx` to `1.5×latticeVelocity`.
- `overallStatus: developing` → quote shape/symmetry only, not drag/shear, until `developed`; raise `steps` with `reynolds`.
- Stage A has box walls only: no part in the flow, no heat, no free surface. `overallStatus: diverged` is not a partial answer.

## Stress (`simulate_stress`)

- **Declare the case** (supports + loads; `loads` is optional when `includeSelfWeight` is true, which is the default). `supports:[{ground:true}]` holds the lowest z face (a held face, not a contact law). `loadCase` reports `gravity` / `service` / `combined`. An unsupported load is refused. `mode`: `judge` (default), `scan` (field, **no verdict**), `both`; `judge` returns `nextLook` where to look.
- **Deliver against `delivery`, not `verdict`**; `unevaluable` is not a pass; `attention` is detection, not evidence.
- **No "largest element stress" and no safety factor** (isotropic; the tiers are a colour scale). Quote `stats.peakAtDeclaredDistanceMPa`; `surfaceExtrapolatedMPa` only when the cross-resolution check passes.
- **`trustworthy` / `whyUntrustworthy` decides what may be quoted**; a member thinner than the voxel comes back `check` with zero trustworthy regions and `meshIndependence: drifting`.
- `excludeFromReport` drops support/load patches; cut sections away from supports and check `M = F·L`.

Full model boundaries, refusal conditions and field semantics: `docs/llm/engines.md`.
