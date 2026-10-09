# 实验报告：物理 canonical 迁 Python 的可行性探针（Q2=A 的前置）

## 目标
> 用户 2026-10-08 裁决 **Q2=A：物理 canonical 随迁 Python（darwin-x64 例外）**，并写明代价——
> "TS 侧现有物理验收（17/17 + 24/24）**必须在 Python 侧重跑**才算数"。
>
> 在动手搬 ~1200 行（`physics.ts` 589 + `motion.ts` 617）之前，先量清楚三件事：
> ① Python 的 `rapier3d` 能不能表达同样的场景；② 同一场景两边跑出来的差多少；
> ③ 那些差是"同一个答案的不同舍入"还是"不同的答案"。

## 假设
> - H1：Python 绑定（0.36）与 TS 绑定（`rapier3d-compat` 0.20）的 API 是一一对应的，迁移是体力活。
> - H2：引擎版本不同 ⇒ 数值不可能逐位一致，但**受约束的量**（关节沿轴行程）应当非常接近。
> - H3：**接触主导的量**（碰撞/卡住/翻滚）会明显分歧，因为接触求解器是版本间改动最大的部分。

## 方法
> 脚本 `dsh-cad-harness/scripts/probe-python-rapier.mjs`（TS 用现役 `runPhysics`，Python 用
> 供给运行时里的 `rapier3d` 0.36）。两侧**同一个 STL 字节**（OpenSCAD 现场编译）、同一重力
> （mm 制 `[0,0,-9810]`）、同一 `dt = 1/60`、同样 120 步、ccd 开、`can_sleep(false)`、
> 密度 1.05e-6。逐帧记录平移/四元数，比较最终位姿与**逐步最大偏差**。
>
> 四个场景：① 翻滚（40×40×100 方块在地面上、绕 Y 给初始角速度 6 rad/s）；
> ② 铰接摆臂（120 mm 臂，轴 Y，会撞到基座）；③ 自由摆臂（同关节，但基座挪到铰点另一侧上方）；
> ④ 滑块（40×40×100 滑块 + 沿 Z 的移动副，限位 [-50,10]，重力向下）。

## 结果

### API 对应（H1 成立，差异只是命名与构造风格）

| 概念 | TS（`rapier3d-compat` 0.20） | Python（`rapier3d` 0.36） |
|---|---|---|
| 世界 | `new RAPIER.World({x,y,z})` + `world.timestep` | `R.PhysicsWorld((x,y,z))` + `world.integration_parameters.dt` |
| 刚体 | `RigidBodyDesc.dynamic()/fixed()` → `world.createRigidBody(desc)` | `RigidBody.dynamic()/fixed()` → `world.add_body(builder)`（返回 handle） |
| 读位姿 | `body.translation()` / `body.rotation()` | `world.rigid_bodies[handle].translation` / `.rotation.quaternion`（**属性，不是方法**） |
| 形状 | `ColliderDesc.convexHull(points)` | `Collider.convex_hull(points)` → `world.add_collider(cb, handle)` |
| 关节 | `JointData.revolute/prismatic(...)` → `world.createImpulseJoint` | `RevoluteJoint.builder(axis=…).local_anchor1/2(...)` → `world.impulse_joints.insert(a, b, joint)` |
| 限位 | `PrismaticImpulseJoint.setLimits(lo, hi)` | `PrismaticJoint.builder(...).limits(lo, hi)` |

### 数值分歧（同一场景、同一输入）

| 场景（主导因素） | TS 最终 | Python 最终 | 最终 Δ | 逐步最大 Δ |
|---|---|---|---|---|
| 翻滚（自由+滚动接触） | [-0.276, -0.464, 49.968] | [-0.245, -0.510, 49.968] | **0.056 mm** | **0.92 mm** |
| 滑块（**关节约束**为主，轻接触） | [0, 0, **56.644**] | [0, 0, **56.644**] | **0 mm** | 0.05 mm |
| 摆臂（**接触卡死**主导） | [70.057, 0, 0.737] | [68.894, 0.012, -2.823] | 3.75 mm | **27.5 mm** |
| 自由摆臂（**铰点接触**主导） | [60.26, 0, 56.374] | [58.54, 0, 66.20] | **9.97 mm** | **35.2 mm** |

