# 实验报告：bench 测评的 token 效率诊断（zai-coding-cn/glm-5.3-flash · high）

## 目标

回答三个问题，并给出可执行的降本清单：

1. 这轮七题测评 81.4M tokens 到底花在什么地方？
2. 哪些开销是**结构性的**（改架构才能降），哪些是**行为性的**（改 prompt / 约束就能降）？
3. 若要让「同预算下多比几个模型」成为可能，先动哪几刀、各能省多少？

## 假设

- H1：主要成本是「每一步重读整个上下文」（cacheRead），而不是模型生成（output）。
- H2：上下文膨胀的主因是工具返回（渲染图、JSON 报告、bash 输出）。
- H3：调用次数与总消耗近似**二次关系**：`总消耗 ≈ N·P + g·N²/2`（P=每步固定前缀，g=每步新增内容）。

## 方法

数据来源（全部为本轮真实运行，非模拟）：

- `--json` 事件流的 `status.step_end.usage`：每步 `inputTokens / cacheReadTokens / outputTokens / totalTokens`；
- `~/.dsh/sessions/**/session.v4.jsonl.zstd` 会话记录：逐条消息的真实字节数（含 `reasoning` 块）；
- `tool_call`/`tool_result` 事件：按 callId 归并，统计每个工具的返回体量；
- 插件 bundle 实测：25 个 CAD 工具的 schema 字节数；`skills/*/SKILL.md` 文件字节数；
- 各题 `run-record.json`：工具调用数与墙钟。

换算口径：中文混合文本按 **≈3.5 字符/token** 估算（仅用于量级判断，不用于精确计费）。

限制：`tool_result` 事件按 8 KiB 截断，因此工具返回体量是**下界**；token 计费口径以服务商为准。

## 结果

### 1. 总盘

| 题 | steps | 首步上下文 | 末步上下文 | 累计 totalTokens | 工具调用 | tokens/次 |
|---|---|---|---|---|---|---|
| 01-mortise-bench | 34 | 17.7k | 129.9k | 3.12M | 47 | 64k |
| 01b-diagnosis | 11 | 17.1k | 70.8k | 0.54M | 11 | 49k |
| 02-steam-engine | 105 | 18.1k | 319.4k | 24.10M | 152 | 143k |
| 03-microscope（中断） | 152 | 20.3k | 442.1k（峰值） | 43.34M | 203 | 213k |
| 04-rack-connector | 42 | 17.4k | 180.8k | 4.95M | 80 | 62k |
| 05-rack-assembly | 64 | 17.5k | 290.1k | 13.90M | 76 | 166k |
| 06-measure | 14 | 17.6k | 50.6k | 0.53M | 31 | 17k |

合计 ≈ **90.5M tokens**（按事件流逐笔累加；评分脚本按 run-record 汇总为 81.4M，差额来自重试轮与落盘时点）。

### 2. 结构：固定前缀 + 线性增长 = 二次总账

- **固定前缀 P ≈ 17.5–20.3k tokens/步**。其中 `request/header` 实测 **65.9 KB ≈ 18k tokens**（25 个 CAD 工具 + bash 等的完整 schema），system 消息仅 3 KB。
- **每步新增 g ≈ 2.5–5.4k tokens**（工具调用 JSON + 工具返回 + 助手消息）。
- 于是 `总消耗 ≈ N·P + g·N²/2`。实测校验：
  - 03：153×18k + 2.7k×153²/2 ≈ **34.3M**（实测 43.3M，差值为 9 次 LLM 重试与方差）；
  - 06：14×18k + 2.5k×14²/2 ≈ **0.50M**（实测 0.53M）。
- **结论：调用次数是平方项**。03 的 203 次调用换来的不是 203 倍单次成本，而是 ≈2.7 万 token/次的边际。

### 3. 上下文里到底装了什么（会话记录逐类字节，03 为例）

| 类别 | 字节 | 占助手内容 | 说明 |
|---|---|---|---|
| `reasoning`（思考） | 638 KB | **76%** | 平均每条 5.1 KB ≈ 1.5k tokens，**且随历史累积重发** |
| `tool-call`（调用参数 JSON） | 190 KB | 23% | 203 次调用，参数即几何代码片段 |
| `text`（正文） | 11 KB | 1% | 最终回答很短 |
| `tool/result`（工具返回） | 267 KB | — | 含 5 次 skill 全文加载（≈50 KB）与 bash/validate/printability 报告 |

