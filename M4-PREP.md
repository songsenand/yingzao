# M4 准备文档：MPM 流体仿真

**状态**：✅ **已交付（2026-09-25，全部案例）**——24/24 断言：直管（11.9k/38.7k 两档规模）、静水沉降（封闭腔稳定 6.1mm/s）、90° 弯管（转向流动贯通 0.63）、渲染 4+1 帧；NaN 三重加固后内核自愈
**⚠️ 2026-09-26 设计反思**：场景表达与结果通道按 **M4R** 方向修订（场景代码归 LLM、可视化一等公民），M5 随之重定义——见 **§9**；§1-§8 的内核/链路决策不受影响
**前置**：M0-M3 已完成（见 DESIGN.md §13）
**验收基线**（TODO 清单降级版）：**直管离线跑通**——粒子从入口流到出口、不穿透管壁、粒子总数守恒。粒子数不设 1 万上限，按 §1.1 实测预算取 **4-8 粒/格、默认 5 万-30 万**，工具上限 100 万
**参考插件调查**：2026-09-25，dsh-plugin-shop-catalog 2026.924.0 全量 12005 个插件

---

## 1. 架构决策：Node 侧 CPU MLS-MPM（M3 先例）

**决策**：MLS-MPM solver 用纯 TypeScript（typed arrays）跑在 Host/Node 侧，不依赖 WebGPU。

**理由**：

| 依据 | 说明 |
|---|---|
| M3 已确立先例 | 设计文档 §13.4：「rapier3d-compat 在 Node 侧 headless 运行……整个物理验证闭环 host 侧完成，headless profile 可验收」。MPM 是同构问题 |
| 验收口径已变 | TODO 清单将验收降级为「直管**离线**跑通」，不再要求实时（>30FPS 是原文验收，已放弃） |
| 性能实测（2026-09-25） | CPU 内核实测 **~0.34µs/粒子/步**（8.8k→564k 粒子线性）：8.8k=3.1ms/步、70k=23ms/步、135k=45ms/步、564k=189ms/步；600 步验收跑在 30 万粒子下 ≈ 60s，内存 ~60B/粒子（564k 全程 RSS 134MB）。**离线完全跑得动几十万粒子**，详见附录 A |
| 确定性与可测性 | CPU 浮点确定性 → 断言可重复；headless profile 直接验收，无需 puppeteer/GPU flag |
| 无新原生依赖 | WebGPU-in-Node（dawn/wgpu napi 绑定）会引入原生驱动依赖；本机虽有 AMD + Vulkan ICD，但驱动耦合不值得 |

**迁移路径（不关闭 WebGPU 大门）**：solver 内核写成无 I/O、无 UI 的纯计算模块（输入初始条件 typed arrays，步进函数步进，输出快照），后续要上浏览器交互面板时，同一内核可直接编译进 client bundle——按实测步速，浏览器主线程跑 5-15 万粒子在 20-50ms/步，交互可接受；或按同接口替换为 WebGPU compute pipeline。

**WebGPU-in-Node 备选**（不推荐，仅记录）：本机 `vulkaninfo` 可用（radeon_icd.json），napi-dawn 理论可跑；代价是原生依赖 + 驱动脆弱性 + CI 不可移植，收益仅是步速，而离线场景不需要。

### 1.1 粒子数决策（「一万」上限废止，实测依据）

原 TODO 把验收定在「1 万粒子」是保守拍脑袋值。2026-09-25 用已实现的 CPU 内核在**同一根物理管道**（48×48×200mm，dx=2mm，网格 100×24×24 格）上做了 8.8k → 564k 粒子的扩展基准（方法、完整数据见附录 A），结论：

| 发现 | 数据 | 决策含义 |
|---|---|---|
| 步进成本对粒子数线性，~0.34µs/粒子/步 | 8.8k=3.1ms、70k=23ms、135k=45ms、564k=189ms/步 | 离线 600 步验收：10 万粒子 ≈ 14s，30 万 ≈ 60s，50 万+ 也就 2 分钟——**上限完全可以放开到几十万** |
| **固定 dx 下，加粒子不提升精度** | 中段速度噪声比在 1→16 粒/格全程平坦（5.2%→5.3%）；十档轴向速度剖面逐 bin 重合 | 精度由 **dx（网格分辨率）** 决定，不由粒子数决定。加粒子的正确定位：① 填更大的域；② 配合 dx 细化（粒子数随 dx⁻³ 自然增长） |
| M5 统计受益于每格粒子数 | 单粒子噪声不降，但**格平均**噪声 ∝ 1/√(粒/格)：1 粒/格 5.2% → 8 粒/格 1.9% → 64 粒/格 0.7%，成本却线性涨 | 死区/截面流量统计取 **4-8 粒/格**为甜点（与 MPM 社区惯例 2-9 一致）；>30 粒/格无收益且压力耦合变噪（实测 30 粒/格噪声恶化到 14.6%） |
| 稳定性与内存全程无压力 | 全阶梯 nan=0、越界=0、限速触发=0；RSS 91→134MB | 可以放心把工具上限设为 100 万，配运行时间预估告警（>10 分钟提示拆分） |

