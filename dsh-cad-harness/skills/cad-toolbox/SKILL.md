---
name: cad-toolbox
description: "Use when a task involves 3D geometry at all — designing or changing a part, importing an STL, checking whether parts fit together, verifying a mechanism moves, testing fluid flow, or measuring a model. This is the ROUTER: the full tool map (which tool answers which question and what each one cannot answer), the conventions every CAD tool assumes, and the delivery discipline. Load it first; it points at five per-job skills for depth."
whenToUse: "Any CAD work, before choosing a tool. Start here even when you think you know which tool you need."
---

# CAD toolbox: which tool, when, and how not to waste a round

Twenty-nine tools, but **three jobs first**. Almost every task starts by picking the
group, not the tool — and the group tells you what the output is allowed to mean:

| 组 | 问的问题 | 代表工具 | 输出允许是什么 | 会导致什么 |
| --- | --- | --- | --- | --- |
| **交付** | 能不能交？ | **`preflight`（入口，一次调用）** · `check_printability` · `check_assembly` · `delivery_audit` | **否决 / 困难 / 不排除可行** + 见证 | 可以**阻止**交付 |
| **检测** | 该往哪看？ | `analyze`（**实验性，不可作交付依据**） · `scan_attention` · 各工具的 `attention` 场 | 坐标 + \|u\| + 几路一致 + 可执行观测 | **永不阻止**，永不沉默 |
| **仿真** | 这种工况下会怎样？ | `simulate_stress` · `simulate_motion` · `simulate_physics` · `simulate_fluid` · `simulate_lbm` | **方向性**读数 + 可靠性 + 证据槽 | 产**证据**，不自己判交付 |

**Markdown 纪律（这是本文件最重要的六条）：**

1. **先结账，再交付**：任何"可以交了"之前，`check_printability`（每个零件）与
   `check_assembly`（每份契约）都要跑过；最后跑 `delivery_audit`，**并把你要主张的
   东西写进 `claims`**。证据缺了它会报 `claim-without-evidence`——那是门在工作，不是你出错。
2. **`not-excluded` 不是"ok"，更不是"安全"**：它只表示"没有找到反例"。`difficult` 表示
   余量落在仪器噪声内，**不许当过**。全库没有 "safe" 这个词可报。
3. **交付要主张，主张要证据**：`delivery_audit({claims})` 里声明你要主张什么——
   `strength` / `motion` / `assembly` / `manufacturability` / `appearance` / `review`。
   缺对应新鲜证据就报 `claim-without-evidence`（直接 blocked）。**不声明 claim 时它只审语料
   一致性**（并显式报 `no-claims-declared`）：绿色语料不等于已交付。
4. **检测 ≠ 交付**：`attention` 里的可疑位置是"去看这里"，**不是**判定证据；
   反过来，工具沉默是检测的失败，但"检测到嫌疑"也不构成交付失败。
5. **仿真需要工况**：没有声明载荷/约束/材质（或驱动/倾角/流体）就没有应力、没有运动。
   仿真的读数一律是**方向性**的——可做相对比较，不能当安全系数。
6. **交付几何默认登记**：要给人看、由人判或要交付的几何，一律走 `generate_part` / `import_part`
   成为版本。面板只读 `versions/`、不扫磁盘；直接写个 STL 既不进面板，也不进任何工具（它们全
   要 `versionId`）——人就没法看见你产出了什么。批量/实验产物可以只落盘，但必须在回复里**声明
   路径与原因**；`delivery_audit` 的 `unregistered-geometry` 会点名未登记的网格，豁免用
   `exempt: [{path, reason}]`。登记不必附图：`import_part({render:false})` 或
   `generate_part({views: []})`，面板照样加载几何，人照样看得见。

**报错怎么读（别把工具 bug 当自己的输入错）：**

- `invalid arguments: ...` —— 入参形状错，消息里已经点名（`"parts[0].position"` 缺失 / `"versionId" must be a string`）。照路径改。
- `unknown version "v999"` —— 给的是**版本号** `vNNN`，不是零件 id（`p001`）或 run id（`r044`）。
- `tool "X" returned invalid output: ...` —— 工具的**返回**不合它自己的输出契约，不是你的入参错。**重试同一个调用不会变**：换同组的原子工具，或把这条记为工具 bug（带上报错原文）。
- 结构文件（装配清单）被拒时，错误里带 **path + expected + 最小清单**；按 path 改，不要换一种形状再猜。

