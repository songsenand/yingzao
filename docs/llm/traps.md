[English](../en/llm/traps.md) | 中文

# 纪律与陷阱：让绿色数字保持诚实

> 长解释参考；短规则在 `skills/cad-toolbox/SKILL.md`。


## Discipline (the facts that keep a green number honest)

- **Read the tool's own caveat fields before its headline number.** Each of these
  is the tool telling you its result cannot be read the way you are about to read
  it:
  - `simulate_fluid`: `metrics.warnings` (a `metrics.seedStats.stacksPerSeed` above
    1.5 means the requested count exceeded the seed lattice, so extra particles are
    duplicates on the same spot) and `metrics.seedStats.solidFraction` (the share of
    the seed box that is metal — high enough on a thick-walled part that the lattice
    is coarse where the flow is). Its arrival ratio is a *sampled* number: state it
    as a range, and treat `overallStatus: pass` as a floor, not a quality claim.
  - `simulate_lbm`: `metrics.peakUx` against the Poiseuille peak (`1.5×latticeVelocity`)
    — `overallStatus: developing/underdeveloped` means the profile is still entering
    the duct, so quote the shape, not drag numbers; `metrics.stable: false` reports
    as `diverged` and means the lattice velocity or Re overran the scheme, not a
    partial answer. Mirror symmetry (`metrics.mirrorError`) is the cheap honesty
    check — a symmetric profile with a wrong peak means "not developed yet", never
    "the theory is off".
  - `simulate_physics`: the REPLY has `notes` (honest-input caveats: several
    disconnected shells make a figure an artefact; an analysis that is analytic
    rather than solved) and `settledPenetrationMm`; the run report's `metrics`
    adds `settled` (still moving at the end — not "did not drift") and
    `jointViolations` (hinge anchor drift / slide cross-axis motion beyond
    `JOINT_DRIFT_TOLERANCE_MM` = 2 mm).
  - `check_printability`: `samples` sets the triangle stride (`triangles / samples`),
    so a thin feature between samples is missed — raise it for a big or
    safety-critical part. Walls are measured to the nearest opposite wall.
    `verdict` is the canonical three-value judgement — `excluded` / `difficult` /
    `not-excluded` (it was `ok` / `check` / `unprintable` until 2026-10-20; old
    corpora still carry those words, and `not-excluded` never means "can be made").
    `surfaceAreaMm2` is published because the band's width is `sqrt(area / sampled)`:
    below that spacing two walls are the same wall to this screen — a "1.19 vs 1.20"
    difference is not one it resolved.

- **Check the operator, not just the interface count.** For every interface whose
  `type` is a joint (转动副 / 滑动副), look at its `check` operator: an interface
  whose operator cannot consume a motion run cannot fail because the mechanism
  does not move, however green the report is. `motion-clearance` consuming a run
  that predates the delivered versions is the same problem one step later.

- **Runtime**: running the measuring / checking / simulating tools needs the
  plugin's pinned Python runtime; `python_runtime` reports, provisions or repairs
  it, and the runtime-not-ready error already names that fix. `run_python` shares
  the same pinned environment and is the escape hatch for checks the CAD tools do
  not cover. `delivery_audit`, `create_part`, `set_datums`, `render_part`,
  `recall_reference_image` do not need it. **`check_assembly` does**: its contract
  solver (distance / diameter-match / coaxial / motion-clearance / spring-preload / spring-behaviour / snap-fit)
  runs in the worker; only the manifest read and the adjacency geometry are local.

- **Installing a package is allowed — do it when the task needs it.** This is the
  user's own machine; `python_runtime action=install packages=["x==1.2"]` puts a
  library in the USER OVERLAY, which the worker tools and `run_python` both see,
  survives runtime updates, and is recorded in `status` and in every run's
  `pythonOverlay` provenance. Two things to know before you reach for it:
  **the default is add-only** (a package the lock already provides keeps the
  LOCKED version — the install reports it as `shadowed`); to actually REPLACE a
  locked dependency pass `override: true` **and a `reason`** — that is the
  explicit declaration, it is recorded in status and in every run's
  `pythonOverlay.overrides`, and you should agree it with the human and mention it
  when you deliver (a replaced dependency is part of what the number means).
  Prefer a tool that already answers the question; install when nothing does.

- **Runs have a lifecycle.** A run records a `subject` (the manifest it audited,
  the part set it posed); committing a newer run about the same subject marks the
  older one `supersededBy`. So "which run is the current answer" is readable, and
  a superseded run is still there to read. Runs with no subject (inline-SCAD
  scenes) are never auto-superseded — do not assume a newer run replaced them.

- **Watertight beats pretty.** `generate_part` reports `watertight` on every
  save and the result text screams when it is false. Never assemble, measure or
  simulate a version flagged NOT WATERTIGHT: every interference, clearance and
  closest-point number on an open mesh is a lie (microscope3's fake 0.05mm
  "margin" and its phantom rack interference both came from exactly this).
  Fix the mesh first — `measure_gap` now warns too,
  but a warning after the fact is cheaper than a rework, only if you obey it.
- Renders are seductive: a shape can look right and measure wrong. Anything with
  a tolerance in it gets a `measure_*` call before it gets a verdict.
- **`simulate_motion` compensates each part's re-based pivot by `R·pivot`, and refuses a
  run whose joints are not assembled at t=0.** If you pass a `pivot` that is not on the
  part's own initial-rotation axis, the identity still holds — that is the point of the
  compensation — but the run now measures every joint's anchor gap BEFORE stepping and
  refuses with the joint named when it exceeds 2mm. A refusal means *your* anchors or
  placements disagree, not that the tool is unhappy: fix those, do not widen the tolerance.
  `cycles` accepts fractions — a balance whose range is ±14° is 0.078 of a turn, and asking
  for a whole turn answers a different question (the beam becomes a windmill and everything
  collides). Fractions also get **at least 24 sampled poses** (the final pose always
  included); check `interferenceChecks`/`samplingSatisfied` before quoting "0 interference",
  because a run with too little travel is `check`, not pass — 0 checks ≠ 0 collisions.
- `simulate_physics` with parts placed exactly touching starts in penetration;
  place them slightly separated and let gravity close the gap.
- A "gap" between two probe points that are not roughly facing each other is not
  the gap you meant — the tool reports true point-to-point distance, which on
  two skew surfaces is larger than the clearance.
- Interpreting a mechanism from a single keyframe is unreliable; the
  interference timeline and the stroke number are the real outputs.

- **A part is ONE connected solid — always.** `generate_part` warns when a
  version carries multiple disconnected bodies, and `measure_part` shows
  where each body sits. Multi-body is NEVER acceptable as "one part": either
  union the fragments in OpenSCAD (they must genuinely touch/overlap), or
  model them as SEPARATE parts. Delivering a multi-body version as a single
  part poisons every downstream number — assembly interference, mass, print
  layout all assume one solid per part.