**新默认**：`simulate_fluid` 粒子数不再硬编码 1 万——按 `4-8 粒/格 × 流体域体积` 自动计算，典型 5 万-30 万；`particleCount` 保留为显式覆盖，上限 1,000,000。dx 才是「更精细」的旋钮：需要更薄的壁/急弯时降 dx（成本 ≈ 8×/每减半），dx=1mm 全充满直管 ≈ 50-90 万粒子 ≈ 2-4 分钟，离线可接受。

---

## 2. M0-M3 提供的地基（直接复用）

| 设施 | 位置 | M4 用法 |
|---|---|---|
| OpenSCAD CLI 封装 | `src/host/compile.ts`：`compileStlOnly` | 管道边界 SCAD → STL |
| 网格解析 | `src/host/mesh.ts`：`parseBinaryStl`、`boundingBox` | STL → 三角面片 → SDF |
| Manifold WASM | `manifold-3d`（已依赖） | STL 修复/merge、体积参考值 |
| 物理工具模式 | `src/host/physics.ts`：`runPhysics` + keyframe + report 结构 | `simulate_fluid` 照此形状设计 |
| 关键帧图 → 附件 | `tools.ts`：`ctx.attachments.saveImages` + `finalizeContent` image block | 流体快照图直进会话 |
| 验收脚本模式 | `scripts/accept-m3.mjs`（node 直跑 src TS） | `scripts/accept-m4.mjs` |
| 报告路由模式 | `/api/cad/physics` GET → `data/physics/physics-report.json` | `/api/cad/fluid` → `data/fluid/fluid-report.json` |
| 单位与坐标系 | z-up、毫米（重力 -9810mm/s²） | MPM 同样全程 mm |

**不复用**：`renderKeyframes` 的 OpenSCAD 渲染路径——1 万粒子的 `union(sphere)` 会超时，流体快照改用纯 JS 点云渲染器（见 §4.3）。

---

## 3. 插件库重叠分析（结论：核心闭环无冲突，M4 无重叠）

### 3.1 扫描方法

- 数据源：`dsh-plugin-shop-catalog` 2026.924.0（npm，dsh-plugin-shop 官方目录），`plugins` 数组 12005 条
- 检索域 × 关键词：CAD（openscad/scad/cad/stl/3mf/step/iges/dxf/gcode/parametric/freecad/blender/cadquery）、物理（rapier/physics engine/rigid body/simulation）、流体（fluid/mpm/particle/cfd/navier/sph）、3D 渲染（three.js/webgl/webgpu/voxel/point cloud/gltf）
- 初扫 682 行命中，剔除误报（`dyna`↔dynamic、`fea`↔feature、`sim`↔simulator(iOS) 等）后逐条核对 summary

### 3.2 各功能域重叠判定

| 我们的域 | 重叠插件 | 判定 |
|---|---|---|
| SCAD 生成→编译→渲染→视觉评审闭环 | **无** | 没有任何插件做这个闭环 |
| 装配验证（布尔干涉/间隙） | **无** | — |
| 刚体物理（M3） | **无** | rapier/物理引擎关键词零命中 |
| **MPM 流体（M4）** | **无** | 唯一 "mpm" 命中是 `metaflywheel`（Meta-Problem Modeling 认知飞轮，同名无关）；fluid/cfd/particle simulation 零功能命中 |
| 版本管理 | **无**（dsh-retrace/dsh-output-gallery 等管会话产物，不管 CAD 版本语义） | — |
| 3D 查看/预览面板 | 6 个，见 3.3 | 部分重叠，均为「查看」向，可共存 |
| 视觉评审通道 | ~427 个 vision 桥接插件 | 无冲突：它们服务「纯文本模型装眼睛」，我们走原生多模态附件（M1 决策），场景不同 |

### 3.3 查看/预览域明细（重叠但不阻塞，记录备查）

| 插件 | 内容 | 与我们的关系 |
|---|---|---|
| `dsh-cad` 0.11.0 | cad_view/cad_info 工具 + Web 内嵌 3D（STL/OBJ/STEP/IGES）、2D（DXF/SVG）查看卡 | 查看能力重叠；无生成循环。若未来要 STEP/IGES/DXF 支持，其解析路线可参考 |
| `dsh-cad-viewer` 0.2.0 | 「3D模型」tab：模型库 + three-cad-viewer 工作台 + **CadQuery** agent 工具（服务端存模型） | CadQuery 是与 OpenSCAD 平行的代码建模路线，仅查看库重叠 |
| `dsh-3d-model-viewer` v0.1.1 | OBJ/STL/STEP 查看 + 转译 LLM 可读 JSON（含语义分析） | 与 `measure_part`（数值真值）思路部分重叠 |
| `dsh-cad-review` | ASCII DXF 检查 + 确定性 CAD 规则评审 | 2D 图纸域；「规则评审」思路与 M5 规则引擎形似，对象不同 |
| `dsh-print3d` | 参数化 STL、G-code、PrusaSlicer 桥、工具路径渲染 | 打印下游域；我们的 3MF/STL 导出之后若接打印可复用其桥 |
| `dsh-blender` 0.2.2 / `dsh-plugin-blender-3d` 0.2.0 | Blender 建模/布尔/导出（外部 Blender 依赖；后者自带 trimesh+manifold3d headless 桥） | 另一条建模管线；注意 `dsh-plugin-blender-3d` 同样用 manifold3d——理念趋同的旁证 |
| `pbr-render` | GLB/GLTF PBR 预览卡 | 纯展示 |
| `@deepseek-ai/dsh-qwen-mm`（官方） | Qwen 多模态 MCP 工具集，含 Blender/FreeCAD 工具 | 官方打包的外部工具集成，非闭环 |

