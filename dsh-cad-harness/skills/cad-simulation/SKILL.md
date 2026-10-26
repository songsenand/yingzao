---
name: cad-simulation
description: "Depth for simulate_motion / simulate_physics / simulate_fluid / simulate_lbm: what each engine actually models, which joints and drives it accepts, the traps that have cost iterations (rack pitch vs a sinusoid, pivot vs world axis, tiltDeg vs a hand-built gravity vector, lattice units vs millimetres), and the questions NONE of them can answer — no fluid-structure coupling, no aerodynamics, no flexible bodies, no force or torque output."
whenToUse: "Before running any simulate_* tool, or when asked whether a mechanism moves, topples, holds under friction, fills with fluid, or what the velocity profile in a duct looks like."
---

# Simulation: what the engines model, and what they cannot

Router: `skills/cad-toolbox/SKILL.md` — this file assumes you loaded it.

Motion is kinematics with an exact interference timeline; physics is rigid bodies under gravity; fluid is a fixed-boundary MPM; `simulate_lbm` is a lattice-Boltzmann channel template (box walls, no embedded solids yet). None of the four reports a force.

## Facts that are not obvious from the tool descriptions

- **`simulate_lbm` works in lattice units, not millimetres.** `latticeVelocity`
  and the profile it returns are in cell-per-step units; converting to physical
  m/s means picking a length scale and a viscosity, and the conversion is YOURS
  to state. Keep `latticeVelocity ≤ 0.1` (weakly compressible scheme) and read
  `metrics.peakUx` against `1.5×latticeVelocity`, the analytical channel peak.
- **Development length grows with Re.** `overallStatus: developing` means the
  parabola is still forming — quote the symmetry and the shape trend, not drag
  or shear numbers, until `developed`. Scale `steps` up together with `reynolds`.
- **Stage A has no embedded solids.** The only walls are the box: no part in the
  flow, no heat, no free surface, no multiphase. A "flow around my part" question
  is out of scope for this tool today — say so instead of running it.
- **Fluid–structure coupling does not exist.** Neither simulator pushes parts
  around. If the question needs both, split it into a rigid check and a fluid
  check, or say the limitation out loud instead of implying a coupled result.
- **`simulate_motion` has no gravity**, and mesh overlap between two parts joined
  by a revolute joint is expected (it is a bearing) and therefore not reported.
  Every other pair *is* checked, which is what makes the interference timeline
  usable as a jamming test.
- **Both simulators take revolute (hinge) and prismatic (slide) joints.**
  `simulate_motion` drives a crank and lets followers react; `simulate_physics`
  runs under gravity and reports whether things settle or topple. A prismatic
  joint in `simulate_physics` is checked for motion *across* its axis only —
  sliding along it is the joint working, not drift.
- **"Will the slide hold under gravity?" is answered by `staticFriction`, not by
  the solver.** Give the prismatic joint `staticFriction: μ` in
  `simulate_physics` and the report carries a quasi-static hold analysis
  (μ·m·|g⊥| vs m·|g∥| → holds/slides), explicitly labelled analytic. Without it
  the joint is a pure constraint: the slider always falls, and that means
  nothing about the design.
- **Slopes are `tiltDeg`, not a hand-computed gravity vector.**
  `simulate_physics({tiltDeg: 5})` tilts gravity 5° about `[0,1,0]`; pass
  `gravity` explicitly only when you need something tiltDeg cannot say.
- **A rack must be driven by `pitchRadiusMm`, never by a sinusoid.** In
  `simulate_motion` an oscillator with `pitchRadiusMm` moves at
  `r × (drive angle)`, i.e. exactly the ratio a real rack and pinion enforce. A
  sinusoidal `amplitudeMm` drifts out of ratio within a quarter turn and the
  teeth gnash *by construction* — that is an artifact of the model, not a
  finding about the design. `phaseRad` offsets the rack's starting position by
  `r × phaseRad`, which is how you sweep tooth phase.
- **`simulate_motion` turns each part about a PIVOT, not about the world
  origin.** Parts in a corpus are modelled in world coordinates while their
  simulation bodies start at (0,0,0), so a gear modelled at z=265 would swing on
  a 265mm arm instead of spinning on its shaft. The tool now re-bases every
  part's geometry on a pivot (default: the anchor of the first joint that names
  it — i.e. its own axis — else the geometry centre) and puts the body there, so
  the motion you get is the motion you drew. Pass `pivot` per part only when the
  rotation axis passes through neither. The run's `pivots` field reports what
  was used. The compensation is `position + R·pivot` — it rotates with the part,
  so a pivot off the part's own initial-rotation axis is still handled — and the
  run now measures every joint's anchor gap BEFORE stepping and REFUSES (naming
  the joint and both anchor positions) when it exceeds 2mm. The reply reports the
  numbers either way — `initialJointGaps` and `jointToleranceMm` — so a marginal
  case is visible without a refusal. A refusal means your anchors or placements
  disagree, not that the tool is unhappy; do not widen the tolerance. `cycles` accepts fractions: a balance whose range is ±14° sweeps
  0.078 of a turn, while a whole turn makes the beam a windmill and collides with
  everything. Note what is never reported: collisions between two parts JOINED by
  a revolute joint (that overlap is a bearing) — a stopper contact lives on
  exactly that pair, so verify a limit stop another way.

  **Interference coverage is part of the verdict.** A short fractional sweep used
  to get fewer than one sample (a 0.03-turn balance run: 754 steps against a
  1047-step sampling interval), so the boolean loop ran zero times while the
  report still said "0 interference" and pass. The engine now caps the interval
  so every run gets at least **24 sampled poses**, always samples the **final
  pose** (the end of travel is where a stop/collision lives), and reports
  `interferenceChecks`, `candidatePairs`, `interferencePairChecks`,
  `samplingSatisfied` and `maxSampleGapDeg`. If too little travel exists to fit
  24 poses the run is `check`, never pass — read `interferenceChecks` before
  quoting "0 interference", because 0 checks is not 0 collisions.

