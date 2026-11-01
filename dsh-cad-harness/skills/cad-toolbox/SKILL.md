---
name: cad-toolbox
description: "CAD router: the three job groups, the full 35-tool map, conventions, and the delivery discipline. Load first; depth lives in the four per-job skills and docs/llm/."
whenToUse: "Any CAD work, before choosing a tool. Start here even when you think you know which tool you need."
---

# CAD toolbox: which tool, when, and how not to waste a round

Thirty-five tools, but **three jobs first**. Pick the group, not the tool — the group tells you what the output is allowed to mean:

| 组 | 问的问题 | 代表工具 | 输出允许是什么 | 会导致什么 |
| --- | --- | --- | --- | --- |
| **交付** | 能不能交？ | **`preflight`** · `check_printability` · `check_assembly` · `check_parts` · `delivery_audit` | **否决 / 困难 / 不排除可行** + 见证 | 可以**阻止**交付 |
| **仿真** | 这种工况下会怎样？ | `simulate_stress` · `simulate_motion` · `simulate_physics` · `simulate_fluid` · `simulate_lbm` | **方向性**读数 + 可靠性 + 证据 | 产**证据**，不自己判交付 |

## Six rules

1. **先结账，再交付**：任何“可以交了”之前，`check_printability`（每个零件）与 `check_assembly`（每份契约）都要跑过；最后 `delivery_audit`，并把你要主张的东西写进 `claims`。缺证据会报 `claim-without-evidence`——门在工作。
2. **`not-excluded` 不是“ok”，更不是“安全”**：只表示“没找到反例”。`difficult` 表示余量落在仪器噪声内，**不许当过**。没有 “safe” 这个词可报。
3. **交付要主张，主张要证据**：`delivery_audit({claims})` 声明你要主张什么——`strength` / `motion` / `assembly` / `manufacturability` / `appearance` / `review`。不声明 claim 时它只审语料一致性（`no-claims-declared`）：绿色语料不等于已交付。**每个交付打印件的最新版本必须先过 `review_visual`（top+iso，带 note）；没有 fresh 记录，`delivery_audit` 直接 blocked。`generate_part({views:[]})` 会被强制改成 top+iso，不要再靠“只登记不看图”省图。****外购件/研究体用 `set_part_role` 声明** `stock` / `research`（`merge_parts` 输出自动标 research）：审计对它们豁免 printability 与 newest-validated 要求，但豁免会作为 info 可见（G4, 2026-10-29）。
4. **检测 ≠ 交付**：`attention` 里的位置是“去看这里”，不是判定证据；反过来，工具沉默是检测的失败，“检测到嫌疑”也不构成交付失败。
5. **仿真需要工况**：没有载荷/约束/材质（或驱动/倾角/流体）就没有应力、没有运动。读数一律是**方向性**的，不能当安全系数。
6. **交付几何默认登记**：要给人看、由人判或要交付的几何，走 `generate_part` / `import_part` 成为版本。面板只读 `versions/`、不扫磁盘；直接写 STL 既不进面板也不进任何工具（它们都要 `versionId`）。批量/实验产物可只落盘，但要在回复里声明路径与原因；`delivery_audit` 的 `unregistered-geometry` 会点名，豁免用 `exempt: [{path, reason}]`。登记不必附图：`import_part({render:false})` 或 `generate_part({views: []})`。

## Project boundary (C-lite, 2026-10-28)

The first CAD call binds the session to its nearest `cad-data/project.json`; `cd` does not switch. **A directory with no marker is NOT a new project when an ancestor has one** — it inherits the ancestor. To create a separate example/subproject:

1. `init_project` (with `{dir}`) writes ONLY `cad-data/project.json` (no versions, no rebind);
2. open a new session with `cwd = dir`; its first CAD call binds the new marker.

**The write target fails closed.** If an UNBOUND session's cwd is inside an ancestor project but is
not itself a project, the first CAD write is REFUSED — it does not silently bind the ancestor and it
never requires a later move. Choose explicitly: `init_project` (make this directory a project) or
`bind_project` (you really mean the ancestor), or `cd` to a project root.

`project_info` is read-only and says `boundRoot`, `liveCwd`, `mismatch`, `ambiguous`, and where a
first call would bind — call it before assuming a path is a project. If a task needs to switch projects in one session, move/rename a project, share it between people, or write to two projects, **stop and tell the user this is the C/D gap** — do not fork a corpus or add symlinks. A copied corpus is still a fork even if it has its own `project.json`.

## Reading errors

- `invalid arguments: ...` —— 入参形状错，消息里已点名（`"parts[0].position"`、`"versionId" must be a string`）；照路径改。
- `unknown version "v999"` —— 给的是**版本号** `vNNN`，不是零件 id（`p001`）或 run id（`r044`）。
- `tool "X" returned invalid output: ...` —— 工具的**返回**不合它自己的输出契约，不是入参错；重试不会变，换同组原子工具或记工具 bug。
- 装配清单被拒时，错误带 **path + expected + 最小清单**；按 path 改，不要换形状再猜。

