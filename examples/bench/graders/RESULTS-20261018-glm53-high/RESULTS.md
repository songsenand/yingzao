# 测评结果 · zai-coding-cn/glm-5.3-flash · high · headless 档（2026-10-19/20）

> 本轮跑法：`dsh --profile headless` + `examples/bench/tools/bench-run.mjs`，模型与当前会话同档
> （`zai-coding-cn/glm-5.3-flash`，`reasoningEffort: high`），N=1。
> 00-smoke 全绿（13 硬门 + 6 数值，2026-10-18 16:21）后才开跑。
> **03-microscope 未完成**：A 段 203 次调用后撞上服务端 5 小时配额上限（429），B 段未跑，本轮不计分。

## 一、评分总表（六列里可机检的三列）

| 题目 | P 通过 | S 生效度 | 工具调用/预算 | 墙钟/预算 | totalToken | cacheRead | output |
|---|---|---|---|---|---|---|---|
| 01-mortise-bench | **0** | 0.5 | 47/60 | 28/45min | 2.99M | 2.79M | 81k |
| 01b-diagnosis | **0** | —（S0 已加载） | 11/12 | 6.5/15min | 0.54M | 452k | 17k |
| 02-steam-engine | **0** | 0.929 | 124/120 | 123/120min | 17.74M | 16.45M | 186k |
| 03-microscope | —（未完成） | — | 203/150 | 183/150min | 43.34M | 42.67M | 256k |
| 04-rack-connector | **0** | 0.929 | 80/60 | 40/40min | 4.95M | 4.69M | 83k |
| 05-rack-assembly | **0** | 0.545 | 68/70 | 76/45min | 11.32M | 10.33M | 162k |
| 06-measure | **0** | 1.0 | 31/40 | 6.5/25min | 0.53M | 478k | 16k |

合计 **81.41M tokens / 564 次工具调用**（含 03 中断前的消耗）；平均每次调用 ≈ 144k tokens。

E / H / R / C 四列需人工判，证据长图见
[`02-人工评分证据.png`](02-人工评分证据.png)（逐题：UNKNOWN/FAIL 判据原文 + 交卷回答全文 +
中间陈述 + 探针问答 + 机读文件片段）。

## 二、每题扣分明细

- **01-mortise-bench**：硬门 `g-undeclared-found` 不过（4 次检查的 undeclared 全空——故意不声明的
  0.4mm 让位间隙没被抓出）；数值判据失分 `c-shoulder-seats`(w3，肩面接口 0 条)、
  `c-protrusion`(w2，零 `measure_distance`，出榫 5mm 从未验证)、`c-measured-vs-datum`(w2，同上)。
  探针 `p-version-recall` 机检记 PASS（答案命中 30），但原答开头写 "**15 mm**"——建议人工复核。
- **01b-diagnosis**：硬门 `g-motion-never-checked` 不过（没点出"运动类接口 6 条从未被检查"）；
  两条语义项 `g-no-green-claim` / `g-distinguish-notdone-vs-failed` 与 `c-anchoring`（需两臂对照）
  记 UNKNOWN 待人工判。
- **02-steam-engine**：硬门 `g-merge-shells-one` 不过（最后一次合并 `shells=9`，历次 5/13/1/9，
  最终不是单一连通体）；数值判据 `c-fluid-arrival`(w2) 失分（到达率 0.1269 < 0.6）。
  其余全过：行程 40mm、关节漂移 0.0001、含 608.stl 导入尺寸 22×22×7。
- **04-rack-connector**：硬门 `g-assembly-run` 不过（4 次装配运行中有 1 次 fail）；数值判据
  `c-length`(w2，最长边 20.5mm 超出 10–18 接受带) 与 `c-not-a-copy`(w2，交付件尺寸与导入的
  同族接头逐位相同——**照抄同族接头**)。阴性对照 `g-negative-copy-fires` 正常命中，
  说明这条判据是有效的。
- **05-rack-assembly**：硬门 `g-verify-run`（3 次装配 r001 fail/r002 pass/r003 fail）与
  `g-merge-run`（只跑过 merge_parts、从未查连通体）不过；数值判据 `c-envelope`(w3，声明包络
  202.4×184.0×25 vs 参考 228.0×184×45，x/z 轴差超容差——**位姿摆错一个面**)、
  `c-no-interference`(w3，1.66mm³ 角部干涉)。
