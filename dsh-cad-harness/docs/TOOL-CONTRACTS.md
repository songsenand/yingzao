# Tool contracts (generated — do not edit by hand)

> `node scripts/audit-tool-contracts.mjs --write`

> **Call surface:** production exposes 9 surfaces; each section below documents an internal op. Call the `Model-facing call` surface/action, not the section heading.

## `affected_checks`

Model-facing call: `cad_deliver` action `affected` (this section documents the internal op).

Return, per changed/newest version, which part-level checks already cite it (fresh) and which only cite an older version (stale), plus the atomic calls that would refresh it. This is the INCREMENTAL half of delivery_audit: the audit says the corpus is incoherent, this says which checks the change actually invalidated. Manifest-level checks (assembly/motion) stay in deliver plan — their freshness depends on the contract, not one version.

| parameter | type | default | meaning |
|---|---|---|---|
| `changed` | array | — | Version ids that changed. Omit to use the newest version of every part. |

```js
cad_deliver({ action: "affected", args: { changed: [] } })
```

returns: `changedVersionIds`, `parts`, `summary`


## `analyze`

Model-facing call: `cad_inspect` action `analyze` (this section documents the internal op).

EXPERIMENTAL — do not base a delivery claim on this yet. The POINT map is thin-wall (lower side) + reentrant corners + (when `stressRunId` is given) STRENGTH from that stress run; PRINT overhang and thick-wall are PER-PART facts (area / thickness), never points — scoring them per sample painted whole rims red and buried the real corner signals (fixed 2026-10-21). The remaining caveats: the print-overhang fact is AREA-based, not mass-based; `support` is a mass-based estimate not verified on real prints; the |u| bands are declared, not calibrated. Build the risk map for a version and say where to LOOK: reentrant corners + mesh health (multi-body / non-manifold / degenerate) + non-planar boolean seams (scan_attention) + measured wall thickness (thin side), each normalised to |u| in [0,1] against its own DECLARED band (dead band + saturating scales; a one-sided quantity is an open band), then fused as max|u| plus an agreement count. When `stressRunId` is given, that run's local stress peaks also enter as `strength-concentration` at |u|=0.5 (a LOOK, not a risk); the absolute `strength` layer may be silent. Overhang area / thick-wall are reported once per part in `partNotes`; the mass-based unsupported regions are in `support`. It never gates and never returns a verdict: a peak means "look here", not "this will break". Every peak carries a runnable `probe` (measure section) and `look` (render_part section) at its Z — a coordinate without a next action is not attention guidance. Comfortable regions are dropped, so an empty peak list means "nothing stands out", NOT "safe".

