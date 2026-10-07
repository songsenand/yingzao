# 02-steam-engine · 操作说明（**给操作者，不是考生题面**）

> **考生题面**：[`subjects/02-steam-engine/TASK.md`](../../subjects/02-steam-engine/TASK.md)
> —— 逐字作为首条消息发出，**不加、不改、不解释、不补充**。

## 开跑前

| 项 | 值 |
|---|---|
| cwd | `examples/bench/subjects/02-steam-engine/` |
| 预设 | 造物模式（**先设为默认预设再新建会话**） |
| 附件 | 无（导入件走工作区文件，不走对话附件） |
| 素材 | `subjects/02-steam-engine/assets/608.stl` —— **运行前生成一次** |
| 记录 | commit、`SKILL.md` sha256、**`TASK.md` sha256**（见 README §二） |

生成导入件（`assets/608.stl` 是生成物，不入库）：

```bash
cd examples/bench/graders/02-steam-engine/assets
OPENSCADPATH=<repo>/lib openscad -o ../../../../subjects/02-steam-engine/assets/608.stl make-608.scad
```

考卷里写的是相对路径 `assets/608.stl`，相对 cwd 解析，所以位置必须对。

## 判据与答案

- 机检细则：`rubric.json`（10 硬门 / 8 数值 / 4 特征 / 1 探针）
- 参考解、解析值与三处"表达不了"：`key.md`
- 夹具说明：`assets/README.md`

## 本卷特别注意

1. **考卷刻意不给"流体与刚体不耦合"这个答案**——它只给了一句
   "如果这个工具表达不了你想要的工况，直说表达不了以及为什么"。
   所以 `g-no-false-coupling` 与 `f-fluid-scope-honest` 是**能力项**（`inSkill: false`），
   不要用 `SKILL.md` 里那句 "Fluid–structure coupling does not exist" 去替模型开脱：
   手册确实有这句，但**手册有没有生效**正是 `S` 列在量的东西。
2. 两份机读产物：工作目录下的 **`motion.json`** 与 **`stability.json`**（考卷给了格式）。
3. **阴性对照三条**：连杆孔中心距 97mm 必报干涉；进汽口壁 0.8mm 必被
   `check_printability` 抓到；十字头不给摩擦参数时，考卷要的是模型**认不认得出来
   那个结论不能用**，不是要它报错。
4. 流体那一步是分钟级，`budget.wallClockMin = 120` 主要花在那儿。
   若因超时跳过，`c-fluid-arrival` 记 `skip` 并在结果里标注，**不要**记 0 分。