其他题同口径：02 reasoning 75%、05 **87%**、04 84%。**助手内容里 3/4 以上是模型自己的思考**。

### 4. 工具返回的体量排行（事件流下界，8 KiB 截断）

| 题 | 结果合计 | Top 来源 |
|---|---|---|
| 03 | 109 KB / 203 次 | skill 33 KB×5、bash 21 KB×46、generate_part 16 KB×50、validate_assembly 8 KB×9、check_printability 7 KB×21 |
| 02 | 118 KB / 152 次 | skill 29 KB×5、bash 18 KB×27、check_printability 17 KB×12、simulate_physics 8 KB×13 |
| 04 | 125 KB / 80 次 | **web_fetch 43 KB×21**、skill 25 KB×4、list_features 17 KB×3 |
| 05 | 110 KB / 76 次 | **run_python 47 KB×18**、skill 17 KB×3、list_features 16 KB×2、measure_section 13 KB×6 |
| 01 | 56 KB / 47 次 | bash 18 KB×10、skill 17 KB×3 |

### 5. 静态开销（与模型行为无关、每题都付）

- **工具 schema 65.9 KB ≈ 18k tokens/次请求**。25 个 CAD 工具，最大 `simulate_stress` 6.8 KB、`simulate_motion` 4.1 KB、`simulate_physics` 3.0 KB。
- **五本 skill 合计 50.2 KB ≈ 14k tokens**：`cad-toolbox` 20.1 KB、`cad-manufacturing` 10.7 KB、`cad-simulation` 9.6 KB、`cad-modeling-measure` 5.6 KB、`cad-assembly` 4.4 KB。实测每题加载 2–5 本（02/03 全加载）。
- 对短题这是大头：06 的 0.53M 里有 **48% 是 14 步 × 18k 的工具 schema 重读**。

### 6. 行为性浪费（可立刻改）

- **预算没被强制执行**（仅评测护栏，不属于全场景杠杆）：02 用 124/120、03 用 203/150、04 用 80/60 全部超预算，runner 只记录不拦截。它不改变任何真实会话的成本，因此本轮**不作为降本措施**，只作为"这些数字里有超支"的读分说明。
- **重试**：03 有 9 次 `llm/retry`，每次都重发当前上下文。
- **反复重跑同一验证**：02 流体跑 r001–r018（18 次）、05 `run_python` 18 次、04 `web_fetch` 21 次（题目并未要求联网）。
- **skill 全文重复进入上下文**：每题 2–5 次加载，每次 4–20 KB。
- **上下文压缩（compaction）在成本最高处反复发生**：按 `step_end` 上下文的断崖式回落计，02 触发 **4 次**、05 **2 次**、03 **1 次**（04/01/06/01b 为 0）。压缩本身是一次"把全量历史交给模型重写"的调用，且压缩后细节丢失、模型往往要重新测量/重跑，进一步推高调用数——02 的 4 次压缩正好对应它 24.1M 的账单。

### 7. 关键机制：dsh/pi-ai **主动回填**历史 reasoning（代码证据）

"reasoning 被反复重发"不是猜测，是 dsh 现版本的既定行为。沿调用链读本机安装的代码：

1. **Harness 层**：`@deepseek-ai/dsh-llm-pi-ai/lib/index.js`
   - `foreignAssistant()` L153-156：把 Harness 的 `reasoning` 块映射成 pi-ai 的 `thinking` 块；
   - `replayedAssistant()` L196-202：回放时连 `thinkingSignature` 都原样带回。
2. **pi-ai 层**：`@earendil-works/pi-ai/dist/api/openai-completions.js`
   - L412-419：流式响应里发现的 reasoning 字段名（`reasoning_content` / `reasoning` / `reasoning_text`）被记成 thinking 块的签名；
   - `convertMessages()` L996-1007：组装历史 assistant 消息时执行 **`assistantMsg[signature] = 全部 thinking 文本`**——上一轮的思考被塞进本次请求的 `reasoning_content` 字段；
   - L1219-1222：`zai-coding-cn` 被识别为 zai，走的正是这条 openai-completions 路径；
   - L1268-1269：zai 的 compat 为 `requiresThinkingAsText: false`、`requiresReasoningContentOnAssistantMessages: isDeepSeek`（zai = false）——所以不是拼进正文，而是走 `reasoning_content` 字段回传。
3. **为什么这样设计**：Anthropic 家族的 thinking 块带签名，续 tool-use 时**必须**原样回传，否则请求失败；pi-ai 用一条统一路径覆盖所有 provider，于是 OpenAI 兼容端（GLM/zai、DeepSeek、Qwen…）**本不需要回传，也被一起回传了**。

