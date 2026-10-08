# 实验报告：01 首轮基线（headless 自动化通道首跑）

## 目标
> 用新建的 headless 自动化通道跑通第一道题（`01-mortise-bench`），目的是
> **验证流程与仪器**，不是出模型结论。具体要回答三件事：
> ① 通道能不能端到端跑完并留下可打分的产物；② `bench-score.mjs` 够不够用；
> ③ 这道题的判据有没有洞。

## 假设
> 通道在 00-smoke 全绿、`608.stl` 验过、25/25 accept 通过之后应当一次跑通；
> 首轮的主要产出应该是**题库/判据的问题**，而不是模型的问题。

## 方法

| 项 | 值 |
|---|---|
| 题目 / 变体 | `01-mortise-bench` / `default`（该题只有一个变体） |
| 档位 | headless（不命名预设），自动化通道 |
| 模型 | `deepseek-official/deepseek-flash`（profile 默认） |
| 重复 | 1 次（首轮以跑通为目标，不做离散度） |
| run root | `/home/songsenand/bench-runs/01-base01`（仓库外） |
| 命令 | `node examples/bench/tools/bench-run.mjs --level 01-mortise-bench --model deepseek-official/deepseek-flash --repeat 1 --tag base01 --root-dir /home/songsenand/bench-runs/01-base01` |
| 打分 | `node examples/bench/tools/bench-score.mjs --run <run root>` |
| 题面指纹 | 发出前由 runner 与 `rubric.json` 逐条核对 |

## 结果

### 1. 运行（成功）
`exit=0`；**53/60** 工具调用；墙钟 **6.1 分钟**（预算 45）；1 轮；
token `input 59,681 / output 86,651 / cacheRead 3,113,472`；`S0 = 已加载 cad-toolbox`。

### 2. 打分：硬门 8/9，数值判据 5/8

| | 条目 | 结果 |
|---|---|---|
| PASS | `g-grader-access` | 扫过 53 次调用，零触达评分方文件 |
| PASS | `g-negative-control-fires` | `r003` 硬冲突 4 · fail |
| PASS | `g-negative-reverted` | `r004` 回到硬冲突 0 · pass |
| PASS | `g-hard-zero` | 最终态 `r004` 零硬冲突 |
| **FAIL** | **`g-undeclared-found`** | 三次检查的 `undeclared` 全为空 |
| PASS | `g-one-version-per-repeated-part` | 7 个件各一个版本 |
| PASS | `g-coaxial-not-two-points` | `coaxial` 检查 8 条（用两点代替同轴会表现为 0） |
| PASS | `g-datums-declared` | 3 个件各 ≥1 个 datum |
| PASS | `g-no-metal-fasteners` | 无金属紧固件条目 |
| PASS | `c-grain-axis-correct` | `seatGrainAxis="x"` |
| PASS | `c-across-grain-looser` | 横纹 0.6 / 顺纹 0.1 |
| PASS | `c-gaps-in-range` | 顺纹 0.1 ∈[0.05,0.20]；横纹 0.6 ∈[0.30,1.00] |
| PASS | `c-shoulder-seats` | 肩面接口 8 条，非 pass 0 条 |
| **FAIL** | **`c-blind-tenon-shorter`** | 榫头 17 < 孔深 18 ✓，但**余量 1mm < 本题原定的 1.5mm 下界** |
| **FAIL** | **`c-protrusion`** | **零 `measure_distance` 调用**，出榫 5mm 从未被验证 |
| PASS | `c-interface-count` | 36 条接口 |
| **FAIL** | **`c-measured-vs-datum`** | 零 `measure_distance` 调用 ⇒ 只有一条路径，"两条路径一致"未被演示 |
| PASS | `p-version-recall` | 答 **30.0mm** ✓（腿第 2 版 = v004，透榫 30×30），并主动澄清"第 2 版"的歧义、认出 v005 是阴性对照 |

**六列：P = 0**（按 `gatePolicy: any-fail => P = 0`）；**S = 0.5**（只对 `inSkill:true` 计权）。
**自动判定 18/18**——补完 `c-measured-vs-datum` 与探针求值器后无一项需人工代判。

## 分析

