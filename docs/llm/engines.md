# 引擎边界：它们模型什么，不能回答什么

五个引擎，五种“能信”的范围。**运动/物理/流体/LBM 都不报告力或扭矩；应力报告反力与截面力，但那不是安全系数，也不是驱动扭矩或功率。没有一个能替代认证。**

## 运动（`simulate_motion`）

- **运动学 + 精确干涉时间线**，没有重力。它回答“按这个驱动，零件会不会撞、行程够不够”。
- **绕 pivot 转，不绕世界原点。** 语料里的零件是世界坐标，仿真体从 (0,0,0) 开始；工具会把几何重基到 pivot（默认：第一个命名它的 joint 的 anchor，否则几何中心），否则 z=265 的齿轮会绕 265mm 的臂摆。`pivots` 回报实际用的 pivot。
- **关节锚点先量后跑。** 每个 joint 的 anchor 间隙在步进前测量；超过 2mm 直接拒绝并报两个 anchor 的位置。`initialJointGaps` / `jointToleranceMm` 在回复里；拒绝意味着你的 anchor 或 placement 不一致，**不要靠调大容差绕过**。
- **不同朝向的件之间的关节要逐体轴。** `axis` 是“两个 body 用同一个局部向量”，只在两件坐标系平行时正确；旋转过的件用 `axisA` + `axisB`，或 `axisWorld`（工具换算到各自局部系）。r001 的 105mm 漂移就是“文件系当世界系 + 单轴”两件事叠出来的；修正后同一批 STL 是 0mm。
- **干涉覆盖是判定的一部分。** 每次运行至少 24 个采样位姿，且必采最终位姿；`interferenceChecks` / `samplingSatisfied` / `maxSampleGapDeg` 回报覆盖。**0 次检查不是 0 碰撞。** 行程太小放不下 24 位姿时判 `check`，不判 pass。
- **被 revolute joint 连接的一对零件之间的重叠不报**——那是轴承。也正因如此，限位挡块恰好落在这一对上时，要另找方式验证。
- **`cycles` 接受小数。** 摆杆 ±14° 只扫 0.078 圈；整圈会变成风车并撞上一切。
- **没有曲柄也能跑。** `drive` 是可选的：全部运动件都是 `oscillators`（规定轨迹的导向件/阀门）时不需要曲柄，时间基取**振荡周期**；回复里 `hasCrank: false`。只有“既无 drive 又无 oscillator”才拒绝——那意味着什么都不动。
- **几何合理性是事实，不是判定。** 每个零件对最近零件的间隙 ÷ 自身包围盒对角线 > 5 → `离群`；≤ 24 个三角面 → `简单盒体`。两者都**不改变** pass/fail，但 `geometrySuspects` 非空时，“干涉 0 次”可能什么都没证明：fructose r013 的两个假件停在 500mm 外，报告照样通过。规则本身写在 `geometrySuspectRule` 里随结果一起返回。

## 物理（`simulate_physics`）

- **刚体 + 重力**；回答“会不会倒、能不能停住”。
- **坡度用 `tiltDeg`，不要手算重力向量。** `tiltDeg: 5` 绕 `[0,1,0]` 倾斜 5°；只有 `tiltDeg` 说不出的方向才显式传 `gravity`。
- **“滑块在重力下会不会滑？”看 `staticFriction`，不是看求解器。** 给 prismatic joint `staticFriction: μ`，报告会给准静态保持分析（μ·m·|g⊥| vs m·|g∥|），并标明是解析的；不给就是纯约束，滑块永远掉，说明不了设计。
- **prismatic joint 只检查“垂直于轴”的漂移**；沿轴滑动是关节在工作，不是漂移。
- **碰撞体按凸性分流。** 凸件用 hull，凹件（叉口、托盘腔、多壳研究体）用精确 trimesh。单个凸包会把凹腔填实：罗伯威尔 r002 的托盘/边杆在 t=0 真实重叠 0mm³，凸包却在每个上铰链重叠 12,140mm³、每个下铰链 3,937mm³——求解器把它当深穿透，把盘甩出叉口。`colliders` 回报每个件实际用了哪种。
- **关节两端默认不碰撞。** 轴承本来就是“设计好的重叠”，不是穿模；`contactsDisabled` 列出关掉的 pair。只有“挡块确实要在这一对上碰撞”才传 `jointContacts: true`。
- **t=0 装配门禁。** 关节锚点间隙 > 2mm 直接拒绝，列出每个关节和两侧世界坐标（`initialJointGaps` / `jointToleranceMm`）；不要靠调大容差绕过。与 motion 同一条规则。
- **不同朝向的件之间的关节要逐体轴。** `axis` 是“两个 body 用同一个局部向量”，只在两件坐标系平行时正确；旋转过的件用 `axisA` + `axisB`，或 `axisWorld`（工具换算到各自局部系）。r002 的上横梁 [90,0,0] 用单 `axis` 会把整个框架拧掉。
- **倾倒相对“ authored 姿态”算，不相对世界 up。** 一个本来就 90° 装着的横梁不是 t=0 就倒了；30° 标事件，60° 才置 `fellOver`。
- **没有力/扭矩输出。**
- **同一条几何合理性检查也在这里跑。** 零件与最近零件的间隙 ÷ 自身对角线 > 5 报「离群」，≤24 面报「简单盒体」；`geometrySuspects` 非空说明"稳态穿透 0"可能只是因为它掉在一片空场里。不改变 pass/fail。

