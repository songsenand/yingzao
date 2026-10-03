---
name: cad-toolbox
description: Use when a task involves 3D geometry at all — designing or changing a part, importing an STL, checking whether parts fit together, verifying a mechanism moves, testing fluid flow, or measuring a model. Contains the tool-selection map, the conventions every CAD tool assumes, and the traps that have cost real iterations. Load it before choosing among generate_part / import_part / measure_* / simulate_* / check_assembly; the tool descriptions are deliberately terse.
---

# CAD toolbox: which tool, when, and how not to waste a round

Fifteen tools, seven jobs. The tool descriptions say what each one *is*; this file
says **which one the question belongs to**, and what has already gone wrong.

## The router (this table is the whole point)

| The question sounds like | Reach for | Not |
|---|---|---|
| "make / change / reshape a part", "try another version" | `generate_part` | — |
| "use this STL/STEP someone sent me", "bring in a bought part" | `import_part` | `generate_part` |
| "treat the whole machine as one body", "does it topple", "whole-assembly mass/CoM" | `merge_parts` | hand-unioning STLs in OpenSCAD |
| "is it watertight", "do these two parts overlap", "what's the gap" | `validate_assembly` | `simulate_physics` |
| "will it topple", "does it rest stably", "does the hinge hold", "does it sink" | `simulate_physics` | `validate_assembly` |
| "does the mechanism move correctly", "what's the stroke", "does it jam mid-travel" | `simulate_motion` | `simulate_physics` |
| "does liquid fill it", "where are the dead zones", "does it drain" | `simulate_fluid` | anything rigid |
| "how big / how many holes / is it watertight", whole-part numbers | `measure_part` | renders |
| "hole spacing", "wall thickness here", "gap at this spot" | `measure_distance` | `measure_part` |
| "how close do these two get", "minimum gap", "nearest point to this sphere" | `measure_closest` | `measure_distance` |
| "does the declared interface hold", "check the BOM's tolerances" | `check_assembly` | `validate_assembly` |
| "can this actually be printed", "is this wall too thin", "will this need supports" | `check_printability` | looking at renders |
| "what anchors does this version have", "I forgot a datum", "rename/add an anchor" | `set_datums` | re-running `generate_part` |
| "I just want to look at it from another angle / cut it open" | `render_part` | re-running `generate_part` |

**An imported part is not a special kind of part.** `import_part` lands the file
as an ordinary version, so every other row of this table applies to it unchanged:
measure it, render it, put it in `validate_assembly` next to a part you generated,
run a mechanism through it. The only thing it cannot do by itself is *be an
interface endpoint* — that needs datums, which an STL does not carry (see below).

**`measure_part` vs `measure_distance` vs `measure_closest`** is the pairing
that gets confused most: whole-part scalars → `measure_part`; two points you can
name → `measure_distance`; the closest approach you *cannot* name → let the
solver find it with `measure_closest`.

**`validate_assembly` vs `check_assembly`**: the first is ad-hoc (give it parts
and poses, it answers interference and clearance); the second is contractual
(give it the manifest, it answers whether *declared* interfaces hold and which
near-touching pairs were never declared).

## Conventions every tool assumes

- **Millimetres, z-up.** No tool takes a unit argument.
- **`generate_part` renders are the review channel** — look at all four views
  (front/side/top/iso) before claiming a shape is right. Renders are for
  *shape*; numbers come from `measure_*`.
- **Anchors**: declare `datum("name", [x,y,z])` at top level, in **final world
  coordinates** (a transform at the call site does not move the echoed value).
  Datums do not affect the mesh. Extended kinds exist for assemblies:
  `datum_axis`, `datum_plane`, `datum_cyl`.
- **Anchors are metadata, not geometry.** If you forgot one, or need the exact
  names and coordinates to write an interface against, use `set_datums` on the
  version you already have — `set_datums(versionId)` lists, `set_datums(versionId,
  datums)` adds or replaces. Do **not** spend a `generate_part` round on a version
  whose only change is an anchor: that buries the real revisions in the history
  (the microscope2 corpus has three such versions) and costs four renders.
