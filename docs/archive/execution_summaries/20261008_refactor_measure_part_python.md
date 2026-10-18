# 执行摘要：measure_part 迁移到 Python（批次 4 前的清尾）

## 动机
> 判据"能迁就迁"。`measure_part` 是纯几何领域计算（Manifold 体积/亏格 + 三角面面积 +
> 体积加权质心 + 包围盒 + 水密），零平台依赖，属于最该搬的一类。

## 影响范围
> - `dsh-cad-harness/python/cad_worker/worker.py`：新增 `measure_part` op（+ `_round3`）
> - `dsh-cad-harness/src/host/inspect.ts`：原 `measureVersion` 更名 `measureVersionInTs`
>   （oracle），新增转发版 `measureVersion`（按**路径**读仓库里的 STL，不复制字节）
> - `dsh-cad-harness/scripts/accept-measure-part-parity.mjs`（新增验收）
> - 文档：矩阵 row 10

## 具体操作步骤
> 1. Python 侧逐行镜像 `measureVersion`：焊接（与 TS `MeshBuilder` 同 key、同首现顺序）→
>    Manifold（`merge()` 后构造）→ 三角面叉积求面积 → 有符号四面体和求质心 →
>    包围盒 / 水密 / 三角数 / 体积 / 亏格。
> 2. **`-0` 归一化照搬**：对称件的质心坐标会舍入到 `-0`，而 `JSON.stringify(-0)` 是 `"0"`，
>    曾让工具结果过不了宿主"无损 JSON"检查 —— 于是 `measure_part` 对**每个对称件**都失败。
>    `_round3` 保留了这个修正。
> 3. **Manifold 构造是有效性闸门**：TS 版在非流形输入上会**抛异常**；Python 绑定不抛，
>    所以显式检查 `status() != Error.NoError` 并报错 —— 否则坏网格会报出一个看着合理的体积。
> 4. 工具的 schema、超时、渲染一律不动。

## 预期风险与验证
> - **风险点：数值必须逐位相同**（同一算法 + 同一个 Manifold 库，不是"引擎版本差异"场景）。
>   验证：`accept-measure-part-parity.mjs` 对 5 个件逐字段 `JSON.stringify` 相等，**全过**：
>   立方体 8000 mm³、带通孔板（亏格 1）、两个分离壳（亏格 -1）、球（质心 `-0` 陷阱）、
>   **真实件 整机.stl（28,830 面，体积 710012.998 mm³、亏格 -2、质心 [-0.002,33.372,108.507]）**。
> - **风险点：坏网格被"修好"**。验证：单三角形"实体"在两侧都必须失败（TS true · py true）。
> - **风险点：调用方回归**。验证：`accept-inspect` PASSED、`accept-import` ALL PASS、
>   `accept-measure` / `accept-tool-scope` OK。
> - 无性能争议（单次读文件 + 一次 worker 往返）。
