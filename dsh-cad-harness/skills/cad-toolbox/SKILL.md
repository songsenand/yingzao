---
name: cad-toolbox
description: "CAD router: the three job groups, the 9-surface map (45 ops), conventions, and the delivery discipline. Load first; depth lives in the four per-job skills and docs/llm/."
whenToUse: "Any CAD work, before choosing a tool. Start here even when you think you know which tool you need."
---

# CAD toolbox: which tool, when, and how not to waste a round

> **生产工具面（2026-11-16）**：模型只看到 9 个 surface。旧工具名（如 `project_info`、`render_part`）只是内部实现名，直接调用会报 `unknown tool`。
> 调用格式：`cad_session` / `cad_part` / `cad_assembly` / `cad_check` / `cad_simulate` / `cad_inspect` / `cad_see` / `cad_python` / `cad_deliver` + `action` + `args`。

Nine job surfaces (45 ops), but **three jobs first**. Pick the group, not the tool — the group tells you what the output is allowed to mean. (`instrument` is the fourth *tool class*, not a fourth job: it is where numbers/coordinates live, and a session may declare it separately in `groups`.)

| 组 | 问的问题 | 代表工具 | 输出允许是什么 | 会导致什么 |
| --- | --- | --- | --- | --- |
| **交付** | 能不能交？ | **`cad_deliver` (`action: "plan"`)**（只读计划） · **`cad_deliver` (`action: "preflight"`)** · `cad_check` (`action: "printability"`) · `cad_check` (`action: "sheet2d"`) · `cad_check` (`action: "turning"`) · `cad_check` (`action: "cnc"`) · `cad_check` (`action: "edm"`) · `cad_assembly` (`action: "check"`) · `cad_check` (`action: "parts"`) · `cad_deliver` (`action: "audit"`) | **否决 / 困难 / 不排除可行** + 见证 | 可以**阻止**交付 |
| **检测** | 该往哪看？ | `cad_check` (`action: "sweep"`) · `cad_inspect` (`action: "analyze"`)（实验性，不可作交付依据） · `cad_inspect` (`action: "attention"`) · `cad_check` (`action: "appearance"`)（成套外观：锐边/收口/对称/近共面/包络预算，只读） · 各工具的 `attention` 场 | 坐标 + \|u\| + 可执行观测 | **永不阻止**，永不沉默 |
| **仿真** | 这种工况下会怎样？ | `cad_simulate` (`action: "stress"`) · `cad_simulate` (`action: "motion"`) · `cad_simulate` (`action: "physics"`) · `cad_simulate` (`action: "fluid"`) · `cad_simulate` (`action: "lbm"`) | **方向性**读数 + 可靠性 + 证据 | 产**证据**，不自己判交付 |

`instrument` 组只装“读数/坐标/写契约”类工具（`cad_inspect` (`action: "measure"`)、`cad_inspect` (`action: "features"`)、`cad_part` (`action: "generate"`)、`cad_see` (`action: "render"`)、`cad_assembly` (`action: "write"`) 等）；它不是交付判据。声明 `groups` 时不要把 `instrument` 和三个 job 组混为一谈。

> **不要用通用 `edit`/`write` 改 `assembly/assembly.json`**：通用编辑不会跑契约校验，而且会被“未读先写”策略挡住。用 `cad_assembly` (`action: "write"`)。同理，`cad_assembly` (`action: "datums"`) 生成的新版本是元数据版本；它的渲染由工具从父版本复制，不要假设 `versions/<new>/render_*.png` 一定存在，视觉复核图在 `cad-data/render/<v>-review-*.png`。

## Six rules