**默认路径**：想知道**往哪看** → `analyze`（一次调用给出 |u| 风险图 + 峰表；`attention.json`
的 `fused` 层就是面板画的那张图）；要**交付** → `preflight`（一次调用跑必跑序列，未编排的步骤
会带原因报出来）→ 有强度/运动主张才 `simulate_*` → `delivery_audit({claims})`。任何一步报
`difficult` / `unevaluable` 时，**回到本文件查该组的原子工具**，或加载对应的深度 skill。

Seven jobs follow; the tool map below is the authority on which tool answers which. The tool descriptions say what each one *is*; this file
says **which one the question belongs to**, what its boundary is, and the discipline
that keeps a green number from being read as a finished design.

**This is the router, and it is the only file that names every tool.** Depth lives in
four per-job skills — load one when the work turns to that job:

| the job | the skill | load it |
| --- | --- | --- |
| a mechanism moves / rigid bodies / flow | `cad-simulation` | before any `simulate_*` |
| assembly contracts, datums, fit, interference | `cad-assembly` | writing a manifest or checking fit |
| authoring, importing, measuring geometry | `cad-modeling-measure` | drawing or measuring a part |
| can it be made, and by which processes | `cad-manufacturing` | before delivering, or any wall/threshold question |

**Appearance data is not geometry truth.** `attach_appearance` stores a
self-contained GLB as `appearance.glb` + `appearance.json` next to the version; the
panel still previews STL and there is no Blender/bpy render lane
(DECISION-LOG 2026-10-25). Do not use a GLB as a color carrier for printability or
as a second geometry source.

**参数与最小调用**：`docs/TOOL-CONTRACTS.md` 由 `scripts/audit-tool-contracts.mjs --write` 生成，
列出每个工具的参数（类型 / 枚举 / 默认 / 含义）与一行可跑的调用示例——**别手改**，它与代码同源，
`--check` 会在漏掉工具时红。

Reference material and long case histories live in each skill's `references/` directory.
The loader prints that directory when the skill is loaded; resolve relative paths
against it, and read a reference only when the skill tells you to.

## The router (this table is the whole point)

| The question sounds like | Reach for | Not |
|---|---|---|
| "make / change / reshape a part", "try another version" | `generate_part` | — |
| "use this STL/STEP someone sent me", "bring in a bought part" | `import_part` | `generate_part` |
| "treat the whole machine as one body", "does it topple", "whole-assembly mass/CoM" | `merge_parts` | hand-unioning STLs in OpenSCAD |
| "is it watertight", "do these two parts overlap", "what's the gap" | `validate_assembly` | `simulate_physics` |
| "will it topple", "does it rest stably", "does the hinge hold", "does it sink" | `simulate_physics` | `validate_assembly` |
| "does the mechanism move correctly", "what's the stroke", "does it jam mid-travel" | `simulate_motion` | `simulate_physics` |
| "how strong is it", "where does it break", "what is the stress at this section" | `simulate_stress` | anything else — it is the only tool that reports a force |
| **"where should I even look", "any sharp internal corner", "is this mesh clean"** | **`scan_attention`** | waiting for a render to reveal it |
| "does liquid fill it", "where are the dead zones", "does it drain" | `simulate_fluid` | anything rigid |
| "channel/duct flow numbers", "velocity profile vs Poiseuille at this Re" | `simulate_lbm` | embedded solids (box walls only for now) |
| "how big / how many holes / is it watertight", whole-part numbers | `measure_part` | renders |
| "how long is this along a diagonal", "which point is the top of this" | `measure_part` with `axis` / `axisVector` | a bare `measure_part` (bbox only, no coordinates) |
| **"where are the holes", "what features does this part have", any geometry you did not draw** | **`list_features`** | guessing coordinates from a render |
| "how thick is this wall", "what is behind this face", "the gap along this line" | `measure_thickness` | aiming `measure_gap` at a point you cannot name |
| **"hole spacing in this plane", "the wall thickness in a cut", "the angle in a section"** | **`measure_section`** | picking 3D points off a render |
| "hole spacing", "wall thickness here", "gap at this spot" | `measure_gap` with point / datum endpoints | `measure_part` |
| "how close do these two get", "minimum gap", "nearest point to this sphere" | `measure_gap` with solid / sphere endpoints | `measure_gap` aimed at a point you cannot name |
| **"what angle is this", "are these two faces parallel / square to each other", "how far off axis is this bore"** | `measure_angle` | eyeballing it off a render; guessing which of 30°/150° the reply meant |
| "does the declared interface hold", "check the BOM's tolerances" | `check_assembly` | `validate_assembly` |
| "can this actually be printed", "is this wall too thin", "will this need supports" | `check_printability` | looking at renders |
| "is this one part or floating fragments", "shells > 1 warning" | `measure_part` (`bodies` / `bodySizes` / `bodyVerdict`) | guessing from renders |
| "what anchors does this version have", "I forgot a datum", "rename/add an anchor" | `set_datums` | re-running `generate_part` |
| "I just want to look at it from another angle / cut it open" | `render_part` | re-running `generate_part` |
| "give this version a color/material design" | `attach_appearance` (stores a GLB sidecar; no render path yet) | treating STL as a color carrier; the panel still previews STL |
| "the reference image is gone from my context", "compare the build with the user's picture" | `recall_reference_image` | describing the image from memory |
| "the user is only *talking* about a part", no geometry yet | `create_part` | `generate_part` (it would invent a shape) |
| "before I claim this is delivered" | `delivery_audit` | re-reading your own notes |
| "there is something the human should look at", "ask them to review", "propose a rollback" | `request_review` | moving their viewport, opening a modal, or writing a report they never open |
| "what did v030 look like", "how did this change between revisions" | the panel's version gate + 对比副视口 (the human opens it); or `request_review({items:[{target:"v030"}]})` | re-running an old version's tool calls to "show" it |
| "a check no CAD tool covers" (FEM, optimisation, a custom metric) | `run_python` | shelling out to the system python |
| "the runtime is missing / broken / I want it warm" | `python_runtime` | re-running a failing tool and hoping |