**结论**：不引入任何上述插件——我们的面板与查看能力已内建，引入只会带来依赖冲突（多份 three）与 UI 面板竞争。dsh-cad 系列验证了一个事实：**查看是 commodity，闭环才是壁垒**。

---

## 4. 模块设计

### 4.1 新文件

```
src/host/mpm.ts            # MLS-MPM solver 内核 ✅ 已实现（纯计算，无 I/O；tsc 严格模式通过）
src/host/sdf.ts            # ✅ STL→SDF 边界链路（已实现；solidMask/solidNormal 直连 mpm.ts 网格 BC，trilinear 采样供粒子投影）
src/host/fluid.ts          # 场景组装（SDF 已拆至 sdf.ts）：粒子初始化、入口驱动、快照导出、指标
src/host/fluid-render.ts   # 纯 JS PNG 点云渲染器（node:zlib 手写 PNG）
scripts/bench-mpm-scaling.mjs  # ✅ 粒子数扩展基准（附录 A 数据来源）
scripts/smoke-mpm.mjs      # ✅ 内核稳定性冒烟
scripts/smoke-sdf.mjs      # ✅ SDF 边界链路冒烟（10 断言）
scripts/accept-m4.mjs      # 验收脚本
data/fluid/                # fluid-report.json + frames/（运行产物）
data/bench/mpm-scaling.json  # ✅ 基准结果存档
```

`src/shared/types.ts` 增加 `MPMScenario` / `MPMReport`（对齐设计文档 §6.6 接口，字段见下）。

### 4.2 solver 内核（mpm.ts）

```
状态：粒子 pos/vel (Float32Array×2, 3N)；网格 m/v (Float32Array, 3×cells)；CⲚ affine matrix (Float32Array×9)
步进（MLS-MPM，固定 dt）：
  1. P2G：二次 B 样条权重，scatter 质量/动量（APIC affine transfer）
  2. Grid：动量→速度；加重力；边界条件（见下）；速度钳制（|v| ≤ vmax 防 NaN 扩散）
  3. G2P： gather 速度 + affine C；粒子 advect
  4. 边界投影：粒子采样 SDF，若进入固体（sdf < -tol）→ 拉回表面 + 法向速度置零（自由滑移）
本构：弱可压流体（fixed corotated / 弱可压 EOS，J = det(F)）
参数预设：水（stiffness 按毫米单位制标定），hardcode 一组已验证参数 + config 可调
防护：每 K 步检测 NaN / 动能突增（数值爆炸），提前终止并在报告标注
```

**网格**：只覆盖 `bbox(管道) + 2×dx` 边界带。dx（格距）与粒距按 2:1 经验比（每格 4-8 粒子）。默认 dx=2mm、粒距 1mm。
**单位制**：毫米/s 贯穿（与 M3 一致），重力 [0,0,-9810] mm/s²；流体参数（K, μ）按 mm 单位标定后固化进预设，避免 Agent 换算。
**确定性**：无随机数；粒子初始化用确定性 JIT 网格排布 + 固定微小扰动。

### 4.3 边界与场景（fluid.ts）

- **STL → SDF**：三角面片窄带 SDF。表面三角形 → 对带内格点算点到三角形精确距离 → 符号由内部/外部判定（对管件：先 Manifold `merge()` 修复，再用奇偶射线判定或直接用 Manifold 体积包含测试初始化符号，窄带内插值）。带外按最近带值外推符号。
- **管道边界加载**：`compileStlOnly(scadCode)` 编译用户提供管件（直管/弯管/突缩管场景预置在验收脚本）。
- **粒子初始化**：`fluidInitialRegion`（box，mm）内确定性均匀排布，剔除 SDF < 0 的点。
- **入口驱动**：`inletRegion` 内粒子每步速度设为 `inletVelocity`（|v| 沿轴向分量钳制下限），出口（x > outletPlane）粒子标记 `escaped` 并**移除**（记数），保证总量守恒可审计。
- **快照**：每 `snapshotEvery` 步复制 pos（+速度标量）到快照数组；结尾导出 `frames/snapshot_XXXX.bin`（Float32 原始）+ PNG 渲染图。

### 4.4 点云 PNG 渲染（fluid-render.ts）

- 正交投影，两视角（iso `[1,-1,0.6]` + side `[0,-1,0]`），深度缓冲 z-buffer 点 splat（半径 2px 圆点），颜色按速度标量映射（蓝→红），管壁 STL 以线框/轮廓灰点叠加做参照
- 输出 2 视角并排 1 张 PNG；纯 `node:zlib` 手写 PNG（IHDR/IDAT/IEND + CRC32，~100 行），**零新依赖**
- 每帧 < 100ms；每场景取 4-6 帧（首/中/出/末 + 事件帧），走 `attachments.saveImages` → 会话 image block（M3 模式）

