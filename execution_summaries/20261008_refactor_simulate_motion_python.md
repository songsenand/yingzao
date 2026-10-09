# 执行摘要：simulate_motion 迁移到 Python（批次 3 收尾，Q2=A）

## 动机
> Q2=A 的物理随迁剩最后一件：机构运动仿真 `simulate_motion`。它和 `simulate_physics` 不同——
> rapier 在这里**只当约束求解器**（无碰撞体、无重力），"过不过"由**精确的 Manifold 干涉时间线**
> 判定。所以这次迁移同时要满足两个引擎：关节求解器 + 本仓库其余部分在用的同一个 Manifold。

## 影响范围
> - `dsh-cad-harness/python/cad_worker/worker.py`：新增 `simulate_motion` op（+ `_norm3`、
>   `_aabb_overlap`、`_period_from_samples`、`_welded_mesh`、`_transform_points`、`_world_anchor`、
>   `_scaled_axis_of_euler` 辅助）
> - `dsh-cad-harness/src/host/motion.ts`：原 `runMotion` 更名 `runMotionInTs`（oracle +
>   darwin-x64 canonical）；新增转发版 `runMotion`
> - `dsh-cad-harness/scripts/accept-motion-parity.mjs`（新增验收，5 用例）
> - 文档：矩阵 row 15 与批次 3（完成）、DESIGN §26.4

## 具体操作步骤
> 1. Python 侧逐行镜像 `runMotion`：dt=1/2000、cycles/samplePerCycle 推导、零重力世界、
>    四类刚体（fixed / 驱动体 kinematicVelocityBased / 摆动体 kinematicPositionBased /
>    无碰撞体 dynamic + AABB 估计惯量）、驱动角速度、关节（含移动副 limits）、
>    摆动器两种模式（正弦 amplitudeMm / 齿条齿轮 pitchRadiusMm，含三条参数校验错误）、
>    曲柄里程碑 90°/180°/270°、暖机后重设行程极值、逐步行程跟踪、
>    干涉时间线（焊接网格 → 固定件世界顶点烘焙 → 静态 Manifold → 逐采样 AABB 剪枝 →
>    Manifold 交 → 体积 >1e-3）、跟随件（行程/主轴/周期）、关节漂移、关键帧、
>    播放时间线、PASS/CHECK 判定。
> 2. TS 侧 `runMotion(scenario)` 转发；`PYTHON_MOTION_UNAVAILABLE = darwin && x64` 走 TS。
> 3. 新增 `accept-motion-parity.mjs`：滑块曲柄、正弦摆动、齿条齿轮耦合、**带初始旋转的部件**、
>    负例（活塞撞缸盖）。

## 预期风险与验证
> - **风险点 1（实际踩到）：Python 绑定的 `RigidBodyBuilder.rotation()` 收的是
>   scaled-axis 向量（轴×角），不是四元数，也不是三个欧拉角。** 传四元数报
>   `expected sequence of 3 floats, got length 4`。修法：`Rotation3.from_quaternion(w,x,y,z)`
>   （注意**参数顺序是 w,x,y,z**）→ `.scaled_axis` 回填，已用三组旋转做往返验证（逐位一致）。
>   **教训**：此前所有用例都没给部件设初始旋转，所以这个坑一直没暴露——因此**专门加了一个
>   带旋转用例**（`[0,90,0]` 与 `[30,-20,45]`），并同时修了 `simulate_physics` 里同样的写法。
> - **风险点 2：`additional_mass_properties` 的签名与 JS 完全不同。** JS 收
>   `(mass, com, inertia, rotation)` 四个位置参数；Python 只收**一个 `MassProperties` 对象**，
>   而 `MassProperties` 只能用关键字构造（`mass=`/`local_com=`/`principal_inertia=`，
>   `local_com` 要 `Vec3`）。已按此实现。
> - **风险点 3：干涉判定会不会因为引擎版本差异而翻面。** 实测：**干涉计数逐位相同**
>   （干净用例 0/0；负例 25/25 与 49/49），干涉的部件对也一致，关键帧标签序列一致
>   （含 `interference`）。判定不受影响。
> - **风险点 4：行程/周期会不会漂。** 实测：行程差 **0.0000 mm**、周期差 **0.00000 s**
>   （滑块曲柄 50.001→50.001、齿条齿轮与正弦摆动同样逐位一致）。
> - **验证方式与结果：**
>   ```bash
>   cd dsh-cad-harness
>   export DSH_CAD_PYTHON_ROOT=$PWD/../.tmp-measure-runtime
>   node scripts/accept-motion-parity.mjs --runtime $DSH_CAD_PYTHON_ROOT   # 全过
>   node scripts/accept-m36.mjs                                          # M3.6 ACCEPTANCE PASSED（17/17）
>   ```
>   - **`accept-m36`（四冲程机构 17/17）在 Python 后端下通过** —— 包含负例：
>     连杆加长后干涉被检出（3 事件）、状态 `check`
>   - 全量回归：`accept-p2`/`accept-p3`/`accept-sim-verdict` + **10 个 parity 验收**全过；
>     `tsc`、`esbuild` 干净
>   - 性能：TS 89–182 ms vs Python 99–175 ms（0.96–1.20×），无负收益
