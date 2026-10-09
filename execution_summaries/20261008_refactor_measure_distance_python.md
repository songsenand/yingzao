# 执行摘要：measure_distance 迁移到 Python（批次 1 第五个，批次 1 收尾）

## 动机
> 判据「能迁就迁 Python」。`measure_distance` 是批次 1 的最后一件：吸附求解（精确最近点 +
> 命中三角面法线定内外）是纯领域计算，`accept-measure.mjs` 可回归。

## 影响范围
> - `dsh-cad-harness/python/cad_worker/worker.py`：新增 `measure_distance` op +
>   `_snap_to_surface`
> - `dsh-cad-harness/src/host/tools.ts`：`measure_distance` 工具改为 worker 调用；
>   datum 解析、警告文案、datum 侧后处理不变；`measure.ts` 的 `measureDistance` 保留为 oracle
> - `dsh-cad-harness/scripts/accept-measure-distance-parity.mjs`（新增 parity 验收）
> - 文档：矩阵 row 11 与批次 1、DESIGN §26.4

## 具体操作步骤
> 1. `worker.py` 新增 `_snap_to_surface`：`ProximityQuery.on_surface` 拿最近点与**命中三角面 id**，
>    用法线算几何法线，`(p − snapped)·n > 0` 判内外（与 TS 的 `snapToSurface` 同法）。
> 2. 新增 `measure_distance`：两侧各自吸附（可分别关闭）→ 距离与 dx/dy/dz（保留 4 位）→
>    吸附距离、内外标志；**顺带回传严格水密标志**（TS 侧原本为此单独解析一遍网格）。
> 3. `tools.ts`：datum 解析保持原样（datum 点精确、不吸附）；`snapRaw` 与 datum 组合逻辑不变；
>    水密警告文案逐字保留；datum 侧把吸附距离置 0、内外置 false 的后处理不变。
> 4. 新增 `scripts/accept-measure-distance-parity.mjs`：6 个用例对拍全字段 + 显式平局用例 +
>    严格水密反证用例 + 真实零件用例。

## 预期风险与验证
> - **风险点 1：并列最近点导致的"看起来不一致"。** 立方体正中心到六个面都是 10 mm，
>   three-mesh-bvh 取 −Z 面、trimesh 取 −X 面——两个都正确，但派生出的坐标与距离不同。
>   处理：验收里**显式**保留这个用例，断言"吸附距离一致 + 内外判定一致 + 两个点都在曲面上"，
>   坐标差异打印出来；同时把常规用例换成**最近面唯一**的点，避免用平局掩盖真问题。
>   （踩坑：第一版我把 `[1,1,1]` 当"非对称点"，其实它到 +X 与 +Z 面都是 9 mm，仍是平局。）
> - **风险点 2：水密标志被换成 trimesh 的宽松版**（会silence"开口面吸附不可靠"的警告）。
>   验证：绕向翻转的立方体——严格判据 false、trimesh true，两侧断言。
> - **风险点 3：把亚毫秒操作的比值当性能结论。** 实测 Python 0.6–3.0 ms vs TS 0.1–0.6 ms
>   （比值 5–8.7×），绝对差 1–3 ms/次（含 worker 每次重新读盘建索引）。已在矩阵里写明
>   "比值意义有限"。验收脚本加了热身调用，否则首次调用会把 trimesh 导入（约 0.3 s）算成 165×。
> - **验证方式：**
>   ```bash
>   cd dsh-cad-harness
>   export DSH_CAD_PYTHON_ROOT=$PWD/../.tmp-measure-runtime
>   node scripts/accept-measure-distance-parity.mjs --runtime $DSH_CAD_PYTHON_ROOT  # 全过
>   node scripts/accept-measure.mjs        # oracle 侧回归
>   node scripts/accept-p1.mjs accept-m2.mjs accept-import.mjs accept-connectivity.mjs
>   node scripts/accept-python-worker.mjs --runtime $DSH_CAD_PYTHON_ROOT
>   node_modules/.bin/tsc --noEmit && node esbuild.mjs
>   ```
> - **已知覆盖缺口**：`accept-measure.mjs` 直接调用 `measureDistance`（oracle），因此工具级
>   路径（datum 解析 → worker → 警告 → 后处理）由本 parity 脚本 + "除调用点外未改动"来保证；
>   工具级端到端留给后续补一个带项目库的验收。