## 流体（`simulate_fluid`）

- **固定边界 MPM**：流体在零件边界内流动；回答流向、死区、压降趋势。
- **没有流固耦合**：流体不推动零件，零件也不因流体变形。需要两者时拆成“刚体检查 + 流体检查”，或明说限制。
- **不是工业级 CFD**：不要拿它当验收数据。

## LBM（`simulate_lbm`）

- **格点单位，不是毫米。** `latticeVelocity` 和返回的剖面都是 cell/step；换算成 m/s 需要你选长度尺度和粘度，并**写明**。保持 `latticeVelocity ≤ 0.1`（弱可压格式）；拿 `metrics.peakUx` 对 `1.5×latticeVelocity`（槽道解析峰值）。
- **发展长度随 Re 增长。** `overallStatus: developing` 表示抛物线还在形成：只引对称性和形状趋势，不引阻力/剪切数，直到 `developed`；`steps` 要随 `reynolds` 一起加。
- **Stage A 没有嵌入固体。** 只有箱壁：没有零件在流里，没有热，没有自由表面，没有多相。“绕我的零件流动”目前超出范围——直接说，不要跑一个假答案。
- **`overallStatus: diverged` 是发散，不是部分答案。**

## 应力（`simulate_stress`）

- **线弹性、各向同性。** 它不知道 FDM 的层方向——通常最先断的那条——所以峰值不是安全系数。
- **不要问“最大单元应力”**：没有这个字段。曲率/缺口边界上它会随网格细化无界增长（实测 1.002 → 1.184，填充比加权也没修好）。
- **引 `criticalDistanceMm` 处的值**（表面内推一个声明距离；实际用的距离回报为 `effectiveSampleDistanceMm`），即 `stats.peakAtDeclaredDistanceMPa`。`surfaceExtrapolatedMPa` 是更高的估计，只有同时通过自身拟合检查与跨分辨率检查（`extrapolationCrossResolutionPct`）才可引——R² 好不够：圆角上 R² 0.90 时两套网格差了 17%。`runConvergence: false` 会让所有区域不可信：稳定性检查是峰值主张的一部分。
- **先声明工况**（supports + loads；`includeSelfWeight` 默认 true，`loads` 可省略；`supports:[{ground:true}]` 固定最低 z 面，是 held face，不是摩擦/单边接触）。`loadCase` 报 `gravity` / `service` / `combined`；`selfWeight.totalWeightN` 是 ρVg，不是应力。unsupported load 是刚体模态，会被拒绝，不是糊过去。可引的积分：反力、截面 `axialForceN` / `shearN` / `momentNmm`、`areaMm2`、`secondMomentMm4`，以及 `checks.equilibriumErrorPct` / `energyBalancePct`（机器精度，不依赖答案对）。
- **`trustworthy` / `whyUntrustworthy` 决定能不能引。** 不可信的区域，位置和数值都不要引；细化 `dxMm`。薄于体素的构件会被抹厚、读起来更刚更安全；此时 verdict 是 `check`、零可信区域、`meshIndependence: drifting`——细化，或只引积分。
- **`excludeFromReport` 去掉支撑/载荷 patch**（夹块不是刀口），`method.excludedCells` 报被排除的单元数。截面切在远离支撑处：切过支撑会吞掉反力，弯矩算错（实测 22.1 vs 62.8 N·mm）；切在中跨，用 `M = F·L` 对。
- **交付看 `delivery`，不看 `verdict`。** 缺失的数不是通过；`attention` 里的几何可疑点是**探测**（去哪看），不是交付证据。
- **永不沉默**：一个区域都认证不了时，仍返回 `geometry-suspects` 层（来自几何扫描的凹角），标明是几何、不是应力。

## 都不能回答的

- 驱动/输出扭矩、功率、寿命（应力只给反力与截面力，不是安全系数）；
- 流固耦合、气动、柔性体；
- 认证级精度、安全系数；
- “用哪种工艺/材料更好”（那是业务决定，不是几何事实）。
