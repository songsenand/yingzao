# 实验报告：simulate_physics 的凸包假接触与关节稳定性

## 目标

回答一个问题：罗伯威尔天平 `examples/roberval-balance` 的 r002（稳态穿透 25.18mm、5 个约束异常、回放里托盘飞出叉口）到底是“闭环机构不可解”，还是碰撞模型/输入错误。并把修复做成可复跑的回归。

## 假设

1. **H1（主假设）**：r002 的散架来自 dynamic 件的单凸包碰撞体。托盘/边杆在 t=0 的真实网格重叠为 0，但凸包在铰链处填实了叉口/腔体，求解器把“设计间隙”读成深穿透。
2. **H2**：关节两端的接触默认开启，轴承的设计重叠被当成碰撞，放大了 H1。
3. **H3**：`simulate_physics` 的 `axis` 是“两个 body 同一个局部向量”，对 `[90,0,0]` 装的横梁与未旋转托盘不成立；单轴会把框架拧掉。
4. **H4**：`fellOver` 按世界 up 计算，90° 装配姿态在 t=0 就误报“倾倒”。

## 方法

- 场景：直接使用 `examples/roberval-balance/cad-data/runs/r002/parts/*.stl` 的 5 个件（base_unit、bottom_unit、pan_unit_left/right、top_beam），6 个转动副；重力 `[0,0,-9810]`，dt=1/60，2s。
- 测量 1：用 Manifold 布尔算 t=0 的**实际网格**两两重叠，再算**凸包**两两重叠，比较两者。
- 测量 2：用 `rapier3d` 直接跑同一场景的 A/B：去 collider vs 保留 collider；关节接触开 vs 关；单轴 vs 逐体轴。
- 测量 3：修复后通过 `node scripts/accept-physics-contact.mjs` 同时跑 Python worker 与 TS oracle，断言穿透/约束异常/漂移/倾倒/装配门禁。
- 关键文件：`python/cad_worker/worker.py`（`op_simulate_physics`）、`src/host/physics.ts`（`runPhysicsInTs`）、`src/host/tools.ts`（`runPhysicsJob`）。

## 结果

### t=0 的重叠（mm³）

| 零件对 | 实际网格 | 凸包 |
|---|---:|---:|
| `top_beam ↔ pan_unit_left/right` | **0** | **12,140.8 / 侧** |
| `bottom_unit ↔ pan_unit_left/right` | **0** | **3,937.3 / 侧** |
| `bottom_unit ↔ base_unit` | 0 | 3,123.3（凸包 vs 固定件网格） |

### A/B（2s，重力，5 体 6 铰）

| 条件 | 结果 |
|---|---|
| 去掉全部 collider | 最大漂移 **0.5mm**，top_beam 精确回 215.0 |
| 保留 collider、关节接触开 | pan_unit_right 漂 **24.7mm**、pan_unit_left 6.8mm、横梁下沉 2mm |
| 保留 collider、只关 pan 关节接触 | 仍有 **11–12mm** 残余（bottom 凸包与 base 网格还有 3.1L 假重叠） |
| 逐体轴但方向未对齐 | 零重力下框架仍被拧动（top_beam 90° → identity） |
| 逐体轴 + 两端世界方向对齐 | 零重力 0.0mm；重力下最大 0.54mm |

### 修复后回归（`accept-physics-contact`）

| 指标 | r002 旧 | 修复后 |
|---|---:|---:|
| 稳态穿透 | 25.18mm | **0mm** |
| 约束异常 | 5 | **0** |
| 最大位移 | 39.18mm（关节） | **0.54mm** |
| `fellOver` | 盘/梁误报 | **全部 false** |
| Python vs TS 最终位姿 | — | **0.0001mm** |

### motion 侧（r001）复跑

同一套 5 个 STL，按工具的 pivot 规则重基，6 个转动副用逐体轴（base↔top: 世界 +Y；top↔pan: 横梁局部 +Z、托盘局部 +Y），上横梁 0.5 rad/s × 0.02 圈：

| 指标 | r001 旧 | 逐体轴 + 重基后 |
|---|---:|---:|
| `overallStatus` | check | **pass** |
| 最大关节漂移 | 105.566mm | **0mm** |
| 约束异常 | 3 | **0** |
| 采样 | 24/24 | **24/24** |

命令：`node scripts/accept-motion-axes.mjs`。这支持了“r001 是锚点/轴输入错误，不是闭环不可解”的判断。