实测指纹（02 早期步骤）：

```
step1 ctx 18,093            （固定前缀）
step2 output 64,754         ← 模型一次写出整份 OpenSCAD 脚本
step3 ctx 94,327（+65,227） ← 上一轮输出原样变成历史
step4 ctx 96,679（+2,352）  ← 正常步增量 ≈ reasoning 1.5k + 工具返回
```

推论：03 的 reasoning（638 KB ≈ 182k tokens）约占其峰值上下文 442k 的 **41%**；若历史 reasoning 不回填，03 的峰值应在 ~260k 量级。

**因此 P1 不是"重复 dsh 已有的能力"，而是补一项 dsh 有意未做的选择性**。落地有两条路：

| 路径 | 做法 | 代价 / 风险 |
|---|---|---|
| 上游（根因） | 在 pi-ai 的 model compat 里加 `replayHistoryReasoning: false`，或按 provider 家族默认关 | 要改 dsh 的上游包，本仓库管不到 |
| 本地（现在可做） | 插件注册持久化投影 `cad/reasoning-elision`：历史 assistant 消息去掉 `reasoning` 块、保留 `text`+`tool-call`；块数与 replay 元数据不匹配会让 `toPiAssistant()`（L246-258）降级走 `foreignAssistant()`，于是不再发 `reasoning_content` | 不碰 node_modules；需按 provider 家族判定（OpenAI 兼容系剥离，Anthropic 系保留回放） |

开关建议 `elideHistoricalReasoning: "auto"`（auto = 按 provider 家族判断），验证用 06 跑 A/B：①无 400/签名错误 ②tool-call 连续性正常 ③P/S 不掉 ④token 降幅符合预期。

## 分析（哪一刀最值）

以 03 为基准（N=153, P=18k, g=2.7k → 34~43M）：

| 措施 | 参数变化 | 预估总量 | 相对现在 |
|---|---|---|---|
| 现状 | N=153, g=2.7k | 34–43M | — |
| A. 结构性减少调用到 100（批量工具 + 纯工具去重） | N=100 | ≈15.3M | **−60%** |
| B. 历史 reasoning 不回填（provider 感知：OpenAI 兼容系关、Anthropic 系留） | g≈1.5k | ≈20.3M | **−45%** |
| C. 压工具返回（摘要+落盘路径，只回 digest） | g≈1.2k | ≈17.5M | −52% |
| D. skill 瘦身 50→20 KB + 按需加载 | g≈1.3k | ≈18.5M | −49% |
| E. 工具 schema 分任务裁剪（65.9→35 KB） | P≈10k | ≈29M | −25% |
| F. 减少 compaction（A+B+C 落地后上下文变短，自然下降） | 02 的 4 次→0~1 | 省 15–25% | −20% |
| **A+B+C 组合** | N=100, g=1.0k | **≈6.8M** | **−80%** |

- H1 成立：cacheRead 占 90–98%，output 只占 4–6%。
- H2 部分成立：工具返回只占助手内容之外的一小块（≈20%），**真正的大头是模型自己的 reasoning 被反复重发**——这是本轮最反直觉的发现。机制已定位到代码（§7）：pi-ai 为兼容 Anthropic 的签名 thinking，统一把历史 thinking 回填到 `reasoning_content`，OpenAI 兼容端也一起付了这份钱。
- H3 成立：二次项主导，所以"少调用"比"少读手册"见效快一个量级。

## 遇到的问题

- 服务端 5 小时配额上限（429 code 1308）在本轮触发两次，两次都用"中性续跑消息"从断点恢复；续跑段上下文含中断前的全部历史，token 照常累积。
- `tool_result` 事件 8 KiB 截断导致工具返回体量只能取**下界**；真实值需从会话记录字节数换算。
- `/tmp` 运行根被机器重置清空两次，第二次起改用 `~/bench-runs/` 持久化。

## 产物列表

**代码与脚本：**
- `examples/bench/tools/bench-run.mjs` —— 测评 runner（本轮修复 `stdio:'inherit'` 下 `child.stdout` 为 null 的误报）
- `examples/bench/tools/bench-score.mjs` —— 六列机检
- `examples/bench/tools/build-manual-manifest.mjs` / `render-manual-scoring.py` —— 人工评分证据 → 长图
- `examples/bench/tools/merge-resume.mjs` —— 配额中断续跑的事件合并
- `examples/bench/tools/write-score-file.mjs` —— README §8 字段的正式分数文件