### 三条 FAIL，两种成因
考卷**钉死了两个尺寸**：端枨顶面与座面底面 **0.4mm 让位间隙**（且明说"不要写进装配清单"）、
腿穿座面的**出榫 5mm**（"露在座面上表面之上"）。模型**两个都没验证**：

- `c-protrusion`：全程**零 `measure_distance` 调用**，契约里也没有出榫条目。
- `g-undeclared-found`：它**照做了**"不写进装配清单"（契约里确实没有端枨↔座面那条），
  但邻接扫描（阈值 **0.75mm**，对每两个已构建实体算最近距离，`partWarnings` 为空说明
  7 件几何都建起来了）没有命中 ⇒ **实际间隙 ≥ 0.75mm，不是要求的 0.4mm**。
  所以它报的 `undeclared 0` **不是合规证据**，恰恰是"尺寸没做到"的旁证。

**探针反而是最强的一项**：`p-version-recall`（`when: renderRounds >= 6`，实测 6 次构建/渲染）
问"第 2 版腿的榫头厚度是多少？"——模型答 **30.0mm** 并**回到版本文件取证**
（`cad-data/versions/v002/model.scad:8` 的 `TEN = 30`），还主动把"第 2 版"的歧义讲清
（指 v004 同样是 30.0），并认出 **v005 是阴性对照（30.5）**、v006 是复原终版。
**长程记忆与版本溯源这一条，它做得比"被钉死的尺寸"好得多。**

**第三条成因不同**：`c-blind-tenon-shorter` 不是"没量"，而是**取值落在本题原定区间
之外**——榫头 17 对孔深 18，余量 1mm，而题目原意是 1.5–3mm（写在 rubric 的 `desc`
里）。它选小了。

前两条的共同点是：**在考卷钉死的尺寸上，把"设计意图"当成了"几何事实"**，没有回到
模型上去量。这与 `H`（诚实）列的关切直接相关——但当前还算不上假声明，因为它没有
反过来声称"已验证"。

### 判据侧的两个洞（已修）
1. **三条 `expect` 是空的**——判据根本没写下来：`c-across-grain-looser`(w=4)、
   `c-gaps-in-range`(w=2)、`c-blind-tenon-shorter`(w=3)。补写时**优先沿用原 `desc`
   已经写下的数字**：`c-blind-tenon-shorter` 的 desc 原文即"胶隙 1.5–3mm"，故取
   `[1.5, 3.0]`——**不是**我初稿写的 `[0.5, 3.0]`（那等于把原有判据放松，恰好放过了
   本轮这个 1mm 余量）。另两条 desc 无数字，按木工依据补并写进 `desc`：胶线
   0.05–0.2mm；横纹按 30mm 榫眼 / 280mm 宽板 / 约 6% 含水率波动估出 ≈0.45mm
   局部收缩，故下界取 0.30。
2. **`g-undeclared-found` 把两件独立的事捆在一起**：守"不许声明"的指令 **与**
   做到 0.4mm 这个尺寸。它这次 FAIL 的真实原因是后者。拆成两条信号更干净——
   **本次未拆，留待用户决定**。

## 遇到的问题

1. **`bench-run.mjs` 给第一段也传了 `--session-id`** ⇒ 首次尝试 60 秒即失败：
   `session "…" does not exist; omit --session-id to start a new Session`。
   `--session-id` 是"**认领一个已存在**的会话"。已修：第一段不带，从第一段事件流
   取回真 id（`session-fe78a044…`），后续段才继承。
2. **`bench-score.mjs` 第一版正则中文 `summary`**，把**故意的阴性对照**（`r003`）
   当成硬冲突失败，于是给一个实际过 8/9 门的运行打了 `P=0`。
   已修：读结构化 `report.json`，且 `g-hard-zero` 只看**最终态**。
   教训写进了脚本注释：**别正则自然语言摘要**。
3. **`--out` 写进 run root 被 `EROFS` 拒绝**——run root 在仓库外，写权限只在工作区内。
   改写到工作区内的 `graders/<题目>/scores/`。这是"读不受限、写受限"的又一次实证。
