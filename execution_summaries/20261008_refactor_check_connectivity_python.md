# 执行摘要：check_connectivity 迁移到 Python（批次 1 第二个）

## 动机
> 判据「能迁就迁 Python」。矩阵里 `check_connectivity` 的实测是"Python 更快（1.7×）且
> 判定一致"，且它有一个**工具级验收**（`accept-connectivity.mjs`，带临时项目库并真的调用工具），
> 迁移后能立刻端到端回归——这是选它作为第二个的理由。

## 影响范围
> - `dsh-cad-harness/python/cad_worker/worker.py`：新增 `connectivity` op + `_is_watertight`
> - `dsh-cad-harness/src/host/tools.ts`：`check_connectivity` 求解改为 worker 调用
> - `dsh-cad-harness/scripts/accept-connectivity-parity.mjs`（新增 parity 验收）
> - `docs/TOOL-RUNTIME-MATRIX.md`（row 8 与批次 1）
> - **未受影响**：工具名/schema/输出形状不变；`mesh.ts` 的 `connectedBodies`/`isWatertight`
>   保留（其他工具与 oracle 仍在用）。

## 具体操作步骤
> 1. `worker.py` 新增 `connectivity`：`trimesh.graph.face_adjacency` + `connected_components`
>    取得**按共享边**的连通块（只共顶点不算连通，与 TS 的并查集判据一致）；每块用
>    `np.unique` 取包围盒，min/max 各保留 3 位小数（与 TS 的 `toFixed(3)` 对齐）。
> 2. **体序还原**：TS 按 `(dx*dy)` 降序排序（Array.sort 稳定 ⇒ 平局保持首次遇到的顺序）。
>    Python 侧按 `(-面积, 首个三角形下标)` 排序，保证与 TS 的体序一致——因为
>    `bodySizes`/`bodyCenters` 是按体序输出的，顺序属于输出契约。
> 3. **水密判据照搬 TS 的严格版本**（`_is_watertight`，numpy 向量化）：每条有向边恰好出现
>    一次，且其反向边存在。**没有**改用 trimesh 的 `is_watertight`（只数无向边共享）。
>    这一点是本次迁移最容易悄悄走样的地方，所以验收里放了反证用例。
> 4. `tools.ts`：求解换成 worker；`verdict`/`size`/`center` 的取整与拼接保持原样；
>    版本文件缺失时的报错文案不变。
> 5. 新增 `scripts/accept-connectivity-parity.mjs`：语料网格对拍（体数/体序/包围盒/水密/
>    三角数）+ 三个人造反例（绕向翻转、只共顶点、开口曲面），并显式证明 trimesh 自己的
>    水密判据会把绕向翻转的立方体误判为水密。

## 预期风险与验证
> - **风险点 1：连通判据被"升级"成按顶点相邻。** 验证：只共顶点的两个立方体在两侧都必须
>    是 **2 块**（TS 2 · py 2 ✅）。
> - **风险点 2：水密判据被换成 trimesh 的宽松版本（会少报问题件）。** 验证：绕向翻转的
>    立方体两侧都判 **不水密**，而 trimesh 自己判水密——反证用例显式断言了这个差异。
> - **风险点 3：体序变化导致 `bodySizes` 顺序变化。** 验证：语料网格逐体比对 min/max 与顺序
>    （整机 26 体、上半机 26 体，全部一致）。
> - **风险点 4：性能回退。** 验证：热身后 0.68×/0.74×/0.76×（TS 92/72/6 ms → Python 62/53/5 ms），
>    Python 更快；验收脚本内加了热身调用，否则首次调用会把 trimesh 导入时间算进对比。
> - **验证方式：**
>   ```bash
>   cd dsh-cad-harness
>   node scripts/accept-connectivity-parity.mjs --runtime ../.tmp-measure-runtime  # 21/21
>   DSH_CAD_PYTHON_ROOT=../.tmp-measure-runtime node scripts/accept-connectivity.mjs  # 工具级 12/12
>   node scripts/accept-python-worker.mjs --runtime ../.tmp-measure-runtime       # 8/8
>   node scripts/accept-tool-scope.mjs && node esbuild.mjs
>   ```
