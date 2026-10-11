# 06-measure · 操作说明（**给操作者，不是考生题面**）

> **考生题面**：[`subjects/06-measure/TASK.md`](../../subjects/06-measure/TASK.md)
> —— 逐字作为首条消息发出，**不加、不改、不解释、不补充**。

## 开跑前

| 项 | 值 |
|---|---|
| cwd | `examples/bench/subjects/06-measure/`（run root 由 `bench-run.mjs` 复制出去，**绝不在仓库内开会话**） |
| 预设 | 造物模式（**先设为默认预设再新建会话**） |
| 附件 | 无 —— 两个 STL 走工作区文件，不走对话附件 |
| 素材 | `subjects/06-measure/part.stl` 与 `part-b.stl`（**生成物，入库**；生成脚本与源码在评分方一侧） |
| 记录 | commit、`SKILL.md` sha256、**`TASK.md` sha256**、两个 STL 的 sha256（见 README §二） |

两个 STL 由评分方的源码生成，**源码与基准真值都留在评分方一侧**（`graders/06-measure/`）：

```bash
# 现场重画两件（源码在评分方一侧，不进考卷）
cd examples/bench/graders/06-measure
node build-parts.mjs                   # → ../../subjects/06-measure/{part,part-b}.stl

# 用真工具测基准真值（判据里的数字全部来自这里，不许推断）
export DSH_CAD_PYTHON_ROOT=<repo>/.tmp-measure-runtime
node ground-truth.mjs                  # → graders/06-measure/ground-truth.json + 人类可读清单
```

考卷里写的是相对路径 `part.stl` / `part-b.stl`，相对 cwd 解析，所以位置必须对。

## 这道题在考什么

它是**这一轮测量能力的验收台**：`list_features`（给"不是自己画的"几何提供坐标）、
`measure_thickness`（把"点必须精确落在面上"降级为"点落在该壁的投影范围内"）、
`measure_section`（把"在剖面上选两点"变成"不用选"）、`measure_extent`（任意轴起止）、
`measure_angle`（夹角三数齐给）。题面**不给图纸、不给参数**，所以只能量。

## 判据与答案

- 机检细则：`rubric.json`
- 基准真值与两件之间的差异：`ground-truth.json`（**判据与求值器都从这里取数**，
  避免同一个数字抄三处）
- 参考解、以及"哪些量工具本来就不该给"：`key.md`

## 本卷特别注意

1. **阴性对照就内建在题面里**：`part-b.stl` 相对 `part.stl` 只改一处，
   考生必须用**同一套测量口径**把两个版本的数都报出来。
   一个"靠看渲染猜数"或"抄一个像样的数字"的回答，会在第二件上原形毕露——
   所以 `g-delta-correct` 是硬门，不是加分项。
2. **`g-tools-not-bypassed` 与 `g-no-invented-numbers` 是因果门**：
   它们保证"答案来自工具返回"而不是来自模型先验或自己解析 STL 字节。
   这两条不过 → `P` 归零（`gatePolicy: any-fail => P = 0`）。
   题面已经**明说**要用工具量、并允许"量不到就说量不到"，所以这不是暗坑。
3. **角度约定**：`measure_angle` 同时返回 `angleDeg` / `acuteDeg` / `supplementDeg`。
   考生报哪个都可以，但**必须自己说清是哪个**（`angleConvention` 字段）。
   判据按它声明的口径核对——这是"数字对不上"最常见的来源，本题把它变成一条判据。
4. **`notMeasurable` 不是免死金牌**：把本该量得出来的量塞进这个数组，
   由 `f-not-measurable-honest` 人判；本条只奖励**真的**测不出来的量。
5. 本题**不需要渲染也能做完**，所以 `budget.images` 给得比 01/02/03 松得多的上限；
   考生若把预算花在看图上，`C` 列会记录但不算错。

## 记录

```
graders/06-measure/scores/<模型>-<时间戳>.json   { commit, skillSha256, taskSha256, partSha256, P/E/H/C/R/S, 未过条目 }
```

首次跑之前 `calibration` 是 `uncertain`；基线跑完后按实测改阈值并把
`calibration` 改成 `calibrated`（README §二）。
