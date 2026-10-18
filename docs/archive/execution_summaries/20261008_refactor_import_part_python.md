# 执行摘要：import_part 领域半区迁移到 Python（批次 2 第一件）

## 动机
> 判据「能迁就迁 Python」。`import_part` 是"外部几何进入版本库"的唯一入口，其领域部分是
> 纯计算：解析（二进制/ASCII）、壳数、单位缩放、焊接、Manifold 实体判定与诊断。
> `accept-import.mjs` 提供工具级回归。

## 影响范围
> - `dsh-cad-harness/python/cad_worker/worker.py`：新增 `import_mesh` op；把焊接逻辑重构成
>   通用的 `_weld(vertices, faces)`（多返回退化面计数）；新增 `_detect_stl_format`、
>   `_parse_ascii_vertices`、`_round_js`；`_is_watertight` 拆出 `_watertight_bad_edges`
> - `dsh-cad-harness/src/host/import.ts`：`importGeometry` 的领域半区改为 worker 调用；
>   TS 侧保留路径/扩展名检查、sha256、unit/scale 校验、datum、警告与返回值装配；
>   删除随之无用的 `applyScale` 与 `round`
> - `dsh-cad-harness/scripts/accept-import-parity.mjs`（新增真值验收）
> - 文档：矩阵 row 4 与批次 2、DESIGN §26.4

## 具体操作步骤
> 1. 通用焊接：`_weld(vertices, faces)` 按 1e-5 mm 取整做键、保留**首次出现**顺序（这一条
>    在 merge_parts 那次已经踩过）、丢弃重复顶点三角并**返回计数**；`_weld_raw` 变成它的
>    薄封装。
> 2. `_detect_stl_format` 照搬 TS：二进制判据是**精确长度恒等式**（`84+n*50 == len`），
>    因此头 80 字节写着 "solid" 的二进制文件不会被误判成 ASCII；否则看前 2048 字节是否
>    `^solid` 且含 `facet`。
> 3. `_parse_ascii_vertices` 照搬 TS 的宽容解析：只有 `vertex x y z` 行携带几何，非有限数报错，
>    顶点数不是 3 的倍数报错（而不是给出半个网格）。
> 4. `import_mesh`：解析 → 壳数（在**交付态**的焊接网格上数，缩放之前）→ 单位缩放一次 →
>    `Mesh.merge()` → Manifold → 实体/绕向判定 → **写出焊接缩放后的 STL**（即入版本库的文件）
>    → 回传 triangles/vertices/rawTriangles/rawVertices/shells/degenerate/badEdges/genus/
>    signedVolume/bbox/appliedScale/reason。
> 5. `import.ts`：领域半区换成 worker 调用；错误信息保留 `${文件名}: …` 前缀；
>    "不是实体"的长文案、警告文案、repaired 文案逐字保留；返回值装配不变。
> 6. 新增 `scripts/accept-import-parity.mjs`：以**解析真值**为准（见下）。

## 为什么这次不用 oracle（重要）
> 其余批次 1 工具都保留了 TS 实现做 parity oracle。import 是**有意的例外**：TS 的 `parseStl`
> 数了退化面却把计数丢掉（`degenerate: 0` 恒成立），所以"N degenerate triangles discarded
> during parse"这句**从未出现过**。把一个已知缺陷留作 oracle 会把缺陷固化成契约。
> 改为断言**算术真值**：20 mm 立方体 = 8000 mm³、1 inch = 25.4 且体积 ×25.4³、ASCII 与二进制
> 同结果、两个不相接体 = 2 壳且体积相加、开口网格被拒且给出边诊断、绕向反转被单独识别、
> 整机 710012.998 mm³ / 28830 面 / 26 壳（这些数字来自更早的独立测量）。

## 预期风险与验证
> - **风险点 1：二进制/ASCII 误判**（头写着 solid 的二进制文件）。验证：ASCII 与二进制
>   两个用例各自断言 format 与结果一致。
> - **风险点 2：单位缩放做两次或做在测量之后。** 验证：inch 用例断言 appliedScale=25.4、
>   体积 ×25.4³、包围盒 508³——一次性、且在测量之前。
> - **风险点 3：退化面计数"顺手照搬 0"。** 处理：报真数；验收断言该用例 degenerate=1 且
>   repaired 里出现对应句子（TS 下这句永远不会出现）。
> - **风险点 4：焊接顺序再次影响交付物。** 复用 merge_parts 修好的首次出现顺序；
>   `import_mesh` 写出的 STL 就是入版本库的字节。
> - **验证方式：**
>   ```bash
>   cd dsh-cad-harness
>   export DSH_CAD_PYTHON_ROOT=$PWD/../.tmp-measure-runtime
>   node scripts/accept-import-parity.mjs --runtime $DSH_CAD_PYTHON_ROOT   # 全过
>   node scripts/accept-import.mjs        # ALL PASS（工具级：单位/父子版本/指纹/拒绝文案）
>   node scripts/accept-p1.mjs accept-m2.mjs accept-connectivity.mjs accept-measure.mjs
>   node scripts/accept-python-worker.mjs --runtime $DSH_CAD_PYTHON_ROOT
>   node_modules/.bin/tsc --noEmit && node esbuild.mjs
>   ```