1. **先结账，再交付**：任何“可以交了”之前，先 `cad_deliver` (`action: "plan"`) 看只读计划（它从 BOM/ICD/claims/run 图派生每行，并给出该跑的原子工具；**它不跑 CAD，也不是闸门**）；按 `next` 跑完缺失项，再 `cad_check` (`action: "printability"`)（每个打印件）与 `cad_assembly` (`action: "check"`)（每份契约），最后 `cad_deliver` (`action: "audit"`) 并把主张写进 `claims`。缺证据会报 `claim-without-evidence`——门在工作。**`cad_deliver` (`action: "plan"`) 的 plan pass 不是 claim。** BOM 顶层的 `manufacturing` 策略是**一次用户决定**（`allowed` + `approvedBy`；用户可以说“我只有 FDM”），agent 在允许集合内给每个零件分配 `source:"policy"`；**不要逐件问用户**。`M:mix` 让用户确认一次配比（例如 10×injection-pp）；只有集合外的零件才问一次例外。总计 0–3 次关键选择，不是 N 次零件确认。未批准的策略/推荐一律 `unobserved`。工艺 id 的能力分级（`supported` / `partial` / `planned`；车削、EDM、激光/水刀/钣金切割/挤出、CNC/压铸/砂铸/真空/模锻/SLA/SLS 都已 **partial**；CNC 用 `cad_check` (`action: "printability"`)（圆孔/壁）+ `cad_check` (`action: "cnc"`)（六方向可达 + 装夹数）；剩下的是斜装夹/刀具长度/夹具、钣金展开图/K 因子/让位槽几何、EDM 电极形状/侧蚀的 handoff）见 `docs/llm/processes.md`；不要拿打印性 profile 冒充新工艺的检查。
2. **`not-excluded` 不是“ok”，更不是“安全”**：只表示“没找到反例”。`difficult` 表示余量落在仪器噪声内，**不许当过**，而且必须用一句话解释你看到了什么、为什么接受/不接受。没有 “safe” 这个词可报。
3. **交付要主张，主张要证据**：`cad_deliver` (`action: "audit"`) with `{claims}` 声明你要主张什么——`strength` / `motion` / `assembly` / `manufacturability` / `appearance` / `review`。不声明 claim 时它只审语料一致性（`no-claims-declared`）：绿色语料不等于已交付。**每个交付打印件的最新版本必须先过 `cad_see` (`action: "review"`)（top+iso，带 note）；没有 fresh 记录，`cad_deliver` (`action: "audit"`) 直接 blocked。`cad_part` (`action: "generate"`) with `{views:[]}` 会被强制改成 top+iso，不要再靠“只登记不看图”省图。****外购件/研究体用 `cad_part` (`action: "role"`) 声明** `stock` / `research`（`cad_part` (`action: "merge"`) 输出自动标 research）：审计对它们豁免 printability 与 newest-validated 要求，但豁免会作为 info 可见（G4, 2026-10-29）。
4. **检测 ≠ 交付**：`attention` 里的位置是“去看这里”，不是判定证据；反过来，工具沉默是检测的失败，“检测到嫌疑”也不构成交付失败。
5. **仿真需要工况**：没有载荷/约束/材质（或驱动/倾角/流体）就没有应力、没有运动。读数一律是**方向性**的，不能当安全系数。
6. **交付几何默认登记**：要给人看、由人判或要交付的几何，走 `cad_part` (`action: "generate"`) / `cad_part` (`action: "import"`) 成为版本。面板只读 `versions/`、不扫磁盘；直接写 STL 既不进面板也不进任何工具（它们都要 `versionId`）。批量/实验产物可只落盘，但要在回复里声明路径与原因；`cad_deliver` (`action: "audit"`) 的 `unregistered-geometry` 会点名，豁免用 `exempt: [{path, reason}]`。登记不必附图：`cad_part` (`action: "import"`) with `{render:false}` 或 `cad_part({ action: "generate", args: { views: [] } })`。

## 交付前必须（2026-11-28：skill 标注，工具执行）

这是**流程标注**：真正的拒绝在工具里（brief gate、导出闸门），不是靠这里的一句话。

1. **brief 先于几何**：`brief.processes` / `verify` / `buyVsMake` 不完整时，`cad_part`/`cad_check`/`cad_simulate` 会被 `[brief-gate]` 拒绝。
2. **每个制造件声明 process**：BOM 的 `manufacturing.allowed` + 零件 `process`；没声明，导出闸门会 block。
3. **按 process 跑 evaluator**：FDM/增材 → printability；CNC → printability + cnc；车削 → turning；钣金/线切割 → sheet2d；EDM → edm。**不要拿 printability 冒充所有工艺。**
4. **每个交付打印件最新版本做 top+iso 视觉复核**（`cad_see review` 带 note）；没有 fresh 记录 audit 直接 blocked。
5. **声明 claims**（`strength`/`motion`/`assembly`/`manufacturability`/`appearance`/`review`），否则 `no-claims-declared`。
6. **`cad_deliver plan` 逐行 `next` → `cad_deliver audit`**；最后从**交付按钮/导出**走同一个 HTTP 闸门。文件名带 `_UNVERIFIED` 就是还没过。
7. **改过任何版本后重跑对应检查**；旧证据不是当前证据。

### 承重薄壁 ≠ 打印薄壁（两个检查，两个阈值）

