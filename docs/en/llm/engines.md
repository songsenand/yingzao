# Engine boundaries: what they model, what they cannot answer

[中文](../../llm/engines.md) | English

Five engines, five scopes of trust. **Motion/physics/fluid/LBM do not report force or torque; stress reports reactions and section forces, but that is not a safety factor, drive torque or power. None replaces certification.** Axial spring/snap statics are not in these five engines; they live in `check_assembly`'s `spring-behaviour` / `snap-fit` static contract checks. That is not dynamics, contact or fatigue.

## Motion (`simulate_motion`)

- **Kinematics + exact interference timeline**, no gravity. Answers “with this drive, will parts collide, is the stroke enough?”.
- **Rotates about the pivot, not the world origin.** Corpus parts are in world coordinates; sim bodies start at (0,0,0). The tool rebases geometry to the pivot (default: the first joint anchor naming it, otherwise the geometry centre), so a gear at z=265 does not swing on a 265 mm arm. `pivots` reports the actual pivot.
- **Measure joint anchors before stepping.** Every joint's anchor gap is measured before the first step; above 2 mm the run is refused with both anchor positions. `initialJointGaps` / `jointToleranceMm` are in the reply. A refusal means your anchors or placements disagree — **do not widen the tolerance**.
- **Joints between differently oriented parts need per-body axes.** `axis` means “both bodies use the same local vector” and is only correct when their frames are parallel; for rotated parts use `axisA` + `axisB`, or `axisWorld` (converted to each local frame). r001's 105 mm drift was “file frame treated as world + single axis”; after the fix the same STLs show 0 mm.
- **Interference coverage is part of the verdict.** Each run samples at least 24 poses, always including the final pose; `interferenceChecks` / `samplingSatisfied` / `maxSampleGapDeg` report coverage. **0 checks is not 0 collisions.** When travel is too small for 24 poses the result is `check`, not pass.
- **Overlap between a revolute pair is not reported** — that is a bearing. If a hard stop intentionally collides on that pair, validate it another way.
- **`cycles` accepts fractions.** A lever at ±14° sweeps 0.078 of a turn; a whole turn turns it into a windmill and it collides with everything.
- **A crank is optional.** `drive` is optional: when every moving part is an `oscillator` (a guided part/valve with a prescribed trajectory), the time base is the oscillation period; the reply has `hasCrank: false`. Only “no drive and no oscillator” is refused — that means nothing moves.
- **A closed loop is a fact, not a verdict.** `closedLoop` / `loopJoints` come from union-find on the joint graph: a tree is false / []; the Roberval balance (5 parts, 6 joints) is true / 2 closing edges. A closed loop can pass — it just saves the reader from re-deriving connectivity.
- **Geometry sanity is a fact, not a verdict.** For each part, gap to the nearest part ÷ its own bbox diagonal > 5 → `outlier`; ≤ 24 triangles → `simple box`. Neither changes pass/fail, but when `geometrySuspects` is non-empty, “0 interferences” may prove nothing: fructose r013's two fake parts sat 500 mm away and the report still passed. The rule is returned in `geometrySuspectRule`.

## Physics (`simulate_physics`)

- **Rigid bodies + gravity**; answers “will it topple, will it settle?”.
- **Use `tiltDeg`, do not hand-compute a gravity vector.** `tiltDeg: 5` tilts gravity 5° about `[0,1,0]`; pass `gravity` explicitly only when tiltDeg cannot express the direction.
- **“Will the slider slide under gravity?” is answered by `staticFriction`, not the solver.** Give a prismatic joint `staticFriction: μ`; the report adds a quasi-static hold analysis (μ·m·|g⊥| vs m·|g∥|) and labels it analytic. Without it the joint is a pure constraint, the slider always falls, and that says nothing about the design.
- **A prismatic joint only checks drift perpendicular to its axis**; sliding along it is the joint working, not drift.
- **Colliders split by convexity.** Convex parts use hull, concave parts (fork openings, tray cavities, multi-shell research bodies) use exact trimesh. A single hull fills a cavity: Roberval r002's tray/edge bars truly overlap 0 mm³ at t=0, but the hull overlapped 12,140 mm³ at each upper hinge and 3,937 mm³ at each lower hinge — the solver treated it as deep penetration and threw the pan out of the fork. `colliders` reports what each part actually used.
- **Joint endpoints do not collide by default.** A bearing is a designed overlap, not a modelling error; `contactsDisabled` lists the disabled pairs. Only when a hard stop really must collide on that pair pass `jointContacts: true`.
- **t=0 assembly gate.** A joint anchor gap > 2 mm is refused, listing every joint and both world coordinates (`initialJointGaps` / `jointToleranceMm`); do not widen the tolerance. Same rule as motion.
- **A closed loop is a fact, not a verdict.** `closedLoop` / `loopJoints` come from the joint graph; a closed loop can pass; the report just states connectivity.
- **Joints between differently oriented parts need per-body axes** (as in motion).
- **Toppling is measured relative to the authored pose, not world up.** A beam authored at 90° is not “fallen at t=0”; 30° marks an event, 60° sets `fellOver`.
- **No force/torque output.**
- **The same geometry sanity check runs here.** Gap to nearest ÷ diagonal > 5 → `outlier`; ≤ 24 faces → `simple box`; non-empty `geometrySuspects` means “steady penetration 0” may only mean it fell in an empty field. Does not change pass/fail.

