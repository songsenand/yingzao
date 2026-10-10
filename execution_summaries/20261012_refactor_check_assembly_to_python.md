# 执行摘要：check_assembly 领域半区迁 Python（#2 后半）

## 动机

2026-10-12 决策第 2 条的落点：`measure_angle` 与 `check_assembly` 的领域半区一起迁。
理由是 `coaxial` 算子已经在 TS 里算"两轴夹角 + 轴线距离"，而新工具也要这份数学——
**两处实现迟早会打架**。迁完 `coaxial` 与 `measure_angle` 消费同一个
`_axis_line_metrics`。同时邻接发现改用与 `validate_assembly` **同一个** Manifold 引擎，
"声明的接口判定"与"未声明邻接的干涉体积"不再可能各说各话。

## 影响范围

- `dsh-cad-harness/python/cad_worker/worker.py`：新增 `DEFAULT_DERIVED`、
  `IMPLEMENTED_CHECKS`、`_js_num`、`_num_param`、`_assembly_base`、`_assembly_verdict`、
  `op_assembly_contracts`（`OPS` 29 → 30）
- `dsh-cad-harness/src/host/assembly-check.ts`：
  - `PartWorld` 增加 `workerMesh`（worker 要的 STL 路径 + 变换；从 `model.scad` 重建的
    版本走 scratch 文件，请求后清理）
  - 原 `runAssemblyCheck` 改名 `runAssemblyCheckInTs`，**保留为 parity oracle**
  - 新增 worker 版 `runAssemblyCheck`：TS 只做 manifest/store 读取、部件世界位姿、
    端点解析、跑数时效，判定与邻接在 worker
- `dsh-cad-harness/scripts/accept-check-assembly-parity.mjs`（新）
- 文档：`docs/TOOL-RUNTIME-MATRIX.md`（§2 row 7 + 已迁移表 + 未完成表移除该行）、
  `HARNESS.md`（op 30）

## 具体操作步骤

1. worker：`op_assembly_contracts` 收 `{parts, interfaces, runs, thresholds}`，返回
   `{results, undeclared, summary, overallStatus}`（**不含** `checkedAt`/`manifestPath`/
   `manifestName`/`partWarnings`——那些只有调用方有）。
2. TS：`runAssemblyCheck` 组装同一载荷；`a`/`b` 送**地址字符串**、解析后的世界特征走
   `aFeature`/`bFeature`；跑数按 `{kind,status,summary,supersededBy,staleVersionIds}` 送
   （时效判定需要版本库，留在 TS）。
3. parity：同 store 同 manifest 跑两条路径，逐字段深比较（`checkedAt` 除外，
   比较前做 JSON 往返以对齐落盘形态）。

## 预期风险与验证

- **风险点 1：契约悄悄变了**。迁移中**真的发生过一次**：我把解析后的特征对象放进报告的
  `a`/`b`，而预迁移报告那里是**地址字符串**。parity 第一次跑就报
  `$.results.0.a: object … vs string …`——已改回字符串（特征走 `aFeature`/`bFeature`）。
  这正是保留 oracle 的价值：`accept-assembly.mjs` 当时是全绿的，它只断言
  `measured`/`verdict`/`detail`，看不见这个字段。
- **风险点 2：detail 文案漂移**。worker 里 `_js_num` 负责让数字按 JS 模板字面量渲染
  （`6` 而不是 `6.0`），否则每条含数字的 detail 都会不等。parity 覆盖了全部五条算子的文案。
- **风险点 3：邻接最小距离的两套算法**。TS 用 BVH 采样、worker 用 `_min_distance_via_sampling`
  （`validate_assembly` 已 parity 验证过的同一函数），且两侧都取双向最小值。
- **风险点 4：报告比较的伪差异**。oracle 里 `expected: undefined` 与 worker 的"无此键"
  在内存里不同、落盘后相同 → 比较前统一 JSON 往返。
- **测试方式**：
  - `node scripts/accept-check-assembly-parity.mjs`：**2 夹具 + 2 语料 + 1 合成 manifest
    （17 接口）逐字段一致**。合成 manifest 专门覆盖夹具没走到的分支：`coaxial`、
    `spring-preload`（含缺参数）、motion-clearance 的五种证据结局（未引用 / 有效 /
    被取代 / 缺 run / 非 motion / 失败 / STALE）、未实现的 L1 check、未知 L0 check、
    解析失败的端点、未声明邻接、`source=stock` 跳过；并逐条断言这些分支**确实被走到**
    （否则"两边一致"可能只是两边都跳过）。
  - `node scripts/accept-assembly.mjs`：既有断言在 worker 路径上**全过**
  - 全套回归 11 件全绿；`tsc --noEmit` 全清；`esbuild` 双产物重建；`00-smoke` 复跑

## 遗留（已报告，未擅自改）

`_assembly_verdict`/`verdictFor` 报告的 `check` 字段用的是 `iface.check ?? 'distance'`，
而不是该接口按 type 派生出来的算子：`紧固`（派生 `diameter-match`）跑的是直径间隙判定，
报告里却写 `check: "distance"`。这是**预迁移既有行为**，为保 parity 原样搬过来；
是否修正留给用户裁决（改则两边同改，且会动报告字段）。