| 检查 | 阈值/规则 | 谁用 | 能否用 `designException` |
|---|---|---|---|
| **打印薄壁** | 1.2mm / 工艺 profile（FDM/增材）；报 overhang | `cad_check` (`action: "printability"`) | **不能** |
| **承重薄壁** | 结构政策 1.6mm；应力支撑环 | `cad_simulate` (`action: "stress"`) | 能；`designException` 记录设计决定，**不豁免打印性** |

不要把 `designException` 当成打印薄壁的豁免；也不要把 1.2mm 的 printability 通过当成"承重够"。

## Evidence verification (V1; 2026-11-06)

The pearl execution layer is **demoted**; `cad_deliver` (`action: "pearl"`) is deprecated/experimental and is no
longer the default path. Decision: `docs/PEARL-TO-VERIFY-DECISION-2026-11-06.md`.

Use `verify <project-dir>` (CLI, read-only) and read its six coverage rows
(requirements/model/fit/make/review/delivery) with `pass|warn|fail|blocked|unobserved`,
stale/missing evidence and claim witnesses. It does not run CAD, write runs, or judge design.
Depth: `docs/llm/verify.md`.

- `cad_deliver` (`action: "pearl"`) (deprecated): read-only six-pearl gate, kept only for the historical
  implementation; do not start new work on it.
- `cad_deliver` (`action: "pearl"`) with `{execute:true, inputs}` (deprecated): template executor; removed after V1.
- No profile → the gate is blocked; `cad_deliver` (`action: "preflight"`) lists the pearl step as `notCovered`.
- A tool returning successfully is not a geometric pass: `judgement=excluded` /
  `overallStatus=fail` is a step failure.
- A project-specific target can be a claim + `checks/<id>/`; `verify --checks` mounts it
  only after its negative sample rejects. Default `warn`; `--mount-checks` validates before
  drawing. It is evidence, not a workflow step.
- A check must account for every declared criterion, may not write the project, and runs
  from a temp copy; `check-mutated` discards its evidence. Entry is `node <file>.mjs` only.
- Register a check before drawing: `node scripts/check-register.mjs <project> --id <id>`.
  Unregistered/modified checks are not executed; a late registration is advisory only and
  cannot witness a claim. To fix a check after drawing, unregister, register, then make a
  new version (the fix must be registered before the version it witnesses).
- Full depth: `docs/llm/verify.md`.

## Project selection (explicit; 2026-11-02)

**There is NO default project.** Every CAD tool that needs a corpus — everything except
`cad_session` (`action: "info"`), `cad_session` (`action: "init"`), `cad_session` (`action: "bind"`) — refuses until this session has selected one:

```text
No CAD project is selected. There is no default cwd/root:
pass cad_session({action:"bind", args:{dir:"..."}}) or cad_session({action:"init", args:{dir:"..."}}), then retry.
```

- `cad_session` (`action: "bind"`) with `{dir}` selects an EXISTING project marker. `dir` is required; there is no
  live-cwd default, and it does not copy or move anything.
- `cad_session` (`action: "init"`) with `{dir}` creates ONLY `cad-data/project.json`; if the session is unbound it also
  selects the new project. If already selected, it does not rebind (create for a new session).
- `cd` never switches; a selected project is fixed for the session. `cad_session` (`action: "info"`) reports
  `selected`, `boundRoot`, `mismatch`, `ambiguous`, `workspace`.
- A workspace root (`cad-workspace.json`) is a container, never a write target.
- The panel has no "follow session" mode and no default root: the project path must be chosen
  explicitly; an empty path shows "未选择项目" and reads nothing.

If a task needs to switch projects in one session, move/rename a project, share it between people,
or write to two projects, **stop and tell the user this is the C/D gap** — do not fork a corpus or
add symlinks. A copied corpus is still a fork even if it has its own `project.json`.

## Reading errors

- `invalid arguments: ...` —— 入参形状错，消息里已点名（`"parts[0].position"`、`"versionId" must be a string`）；照路径改。
- `unknown version "v999"` —— 给的是**版本号** `vNNN`，不是零件 id（`p001`）或 run id（`r044`）。
- `tool "X" returned invalid output: ...` —— 工具的**返回**不合它自己的输出契约，不是入参错；重试不会变，换同组原子工具或记工具 bug。
- 装配清单被拒时，错误带 **path + expected + 最小清单**；按 path 改，不要换形状再猜。

## Default path