**An imported part is not a special kind of part.** `import_part` lands the file
as an ordinary version, so every other row of this table applies to it unchanged
(STEP/3MF tessellation is yours to choose: `tolLinear` mm / `tolAngular` rad —
0.01 mm vs 0.002 mm was 3074 vs 12254 triangles with <0.3% volume change):
measure it, render it, put it in `validate_assembly` next to a part you generated,
run a mechanism through it. The only thing it cannot do by itself is *be an
interface endpoint* — that needs datums, which an STL does not carry (see below).

**`measure_part` vs `measure_gap`** is the pairing that gets confused most.
Whole-part numbers → `measure_part` (add `axis`/`axisVector` for a projection).
"How far apart are these two things" → `measure_gap`, where the ONLY decision left
to you is how you NAME each endpoint, and both endpoints must be the same kind:
a saved solid (`aVersionId`/`bVersionId`) or an analytic sphere (`aSphere`/`bSphere`)
— solved as a closest-point pair, no coordinates needed; or a coordinate
(`aPoint`/`bPoint`, snapped) or a datum (`aDatum`/`bDatum`, exact) — your inputs,
with snap and inside/outside diagnostics. A solid cannot be paired with a point in
one call.

**You cannot name a point on geometry you did not draw, and renders carry no
coordinates.** So before measuring an imported STL or an existing corpus part,
get the coordinates from `list_features` (face normals, hole centres and
diameters, cylinder axes) and then measure against those. When you cannot name a
point even then, `measure_thickness` takes a LINE instead of a point: the ray only
has to cross the wall, and every crossing comes back, so a rough guess is enough.
`measure_gap` remains the tool for a point you can write down exactly — a
datum, or a coordinate you read out of `list_features`.

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
- **Anchors are declarations, not metadata.** If you forgot one, or need the exact
  names and coordinates to write an interface against, use `set_datums` on the
  version you already have — `set_datums(versionId)` lists, `set_datums(versionId,
  datums)` records. Recording creates a **new version** (parent = the one you gave;
  the mesh is copied byte-for-byte, so no renders and no recompile): an interface
  RESOLVES against an anchor, so moving it in place would change what old runs meant.
  Point your manifest at the returned version id. Do **not** spend a `generate_part`
  round on a version whose only change is an anchor — that costs four renders and
  rewrites the geometry for nothing.
- **The assembly manifest is an ordinary file in your workspace**, by default
  `<workspace>/assembly/assembly.json`, and `check_assembly` resolves a relative
  `manifestPath` against the workspace first (the plugin data root is only a
  fallback for old corpora). Author and edit it with `write` / `edit` like any
  other source file — do not shell out to patch JSON, and never copy it anywhere.
