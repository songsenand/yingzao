# Tool contracts (generated — do not edit by hand)

> `node scripts/audit-tool-contracts.mjs --write`

## `analyze`

EXPERIMENTAL — do not base a delivery claim on this yet: its overhang handling is still AREA-based, which lights up whole regions (the toy-balance pan showed 1041 of 2871 samples red) instead of pointing. Build the risk map for a version and say where to LOOK: geometry corners (scan_attention) + measured wall thickness + overhang faces, each normalised to |u| in [0,1] against its own DECLARED band (dead band + saturating scales; a one-sided quantity is an open band), then fused as max|u| plus an agreement count. It never gates and never returns a verdict: a peak means "look here", not "this will break". Comfortable regions are dropped, so an empty peak list means "nothing stands out", NOT "safe".

| parameter | type | default | meaning |
|---|---|---|---|
| `versionId` | string | **required** | Saved version id, e.g. "v069". |
| `cellMm` | number | — | Clustering cell for peaks (default 8 mm). |
| `wallMinMm` | number | — | Wall band lower edge (default: the declared profile's wallMinMm, else 1.2 mm — and the reply says which). |
| `wallMaxMm` | number | — | Wall band upper edge — thick masses are a risk too (default 4.0 mm, a DECLARED heuristic, not a measurement). |
| `profileIds` | array | — | Process profiles to take the wall band from (same meaning as in check_printability). Omit and the band source says "no profile" — an unsigned threshold, which DESIGN §27.1 exists to prevent. |
| `dxMm` | number | — | Voxel size for the support estimate (default 1.0 mm). |
| `minMassG` | number | — | Unsupported MASS above which a hanging region is reported (default 1.0 g, declared). A 0.2 g sliver is free. |
| `bridgeMaxMm` | number | — | Horizontal span a printer can bridge without support (default 10 mm, declared). |

```js
analyze({ versionId: "…" })
```

returns: `peaks`, `layers`, `notMapped`, `partNotes`, `support`, `bands`, `note`


## `attach_appearance`

Attach a self-contained GLB color/material design to a saved version as a sidecar. The version keeps model.stl as geometry truth; the GLB is stored as versions/<id>/appearance.glb + appearance.json for external viewers and future panel work. There is no Blender/bpy render path and the panel still previews STL. The GLB must be v2, contain at least one mesh and one material, and embed its buffers/images.

| parameter | type | default | meaning |
|---|---|---|---|
| `versionId` | string | **required** | Saved version to attach the appearance to, e.g. "v003". |
| `file` | string | **required** | Workspace path to a self-contained .glb (GLB v2, embedded buffers/images). |
| `note` | string | — | Optional human note recorded in appearance.json (e.g. "three-color panel"). |

```js
attach_appearance({ versionId: "…", file: "…" })
```

returns: `versionId`, `file`, `sha256`, `bytes`, `materials`, `meshes`, `replaced`, `note`


## `check_assembly`

Validate the assembly manifest (BOM + interface contracts): distance, diameter-match and coaxial (axis-to-axis offset between datum_axis/datum_cyl endpoints) checks, motion-clearance (static distance plus the motion run you cite in params.runId), spring-preload (stiffness × deflection from the measured installed length), plus a discovery pass for undeclared near-touching pairs. Nodes accept transform.pose {datum, angleDeg} to rotate a part about its own datum axis (assembly/meshing pose) with the datums following. Interfaces with no implementable operator OR no declared tolerance come back in `skipped` with what would make them checkable — a missing criterion is not a pass. A structurally invalid manifest is rejected with path-addressed issues and a minimal example (schema: schemas/assembly-manifest.schema.json). mm, z-up. A relative manifestPath resolves against the session workspace first, then the plugin data root.

| parameter | type | default | meaning |
|---|---|---|---|
| `manifestPath` | string | — | Path to the assembly manifest JSON. Relative paths are tried against the session workspace (e.g. "assembly/assembly.json" → <workspace>/assembly/assembly.json, which the agent can write) and then against the plugin data root; an absolute path is used as given. Defaults to "assembly/assembly.json". |
| `adjacencyThresholdMm` | number | — | How close counts as "near" in the undeclared-adjacency discovery pass, mm. Default 0.75. Raise it (1.5–2) when the design keeps deliberate clearance gaps you want to see listed; a pair is reported when it interferes OR its gap is below this value. |

```js
check_assembly({ manifestPath: "…" })
```

returns: `overallStatus`, `judgement`, `judgedBy`, `manifestPath`, `adjacencyThresholdMm`, `summary`, `hardViolations`, `intentFlags`, `skipped`, `undeclared`


## `check_parts`

Screen up to 12 saved versions in ONE call: per version, the measure half (watertight / bodies / volume / bbox) and the SAME profile-aware printability job as check_printability. The printability half writes one printability run per version and returns its runId, so the rows can back a delivery claim; there is no second implementation. Use it to screen a family (which of these 7 is thin?) instead of N single calls; for one part the single tool is equivalent. `checks` defaults to both halves. The reply is deliberately compact — run the single-part tool when you need the full findings/attention for one part.

| parameter | type | default | meaning |
|---|---|---|---|
| `versionIds` | array | **required** | Versions to screen, e.g. ["v031","v032","v033"]. Duplicates are removed; at most 12 are screened per call. |
| `checks` | array | — | Which halves to run: "measure" and/or "printability". Default both. |
| `profileIds` | array | — | Shipped process profiles for the printability half, e.g. ["fdm-pla-0.4"]. Omit to use the built-in fallback (which downgrades a pass, as in check_printability). |
| `wallMinMm` | number | — | Wall thinner than this is reported (printability half). Default 1.2. |
| `overhangDeg` | number | — | Down-facing faces steeper than this count as overhang (printability half). Default 45. |
| `samples` | number | — | Approximate surface samples for the wall half. Default 600. |

```js
check_parts({ versionIds: [] })
```

returns: `parts`, `failures`, `summary`


## `check_printability`

Manufacturability screen for a saved version: sampled wall thickness (ray to the opposite wall along the inward normal) plus exact down-facing area steeper than the overhang angle. The wall half is SAMPLED (a thin feature between samples is missed); the overhang area is exact. If wallMeasured is false the ray half measured nothing, so the verdict is never "ok". Run it before delivering and after any wall/angle-changing edit. Judge against a DECLARED process via `profileIds` (e.g. ["fdm-pla-0.4"]) or `profilesJson`: each profile returns "excluded" (with a witness: rule, location, measured vs required) or "not-excluded" — NOT-EXCLUDED IS NOT "CAN BE MADE". It never ranks or recommends. With no profile it uses a named built-in fallback (all numbers `assumed`) and downgrades ok to check. Authoring a profile: cad-manufacturing skill. JUDGEMENT vs DETECTION: this tool produces both halves; pass `mode` to get one. A green verdict says nothing about where to look, and the attention field is not a verdict (DESIGN §25.7).

| parameter | type | default | meaning |
|---|---|---|---|
| `mode` | string (judge \| scan \| both) | — | "judge" (default) returns ONLY the judgement half (verdict / findings / profiles, no attention field); "scan" returns ONLY the attention field and NO verdict, because a risk map must never be read as a gate; "both" returns the two halves as separate keys. The run ALWAYS records both halves (report.json + attention.json) — the mode trims the reply, not the record (DESIGN §25.7). |
| `versionId` | string | **required** | Saved version id to screen, e.g. "v012". |
| `wallMinMm` | number | — | Wall thinner than this is reported. Default 1.2 (≈2× a 0.4mm nozzle line width). |
| `overhangDeg` | number | — | A down-facing face tilted more than this many degrees from vertical counts as needing support. Default 45. |
| `samples` | number | — | Approximate surface samples. Default 600; raise for big meshes, lower for quick passes. |
| `profileIds` | array | — | Shipped process profiles to judge against, e.g. ["fdm-pla-0.4"]. Each yields its own two-valued verdict. Omit (with profilesJson) to use the built-in fallback, which the report then names. |
| `profilesJson` | string | — | An inline JSON array of process profiles (schema: schemas/process-profile.schema.json). Use for a profile you authored; an invalid one is REFUSED with the offending rule named. |

```js
check_printability({ versionId: "…" })
```

returns: `versionId`, `nextLook`, `verdict`, `minWallMm`, `wallMeasured`, `thinSamples`, `sampled`, `thinAreaMm2`, `thinAreaPct`, `surfaceAreaMm2`, `overhangAreaMm2`, `overhangZRange`, `findings`, `minWallAtMm`, `watertight`, `attention`, `profileSource`, `profiles`


## `create_part`

Name a part before any geometry exists; idempotent. generate_part creates a part automatically, so call this only to open a subject the user has merely talked about.

| parameter | type | default | meaning |
|---|---|---|---|
| `name` | string | **required** | The name a human would call it, e.g. "调焦轴". Used as the part label in the panel. |

```js
create_part({ name: "…" })
```

returns: `partId`, `name`, `created`


## `delivery_audit`

Audit the corpus before delivering: failing runs that are still the newest of their kind, parts whose newest version no run ever checked, runs citing superseded geometry (stale evidence), contract gaps (e.g. no motion-clearance interface while the assembly has several parts), contract nodes pointing at replaced versions, repeated runs that add no information, and mesh files on disk that NO version accounts for (a part written straight to a file never reaches the panel or any tool — a human cannot see it). Run this BEFORE any delivery claim; a blocked verdict means the corpus itself contradicts the claim.

| parameter | type | default | meaning |
|---|---|---|---|
| `manifestPath` | string | — | Assembly manifest to audit against. Defaults to assembly/assembly.json in the session workspace. |
| `claims` | array | — | Delivery CLAIMS to back with evidence: {kind, statement}. kind is strength \| motion \| assembly \| manufacturability \| appearance \| review. A claim with no fresh run of the kind it needs is reported as claim-without-evidence (blocked). Omit it and the audit declines to judge any delivery claim — it only says whether the CORPUS is coherent. |
| `scanPaths` | array | — | Workspace-relative roots scanned for mesh files no version accounts for. Default ["."] (whole workspace, skipping the corpus, nested projects and common build dirs); pass [] to disable. A found file NEWER than the newest version is blocked — register it with import_part or declare it exempt. |
| `exempt` | array | — | Declared exceptions for files intentionally left as files (e.g. bought/reference geometry): {path, reason}. Reported as info, never blocked, and the reason is echoed. Use it instead of narrowing scanPaths when the file is a legitimate non-version. |

```js
delivery_audit({ manifestPath: "…" })
```

returns: `verdict`, `judgement`, `findings`, `summary`, `versions`, `parts`, `runs`, `contract`, `unregistered`


## `generate_part`

Compile OpenSCAD into a new part version; renders top/front/side/iso (all four attached by default; trim with `views` to save image budget on numeric iterations). Write complete self-contained code with $fn=64 (BOSL2 is available: std/screws/gears/walls). Declare anchors with `datum("name",[x,y,z])` at top level in final world coordinates; they do not affect the mesh. The FIRST version of a part also gets a sampled wall screen (minWallMm + warning) — when several parts share a new feature (a slot, a snap, a thread), generate ONE representative, fix its screen, then generate the family; regenerating N parts after a shared defect costs N rounds.

| parameter | type | default | meaning |
|---|---|---|---|
| `scadCode` | string | **required** | Complete OpenSCAD source code for the part. Must be self-contained; no external libraries. |
| `userIntent` | string | **required** | One-line summary of what the part should look like, used in the version history. |
| `parentVersion` | string | — | Version id this iteration derives from, e.g. "v003". Must belong to the same part. |
| `part` | string | — | Which part this version belongs to — the name the user would call it, e.g. "调焦轴". ALWAYS pass this when iterating: it is what groups versions into one part in the panel. Omit only for a brand-new part with no parentVersion (a name is then derived from userIntent), or to inherit the parentVersion's part. |
| `views` | array | — | Which render views to ATTACH (each attached image spends context image budget): subset of ["top","front","side","iso"]. Default: all four — right for a new shape or a shape change you need to SEE. For an iteration that only changes a number you will verify by measurement (a hole Ø, a length), pass ["iso"]. Pass [] to register the version with NO images attached — the panel still shows the geometry, so the human is not blinded. |

```js
generate_part({ scadCode: "…", userIntent: "…" })
```

returns: `versionId`, `success`, `errors`, `warnings`, `durationMs`, `views`, `sizeMm`, `bboxMin`, `bboxMax`, `watertight`, `triangles`, `shells`, `minWallMm`, `minWallAtMm`, `part`


## `import_part`

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
import_part({ file: "…" })
```

returns: `versionId`, `part`, `format`, `solid`, `watertight`, `repaired`, `triangles`, `shells`, `genus`, `volumeMm3`, `sizeMm`, `unit`, `scaleApplied`, `sha256`, `sourcePath`, `datums`, `warnings`, `durationMs`, `views`


## `list_features`

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
list_features({ versionId: "…" })
```

returns: `versionId`, `watertight`, `triangles`, `thresholds`, `faces`, `facesOmitted`, `curvedSegmentFacets`, `cylinders`, `curvedSurfaces`, `faceCount`, `holeCount`, `cylinderCount`, `warnings`


## `measure_angle`

The angle between two directions, plus the distance between their lines. Name each side ONE of three ways: `aProbe` [x,y,z] (a point — the direction becomes the normal of the face it lands on, so a rough guess is enough), `aDatum` (an axis / cylinder / plane datum, resolved exactly), or `aPoints` [[x,y,z],[x,y,z]] (the direction is the segment; give [apex, point] for a corner) / `aDir` (a vector you already know). Returns angleDeg (between the vectors AS GIVEN, 0..180), acuteDeg (0..90 — the usual reading of "the angle between two lines") and supplementDeg TOGETHER, with lineDistanceMm (perpendicular offset for parallel lines, closest approach for skew), commonNormalMm and the crossing point when they meet. Angles are degrees. mm, z-up.

| parameter | type | default | meaning |
|---|---|---|---|
| `versionId` | string | **required** | Version whose surface side b snaps a probe to (and the default for side b's datum). |
| `aVersionId` | string | — | Version for side a when the two sides live on different parts. Defaults to versionId. |
| `bVersionId` | string | — | Version for side b. Defaults to versionId. |
| `aProbe` | array | — | Side a as a POINT [x,y,z] mm: the direction becomes the normal of the nearest face. Approximate is fine. |
| `bProbe` | array | — | Side b as a point (nearest face normal). |
| `aDatum` | string | — | Side a as a datum name declared on aVersionId: axis / cylinder / plane give a direction, resolved EXACTLY. |
| `bDatum` | string | — | Side b as a datum name declared on bVersionId. |
| `aPoints` | array | — | Side a as two points [[x,y,z],[x,y,z]]; the direction is the segment between them. |
| `bPoints` | array | — | Side b as two points. |
| `aDir` | array | — | Side a as a direction vector [x,y,z] you already know (e.g. a face normal read out of list_features). |
| `bDir` | array | — | Side b as a direction vector. |
| `aOrigin` | array | — | A point ON side a's line. Needed for a meaningful lineDistanceMm / coplanar / crossing point when you gave aDir instead of a position. |
| `bOrigin` | array | — | A point on side b's line. |
| `parallelToleranceDeg` | number | — | Within this many degrees of 0 the lines count as parallel (and 90 as perpendicular). Default 0.5. |

```js
measure_angle({ versionId: "…" })
```

returns: `versionId`, `aDirMm`, `bDirMm`, `aOriginMm`, `bOriginMm`, `aSource`, `bSource`, `anchoredAtOrigin`, `angleDeg`, `acuteDeg`, `supplementDeg`, `parallel`, `perpendicular`, `coplanar`, `lineDistanceMm`, `commonNormalMm`, `crossingPointMm`, `convention`, `warnings`


## `measure_gap`

How far apart two things are, however you name them. Each endpoint is ONE of: a saved solid (`aVersionId`/`bVersionId`), an analytic sphere (`aSphere`/`bSphere`, solved exactly), a coordinate (`aPoint`/`bPoint`, snapped to the surface by default) or a declared datum (`aDatum`/`bDatum`, resolved EXACTLY and never snapped). Solid/sphere pairs are solved as a closest-point problem and come back with an annotated render; point/datum pairs come back with per-endpoint snap distances and whether your input point was inside the solid. Both endpoints must be the same kind — a solid cannot be paired with a point in one call. mm, z-up.

| parameter | type | default | meaning |
|---|---|---|---|
| `versionId` | string | — | The base part: it owns endpoint A and, unless bOn says otherwise, endpoint B. Required for point/datum endpoints; a solid/sphere pair does not need it. |
| `aVersionId` | string | — | Endpoint A as a whole solid: saved version id. |
| `aSphere` | object | — | Endpoint A as an analytic sphere probe {center:[x,y,z], radius} — solved exactly. |
| `aPoint` | array | — | Endpoint A as a coordinate [x,y,z] mm — approximate is fine (snapped to versionId's surface). Give this OR aDatum. |
| `aDatum` | string | — | Endpoint A as a datum anchor declared via datum("name",[x,y,z]). Resolved EXACT (no snapping) — prefer over aPoint. |
| `bVersionId` | string | — | Endpoint B as a whole solid: saved version id. |
| `bSphere` | object | — | Endpoint B as an analytic sphere probe. |
| `bPoint` | array | — | Endpoint B as a coordinate [x,y,z] mm — snapped to bOn's surface (bOn defaults to versionId). Give this OR bDatum. |
| `bDatum` | string | — | Endpoint B as a datum anchor on bOn (defaults to versionId). Resolved EXACT — prefer over bPoint. |
| `bOn` | string | — | Which part a bPoint/bDatum endpoint belongs to. Defaults to versionId. (This is what the retired measure_distance meant by bVersionId.) |
| `snap` | boolean | — | Snap raw coordinate inputs to the nearest surface point. Default true. Datum-resolved points are never snapped. |

```js
measure_gap({ versionId: "…" })
```

returns: `distanceMm`, `dxMm`, `dyMm`, `dzMm`, `pointA`, `pointB`, `method`, `frame`, `aSnapDistanceMm`, `bSnapDistanceMm`, `aOutside`, `bOutside`, `warnings`


## `measure_part`

Whole-part ground truth in one call: bounding box (size AND min/max), volume, surface area, centre of mass, triangle count, watertightness, genus, and the mutually disconnected BODIES with each one's bbox (a part must be a single body). Pass `axis` (x|y|z, a leading "-" flips it) or `axisVector` for a non-principal direction and you also get the projection along it: min/max, size, centre and the two extremal VERTICES — the coordinates you would otherwise hunt for by hand, and a point ON the part to hand to another measurement. mm, z-up. For a per-feature extent (a cylinder's length, a hole's depth) use `list_features` instead. On an open / non-manifold mesh the mass properties are OMITTED (with a warning) rather than guessed, but the body count still comes back.

| parameter | type | default | meaning |
|---|---|---|---|
| `versionId` | string | **required** | Saved version, e.g. "v003". |
| `axis` | string | — | Optional. Project on x \| y \| z (a leading "-" flips it). For anything else use axisVector. Without either, only the axis-aligned bbox is reported. |
| `axisVector` | array | — | Optional projection axis [x,y,z] for a non-principal direction (a diagonal, a slanted boss); normalised internally. |

```js
measure_part({ versionId: "…" })
```

returns: `versionId`, `watertight`, `triangles`, `sizeMm`, `bboxMinMm`, `bboxMaxMm`, `volumeMm3`, `surfaceAreaMm2`, `centerOfMassMm`, `genus`, `bodies`, `bodySizes`, `bodyCenters`, `bodyVerdict`, `extent`, `warnings`


## `measure_section`

Cut a saved version with a plane and return the SECTION AS DATA: every polygon, its outer ring (points in the plane's 2D frame AND in world mm, with per-segment lengths and angles), every hole in it (centre, diameter, kind, and the exact segment-to-segment wall thickness to the outside), and the centre distance and clearance between neighbouring holes. Use it for hole spacing, wall thickness or an in-plane angle WITHOUT naming any 3D point — `axis` plus `fraction` is the whole input. The plane's own u/v axes are reported, so a follow-up `measure_distance` can be written against the world coordinates it returns. Holes are found by polygonising the cut, so a slot is reported as non-circular rather than forced through a circle. mm, z-up.

| parameter | type | default | meaning |
|---|---|---|---|
| `versionId` | string | **required** | Saved version to section, e.g. "v003". |
| `axis` | string | — | Plane normal along a principal axis: x \| y \| z (a leading "-" flips it). Default z, i.e. a horizontal cut. |
| `fraction` | number | — | Where to cut, as 0..1 across the bounding box along the axis. Default 0.5 (mid-height). |
| `atMm` | number | — | Explicit cut position in mm along the axis — wins over `fraction`. The version's extent along that axis is reported as planeRangeMm. |
| `simplifyToleranceMm` | number | — | Ring vertices within this distance of the line through their neighbours are dropped. Default 0.01 (a $fn=64 R=10 circle keeps every vertex). |
| `maxPolygons` | integer | — | Cap on reported polygons, largest first. Default 12. |
| `maxHolesPerPolygon` | integer | — | Cap on holes reported per polygon. Default 24. |
| `maxHoleNeighbours` | integer | — | How many nearest holes to relate to each hole. Default 3. |

```js
measure_section({ versionId: "…" })
```

returns: `versionId`, `axisMm`, `atMm`, `originMm`, `uAxisMm`, `vAxisMm`, `planeRangeMm`, `thresholds`, `empty`, `polygons`, `polygonsOmitted`, `voidRegions`, `holeSpacing`, `areaMm2`, `perimeterMm`, `bboxUvMm`, `holeCount`, `warnings`


## `measure_thickness`

Every material span along one ray, in a single call: wall thicknesses, internal cavities and cross-part clearances. Give a start point (APPROXIMATE IS FINE — the ray only has to cross the wall, not hit a surface) and an axis. Returns, for each span, the enter/exit distance from the start, the thickness, the point and surface normal at each end, plus the gap between consecutive spans. Opposite entry/exit normals mean a wall; same-facing normals mean a slot, not a wall. Pass bVersionId to read a clearance between two parts along the same line (tagged "a→b"). Prefer this over measure_distance whenever you cannot name an exact surface point. mm, z-up.

| parameter | type | default | meaning |
|---|---|---|---|
| `versionId` | string | **required** | Saved version to probe, e.g. "v003". |
| `from` | array | — | Start point [x,y,z] mm — approximate is fine. Give this OR fromDatum. |
| `fromDatum` | string | — | Datum anchor name, resolved EXACTLY (no guessing). Prefer over `from` when the part declares one. |
| `direction` | string | — | Ray direction along a principal axis: +x \| -x \| +y \| -y \| +z \| -z. Give this OR directionVector. Pick the axis that crosses the feature you care about. |
| `directionVector` | array | — | Ray direction [x,y,z] for a non-axis-aligned probe; normalised internally. |
| `bVersionId` | string | — | Second part included in the same ray, so a gap between the two comes back tagged "a→b". |
| `maxSpanMm` | number | — | Stop reporting past this distance from `from`, mm. A span cut by the limit comes back with clipped:true. |

```js
measure_thickness({ versionId: "…" })
```

returns: `direction`, `from`, `fromInsideSolid`, `spans`, `gaps`, `thinnestSpanMm`, `clipped`, `nudgedMm`, `probeAgreement`, `watertightA`, `watertightB`, `warnings`


## `merge_parts`

Union two or more parts, each at its assembly placement, into ONE new solid part version. Use it when the whole machine must be a single rigid body: simulate_physics topple/stability, or a whole-assembly measure_part. Replaces hand-merging STLs in OpenSCAD. mm, z-up; rotate first (degrees in R = Rz·Ry·Rx — the OpenSCAD/Manifold composition; three.js order `ZYX`), then translate.

| parameter | type | default | meaning |
|---|---|---|---|
| `parts` | array | **required** | Parts to union (at least 2), each with its placement in the merged body's frame. |
| `userIntent` | string | **required** | One-line summary for the version history, e.g. "整机刚体（用于倾倒测试）". |
| `part` | string | — | Which part the merged version belongs to. Defaults to a name derived from userIntent. Pass this to re-merge into an existing part. |

```js
merge_parts({ parts: [], userIntent: "…" })
```

returns: `versionId`, `part`, `triangles`, `volumeMm3`, `sizeMm`, `shells`, `sources`, `warnings`, `durationMs`, `views`


## `preflight`

Run the mandatory delivery sequence in one call: printability for every part (newest version, against the `profileIds` you declare), mesh health, support cost, the assembly contract and the corpus audit with your `claims`. `judgement` is the worst step that RAN; a step that was attempted and failed forces `difficult`, and it never averages away. Steps this cut does not orchestrate at all (simulation evidence, the assembly render) are listed in `coverage.notCovered` with a reason — they are named, not silently green, and they do not enter the judgement. Read `unevaluable` before claiming anything: not-excluded means "no counter-example", never "ok" and never "safe".

| parameter | type | default | meaning |
|---|---|---|---|
| `claims` | array | — | Delivery claims to back with evidence: {kind, statement}. kind = strength \| motion \| assembly \| manufacturability \| appearance \| review. |
| `profileIds` | array | — | Declared process profiles to screen against (same meaning as in check_printability). |
| `scanPaths` | array | — | Workspace-relative roots for the unregistered-geometry scan (same meaning as in delivery_audit). Default ["."]; [] disables it. |
| `exempt` | array | — | Declared exceptions for files intentionally left as files: {path, reason} (same meaning as in delivery_audit). |

```js
preflight({ claims: [] })
```

returns: `judgement`, `steps`, `ran`, `notRun`, `unevaluable`, `coverage`, `summary`, `timings`


## `python_runtime`

Status, repair and EXTENSION for the plugin's bundled Python runtime (CPython 3.13 + pinned numpy/scipy/trimesh/manifold3d/networkx/scikit-fem/rtree/rapier3d). action "status" (default) reports where it is, whether it is usable, its size, the last error and the USER OVERLAY; "provision" installs it now instead of waiting for the first run_python call; "repair" rebuilds the dependency environment; "install" adds packages to the user overlay — the runtime is the user's machine, so installing is a normal act, not a favour: the packages land in a directory provisioning never deletes, the worker and run_python both see them, and the overlay is recorded (status + run provenance). DEFAULT: adding is not overriding — a package the lock also provides keeps the LOCKED version (reported as shadowed). EXPLICIT: override:true + reason:"…" installs into a separate directory placed at the FRONT of sys.path, so the new version really replaces the locked one; agree it with the human first and expect runs to carry it in pythonOverlay.overrides. Use it when run_python reports a runtime problem, to warm the runtime before a long batch, or when a task needs a library we do not ship.

| parameter | type | default | meaning |
|---|---|---|---|
| `action` | string (status \| provision \| repair \| install) | — | status (default) \| provision \| repair \| install |
| `packages` | array | — | action=install only: package specs for pip, e.g. ["six==1.17.0", "svgpathtools"]. They go into the user overlay (not the locked venv), so a runtime update cannot erase them. |
| `override` | boolean | — | action=install only: explicitly REPLACE a package the lock pins. Default false = the copy is additive and the locked version keeps precedence. Requires reason. |
| `reason` | string | — | action=install + override: why the locked version cannot be used. Recorded with the install and carried into run provenance — this is the declaration, not ceremony. |

```js
python_runtime({ action: "status" })
```

returns: `action`, `state`, `root`, `target`, `pythonVersion`, `mode`, `source`, `interpreter`, `venvPython`, `installedAt`, `phase`, `error`, `occupiedBytes`, `occupied`, `skipped`, `missingPackages`, `overlay`, `installed`, `overrides`, `shadowed`, `provisionLog`, `summary`


## `recall_reference_image`

Re-attach a user-uploaded reference image (or any earlier attachment) as a fresh image on this tool result. Use it when a reference image has been pruned from context (its placeholder reads "image omitted; <name>; path=<path>") and the task depends on seeing it again — comparing a build against a reference, matching proportions or colors. Pass the `path` from the placeholder, or the `attachmentId`. The recalled image becomes the NEWEST image in context, so it survives pruning for the following rounds; recall again when needed.

| parameter | type | default | meaning |
|---|---|---|---|
| `path` | string | — | Local file path of the pruned image, exactly as the "image omitted" placeholder names it (preferred). |
| `attachmentId` | string | — | Durable attachment id (sha256:…) if the placeholder or history named one instead of a path. |
| `name` | string | — | Display name to keep for the recalled image; defaults to the file name or the attachment id. |

```js
recall_reference_image({ path: "…" })
```

returns: `recalled`, `source`, `mediaType`, `bytes`, `attached`


## `render_part`

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
render_part({ versionId: "…" })
```

returns: `versionId`, `label`, `file`


## `request_review`

Ask the human to look at something (a version, a run, a part) or to consider a rollback — queued, never a popup. The panel badges the queue; the human opens it when they choose. Limits: 3 items per call, 6 calls per 10 minutes, 20 unread; repeating the same target within 10 minutes updates that item instead of adding another.

| parameter | type | default | meaning |
|---|---|---|---|
| `items` | array | **required** | Up to 3 items. Each is one thing to look at, with a one-line title. |

```js
request_review({ items: [] })
```

returns: `queued`, `merged`, `dropped`, `unread`, `rateLimited`


## `run_python`

Run Python in the plugin's own pinned runtime — CPython 3.13 with numpy, scipy, trimesh, manifold3d, networkx, scikit-fem and rapier3d (rapier3d only where a wheel exists for this platform; python_runtime reports what this machine has) — not the host's system interpreter. Pass `code` for a one-off program, or `script` to run an existing .py file (relative to the project directory). Use it for numerical analysis, mesh measurement on an exported STL, FEM/optimisation probes, or any check the CAD tools do not cover. It also sees the USER OVERLAY (python_runtime action=install): installing a library is a normal act on the user's own machine, not an exception — the overlay survives runtime updates and is recorded in run provenance, so add one when the task needs what we do not ship. The process runs with your user's full filesystem access (no sandbox), in the project directory, and is killed at the timeout. On failure the complete Python traceback comes back. The first call on a machine installs the runtime once (hundreds of MB, progress reported); python_runtime shows or repairs it.

| parameter | type | default | meaning |
|---|---|---|---|
| `code` | string | — | Python source to run. Mutually exclusive with `script`; prints go to stdout, and an uncaught exception returns its traceback. |
| `script` | string | — | Path to an existing .py file — absolute, or relative to the project directory. Mutually exclusive with `code`. |
| `args` | array | — | Command-line arguments appended after the script path (sys.argv[1:]). |
| `cwd` | string | — | Working directory for the run; defaults to the project directory. Relative paths resolve against the project directory. |
| `timeoutSec` | number | — | Wall-clock budget in seconds (default 120, maximum 600). On expiry the process group is killed and the result says so. |

```js
run_python({ code: "…" })
```

returns: `ok`, `python`, `runtimeSource`, `scriptPath`, `exitCode`, `signal`, `timedOut`, `durationMs`, `stdout`, `stderr`, `traceback`, `truncated`, `protocolVersion`, `provisionLog`


## `scan_attention`

Where to LOOK on a saved version — not a verdict. Mesh health (watertight, body count) plus REENTRANT CORNERS: concave edges whose face normals turn by more than `concaveMinDeg` (default 100°), chained and located. θ=90° is an ordinary T-junction (not reported); θ=135° is a 45° V-notch; θ→180° is a knife slit. A notch is where printed parts initiate cracks, so each one comes back with a coordinate, a bbox and a runnable next observation. Run it on a new part, and again after any geometry change: it is how a fix is shown to have worked (the repaired part must go quiet).

| parameter | type | default | meaning |
|---|---|---|---|
| `versionId` | string | **required** | Saved version id to scan, e.g. "v012". |
| `concaveMinDeg` | number | — | Report concave edges sharper than this face-normal angle. Default 100 (just past a right angle). |
| `minChainMm` | number | — | Ignore chained edges shorter than this, mm. Default 0.5. |

```js
scan_attention({ versionId: "…" })
```

returns: `versionId`, `stats`, `suspects`


## `set_datums`

Read or declare the datum anchors of a version. Call it with only versionId to list what that version declares (names and world coordinates) — the input you need to write assembly interfaces. Call it with datums to record anchors; because an anchor is what an interface RESOLVES against, declaring them creates a NEW version (parent = the given one) instead of rewriting history: a run that cited the old anchors must keep meaning what it meant (§22 evidence). The mesh is copied byte-for-byte, so the geometry is identical.

| parameter | type | default | meaning |
|---|---|---|---|
| `versionId` | string | **required** | Version to read or edit, e.g. "v003". |
| `datums` | array | — | Anchors to write. Omit to list the current ones. Coordinates are in the version's own stored frame, final world coordinates. |
| `replace` | boolean | — | true = drop the existing anchors and keep only these. Default false = merge by name (an incoming anchor of the same name replaces the old one). |

```js
set_datums({ versionId: "…" })
```

returns: `versionId`, `previousVersionId`, `userIntent`, `mode`, `datums`, `counts`, `warnings`


## `simulate_fluid`

MPM (CPU) flow through a pipe or part cavity: arrival, section velocities, conservation, snapshots. The solid boundary stays fixed for the whole run.

| parameter | type | default | meaning |
|---|---|---|---|
| `pipeScad` | string | **required** | Complete OpenSCAD source of the pipe/cavity (the SOLID; the fluid flows through its bore). Self-contained, $fn=48+. |
| `fluidRegionMm` | object | — | Particle seed box {min:[x,y,z], max:[x,y,z]} in mm. Default: derived from the pipe (30% of the length at the inlet end, 3mm wall clearance). |
| `inletVelocityMmPerSec` | number | — | Inlet axial speed. Default 100 mm/s. |
| `particleCount` | number | — | Explicit particle count. Default auto (4-8 particles/cell, typically 50k-300k). |
| `particlesPerCell` | number | — | Seed density (sweet spot 4-8). Default 6. |
| `steps` | number | — | Simulation steps (dt=4ms). Default derived from travel time ×1.6, min 600. |
| `gravityMmPerSec2` | array | — | Gravity [x,y,z] mm/s². Default [0,0,-98.1]; use [0,0,0] for pure driven flow. |

```js
simulate_fluid({ pipeScad: "…" })
```

returns: `overallStatus`, `metrics`, `frames`


## `simulate_lbm`

Lattice-Boltzmann channel flow (XLB, CPU): developed velocity profile vs the Poiseuille parabola, mirror symmetry and stability at a chosen Reynolds number. Stage-A template — the domain is a rectangular channel with box walls; no embedded solids, no heat, single phase.

| parameter | type | default | meaning |
|---|---|---|---|
| `cells` | array | — | Lattice resolution [nx,ny,nz]; nx is the flow direction. Default [48,24,24]. Keep the product ≤ ~200k on CPU; runtime is linear in steps×cells. |
| `reynolds` | number | — | Channel Reynolds number based on (ny-1) cells. Default 100. Development length grows ~with Re — raise steps together with Re. |
| `latticeVelocity` | number | — | Inlet speed in lattice units. Default 0.05; keep ≤0.1 (weakly compressible LBM). |
| `steps` | number | — | Time steps. Default 20000 (≈75% developed on the default grid); quote numbers only near the developed end. |

```js
simulate_lbm({ cells: [] })
```

returns: `overallStatus`, `metrics`


## `simulate_motion`

Assembled-mechanism kinematics: a constant-speed crank AND/OR prescribed sinusoidal movers (no crank is required when every mover is an oscillator), revolute/prismatic followers, optionally parts on prescribed sinusoidal paths. Returns stroke/period, an exact interference timeline at >=24 sampled poses per run (final pose included; fewer means check, never pass), joint anchor drift, keyframes. Gravity is off.

| parameter | type | default | meaning |
|---|---|---|---|
| `parts` | array | **required** | Parts of the mechanism. The crank should be bodyType "kinematic". |
| `joints` | array | **required** | Joints between parts. |
| `drive` | object | — | The constant-speed crank drive. Omit it when every mover is a prescribed oscillator (a guide/valve following a sinusoid): the time base is then the oscillator period. A run with neither a drive nor an oscillator is refused — nothing would move. |
| `oscillators` | array | — | Prescribed sinusoidal movers (valves). bodyType must be "kinematic". |
| `cycles` | number | — | Drive cycles to simulate. Default 2. FRACTIONAL values are meaningful and are honoured: a balance whose design range is ±14° sweeps 0.078 of a turn, and asking for a whole turn instead answers a different question (the beam becomes a windmill and every part of it collides). |

```js
simulate_motion({ parts: [], joints: [] })
```

returns: `overallStatus`, `followers`, `interferenceCount`, `interferenceEvents`, `interferenceChecks`, `candidatePairs`, `interferencePairChecks`, `samplingSatisfied`, `maxSampleGapDeg`, `blocking`, `deliverability`, `maxJointDriftMm`, `geometrySuspects`, `geometrySuspectRule`, `hasCrank`, `initialJointGaps`, `jointToleranceMm`, `jointViolations`, `pivots`, `keyframes`, `stepsRun`, `durationSec`


## `simulate_physics`

Rigid-body simulation (rapier, z-up, millimetres) over discrete parts: settled penetration, toppling, joint violations, drift, plus keyframe images. Joints may be revolute (hinge) or prismatic (slide). Start parts slightly separated — gravity closes the gap.

| parameter | type | default | meaning |
|---|---|---|---|
| `parts` | array | **required** | Parts in the scene. |
| `joints` | array | — | Joints between parts: "revolute" (hinge) or "prismatic" (slide). |
| `durationSec` | number | — | Simulation length. Default 2. |
| `gravity` | array | — | mm/s². Default [0,0,-9810] (z-up). |
| `tiltDeg` | number | — | Tilt gravity by this many degrees about tiltAboutAxis (default [0,1,0]) — the slope scenario without hand-computing the gravity vector. Ignored when gravity is given. |
| `tiltAboutAxis` | array | — | Axis to tilt about, default [0,1,0]. |

```js
simulate_physics({ parts: [] })
```

returns: `overallStatus`, `settledPenetrationMm`, `geometrySuspects`, `geometrySuspectRule`, `maxPenetrationMm`, `fellOver`, `jointViolations`, `holdAnalysis`, `notes`, `keyframes`


## `simulate_stress`

Static linear-elastic stress of a saved version (voxel hex8 FEM, matrix-free CG). You must declare the CASE — material, supports and loads — because "the stress" without one is not a number. TRUST from this tool: the integrals (reaction, section force/moment, compliance, strain energy), the hot-spot LOCATIONS, and the surface stress recovered by extrapolating the depth profile inward from each hot spot. DO NOT ASK IT FOR "the largest element stress": there is no such field, because on a curved or notched boundary it grows without bound under refinement (measured 1.002 → 1.184, and fill-ratio weighting did not fix it). DO NOT read a tier or a peak as a safety factor: the model is isotropic, so an FDM part's layer-direction weakness — usually what breaks first — is invisible to it. Peaks are read at `criticalDistanceMm` inside the surface (a declared distance; the distance actually used comes back as effectiveSampleDistanceMm) — that declared-distance reading is the number to quote. A region's `surfaceExtrapolatedMPa` (the depth profile fitted out to the surface) is a HIGHER estimate and is only quoted when it passes BOTH its own fit check and a cross-resolution check (`extrapolationCrossResolutionPct`), because a good fit R^2 is not sufficient: on a fillet the fit looked fine (R^2 0.90) while the value moved 17% between grids. Every region also carries the wall thickness it tunnels through in cells and a `trustworthy` flag with `whyUntrustworthy`; an untrustworthy region means the position/value may not be quoted — refine dxMm. Deliver against `delivery` (excluded / difficult / not-excluded, with witnesses), NOT against `verdict`: a missing number is not a pass, and the geometry suspects in `attention` are DETECTION (where to look), never delivery evidence. THIS TOOL IS NEVER SILENT: when it cannot certify any region it still returns a `geometry-suspects` layer — the reentrant corners already known from the geometry scan, labelled as geometry and NOT as stress — so a run always says where to look next (HARNESS §11.14). A part whose members are thinner than the voxel cannot be certified at any affordable dxMm — the report then says so (verdict check, zero trustworthy regions) instead of drawing an authoritative-looking heatmap. Run it once per load case, and again after any change to the material, the supports or the geometry: comparing two versions under the SAME case is the re-check.

| parameter | type | default | meaning |
|---|---|---|---|
| `versionId` | string | **required** | Saved version id to analyse, e.g. "v050". |
| `loads` | array | **required** | The load case. Each entry is a force in N applied either to a whole bounding-box face or to the nodes within radiusMm of atMm. |
| `supports` | array | — | Where the part is held. A face locks the outermost node layer; atMm locks the nodes within radiusMm (e.g. a knife edge resting on a pin). An unsupported load is a rigid-body mode and is REFUSED, not fudged. |
| `mode` | string (judge \| scan \| both) | — | "judge" (default) returns ONLY the delivery judgement; "scan" returns ONLY the attention field and NO verdict, because a risk map must never be read as a gate; "both" returns the two halves as separate keys. The default is the stricter half (DESIGN §25.7). |
| `excludeFromReport` | array | — | Cells to drop from the reported field, peaks, regions and percentiles — for SUPPORT and LOAD patches, whose stress is an artifact of the idealisation (a clamped patch is not a knife edge on a pin). The excluded cell count comes back in method.excludedCells, so the exclusion is declared rather than silent. |
| `materialIds` | array | — | Shipped materials, e.g. ["fdm-pla"]. The strength behind the tiers is the LAYER-ADHESION band, not the bulk figure. Omit (with materialJson) for your own; the built-in is marked assumed. |
| `materialJson` | string | — | Inline material: {"id","name","youngModulusMPa","poissonRatio","strengthMPa"}. Use for a filament you have data for. |
| `dxMm` | number | — | Voxel size in mm. Default: 8 cells across the thinnest dimension. Halving it costs ~8x. A hot spot thinner than ~8 cells needs a finer grid before its position is trustworthy. |
| `criticalDistanceMm` | number | — | Distance inside the surface at which peaks are read. Default 1.0 mm (the grid cannot sample closer than one cell; the distance actually used comes back as effectiveSampleDistanceMm). |
| `probeAtMm` | array | — | Watch this point: report its displacement, e.g. a pan centre or a beam tip. |
| `resultants` | array | — | Section resultants to integrate — the trustworthy half of this tool: axial force, shear, bending moment, plus the section area and its second moment so an analytic check can be closed on a profile too complex to hand-compute. Place the cut AWAY from a support: a cut through the support patch swallows part of the reaction. |
| `runConvergence` | boolean | — | Also solve a coarser grid and report the deltas (default true; costs ~30% more). A drifting verdict means refine before quoting. |

```js
simulate_stress({ versionId: "…", loads: [] })
```

returns: `versionId`, `nextLook`, `verdict`, `delivery`, `material`, `method`, `checks`, `resultants`, `capability`, `attention`


## `validate_assembly`

Static multi-part check: watertightness plus, for every pair, exact interference volume and minimum clearance, in the poses you give. Behaviour under gravity or motion is simulate_physics.

| parameter | type | default | meaning |
|---|---|---|---|
| `parts` | array | **required** | Parts of the assembly. |
| `clearanceThreshold` | number | — | Minimum allowed clearance in mm between non-interfering parts. Default 0.75. |
| `interferenceEpsilonMm3` | number | — | Interference below this volume (mm³) counts as polygonal-fit residual, not a clash. Default 1e-3. Raise it (e.g. 1) when a printed thread's segmentation noise keeps drowning the report. |

```js
validate_assembly({ parts: [] })
```

returns: `overallStatus`, `judgement`, `judgedBy`, `parts`, `pairs`