- **The assembly manifest is an ordinary file in your workspace**, by default
  `<workspace>/assembly/assembly.json`, and `check_assembly` resolves a relative
  `manifestPath` against the workspace first (the plugin data root is only a
  fallback for old corpora). Author and edit it with `write` / `edit` like any
  other source file — do not shell out to patch JSON, and never copy it anywhere.
- **BOSL2 is available** in `generate_part` (`std.scad`, plus `screws.scad`,
  `gears.scad`, `walls.scad`, `threading.scad`, `sliders.scad`,
  `ball_bearings.scad`). Use the library module instead of hand-rolling a thread,
  a gear or a fillet.
- **Rigid simulation costs seconds, fluid costs minutes.** Ask for the cheap
  check first.
- **Images are the biggest context spend.** Each attached render lives in your
  context for several rounds before the budget prunes it. New or reshaped parts
  deserve all four views; a numeric iteration (a hole Ø, a length you will
  verify with `measure_*`) does not — pass `views: ["iso"]` to `generate_part`
  and keep the budget for the screenshots that carry information.
- **A reference image the user attached will be pruned from your context** after
  roughly five render rounds (the oldest images go first, and theirs is the
  oldest). The first user message then carries a placeholder naming the local
  file. Before you claim a shape matches the reference — and again before you
  finish — `read_image` that path and look at it. Designing "from the picture"
  while the picture is no longer in view is how a machine ends up with the wrong
  silhouette and a green assembly check.

## Facts that are not obvious from any single tool

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
- **`import_part` refuses a mesh that is not a closed solid, and that is a
  feature.** It runs Manifold on the file first; if the surface has holes,
  T-junctions or inside-out winding, nothing is stored. Storing it would let
  `measure_part`, `validate_assembly` and the simulators report confident numbers
  about a shape that is not a body. `allowNonSolid:true` exists only to look at
  broken geometry, and it brands the version so the geometric tools refuse it.
- **An imported part has no datums until you declare them.** Generated parts get
  them from `datum()` / `datum_cyl()` in their SCAD; an STL carries none, so
  `import_part`'s `datums` argument is the only way to make the part an interface
  endpoint. Without it the part is still fully measurable and assemblable, just
  not *addressable* by `check_assembly`.
- **STL has no unit.** `import_part`'s `unit` (mm/cm/m/inch) and `scale` are your
  declaration, applied once before measurement and recorded in the version's
  provenance. A 25.4x wrong part is the classic failure here, so check the
  reported `sizeMm` against what you expected before trusting anything else.
- **STEP/IGES are not supported** (no B-rep kernel; the whole truth engine is
  mesh-based). `import_part` says so with the conversion route instead of failing
  mysteriously. Convert to STL in FreeCAD (`File → Export → STL`) or the
  originating CAD tool.
- **Stock (purchased) parts without a version cannot be interface endpoints**:
  they have no geometry to measure. Their influence has to be folded into the
  datums of the parts that surround them, and that assumption should be written
  down where a human will see it. **This stops applying the moment you import the
  part** — an imported part has a version, so it is checked like any other.
- **Undeclared adjacency is a feature, not noise.** A warning about a
  near-touching pair that is not in any interface means the manifest has a gap:
  either declare the interface or move the parts apart. It is the one check that
  catches what nobody thought to declare.
- **`merge_parts` is for "one rigid body", not for tidying a corpus.** Use it when
  a whole machine has to be a single body (`simulate_physics` topple, a
  whole-assembly `measure_part`), because `simulate_physics` takes no joints
  other than revolute and cannot hold a machine together by itself. It reports
  the number of **shells**: more than one means the parts you merged do not all
  touch, so the body is not a machine but a pile.
- **Runs have a lifecycle.** A run records a `subject` (the manifest it audited,
  the part set it posed); committing a newer run about the same subject marks the
  older one `supersededBy`. So "which run is the current answer" is readable, and
  a superseded run is still there to read. Runs with no subject (inline-SCAD
  scenes) are never auto-superseded — do not assume a newer run replaced them.

## Traps that have cost real iterations here