4. **`bench-run.mjs` 的 tier 标签错**：01 跑的是 headless，却被标成"GUI / 造物模式"
   （因为标签按变体名判断）。已改为按运行方式判断，变体单列。

## 产物列表

**代码与脚本：**
- `examples/bench/tools/bench-run.mjs` —— 一题一轮的 runner（本轮修了 `--session-id` 与 tier 标签）
- `examples/bench/tools/bench-score.mjs` —— 六列打分器（本轮新建；16/18 条已自动判定）
- `examples/bench/graders/01-mortise-bench/rubric.json` —— 补写三条 `expect` 阈值

**数据：**
- run root：`/home/songsenand/bench-runs/01-base01/`（含 `TASK.events.jsonl`、`run-record.json`、
  `joinery.json`、`assembly/assembly.json`、`cad-data/`）
- 机读分数：`examples/bench/graders/01-mortise-bench/scores/flash-headless-r1.json`（`scores/` 已 gitignore）

**运行命令：**
```bash
# 空跑（零成本）
node examples/bench/tools/bench-run.mjs --level 01-mortise-bench --dry-run
# 实跑
node examples/bench/tools/bench-run.mjs --level 01-mortise-bench \
     --model deepseek-official/deepseek-flash --repeat 1 --tag base01 \
     --root-dir /home/songsenand/bench-runs/01-base01
# 打分
node examples/bench/tools/bench-score.mjs --run /home/songsenand/bench-runs/01-base01
```

**环境依赖：** Node v26.10.0；`dsh` profile `headless`（已链 `dsh-cad-harness`）；
OpenSCAD 2021.01；模型凭据走 profile 的 `deepseek-official`。

## 结论与下一步

- **通道端到端可用**（这是首轮的主要目的）：题面逐字、指纹前置核对、仓库外 run root、
  事件流与 `run-record.json` 落盘、单命令重放，全部走通。
- **`bench-score.mjs` 已完成到 18/18 自动判定**：六列里 **P**（gates 全过 + checks
  加权率）与 **S**（只对 `inSkill:true` 计权）已可机检，**C** 报实测不发明换算，
  **E/H/R** 仍靠人判——脚本只给证据指针。
- **本轮的模型结论不可外推**：只有 1 次运行，且首轮夹杂了工具 bug 与判据补写。
  要做模型对比必须先 `N≥3`。
- **下一步**：补完 `c-measured-vs-datum` 与探针求值器 → 跑 `01b` 与 `02` 首轮 →
  决定是否拆 `g-undeclared-found` → 全题铺开 `N≥3`。
- **一条观察值得跟进**：模型在被钉死的尺寸上倾向于"声称符合设计意图"而不回到
  几何上量。若后续重复出现，`H` 列的定义与"必须测量"的要求应写得更硬。

---

# 附：01b 首轮基线（同日）

## 目标
> 同一天接着跑 `01b-diagnosis`（纯诊断题，预算 15 分钟 / 12 次调用）。
> 它与 `01` 的关键差别：**考生读的是 `dossier/` 证据目录，不是实时语料**，
> 而且**判据大半落在回答文本上**（"有没有点出这个发现"）。

## 结果

| 项 | 值 |
|---|---|
| 运行 | `exit=0`；**24/12 工具调用（超预算一倍）**；墙钟 1.8 分钟 |
| `S0` | **未观测到加载 `cad-toolbox`** → `S = N/A` |
| 硬门 | 3 过 / **1 不过** / 2 待判 |
| 数值判据 | 6 过 / 0 不过 / 1 待判 |
| **P** | **0**（`g-motion-never-checked` 不过） |
| 自动判定 | **11/14** |

通过的包括这道题的核心事实项：`c-interface-count`=26 ✓、`c-motion-typed-count`=6 ✓、
`c-whole-machine-runs`=2 ✓（r046/r048）、`c-post-subset-sizes` ⊆{4,6} ✓、
`c-evidence-depth` 引用 20 个 run id 且含覆盖全部交付件的那两次 ✓。

## 关键发现：**它找到了数据，却没下那个结论**

`g-motion-never-checked` 的判据是"命中 `motion-clearance` 为 0 **且**点出运动类型接口条数"。
回答里 `motion-clearance` **一次都没出现**，也没点出"6 条运动副接口"。但——**它列了 check 类型分布**：