### 4.5 工具与路由（tools.ts 追加）

**`simulate_fluid` 工具**（形状对齐 `simulate_physics`）：

```
描述（边界编码，见 §4.6）：
  'Run an MPM fluid simulation (CPU solver, z-up, millimetres) over the given pipe/part cavity and ' +
  'return flow metrics (throughput, section velocities, conservation) plus snapshot images. ' +
  'Use when the QUESTION is about fluid or granular media: does liquid flow through the cavity, ' +
  'flow rate and dead zones, fill/drain behaviour, granular pouring. ' +
  'Rigid-body questions (stability, toppling, hinge motion, part interference) are answered more ' +
  'accurately and far cheaper by simulate_physics / validate_assembly — use those instead. ' +
  'Purely geometric questions belong to measure_part. Deformable/stress analysis of a single part is ' +
  'out of scope for both tools at present. Fluid-structure coupling is NOT supported: the solid ' +
  'boundary is fixed during the run.'

参数：
  pipeScad: string            # 管件 SCAD（含空腔；流体域 = 空腔）
  fluidRegion: {min:[x,y,z], max:[x,y,z]}   # 粒子初始区域 mm
  inlet: {plane: 'x-'|'x+'|'y-'|'y+'|'z-'|'z+', velocity: [x,y,z]}
  outletPlane?: number        # 沿入口轴的出口面坐标（escaped 判定）
  particleCount?: number      # 默认按 4-8 粒/格自动填充；显式覆盖上限 1,000,000（§1.1）
  steps?: 600                 # 默认 600
输出：
  overallStatus: 'pass'|'check'
  metrics: {
    particleCount0, escaped, active,          # 守恒审计：0 = 0 + active
    massConservationError,                    # = escaped/total（本实现定义，M5 复核）
    penetrationCount,                         # SDF < -tol 的粒子数（验收硬指标）
    outletArrivalRatio, timeToOutletSteps,
    sectionAvgVelocity: [{position, velocity}],   # 轴向 20 段（M5 直接复用）
    maxVelocity, avgVelocity,
    diverged: boolean, stepsRun,
  }
  snapshots: string[]          # 帧标签
finalizeContent：报告文本 + 4 张快照 PNG image blocks
```

**`/api/cad/fluid` GET 路由**：读 `data/fluid/fluid-report.json`（照 `/api/cad/physics` 模式）。客户端 MPM 面板**不在 M4 范围**（内核可移植，面板随「先 CPU 后 WebGPU」路线后补）。

### 4.6 验证边界与发起权（M2 几何 / M3 刚体 / M4 流体）

**三层判据**——问题的「主语物态」决定手段，与里程碑无关：

| 层 | 手段 | 回答的问题 | 判据（决定性问句） |
|---|---|---|---|
| L0 静态几何 | `measure_part` / `render_part` / `validate_assembly`（M2） | 尺寸/体积/孔数对不对？零件按给定摆位干不干涉、间隙够不够？ | 只涉及几何本身，**不需要时间演化** |
| L1 刚体动力学 | `simulate_physics`（M3，动力学行为）/ `simulate_motion`（M3.6，机构运动） | 动力学：稳不稳、倒不倒、跌落冲击、装配后重力下间隙是否保持；机构：转不转得动、行程/周期对不对、**运动过程干不干涉** | 主语是**离散刚性零件**，形状不变，接触为固-固 |
| L2 连续介质流动 | `simulate_fluid`（M4，MPM） | 流体/颗粒流不流得过、流量与死区、注液排液、灌装 | 主语是**连续介质**（流体/颗粒），或「零件空腔的通流能力」 |

**硬规则（互斥边界）**：

1. 问「零件会不会倒/碰/转」→ L1 或 L0；问「液体/颗粒会不会流/填」→ L2。主语物态是唯一判据，不看里程碑先后
2. 刚体问题走专用刚体引擎（rapier），不走 MPM——**这是工具选型，不是方法不可能**（澄清见下）
3. rapier 不回答流动问题——没有流体求解器，「通不通」不在它的输出语义里
4. **流固耦合超出两套引擎的现状**（浮力、水流推动零件、水车）：M3 与 M4 之间没有耦合通道。方法上 hybrid 刚体-MPM 耦合是成熟方向（Taichi diffTaichi 耦合示例、岩土 MPM 的刚-土接触），但我们两套引擎各自独立。遇此类需求拆成一次 L1 + 一次 L2 检查，或明示局限
5. 复合问题（水龙头：阀体开合机构 + 水道流场）→ 分两次调用，各自回答各自的问题；工具描述已写明

**能力 vs 工具范围澄清**（2026-09-25 修订，纠正初版「粒子云没有形状记忆」的错误表述）：

