# 执行摘要：measure_closest 迁移到 Python（批次 1 第一个）

## 动机
> 判据是「能迁就迁 Python」，而 `measure_closest` 是矩阵里证据最足的一个：加 `rtree` 后
> 精度与 TS 的 three-mesh-bvh 逐位一致（Δ=0），绝对耗时也在可接受范围。用户 2026-10-08
> 已批准 rtree 进锁与 batch 0（常驻 worker），前置条件齐备，于是把它作为第一个迁移的工具。

## 影响范围
> - `dsh-cad-harness/python/cad_worker/worker.py`：新增 `closest_mesh_mesh` / `closest_mesh_sphere`
>   两个 op + 包围盒下界剪枝
> - `dsh-cad-harness/src/host/tools.ts`：`measure_closest` 的求解改为 worker 调用；渲染与
>   警告文案不变；删除该工具对 TS 最近点函数的依赖
> - `dsh-cad-harness/src/host/measure.ts`：函数保留，**改作 parity 的 oracle**（见文件顶部注释）
> - `dsh-cad-harness/scripts/accept-measure-closest.mjs`（新增验收）
> - `docs/TOOL-RUNTIME-MATRIX.md`（row 12 与批次 1 状态）
> - **未受影响**：工具名/schema/输出形状不变；`measure_distance`、`validate_assembly` 仍走 TS。

## 具体操作步骤
> 1. `worker.py` 新增 `closest_mesh_mesh`：与 TS 参考同法（每侧至多约 20k 个顶点，精确投影到
>    另一侧，取全局最小；平局偏向 A 侧），返回 `{distanceMm, pointA, pointB, method, watertightA,
>    watertightB, queries, queriesWithoutPruning}`。
> 2. `worker.py` 新增 `closest_mesh_sphere`：中心一次精确投影；球心到命中点距离 ≤ 半径时报
>    `distanceMm: 0 / intersected: true`（与 TS 的规则一致），否则 `distC - radius`。
> 3. **剪枝（性能必需）**：实测发现朴素全量扫描在"点离目标很远"时退化——`trimesh` 的候选搜索
>    随距离变宽，每点约 0.45 ms，底座↔上半机因此要 **15 s**（TS 只要 141 ms）。改成：
>    用目标包围盒距离作**严谨下界**（曲面必在包围盒内），先取下界最小的 64 点做种子，再按
>    下界升序分块精确求值并剪枝。结果与全量扫描**在数学上等价**（下界已超过当前最优的点
>    不可能成为最小值），实测查询数从 14,404 降到 128。
> 4. `tools.ts`：把求解换成 `ensurePythonWorker()` + 两个 op；版本→路径仍是
>    `store.root/versions/<id>/model.stl`；watertight 警告文案逐字保留；渲染（OpenSCAD +
>    `ctx.attachments`）留在宿主侧。
> 5. 新增 `scripts/accept-measure-closest.mjs`：三用例与 TS oracle 对拍 + 球探针三分支
>    + **真实版本库布局下的解析真值**（1 mm 间隙、4 mm 球间隙、吞掉顶面报 0）。

## 预期风险与验证
> - **风险点 1：数值漂移。** 验证：三组真实网格上距离与 oracle **Δ=0**；解析真值 1.000 mm /
>    4.000 mm 也命中。
> - **风险点 2：平局时返回的最近点对与 TS 不同。** 这是剪枝带来的**已知且有意**的放松：
>    最小值唯一时点对完全一致（本次三个用例 Δ=0），存在多个并列最小点时返回其中任意一对
>    （旧实现返回扫描序里第一个）。验收因此断言"两点间距 == distanceMm 且其中一点是另一点
>    在对侧曲面上的精确投影"，而不是死比点坐标。
> - **风险点 3：远离目标的点导致性能悬崖。** 验证：剪枝后 15.0 s → 465 ms；三个用例耗时
>    1.02×/3.74×/8.91×（TS 侧 101/124/17 ms）。
> - **风险点 4：运行时不可用（`DSH_CAD_PYTHON=off`）。** 行为：`ensurePythonWorker` 抛出
>    "the bundled Python runtime is disabled (DSH_CAD_PYTHON=off)"，工具失败并明说原因
>    （不静默降级回 TS——那会让两条实现长期并存）。
> - **验证方式：**
>   ```bash
>   cd dsh-cad-harness
>   node scripts/accept-measure-closest.mjs --runtime ../.tmp-measure-runtime  # parity + 真值 24/24
>   node scripts/accept-python-worker.mjs  --runtime ../.tmp-measure-runtime  # 8/8（worker 回归）
>   node scripts/accept-m2.mjs            # validate_assembly 仍走 TS，回归通过
>   node scripts/accept-measure.mjs       # measure_distance 回归通过
>   node scripts/accept-tool-scope.mjs && node scripts/accept-python.mjs --quick
>   node esbuild.mjs
>   ```

## 补充：运行时未就绪时的快速失败（2026-10-08 同日）

`ensurePythonWorker()` 现在先查 `pythonRuntimeStatus()`，状态不是 `ready` 就立刻抛出可执行
指引（实测 3 ms），而不是触发 6–11 分钟的冷装后撞上工具的 60/180 s 超时。详见
`execution_summaries/20261008_refactor_check_connectivity_python.md` 的同名小节。