- **OpenSCAD trigonometry is DEGREES in and DEGREES out — gear and thread math
  is radians.** `sin/cos/tan` take degrees; `asin/acos/atan` return degrees;
  involute (`inv(α) = tanα − α`), helix pitch and cam tables need radians.
  Convert explicitly (`d2r` / `r2d`) at the boundary, never inline. The lethal
  part: on the pitch circle the mixed-up terms cancel, so one self-check number
  looks right while the whole flank is garbage (microscope3 shipped a gear with
  `ph(rb) = −19.6` "radians" that passed its pitch-radius spot check, then fed
  that gear as the hob for its rack — nine rework versions before anyone looked).
- **Watertight beats pretty.** `generate_part` reports `watertight` on every
  save and the result text screams when it is false. Never assemble, measure or
  simulate a version flagged NOT WATERTIGHT: every interference, clearance and
  closest-point number on an open mesh is a lie (microscope3's fake 0.05mm
  "margin" and its phantom rack interference both came from exactly this).
  Fix the mesh first — `measure_closest` / `measure_distance` now warn too,
  but a warning after the fact is cheaper than a rework, only if you obey it.
- Renders are seductive: a shape can look right and measure wrong. Anything with
  a tolerance in it gets a `measure_*` call before it gets a verdict.
- `simulate_physics` with parts placed exactly touching starts in penetration;
  place them slightly separated and let gravity close the gap.
- A "gap" between two probe points that are not roughly facing each other is not
  the gap you meant — the tool reports true point-to-point distance, which on
  two skew surfaces is larger than the clearance.
- Interpreting a mechanism from a single keyframe is unreliable; the
  interference timeline and the stroke number are the real outputs.
- **A coaxial claim checked as two points is not checked.** Two well-chosen
  points pass while one bore is tilted. Interfaces about alignment use
  `"check": "coaxial"` with `datum_axis`/`datum_cyl` endpoints — it measures
  axis-to-axis offset AND flags non-parallel axes.

## Printability checklist (volunteer it with the design, don't wait to be asked)

- **Overhangs**: holes, racks, threaded cavities with the axis along Z print
  support-free; a horizontal closed ceiling is a bridge — keep spans ≤30mm and
  say so when one is longer.
- **Layer direction**: stiff parts (columns, tubes) print standing; a spring
  (cantilever clip) must print with layer lines perpendicular to the bending
  neutral face, or it snaps along a layer.
- **Threads**: never print fine load-bearing threads (M12×0.5 and tighter) —
  use a clearance hole + locknut or a heat-set insert. Coarse printed threads
  (≥1.5mm pitch) are fine; trapezoidal/square profiles print support-free.
- **Fits**: printed mating pairs get ±0.15mm loose fit; "tight" means a fastener
  or an insert, not a tight print.
- **Bed and time**: check each part against the bed (e.g. 220×220×250) and the
  time budget (e.g. ≤6h) with `measure_part`'s bbox; a part that does not fit is
  split — and the new joint goes into the assembly manifest as an interface.

## Delivery discipline (non-negotiable, learned the hard way)

1. **Never deliver on green numbers alone.** Before you tell the user a design
   is done, LOOK at the final state: the assembly renders (validate_assembly
   attaches them), the panel screenshots, or a fresh render_part of the risky
   part. microscope 系列两次"指标全绿、图上一眼假"的交付都是跳过了这一步.
2. **Run `check_printability` on every part before declaring the design done**,
   and again after any edit that changes a wall, a boss or an angle. A part can
   be geometrically valid, watertight, interference-free — and still 0.5mm thin
   in a place no number you checked looked at. `verdict: check` means the
   findings get answered (fixed or argued), not ignored.
3. "It compiles / it assembles / the report passes" are three different claims.
   Delivery requires all three PLUS eyes on the shape and a printability pass.

## Still to add (deliberately open)

- Parameter sweet spots per tool (particle counts, step counts, what actually
  changes the answer vs what only changes the runtime).
- Cost model: which call is seconds and which is minutes, and how to bound a
  simulation before launching it.
- Assembly-specific guidance (when a flat root is enough and when to nest).