- **BOSL2 is available** in `generate_part` (`std.scad`, plus `screws.scad`,
  `gears.scad`, `walls.scad`, `threading.scad`, `sliders.scad`,
  `ball_bearings.scad`). Use the library module instead of hand-rolling a thread,
  a gear or a fillet.
- **`judge` / `scan` / `both`.** The judgement tools (`check_printability`,
  `simulate_stress`) take `mode`: `judge` (default) returns the verdict and NO
  field, `scan` returns the field and NO verdict, `both` returns both as separate
  keys. The RUN always records both halves — the mode trims the reply, not the
  record. In `judge` mode the reply still carries `nextLook`: runnable observations
  (`{tool, args, why}`) for this same version, because a verdict without a place is
  the failure HARNESS §11.14 exists to prevent.
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
  solver (distance / diameter-match / coaxial / motion-clearance / spring-preload)
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
  collides).
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
4. **A part version update invalidates every whole-machine result that names the
   old version.** 整机刚体（`merge_parts`）、`simulate_physics` / `simulate_motion`
   / `validate_assembly` 的运行、以及 `check_assembly` 的报告，全部**钉在具体
   版本号上**（run 的 `sourceVersionIds`、manifest 节点里的 `version`、接口引用的
   `params.runId`）。零件更新出 `vNNN+1` 之后，旧结果不会自动跟着变——它们仍
   显示"存在、绿色、通过"，但描述的是**已经不存在的几何**。交付前必须：
   - 重跑所有整机级产物（合并刚体、物理/运动仿真、装配验证），或在结果里
     显式声明它基于哪个版本、并说明为什么仍然有效；
   - 把 manifest 里指向旧版本的节点/接口更新到新版本，再重跑 `check_assembly`
     （引用已被取代的运行，检查会报 `SUPERSEDED`）；
   - 绝不把"某次旧的绿色运行"当作当前版本的证据——**证据的有效期等于它引用的
     那个版本的有效期**。判据：说"已通过"之前，先问一句"它验证的是哪个版本？"

5. **A whole-machine claim must be backed by a whole-machine run.** A physics or
   assembly conclusion covers the parts that were IN that run and no more:
   microscope5's delivered "整体" evidence included seven single-part physics
   runs, while the 16-part assembly never once passed. Before saying "整机 /
   the machine", check the run's part list — if it is not the full delivered
   set, the claim is about a fragment, and you say so or you re-run it over
   everything.
6. **A mechanism must be able to fail the contract.** If parts move relative to
   each other (gear/rack, slide, hinge, cam), the manifest declares `转动副` /
   `滑动副` interfaces with `check: "motion-clearance"` citing a motion run.
   **Procedure before you call a contract green:** list every interface, take the
   ones whose `type` is a joint, and for each ask (a) which operator its `check`
   uses, (b) whether that operator consumes a run, and (c) whether the run it
   cites covers the versions you are delivering. Any joint whose answers are not
   (motion-clearance, yes, yes) is unverified no matter what the report says —
   "N interfaces, 0 hard violations" cannot speak about a mechanism the contract
   cannot fail on.
7. **Run `delivery_audit` before any delivery claim, and answer its findings.**
   It reads the corpus (not your memory) and returns: failing runs that are
   still newest of their kind, stale evidence (`stale-evidence`), versions nobody
   checked (`versions-never-cited`, `newest-version-unvalidated`), contract gaps
   (`contract-without-motion`, `contract-stale-nodes`), **merged bodies built from
   versions a part has since replaced** (`merged-stale`), repeated runs
   (`duplicate-runs`), and mesh files no version accounts for
   (`unregistered-geometry`). A
   verdict of `excluded` (or any `blocked`-severity finding) means the corpus
   contradicts the claim — fix it, or state the exception explicitly to the user. Citing a green number that the audit
   flags as stale is exactly the failure this step exists to prevent.


## Still to add (deliberately open)

- Parameter sweet spots per tool: what actually changes the answer vs what only
  changes the runtime. Partly answered above (`check_printability`'s `samples`,
  `simulate_fluid`'s `particlesPerCell`/`stacksPerSeed`), still open for
  `simulate_motion`'s cycles/samplePerCycle and for bounding a fluid run before
  launching it.
- Assembly-specific guidance (when a flat root is enough and when to nest).