想知道**往哪看** → `cad_inspect` (`action: "analyze"`)（|u| 风险图 + 峰表；`attention.json` 的 `fused` 层就是面板画的那张图；每个峰带 `probe` 和 `look`（Z 截面；分别按 `cad_inspect({ action: "measure" })` / `cad_see({ action: "render" })` 调用））。要**交付** → `cad_deliver` (`action: "preflight"`)（一次跑必跑序列，未编排的步骤带原因报出）→ 有强度/运动主张才跑 `cad_simulate` → `cad_deliver` (`action: "audit"`) with `{claims}`。任何一步报 `difficult` / `unevaluable`，回到本文件查该组的原子工具，或加载对应的深度 skill。

## Router

| The question sounds like | Reach for | Not |
|---|---|---|
| "make / change / reshape a part", "try another version" | `cad_part` (`action: "generate"`) | — |
| "use this STL/STEP someone sent me", "bring in a bought part" | `cad_part` (`action: "import"`) | `cad_part` (`action: "generate"`) |
| "treat the whole machine as one body", "does it topple", "whole-assembly mass/CoM" | `cad_part` (`action: "merge"`) | hand-unioning STLs |
| "is it watertight", "do these two parts overlap", "what's the gap" | `cad_assembly` (`action: "validate"`) | `cad_simulate` (`action: "physics"`) |
| "will it topple", "does it rest stably", "does the hinge hold", "does it sink" | `cad_simulate` (`action: "physics"`) | `cad_assembly` (`action: "validate"`) |
| "does the mechanism move correctly", "what's the stroke", "does it jam mid-travel" | `cad_simulate` (`action: "motion"`) | `cad_simulate` (`action: "physics"`) |
| "how strong is it", "where does it break", "stress at this section" | `cad_simulate` (`action: "stress"`) | anything else — it is the only tool that reports a force |
| **"where should I even look", "any sharp internal corner", "is this mesh clean"** | **`cad_inspect` (`action: "attention"`)** | waiting for a render to reveal it |
| "the whole set looks crude", "where are the razor edges / blunt ends", "is it the right proportion", "do the parts match / line up" | `cad_check` (`action: "appearance"`) (assembly manifest; add `budgetPath` for the declared envelope, symmetry and near-plane checks) | per-part renders, or calling a part "ugly" with no location |
| "I need to deliver this printed part", "is the D hole really a D hole" | `cad_see` (`action: "review"`) (top+iso, section when internal — `{ axis: "y", atMm: 18 }` or `{ axis: "y", fraction: 0.68 }`; writes the per-version record) | `cad_part` (`action: "generate"`) with `{views:[]}`, or claiming "looks good" without an image |
| "does liquid fill it", "where are the dead zones", "does it drain" | `cad_simulate` (`action: "fluid"`) | anything rigid |
| "channel/duct flow numbers", "velocity profile vs Poiseuille at this Re" | `cad_simulate` (`action: "lbm"`) | embedded solids (box walls only) |
| "how big / how many holes / is it watertight", whole-part numbers | `cad_inspect` (`action: "measure"`) `kind="part"` | renders |
| "how long along a diagonal", "which point is the top" | `cad_inspect` (`action: "measure"`) `kind="part"` + `axis` / `axisVector` | bare kind="part" (bbox only) |
| **"where are the holes", "what features", geometry you did not draw** | **`cad_inspect` (`action: "features"`)** | guessing coordinates from a render |
| "how thick is this wall", "what is behind this face", "gap along this line" | `cad_inspect` (`action: "measure"`) `kind="thickness"` | aiming a gap at a point you cannot name |
| **"hole spacing in this plane", "wall thickness in a cut", "angle in a section"** | **`cad_inspect` (`action: "measure"`) `kind="section"`** | picking 3D points off a render |
| "hole spacing", "wall thickness here", "gap at this spot" | `cad_inspect` (`action: "measure"`) `kind="gap"` with point / datum endpoints | `kind="part"` |
| "how close do these two get", "minimum gap", "nearest point to this sphere" | `cad_inspect` (`action: "measure"`) `kind="gap"` with solid / sphere endpoints | a gap at a point you cannot name |
| **"what angle is this", "are these faces parallel", "how far off axis is this bore"** | **`cad_inspect` (`action: "measure"`) `kind="angle"`** | eyeballing a render; guessing 30°/150° |
| "does the declared interface hold", "check the BOM's tolerances" | `cad_assembly` (`action: "check"`) | `cad_assembly` (`action: "validate"`) |
| "is the evidence fresh?", "what is still unobserved?" | `verify` (V1; read-only) | `cad_deliver` (`action: "audit"`) (claims only) |
| "run the selected pearl template" (deprecated) | `cad_deliver` (`action: "pearl"`) with `{execute:true, inputs}` — deprecated; use the atomic tools | `cad_deliver` (`action: "preflight"`) (it only runs the gate) |
| "write/update the assembly contract", "add an interface" | `cad_assembly` (`action: "write"`) | generic write / `cad_python` (`action: "run"`) |
| "can this actually be printed", "is this wall too thin", "will it need supports" | `cad_check` (`action: "printability"`) | looking at renders |
| "laser/waterjet cut: is this hole too small, wall too thin, holes too close after kerf" | `cad_check` (`action: "sheet2d"`) (section of a flat part; declared kerf/limits) | 3D printability |
| "can this be turned from bar stock; does it fit the L/D/symmetry" | `cad_check` (`action: "turning"`) (bar Ø / L/D / rotational symmetry) | printability profile |
| "can a 3-axis mill reach this pocket/undercut; how many setups" | `cad_check` (`action: "cnc"`) (six principal directions + setup count) | CAM/toolpath |
| "can a sinker EDM electrode reach this cavity along one axis" | `cad_check` (`action: "edm"`) (single burn axis line of sight) | electrode shape/undercut |
| **"screen a family at once", "which of these parts is thin"** | **`cad_check` (`action: "parts"`)** | N single calls; it runs the same jobs and writes one run per part |
| "is this one part or floating fragments", "shells > 1 warning" | `cad_inspect` (`action: "measure"`) `kind="part"` (`bodies` / `bodySizes` / `bodyVerdict`) | guessing from renders |
| "what anchors does this version have", "I forgot a datum", "rename/add an anchor" | `cad_assembly` (`action: "datums"`) | re-running `cad_part` (`action: "generate"`) |
| "look from another angle / cut it open" | `cad_see` (`action: "render"`) | re-running `cad_part` (`action: "generate"`) |
| "give this version a color/material design" | `cad_part` (`action: "appearance"`) (GLB sidecar; no render path) | treating STL as a color carrier |
| "the reference image is gone from my context" | `cad_see` (`action: "reference"`) | describing the image from memory |
| "the user is only *talking* about a part", no geometry yet | `cad_part` (`action: "create"`) | `cad_part` (`action: "generate"`) (it would invent a shape) |
| "before I claim this is delivered" | `cad_deliver` (`action: "plan"`)（只读计划）→ 按每行 `next` 跑原子工具 → `cad_deliver` (`action: "audit"`) | re-reading your own notes; `cad_deliver` (`action: "plan"`) alone is not a claim |
| "what is missing / what should I run next?", "show me the whole delivery board" | **`cad_deliver` (`action: "plan"`)** (read-only plan derived from BOM/ICD/claims/run graph; each row names its atomic tool) | guessing which check applies, or running `cad_deliver` (`action: "preflight"`) blind |
| "the human should look at this", "ask them to review", "propose a rollback" | `cad_session` (`action: "review"`) | moving their viewport or opening a modal |
| "what did v030 look like", "how did this change" | the panel's version gate + compare (the human opens it); or `cad_session({ action: "review", args: { items: [{ target: "v030" }] } })` | re-running old tool calls to "show" it |
| "a check no CAD tool covers" (FEM, optimisation, a custom metric) | `cad_python` (`action: "run"`) | shelling out to the system python |
| "the runtime is missing / broken / I want it warm" | `cad_python` (`action: "runtime"`) | re-running a failing tool and hoping |

