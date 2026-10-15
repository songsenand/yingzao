---
name: cad-assembly
description: "Depth for the assembly contract machinery: check_assembly's five operators, validate_assembly's per-pair interference, datums as interface endpoints, pose vs transform for a meshing angle, undeclared adjacency, and stock parts. Explains what a manifest can and cannot prove, and why an interface COUNT is not evidence."
whenToUse: "Writing or debugging an assembly manifest, declaring datums, checking fit / coaxiality / interference, or reading an assembly-check report."
---

# Assembly contracts: datums, fit, and what a manifest proves

Router: `skills/cad-toolbox/SKILL.md` — this file assumes you loaded it.

A green assembly check means the declared interfaces were machine-checked against their operators. It is not a statement that the parts are manufacturable, printable or strong.

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
  `import_part`'s `datums` argument is the only way to make the part an interface
  endpoint. Without it the part is still fully measurable and assemblable, just
  not *addressable* by `check_assembly`.
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
