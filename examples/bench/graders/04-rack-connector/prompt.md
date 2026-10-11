# 04-rack-connector · 操作说明（**给操作者，不是考生题面**）

> **考生题面**：[`subjects/04-rack-connector/TASK.md`](../../subjects/04-rack-connector/TASK.md)
> —— 逐字作为首条消息发出，**不加、不改、不解释、不补充**。

## 开跑前

| 项 | 值 |
|---|---|
| cwd | `subjects/04-rack-connector/`（run root 由 `bench-run.mjs` 复制出去，**绝不在仓库内开会话**） |
| 预设 | 造物模式（**先设为默认预设再新建会话**） |
| 附件 | 无（两件 STL 走工作区文件） |
| 素材 | `mainRail.stl` + `rackJoiner.stl` —— **由 `bench-run` 的 `prep` 现场物化**（第三方几何不入库） |
| 记录 | commit、`SKILL.md` sha256、**`TASK.md` sha256**、两件 STL 的 sha256（`MATERIALIZED.json` 里有） |

`bench-run --level 04-rack-connector` 会自动先跑：

```bash
node examples/bench/graders/04-rack-connector/materialize.mjs --out <run-root>
```

它钉死 upstream commit（`jazwa/rackstack` @ `8e296e93…`，MIT），校验**全树 100 个
`*.scad` 的字节序摘要**与逐文件 sha256，再编译出两件 STL。prep 失败即中止这一轮——
宁可不开跑，也不让模型在空目录里找零件。手动复核（含评分方参考解）：

```bash
export DSH_CAD_PYTHON_ROOT=<repo>/.tmp-measure-runtime
node examples/bench/graders/04-rack-connector/materialize.mjs --out <dir> --with-reference
node examples/bench/graders/04-rack-connector/measure-04.mjs --parts <dir>   # 重录 ground-truth.json
node examples/bench/graders/04-rack-connector/self-check.mjs                 # 机检自检（不调模型）
```

## 这道题在考什么

**逆向 + 补全**：给定件只有 STL（没有图纸/源码/参数表），配合尺寸只能**量**出来。
同族的 `rackJoiner` 是现成参照——它就是同一套配合的另一个接头。判据按**功能**
（装得上、锁得住、印得出），不要求复刻原件。

## 判据与答案

- 机检细则：`rubric.json`（6 硬门 / 6 数值 / 3 特征）
- 基准真值与接受带的理由：`ground-truth.json`（每个数字都记了 op/参数/原始返回）
- 参考解、"差一点就错"的对照表、以及**参考件长什么样**：`key.md`

## 本卷特别注意

1. **阴性对照就内建在题面里**：两件 STL 都在考生手上，"导入一件改名就交"是最省事的
   蒙混。所以 `c-cross-section` / `c-length` / `c-not-a-copy` 三条会把复制品判掉，
   而 `g-negative-control-fires` 把"照抄必被拒"本身变成可机检的事实。
2. **`g-tools-used` 是因果门**：尺寸必须来自测量（`list_features`/`measure_*`），
   形状必须来自建模（`generate_part`）。题面已明说要用工具量。
3. **判据与朝向无关**：交付件的三个尺寸排序后取中间两个判截面、最长边判长度——
   考生横着画还是竖着画都判得一样。
4. **没有交付件时，尺寸类判据记 `unknown`**（"没法判"≠"判它错"），扣分由
   `g-new-part-version` 那条硬门负责。
5. 这一卷**看图不是必需的**，`budget.images` 只给 12。
