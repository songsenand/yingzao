---
name: cad-toolbox
description: "CAD router: the three job groups, the 9-surface map (45 ops), conventions, and the delivery rule. Load first; depth lives in the four job skills and docs/llm/."
whenToUse: "Any CAD work, before choosing a tool. Start here even when you think you know which tool you need."
---

# CAD toolbox: which tool, when, and how to spend a round

> The model sees 9 surfaces. Legacy names (`project_info`, `render_part`, …) are internal and not callable.
> Call shape: `cad_session` / `cad_part` / `cad_assembly` / `cad_check` / `cad_simulate` / `cad_inspect` / `cad_see` / `cad_python` / `cad_deliver` + `action` + `args`.

Nine job surfaces, three job groups. Pick the group first: the group determines what the output may mean. `instrument` is a tool class, not a fourth job.

| Group | Question | Tools | Output may be | Effect |
| --- | --- | --- | --- | --- |
| **Deliver** | Can this ship? | `cad_deliver` (`plan` / `preflight` / `audit`) · `cad_check` (`printability` / `sheet2d` / `turning` / `cnc` / `edm` / `parts`) · `cad_assembly` (`check`) | excluded / difficult / not-excluded + witness | can block delivery |
| **Detect** | Where should I look? | `cad_check` (`sweep` / `appearance`) · `cad_inspect` (`analyze` / `attention`) · every tool's `attention` field | coordinates + \|u\| + an actionable observation | never blocks, never silent |
| **Simulate** | What happens under this case? | `cad_simulate` (`stress` / `motion` / `physics` / `fluid` / `lbm`) | directional reading + reliability + evidence | produces evidence, does not decide delivery |

`instrument` groups the reading/coordinate/contract writers (`cad_inspect` (`measure` / `features`), `cad_part` (`generate`), `cad_see` (`render`), `cad_assembly` (`write`), …). It is not a delivery judgement; keep it separate from the three job groups when declaring `groups`.

## Rules

1. **Start with the plan.** `cad_deliver` (`plan`) is read-only and derives one row per gap from the BOM/ICD, roles, claims and the run graph. Follow its `next`, then run `cad_deliver` (`audit`) with your claims. A plan pass is not a claim.
2. **Read `not-excluded` as "no counterexample found".** `difficult` means the margin is inside measurement noise: state what you saw and why you accept or reject it. Report findings in those terms rather than as "ok" or "safe".
3. **Make claims carry evidence.** Declare `strength` / `motion` / `assembly` / `manufacturability` / `appearance` / `review` through `cad_deliver` (`audit`). The newest version of every printed part gets a fresh top+iso `cad_see` (`review`) with a note. Mark bought or research geometry with `cad_part` (`role`): `stock` / `research`.
4. **Use detection to aim attention.** A location in `attention` or `nextLook` is where to look next; record what you saw there and let the check decide the verdict.
5. **Declare the load case.** Stress needs material, supports and loads; motion needs joints and drive; fluid needs the medium and boundaries. Read directional trends and reliability, not a safety factor.
6. **Register geometry that a human or a tool must see.** `cad_part` (`generate`) and `cad_part` (`import`) create versions; the panel and every geometric tool read versions, not loose STL files. Batch experiments may stay on disk when you state the path and reason; `cad_deliver` (`audit`) lists unregistered geometry.

## Before delivery

Deliver only when every check has no `block`; read and explain each `warning` / `difficult`; for each exception, state why it is an exception, what evidence supports it, and when it stops holding. Otherwise, do not deliver.

## Project selection

**There is no default project.** Every CAD tool that needs a corpus — everything except `cad_session` (`info` / `init` / `bind`) — refuses until this session selects one:

```text
No CAD project is selected. There is no default cwd/root:
pass cad_session({action:"bind", args:{dir:"..."}}) or cad_session({action:"init", args:{dir:"..."}}), then retry.
```

- `cad_session` (`bind`) selects an EXISTING project marker. `dir` is required; nothing is copied or moved.
- `cad_session` (`init`) creates only `cad-data/project.json`; it also selects the new project when the session is unbound. If a project is already selected it does not rebind.
- `cd` never switches the project; the selection is fixed for the session. `cad_session` (`info`) reports `selected`, `boundRoot`, `mismatch`, `ambiguous`, `workspace`.
- A workspace root (`cad-workspace.json`) is a container, never a write target.
- The panel has no "follow session" mode: the project path is chosen explicitly; an empty path shows "no project selected" and reads nothing.

If a task needs two projects, a moved project, or a shared corpus, stop and tell the user this is the C/D gap; work inside one selected project.

## Reading errors