## Fluid (`simulate_fluid`)

- **Fixed-boundary MPM**: fluid flows inside part boundaries; answers flow direction, dead zones and pressure-drop trends.
- **No fluid–structure coupling**: fluid does not push parts, and parts do not deform from fluid. Split into “rigid check + fluid check”, or state the limit.
- **Not industrial CFD**: do not use it as acceptance data.

## LBM (`simulate_lbm`)

- **Lattice units, not millimetres.** `latticeVelocity` and returned profiles are cell/step; converting to m/s requires a chosen length scale and viscosity, and must be **stated**. Keep `latticeVelocity ≤ 0.1` (weakly compressible scheme); compare `metrics.peakUx` with `1.5×latticeVelocity` (analytic channel peak).
- **Development length grows with Re.** `overallStatus: developing` means the parabola is still forming: quote symmetry and shape trends only, not drag/shear numbers, until `developed`; increase `steps` with `reynolds`.
- **Stage A has no immersed solids.** Only box walls: no part in the flow, no heat, no free surface, no multiphase. “Flow around my part” is currently out of scope — say so, do not run a fake answer.
- **`overallStatus: diverged` is divergence, not a partial answer.**

## Stress (`simulate_stress`)

- **Linear elastic, isotropic.** It does not know FDM layer direction — usually the first failure path — so a peak is not a safety factor.
- **Do not ask for “maximum element stress”**: there is no such field. At curvature/notch boundaries it grows without bound under refinement (measured 1.002 → 1.184; fill-ratio weighting did not fix it).
- **Quote the value at `criticalDistanceMm`** (a declared distance inward from the surface; the actual distance is returned as `effectiveSampleDistanceMm`), i.e. `stats.peakAtDeclaredDistanceMPa`. `surfaceExtrapolatedMPa` is a higher estimate and may be quoted only when both its own fit check and the cross-resolution check (`extrapolationCrossResolutionPct`) pass — good R² is not enough: on a fillet R² 0.90 still differed 17% between two meshes. `runConvergence: false` makes every region untrustworthy: the stability check is part of the peak claim.
- **Declare the load case first** (supports + loads; `includeSelfWeight` defaults true, `loads` may be omitted; `supports:[{ground:true}]` holds the lowest z face — a held face, not friction/unilateral contact). `loadCase` reports `gravity` / `service` / `combined`; `selfWeight.totalWeightN` is ρVg, not stress. An unsupported load is a rigid-body mode and is refused, not papered over. Quotable integrals: reactions, section `axialForceN` / `shearN` / `momentNmm`, `areaMm2`, `secondMomentMm4`, and `checks.equilibriumErrorPct` / `energyBalancePct` (machine precision, independent of whether the answer is right).
- **`trustworthy` / `whyUntrustworthy` decide whether a number may be quoted.** Do not quote positions or values from an untrustworthy region; refine `dxMm`. Features thinner than a voxel are smeared thicker and read stiffer/safer; then the verdict is `check`, zero trustworthy regions, `meshIndependence: drifting` — refine, or quote integrals only.
- **`excludeFromReport` removes support/load patches** (a clamp is not a knife edge); `method.excludedCells` reports excluded cells. Cut the section away from supports: cutting through a support swallows the reaction and computes the wrong moment (measured 22.1 vs 62.8 N·mm); at mid-span, `M = F·L` is correct.
- **Delivery looks at `delivery`, not `verdict`.** A missing number is not a pass; geometry-suspect points in `attention` are **probes** (where to look), not delivery evidence.
- **Never silent**: when no region can be certified, still return the `geometry-suspects` layer (concave corners from the geometry scan), labelled geometry, not stress.

## What none of them can answer

- Drive/output torque, power, lifetime (stress gives reactions and section forces, not a safety factor);
- fluid–structure coupling, aerodynamics, flexible bodies;
- certified accuracy, safety factors;
- “which process/material is better” (a business decision, not a geometric fact).
