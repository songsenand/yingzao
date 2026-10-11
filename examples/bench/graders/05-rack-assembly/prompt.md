# 05-rack-assembly · 操作说明（**给操作者，不是考生题面**）

> **考生题面**：[`subjects/05-rack-assembly/TASK.md`](../../subjects/05-rack-assembly/TASK.md)
> —— 逐字作为首条消息发出，**不加、不改、不解释、不补充**。

## 开跑前

| 项 | 值 |
|---|---|
| cwd | `subjects/05-rack-assembly/`（run root 由 `bench-run.mjs` 复制出去，**绝不在仓库内开会话**） |
| 预设 | 造物模式 |
| 附件 | 无（两件 STL 走工作区文件） |
| 素材 | `xBar.stl` + `yBar.stl` —— **由 `bench-run` 的 `prep` 现场物化**（第三方几何不入库） |
| 记录 | commit、`SKILL.md` sha256、`TASK.md` sha256、两件 STL 的 sha256（`MATERIALIZED.json`） |

`bench-run --level 05-rack-assembly` 会先跑
`graders/05-rack-assembly/materialize.mjs --out <run-root>`（钉 commit + 全树摘要校验 + 编译）。
手动复核（含评分方参考装配）：

```bash
export DSH_CAD_PYTHON_ROOT=<repo>/.tmp-measure-runtime
node examples/bench/graders/05-rack-assembly/materialize.mjs --out <dir> --with-reference
node examples/bench/graders/05-rack-assembly/measure-05.mjs --parts <dir>
node examples/bench/graders/05-rack-assembly/self-check.mjs
```

## 这道题在考什么

**装配**：两件都只有 STL，配合关系只能从几何（导槽、齿、螺孔、平行面）**量**出来。
合法位姿**唯一**，所以"装没装对"是可以机检的——但判据看的是**关系**（包络、干涉、
连通体），不是"像不像参考图"。

## 判据与答案

- 机检细则：`rubric.json`（7 硬门 / 4 数值 / 3 特征）
- 参考包络与三条判据的理由：`ground-truth.json`
- 参考装配长什么样、以及"差一点就错"的对照表：`key.md`

## 本卷特别注意

1. **阴性对照是"两件都留在原点"**（最常见的偷懒）：`g-pose-not-trivial` 直接点名，
   `c-envelope` 用参考包络把它判掉，而 `g-negative-control-fires` 由真值自证
   "原点包络至少在 x/z 轴上落在容差外"。**注意 y 轴本来就相同**（沿该方向滑动不改变
   包络）——所以判据是"至少一个轴越界"，不是"三个轴都不同"。
2. **绝对原点不算判据**：整体平移是合法的，只比三个方向的**尺寸**。
3. **`g-merge-run` 是因果门**：`merge_parts` 与 `check_connectivity` 都要真的调过——
   "连成一体"是一次调用，不是一句话。
