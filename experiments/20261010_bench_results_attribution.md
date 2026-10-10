# 实验报告：评测结果归因 —— 能力 / 场地 / skill 三分

## 目标

对 `examples/bench/graders/RESULTS.md`（2026-10-10）表格中所有 **❌ 不过** 与
**❓ 需人判** 的条目做归因，回答三个问题：

1. 哪些是 **LLM 能力问题**（换场地、改手册都仍会留下）；
2. 哪些是 **插件 / 考场基建（场地）问题**（instrument、runner、求值器、预算、沙箱、归档）；
3. 哪些是 **`cad-toolbox` 手册（skill）问题**，以及从哪个角度补强。

> 口径前提（`docs/DECISION-LOG.md` 2026-10-10）：**现阶段目标是评测链路能跑通，
> 不是拿到可信的能力分数；`C` 列只记录、不作为行动依据。** 所以本报告把
> "链路断点"与 "能力短板"分开排优先级，不为了让分数好看而动手册。

## 方法（数据来源）

不重跑，只对已入库结果做二次归因。证据面：

- 判据与口径：`examples/bench/graders/README.md` §四/§七、各题 `rubric.json`
  （逐条的 `desc` / `expect` / `inSkill` / `inSkillNote`）。
- 机检结果：`graders/*/scores/*.json`（00/01/01b 有归档；02/03 只见于 RESULTS.md 正文）。
- 手册：`dsh-cad-harness/skills/cad-toolbox/SKILL.md`（交付纪律 §303-352、测量纪律 §256-257、
  邻接门槛 §157-162、同轴 §265-268、参考图 §276-284）。
- 场地实现：`examples/bench/tools/bench-run.mjs`、`bench-score.mjs`、`headless-overlay.yml`。

分类规则：

- 判据 `inSkill=false` 且手册无对应流程 → 优先记 **能力**（若手册有旋钮无流程，标"能力+skill 可补"）。
- 判据本身不能机检 / 求值器形状过严 / 归档缺失 / 预算与环境限制 → 记 **场地**。
- 手册 `inSkill=true` 但模型没执行 → **能力**（手册已覆盖）；手册反复覆盖却仍不做 → **skill 表达问题**。

## 结果

### 一、条目归因表

| 条目 | 结果 | 归因 | 依据 |
|---|---|---|---|
| 01 `g-grader-access` | r01 ❌（整轮作废） | **场地（已修）** | skill 正文自带 `Base directory` 面包屑指向仓库根 ⇒ 考生据此 `cat graders/…`；commit `96c4f32` 手册副本外置后消除 |
| 01 `g-undeclared-found` | 3/3 ❌ | **能力**（+skill 可补方法） | `inSkill=false`；手册只有 `adjacencyThresholdMm` 旋钮（§157-162），没有"交付前抬门槛扫未声明邻接"的流程 |
| 01 `c-protrusion` | r02/r03 ❌ | **能力** | 零 `measure_distance`；手册通则已写（§256-257「有公差先量再判」）但未执行 |
| 01 `c-measured-vs-datum` | r01 ❓ / r02,r03 ❌ | **能力 + 场地（r01 判据缺口）** | 同根因（零测量）；r01 记 UNKNOWN 是"缺一条路径的数不能判 FAIL"的约定 |
| 01 `p-version-recall` | R 记 N/A | **场地** | 探针门槛 `renderRounds >= 6`，实测 5 ⇒ R 列在 01 不可测 |
| 01b `g-motion-never-checked` | 12/12 ❌ ⇒ 四臂 P=0 | **场地（判据形状）** | 实质命中"`motion-clearance`=0"，仅未点出"6 条"这个形状要求；README §七 已给改法（UNKNOWN+证据） |
| 01b `g-no-green-claim` | 12/12 ❓ | **场地（判据未实现 → 人判）** | 语义项；关键词代理曾在首个真实用例误判（README §七） |
| 01b `g-distinguish-notdone-vs-failed` | 12/12 ❓ | **场地（判据未实现 → 人判）** | `inSkill=false` 语义项 |
| 01b `c-anchoring` | 12/12 ❓ | **场地（应两臂自动算）** | 单臂轮内无基线；delta 文件已离线算出 `anchoringSuspect` |
| 01b `g-evidence-cited` | flash cand r01/r02、v4.1 base r01 ❌ | **能力 + skill 缺口** | `inSkill=false`；手册未要求"诊断结论带字段级依据" |
| 01b `c-stale-visual` | 4/12 ❌ | **能力 + skill（通则未落流程）** | `inSkill=false`；手册只有交付纪律 #4 的通则，未要求做该审计发现 |
| 01b 预算 | calls 8–38 vs budget 12 普遍超 | **场地（成本，暂不调）** | DECISION-LOG 2026-10-10 明确 C 列只记录 |
| 01b `S0` | flash 3/6、v4.1 1/6 观测到加载 | **场地 ∩ skill（触发）** | 手册未被看见 ⇒ `S` 记 N/A，A/B 无法给结论 |
| 01b 锚定嫌疑 | flash 臂 `anchoringSuspect=true` | **skill（设计）** | 候选手册 380 行 vs 基准 313 行 ⇒ citedRunIds 中位 22<24、`g-evidence-cited` 1/3 vs 3/3；压到 361 行后 v4.1 组转 false |
| 02 `c-fluid-arrival` | ❌（0.4173） | **场地（工况契约未定）** | README §七 ⛔待定：`fluidRegionMm`/`inletVelocityMmPerSec`/步数全由调用方选，跨轮不可比；不计入模型短板 |
| 02/03 归档 | 无 `scores/*.json` | **场地（归档闭环）** | RESULTS 声称来源是机检 `scores/*.score.json`，但只有 00/01/01b 有该目录 |
| 03 外观 7 条 `features` | 仍人判 | **设计使然** | 落在 rubric `features`，按设计不计入 26 条机检 |