**数据：**
- 事件流：`~/bench-runs/<题>-glm53-high/*.events.jsonl`（03/02/04/05）与 `examples/bench/graders/<题>/scores/glm53-high-r1.events.tgz`（01/01b/06 归档）
- 会话记录：`~/.dsh/sessions/--home-songsenand-bench-runs-*-glm53-high--/*/session.v4.jsonl.zstd`
- 分数：`examples/bench/graders/RESULTS-20261018-glm53-high/*.score.json`
- 长图：`examples/bench/graders/RESULTS-20261018-glm53-high/01-评分与token总览.png`、`02-人工评分证据.png`
- 诊断图：`examples/bench/graders/RESULTS-20261018-glm53-high/03-token诊断图.png`（每步上下文增长曲线 + 各题累计）

**运行命令：**
```bash
node examples/bench/tools/bench-run.mjs --level 03-microscope --variant headless \
  --model zai-coding-cn/glm-5.3-flash --reasoning-effort high --tag glm53-high \
  --root-dir ~/bench-runs/03-microscope-glm53-high
node examples/bench/tools/bench-score.mjs --run ~/bench-runs/03-microscope-glm53-high
```

**环境依赖：** Node 26、dsh 0.2.0-rc.2、OpenSCAD、python runtime（venv 由 `--require-hashes` + aliyun 镜像重建）

## 结论与下一步

**结论**：token 成本 ≈ `N·P + g·N²/2`，其中二次项由**调用次数**驱动、线性项由**模型 reasoning 重发**主导。当前 81–90M/7 题不是"评测太贵"，而是"每轮都在为历史思考与重复验证付几何级利息"。

**按优先级执行（预期 −60%~−80%）**：

> **口径修正（2026-10-20）**：原先列的"bench 侧硬预算强制"（超过 rubric 预算即杀进程）**已撤回**——它只服务于评测护栏、不改全场景成本，而且会让"能否交卷"变成变量。下面全部是**任何会话都吃到**的改造。

1. **历史 reasoning 不回填**（最大单项，≈−40%）：机制见 §7——dsh 现版本通过 pi-ai 把历史 thinking 回填进 `reasoning_content`，OpenAI 兼容端本是纯浪费。落法二选一：①上游给 pi-ai 的 model compat 加 `replayHistoryReasoning: false`（根因修复，需改上游包）；②插件注册持久化投影 `cad/reasoning-elision`，借既有 `toPiAssistant()` 降级路径实现，不碰 node_modules。开关 `elideHistoricalReasoning: "auto"`（OpenAI 兼容系剥离、Anthropic 系保留签名回放）。**验证**：06 跑 A/B，确认无 400/签名错误、tool-call 连续、P/S 不掉。
2. **大结果落盘、只回 digest**（工具实现侧）：`validate_assembly`/`check_assembly`/`list_features`/`check_printability`/`run_python` 默认返回"计数 + 首条问题 + 文件路径"，全量 JSON 落盘；需要细看时再 `read`。预期 g 降 30–50%。
3. **纯工具去重**（插件执行层）：`key=(tool, 规范化参数, 工程修订号)`，命中只回摘要并记 `cache_hit`；只覆盖确定性工具。02 的流体 18 连跑、03 的 `check_printability` 21 次是现成试验场。
4. **skill 瘦身与按需加载**：50 KB → ≤20 KB；手册"路由页"与"细节页"分开，细节只在对应工具首次失败时加载。
5. **工具 schema 精简**：描述改"是什么 + 何时用 + 边界"，长说明挪进 skill/docs；65.9 KB → ~40 KB（P 从 18k 降到 ~11k），短题受益最大。
6. **批量工具**（工具面扩容 `generate_parts`/`measure_batch`/`render_views`/整机 `check_printability`）：结构性削减 N，但会改 SUT 工具表，须重录基线，放最后。
7. **基准纪律**：换模型对比先 N=1 看方向，N=3 只对差异明显的题补；把 `tokens/toolCall` 与 `tokens/resolved` 作为与 P/S 并列的公布指标——否则"哪个模型好"会被"谁更烧 token"掩盖。

**下一步**：先做 1（06 上跑 A/B 验证 provider 行为）与 2（工具返回 digest，06/01 可立即验证），预计 06 从 0.53M 降到 ~0.3M、01 从 3.1M 降到 ~1.2M；3 在 02 上验证去重命中率。三件稳定后再动 4/5（需重录 SUT 基线），最后才评估 6。
