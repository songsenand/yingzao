---
name: cad-simulation
description: "Depth for simulate_motion / simulate_physics / simulate_fluid: what each engine actually models, which joints and drives it accepts, the traps that have cost iterations (rack pitch vs a sinusoid, pivot vs world axis, tiltDeg vs a hand-built gravity vector), and the questions NONE of them can answer — no fluid-structure coupling, no aerodynamics, no flexible bodies, no force or torque output."
whenToUse: "Before running any simulate_* tool, or when asked whether a mechanism moves, topples, holds under friction, or fills with fluid."
---

# Simulation: what the engines model, and what they cannot

Router: `skills/cad-toolbox/SKILL.md` — this file assumes you loaded it.

Motion is kinematics with an exact interference timeline; physics is rigid bodies under gravity; fluid is a fixed-boundary MPM. None of the three reports a force.

## Facts that are not obvious from the tool descriptions

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
  was used.