- `invalid arguments: …` — the argument shape is wrong and the message names the path (`"parts[0].position"`, `"versionId" must be a string`). Fix that path.
- `unknown version "v999"` — pass a version id (`vNNN`), not a part id (`p001`) or a run id (`r044`).
- `tool "X" returned invalid output: …` — the tool's return violates its own contract. Retry will not change it; switch to the atomic tool in the same group or report a tool bug.
- A rejected manifest carries path + expected + a minimal example. Fix the named path and write again through `cad_assembly` (`write`).

## Router

| The question sounds like | Reach for |
| --- | --- |
| "make / change / reshape a part", "try another version" | `cad_part` (`generate`) |
| "use this STL/STEP someone sent me", "bring in a bought part" | `cad_part` (`import`) |
| "treat the whole machine as one body", "does it topple", "whole-assembly mass/CoM" | `cad_part` (`merge`) |
| "is it watertight", "do these two parts overlap", "what's the gap" | `cad_assembly` (`validate`) |
| "will it topple", "does it rest stably", "does the hinge hold", "does it sink" | `cad_simulate` (`physics`) |
| "does the mechanism move correctly", "what's the stroke", "does it jam mid-travel" | `cad_simulate` (`motion`) |
| "how strong is it", "where does it break", "stress at this section" | `cad_simulate` (`stress`) |
| "where should I look", "any sharp internal corner", "is this mesh clean" | `cad_inspect` (`attention`) |
| "the whole set looks crude", "where are the razor edges / blunt ends", "is it the right proportion", "do the parts line up" | `cad_check` (`appearance`) — assembly manifest; add `budgetPath` for the declared envelope |
| "I need to deliver this printed part", "is the D hole really a D hole" | `cad_see` (`review`) — top+iso, plus a section for an internal feature (`{axis:"y", atMm:18}` or `{axis:"y", fraction:0.68}`) |
| "does liquid fill it", "where are the dead zones", "does it drain" | `cad_simulate` (`fluid`) |
| "channel/duct flow numbers", "velocity profile vs Poiseuille at this Re" | `cad_simulate` (`lbm`) — box walls only |
| "how big / how many holes / is it watertight", whole-part numbers | `cad_inspect` (`measure`) `kind="part"` |
| "how long along a diagonal", "which point is the top" | `cad_inspect` (`measure`) `kind="part"` + `axis` / `axisVector` |
| "where are the holes", "what features", geometry you did not draw | `cad_inspect` (`features`) |
| "how thick is this wall", "what is behind this face", "gap along this line" | `cad_inspect` (`measure`) `kind="thickness"` |
| "hole spacing in this plane", "wall thickness in a cut", "angle in a section" | `cad_inspect` (`measure`) `kind="section"` |
| "hole spacing", "wall thickness here", "gap at this spot" | `cad_inspect` (`measure`) `kind="gap"` with point or datum endpoints |
| "how close do these two get", "minimum gap", "nearest point to this sphere" | `cad_inspect` (`measure`) `kind="gap"` with solid or sphere endpoints |
| "what angle is this", "are these faces parallel", "how far off axis is this bore" | `cad_inspect` (`measure`) `kind="angle"` |
| "does the declared interface hold", "check the BOM's tolerances" | `cad_assembly` (`check`) |
| "is the evidence fresh?", "what is still unobserved?" | `verify` (read-only); depth in `docs/llm/verify.md` |
| "write/update the assembly contract", "add an interface" | `cad_assembly` (`write`) |
| "can this actually be printed", "is this wall too thin", "will it need supports" | `cad_check` (`printability`) |
| "laser/waterjet cut: is this hole too small, wall too thin, holes too close after kerf" | `cad_check` (`sheet2d`) — section of a flat part with declared kerf/limits |
| "can this be turned from bar stock; does it fit the L/D/symmetry" | `cad_check` (`turning`) — bar Ø / L/D / rotational symmetry |
| "can a 3-axis mill reach this pocket/undercut; how many setups" | `cad_check` (`cnc`) — six principal directions + setup count |
| "can a sinker EDM electrode reach this cavity along one axis" | `cad_check` (`edm`) — single burn axis line of sight |
| "screen a family at once", "which of these parts is thin" | `cad_check` (`parts`) — one run per part |
| "is this one part or floating fragments", "shells > 1 warning" | `cad_inspect` (`measure`) `kind="part"` (`bodies` / `bodySizes` / `bodyVerdict`) |
| "what anchors does this version have", "I forgot a datum", "rename/add an anchor" | `cad_assembly` (`datums`) |
| "look from another angle / cut it open" | `cad_see` (`render`) |
| "give this version a color/material design" | `cad_part` (`appearance`) — GLB sidecar; STL carries no color |
| "the reference image is gone from my context" | `cad_see` (`reference`) |
| "the user is only talking about a part", no geometry yet | `cad_part` (`create`) |
| "before I claim this is delivered" | `cad_deliver` (`plan`) → follow `next` → `cad_deliver` (`audit`) with claims |
| "what is missing / what should I run next?" | `cad_deliver` (`plan`) — read-only, one row per gap |
| "the human should look at this", "ask them to review", "propose a rollback" | `cad_session` (`review`) |
| "what did v030 look like", "how did this change" | the panel's version gate + compare, or `cad_session` (`review`) with `items` |
| "a check no CAD tool covers" (FEM, optimisation, a custom metric) | `cad_python` (`run`) |
| "the runtime is missing / broken / I want it warm" | `cad_python` (`runtime`) |