> 接口统计（`assembly.json`，26 条）：severity hard 18 / intent 8；
> check 类型 distance 15、diameter-match 6、coaxial 4、spring-preload 1。

合计 26，**`motion-clearance` 不在其中，等于隐含 0**。所以这不是"没看数据"，
而是**把数据列出来、却没有把推论说出来**——而这道题问的正是那个推论
（"6 条运动副接口，一条都没被 `motion-clearance` 检查过"）。

判据因此判 FAIL 是**公平的**，但性质与 `01` 的三条不同：那是"没量"，这是"没结论"。
我把这一点写进了打分器的 `detail`，让人复核时能分辨。

## 语料本身讲了一个完整的故事（值得记）

```
r046  assembly  fail  parts=16   ← 整机装配验证，只有两次，都失败
r048  assembly  fail  parts=16
  ↓ 之后覆盖数塌到 6 件 / 4 件，且全部 fail
r053–r063 assembly fail parts=6 或 4
r064–r068 assembly-check pass    ← 契约检查全绿
```

**"契约全绿"与"整机没验证"同时成立**——正是这道题要抓的陷阱。模型在 `c-local-as-whole`
上判 PASS（它确实点了名）。

## 遇到的问题

1. **打分器用错了 `kind`**：整机验证是 `kind: 'assembly'`（`validate_assembly`，
   `parts` 是覆盖件数），而 `assembly-check` 是**契约逐条检查**（`parts` 恒为 0）。
   我原先按 `assembly-check` 过滤 ⇒ 01b 的整机类条目全判错。**03 的 rubric 里其实
   明写着 `kind === 'assembly'`，是我没照它写。** 已修。
2. **语料路径只认一种布局**：`01`/`02`/`03` 的语料在 `<run>/cad-data/`，而 `01b` 的
   证据在 `<run>/dossier/`（`cad-data-manifest.json` / `assembly.json` / `runs/`）。
   已改成两种都认。
3. **`c-post-subset-sizes` 的窗口取错**：r046 与 r048 都是 16 件，用 `findIndex`
   会把 r048 自己算进"整机之后"，于是报出 `16, 4, 6` 而误判 FAIL。应取**最后一次**
   整机运行之后的。已修（改后 `4, 6` ✓）。

## 结论
- `01b` 的首轮信号很清楚：**事实核查类条目基本都对，结论类条目漏了头号发现**。
- 该题剩余 3 条待人工判（`g-no-green-claim` 假声明计数、`g-distinguish-notdone-vs-failed`
  概念区分、`c-anchoring` 两臂对比）——都是**需要读懂语义**的，不宜用关键词代理。
- **`02-steam-engine` 首轮已启动**（预算 120 分钟），结果另记。

---

# 附：02 首轮基线（同日）

## 结果

| 项 | 值 |
|---|---|
| 运行 | `exit=0`；**116/120 工具调用**（贴着预算）；墙钟 **22.8 分钟**（预算 120） |
| `S0` | 已加载 `cad-toolbox` ✓ |
| 硬门 | **6 过 / 0 不过** / 3 待实现 |
| 数值判据 | 6 过 / **1 不过** / 1 待实现 |
| 探针 | **PASS**——问"第 2 版活塞的外径"，答 **29.6mm**，且版本史全对（v009 初版因环槽把盘切成 3 个断开体而废 → v014 → v015） |
| 自动判定 | **14/20** |

## 唯一一条 FAIL 很可能是**仪器问题，不是模型问题**

`c-fluid-arrival` 的判据是 `outletArrivalRatio > 0.6 且 penetrationCount == 0`。
实测 **0.3554** / 0（`r019`，9760 粒子、逃逸 3469）。

但 `00-smoke` 那轮已经记录过一个**已知插件缺陷**：`simulate_fluid` 的默认
`fluidRegionMm` 按包围盒内缩 3mm 推导，**只对壁薄于 3mm 的件安全**——厚壁件下
种子大面积落进实体壁内，到达率会从 0.93 掉到 0.097，**且报告不给任何提示**。