## Default path

想知道**往哪看** → `analyze`（|u| 风险图 + 峰表；`attention.json` 的 `fused` 层就是面板画的那张图）。要**交付** → `preflight`（一次跑必跑序列，未编排的步骤带原因报出）→ 有强度/运动主张才 `simulate_*` → `delivery_audit({claims})`。任何一步报 `difficult` / `unevaluable`，回到本文件查该组的原子工具，或加载对应的深度 skill。

## Router

| The question sounds like | Reach for | Not |
|---|---|---|
| "make / change / reshape a part", "try another version" | `generate_part` | — |
| "use this STL/STEP someone sent me", "bring in a bought part" | `import_part` | `generate_part` |
| "treat the whole machine as one body", "does it topple", "whole-assembly mass/CoM" | `merge_parts` | hand-unioning STLs |
| "is it watertight", "do these two parts overlap", "what's the gap" | `validate_assembly` | `simulate_physics` |
| "will it topple", "does it rest stably", "does the hinge hold", "does it sink" | `simulate_physics` | `validate_assembly` |
| "does the mechanism move correctly", "what's the stroke", "does it jam mid-travel" | `simulate_motion` | `simulate_physics` |
| "how strong is it", "where does it break", "stress at this section" | `simulate_stress` | anything else — it is the only tool that reports a force |
| **"where should I even look", "any sharp internal corner", "is this mesh clean"** | **`scan_attention`** | waiting for a render to reveal it |
| "I need to deliver this printed part", "is the D hole really a D hole" | `review_visual` (top+iso, section when internal; writes the per-version record) | `generate_part({views:[]})`, or claiming "looks good" without an image |
| "does liquid fill it", "where are the dead zones", "does it drain" | `simulate_fluid` | anything rigid |
| "channel/duct flow numbers", "velocity profile vs Poiseuille at this Re" | `simulate_lbm` | embedded solids (box walls only) |
| "how big / how many holes / is it watertight", whole-part numbers | `measure_part` | renders |
| "how long along a diagonal", "which point is the top" | `measure_part` with `axis` / `axisVector` | bare `measure_part` (bbox only) |
| **"where are the holes", "what features", geometry you did not draw** | **`list_features`** | guessing coordinates from a render |
| "how thick is this wall", "what is behind this face", "gap along this line" | `measure_thickness` | aiming `measure_gap` at a point you cannot name |
| **"hole spacing in this plane", "wall thickness in a cut", "angle in a section"** | **`measure_section`** | picking 3D points off a render |
| "hole spacing", "wall thickness here", "gap at this spot" | `measure_gap` with point / datum endpoints | `measure_part` |
| "how close do these two get", "minimum gap", "nearest point to this sphere" | `measure_gap` with solid / sphere endpoints | `measure_gap` at a point you cannot name |
| **"what angle is this", "are these faces parallel", "how far off axis is this bore"** | **`measure_angle`** | eyeballing a render; guessing 30°/150° |
| "does the declared interface hold", "check the BOM's tolerances" | `check_assembly` | `validate_assembly` |
| "can this actually be printed", "is this wall too thin", "will it need supports" | `check_printability` | looking at renders |
| **"screen a family at once", "which of these parts is thin"** | **`check_parts`** | N single calls; it runs the same jobs and writes one run per part |
| "is this one part or floating fragments", "shells > 1 warning" | `measure_part` (`bodies` / `bodySizes` / `bodyVerdict`) | guessing from renders |
| "what anchors does this version have", "I forgot a datum", "rename/add an anchor" | `set_datums` | re-running `generate_part` |
| "look from another angle / cut it open" | `render_part` | re-running `generate_part` |
| "give this version a color/material design" | `attach_appearance` (GLB sidecar; no render path) | treating STL as a color carrier |
| "the reference image is gone from my context" | `recall_reference_image` | describing the image from memory |
| "the user is only *talking* about a part", no geometry yet | `create_part` | `generate_part` (it would invent a shape) |
| "before I claim this is delivered" | `delivery_audit` | re-reading your own notes |
| "the human should look at this", "ask them to review", "propose a rollback" | `request_review` | moving their viewport or opening a modal |
| "what did v030 look like", "how did this change" | the panel's version gate + compare (the human opens it); or `request_review({items:[{target:"v030"}]})` | re-running old tool calls to "show" it |
| "a check no CAD tool covers" (FEM, optimisation, a custom metric) | `run_python` | shelling out to the system python |
| "the runtime is missing / broken / I want it warm" | `python_runtime` | re-running a failing tool and hoping |

**`measure_part` vs `measure_gap`**: whole-part numbers → `measure_part` (add `axis`/`axisVector` for a projection). “How far apart are these two things” → `measure_gap`, where the only decision is how you NAME each endpoint, and both must be the same kind: solid (`aVersionId`/`bVersionId`) or sphere (`aSphere`/`bSphere`), or point (`aPoint`/`bPoint`) or datum (`aDatum`/`bDatum`). A solid cannot pair with a point in one call. Renders carry no coordinates: get them from `list_features` first; when you cannot name a point, `measure_thickness` takes a line instead.

