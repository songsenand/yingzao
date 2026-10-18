# 执行摘要：validate_assembly 迁移到 Python（批次 1 第三个）

## 动机
> 判据「能迁就迁 Python」。`validate_assembly` 是装配间隙/干涉的主工具，实测 Python 侧
> 的 Manifold 布尔更快（3×），且它有两个**既有工具级验收**（`accept-m2.mjs` 的干涉/间隙
> 判定、`accept-import.mjs` 的导入件校验）可以立刻回归。

## 影响范围
> - `dsh-cad-harness/python/cad_worker/worker.py`：新增 `validate_assembly` op 及其依赖的
>   `_parse_stl_raw` / `_weld_raw` / `_solid_from_stl` / `_min_distance_via_sampling`；
>   `_closest_side` 增加 `max_points` 参数（None = 用给定点集，不二次抽样）
> - `dsh-cad-harness/src/host/assembly.ts`：`validateAssembly` 改为转发到 worker（STL 字节
>   写进 worker scratch，以**路径**传给 Python）；原实现改名 `validateAssemblyInTs` 作 oracle
> - `dsh-cad-harness/src/host/index.ts`：新增插件卸载时 `resetPythonWorker()` 的 effect
> - `dsh-cad-harness/scripts/accept-assembly-parity.mjs`（新增 parity 验收）
> - `dsh-cad-harness/scripts/accept-m2.mjs`：结尾补 `resetPythonWorker()` + 显式退出
> - 文档：矩阵 row 6 与批次 1、DESIGN §26.4、HARNESS §12.3
> - **未受影响**：工具名/schema/报告形状不变；`buildSolid` / `pairMinDistance` 仍服务
>   `check_assembly` 与 union 工具（批次 2）。

## 具体操作步骤
> 1. **逐行镜像 `solidify.ts`**：`_parse_stl_raw`（二进制 STL → float64 原始三角）→
>    `_weld_raw`（按 1e-5 mm 取整做键、保留首次出现的精确坐标、丢掉重复顶点的退化三角，
>    与 TS 的 `MeshBuilder` 同规则）→ `Mesh.merge()` → `Manifold(...)`。
>    **状态与体积是硬闸门**：`status != NoError`（Python 侧**不会抛异常**，只会把 status 置为
>    `NotManifold`）或 `volume < 0`（绕向反了）都**拒绝**，不修补——与 TS 一致。
>    顺序也一致：matrix（先）→ merge → rotate → translate；返回 Manifold 输出网格，保证
>    水密判定/距离抽样/包围盒共用一个坐标系。
> 2. **逐行镜像 `validateAssembly`**：逐件 watertight（严格判据）/volume/bbox/triangles；
>    逐对先用 Manifold 交集定干涉（>ε 判 interference；>1e-9 记 ok 但把体积显示出来——
>    microscope3 的打印螺纹就是这么暴露的），只有不接触的对才付距离抽样的代价。
> 3. **距离抽样按 TS 的规则**：`step = max(1, triCount // 1200)`，取每个被抽中三角形的
>    **三个顶点**（不是按顶点等距抽样），再对另一侧曲面做精确投影取最小；`_closest_side`
>    的包围盒下界剪枝保证与全量扫描等价。
> 4. `assembly.ts`：新的 `validateAssembly` 把每个 part 的 STL 写到 `workerScratchDir()`
>    下（`finally` 里删除），以路径调用 op，返回同一形状的报告；调用点无需改动。
> 5. 新增 `scripts/accept-assembly-parity.mjs`：8 个用例（1 mm 间隙、干涉、0.5 mm 在
>    0.75/0.25 两个阈值下、rotate、matrix/pose、真实零件对、整体平移）+ 非实体拒绝，
>    对**全字段**做等值比较。

## 预期风险与验证
> - **风险点 1：焊接规则不同导致三角形数/体积/包围盒漂移。** 验证：语料与手工件上
>   逐件 triangles/volume/bbox 与 oracle **完全一致**（volume 到 1e-6 内，实测多为逐位相同）。
> - **风险点 2：Python 的 Manifold 对非实体不抛异常**（只把 status 置 `NotManifold`），
>   若照搬会静默产出空报告。验证：显式检查 status 并抛错；单三角形用例两侧都拒绝。
> - **风险点 3：距离抽样规则被"顺手改成按顶点等距"。** 验证：按 TS 的"抽三角形取三顶点"
>   实现；0.5 mm 与 1 mm 用例两侧 minDistance 逐位一致。
> - **风险点 4：常驻 worker 是子进程，会吊住宿主/脚本的退出。** 实测：`accept-m2.mjs`
>   在迁移后**挂住不退出**（worker 的 stdio 句柄让事件循环一直活着）。处理：插件
>   `ctx.effect` 里注册 `resetPythonWorker()`（卸载即停），受影响的验收脚本显式收尾。
>   这也是"必须在插件生命周期里管理子进程"的实证，而不是理论担忧。
> - **验证方式：**
>   ```bash
>   cd dsh-cad-harness
>   export DSH_CAD_PYTHON_ROOT=$PWD/../.tmp-measure-runtime   # 未供给时先 python_runtime provision
>   node scripts/accept-assembly-parity.mjs --runtime $DSH_CAD_PYTHON_ROOT  # 26/26
>   node scripts/accept-m2.mjs        # 干涉 2258.3 mm³ / 1mm 间隙 / 5mm 间隙 全过
>   node scripts/accept-import.mjs    # ALL PASS
>   node scripts/accept-python-worker.mjs --runtime $DSH_CAD_PYTHON_ROOT
>   node_modules/.bin/tsc --noEmit && node esbuild.mjs
>   ```