- **形状记忆恰恰是 MPM 的特征**：MPM 粒子携带变形梯度张量 F——正是「记忆」材料历史的量。初版把「我们的 M4 内核没有 F/弹性路径」错写成了「MPM 没有形状记忆」，特此更正
- **MPM 仿真刚体是可能的**（刚性极限本构、多材料约束投影、hybrid 刚-MPM 耦合均有先例），但作为刚体问题的常规手段不合适：刚性极限要求极小 dt（声速 ∝ √K，越硬越慢）；长时静置接触、铰链、睡眠、CCD 这些刚体语义 MPM 都得自行重建。机构类问题上专用刚体引擎**更准也更便宜**——边界依据是选型，不是做不到
- **单体内部受力/变形**：是的，这是连续介质方法的天然输出——MPM 每粒子本就计算应力（动量方程要用），弹性本构（fixed corotated / neo-Hookean）下可给**定性**应力场与变形过程（挤压、跌落变形、软体行为）。两条边界：(a) 当前 M4 内核按流体 EOS 配置（无 F、无剪切弹性），定性应力是**内核扩展**而非现成能力（F 张量 + 弹性本构，估算 1-2 天，挂 §8 候选）；(b) 设计文档 §2.2 明确不做「精确 FEA / 应力分析」——MPM 给的是趋势与分布，不是工程应力值，验收口径需按「趋势判断」另定

**LLM 决策编码（默认路径）**——边界写进工具描述，让会话 Agent 选型有据：

- ✅ `simulate_physics` 描述已加边界句（2026-09-25）：RIGID parts only / 流体问题 → `simulate_fluid` / 纯几何 → `measure_part`/`validate_assembly` / 流固耦合不支持需拆分
- ✅ `validate_assembly` 描述已加「静态几何检查；重力/运动行为 → simulate_physics」
- `simulate_fluid` 描述随 M4 落地（§4.5 文案已定稿）：fluid/granular only / 刚体问题 → `simulate_physics`
- 三者交叉引用形成闭环，Agent 无论如何看哪个工具的描述都能被指到正确的邻居

**人工主动发起（三条路径，按介入深度）**：

| 路径 | 机制 | 经 LLM？ | 状态 |
|---|---|---|---|
| ① 会话点名 | 人直接说「用流体仿真验证 v005 的流道」或「跑一下刚体仿真」——显式点名工具，Agent 只做参数装配 | 是（但人已锁定手段） | 天然可用，零代码 |
| ② Host 运行路由 | `POST /api/cad/physics/run`、`POST /api/cad/fluid/run`，body = 工具参数同构 JSON，直调 `runPhysics` / `runFluid`，结果写同一 report 文件 + 版本档案 | **否** | M4 交付（physics 侧几十行，fluid 侧随工具一起落） |
| ③ 面板按钮 | 面板「验证」区：当前选中版本 → 预设场景一键跑。流体易自动化（管件=版本 STL、流体域/入口自动推导）；刚体场景难全自动（地面/铰链在哪需要语义），先做流体按钮 + 刚体 POST 路由 | **否** | M4 交付流体按钮（~50 行）；刚体按钮后补 |

人工发起的结果闭环：报告落 `data/fluid/`（或 physics 同目录）→ 面板既有轮询显示 → 需要 Agent 分析时走既有「📸 截图到会话 + 备注」链路（已通），不依赖 LLM 发起。

**与验收的衔接**：accept-m4 增加一条——人工路径②（直接 POST `/api/cad/fluid/run`）发起的运行与工具路径产出**完全一致**的报告结构（同一 `runFluid` 入口），证明发起权与手段解耦。

---

## 5. 验收设计（scripts/accept-m4.mjs）

| 案例 | 场景 | 断言 |
|---|---|---|
| 1 直管（必过） | 水平圆管或方管，长 ~200mm，入口恒速，默认 4-8 粒/格（典型 5 万-30 万粒子，预算见 §1.1） | ① `particleCount0 === escaped + active` ② `penetrationCount === 0` ③ `outletArrivalRatio > 0.9`（跑够步数）④ 分段平均速度沿程不为零且入口段 ≈ inlet ⑤ 无 NaN/diverged |
| 2 静水沉降（辅助） | 粒子块在封闭腔内自由沉降 | 最终动能 → 稳定小值；无穿透（验本构稳定性） |
| 3 90° 弯管（可选，M5 前置） | 弯管 + 同驱动 | 跑通不发散；外侧/内侧速度差可见（M5 死区检测的输入） |
| 4 分辨率阶梯（可选，替代旧「粒子数对比」诉求） | 同直管 dx=2mm 与 dx=1mm 各一跑 | dx 减半后壁面/剖面量化指标改善可检出，成本 ≈8×（验证 §1.1「精度旋钮是 dx」结论在真管道上成立） |

验收人机分工照旧：脚本断言数值硬指标；快照 PNG 由模型判读（粒子云形态、是否穿壁、是否到达出口）+ 人复核。

---

## 6. 风险与规避