## 分析
- **H1 成立**：API 一一对应，port 是机械的（上表就是映射表）。
- **H2 成立且比预期好**：滑块那个**由关节求解器决定**的量，两边**完全一致到 0.001 mm**
  （都是 56.644）；翻滚场景的最终位姿也只差 0.056 mm。⇒ **受约束/轻接触的量可以直接沿用现有阈值。**
- **H3 成立**：两个摆臂都因**铰点附近的接触**而分歧到 3.7–10 mm 终值、27–35 mm 过程值。
  这两个场景的物理设计本身也证明了另一件事：**本工具族的关节场景不可能"无接触"**——
  关节的铰点就在部件表面上，臂的端面必然在铰点邻域扫过基座（真实铰链也有铰节）。
  换句话说，"纯关节、零接触"的基准场景在这个模型里不存在。
- **因此 Q2=A 的重新定基线策略应当是分层的**：
  1. **关节约束量**（沿轴行程、限位、传动比、周期）：沿用现有阈值（实测≤0.05 mm）。
  2. **自由飞行/轻接触量**（沉降位置、未倾倒）：沿用 ±1 mm 级阈值（实测≤0.92 mm）。
  3. **接触主导量**（卡死角度、翻滚轨迹、穿透量）：**必须重定阈值**，并优先断言**定性判定**
     （倾倒/卡住/沉降/穿透≤阈值）而不是轨迹坐标。现有 `accept-p2`/`accept-p3` 的断言正是
     这个风格（judgment 为主、数字带量级余量），所以迁移风险主要在 `accept-m36`（motion 17/17，
     四冲程相位/周期类断言——那属于第 1 类，预期能过）。

## 遇到的问题
1. **Python 绑定的构造风格与 JS 不同**：静态工厂挂在**结果类**上（`RigidBody.dynamic()`、
   `Collider.convex_hull()`、`RevoluteJoint.builder()`），不是 `XxxDesc`；位姿是**属性**不是方法；
   关节插入是 `world.impulse_joints.insert(a, b, joint.build())`。第一轮探针在这三处各炸了一次。
2. **两个摆臂场景一开始都不动**：因为我先用轴 X（沿臂长）——那只能让臂绕自身滚转。改成轴 Y 后
   动起来，也因此暴露了"铰点必接触"这个结构性事实（见分析）。
3. **探针脚本必须设 `DSH_CAD_PYTHON_ROOT`**：`compileStlOnly` → `datumPrelude()` 现在会碰 worker，
   默认路径 `~/.dsh/cad/runtime` 在我的沙箱里只读，脚本已显式指向工作区运行时。

## 产物列表

**代码与脚本：**
- `dsh-cad-harness/scripts/probe-python-rapier.mjs` —— 四个场景的 TS↔Python 对拍（内嵌 Python 探针）

**数据：**
- `dsh-cad-harness/data/bench/python-rapier-probe.json` —— 原始结果（每场景的最终位姿、最终 Δ、
  逐步最大 Δ、步数）

**运行命令：**
```bash
cd dsh-cad-harness
export DSH_CAD_PYTHON_ROOT=$PWD/../.tmp-measure-runtime   # 未供给时先 provision
node scripts/probe-python-rapier.mjs
```

**环境依赖：**
- Node 26（运行 TS 侧 `runPhysics`，依赖 `@dimforge/rapier3d-compat`）
- Python 3.13.16 + `rapier3d 0.36.1`（供给运行时里的锁定版本）
- OpenSCAD（现场编译四个测试网格）

## 结论与下一步
> 1. **可以迁，且迁移是机械的**：API 映射表已列全，Python 侧四个场景全部跑通。
> 2. **重新定基线要分层**：关节约束量与轻接触量沿用现有阈值（实测 0–0.92 mm）；
>    **接触主导的量必须重定**，并改成断言定性判定（`accept-p2`/`accept-p3` 已是这个风格）。
> 3. 下一步（批次 3）：把 `physics.ts` 的**场景构建 + 步进 + 指标**搬进 worker（一条 op
>    `simulate_physics`），TS 侧保留 schema、关键帧渲染与报告装配；随后按同样方式搬 `motion.ts`，
>    每搬完一个就跑 `accept-p2`/`accept-p3`/`accept-m36`，把"Python 侧基线"记进验收脚本头部。
> 4. `darwin-x64` 例外：该平台没有 `rapier3d` wheel（锁里 `# cad-exclude`），工具必须**明确**
>    走 TS canonical 而不是报错——这条要在迁移实现里落到代码分支上。
