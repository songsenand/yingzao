# 01-mortise-bench · 操作说明（**给操作者，不是考生题面**）

> **考生题面**：[`subjects/01-mortise-bench/TASK.md`](../../subjects/01-mortise-bench/TASK.md)
> —— 逐字作为首条消息发出，**不加、不改、不解释、不补充**。

## 开跑前

| 项 | 值 |
|---|---|
| cwd | `examples/bench/subjects/01-mortise-bench/` |
| 预设 | 造物模式（**先设为默认预设再新建会话**） |
| 附件 | 无 |
| 素材 | 无（考卷自带全部尺寸） |
| 记录 | commit、`SKILL.md` sha256、**`TASK.md` sha256**（见 README §二） |

## 判据与答案

- 机检细则：`rubric.json`（9 硬门 / 8 数值 / 3 特征 / 1 探针）
- 参考解与语义依据：`key.md`

## 本卷特别注意

1. **这是木工件，不是打印件。** 考卷没有要求 `check_printability`；若模型主动去跑，
   不扣分，但**不要**把它当成判据项。
2. 唯一要求的机读产物是工作目录下的 **`joinery.json`**（考卷里给了格式）。
   `c-across-grain-looser` 也就是本题的核心考点——**横纹方向的间隙必须大于顺纹**——
   从这个文件读。
3. **阴性对照**：榫头厚 +0.5mm 必须报 hard-violation，改回必须回 pass。
   两条都要在 transcript 里看到。
4. 多实例判据：4 条腿必须是**同一个版本**，不是 4 个近似件。
