# Process catalogue: every common method has a verification method

[中文](../../llm/processes.md) | English

`manufacturing.allowed` is **what the user can actually get** (the decision space); `verification` is **how it is checked**. Keep them separate; the catalogue has no “unsupported with no method”:

| support | Meaning |
|---|---|
| **supported** | Evaluator implemented; covers the main geometric failure modes for that process |
| **partial** | Evaluator implemented; only some criteria are screened; `handoff` lists the rest |
| **planned** | Method, criteria and inputs are defined; evaluator not implemented. A decision may be recorded, but never read as pass |

## Common methods

| id | Process | support | Verification (geometry) | Inputs | Still handoff |
|---|---|---|---|---|---|
| `fdm-pla-0.4` | FDM | supported | wall/feature/clearance + overhang area + print orientation | layer/nozzle profile | layer strength, warping, actual print |
| `sla-resin` | Resin | **partial** | wall/feature/clearance + overhang/support + sealed-cavity drain reachability | resin profile, drain holes | suction, shrinkage, post-cure |
| `sls-pa12` | SLS/MJF | **partial** | wall/feature/clearance + powder-clearance reachability (powder bed self-supporting, overhang off) | powder profile, escape holes | cleaning effectiveness, nesting/orientation cost, density/warp |
| `injection-pp` | Injection moulding | **partial** | wall/feature/clearance + draft/undercut (shipped profile; overhang/bridging/venting explicitly not applicable) | min wall, min draft | fill/pack, sink, warp, gate/cooling |
| `die-casting-alu` | Die casting | **partial** | wall/feature/clearance + draft/undercut (best opening direction) | min draft, alloy wall rules | fill/porosity, hot tears, gate/overflow, tool life |
| `sand-casting` | Sand casting | **partial** | wall/feature/clearance + draft (best draw direction) | min draft, machining allowance | shrinkage/porosity/sand inclusions, gating/risers |
| `forging` | Forging | **partial** | wall/feature/clearance + draft (best die direction) | min draft, parting plane | grain flow/flash/tool wear/cracks |
| `vacuum-forming` | Vacuum forming | **partial** | wall/feature/clearance + draft (best release direction) | sheet thickness, min draft | draw ratio, thickness distribution, webbing, cooling |
| `cnc-3axis` | CNC milling (incl. desktop) | **partial** | wall/feature/clearance + bore cutter radius + aspect ratio (`cad_check` (`action: "printability"`) + `cnc-3axis` profile); **six-direction access + minimum setups** (`cad_check` (`action: "cnc"`)) | cutter radius, aspect ratio, wall rules, `maxSetups`, `requireAllAccessible` | tilted setups/4th axis, tool length/diameter/collision, fixture rigidity, chatter/cost |
| `cnc-turning` | Turning | **partial** | bar diameter + L/D + rotational symmetry deviation (`cad_check` (`action: "turning"`), about spindle) | `barDiameterMm`, `maxLdRatio`, `symmetryToleranceMm`, `requireSymmetry` | undercut/profile tool access, chatter, surface, bar-feeder limits |
| `laser-cut-sheet` | Laser cutting | **partial** | 2D section: round-hole diameter/hole-to-outline/hole spacing, kerf deducted (`cad_check` (`action: "sheet2d"`)) | `kerfMm`, `minHoleMm`, `minFeatureMm`, `minSpacingMm` | non-circular hole width, narrow outer ribs, HAZ, taper, surface |
| `waterjet` | Waterjet | **partial** | 2D section: round-hole diameter/hole-to-outline/hole spacing, kerf deducted (`cad_check` (`action: "sheet2d"`)) | `kerfMm`, `minHoleMm`, `minFeatureMm`, `minSpacingMm` | non-circular hole width, narrow outer ribs, taper vs thickness, surface, abrasive cost |
| `sheet-metal-bend` | Sheet-metal bending | **partial** | cut features (round holes/walls/spacing, kerf deducted) + optional bend checks: **hole-to-bend, min flange, bend-relief heuristic** (`cad_check` (`action: "sheet2d"`) + `bendLines`) | `kerfMm`, min hole/wall/spacing, `bendLines` (u/v), `minHoleToBendMm`, `minFlangeMm`, `minBendReliefMm` | flat pattern/K-factor, relief geometry, springback, tooling limits |
| `edm` | EDM | **partial** | wall/feature/clearance + round-hole electrode/wire radius + aspect ratio (`cad_check` (`action: "printability"`) + `edm` profile); wire-cut 2D features (`cad_check` (`action: "sheet2d"`)); sinker **single-axis electrode reachability** (`cad_check` (`action: "edm"`)) | electrode/wire radius, aspect ratio, wire `kerf`/min hole/wall/spacing, `burnAxis`/`requireAllReachable` | electrode shape/side erosion/undercut, wear, min feature, surface, machining time |
| `extrusion` | Profile extrusion | **partial** | 2D section: wall/round holes/spacing, kerf deducted (`cad_check` (`action: "sheet2d"`)) | `kerfMm`, `minHoleMm`, `minFeatureMm`, `minSpacingMm` | constant-section validation, die swell, cooling/warp, pull speed, hollow-section rules |

## How `cad_deliver` action `plan` uses it

- `M:policy` labels every `allowed` process `[supported]` / `[partial]` / `[planned]`;
- a `planned` process in the allowed set → `process-planned`: “method defined, evaluator not implemented; do not read as pass”;
- a part assigned to a `planned` process → that row is `unobserved`; `why` states the method and inputs, `next` says “implement/connect an evaluator, or check manually”; it never substitutes a printability profile;
- unknown id → `process-unknown`.

## Implementation order (each independently acceptable)

1. **Process profiles (done, partial)** — CNC 3-axis, injection, die casting, vacuum, sand, forging, SLA, SLS share `cad_check` (`action: "printability"`): wall/feature/clearance + **draft solver** + **escape reachability**. No separate `check_moldability`; the draft solver covers the same geometric family.
2. **`cad_check` (`action: "sheet2d"`) (done, partial)** — 2D cut screening for flat plates: round-hole diameter, hole-to-outline, hole spacing, kerf deducted; covers laser, waterjet, sheet metal, extrusion. Sheet metal can pass `bendLines` (u/v) for hole-to-bend, min flange, bend relief (heuristic); flat pattern/K-factor and relief geometry remain handoff.
3. **EDM (done, partial)** — `schemas/examples/edm.json` covers **round-hole** electrode/wire radius with `toolRadiusMm`/`holeAspectMax`/wall rules; wire-cut 2D can use `cad_check` (`action: "sheet2d"`); sinker single-axis reachability uses `cad_check` (`action: "edm"`); electrode shape/side erosion/wear/surface/burn remain handoff.
4. **Turning (done, partial)** — `cad_check` (`action: "turning"`) checks bar diameter/L/D/rotational symmetry deviation; undercut/profile tool access/chatter/feed remain handoff.
5. **CNC six-direction access + setups (done, partial)** — `cad_check` (`action: "cnc"`) uses ±X/±Y/±Z visibility + greedy cover to report unreachable area and minimum principal-direction setups; tilted setups/tool length/fixture/chatter remain handoff; voxel/oblique reachability can later raise it to supported.
6. When an evaluator lands, change the catalogue `support` from `planned` to `partial/supported` and state the `handoff`.

## What geometry cannot verify

Fill/porosity/shrink/warp, chatter/tool deflection, springback, HAZ, time/cost — **not** answerable from a mesh. The catalogue lists them under `handoff`; CAE, suppliers or physical tests take over. The venue asks the question and states the boundary; it does not pretend a mesh check issues a certificate.