**`cad_inspect` (`action: "measure"`) 的五个 kind**：whole-part 数字 → `kind="part"`（加 `axis`/`axisVector` 可投影）。“两样东西相距多远” → `kind="gap"`, where the only decision is how you NAME each endpoint, and both must be the same kind: solid (`aVersionId`/`bVersionId`) or sphere (`aSphere`/`bSphere`), or point (`aPoint`/`bPoint`) or datum (`aDatum`/`bDatum`). A solid cannot pair with a point in one call. Renders carry no coordinates: get them from `cad_inspect` (`action: "features"`) first; when you cannot name a point, `kind="thickness"` takes a line instead.

**`cad_assembly` (`action: "validate"`) vs `cad_assembly` (`action: "check"`)**: the first is ad-hoc (parts + poses → interference/clearance); the second is contractual (manifest → declared interfaces + undeclared adjacency).

**An imported part is an ordinary version.** Every row above applies; the only thing it cannot do by itself is *be an interface endpoint* — that needs datums.

## Conventions

- **Millimetres, z-up.** No tool takes a unit argument.
- **Datums** are declared `datum("name",[x,y,z])` at top level in final world coordinates; they do not affect the mesh. `datum_axis` / `datum_plane` / `datum_cyl` exist for assemblies — signature is `(name, point, dir)`, POINT FIRST: a positional swap compiles silently and corrupts the contract (a zero dir is now a compile error; a dir that dwarfs its point warns as a swap). `cad_assembly` (`action: "datums"`) lists or records; recording creates a **new version** (mesh copied, no recompile) — point the manifest at the returned id. Do not spend a `cad_part` (`action: "generate"`) round on an anchor-only change.
- **The manifest** is an ordinary file, by default `<workspace>/assembly/assembly.json`; `cad_assembly` (`action: "check"`) resolves a relative `manifestPath` against the workspace first. Edit it with `write` / `edit`; do not patch JSON by shell.
- **BOSL2 is an OpenSCAD modelling library, not the standard-parts catalogue.** It is available in `cad_part` (`action: "generate"`) when writing `scadCode` (`std`, `screws`, `gears`, `walls`, `threading`, `sliders`, `ball_bearings`); use it instead of hand-rolling a thread/gear/fillet.
- **The 99 pre-generated standard parts are shipped but not tool-exposed in 0.1.2-preview.1.** `library/catalog.json` has the IDs and `fit`/`visual` LODs, but there is no `cad_part` list/get/import-by-catalog action. Do not claim you can select a catalogue part; if the user gives a `library/parts/.../fit/model.step` path, import it as `stock`. Read `docs/llm/library.md` before answering catalogue questions.
- **`judge` / `scan` / `both`**: `judge` (default) returns the verdict and no field; `scan` returns the field and **no verdict**; `both` returns both. The **run report** always records both halves — the mode trims the reply, not the record. In `judge` the reply still carries `nextLook` (`{tool, args, why}`) because a verdict without a place is the failure HARNESS §11.14 exists to prevent.
- **Runtime**: measuring/checking/simulating need the pinned Python runtime (`cad_python` (`action: "runtime"`) provisions/repairs); `cad_python` (`action: "run"`) shares it. `cad_deliver` (`action: "audit"`), `cad_part` (`action: "create"`), `cad_assembly` (`action: "datums"`), `cad_see` (`action: "render"`), `cad_see` (`action: "reference"`) do not need it. **`cad_assembly` (`action: "check"`) does.**
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

