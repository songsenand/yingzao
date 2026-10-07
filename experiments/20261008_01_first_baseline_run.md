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
| ?? | `c-measured-vs-datum` | 未实现求值器 |
| ?? | `p-version-recall` | 需人判 |

**六列：P = 0**（按 `gatePolicy: any-fail => P = 0`）。**自动判定 16/18。**

## 分析

### 三条 FAIL，两种成因
考卷**钉死了两个尺寸**：端枨顶面与座面底面 **0.4mm 让位间隙**（且明说"不要写进装配清单"）、
腿穿座面的**出榫 5mm**（"露在座面上表面之上"）。模型**两个都没验证**：

- `c-protrusion`：全程**零 `measure_distance` 调用**，契约里也没有出榫条目。
- `g-undeclared-found`：它**照做了**"不写进装配清单"（契约里确实没有端枨↔座面那条），
  但邻接扫描（阈值 **0.75mm**，对每两个已构建实体算最近距离，`partWarnings` 为空说明
  7 件几何都建起来了）没有命中 ⇒ **实际间隙 ≥ 0.75mm，不是要求的 0.4mm**。
  所以它报的 `undeclared 0` **不是合规证据**，恰恰是"尺寸没做到"的旁证。

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
- **`bench-score.mjs` 可用但未完成**：16/18 自动判定；`c-measured-vs-datum` 与
  探针 `p-version-recall` 仍需人工或补求值器。**六列里 E/H/R 仍靠人判**，
  脚本只给证据指针。
- **本轮的模型结论不可外推**：只有 1 次运行，且首轮夹杂了工具 bug 与判据补写。
  要做模型对比必须先 `N≥3`。
- **下一步**：补完 `c-measured-vs-datum` 与探针求值器 → 跑 `01b` 与 `02` 首轮 →
  决定是否拆 `g-undeclared-found` → 全题铺开 `N≥3`。
- **一条观察值得跟进**：模型在被钉死的尺寸上倾向于"声称符合设计意图"而不回到
  几何上量。若后续重复出现，`H` 列的定义与"必须测量"的要求应写得更硬。