**`cad_inspect` (`measure`) five kinds:** whole-part numbers → `kind="part"` (add `axis` / `axisVector` to project). "How far apart are two things" → `kind="gap"`, where you name both endpoints in the same family: solid (`aVersionId`/`bVersionId`), sphere (`aSphere`/`bSphere`), point (`aPoint`/`bPoint`) or datum (`aDatum`/`bDatum`). Renders carry no coordinates: get them from `cad_inspect` (`features`) first; when you cannot name a point, `kind="thickness"` takes a line.

**`cad_assembly` (`validate`) vs (`check`):** `validate` is ad-hoc (parts + poses → interference/clearance); `check` is contractual (manifest → declared interfaces + undeclared adjacency).

**An imported part is an ordinary version.** Every row applies; it becomes an interface endpoint once it declares datums.

## Conventions

- **Millimetres, z-up.** No tool takes a unit argument.
- **Datums** are declared `datum("name",[x,y,z])` at top level in final world coordinates; they do not affect the mesh. `datum_axis` / `datum_plane` / `datum_cyl` take `(name, point, dir)` — point first. `cad_assembly` (`datums`) lists or records; recording creates a new metadata version (mesh copied, no recompile), so point the manifest at the returned id.
- **The manifest** is `<workspace>/assembly/assembly.json` by default. Edit it through `cad_assembly` (`write`): that call validates the schema, versions and endpoints, then seals the revision.
- **BOSL2** is an OpenSCAD modelling library, not the standard-parts catalogue. Use it from `cad_part` (`generate`) with `scadCode` (`std`, `screws`, `gears`, `walls`, `threading`, `sliders`, `ball_bearings`) instead of hand-rolling a thread, gear or fillet.
- **Standard parts** ship as a catalogue but are not tool-exposed in this preview. When the user gives a `library/parts/…/fit/model.step` path, import it as `stock`; read `docs/llm/library.md` before answering catalogue questions.
- **`judge` / `scan` / `both`:** `judge` (default) returns the verdict; `scan` returns the field with no verdict; `both` returns both. The run report always records both halves. In `judge`, the reply still carries `nextLook` (`{tool, args, why}`).
- **Runtime:** measuring, checking and simulating use the pinned Python runtime (`cad_python` (`runtime`) provisions/repairs it; `cad_python` (`run`) shares it). `cad_deliver` (`audit`), `cad_part` (`create`), `cad_assembly` (`datums`), `cad_see` (`render`) and `cad_see` (`reference`) do not need it; `cad_assembly` (`check`) does.
- **Images are the largest context spend.** Give a new or reshaped part all four views; give a numeric iteration `views: ["iso"]`. The user's reference image is pruned first, so recall it before claiming a match.

## Discipline

- Fix watertightness first; assemble, measure and simulate only watertight versions.
- Make each part one connected solid: union touching bodies or model them as separate parts.
- Match the interface operator to the run kind; a motion-clearance interface needs a motion run that cites the delivered versions.
- Read the newest run for a subject; a newer run supersedes the older one, while older runs stay readable as history.
- Start with rigid checks (seconds) before fluid runs (minutes). Read the interference timeline and stroke; for skew surfaces measure point-to-point, for parallel faces measure clearance.

## Depth

| Job | Skill | Long-form |
| --- | --- | --- |
| mechanism / rigid bodies / flow | `cad-simulation` | `docs/llm/engines.md` |
| assembly contracts, datums, fit | `cad-assembly` | `docs/llm/assembly.md` |
| authoring, importing, measuring | `cad-modeling-measure` | `docs/llm/modeling.md` |
| can it be made / process profiles | `cad-manufacturing` | `docs/llm/manufacturing.md` |
| conventions / delivery / traps | this file | `docs/llm/conventions.md` · `delivery.md` · `traps.md` |
| freshness, claims, custom checks | — | `docs/llm/verify.md` |
| process ids and evaluator status | — | `docs/llm/processes.md` |
| standard-parts catalogue | — | `docs/llm/library.md` |

Parameters and minimal calls: `docs/TOOL-CONTRACTS.md` (generated; do not hand-edit). Fields not listed there do not exist.