1. **Never deliver on green numbers alone.** Look at the final state (assembly renders, panel screenshots, or a fresh `cad_see` (`action: "render"`)).
2. **`cad_check` (`action: "printability"`) on every part before “done”**, and after any wall/boss/angle change. `difficult` findings get answered, not ignored.
3. “Compiles / assembles / report passes” are three claims; delivery needs all three + eyes + a printability pass.
4. **A version update invalidates every whole-machine result that names the old version.** Re-run merged body, physics/motion, `cad_assembly` (`action: "validate"`), and `cad_assembly` (`action: "check"`); update manifest nodes; a superseded run is not current evidence.
5. **A whole-machine claim needs a whole-machine run.** Check the run's part list; a fragment is not “the machine”.
6. **A mechanism must be able to fail the contract.** Joint interfaces need `check: "motion-clearance"` citing a run that covers the delivered versions.
7. **Run `cad_deliver` (`action: "audit"`) before any delivery claim and answer its findings** (`stale-evidence`, `versions-never-cited`, `contract-without-motion`, `merged-stale`, `duplicate-runs`, `unregistered-geometry`). A `blocked` finding means the corpus contradicts the claim.

## Depth

| the job | the skill | long-form |
|---|---|---|
| mechanism / rigid bodies / flow | `cad-simulation` | `docs/llm/engines.md` |
| assembly contracts, datums, fit | `cad-assembly` | `docs/llm/assembly.md` |
| authoring, importing, measuring | `cad-modeling-measure` | `docs/llm/modeling.md` |
| can it be made / process profiles | `cad-manufacturing` | `docs/llm/manufacturing.md` |
| conventions / delivery / traps | this file | `docs/llm/conventions.md` · `delivery.md` · `traps.md` |

Parameters and minimal calls: `docs/TOOL-CONTRACTS.md` (generated; do not hand-edit). If a field is not there, it does not exist.