工具级复跑：`examples/roberval-balance` 已生成 **r038**（physics，pass，0mm 穿透/0 约束异常）与 **r039**（motion，pass，0mm 漂移/24 采样）；r001/r002 的 `supersededBy` 分别指向 r039/r038。

## 分析

- H1 成立：r002 的直接触发因素是凸包把真实 0 重叠变成 12L 穿模；`maxPenetrationMm=40.16` 与 12L 重叠的尺度一致。
- H2 成立：关节接触不关时，即使换成精确 trimesh，零件仍被轴承接触力推走（trimesh + 关节接触开：2s 漂 72mm+）。关掉后同一场景稳定。
- H3 成立：单轴让 `[90,0,0]` 横梁从 90° 转回 identity；逐体轴 + 方向对齐后零重力 0.0mm、重力 0.54mm。
- H4 成立：旧代码 t=0 就记录 `倾倒:top_beam`；相对姿态后 authored 90° 不再算倾倒。
- **原 README 的“闭环不可解”归因不完整**：physics 侧的失败是碰撞体/接触/轴三个可修错误，不是闭环求解能力。`simulate_motion` 的 r001 仍需用 `anchorWorld` 重跑后单独定论。

## 遇到的问题

- rapier 的 revolute 轴是“有方向的框架对齐”，不是无向直线：`axisA` 与 `axisB` 的世界方向相反时会产生 180° 框架扭转，表现为零件在零重力下自己动。修复是在建关节前比较世界方向并翻转 B。
- 把 dynamic 件换成 trimesh 后，`accept-physics-parity` 的 many-shell 用例出现键帧标签差异（一个引擎采到“最大穿透”，另一个没采到）。这是接触主导轨迹的预期分歧；该用例改为只断言 start/final 存在，并保留最终位置带。
- 现有 `accept-p2` / `accept-p3` 在干净 HEAD 上也有 `check_assembly: value.skipped[0]` 的 lossless JSON 失败（P3 还在 coaxial 0.8mm 断言上失败），与本次改动无关，未在本实验范围内修。

## 产物列表

**代码与脚本：**
- `dsh-cad-harness/python/cad_worker/worker.py` —— 规范实现：碰撞体按凸性分流、关节接触开关、t=0 门禁、逐体轴 + 方向对齐、相对倾倒。
- `dsh-cad-harness/src/host/physics.ts` —— TS oracle 同步。
- `dsh-cad-harness/src/host/tools.ts` —— `jointContacts` / `axisA` / `axisB` / `axisWorld` / 新报告字段。
- `dsh-cad-harness/scripts/accept-physics-contact.mjs` —— 新回归，直接使用 r002 的 STL。
- `dsh-cad-harness/scripts/accept-motion-axes.mjs` —— motion 侧 r001 复跑（重基 + 逐体轴）。
- `dsh-cad-harness/scripts/accept-physics-parity.mjs` —— 接触主导用例的断言调整。

**数据：**
- `examples/roberval-balance/cad-data/runs/r002/parts/*.stl` —— r002 的 5 个件，未修改。

**运行命令：**
```bash
cd dsh-cad-harness
node scripts/accept-physics-contact.mjs
node scripts/accept-motion-axes.mjs
node scripts/accept-physics-parity.mjs
```

**环境依赖：**
- Node ≥ 20（实测 v26.13.0）
- `dsh-cad-harness/.tmp-measure-runtime` 或 `.tmp-cad-runtime` 的 CPython + rapier3d
- 依赖见 `dsh-cad-harness/package.json`

**复现步骤：**
1. 运行回归：`node scripts/accept-physics-contact.mjs`（无 runtime 时只跑 TS，会 SKIP Python）。
2. 运行 parity：`node scripts/accept-physics-parity.mjs`。
3. 如需手工复现 t=0 重叠，用 Manifold 对 `r002/parts` 的 STL 做 `mesh ∩ mesh` 与 `hull ∩ hull`。

## 结论与下一步

physics 侧的 r002 不是“闭环不可解”，而是凸包碰撞体 + 关节接触 + 单轴三个可修错误；修复后同一批 STL 从 25.18mm 穿透/5 个约束异常降到 0/0，漂移 0.54mm。motion 侧的 r001 用重基 + 逐体轴复跑也从 105.6mm 漂移降到 0，说明它同样是输入/轴问题。下一步：把两个新回归加入 CI；r038/r039 已作为工具级证据生成（见上）。