**`validate_assembly` vs `check_assembly`**: the first is ad-hoc (parts + poses → interference/clearance); the second is contractual (manifest → declared interfaces + undeclared adjacency).

**An imported part is an ordinary version.** Every row above applies; the only thing it cannot do by itself is *be an interface endpoint* — that needs datums.

## Conventions

- **Millimetres, z-up.** No tool takes a unit argument.
- **Datums** are declared `datum("name",[x,y,z])` at top level in final world coordinates; they do not affect the mesh. `datum_axis` / `datum_plane` / `datum_cyl` exist for assemblies — signature is `(name, point, dir)`, POINT FIRST: a positional swap compiles silently and corrupts the contract (a zero dir is now a compile error; a dir that dwarfs its point warns as a swap). `set_datums` lists or records; recording creates a **new version** (mesh copied, no recompile) — point the manifest at the returned id. Do not spend a `generate_part` round on an anchor-only change.
- **The manifest** is an ordinary file, by default `<workspace>/assembly/assembly.json`; `check_assembly` resolves a relative `manifestPath` against the workspace first. Edit it with `write` / `edit`; do not patch JSON by shell.
- **BOSL2 is available** in `generate_part` (`std`, `screws`, `gears`, `walls`, `threading`, `sliders`, `ball_bearings`); use the library instead of hand-rolling a thread/gear/fillet.
- **`judge` / `scan` / `both`**: `judge` (default) returns the verdict and no field; `scan` returns the field and **no verdict**; `both` returns both. The **run report** always records both halves — the mode trims the reply, not the record. In `judge` the reply still carries `nextLook` (`{tool, args, why}`) because a verdict without a place is the failure HARNESS §11.14 exists to prevent.
- **Runtime**: measuring/checking/simulating need the pinned Python runtime (`python_runtime` provisions/repairs); `run_python` shares it. `delivery_audit`, `create_part`, `set_datums`, `render_part`, `recall_reference_image` do not need it. **`check_assembly` does.**
- **Images are the biggest context spend.** New/reshaped parts deserve all four views; a numeric iteration needs `views: ["iso"]`. The user's reference image is pruned first — recall it before claiming a match.

## Discipline

- **Watertight beats pretty.** Never assemble/measure/simulate a version flagged NOT WATERTIGHT; every number on an open mesh is a lie. Fix the mesh first.
- **A part is ONE connected solid.** Multi-body → union (genuinely touching) or separate parts; a multi-body “part” poisons assembly interference, mass and print layout.
- **Check the operator, not the interface count.** A joint interface whose `check` cannot consume a motion run cannot fail because the mechanism does not move.
- **Runs have a lifecycle.** A newer run about the same `subject` supersedes the older one (`supersededBy`); a superseded run is still readable. Runs with no subject are never auto-superseded.
- **Rigid simulation costs seconds, fluid minutes.** Ask for the cheap check first.
- **A single keyframe is not a mechanism.** The interference timeline and stroke number are the outputs.
- **A gap between skew surfaces is point-to-point, not clearance.** Make the probes roughly face each other.

## Delivery

1. **Never deliver on green numbers alone.** Look at the final state (assembly renders, panel screenshots, or a fresh `render_part`).
2. **`check_printability` on every part before “done”**, and after any wall/boss/angle change. `difficult` findings get answered, not ignored.
3. “Compiles / assembles / report passes” are three claims; delivery needs all three + eyes + a printability pass.
4. **A version update invalidates every whole-machine result that names the old version.** Re-run merged body, physics/motion, `validate_assembly`, and `check_assembly`; update manifest nodes; a superseded run is not current evidence.
5. **A whole-machine claim needs a whole-machine run.** Check the run's part list; a fragment is not “the machine”.
6. **A mechanism must be able to fail the contract.** Joint interfaces need `check: "motion-clearance"` citing a run that covers the delivered versions.
7. **Run `delivery_audit` before any delivery claim and answer its findings** (`stale-evidence`, `versions-never-cited`, `contract-without-motion`, `merged-stale`, `duplicate-runs`, `unregistered-geometry`). A `blocked` finding means the corpus contradicts the claim.

## Depth

| the job | the skill | long-form |
|---|---|---|
| mechanism / rigid bodies / flow | `cad-simulation` | `docs/llm/engines.md` |
| assembly contracts, datums, fit | `cad-assembly` | `docs/llm/assembly.md` |
| authoring, importing, measuring | `cad-modeling-measure` | `docs/llm/modeling.md` |
| can it be made / process profiles | `cad-manufacturing` | `docs/llm/manufacturing.md` |
| conventions / delivery / traps | this file | `docs/llm/conventions.md` · `delivery.md` · `traps.md` |

Parameters and minimal calls: `docs/TOOL-CONTRACTS.md` (generated; do not hand-edit). If a field is not there, it does not exist.
