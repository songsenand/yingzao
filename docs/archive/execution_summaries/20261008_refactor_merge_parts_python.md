# 执行摘要：merge_parts 并集迁移到 Python（批次 1 第四个）

## 动机
> 判据「能迁就迁 Python」。`merge_parts` 的并集就是 Manifold 布尔（实测 Python 侧 3×），
> 且 `accept-p1.mjs` 里有**工具级验收**（体积 40000 mm³、接触并成 1 壳、不相接报 2 壳 + 警告、
> provenance、4 张渲染图、少于 2 件要拒绝）可立刻回归。

## 影响范围
> - `dsh-cad-harness/python/cad_worker/worker.py`：新增 `merge_solids` op +
>   `_write_binary_stl`（逐字节镜像 TS 的 STL 写出）+ `_shell_count`；**修正 `_weld_raw`
>   的顶点顺序**（见风险点 1）
> - `dsh-cad-harness/src/host/tools.ts`：`mergePartsJob` 的并集循环改为 worker 调用；
>   合并 STL 由 Python 写出、TS 读回用于渲染与存版；错误信息保留"哪个 part 不可用"
> - `dsh-cad-harness/scripts/accept-merge-parity.mjs`（新增 parity 验收）
> - 文档：矩阵 row 5 与批次 1、DESIGN §26.4
> - **未受影响**：工具名/schema/输出形状不变；`buildSolid`/`pairMinDistance` 仍服务
>   `check_assembly`（批次 2）。

## 具体操作步骤
> 1. `worker.py` 新增 `_write_binary_stl`：80 字节头 + uint32 三角数 + 每三角（法线 + 三顶点）
>    小端 float32 + uint16 属性，与 TS `writeBinaryStl` 逐字节一致（法线用 float64 算，和 JS
>    的 number 语义对齐）。
> 2. 新增 `_shell_count`：按**无向边**做连通分量，等价于 TS 的 `shellCount`（驱动
>    "你合的这些件并不都相接"的警告）。
> 3. 新增 `merge_solids`：逐件 `_solid_from_stl` → Manifold `+` 累加 → `to_mesh()` →
>    写 STL → 返回 `{triangles, volumeMm3, sizeMm, shells, outBytes}`。**错误里点名出错的
>    part**（`part "x" is not a usable solid — …`），因为模型需要知道改哪个件。
> 4. `tools.ts`：各件 STL 写进 worker scratch 后以路径传参；`finally` 清理输入件；
>    合并件读回后删除；`shells` 警告文案、渲染、`saveVersion`、`ctx.attachments` 全部不变。
> 5. 新增 `scripts/accept-merge-parity.mjs`：5 个用例（接触叠放、不相接、旋转件、三件、
>    真实零件）对拍三角数/体积/尺寸/壳数 + **STL 字节**；不可用件必须被点名。

## 预期风险与验证
> - **风险点 1（真踩到了）：焊接后的顶点顺序不一致。** 第一版用 `np.unique` 直接取唯一顶点，
>   它返回的是**按键排序**的顺序，而 TS 的 `MeshBuilder` 按**首次出现**顺序编号——顺序会传播
>   到合并 STL，于是产出"几何相同但字节不同"的交付物。修法：`argsort(first_index)` 还原首次
>   出现顺序再重映射面索引。修完 **2 件并集与真实零件（1.44 MB）的 STL 逐字节相同**。
> - **风险点 2：3 件且带共面接触时三角形顺序仍不同。** 已核实**不是我们的代码**：Python 侧
>   `(a+b)+c`、`a+(b+c)`、`batch_boolean` 三种写法字节完全相同，是 JS 绑定在该情形下的输出
>   顺序差异。STL 的三角形顺序不属于其语义，因此验收**断言**"字节长度相同 + 几何指纹相同 +
>   顶点集相同"，把顺序差异**打印出来**而不是悄悄放过，也不当作失败。
> - **风险点 3：错误信息丢失 part 归因。** 验证：验收里用一个单三角形当第二个件，断言错误里
>   出现 `broken-bracket` 与 `not a usable solid`。
> - **验证方式：**
>   ```bash
>   cd dsh-cad-harness
>   export DSH_CAD_PYTHON_ROOT=$PWD/../.tmp-measure-runtime
>   node scripts/accept-merge-parity.mjs --runtime $DSH_CAD_PYTHON_ROOT   # 全过
>   node scripts/accept-p1.mjs        # P1 ACCEPTANCE PASSED（40000mm³ / 1 壳 / 2 壳+警告 / 4 图）
>   node scripts/accept-assembly-parity.mjs --runtime $DSH_CAD_PYTHON_ROOT
>   node scripts/accept-connectivity-parity.mjs --runtime $DSH_CAD_PYTHON_ROOT
>   node scripts/accept-measure-closest.mjs --runtime $DSH_CAD_PYTHON_ROOT
>   node scripts/accept-python-worker.mjs --runtime $DSH_CAD_PYTHON_ROOT
>   node_modules/.bin/tsc --noEmit && node esbuild.mjs
>   ```