| parameter | type | default | meaning |
|---|---|---|---|
| `versionId` | string | **required** | Saved version id, e.g. "v069". |
| `cellMm` | number | — | Clustering cell for peaks (default 8 mm). |
| `wallMinMm` | number | — | Wall band lower edge (default: the declared profile's wallMinMm, else 1.2 mm — and the reply says which). |
| `wallMaxMm` | number | — | Wall band upper edge — thick masses are counted per part in `partNotes.thickSamples` (default 4.0 mm, a DECLARED heuristic, not a measurement); they are NOT scored as points. |
| `profileIds` | array | — | Process profiles to take the wall band from (same meaning as in check_printability). Omit and the band source says "no profile" — an unsigned threshold, which DESIGN §27.1 exists to prevent. |
| `stressRunId` | string | — | Optional stress run id (kind "stress") for this version. Its von-mises field is fused as the STRENGTH layer, normalised by that run's declared warnAt/badAt. Without it strength is `notMapped` — absence is not 0. The run must cite this version. |
| `dxMm` | number | — | Voxel size for the support estimate (default 1.0 mm). |
| `minMassG` | number | — | Unsupported MASS above which a hanging region is reported (default 1.0 g, declared). A 0.2 g sliver is free. |
| `bridgeMaxMm` | number | — | Horizontal span a printer can bridge without support (default 10 mm, declared). |

```js
cad_inspect({ action: "analyze", args: { versionId: "…" } })
```

returns: `peaks`, `layers`, `notMapped`, `partNotes`, `stress`, `support`, `bands`, `note`, `timings`


## `attach_appearance`

Model-facing call: `cad_part` action `appearance` (this section documents the internal op).

Attach a self-contained GLB color/material design to a saved version as a sidecar. The version keeps model.stl as geometry truth; the GLB is stored as versions/<id>/appearance.glb + appearance.json for external viewers and future panel work. There is no Blender/bpy render path and the panel still previews STL. The GLB must be v2, contain at least one mesh and one material, and embed its buffers/images.

| parameter | type | default | meaning |
|---|---|---|---|
| `versionId` | string | **required** | Saved version to attach the appearance to, e.g. "v003". |
| `file` | string | **required** | Workspace path to a self-contained .glb (GLB v2, embedded buffers/images). |
| `note` | string | — | Optional human note recorded in appearance.json (e.g. "three-color panel"). |

```js
cad_part({ action: "appearance", args: { versionId: "…", file: "…" } })
```

returns: `versionId`, `file`, `sha256`, `bytes`, `materials`, `meshes`, `replaced`, `note`


## `bind_project`

Model-facing call: `cad_session` action `bind` (this section documents the internal op).

Explicitly select an EXISTING project by path before any CAD tool. There is NO default cwd/root: if no project is selected, CAD tools refuse and ask for this call. It never creates a marker (use init_project for that), never copies/moves a corpus, and refuses to rebind an already-selected session — a wrong target is fixed by a new session, not by moving data after the fact.

| parameter | type | default | meaning |
|---|---|---|---|
| `dir` | string | **required** | Existing project root (absolute, or relative to the live cwd). Required: there is no default. |

```js
cad_session({ action: "bind", args: { dir: "…" } })
```

returns: `root`, `marker`, `boundAt`, `note`


## `check_appearance`

Model-facing call: `cad_check` action `appearance` (this section documents the internal op).

Appearance screen over a whole SET (assembly manifest), never a single part: proportion, alignment and repetition are relations, and a part-level report is mostly invalid because the assembly hides 29-39% of its sharp edges (measured). Read-only: it never changes geometry, never scores "beauty", and never claims a part is attractive — it reports WHERE a declared visual rule is violated and by how much. Three rules: visible convex sharp-edge LENGTH (not count: a fillet adds short segments, so the count rises while the length falls); TERMINATION (a flat cap at the end of a slender member whose boundary is all 90 degrees — the "just cut off" signature); and SILHOUETTE descriptors (width profile, waists, top-vs-base ratio, symmetry) which are ATTENTION ONLY. Visibility is sampled from N viewpoints; clusters seen from fewer than the threshold are counted, never silently dropped. Caps inside a declared axis/cylinder datum (datums.json) are functional openings and are exempted by name. Purchased/reference parts occlude but are never judged. VERDICT: without a declared budget (budgetPath) or a declared maxVisibleSharpMm the verdict is "check" and only the numbers are returned — running on an existing project without declaring one of them tells you how rough it is, never that it is acceptable. mm, z-up.

| parameter | type | default | meaning |
|---|---|---|---|
| `manifestPath` | string | — | Assembly manifest, e.g. "assembly/assembly.json". A relative path resolves against the session workspace first, then the plugin data root. |
| `mode` | string (judge \| scan \| both) | — | "judge" (default) returns the numbers + findings; "scan" returns only the attention layer (where to look, never a verdict); "both" returns the two halves separately. |
| `maxVisibleSharpMm` | number | — | Declared budget for visible convex sharp-edge length, mm. Omit and the verdict is "check" — a missing threshold is not a pass. |
| `cellMm` | number | — | Clustering cell for sharp edges, mm. Default 10. |
| `views` | number | — | Visibility viewpoints. Default 12. |
| `visibilityThreshold` | number | — | Fraction of views that must see a cluster for it to be reported. Default 0.25. |
| `minFeatureMm` | number | — | Caps smaller than this in any direction are surface texture, not form ends. Default 1.5. |
| `budgetPath` | string | — | Optional assembly/budget.json: per-group envelope {x,y,z:[lo,hi]}. A GROUP IS A PARTITION OF PARTS (the manifest `group` field), never a spatial region; its envelope is measured as the union of its members. At most one group per part, and a small part may have none. |

```js
cad_check({ action: "appearance", args: { manifestPath: "…" } })
```

returns: `scope`, `manifest`, `parts`, `verdict`, `judgement`, `attention`, `budget`, `note`


## `check_assembly`

Model-facing call: `cad_assembly` action `check` (this section documents the internal op).

Validate the assembly manifest (BOM + interface contracts): distance (datum-kind aware: plane/plane → perpendicular distance, plane/point → point-to-plane, otherwise point-to-point), diameter-match and coaxial (axis-to-axis offset between datum_axis/datum_cyl endpoints) checks, motion-clearance (static distance plus the motion run you cite in params.runId), spring-preload (stiffness × deflection from the measured installed length), spring-behaviour (axial spring: installed/free/deflection/force with an order-of-magnitude band, direction, solid-height, travel, force at the travel endpoint, buckling attention, optional standardId from the seed catalog, and a USER-DECLARED forceBudgetN/tolerance comparison; no built-in product thresholds), snap-fit (卡扣: lobe beam model → radial force, wedge-model insertion, root strain, self-lock; L1 headline + worst + nextLook, L2 via detail: "checks"; all limits user-declared), plus a discovery pass for undeclared near-touching pairs. Declared `features` (v1: hole-pattern) are CHECKED against the version mesh — never generated from the declaration; a missing/off-PCD/wrong-diameter hole is a feature failure, and the feature of a BOM-only stock part is skipped (not a pass). Nodes accept transform.pose {datum, angleDeg} to rotate a part about its own datum axis (assembly/meshing pose) with the datums following. Interfaces with no implementable operator OR no declared tolerance come back in `skipped` with what would make them checkable — a missing criterion is not a pass. A structurally invalid manifest is rejected with path-addressed issues and a minimal example (schema: schemas/assembly-manifest.schema.json). mm, z-up. A relative manifestPath resolves against the session workspace first, then the plugin data root.

| parameter | type | default | meaning |
|---|---|---|---|
| `manifestPath` | string | — | Path to the assembly manifest JSON. Relative paths are tried against the session workspace (e.g. "assembly/assembly.json" → <workspace>/assembly/assembly.json, which the agent can write) and then against the plugin data root; an absolute path is used as given. Defaults to "assembly/assembly.json". |
| `adjacencyThresholdMm` | number | — | How close counts as "near" in the undeclared-adjacency discovery pass, mm. Default 0.75. Raise it (1.5–2) when the design keeps deliberate clearance gaps you want to see listed; a pair is reported when it interferes OR its gap is below this value. |
| `detail` | string (summary \| checks) | — | Default summary: one headline + worst + nextLook per interface (the attention layer). checks: append the L2 utilization rows (insertion/retention/strain/self-lock) for snap-fit. Raw beam inputs/outputs stay in the run report. |

```js
cad_assembly({ action: "check", args: { manifestPath: "…" } })
```

returns: `overallStatus`, `judgement`, `judgedBy`, `manifestPath`, `contractRevision`, `contractHash`, `adjacencyThresholdMm`, `summary`, `features`, `hardViolations`, `intentFlags`, `skipped`, `undeclared`


## `check_cnc_access`

Model-facing call: `cad_check` action `cnc` (this section documents the internal op).

CNC 3-AXIS ACCESS SCREEN: sample the mesh and test visibility from ±X/±Y/±Z; report the area reachable from no principal direction and the minimum number of principal setups (greedy cover), against a declared maxSetups. Inaccessible area is a warning unless requireAllAccessible is true. It does NOT model oblique setups, tool length/diameter, collision, fixture rigidity or chatter — those are handoffs. Use together with the cnc-3axis printability profile (wall + circular bores).

| parameter | type | default | meaning |
|---|---|---|---|
| `versionId` | string | **required** | Saved version to screen, e.g. "v012". |
| `maxSetups` | integer | — | Declared maximum number of principal setups. Default 6 (the six principal directions); declare fewer only if that is a real machine/fixture limit — exceeding it then excludes, which is a declared capability, not a geometric impossibility. |
| `requireAllAccessible` | boolean | — | true = any inaccessible area is a witness; false = warning. Default false. |
| `sampleLimit` | integer | — | Max sampled triangles; default 300, capped at 600 (each sample is 6 ray casts). |

```js
cad_check({ action: "cnc", args: { versionId: "…" } })
```

returns: `versionId`, `verdict`, `witnesses`, `findings`, `unevaluable`, `metrics`, `params`, `sealedCavities`, `runId`


## `check_edm_access`

Model-facing call: `cad_check` action `edm` (this section documents the internal op).

EDM SINKER ELECTRODE ACCESS: sample the mesh and test the line of sight along ONE burn axis (x|y|z, leading "-" flips it). Reports the area whose first surface hit is itself (reachable) vs occluded (inaccessible). Inaccessible area is a warning unless requireAllReachable is true. It does NOT model electrode shape/side-burn/undercut, wear, minimum feature or surface finish — those are handoffs.

| parameter | type | default | meaning |
|---|---|---|---|
| `versionId` | string | **required** | Saved version to screen, e.g. "v012". |
| `burnAxis` | string | — | Burn axis: x \| y \| z, optional leading "-" (e.g. "-z"). Default z. |
| `requireAllReachable` | boolean | — | true = any occluded area is a witness; false = warning. Default false. |
| `sampleLimit` | integer | — | Max sampled triangles; default 300, capped at 1000. |

```js
cad_check({ action: "edm", args: { versionId: "…" } })
```

returns: `versionId`, `burnAxis`, `verdict`, `witnesses`, `findings`, `unevaluable`, `metrics`, `params`, `runId`


## `check_parts`

Model-facing call: `cad_check` action `parts` (this section documents the internal op).

Screen up to 12 saved versions in ONE call: per version, the measure half (watertight / bodies / volume / bbox) and the SAME profile-aware printability job as check_printability. The printability half writes one printability run per version and returns its runId, so the rows can back a delivery claim; there is no second implementation. Use it to screen a family (which of these 7 is thin?) instead of N single calls; for one part the single tool is equivalent. `checks` defaults to both halves. The reply is deliberately compact — run the single-part tool when you need the full findings/attention for one part.

| parameter | type | default | meaning |
|---|---|---|---|
| `versionIds` | array | **required** | Versions to screen, e.g. ["v031","v032","v033"]. Duplicates are removed; at most 12 are screened per call. |
| `checks` | array | — | Which halves to run: "measure" and/or "printability". Default both. |
| `profileIds` | array | — | Process profiles for the printability half: shipped ids, or a project-local profiles/<id>.json. Omit to use the built-in fallback (which downgrades a pass, as in check_printability). |
| `profilesJson` | string | — | Inline JSON array of process profiles for the batch — the batch used to accept only shipped ids, forcing N single calls for a custom CNC profile. |
| `edgeOnlyThinPct` | number | — | Printability half: thin area at or below this % is a sharp-edge artefact, not a shell. Default 1.0; 0 disables. |
| `wallMinMm` | number | — | Wall thinner than this is reported (printability half). Default 1.2. |
| `overhangDeg` | number | — | Down-facing faces steeper than this count as print-overhang (FDM support, printability half; NOT structural overhang/self-weight stress). Default 45. |
| `printOrientationDeg` | array | — | G6 (2026-10-29): the PRINT orientation as [rx,ry,rz] degrees (Rz·Ry·Rx), applied before the overhang/wall analysis. The modelling pose is not the printing pose — declare it; the reply's overhang/witness numbers are then in the printed frame. |
| `samples` | number | — | Approximate surface samples for the wall half. Default 600. |

```js
cad_check({ action: "parts", args: { versionIds: [] } })
```

returns: `parts`, `failures`, `summary`


## `check_printability`

Model-facing call: `cad_check` action `printability` (this section documents the internal op).

Manufacturability screen for a saved version: sampled wall thickness (ray to the opposite wall along the inward normal) plus exact print-overhang area (FDM support; NOT structural overhang/self-weight stress) steeper than the print-overhang angle. The wall half is SAMPLED (a thin feature between samples is missed); the print-overhang area is exact. PRINT overhang is a support COST, reported as a finding: it gates the verdict only when the process profile declares `overhangDeg.hard: true` (no supports / visible surface / trapped cavity); otherwise a supported FDM part can be not-excluded. If wallMeasured is false the ray half measured nothing, so the verdict is never "ok". Run it before delivering and after any wall/angle-changing edit. Judge against a DECLARED process via `profileIds` (e.g. ["fdm-pla-0.4"]) or `profilesJson`: each profile returns "excluded" (with a witness: rule, location, measured vs required) or "not-excluded" — NOT-EXCLUDED IS NOT "CAN BE MADE". It never ranks or recommends. With no profile it uses a named built-in fallback (all numbers `assumed`) and downgrades ok to check. Authoring a profile: cad-manufacturing skill. JUDGEMENT vs DETECTION: this tool produces both halves; pass `mode` to get one. A green verdict says nothing about where to look, and the attention field is not a verdict (DESIGN §25.7).

| parameter | type | default | meaning |
|---|---|---|---|
| `mode` | string (judge \| scan \| both) | — | "judge" (default) returns ONLY the judgement half (verdict / findings / profiles, no attention field); "scan" returns ONLY the attention field and NO verdict, because a risk map must never be read as a gate; "both" returns the two halves as separate keys. The run ALWAYS records both halves (report.json + attention.json) — the mode trims the reply, not the record (DESIGN §25.7). |
| `versionId` | string | **required** | Saved version id to screen, e.g. "v012". |
| `wallMinMm` | number | — | Wall thinner than this is reported. Default 1.2 (≈2× a 0.4mm nozzle line width). |
| `overhangDeg` | number | — | A down-facing face tilted more than this many degrees from vertical counts as print-overhang (FDM support, NOT structural overhang/self-weight stress). Default 45. The area is reported as a support-cost finding; only a process profile with overhangDeg.hard=true lets it gate the verdict. |
| `printOrientationDeg` | array | — | The PRINT orientation as [rx,ry,rz] degrees (Rz·Ry·Rx), applied before the overhang/wall analysis. The modelling pose is not the printing pose — declare it (e.g. [180,0,0] for a part printed upside down); the reply's overhang/witness numbers are then in the printed frame. Absent = modelling pose. |
| `samples` | number | — | Approximate surface samples. Default 600; raise for big meshes, lower for quick passes. |
| `edgeOnlyThinPct` | number | — | Thin area at or below this % of surface is classified as a solid sharp-edge artefact, not a thin shell (default 1.0; 0 disables). A shell is sustained area; a deburring edge is a strip. |
| `profileIds` | array | — | Shipped process profiles to judge against, e.g. ["fdm-pla-0.4"]. Each yields its own two-valued verdict. Omit (with profilesJson) to use the built-in fallback, which the report then names. |
| `profilesJson` | string | — | An inline JSON array of process profiles (schema: schemas/process-profile.schema.json). Use for a profile you authored; an invalid one is REFUSED with the offending rule named. |

```js
cad_check({ action: "printability", args: { versionId: "…" } })
```

returns: `versionId`, `nextLook`, `verdict`, `minWallMm`, `wallMeasured`, `thinSamples`, `sampled`, `thinAreaMm2`, `thinAreaPct`, `edgeOnlyThinPct`, `surfaceAreaMm2`, `overhangAreaMm2`, `printOrientationDeg`, `overhangZRange`, `findings`, `minWallAtMm`, `watertight`, `attention`, `profileSource`, `profiles`


## `check_sheet2d`

Model-facing call: `cad_check` action `sheet2d` (this section documents the internal op).

2D CUT SCREEN for a flat sheet/plate part: section it at mid-thickness (axis/fraction) and check round-hole diameter, hole-to-outside wall and hole-to-hole spacing AFTER the kerf. Inputs are declared: kerfMm, minHoleMm, minFeatureMm, minSpacingMm — no silent defaults. It does NOT check non-circular hole width, outer tabs, flat pattern/K-factor, heat-affected zone or taper. With bendLines it also checks hole-to-bend distance, min flange and a bend-relief heuristic; flat pattern/K-factor remain handoffs. A `not-excluded` result is a section-level screen, not a cut certificate.

| parameter | type | default | meaning |
|---|---|---|---|
| `versionId` | string | **required** | Saved flat version to section, e.g. "v012". |
| `axis` | string | — | Plane normal: x \| y \| z (leading "-" flips it). Default z. |
| `fraction` | number | — | Where to cut across the axis, 0..1. Default 0.5 (mid-thickness for a plate). |
| `atMm` | number | — | Explicit cut position in mm; wins over fraction. |
| `kerfMm` | number | **required** | Cut kerf to subtract from every measured hole/feature, mm. |
| `minHoleMm` | number | **required** | Smallest acceptable round-hole diameter after kerf, mm. |
| `minFeatureMm` | number | **required** | Smallest acceptable hole-to-outside wall after kerf, mm. |
| `minSpacingMm` | number | **required** | Smallest acceptable hole-to-hole clearance after kerf, mm. |
| `bendLines` | array | — | Optional bend lines in the section u/v frame: [{from:[u,v], to:[u,v]}]. Enables bend checks. |
| `minHoleToBendMm` | number | — | Minimum hole-centre to bend-line distance, mm (needs bendLines). |
| `minFlangeMm` | number | — | Minimum flange from the bend line to a free edge, mm (needs bendLines). |
| `minBendReliefMm` | number | — | Max distance from a bend-line end to a free edge/hole before it counts as "no relief", mm (needs bendLines). |

```js
cad_check({ action: "sheet2d", args: { versionId: "…", kerfMm: 0, minHoleMm: 0, minFeatureMm: 0, minSpacingMm: 0 } })
```

returns: `versionId`, `axisMm`, `atMm`, `uAxisMm`, `vAxisMm`, `verdict`, `witnesses`, `findings`, `unevaluable`, `metrics`, `params`, `section`, `runId`


## `check_sweep`

Model-facing call: `cad_check` action `sweep` (this section documents the internal op).

Early sweep screen for ONE moving version against static versions over a DECLARED joint range. A continuous swept AABB envelope drops pairs that cannot touch; coarse closest-point clearance samples are then refined where clearance is below 2×minFeature, until the arc step is <= minFeature/2 or the sample budget is exhausted (then UNCOVERED, never clean). Returns SUSPECTS, not a delivery verdict: a positive clearance is not a pass, and simulate_motion remains the pass/fail evidence. Use it before building a motion run to find a swing/stroke collision early.

| parameter | type | default | meaning |
|---|---|---|---|
| `versionId` | string | **required** | The MOVING part (saved version id). |
| `againstVersionIds` | array | **required** | Static versions to screen against (at least one). |
| `joint` | object | **required** | The declared sweep: revolute (degrees) or prismatic (mm) about/along a world axis and anchor. |
| `minFeatureMm` | number | — | The smallest feature that must not be stepped over. Default 0.5. The refinement target is half of it. |
| `maxSamples` | number | — | Sample budget per pair. Default 48; when exhausted the pair is UNCOVERED, not clean. |
| `clearanceThresholdMm` | number | — | Clearance at or below this is a collision. Default 0 (touching). |

```js
cad_check({ action: "sweep", args: { versionId: "…", againstVersionIds: [], joint: {} } })
```

returns: `moving`, `joint`, `rows`, `overall`, `rule`, `notes`


## `check_turning`

Model-facing call: `cad_check` action `turning` (this section documents the internal op).

TURNING SCREEN: fit the declared bar stock diameter, check length/diameter against a declared L/D limit, and measure rotational-symmetry deviation about the declared spindle axis (axes through the bbox centre). No silent defaults: barDiameterMm, maxLdRatio and symmetryToleranceMm are required. It does NOT measure undercut/tool access along the profile, chatter, surface finish or bar-feeder limits — those are handoffs. A non-symmetric part is a warning (secondary milling/mill-turn), not automatically excluded unless requireSymmetry is true.

| parameter | type | default | meaning |
|---|---|---|---|
| `versionId` | string | **required** | Saved version to screen, e.g. "v012". |
| `spindleAxis` | string | — | Spindle axis: x \| y \| z. Default z. |
| `barDiameterMm` | number | **required** | Declared bar-stock diameter, mm. |
| `maxLdRatio` | number | **required** | Declared maximum length / diameter (L/D). |
| `symmetryToleranceMm` | number | **required** | Allowed rotational-symmetry deviation, mm. |
| `requireSymmetry` | boolean | — | true = symmetry deviation is a witness (excluded); false = warning only. Default false. |

```js
cad_check({ action: "turning", args: { versionId: "…", barDiameterMm: 0, maxLdRatio: 0, symmetryToleranceMm: 0 } })
```

returns: `versionId`, `spindleAxis`, `verdict`, `witnesses`, `findings`, `unevaluable`, `metrics`, `params`, `runId`


## `create_part`

Model-facing call: `cad_part` action `create` (this section documents the internal op).

Name a part before any geometry exists; idempotent. generate_part creates a part automatically, so call this only to open a subject the user has merely talked about.

| parameter | type | default | meaning |
|---|---|---|---|
| `name` | string | **required** | The name a human would call it, e.g. "调焦轴". Used as the part label in the panel. |

```js
cad_part({ action: "create", args: { name: "…" } })
```

returns: `partId`, `name`, `created`


## `deliver`

Model-facing call: `cad_deliver` action `plan` (this section documents the internal op).

Read-only delivery PLAN derived from the BOM/ICD, parts roles, claims and the run graph. Returns per-target rows (part printability/review, interface contract/joint, assembly interference, claims): status, witness run/check, where to look, and the atomic tool call that would fill a gap. `planVerdict` is scoped to the BOM's process (`source:user`, or an agent recommendation the user confirmed) or the argument; `corpusVerdict` is the corpus audit — when they differ, the plan names it (usually the audit is counting a run under another process). Process decisions are BATCHED, not per part: the BOM `manufacturing` policy (a user-approved allowed set) plus one `M:mix` summary cover every part; the agent assigns each part from the allowed set. Only a part outside the set becomes one exception question. An unconfirmed policy/recommendation is `unobserved` — the plan asks once, never N times. Allowed ids come from the process catalog: each is tagged [supported|partial|planned]; a planned process (e.g. laser-cut-sheet, die-casting) has a defined method/criteria/inputs but no evaluator yet — its parts are `unobserved` with that method, never checked with a printability profile. This tool DOES NOT run CAD, write runs or decide delivery: a plan pass is not a claim. A missing process/profile/run is `unobserved` with the declaration or call that would fill it — never a silent pass. Use it before delivery to see the whole board, then run the named tools; use `verify`/`delivery_audit` for the gate.

| parameter | type | default | meaning |
|---|---|---|---|
| `process` | string | — | User-confirmed process/profile override for printed parts (e.g. injection-pp, fdm-pla-0.4). The BOM's per-part or root `process` is preferred; omit this unless you are confirming on the user's behalf. |

```js
cad_deliver({ action: "plan", args: { process: "…" } })
```

returns: `planVerdict`, `corpusVerdict`, `process`, `processSource`, `summary`, `rows`, `gaps`, `next`, `verification`


## `delivery_audit`

Model-facing call: `cad_deliver` action `audit` (this section documents the internal op).

Audit the corpus before delivering: failing runs that are still the newest of their kind, parts whose newest version no run ever checked, runs citing superseded geometry (stale evidence), contract gaps (e.g. no motion-clearance interface while the assembly has several parts), contract nodes pointing at replaced versions, repeated runs that add no information, and mesh files on disk that NO version accounts for (a part written straight to a file never reaches the panel or any tool — a human cannot see it). Run this BEFORE any delivery claim; a blocked verdict means the corpus itself contradicts the claim.

| parameter | type | default | meaning |
|---|---|---|---|
| `manifestPath` | string | — | Assembly manifest to audit against. Defaults to assembly/assembly.json in the session workspace. |
| `claims` | array | — | Delivery CLAIMS to back with evidence: {kind, statement}. kind is strength \| motion \| assembly \| manufacturability \| appearance \| review \| flow. A claim with no fresh run of the kind it needs is reported as claim-without-evidence (blocked). Omit it and the audit declines to judge any delivery claim — it only says whether the CORPUS is coherent. |
| `scanPaths` | array | — | Workspace-relative roots scanned for mesh files no version accounts for. Default ["."] (whole workspace, skipping the corpus, nested projects and common build dirs); pass [] to disable. A found file NEWER than the newest version is blocked — register it with import_part or declare it exempt. |
| `exempt` | array | — | Declared exceptions for files intentionally left as files (e.g. bought/reference geometry): {path, reason}. Reported as info, never blocked, and the reason is echoed. Use it instead of narrowing scanPaths when the file is a legitimate non-version. |
| `visualReview` | string (required \| off) | — | Per-version LLM visual review gate. "required" (default): every printed part in the assembly must have a fresh top+iso review of the EXACT version (review_visual), or delivery is blocked. "off" is a declared opt-out for legacy/bench corpora and is reported as info. |

```js
cad_deliver({ action: "audit", args: { manifestPath: "…" } })
```

returns: `verdict`, `judgement`, `findings`, `summary`, `versions`, `parts`, `runs`, `contract`, `brief`, `unregistered`, `visual`


## `generate_part`

Model-facing call: `cad_part` action `generate` (this section documents the internal op).

Compile a part into a new version. Pass EITHER `scadCode` (OpenSCAD) OR `code` (CadQuery Python); exactly one is required. CadQuery scripts must leave a `result` (Workplane/Shape) or call `show_object(...)`; declare anchors with datum/datum_axis/datum_plane/datum_cyl (point first, same schema as OpenSCAD). OpenSCAD code is self-contained with $fn=64 (BOSL2 available when installed); declare datum("name",[x,y,z]) at top level in final world coordinates. G2: datum_axis/datum_plane/datum_cyl are (name, point, dir) — POINT FIRST; a swapped OpenSCAD positional call compiles silently and corrupts the contract. Renders are attached by default; trim with `views` on numeric iterations. CadQuery renders are produced by the shared STL→OpenSCAD path, never by VTK. The FIRST version of a part also gets a sampled wall screen (minWallMm + warning) — when several parts share a new feature (a slot, a snap, a thread), generate ONE representative, fix its screen, then generate the family; regenerating N parts after a shared defect costs N rounds.

| parameter | type | default | meaning |
|---|---|---|---|
| `scadCode` | string | — | Complete OpenSCAD source code. Give this OR `code`, not both. Required for the OpenSCAD kernel. |
| `code` | string | — | Complete CadQuery Python authoring script. Give this OR `scadCode`, not both. Set `result = ...` or call `show_object(...)`; datum helpers share the assembly schema. |
| `userIntent` | string | **required** | One-line summary of what the part should look like, used in the version history. |
| `parentVersion` | string | — | Version id this iteration derives from, e.g. "v003". Must belong to the same part. |
| `part` | string | — | Which part this version belongs to — the name the user would call it, e.g. "调焦轴". ALWAYS pass this when iterating: it is what groups versions into one part in the panel. Omit only for a brand-new part with no parentVersion (a name is then derived from userIntent), or to inherit the parentVersion's part. |
| `views` | array | — | Which render views to ATTACH (each attached image spends context image budget): subset of ["top","front","side","iso"]. Default: all four — right for a new shape or a shape change you need to SEE. For an iteration that only changes a number you will verify by measurement (a hole Ø, a length), pass ["iso"]. Pass [] to register the version with NO images attached — the panel still shows the geometry, so the human is not blinded. |
| `step` | boolean | — | CadQuery only: also write model.step and record BRepCheck provenance (optional; adds ~tens of KB and a STEP/STL consistency check). |
| `dryRun` | boolean | — | Compile + check WITHOUT saving: no version, no images, no part row. Reports watertight / bodies / bbox / min-wall (600 samples) and refuses to create anything. Use it when you want to probe geometry before spending a version. |
| `preflight` | boolean | — | Compile + check BEFORE saving: a version is written only when the mesh is watertight AND a single connected body; a sub-1.2mm wall is reported as a warning (legitimate thin ears must not be blocked). A refusal writes no version and no image. Default false preserves the current "failed rounds land in history" behavior. |

```js
cad_part({ action: "generate", args: { userIntent: "…" } })
```

returns: `versionId`, `saved`, `dryRun`, `preflight`, `success`, `errors`, `warnings`, `durationMs`, `views`, `sizeMm`, `bboxMin`, `bboxMax`, `watertight`, `triangles`, `shells`, `kernel`, `step`, `errorCode`, `fix`, `minWallMm`, `minWallAtMm`, `part`


## `import_part`

Model-facing call: `cad_part` action `import` (this section documents the internal op).

Import an external STL (binary/ASCII, mm z-up), STEP/STP (OpenCASCADE tessellation) or 3MF (trimesh; a 3MF must contain ONE object — a plate of objects is refused, not stored as a multi-body part) or DXF (closed 2D profiles extruded by depthMm, or 3D mesh entities) as a new version of a part, so it can be measured, assembled and simulated like any generated part. STEP and 3MF carry their own units, honored and folded to mm; STL and DXF take the declared `unit`. This is the DEFAULT landing path for geometry produced outside generate_part: a file written straight to disk is invisible to the panel and to every tool, so anything the human must see or a check must address has to become a version. Runs the same truth engine on it and REFUSES a mesh that is not a closed solid unless allowNonSolid. IGES is not readable — re-export STEP or STL instead.

| parameter | type | default | meaning |
|---|---|---|---|
| `file` | string | **required** | Path to the file; a relative path resolves against the project directory. The bytes are copied into the version, never referenced. |
| `part` | string | — | Which part to file it under (defaults to the file name). Re-importing a corrected export under the same part is how you iterate an imported part. |
| `parentVersion` | string | — | Version id this import supersedes, e.g. "v003". Must belong to the same part. |
| `userIntent` | string | — | One-line summary for the version history; defaults to "导入自 <file>". |
| `unit` | string | — | The source file's unit as DECLARED by you: mm (default), cm, m or inch. STL carries no unit, so this is never inferred. STEP self-declares (mm only accepted); DXF $INSUNITS wins when set. |
| `scale` | number | — | Extra multiplier applied on top of unit, e.g. 0.5 for a half-scale model. |
| `depthMm` | number | — | Extrusion depth in mm for DXF 2D closed profiles, e.g. 10 for a 10mm plate. Required when a DXF has no 3D mesh entities; ignored otherwise. |
| `tolLinear` | number | — | Tessellation linear tolerance for STEP/3MF, mm (ignored for STL/DXF). Default is OpenCASCADE's ~0.01; lower = more triangles. Measured: 0.01 -> 3074 triangles, 0.002 -> 12254, volume differs <0.3%. |
| `tolAngular` | number | — | Tessellation angular tolerance for STEP/3MF, radians (ignored for STL/DXF). Lower = finer around curved faces. |
| `datums` | array | — | Anchors making the imported part an assembly interface endpoint (check_assembly addresses "<partId>.<datumName>"). Coordinates are in the file's own frame, after unit/scale. |
| `allowNonSolid` | boolean | — | Store it even though it is not a closed solid (holes, T-junctions, inside-out winding); the geometric tools will then refuse this version. Default false. |
| `render` | boolean | — | Render four views into the conversation (default true, same views as generate_part). |

```js
cad_part({ action: "import", args: { file: "…" } })
```

returns: `versionId`, `part`, `format`, `solid`, `watertight`, `repaired`, `triangles`, `shells`, `genus`, `volumeMm3`, `sizeMm`, `unit`, `scaleApplied`, `sha256`, `sourcePath`, `datums`, `warnings`, `durationMs`, `views`


## `init_project`

Model-facing call: `cad_session` action `init` (this section documents the internal op).

Create a CAD project marker (`cad-data/project.json`) in an EXPLICIT directory, WITHOUT writing any version/part/run. If this session is unbound, it also SELECTS the new project (the path is the explicit choice); if already bound, it does not rebind. Use bind_project({dir}) instead for an existing marker. A directory with an existing marker is reported as created:false. A marker inside an ancestor project is reported with inheritedFrom — it shadows that ancestor for new sessions.

| parameter | type | default | meaning |
|---|---|---|---|
| `dir` | string | **required** | Directory to make a project (absolute, or relative to the session workspace). Created if missing. |
| `title` | string | — | Human title for project.json (default: the directory basename). |
| `defaultKernel` | string (openscad \| cadquery) | — | Optional project-level authoring kernel default (cad_session info reports it). |

```js
cad_session({ action: "init", args: { dir: "…" } })
```

returns: `root`, `key`, `created`, `bound`, `inheritedFrom`, `note`


## `list_features`

Model-facing call: `cad_inspect` action `features` (this section documents the internal op).

The coordinate inventory of a saved version: planar faces (normal, a point on the plane, area, centroid), the HOLES in them (centre, diameter, and whether each is through or how deep), and cylindrical surfaces (axis, diameter, length, and bore-vs-boss). Use this FIRST whenever you must measure or assemble geometry you did not generate — an imported STL, an existing corpus part — because measure_distance needs a point on a surface and this is where those coordinates come from. Each face also reports the smooth region it belongs to, so a 5.9mm² facet that is one of 64 in a 377mm² non-planar region is readable as a bore segment rather than a face. Thresholds (`minFaceAreaMm2`, `smoothDeg`) are choices and are echoed in the result, together with how many faces and curved segments were left out. Holes are detected on planar faces only. mm, z-up.

| parameter | type | default | meaning |
|---|---|---|---|
| `versionId` | string | **required** | Saved version to inspect, e.g. "v003". |
| `minFaceAreaMm2` | number | — | A planar face smaller than this is not listed as a face. Default 4.0. Raise it to cut bore-segment noise on a finely tessellated part; lower it to catch small lands. |
| `smoothDeg` | number | — | Dihedral angle below which two facets are treated as one smooth (curved) surface. Default 10 (a 64-segment bore steps 5.6°). |
| `maxFaces` | integer | — | Cap on listed faces, largest first. Default 40; the result reports facesOmitted. |
| `maxCylinders` | integer | — | Cap on listed cylinders. Default 24. |
| `withHoleDepth` | boolean | — | Probe each hole along its axis to report depth / through-hole. Default true (one ray per hole). |

```js
cad_inspect({ action: "features", args: { versionId: "…" } })
```

returns: `versionId`, `watertight`, `triangles`, `thresholds`, `faces`, `facesOmitted`, `curvedSegmentFacets`, `cylinders`, `curvedSurfaces`, `faceCount`, `holeCount`, `cylinderCount`, `warnings`


## `measure`

Model-facing call: `cad_inspect` action `measure` (this section documents the internal op).

Geometry ground truth about a saved version — one entry point, five kinds. Pick kind first:
  kind="part"      → whole-part numbers: bbox (size AND min/max), volume, area, centre of mass, triangles, watertight, genus, and the disconnected BODIES; add axis/axisVector for a projection and the two extremal vertices.
  kind="gap"       → closest distance between two geometries (points / spheres / datum faces), with the witness pair on each side.
  kind="thickness" → wall thickness at a named side, cast outward along a direction (or the inward normal) up to maxSpanMm.
  kind="section"   → the cross-section polygon loop at a fraction of an axis (area, holes, bbox).
  kind="angle"     → angle between two directions + the distance between their lines; each side is a probe point, a datum, two points, or a known vector.
All measurements are mm, z-up, and read the SAVED version: the answer is about that artifact, not about a model you are about to change. For per-feature facts (a cylinder's length, a hole's depth) use list_features instead.

| parameter | type | default | meaning |
|---|---|---|---|
| `versionId` | string | — | Saved version, e.g. "v003". Required for part / section / thickness; for gap and angle it is the default for a side whose own *VersionId is omitted. |
| `kind` | string (part \| gap \| thickness \| section \| angle) | **required** | Which measurement. Each kind reads its own parameter cluster below; fields of other kinds are ignored. |
| `aVersionId` | string | — | gap/angle: version for side a when the two sides live on different parts. Defaults to versionId. |
| `bVersionId` | string | — | gap/angle/thickness: version for side b. Defaults to versionId. |
| `axis` | string | — | part: project on x \| y \| z (a leading "-" flips it). section: the axis to slice perpendicular to. Default z. |
| `axisVector` | array | — | part: projection axis [x,y,z] for a non-principal direction (normalised internally). |
| `aSphere` | array | — | gap: side a as a sphere [x,y,z,r] — the radius is honoured, not snapped. |
| `aPoint` | array | — | gap: side a as a point [x,y,z]. |
| `aDatum` | string | — | gap: side a as a datum name (axis / cylinder / plane) declared on aVersionId. |
| `bSphere` | array | — | gap: side b as a sphere [x,y,z,r]. |
| `bPoint` | array | — | gap: side b as a point. |
| `bDatum` | string | — | gap: side b as a datum name. |
| `bOn` | string | — | gap: which side the reported distance is measured TO ("a" \| "b"); default both witness pairs. |
| `runId` | string | — | gap: measure two parts of a saved run at one trajectory pose (needs aPart/bPart + timeSec or step). |
| `timeSec` | number | — | gap run mode: trajectory time, s. |
| `step` | number | — | gap run mode: simulation step, looked up in the run report. |
| `aPart` | string | — | gap run mode: part A name in the run. |
| `bPart` | string | — | gap run mode: part B name in the run. |
| `snap` | boolean | — | gap: snap a bare point onto the nearest surface of its version before measuring. Default true. |
| `from` | array | — | thickness: starting point [x,y,z]. |
| `fromDatum` | string | — | thickness: start from a datum instead of a point. |
| `direction` | string | — | thickness: cast direction x \| y \| z (a leading "-" flips it). |
| `directionVector` | array | — | thickness: cast direction [x,y,z]. |
| `maxSpanMm` | number | — | thickness: give up after this many mm (default 50). |
| `fraction` | number | — | section: where to slice along the axis, 0..1 (default 0.5). |
| `atMm` | number | — | section: absolute slice coordinate instead of fraction. |
| `simplifyToleranceMm` | number | — | section: polygon simplification tolerance (default 0.02). |
| `maxPolygons` | integer | — | section: cap on returned loops (default 8). |
| `maxHolesPerPolygon` | integer | — | section: cap on holes reported per loop. |
| `maxHoleNeighbours` | integer | — | section: how many neighbouring holes to name. |
| `aProbe` | array | — | angle: side a as a POINT — the direction becomes the normal of the face it lands on. Approximate is fine. |
| `bProbe` | array | — | angle: side b as a point (nearest face normal). |
| `aPoints` | array | — | angle: side a as two points [[x,y,z],[x,y,z]]; the direction is the segment. |
| `bPoints` | array | — | angle: side b as two points. |
| `aDir` | array | — | angle: side a as a direction vector you already know. |
| `bDir` | array | — | angle: side b as a direction vector. |
| `aOrigin` | array | — | angle: a point ON side a's line (needed for a meaningful line distance when you passed aDir). |
| `bOrigin` | array | — | angle: a point on side b's line. |
| `parallelToleranceDeg` | number | — | angle: within this many degrees of 0 the lines count as parallel (90 = perpendicular). Default 0.5. |

```js
cad_inspect({ action: "measure", args: { kind: "part" } })
```

returns: `kind`, `versionId`


## `merge_parts`

Model-facing call: `cad_part` action `merge` (this section documents the internal op).

Union two or more parts, each at its assembly placement, into ONE new solid part version. Use it when the whole machine must be a single rigid body: simulate_physics topple/stability, or a whole-assembly measure_part. Replaces hand-merging STLs in OpenSCAD. mm, z-up; rotate first (degrees in R = Rz·Ry·Rx — the OpenSCAD/Manifold composition; three.js order `ZYX`), then translate. G4 (2026-10-29): the merged part is marked role=research (an analysis body, not a printed part) unless it already carries an explicit role — the delivery audit then exempts it from the printability and newest-validated checks; set_part_role back to printed if it IS printed.

| parameter | type | default | meaning |
|---|---|---|---|
| `parts` | array | **required** | Parts to union (at least 2), each with its placement in the merged body's frame. |
| `userIntent` | string | **required** | One-line summary for the version history, e.g. "整机刚体（用于倾倒测试）". |
| `part` | string | — | Which part the merged version belongs to. Defaults to a name derived from userIntent. Pass this to re-merge into an existing part. |

```js
cad_part({ action: "merge", args: { parts: [], userIntent: "…" } })
```

returns: `versionId`, `part`, `triangles`, `volumeMm3`, `sizeMm`, `shells`, `sources`, `warnings`, `durationMs`, `views`


## `pearl_run`

Model-facing call: `cad_deliver` action `pearl` (this section documents the internal op).

DEPRECATED / experimental — the pearl execution layer is demoted; use the V1 `verify` evidence report or the atomic tools. Kept for the historical implementation. Run the pearl gate, or execute the selected template when execute:true. Gate mode auto-loads pearl-profile.json, plans against the project budget, observes all six pearls and returns localized failures. Execute mode resolves template step bindings, dispatches the named CAD tools through the same registry, applies transient retry and returns the on_fail route. Missing inputs are errors, not guesses.

| parameter | type | default | meaning |
|---|---|---|---|
| `execute` | boolean | — | true = dispatch the template steps; false/omitted = read-only gate. |
| `inputs` | object | — | Caller-provided values for step bindings (e.g. gap/motion/contract/versionId). |
| `deadlineMs` | number | — | Whole-template step deadline; defaults to the profile maxCostSeconds. |

## `preflight`

Model-facing call: `cad_deliver` action `preflight` (this section documents the internal op).

Run the mandatory delivery sequence in one call: printability for every part (newest version, against the `profileIds` you declare), mesh health, support cost, the assembly contract and the corpus audit with your `claims`. `judgement` is the worst step that RAN; a step that was attempted and failed forces `difficult`, and it never averages away. Steps this cut does not orchestrate at all (simulation evidence, the assembly render) are listed in `coverage.notCovered` with a reason — they are named, not silently green, and they do not enter the judgement. Read `unevaluable` before claiming anything: not-excluded means "no counter-example", never "ok" and never "safe".

| parameter | type | default | meaning |
|---|---|---|---|
| `claims` | array | — | Delivery claims to back with evidence: {kind, statement}. kind = strength \| motion \| assembly \| manufacturability \| appearance \| review \| flow. |
| `profileIds` | array | — | Declared process profiles to screen against (same meaning as in check_printability). |
| `scanPaths` | array | — | Workspace-relative roots for the unregistered-geometry scan (same meaning as in delivery_audit). Default ["."]; [] disables it. |
| `exempt` | array | — | Declared exceptions for files intentionally left as files: {path, reason} (same meaning as in delivery_audit). |

```js
cad_deliver({ action: "preflight", args: { claims: [] } })
```

returns: `judgement`, `steps`, `ran`, `notRun`, `unevaluable`, `coverage`, `summary`, `timings`


## `project_info`

Model-facing call: `cad_session` action `info` (this section documents the internal op).

Read-only: which CAD project THIS session has explicitly SELECTED (boundRoot/boundAt), or `selected:false` with no default. There is no implicit cwd/root: if nothing is selected, CAD tools refuse and you must call bind_project({dir}) or init_project({dir}). Also reports `mismatch: true` when the live cwd resolves to a different corpus than the selection — a selected session does not switch. Reports the effective authoring kernel (`kernel`/`kernelSource`); the session prompt already states it, so this is a confirmation, not a prerequisite.

| parameter | type | default | meaning |
|---|---|---|---|

```js
cad_session({ action: "info", args: {  } })
```

returns: `sessionId`, `boundRoot`, `boundAt`, `marker`, `liveCwd`, `selected`, `kernel`, `kernelSource`, `wouldBindTo`, `wouldBindMarker`, `mismatch`, `ambiguous`, `workspace`, `note`


## `python_runtime`

Model-facing call: `cad_python` action `runtime` (this section documents the internal op).

Status, repair and EXTENSION for the plugin's bundled Python runtime (CPython 3.13 + pinned numpy/scipy/trimesh/manifold3d/networkx/scikit-fem/rtree/rapier3d). action "status" (default) reports where it is, whether it is usable, its size, the last error and the USER OVERLAY; "provision" installs it now instead of waiting for the first run_python call; "repair" rebuilds the dependency environment; "install" adds packages to the user overlay — the runtime is the user's machine, so installing is a normal act, not a favour: the packages land in a directory provisioning never deletes, the worker and run_python both see them, and the overlay is recorded (status + run provenance). DEFAULT: adding is not overriding — a package the lock also provides keeps the LOCKED version (reported as shadowed). EXPLICIT: override:true + reason:"…" installs into a separate directory placed at the FRONT of sys.path, so the new version really replaces the locked one; agree it with the human first and expect runs to carry it in pythonOverlay.overrides. Use it when run_python reports a runtime problem, to warm the runtime before a long batch, or when a task needs a library we do not ship.

| parameter | type | default | meaning |
|---|---|---|---|
| `action` | string (status \| provision \| repair \| install) | — | status (default) \| provision \| repair \| install |
| `packages` | array | — | action=install only: package specs for pip, e.g. ["six==1.17.0", "svgpathtools"]. They go into the user overlay (not the locked venv), so a runtime update cannot erase them. |
| `override` | boolean | — | action=install only: explicitly REPLACE a package the lock pins. Default false = the copy is additive and the locked version keeps precedence. Requires reason. |
| `reason` | string | — | action=install + override: why the locked version cannot be used. Recorded with the install and carried into run provenance — this is the declaration, not ceremony. |

```js
cad_python({ action: "runtime", args: { action: "status" } })
```

returns: `action`, `state`, `root`, `target`, `pythonVersion`, `mode`, `source`, `interpreter`, `venvPython`, `installedAt`, `phase`, `error`, `occupiedBytes`, `occupied`, `skipped`, `missingPackages`, `overlay`, `installed`, `overrides`, `shadowed`, `provisionLog`, `summary`


## `recall_reference_image`

Model-facing call: `cad_see` action `reference` (this section documents the internal op).

Re-attach a user-uploaded reference image (or any earlier attachment) as a fresh image on this tool result. Use it when a reference image has been pruned from context (its placeholder reads "image omitted; <name>; path=<path>") and the task depends on seeing it again — comparing a build against a reference, matching proportions or colors. Pass the `path` from the placeholder, or the `attachmentId`. The recalled image becomes the NEWEST image in context, so it survives pruning for the following rounds; recall again when needed.

| parameter | type | default | meaning |
|---|---|---|---|
| `path` | string | — | Local file path of the pruned image, exactly as the "image omitted" placeholder names it (preferred). |
| `attachmentId` | string | — | Durable attachment id (sha256:…) if the placeholder or history named one instead of a path. |
| `name` | string | — | Display name to keep for the recalled image; defaults to the file name or the attachment id. |

```js
cad_see({ action: "reference", args: { path: "…" } })
```

returns: `recalled`, `source`, `mediaType`, `bytes`, `attached`, `recallToken`


## `render_part`

Model-facing call: `cad_see` action `render` (this section documents the internal op).

One image of a saved version with explicit camera control: preset view, custom rotation, zoom, optional section cut. Sub-second, so request freely.

| parameter | type | default | meaning |
|---|---|---|---|
| `versionId` | string | **required** | Saved version to render, e.g. "v003". |
| `view` | string | — | Preset view: front \| side \| top \| iso. Default iso. |
| `rotate` | array | — | Custom camera rotation [rx,ry,rz] degrees — overrides view. |
| `zoom` | number | — | Zoom over auto-fit: 2 = twice as close, 0.5 = further out. Default 1. |
| `imgSize` | integer | — | Image size in px (default 512). |
| `section` | object | — | Optional cross-section cut. |

```js
cad_see({ action: "render", args: { versionId: "…" } })
```

returns: `versionId`, `label`, `file`


## `request_review`

Model-facing call: `cad_session` action `review` (this section documents the internal op).

Ask the human to look at something (a version, a run, a part) or to consider a rollback — queued, never a popup. The panel badges the queue; the human opens it when they choose. Limits: 3 items per call, 6 calls per 10 minutes, 20 unread; repeating the same target within 10 minutes updates that item instead of adding another.

| parameter | type | default | meaning |
|---|---|---|---|
| `items` | array | **required** | Up to 3 items. Each is one thing to look at, with a one-line title. |

```js
cad_session({ action: "review", args: { items: [] } })
```

returns: `queued`, `merged`, `dropped`, `unread`, `rateLimited`


## `retire_run`

Model-facing call: `cad_deliver` action `retire` (this section documents the internal op).

Retire (or un-retire) a run: keep all artifacts and history, but stop counting it as current evidence. Use it for a failure/screen whose geometry a later version replaced, or a declaration error that a re-run fixed. A retirement REQUIRES a reason; it is written to the run index and the run's own run.json, and delivery_audit excludes retired runs from failing/latest/stale verdicts (they still appear in runs.retired). This is not deletion: nothing is moved or removed. Prefer a fresh run with the same subject when the geometry is still current; retire only when the run can never become current again.

| parameter | type | default | meaning |
|---|---|---|---|
| `runId` | string | **required** | Run id, e.g. "r006". |
| `reason` | string | **required** | Why this run is history, e.g. "v017 washer face overlap; fixed in v026". |
| `by` | string | — | Who/what approved the retirement (default: the calling session). |
| `undo` | boolean | — | true = clear an existing retirement (the artifacts were never changed). |

```js
cad_deliver({ action: "retire", args: { runId: "…", reason: "…" } })
```

returns: `runId`, `kind`, `status`, `retiredAt`, `reason`, `retiredCount`, `activeCount`


## `review_visual`

Model-facing call: `cad_see` action `review` (this section documents the internal op).

MANDATORY before delivering a printed part: render the version from top and iso (plus an optional section), attach the images to THIS reply, and write a per-version visual-review record. `note` must say what you actually checked and what could be wrong — a bare "looks good" is not a review. A version changed after its last review is UNREVIEWED; call this again. delivery_audit blocks the newest printed part of every assembly whose version has no fresh top+iso review. The images are attached here, so this call spends image context by design; that is the point — do not save tokens by skipping it.

| parameter | type | default | meaning |
|---|---|---|---|
| `items` | array | **required** | Versions to review, 1–8 per call. Each needs its own note: a batch shares the views, not the judgment. |
| `views` | array | — | Views to render/attach. Default and minimum ["top","iso"]; both are required for the delivery gate. You may add front/side. |
| `section` | object | — | Optional section cut applied to every item (adds one more image). Use it for an internal feature the outside views cannot show. |
| `imgSize` | integer | — | Image size in px (default 512). |

```js
cad_see({ action: "review", args: { items: [] } })
```

returns: `reviewId`, `reviewed`


## `run_python`

Model-facing call: `cad_python` action `run` (this section documents the internal op).

Run Python in the plugin's own pinned runtime — CPython 3.13 with numpy, scipy, trimesh, manifold3d, networkx, scikit-fem and rapier3d (rapier3d only where a wheel exists for this platform; python_runtime reports what this machine has) — not the host's system interpreter. Pass `code` for a one-off program, or `script` to run an existing .py file (relative to the project directory). Use it for numerical analysis, mesh measurement on an exported STL, FEM/optimisation probes, or any check the CAD tools do not cover. It also sees the USER OVERLAY (python_runtime action=install): installing a library is a normal act on the user's own machine, not an exception — the overlay survives runtime updates and is recorded in run provenance, so add one when the task needs what we do not ship. The process runs with your user's full filesystem access (no sandbox), in the project directory, and is killed at the timeout. On failure the complete Python traceback comes back. The first call on a machine installs the runtime once (hundreds of MB, progress reported); python_runtime shows or repairs it.

| parameter | type | default | meaning |
|---|---|---|---|
| `code` | string | — | Python source to run. Mutually exclusive with `script`; prints go to stdout, and an uncaught exception returns its traceback. |
| `script` | string | — | Path to an existing .py file — absolute, or relative to the project directory. Mutually exclusive with `code`. |
| `args` | array | — | Command-line arguments appended after the script path (sys.argv[1:]). |
| `cwd` | string | — | Working directory for the run; defaults to the project directory. Relative paths resolve against the project directory. |
| `timeoutSec` | number | — | Wall-clock budget in seconds (default 120, maximum 600). On expiry the process group is killed and the result says so. |

```js
cad_python({ action: "run", args: { code: "…" } })
```

returns: `ok`, `python`, `runtimeSource`, `scriptPath`, `exitCode`, `signal`, `timedOut`, `durationMs`, `stdout`, `stderr`, `traceback`, `truncated`, `protocolVersion`, `provisionLog`


## `scan_attention`

Model-facing call: `cad_inspect` action `attention` (this section documents the internal op).

Where to LOOK on a saved version — not a verdict. Mesh health (watertight, body count) plus REENTRANT CORNERS: concave edges whose face normals turn by more than `concaveMinDeg` (default 100°), chained and located. θ=90° is an ordinary T-junction (not reported); θ=135° is a 45° V-notch; θ→180° is a knife slit. Plus MESH HEALTH (multi-body / non-manifold / degenerate) and NON-PLANAR CLOSED SHARP LOOPS (`boolean-seam`, 80° edges): a curved/angled boolean seam, the trace a missed difference/union often leaves. Flat hole rims and 90° pocket rims are excluded on purpose, so a molecule with many bond necks does not flood the list; at most 8 seams are returned, the count is in stats. A notch is where printed parts initiate cracks, so each one comes back with a coordinate, a bbox and a runnable next observation. Run it on a new part, and again after any geometry change: it is how a fix is shown to have worked (the repaired part must go quiet).

| parameter | type | default | meaning |
|---|---|---|---|
| `versionId` | string | **required** | Saved version id to scan, e.g. "v012". |
| `concaveMinDeg` | number | — | Report concave edges sharper than this face-normal angle. Default 100 (just past a right angle). |
| `minChainMm` | number | — | Ignore chained edges shorter than this, mm. Default 0.5. |

```js
cad_inspect({ action: "attention", args: { versionId: "…" } })
```

returns: `versionId`, `stats`, `suspects`


## `set_datums`

Model-facing call: `cad_assembly` action `datums` (this section documents the internal op).

Read or declare the datum anchors of a version. Call it with only versionId to list what that version declares (names and world coordinates) — the input you need to write assembly interfaces. Call it with datums to record anchors; because an anchor is what an interface RESOLVES against, declaring them creates a NEW version (parent = the given one) instead of rewriting history: a run that cited the old anchors must keep meaning what it meant (§22 evidence). The mesh is copied byte-for-byte, so the geometry is identical. G2 (2026-10-29): a zero dir/normal is REFUSED (an axis with no direction can never be an assembly endpoint), and an axis whose direction dwarfs its own point warns as a probable p/dir swap — the anchor is still recorded, because this tool is also the repair path (roberval v048).

| parameter | type | default | meaning |
|---|---|---|---|
| `versionId` | string | **required** | Version to read or edit, e.g. "v003". |
| `datums` | array | — | Anchors to write. Omit to list the current ones. Coordinates are in the version's own stored frame, final world coordinates. |
| `replace` | boolean | — | true = drop the existing anchors and keep only these. Default false = merge by name (an incoming anchor of the same name replaces the old one). |

```js
cad_assembly({ action: "datums", args: { versionId: "…" } })
```

returns: `versionId`, `previousVersionId`, `userIntent`, `mode`, `datums`, `counts`, `warnings`


## `set_part_role`

Model-facing call: `cad_part` action `role` (this section documents the internal op).

Declare what a part IS: printed (default — full printability and delivery expectations), stock (purchased hardware modelled for reference, e.g. an M3 screw), or research (an analysis/merged body, e.g. a kinematic stand-in). The delivery audit exempts stock/research parts from the printability-for-every-part claim and from the newest-version-unvalidated check, and reports the exemption as an info finding — a declared exemption, never an inference from the name. merge_parts marks its output research automatically. If a part actually ships as a printed part, its role must be printed.

| parameter | type | default | meaning |
|---|---|---|---|
| `part` | string | **required** | Part name (as shown by the part picker) or part id, e.g. "m3_screw_20" or "p012". |
| `role` | string | **required** | One of printed \| stock \| research. |

```js
cad_part({ action: "role", args: { part: "…", role: "…" } })
```

returns: `partId`, `name`, `role`, `previousRole`, `effect`


## `set_project_kernel`

Model-facing call: `cad_session` action `kernel` (this section documents the internal op).

Change the project-level authoring kernel in place (openscad <-> cadquery). Existing versions keep their own backend pin and source file; only NEW generate_part calls follow the new default. The session prompt updates on the next turn. Use this instead of creating a second project just to switch engines — the previous design and its evidence stay in one corpus.

| parameter | type | default | meaning |
|---|---|---|---|
| `kernel` | string (openscad \| cadquery) | **required** | New default kernel for this project. |
| `dir` | string | — | Project directory; default the session's bound project (or live cwd). |

```js
cad_session({ action: "kernel", args: { kernel: "openscad" } })
```

returns: `root`, `key`, `previous`, `kernel`, `note`


## `simulate_fluid`

Model-facing call: `cad_simulate` action `fluid` (this section documents the internal op).

MPM (CPU) flow through a pipe or part cavity: arrival, section velocities, conservation, snapshots. The solid boundary stays fixed for the whole run. Pass pipeScad for inline geometry or versionId for a saved version; versionId records provenance and wins when both are given.

| parameter | type | default | meaning |
|---|---|---|---|
| `pipeScad` | string | — | Complete OpenSCAD source of the pipe/cavity (the SOLID; the fluid flows through its bore). Self-contained, $fn=48+. Give this OR versionId; when both are given, versionId wins. |
| `versionId` | string | — | Use a saved version's model.stl as the solid and record it as the run's source. Give this OR pipeScad; overrides pipeScad when both are given. |
| `fluidRegionMm` | object | — | Particle seed box {min:[x,y,z], max:[x,y,z]} in mm. Default: derived from the pipe (30% of the length at the inlet end, 3mm wall clearance). |
| `inletVelocityMmPerSec` | number | — | Inlet axial speed. Default 100 mm/s. |
| `particleCount` | number | — | Explicit particle count. Default auto (4-8 particles/cell, typically 50k-300k). |
| `particlesPerCell` | number | — | Seed density (sweet spot 4-8). Default 6. |
| `steps` | number | — | Simulation steps (dt=4ms). Default derived from travel time ×1.6, min 600. |
| `gravityMmPerSec2` | array | — | Gravity [x,y,z] mm/s². Default [0,0,-98.1]; use [0,0,0] for pure driven flow. |

```js
cad_simulate({ action: "fluid", args: { pipeScad: "…" } })
```

returns: `runId`, `overallStatus`, `metrics`, `frames`


## `simulate_lbm`

Model-facing call: `cad_simulate` action `lbm` (this section documents the internal op).

Lattice-Boltzmann channel flow (XLB, CPU): developed velocity profile vs the Poiseuille parabola, mirror symmetry and stability at a chosen Reynolds number. Stage-A template — the domain is a rectangular channel with box walls; no embedded solids, no heat, single phase.

| parameter | type | default | meaning |
|---|---|---|---|
| `cells` | array | — | Lattice resolution [nx,ny,nz]; nx is the flow direction. Default [48,24,24]. Keep the product ≤ ~200k on CPU; runtime is linear in steps×cells. |
| `reynolds` | number | — | Channel Reynolds number based on (ny-1) cells. Default 100. Development length grows ~with Re — raise steps together with Re. |
| `latticeVelocity` | number | — | Inlet speed in lattice units. Default 0.05; keep ≤0.1 (weakly compressible LBM). |
| `steps` | number | — | Time steps. Default 20000 (≈75% developed on the default grid); quote numbers only near the developed end. |

```js
cad_simulate({ action: "lbm", args: { cells: [] } })
```

returns: `overallStatus`, `metrics`


## `simulate_motion`

Model-facing call: `cad_simulate` action `motion` (this section documents the internal op).

Assembled-mechanism kinematics: a constant-speed crank AND/OR prescribed sinusoidal movers (no crank is required when every mover is an oscillator), revolute/prismatic followers, optionally parts on prescribed sinusoidal paths. Returns stroke/period, an exact interference timeline at >=24 sampled poses per run (final pose included; fewer means check, never pass), joint anchor drift, keyframes. Gravity is off. A revolute joint may declare `overlapEnvelope` (the fit capsule along its axis) and `fit`: overlap inside the capsule is listed in `jointExemptions` and, until `fit` is declared, keeps the run at check (`jointFitsUnresolved`); overlap outside it is interference. A joint may also be `type:"gear"` with a signed `ratio` (turns of B per turn of A) and each body's own `axisA`/`axisB`: the coupling is prescribed (rapier has no gear constraint), transfers no torque, and `metrics.gears` reports declared vs measured turns. Every interference event carries `overlapBboxMm` (min XYZ + max XYZ of the intersection), so a swept clash can be located without replaying the run.

| parameter | type | default | meaning |
|---|---|---|---|
| `parts` | array | **required** | Parts of the mechanism. The crank should be bodyType "kinematic". |
| `joints` | array | **required** | Joints between parts. A revolute joint may carry overlapEnvelope + fit (the declared fit capsule); with scanJointPairs those pairs enter the timeline instead of being excluded. |
| `drive` | object | — | The constant-speed crank drive. Omit it when every mover is a prescribed oscillator (a guide/valve following a sinusoid): the time base is then the oscillator period. A run with neither a drive nor an oscillator is refused — nothing would move. |
| `oscillators` | array | — | Prescribed sinusoidal movers (valves). bodyType must be "kinematic". |
| `scanJointPairs` | boolean | — | Also boolean-test revolute-linked pairs. Off by default: those pairs are then listed in excludedJointPairs. Turn it on when a motion-clearance interface needs evidence over a hinge pair — without it that pair is never in the timeline. |
| `cycles` | number | — | Drive cycles to simulate. Default 2. FRACTIONAL values are meaningful and are honoured: a balance whose design range is ±14° sweeps 0.078 of a turn, and asking for a whole turn instead answers a different question (the beam becomes a windmill and every part of it collides). |

```js
cad_simulate({ action: "motion", args: { parts: [], joints: [] } })
```

returns: `overallStatus`, `followers`, `gears`, `interferenceCount`, `interferenceEvents`, `interferenceChecks`, `candidatePairs`, `interferencePairChecks`, `excludedJointPairs`, `jointPairScan`, `jointFitsUnresolved`, `jointExemptions`, `jointExemptRule`, `samplingSatisfied`, `maxSampleGapDeg`, `blocking`, `deliverability`, `maxJointDriftMm`, `closedLoop`, `loopJoints`, `geometrySuspects`, `geometrySuspectRule`, `hasCrank`, `initialJointGaps`, `jointToleranceMm`, `jointViolations`, `pivots`, `keyframes`, `runId`, `playback`, `stepsRun`, `durationSec`


## `simulate_physics`

Model-facing call: `cad_simulate` action `physics` (this section documents the internal op).

Rigid-body simulation (rapier, z-up, millimetres) over discrete parts: settled penetration, toppling, joint violations, drift, plus keyframe images. Joints may be revolute (hinge) or prismatic (slide). Contact model: convex dynamic parts use a hull, concave parts their EXACT mesh (a hull would fill a fork/cavity and report phantom penetration); the two bodies of a joint do NOT collide by default — a bearing is designed to overlap in clearance (pass jointContacts:true only for a stopper that must). t=0 anchors >2mm apart are REFUSED, not warmed up. Topple is measured relative to the authored pose, not world up, so a part authored at 90° is not "toppled" at t=0. For a joint between differently-oriented bodies use axisA+axisB or axisWorld; a bare axis is one local vector for both and is only right for parallel frames. A revolute joint may carry a torque-limited motor (`motor`): with one the mechanism is DRIVEN and keeps turning; without one the only input is an impulse (initialAngularVelocity) that dies at the first tooth/stop — a still keyframe then means "nothing drove it", not "it slips". Joints may also be `gear` (a kinematic ratio coupling between two shafts — rapier has no gear constraint, so it is prescribed, not solved). `metrics.motors` reports commanded vs measured so a stall is a number. Two more INPUTS decide whether that verdict means anything: `friction` per part (default rapier 0.5, echoed in `metrics.frictions` — a self-locking worm is η≈19% at 0.5 and η≈40% at POM's 0.15) and `timestepSec` (default 1/60, too coarse for fast contact: keep v·dt ≤ clearance/10, e.g. 1/2000 for a 20 rad/s shaft).

| parameter | type | default | meaning |
|---|---|---|---|
| `parts` | array | **required** | Parts in the scene. |
| `joints` | array | — | Joints between parts: "revolute" (hinge) or "prismatic" (slide). |
| `durationSec` | number | — | Simulation length. Default 2. |
| `timestepSec` | number | — | Integration step, s. Default 1/60 — which is WRONG for fast contact: a surface moving v mm/s advances v·dt per step, and when that is comparable to the clearance the solver resolves the teeth as interpenetration (a worm at 2 rad/s on a 4mm pitch radius advances 0.133mm/step against a 0.03–0.15mm backlash). Rule of thumb: v·dt ≤ clearance/10, e.g. 1/2000 for a 20 rad/s shaft. Cost is linear in steps. |
| `gravity` | array | — | mm/s². Default [0,0,-9810] (z-up). |
| `tiltDeg` | number | — | Tilt gravity by this many degrees about tiltAboutAxis (default [0,1,0]) — the slope scenario without hand-computing the gravity vector. Ignored when gravity is given. |
| `tiltAboutAxis` | array | — | Axis to tilt about, default [0,1,0]. |
| `solverIterations` | number | — | Solver iterations per step. Default 4 (rapier default, tuned for a metre-scale scene). Raise it (16-32) when a stiff chain or a thin-contact run reports settled penetration: it is the second knob after timestepSec, and unlike timestepSec it does not multiply the cost of every step. Echoed in metrics.solver. |
| `ccdSubsteps` | number | — | Continuous-collision substeps per step. Default 1. Raise (4-8) when a fast, thin part must not tunnel: a 6400 rpm tooth at a 4.8mm pitch radius advances ~0.67mm per 1/1000 step, far more than the 0.028mm backlash it is supposed to resolve. Echoed in metrics.solver. |
| `jointContacts` | boolean | — | Default false: the two bodies of a JOINT do not collide, because a bearing is designed to have its parts inside one another's clearance. Set true only when a stopper really is supposed to collide on the jointed pair. |

```js
cad_simulate({ action: "physics", args: { parts: [] } })
```

returns: `overallStatus`, `settledPenetrationMm`, `geometrySuspects`, `geometrySuspectRule`, `maxPenetrationMm`, `fellOver`, `jointViolations`, `initialJointGaps`, `jointToleranceMm`, `contactsDisabled`, `colliders`, `closedLoop`, `loopJoints`, `holdAnalysis`, `motors`, `gears`, `frictions`, `notes`, `keyframes`, `runId`, `playback`


## `simulate_stress`

Model-facing call: `cad_simulate` action `stress` (this section documents the internal op).

Static linear-elastic stress of a saved version (voxel hex8 FEM, matrix-free CG). You must declare the CASE — material, supports and loads — because "the stress" without one is not a number. SELF-WEIGHT IS A LOAD CASE NOW (2026-10-29): `includeSelfWeight` defaults to true and applies rho*g; `loads` is then optional. Use `supports: [{ground:true}]` for a part resting on the bed; ground is a HELD FACE, not a frictional/unilateral contact. `loadCase` reports gravity / service / combined; "gravity stress" / "structural overhang" is valid only when the reply says so. TRUST from this tool: the integrals (reaction, section force/moment, compliance, strain energy), the hot-spot LOCATIONS, and the surface stress recovered by extrapolating the depth profile inward from each hot spot. DO NOT ASK IT FOR "the largest element stress": there is no such field, because on a curved or notched boundary it grows without bound under refinement (measured 1.002 → 1.184, and fill-ratio weighting did not fix it). DO NOT read a tier or a peak as a safety factor: the model is isotropic, so an FDM part's layer-direction weakness — usually what breaks first — is invisible to it. Peaks are read at `criticalDistanceMm` inside the surface (a declared distance; the distance actually used comes back as effectiveSampleDistanceMm) — that declared-distance reading is the number to quote. A region's `surfaceExtrapolatedMPa` (the depth profile fitted out to the surface) is a HIGHER estimate and is only quoted when it passes BOTH its own fit check and a cross-resolution check (`extrapolationCrossResolutionPct`), because a good fit R^2 is not sufficient: on a fillet the fit looked fine (R^2 0.90) while the value moved 17% between grids. Every region also carries the wall thickness it tunnels through in cells and a `trustworthy` flag with `whyUntrustworthy`; an untrustworthy region means the position/value may not be quoted — refine dxMm. Deliver against `delivery` (excluded / difficult / not-excluded, with witnesses), NOT against `verdict`: a missing number is not a pass, and the geometry suspects in `attention` are DETECTION (where to look), never delivery evidence. THIS TOOL IS NEVER SILENT: when it cannot certify any region it still returns a `geometry-suspects` layer — the reentrant corners already known from the geometry scan, labelled as geometry and NOT as stress — so a run always says where to look next (HARNESS §11.14). A part whose members are thinner than the voxel cannot be certified at any affordable dxMm — the report then says so (verdict check, zero trustworthy regions) instead of drawing an authoritative-looking heatmap. Run it once per load case, and again after any change to the material, the supports or the geometry: comparing two versions under the SAME case is the re-check.

| parameter | type | default | meaning |
|---|---|---|---|
| `versionId` | string | **required** | Saved version id to analyse, e.g. "v050". |
| `loads` | array | — | The EXTERNAL load case. Optional when `includeSelfWeight` is true; at least one of `loads` / self-weight is required. Each entry is a force in N applied either to a whole bounding-box face or to the nodes within radiusMm of atMm. |
| `supports` | array | — | Where the part is held. A face locks the outermost node layer; atMm locks the nodes within radiusMm (e.g. a knife edge resting on a pin); `ground: true` holds the lowest z face (a part resting on the bed). An unsupported load is a rigid-body mode and is REFUSED, not fudged. Ground is a HELD FACE, not a frictional or unilateral contact. |
| `mode` | string (judge \| scan \| both) | — | "judge" (default) returns ONLY the delivery judgement; "scan" returns ONLY the attention field and NO verdict, because a risk map must never be read as a gate; "both" returns the two halves as separate keys. The default is the stricter half (DESIGN §25.7). |
| `excludeFromReport` | array | — | Cells to drop from the reported field, peaks, regions and percentiles — for SUPPORT and LOAD patches, whose stress is an artifact of the idealisation (a clamped patch is not a knife edge on a pin). The excluded cell count comes back in method.excludedCells, so the exclusion is declared rather than silent. |
| `materialIds` | array | — | Shipped materials, e.g. ["fdm-pla"]. The strength behind the tiers is the LAYER-ADHESION band, not the bulk figure. Omit (with materialJson) for your own; the built-in is marked assumed. |
| `materialJson` | string | — | Inline material: {"id","name","youngModulusMPa","poissonRatio","strengthMPa","densityKgPerM3"}. `densityKgPerM3` is required when includeSelfWeight is true. Use for a filament you have data for. |
| `dxMm` | number | — | Voxel size in mm. Default: 8 cells across the thinnest dimension. Halving it costs ~8x. A hot spot thinner than ~8 cells needs a finer grid before its position is trustworthy. |
| `includeSelfWeight` | boolean | — | Include the body force rho*g (default true). Requires the material density; a gravity-only case is valid as long as `supports` is given. Set false to reproduce an external-load-only result. |
| `gravityMmPerS2` | array | — | Gravity vector [gx,gy,gz] in mm/s^2 (default [0,0,-9810], -z is down). Only used when includeSelfWeight is true. |
| `criticalDistanceMm` | number | — | Distance inside the surface at which peaks are read. Default 1.0 mm (the grid cannot sample closer than one cell; the distance actually used comes back as effectiveSampleDistanceMm). |
| `probeAtMm` | array | — | Watch this point: report its displacement, e.g. a pan centre or a beam tip. |
| `resultants` | array | — | Section resultants to integrate — the trustworthy half of this tool: axial force, shear, bending moment, plus the section area and its second moment so an analytic check can be closed on a profile too complex to hand-compute. Place the cut AWAY from a support: a cut through the support patch swallows part of the reaction. |
| `runConvergence` | boolean | — | Also solve a coarser grid and report the deltas (default true; costs ~30% more). A drifting verdict means refine before quoting. |

```js
cad_simulate({ action: "stress", args: { versionId: "…" } })
```

returns: `versionId`, `nextLook`, `verdict`, `delivery`, `material`, `loadCase`, `selfWeight`, `method`, `checks`, `resultants`, `capability`, `attention`


## `suggest_interfaces`

Model-facing call: `cad_assembly` action `suggest` (this section documents the internal op).

Turn undeclared near-contact pairs into READY-TO-EDIT interface templates. The assembly check reports "52 undeclared" but not which datums to use, so every contact had to be hand-written. This runs the same adjacency pass, reads each part's datums, and proposes a distance interface with the measured gap and a symmetric tolerance. The template is a STARTING POINT: it uses the first point datum (or first axis/plane/cylinder) on each part, so review the chosen datums — it never writes the contract.

| parameter | type | default | meaning |
|---|---|---|---|
| `manifestPath` | string | — | Assembly manifest; default assembly/assembly.json. |
| `adjacencyThresholdMm` | number | — | Near-contact gap below which a pair is proposed. Default 0.75. |
| `maxSuggestions` | integer | — | Cap the reply. Default 20, max 60. |

```js
cad_assembly({ action: "suggest", args: { manifestPath: "…" } })
```

returns: `manifest`, `thresholdMm`, `undeclared`, `suggestions`, `skipped`


## `validate_assembly`

Model-facing call: `cad_assembly` action `validate` (this section documents the internal op).

Static multi-part check: watertightness plus, for every pair, exact interference volume and minimum clearance, in the poses you give. Behaviour under gravity or motion is simulate_physics.

| parameter | type | default | meaning |
|---|---|---|---|
| `parts` | array | **required** | Parts of the assembly. |
| `clearanceThreshold` | number | — | Minimum allowed clearance in mm between non-interfering parts. Default 0.75. |
| `interferenceEpsilonMm3` | number | — | Interference below this volume (mm³) counts as polygonal-fit residual, not a clash. Default 1e-3. Raise it (e.g. 1) when a printed thread's segmentation noise keeps drowning the report. |

```js
cad_assembly({ action: "validate", args: { parts: [] } })
```

returns: `overallStatus`, `judgement`, `judgedBy`, `parts`, `pairs`


## `write_assembly`

Model-facing call: `cad_assembly` action `write` (this section documents the internal op).

Write or update the assembly contract. This is the ONLY write entry: the contract is sealed (assembly/assembly.seal) and every change appends a record under assembly/changes/ with a reason, actor, diff and revision. A generic write/edit to assembly.json is not a contract change and will be rejected by the seal check. The tool validates the manifest schema, every child version, every interface endpoint against that version's datums, and direct-child ownership, then writes atomically. Modes: create (file must not exist; expectedRevision 0), merge (upsert children/interfaces by id; explicit remove; requires expectedRevision), replace (full root; requires expectedRevision). `reason` is required for every mode. Use `dryRun` to preview the diff without writing. It does not create datums, compute distances, or judge fit. Give each part a `color` (#rrggbb) when the project is discussed with a human: the panel renders assembly and playback with it, so the agent and the human name the same part. It is a communication label, not a material or a spec, and it is only used where colour already exists (assembly + playback) — never to decorate reports or tables. Record the kickoff alignment in the root `brief` field (buy-vs-make with `by: user|assumed`, the ALLOWED process set, what "working" means, and every assumption) — delivery_audit prints the assumed ones.

| parameter | type | default | meaning |
|---|---|---|---|
| `manifestPath` | string | — | Workspace-relative manifest path; default assembly/assembly.json. Must stay inside the project workspace. |
| `mode` | string (create \| merge \| replace) | — | Default merge. merge/replace require expectedRevision (from the last write/check). |
| `expectedRevision` | integer | — | Current contract revision from the last write/check (0 for create). Required for merge/replace; a stale revision is refused. |
| `expectedHash` | string | — | Optional sha256 of the current file (or bare hex); when both are given, both must match. |
| `reason` | string | **required** | Why this change is made. Recorded in the change log; empty is refused. |
| `dryRun` | boolean | — | Validate and return the diff without writing or appending a change record. |
| `root` | object | — | Assembly root (create/replace) or patch (merge). Merge upserts children/interfaces by id and preserves unspecified fields. |
| `rootPath` | string | — | Workspace-relative JSON file containing the root object. Use this for a large assembly instead of inlining ~20k characters; root wins if both are given. |
| `patch` | object | — | JSON-merge patch of the WHOLE manifest (root / manufacturing / claims). Arrays and scalars replace; null deletes. Applied before the root merge. |
| `manufacturing` | object | — | Top-level manufacturing policy: {allowed:[{id,note?}], approvedBy?, approvedAt?, mixApprovedBy?, mixApprovedAt?, delegate?}. Lives beside root; omitting it preserves the file's existing policy. |
| `claims` | array | — | Declared delivery claims persisted with the contract: [{kind, statement}]. delivery_audit reads them back, so no-claims-declared is avoidable. |
| `remove` | object | — | Explicit root-level deletions; omitted ids are preserved, never deleted implicitly. |

```js
cad_assembly({ action: "write", args: { reason: "…" } })
```

returns: `manifestPath`, `manifestHash`, `mode`, `changed`, `contractRevision`, `contractHash`, `changeId`, `dryRun`, `diff`, `counts`, `warnings`