- **06-measure**：硬门 `g-no-invented-numbers`（`volumeDeltaMm3=564.578` 在任何工具返回里
  找不到——注意：若是两次数值相减的派生量则属正常，需人工复核）与 `g-delta-correct`
  （报 −2 vs 真值 1.000）不过。七项数值判据全过（壁厚/孔心距/夹角/对角长度/剖面面积均对）。
- **03-microscope**：未完成，不计分（A 段 203 调用后 429 中断；B 段未跑）。

## 三、token 消耗（每题，含中断前消耗）

| 题目 | calls | totalToken | cacheRead | output | tokens/次 | cacheRead 占比 |
|---|---|---|---|---|---|---|
| 01-mortise-bench | 47 | 2.99M | 2.79M | 81k | 64k | 93% |
| 01b-diagnosis | 11 | 0.54M | 452k | 17k | 49k | 84% |
| 02-steam-engine | 124 | 17.74M | 16.45M | 186k | 143k | 93% |
| 03-microscope（中断） | 203 | 43.34M | 42.67M | 256k | 213k | 98% |
| 04-rack-connector | 80 | 4.95M | 4.69M | 83k | 62k | 95% |
| 05-rack-assembly | 68 | 11.32M | 10.33M | 162k | 166k | 91% |
| 06-measure | 31 | 0.53M | 478k | 16k | 17k | 90% |

**消耗在哪**：90%–98% 是 cacheRead——每轮工具调用都要把「历史对话 + 工具返回 + 手册 + 图片」
重读一遍。三个放大器：① 调用次数（03 的 A 段 203 次）；② 大工具返回进上下文（03 共出 144 张
渲染图、02 的仿真 JSON、check_* 报告）；③ 长任务反复重试（流体/装配/打印性反复重跑，同一段
上下文重读多次）。输出 token 只占 4%–6%。想省 token：压调用次数、限制渲染图数量、大 JSON
落盘不进上下文。

## 四、本轮基础设施与纪律备注

- **SUT 已变化**：`SKILL.md` 由 375 行拆分为五本（当前 `cad-toolbox` 261 行，
  sha256 `857f3de6…`），基准表已重录（README §2）。因此**本轮分数与 10-12 及以前的分数不可比**。
- **03 卷已同步**：2026-10-18 定稿（反光镜改外购件 + 单一 M3 接口、删台下聚光镜）已同步进
  `TASK.headless.md`，两卷仍只差参考图送达方式两行；rubric 与 README 的 sha 已重录。
- **服务端配额**：zai-coding-cn 有 5 小时滚动用量上限（429 code 1308），本轮多次撞顶；
  02/05 经中性续跑消息从断点续跑完成（续跑消息只说明"基础设施中断"，不含题目提示），
  续跑段事件已拼接回 `TASK.events.jsonl`。
- **机器重置**：10-19 的两次机器重置清掉了 `/tmp` 运行根；01/01b/06 的事件与交付件已在
  重置前归档到 `graders/<题>/scores/glm53-high-r1.*`（本目录的评分即由归档重建）。
  02/04/05/03 改用 `/home/songsenand/bench-runs/` 下的持久运行根。
- **工具修复**：`bench-run.mjs` 的 `run()` 在 `stdio:'inherit'`（04/05 的 prep 路径）下
  `child.stdout` 为 null 会抛 TypeError 导致误报 "prep 失败"——已改为可选链。
- **00-smoke**：全绿（13/13 硬门 + 6/6 数值），但需要先把 python runtime venv 按新 lock 重建
  （pypi 直连过慢，改用 aliyun 镜像 + `--require-hashes` 完成，哈希仍由 lock 校验）。

## 五、待办

- **03-microscope 需补跑**（最贵的一题：上一轮 A 段就消耗 43.3M tokens；预算 150 调用/150min）。
- E/H/R/C 四列待用户打分回填（每题的分数文件在 `graders/<题>/scores/`，`columns` 字段预留）。
- 若要跨模型对比：先跑通 03，再按 `README §5` 的固定条件换模型重复（N≥3 才报中位数）。