| 风险 | 影响 | 规避 |
|---|---|---|
| ~~CPU 步速不达预期~~ **已实测排除**（~0.34µs/粒子/步，30 万粒子 600 步 ≈ 60s） | — | 剩余工作：dx 细化档位的时间预估提示（>10 分钟告知拆分） |
| MPM 参数爆炸（弱可压刚度 vs dt 不匹配） | 数值发散返工 | 固化已验证预设（基准全阶梯 nan=0 证明参数窗宽）；CFL 估算入口；NaN/动能监测提前终止并在报告标 `diverged`；dt 固定不可调（config 不暴露） |
| 毫米单位下本构参数数量级陌生 | 标定耗时 | 内核在 cell 单位下运行（位置=格、速度=格/s），物理单位只在边界换算——restDensity 由初始布局自动标定（实测 0.99→62.8 全档自洽），K/μ 按 ρ 缩放 |
| SDF 符号错误 → 粒子整体被吞或全穿壁 | 验收假失败 | 用 Manifold 体积包含测试做符号仲裁；冒烟：直管中心线 SDF > 0、管壁 SDF < 0 |
| 点云渲染判读性差 | 模型误判 | 速度着色 + 管壁参照叠加 + 两视角；必要时帧内叠注入步数/比例角标 |
| 自由滑移边界导致非物理滑移 | 物理合理性 | M4「跑通即可」接受；M5 后处理时评估是否切 no-slip |
| 90° 弯管死区波动 | M5 判据漂移 | M4 只要求不发散；死区阈值判定留给 M5 |

---

## 7. 工作分解（建议顺序）

1. ~~**solver 冒烟**~~ ✅ 已完成：mpm.ts 内核（P2G×2 + grid update + G2P，APIC，弱可压 EOS，restDensity 自动标定）+ 稳定性冒烟（15.6 万粒子 120 步 nan=0、速度有界、流量贯通）+ 类型检查通过
2. ~~**SDF 管道**~~ ✅ 已完成：`src/host/sdf.ts`（STL→Manifold 水密→BVH 最近距离 + 三射线奇偶符号→逐格 SDF→solidMask/solidNormal→trilinear 采样器），冒烟 10/10（符号/解析距离/对称性/体积占用 0.95/钩子兼容），6.9 万格 260ms；附带修复全仓 `.js`→`.ts` 相对导入（脚本直跑兼容，accept-m3 回归通过）
3. ~~**直管贯通**~~ ✅ `src/host/fluid.ts`：SDF 粒子投影回推（近壁掩膜）、出口 escape+守恒审计、20 段时间平均分速、发散检测；直管 11.9k 粒子贯通到达 0.854
4. ~~**点云渲染**~~ ✅ `src/host/fluid-render.ts`：零依赖 PNG（iso+side 双视角、速度着色、壁面灰点、z-buffer），快照图可清晰判读流动
5. ~~**工具接线**~~ ✅ `simulate_fluid`（含 deriveFluidPreset 自动推导流场/入口/出口）+ `/api/cad/fluid` GET + 人工发起② `POST /api/cad/fluid/run`、`POST /api/cad/physics/run`（与工具共用 runFluidJob/runPhysicsJob，一致性 by construction）+ 路径③面板「💧 流体仿真」按钮
6. ~~**验收固化**~~ ✅ accept-m4.mjs 通过 + DESIGN.md §13.7 实施实录
7. **（可选）弯管场景**：为 M5 备好死区输入数据

M4 全部完成（含弯管/沉降/5 万级案例）。弯管时间平均分速已产出，M5 死区检测可直接消费；分辨率阶梯（dx=1mm）仍为可选项。

---

## 8. M4 之后的衔接点

- M5 后处理（`postprocess_mpm`）直接消费 `fluid-report.json` 的 `sectionAvgVelocity`、快照 `.bin`（最终帧 pos/vel）与 escaped 审计数据，`deadZones` 聚类输入为最终帧粒子
- WebGPU 交互面板：内核接口已按可移植设计（§1），面板期把同一 mpm.ts 编译进 client bundle + three.js 粒子渲染即可，无需返工
- **弹性本构扩展**（候选，需求触发）：mpm.ts 增加变形梯度 F 与 fixed-corotated / neo-Hookean 本构（`material: 'fluid' | 'elastic'` 预设），即可回答**单体定性应力/变形**问题（挤压、跌落变形、软体）——见 §4.6 澄清。估算 1-2 天；验收口径按「趋势判断」另定，不承诺 FEA 精度。是否立项取决于是否出现该类验收需求

---

## 9. 设计反思与 M4R 方向修订（2026-09-26）

**触发**：项目定位反思——插件的核心是**与人交互**和**经营一块让 LLM 能充分发挥的场地**（不是设计 API 当包工头）；MPM 的重点应是**把结果可视化**，而不是约束怎么仿真；**仿真代码归 LLM**。本节为方向修订：§1-§8 的内核/链路决策（CPU 内核、SDF、防护、三发起路径）不受影响，受影响的是**场景表达、结果通道与 M5**。

> **核心目标表述（v2 修订，同日）**：初稿把支柱 A 写成「注入 ≤10 函数的场景 API」——仍是包工头思路：发明一门 LLM 零预训练语料的迷你语言，以后每个缺的动词都要改插件。纠正为场地思路，对齐 DSH 本身的原则：**DSH 给 LLM 的是原样 bash / 原样 Python，从不给 Python 加新函数**。我们也一样：给原样 Node/TS 运行时 + 我们自己的真实模块。分界线：为控制 LLM 而设计的窄接口是包工头；真实能力的开放是场地。

### 9.1 诊断：约束的层次错位

仿真里的约束并非都错，M4 的问题是捆了两类一起处理：