## `simulate_stress` — the one that reports a force, and the only one with a refusal

**Two channels, and you must pick one.** `mode: 'judge'` (default) returns the delivery
judgement only; `mode: 'scan'` returns the attention field only and **no verdict** (a risk
map must never be read as a gate); `'both'` returns the two halves as separate keys. A
`scan`-mode reply that looks "empty" is not a pass — it means nothing was certified.

**Deliver against `delivery`, not `verdict`.** `verdict` is a human summary. `delivery` is
`excluded` / `difficult` / `not-excluded` with witnesses plus `unevaluable` for numbers this
mesh cannot decide. `not-excluded` means "no counter-example", never "ok", never "safe".

**Simulations produce EVIDENCE; `preflight` checks that it exists.** A strength claim needs
a fresh stress run citing the newest version; run one, then declare the claim — do not expect
`preflight` to invent a load case for you.

Voxel hex8 linear-elastic statics for **one saved version under one declared case**
(material + supports + loads). It is the only `simulate_*` that answers "where does it
break", and it is also the only one that will tell you it cannot.

**Declare the case or the number means nothing.** Supports (a bbox face, or the nodes
within `radiusMm` of `atMm` — the latter is how a knife edge on a pin is modelled) and
loads (a face, or a point patch). An unsupported load is a rigid-body mode and is
**refused**, not fudged.

**Trust these**: the integrals — reaction, section `axialForceN`/`shearN`/`momentNmm`,
`areaMm2`, `secondMomentMm4` (enough to close a hand check on a profile you cannot
compute by hand), plus `checks.equilibriumErrorPct` and `checks.energyBalancePct`,
which are machine-precision and do not depend on the answer being right.

**Quote the declared-distance reading, not the extrapolated one.** `stats.peakAtDeclaredDistanceMPa`
is the number that survives refinement; a region's `surfaceExtrapolatedMPa` is a higher estimate and is
only emitted when it passes a cross-resolution stability check (`extrapolationCrossResolutionPct`) —
a good fit R² is NOT sufficient (measured on a fillet: R² 0.90 while the value moved 17% between grids).
Setting `runConvergence: false` therefore leaves every region untrustworthy: the stability check is part
of the peak claim, not an extra.

**Peaks are read at a declared distance, never at the surface.** `criticalDistanceMm`
(default 1.0) is floored by one cell; the distance actually used comes back as
`effectiveSampleDistanceMm`. The number to compare against a material is a region's
`surfaceExtrapolatedMPa` — the depth profile walked inward from the hot spot and fitted
out to the surface (R² is reported; the acceptance bands it at −6% on a cantilever).

**Two things you must not ask it for.**
- *"the largest element stress"* — there is no such field. On a curved or notched
  boundary it grows without bound under refinement (measured 1.002 → 1.184; fill-ratio
  weighting did not fix it, 1.184 → 1.169). Where the boundary is a staircase, the cell
  maximum is a property of the staircase. Use `surfaceExtrapolatedMPa` or a section
  resultant.
- *a safety factor* — the model is isotropic, so an FDM part's layer-direction weakness
  (usually what breaks first) is invisible to it. The tiers in `normalization`
  (`warnAt`/`badAt`, derived from the declared strength) are a **colour scale**.

**Deliver against `delivery`, not `verdict`.** `verdict` is a human summary; `delivery` is the
judgement: an allowable-stress requirement plus **excluded / difficult / not-excluded** with witnesses
(rule, measured, required, location), and `unevaluable` for numbers this mesh cannot decide — a missing
number is NOT a pass. The geometry suspects in `attention` are DETECTION (where to look) and are never
witnesses: a reentrant corner must not fail a part that has no load case behind it.

**The refusal is a feature.** Every region carries `localThicknessCells`,
`minExtentCells`, `fitR2` and `trustworthy`/`whyUntrustworthy`. A member thinner than
the voxel is smeared into a thicker one, which reads stiff and safe — so on such a part
the verdict comes back `check` with zero trustworthy regions and `meshIndependence.verdict
= "drifting"`. That is the tool saying "refine, or use the integrals only", and it is the
correct answer: the toy-balance beam (members ~1.2 mm at a 1.25 mm voxel) is exactly this
case. Do not quote a hot spot from a run that says this.

**Exclude the idealisation, not the evidence.** `excludeFromReport` drops the support and
load patches from the field, peaks and percentiles, because a clamped patch is not a
knife edge on a pin; the excluded cell count is reported in `method.excludedCells`.

**Place section cuts away from a support** — a cut through the support patch swallows part
of the reaction and the moment comes out wrong (measured: 22.1 vs 62.8 N·mm on the
toy-balance beam). Cut at mid-span and check the analytic invariant `M = F·L`.