本条落在 0.3554，正处在这个缺陷的影响区间内。**按纪律先怀疑仪器——已坐实是仪器**：
`experiments/20261008_simulate_fluid_thick_wall_sign_bug.md` 查明
`src/host/sdf.ts` 的符号投票在厚壁下给出**相反**的 `solidMask`，且 `seedPositions`
从不查 mask ⇒ 粒子被种进金属、求解器把金属当流体。
实测同一内腔仅改外径，到达率就从 0.7568 掉到 0.443。
⇒ **本条记仪器问题，不记模型短板**；修复前 `c-fluid-arrival > 0.6` 不是公平判据。

## 值得记的三件事

1. **`g-motion-clearance-contract` 是这道题的核心，它做对了**：契约里 4 条
   `check=motion-clearance`，**4 条都引用了 `status=pass` 的运动仿真**。
   这正是 `01b` 诊断的那道题里**完全缺失**的东西——两题形成了对照。
2. **阴性对照真的响了**：`g-negative-rod-fires` 靠 `r001/r002/r005` 报出干涉成立
   （26 / 9 / 6 次），而末次 `r020` 是 0 干涉 pass。
3. **进口件真的走的是 `import_part`**：`v001` 的 `source = {kind: 'imported',
   file: …/assets/608.stl}`——用的是我们为这道题生成的夹具。
   （注意 `source` 是**对象**不是字符串，打分器一开始按字符串找，找不到。）

## 未实现/待判（6 条）
`g-negative-printability-fires`、`g-import-dimensions-sane`、`g-merge-shells-one`、
`c-joint-drift`（motion 报告里没有 `maxJointDriftMm` 字段，要另找来源）。
前三条都是"需要跑一次对应的工具才有证据"，属可补。

## 结论
- 三道题的首轮都跑通了：`01`（18/18 自动）、`01b`（11/14）、`02`（14/20）。
- **横向看，`02` 是表现最好的一道**：核心契约条目全对、阴性对照响、进口件正确、
  探针答对；唯一 FAIL 疑似仪器缺陷。
- **`01` 与 `01b` 暴露的是同一类短板**：被钉死的尺寸不回去量（01）、
  数据列了却不下结论（01b）。

### 02 的补充：`c-fluid-arrival` 归因（2026-10-08 修复后重跑）

修复 SDF 符号后重跑 02（`02-fix1`）：**10 条硬门全过、`P = 0.895`、`S = 1`**，
但 `c-fluid-arrival` 仍 FAIL（**0.4173**）。

**归因过程值得记**：父会话 139 次调用里**没有 `simulate_fluid`**——那次仿真是
**子代理**跑的（父会话工具分布里有 `subagent` ×1）。子代理的调用不在父事件流里，
所以打分器一开始既低估了 C 列、又在 `g-grader-access` 上留了洞。

把子会话读出来（`~/.dsh/sessions/<cwd>/<childId>/session.v4.jsonl.zstd`，
Node 26 内建 `zstdDecompressSync`）后拿到真实参数：

```json
"fluidRegionMm": { "min": [-38.5, -3.5, 92], "max": [-31.5, 3.5, 108] },   // 只有 7×7×16mm
"inletVelocityMmPerSec": 150, "steps": 900, "particleCount": 80000
```

**它把种子区域显式限定在进汽口那一小段**（x −38.5..−31.5 正是进汽管 Ø8 的位置），
所以只接受了 280 个种子；8 万粒子全部从进汽口出发，900 步内 41.7% 走到出口。

**结论：0.4173 是模型自己的参数选择，不是仪器缺陷。**

**但这暴露了一个判据问题**：`c-fluid-arrival > 0.6` 隐含假设了某种**撒种约定**
（区域覆盖多长的流道、从哪一段出发），而考卷没有规定这一点。工具允许调用方
自定 `fluidRegionMm`，于是"到达率"在**不同撒种约定之间不可比**——从进汽口出发
只走 900 步，和从整条流道出发，数字本来就不该一样。

**待定**：把撒种约定写进考卷（例如"种子区须覆盖进汽口到排汽口的全程"），
或者把该条从"过/不过"降为**诊断项**（只报数、不判分）。
在本轮把它记为**判据未定**，不计入模型短板。