### 二、三类的规模

- **能力问题**：01 的 `g-undeclared-found` + 零测量（`c-protrusion`/`c-measured-vs-datum`）、
  01b 的 `g-evidence-cited`/`c-stale-visual`。共同根因只有一个：**不主动量、不主动扫邻接、不给字段级引用**。
- **场地问题**：01b 的 `g-motion-never-checked`（判据形状，直接让整题 P 恒 0）、三条 ❓ 求值器缺口、
  `c-fluid-arrival` 工况未定、02/03 归档缺失、01 R 探针门槛、01 r01 面包屑（已修）、成本预算偏紧。
- **skill 问题**：S0 触发率不稳、长手册诱导锚定、测量/邻接/引用三类"有旋钮无流程"的覆盖缺口。

## 分析

### 1. 最贵的一条不是能力，是判据形状

`g-motion-never-checked` 让 01b **四组 × 三轮 P 全为 0**，而四组的回答"实质上指出了机构从未在
最终版本上机检通过"。硬门一失败就把 P 归零，于是一个**形状要求**把整道诊断题的能力信号全部抹掉。
按 README §七 既有约定，语义/形状类项应记 `UNKNOWN`+候选证据，而不是硬门 FAIL。这是当前
**投入产出比最高的一处修复**。

### 2. ❓ 全部是求值器缺口，不是考生失败

`g-no-green-claim`、`g-distinguish-notdone-vs-failed` 是语义项，`c-anchoring` 是**两臂对比项**。
前两条确实只能人判；第三条其实可以机械化（delta 文件已经在算），只是没把它从"轮内 UNKNOWN"
提升为"双臂求解"。把 ❓ 读成"模型不会"会系统性低估模型。

### 3. `S0` 不稳是"手册改动能不能被测出来"的前提问题

v4.1 臂 1/6、flash 臂 3/6 观测到手册加载。`S0=false` 时 `S` 记 N/A，于是

> "手册 +67 行改动的净效应" 这个问题，在本轮**无法回答**（flash 的 ΔS=0.0 也只是两臂都顶在
> 0.8 天花板上）。

这不是排版问题，是**手册可见性**问题：诊断类任务不必然触发 CAD skill 的加载条件。要么换一道
"必然用 CAD 工具"的题来测 skill 内容（01/02），要么在 profile 层固定加载并在报告里标注
"该轮 S0 由配置保证"——后者会牺牲"模型自己会不会想起来用"的测量，属于口径取舍。

### 4. 锚定是一条真实的 skill 设计信号

flash 臂：手册从 313 行加到 380 行后，候选臂引用 run id 中位数反而从 24 降到 22、
`g-evidence-cited` 通过率从 3/3 掉到 1/3。v4.1 臂把新增内容压成 361 行点式清单后，
`anchoringSuspect=false`。两次观测方向一致 ⇒ **手册应"给方法不给结论"、分点化、控长度**。

### 5. 能力项要留在能力项，不能拿手册去救