| 层 | 该谁管 | M4 现状 | 判定 |
|---|---|---|---|
| 内核数值完整性（dt、钳制、NaN 守卫、单位制） | 插件 | 已管住 | ✅ 保留 |
| 资源守卫（超时、内存、粒子/步数上限） | 插件 | 部分有（工具上限） | ✅ 保留并加强 |
| 场景表达（种子、驱动、边界事件、度量） | LLM（写代码表达） | 场景语义冻结进 fluid.ts，LLM 只能填 ~8 参数 | ❌ 交还 LLM |
| 结果解读（死区、流量、建议） | LLM（看图/数据推理） | 原计划做成规则引擎（M5） | ❌ 取消 |
| 人看到什么 | 交互式回放 | 面板一行状态字 | ❌ 重做 |

对照自家原则：v2.3 原则 1「模型输出意图/引用，几何引擎解析真值」与 M1 先例（视觉循环原生化；OpenSCAD 从不约束「怎么建模」，只给语言 + 编译 + 渲染 + 测量）。**M4 是第一个失守的里程碑。**

### 9.2 三个病灶（代码证据）

1. **`simulate_fluid` 是表单，不是语言**：单入口带/单出口面/盒形种子/escape 审计冻结在 `fluid.ts` 源码；双入口、计时阀门、倾倒注液、搅拌、排空——任何一种都要改插件源码
2. **可视化是验收副产品，不是产品**：面板上人跑完几分钟仿真只看到一行字（到达率/穿透/粒子数）；快照 4 帧只 `frames.slice(-2)` 留 2 帧；`tools.ts` 里 `void snapshots` **丢弃全量 posMm/speedMmPerSec**——LLM 想写死区分析无米下锅。M4-PREP §3.3「查看是 commodity，闭环才是壁垒」在 M4 内部被读成了「可视化可以省」——闭环恰恰**由**可视化构成（LLM 的眼睛 + 人的眼睛），没有眼睛的闭环是盲跑
3. **规则引擎把解读也硬编码**：`maxV > 3×avg → 建议平滑过渡` 是 LLM 一句话的事，做成 if-else 还在误报时无法自辩

### 9.3 M4R 两支柱（v2：场地思路）

**支柱 A：库即 API，场地不设限**

- **库 = 我们自己的 src**：mpm.ts / sdf.ts / mesh.ts / fluid-render.ts / compile.ts 本来就是纯 TS 模块——不新设计 API，把它们**作为库开放**（可从工作区 import）。狗食原则：插件能调的，LLM 就能调；一套代码，两个消费者（Host 工具 + LLM 脚本）
- **执行 = 真实运行时**：会话 agent 本就有 shell（dsh 会话标配）——写脚本、`node/tsx` 直跑、import 库、自己看图、改、再跑，零新执行器，与会话里跑任何命令同级风险；个别无 shell 的 profile 才需要一个薄 `run_script` 工具（仍不是场景 API）。资源守卫（超时/内存/发散检测）只加在人工按钮路径与长任务守护上
- **眼睛也在库里**：fluid-render.ts 是纯函数——参数化扩展（视角/剖切/着色通道/叠 STL 轮廓）做成库级能力，LLM import 直用；**真正需要工具的只剩插件不可替代的服务**：图进会话（attachments）、版本库读写、面板数据服务、人工守卫运行器
- **文档 = 源码 + JSDoc + `examples/` 示例脚本**：LLM 是编码 agent，会直接读源码；不写「API 规范」
- `simulate_fluid` **降级为示例脚本**（等价回归基准），不再是「工具」的必要形态
- 演进方式改变：弹性本构、移动边界、双入口——从「内核扩展候选/工具 schema 变更」变成**给库加函数**，工具层纹丝不动

**支柱 B：可视化一等公民**

- 人的通道：MPM 面板 v2——three.js Points 回放，帧 `.bin` 经 Host GET 路由惰性加载（与 STL 同模式）；时间轴 scrub/播放/速度着色/剖切平面；跑完自动进回放。既有「截图→标注→会话」链路接上即闭环：**人指画面 → LLM 改脚本重跑**
- LLM 的通道：库级渲染参数化 + 帧 `.bin` 直接读——分析代码有米下锅；图进会话走既有 attachments 通道

### 9.4 M5 重定义

~~截面流速/守恒/死区/规则引擎~~ → 插件只供**数据（帧落盘 + 访问）+ 渲染 + 面板**；死区聚类、截面流量、守恒复核、改进建议全部由 LLM 写分析脚本消费帧数据或直接判读渲染图完成。

### 9.5 保留清单

mpm.ts / sdf.ts 不动；内核数值防护（固定 dt、钳制、NaN 三重加固）不动；三发起路径与 runFluidJob 共用入口不动；验收硬指标断言哲学（守恒/穿透/到达）不动。

### 9.6 诚实代价与对策

- **库卫生成为第一义务**：库 = 自己的 src，文档债就是代码债——JSDoc、`examples/`、模块边界干净（fluid.ts 的封闭场景语义要拆成库级原语：种子/驱动/度量从 `runFluid` 分离），否则 LLM 只能对着封闭函数发呆。这不是给 LLM 设计专用 API，是任何库都欠的功课
- **LLM 脚本可能不收敛/跑偏** → LLM 自跑路径由会话自身的观察与审批兜底（与跑任何命令同级）；人工按钮路径保留守卫运行器（超时/内存/发散检测，沿用内核三重加固）
- **表单入口对最常见场景摩擦最低** → 不删，降级为示例脚本（accept-m4 24 断言作为库的等价回归基准照跑）

