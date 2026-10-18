# 执行摘要：simulate_physics 迁移到 Python（批次 3 第一件，Q2=A）

## 动机
> 用户 2026-10-08 裁决 **Q2=A：物理 canonical 随迁 Python（darwin-x64 例外）**，并要求
> "TS 侧现有物理验收必须在 Python 侧重跑才算数"。前置探针
> （`experiments/20261008_python_rapier_probe.md`）已量清 API 映射与分歧分层，本件是落地。

## 影响范围
> - `dsh-cad-harness/python/cad_worker/worker.py`：新增 `simulate_physics` op
>   （含 `_quat_to_matrix3` / `_up_tilt_degrees` / `_euler_to_quat` / `_is_convex` 四个辅助）
> - `dsh-cad-harness/src/host/physics.ts`：原 `runPhysics` 更名 `runPhysicsInTs`（oracle +
>   darwin-x64 canonical）；新增转发版 `runPhysics`（把 parts 的 STL 写进 worker scratch、
>   以路径传参、`finally` 清理）
> - `dsh-cad-harness/scripts/accept-physics-parity.mjs`（新增验收）
> - 文档：矩阵 row 14 与批次 3、DESIGN §26.4

## 具体操作步骤
> 1. Python 侧逐行镜像 `runPhysics`：
>    - 世界：`PhysicsWorld(gravity)` + `integration_parameters.dt`；
>    - 刚体：dynamic（`can_sleep(False)` + `ccd_enabled(True)` + 凸包 + 密度 + 可选初始角速度）、
>      fixed（凸包；非凸则 `_weld_raw` 后 trimesh，等价 TS 的 `isConvexStl` 分支）；
>    - 关节：`PrismaticJoint/RevoluteJoint.builder(axis=…).local_anchor1/2(…)`（+ `limits`），
>      用 `world.impulse_joints.insert(a, b, joint.build())`；
>    - 接触采样：`world.narrow_phase.contact_pair(c1, c2)` → `manifolds[].points[].dist`
>      （等价 JS 的 `world.contactPair(c1, c2, cb)` + `solverContactDist`）；
>    - 指标：最大/沉降穿透、倾倒（>60°）、水平位移、是否仍在动（linvel>5）、
>      关节违规（转动副锚点漂移 >2；移动副**跨轴** >2）、honest-input notes（壳数 ≥4）、
>      hold 分析（μ·m·|g⊥| vs m·|g∥|，解析式）；
>    - 关键帧：事件步（start/最大穿透/倾倒/final）+ 均匀补位 + 最小间隔 + "final 必须保留"，
>      与 TS 同一套选择算法；时间线 `traj_every = ceil(steps/160)`。
> 2. TS 侧：`runPhysics(scenario)` 变为转发；`PYTHON_PHYSICS_UNAVAILABLE =
>    platform==='darwin' && arch==='x64'` 时**明确走 TS canonical**（锁里没有该平台 wheel），
>    其余平台走 worker。
> 3. 新增 `accept-physics-parity.mjs`：五个用例（约束驱动滑块、自由飞行+轻接触、接触主导倾倒、
>    含静摩擦的 hold 分析、多壳件 notes），按探针的分层断言。

## 预期风险与验证
> - **风险点 1：把"引擎版本差异"当成 bug 追。** 处理：按探针分层——解析量必须精确、
>     定性判定必须一致、数值落在声明带内、接触主导的打印而不假装一致。
> - **风险点 2：darwin-x64 上工具直接报错。** 处理：显式分支走 TS canonical（不是报错、
>     也不是静默回退），并在代码注释里写明依据（锁里的 `# cad-exclude`）。
> - **风险点 3：接触采样/事件 API 语义不同。** 实测：Python 的 `contact_pair` 返回
>     **快照**（比 JS 的回调更好用）；`dist` 与 TS 的 `solverContactDist` 同义。
> - **风险点 4（顺带发现的真缺陷，**未修**）**：TS 的 `runPhysics` 建了 `EventQueue` 并 drain
>     碰撞事件，但**从未给任何 collider 打开 `ActiveEvents.COLLISION_EVENTS`** ⇒ 事件永远是空的，
>     `接触:<a>↔<b>` 这个关键帧标签是**死代码**。Python 侧**照现状镜像**（不开事件），
>     因为打开它会改变用户可见的关键帧，属于行为变更而非迁移。**建议**：单独一次改动打开它，
>     并同步更新验收（当前无任何验收引用该标签）。
> - **验证方式与结果：**
>   ```bash
>   cd dsh-cad-harness
>   export DSH_CAD_PYTHON_ROOT=$PWD/../.tmp-measure-runtime
>   node scripts/accept-physics-parity.mjs --runtime $DSH_CAD_PYTHON_ROOT   # 全过
>   node scripts/accept-p2.mjs && node scripts/accept-p3.mjs && node scripts/accept-sim-verdict.mjs
>   ```
>   - 约束驱动（滑块由限位停住、零接触）：最终 Δ **0.000 mm**
>   - 自由飞行 + 轻接触（翻滚）：**0.056 mm**
>   - 接触主导（200 mm 立柱被推倒）：最终 Δ 15.3 mm（带内），**定性判定一致**、
>     **关键帧标签集一致**（含"最大穿透"）
>   - hold 分析：解析式逐项一致（cap 0 vs drive 82.4 N → SLIDES）
>   - 多壳件：两侧都给出 honest-input note
>   - **Python 侧重跑既有基线：`accept-p2` / `accept-p3` / `accept-sim-verdict` 全过，未改阈值**