`g-undeclared-found`、`c-protrusion`、`c-measured-vs-datum` 都是 `inSkill=false` 的纯能力项，
且手册里 SKILL 明说了"有公差先量"、"邻接门槛是调用方的选择"。把"该量哪些尺寸"的答案写进手册，
会同时污染 `S` 与能力项的分离（README §七 的设计意图就是两者可背离）。正确做法是补**流程**
（怎么扫、什么时候扫），不补**结论**（扫出来是什么）。

### 6. 归档闭环决定这些结论明年还成不成立

02/03 的分数只存在于 RESULTS.md 的正文里，没有 `scores/*.json`。而 RESULTS 声称来源是机检
score 文件。这会让 02/03 的 P/S/S0 无法复核，也让"结果表"与"机检产物"之间出现第二权威副本。

## 遇到的问题

- **单文件双权威**：RESULTS.md 与 `scores/*.json` 对 02/03 只有前者，暂无解。
- **人判项无处置协议**：README 只说"记 UNKNOWN 并把证据摘进 detail"，但没有"谁判、判完写哪"。
- **`g-motion-never-checked` 属于已知设计债**：RESULTS 注脚自己已经建议改，属未结项。

## 产物列表

**数据与判据：**

- `examples/bench/graders/RESULTS.md` —— 被分析的结果表（2026-10-10）
- `examples/bench/graders/*/rubric.json` —— 逐条判据的 `desc`/`expect`/`inSkill`
- `examples/bench/graders/01b-diagnosis/scores/*.json` —— 四臂的轮级 s0/P/S/gatesFailed/citedRunIds
- `examples/bench/graders/01-mortise-bench/scores/*.json` —— r01/r02/r03 与 summary
- `examples/bench/graders/README.md` §四/§七 —— 分类口径

**代码与脚本：**

- `examples/bench/tools/bench-score.mjs` —— 求值器（`skillLoaded()` 在 244-246 行决定 S0）
- `examples/bench/tools/bench-run.mjs` —— run root、手册副本外置、model overlay
- `examples/bench/tools/headless-overlay.yml` —— headless 补手册根

**运行命令（复核本报告用到的计数）：**

```bash
cd examples/bench/graders
node -e 'for (const f of process.argv.slice(1)) { const s = require("./"+f);
  if (s.rounds) for (const r of s.rounds)
    console.log(f, r.repeat, "s0="+r.s0, "P="+r.P, JSON.stringify(r.gatesFailed), JSON.stringify(r.checksFailed)); }' \
  01b-diagnosis/scores/*baseline.json 01b-diagnosis/scores/*candidate.json
```

**环境依赖：** Node（仅 `require` JSON）；无网络、无 GPU。

## 结论与下一步

**结论：** RESULTS 里的"不过"里，**能力问题只占一半且根因单一（不主动量/扫/引用）**；
另外一半是场地问题——其中 `g-motion-never-checked` 一条就吞掉了整道 01b 的 P 列，
三条 ❓ 全是求值器缺口，`c-fluid-arrival` 是插件契约未定。skill 侧最硬的信号是
**S0 可见性**与**长手册锚定**。

**下一步（按现阶段的"链路跑通"目标排序）：**

- **P0 场地**：① `g-motion-never-checked` 按 README §七 改为 `UNKNOWN`+证据（否则 01b 永久 P=0）；
  ② 02/03 的 score json 落盘归档，恢复"机检产物是唯一权威"；③ 把会话 cwd 整体移出仓库根，
  彻底关掉 `graders/`、`docs/DECISION-LOG.md`、`examples/microscope5/**` 三处暴露面（README §四 方向）。
- **P1 可测性**：④ 解决 S0——用"必然用工具"的题测手册内容，或以配置保证加载并在报告中标注；
  ⑤ 定稿 `c-fluid-arrival` 的撒种/工况契约（`M4-M5-REVIEW.md`）。
- **P2 skill**：⑥ 把"测量 / 邻接扫描 / 字段级引用"补成**分点流程**（给方法不给结论）；
  ⑦ 继续压缩手册并按 01b A/B 复测，盯 `anchoringSuspect` 与 `citedRunIds_median`。
- **P3 判据完成度**：⑧ 把 `c-anchoring` 从轮内 UNKNOWN 提升为双臂自动求解；
  ⑨ 给语义项写人判协议（谁判、写在哪、如何进分数文件）。
- **不要做**：把 `g-undeclared-found` / `c-protrusion` 的答案写进手册——那会让 `S` 与能力项
  的分离失效，属于为提分污染测量。