### 9.7 工作分解与验收方向（~3-4 天）

1. 库化拆分：fluid.ts 封闭场景语义 → 库级原语（种子/驱动/度量分离），模块可从工作区 import（0.5-1d）
2. 帧 `.bin` 落盘 + manifest + GET 路由（0.5d）
3. 渲染参数化进库（视角/剖切/着色通道，LLM import 直用，面板复用同一函数）（0.5d）
4. `examples/` 场景脚本（含 simulate_fluid 等价脚本）+ MPM 面板 v2 回放（1-2d）
5. M5 重定义落文档 + accept 回归（0.5d）

**验收方向**：① LLM 全程用自有 shell + 库跑通一个表单表达不了的场景（计时阀门或双入口），无专用工具依赖；② 面板回放人工核判；③ LLM 消费帧数据写自己的死区分析；④ accept-m4 24 断言以示例脚本等价性回归通过。

### 9.8 支柱 B 实施实录（2026-09-26，当日交付）

- 轨迹/帧数据落盘 + 6 条路由 + 面板三 Tab（模型/动作回放/流体回放）全链路完成，明细见 DESIGN.md **v2.5**
- 意外收获：修复 physics.ts keyframe 终态 bug（原循环后采样，全部关键帧同帧）
- 冒烟 `scripts/smoke-playback.mjs` 7/7；回归 accept-m3 / m36 / m4 全过；面板人工复核待真实使用
- 待办（支柱 A，场地化库化拆分）：fluid.ts 场景语义拆原语 + examples/ 脚本

---

## 附录 A：粒子数扩展基准（实测 2026-09-25）

**方法**：同一物理管道（48×48×200mm，dx=2mm → 求解网格 100×24×24 格，流向 +x），入口带恒速驱动（50mm/s），出口回收（transit 计数）。粒子晶格间距 s 从 1.0 → 0.25 格递减 → 粒子数 8.8k → 564k（1 → 64 粒/格）。dt=0.004s、vmax=60 格/s、重力 -98.1mm/s² 全程一致；K/μ 按 restDensity 缩放保持跨档可比。内核：`src/host/mpm.ts`（P2G 质量+动量 → P2G 应力 → 网格更新+边界 → G2P APIC，二次 B 样条，公式对齐 three.js `webgpu_compute_particles_fluid` / WebGPU-Ocean）。脚本：`scripts/bench-mpm-scaling.mjs`，原始数据 `data/bench/mpm-scaling.json`。

**性能**（每步耗时 p50，Node v26，本机）：

| 粒子 | 粒/格 | ms/步 | steps/s | 600 步验收耗时 | RSS |
|---|---|---|---|---|---|
| 8,820 | 1 | 3.1 | 326 | 2s | 91MB |
| 33,759 | 4 | 11.4 | 87 | 7s | 101MB |
| 70,560 | 8 | 23.4 | 43 | 14s | 107MB |
| 135,200 | 16 | 44.9 | 22 | 27s | 114MB |
| 261,950 | 30 | 88.3 | 11 | 53s | 119MB |
| 564,480 | 64 | 189.2 | 5 | 114s | 134MB |

线性拟合 ≈ **0.34µs/粒子/步**；内存 ≈ 60B/粒子（+Node 基线 ~90MB）。

**效果**（中段截面轴向速度）：

| 粒/格 | 单粒子噪声 σ/μ | 格平均噪声（M5 统计口径） | 备注 |
|---|---|---|---|
| 1 | 5.2% | 5.2% | 已足够平滑 |
| 4 | 5.2% | 2.6% | |
| 8 | 5.3% | 1.9% | 甜点区 |
| 16 | 5.3% | 1.3% | |
| 30 | 14.6% | 2.6% | 无收益且开始恶化（K∝ρ 缩放的刚度耦合；剖面形状也已偏离——该档物理时间不足 1 次贯通，剖面含瞬态） |
| 64 | 9.4% | 0.7% | 同上，统计口径收益被成本抵消 |

关键证据：**1→16 粒/格的十档轴向速度剖面逐 bin 重合**（如 s=1.0 与 s=0.4 的 profile 差 <0.5 格/s）——固定 dx 下粒子数对解的精度贡献饱和，精度由 dx 决定。稳定性全阶梯无瑕疵（nan=0、越界=0、限速触发=0、maxSpeed ≤ 52 < 60 上限）。

**结论**（已并入 §1.1）：步进成本线性、离线预算宽裕 → 粒子数上限放开到几十万；精度旋钮是 dx 不是粒子数；M5 统计甜点 4-8 粒/格。

**基准自身注意事项**（照 M3 教训记录）：① 高密度档（30/64 粒/格）总步数少于贯通所需，剖面含瞬态成分，其「噪声恶化」部分是 K∝ρ 缩放与瞬态的合成，不影响主要结论（噪声平坦性在 1-16 档成立）；② minWallMargin 恒为 0 是 clamp 允许粒子贴壁所致，穿透判定应看越界计数（全档 0）。
