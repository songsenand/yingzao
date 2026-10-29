# 实验报告：接触面锐角的注意力引导

## 目标

验证两件事：

1. 新加的 `simulate_stress` 自重 + `supports:[{ground:true}]` 在“零件放在地面”的工况下能否正常跑通；
2. 对“接触面上存在锐角”的零件，注意力是否能指向正确的危险位置。

## 假设

- 几何/构造问题（锐角）应由 `scan_attention` 回答，不依赖载荷；
- 强度问题（应力集中）应由 `simulate_stress` 回答，且只有当载荷路径经过锐角时才会在锐角处出现热点；
- 两者可以各自指向不同位置；同一位置同时被两者怀疑，才是强信号。

## 方法

测试件（`examples/attention-contact-corner/`）：

- **V 缺口块**：80×40×40，底面切 37° V 缺口，根部 `(40,20,30)`，两个底面脚接触地面。`.scad` 见 `v-notch.scad`。
- **L 形块**：80×40×10 base + 10×40×80 立墙，内凹直角 `(10,20,10)`，底面接触地面。`.scad` 见 `l-bracket.scad`。

三次测量：

1. `scan_attention`：默认阈值 100°，以及 `concaveMinDeg:80` 对 90° 角；
2. `simulate_stress`：`supports:[{ground:true}]`，`includeSelfWeight:true`，无外载，`dxMm:2`，`mode:'scan'`；
3. `simulate_stress`：固定 x-min 面，x-max 面加 `[0,0,-10] N`，`includeSelfWeight:true`（弯载工况），`dxMm:2`，`mode:'scan'`。

## 结果

### 1. 几何检测

| 测试件 | `concaveMinDeg` | 结果 |
|---|---:|---|
| V 缺口（37°） | 100（默认） | 报 `(40,20,30)`，二面角 143°、void 37°、`likely-defect` |
| L 形（90°） | 100（默认） | **不报**（`sharp_concave_edges:0`） |
| L 形（90°） | 80 | 报 `(10,20,10)`，90°/void 90°/material 270° |

默认 100° 的设计是“只报比直角更尖的 V 形缺口”；直角不算“锐角”，所以 L 形不报不是漏检。要覆盖直角，显式传 `concaveMinDeg:80`。

### 2. 自重 + 地面

V 缺口件：

- `loadCase=gravity`；`selfWeight.totalWeightN=1.403091 N`；`equilibriumErrorPct=2.74e-8%`。
- 应力峰值（`von-mises` 层）：`(29,1,1)`、`(29,39,1)`、`(51,39,1)`、`(51,1,1)`，值约 **0.001 MPa**——在**接触/缺口开口边缘**。
- 缺口根部采样 `(39,19,29)` 只有 **0.0002 MPa**；开口边约 **0.0008 MPa**。
- 应力工具的 `geometry-suspects` 层仍报 `(40,20,30)`，所以整体注意力没有沉默。

解释：自重下缺口根部是自由表面，载荷主要由两个接触脚和缺口开口边缘承担；根部不是应力热点。接触边峰值有一部分是“地面夹持面”的理想化产物，`excludeFromReport` 可去掉，但去掉后峰值只上移到 z≈3，仍不在 z=30 的根部。

### 3. 弯载

V 缺口件：

- `loadCase=combined`；`totalWeightN=1.404842 N`；`equilibriumErrorPct=7.37e-8%`。
- 应力峰值沿缺口根部：`(39,3,27)` **0.462 MPa**、`(39,33,29)` 0.344、`(39,27,29)` 0.341、`(39,21,29)` 0.339、`(39,11,29)` 0.338。
- `geometry-suspects` 层同时报 `(40,20,30)`。

这时应力与几何两个问题在根部**相互呼应**，说明应力层在载荷路径经过锐角时能正确指过去。

### 3b. 纯自重悬臂（关键：只受重力）

把 V 缺口块固定 x-min，**不加任何外载**，只开自重：

- `loadCase=gravity`；`totalWeightN=1.406205 N`。
- 应力峰值沿缺口根部：`(39,3,27)` **0.019 MPa**、`(39,33,29)` 0.014、`(39,27,29)` 0.013、`(39,21,29)` 0.013、`(39,11,29)` 0.013、`(39,39,29)` 0.012。
- `geometry-suspects` 层同时在 `(40,20,30)`。

**这就是问题要的答案：只靠重力，悬臂的 V 缺口根部就是应力峰值，注意力指向根部。** 之前“地面支撑 + 自重”没有出现根部热点，是因为那种工况下自重是压缩、根部不在弯曲载荷路径上；悬臂工况下根部在弯曲路径上。

### 4. 融合图（`analyze`）

对 V 缺口件跑 `analyze`（默认 `scan_attention` 阈值 100°）：

- `peaks` **只有一个**：`(40,20,30)`，`risk=1`，`layers=["reentrant-corner"]`；
- `layers`：`reentrant-corner:1`，`wall:24`；
- `partNotes`：24 个 print-overhang 面、面积 0、最大壁厚 40mm、24 个厚壁采样；
- `notMapped: []`。

也就是说，**融合图把注意力准确指到了 V 缺口根部**，没有被壁厚/悬垂的整件事实淹没。

### 5. 融合 strength 层（`analyze` + `stressRunId`）

V 缺口件 + 纯自重悬臂 stress run `r010`：

- `cellMm:8`：融合图有 1 个角峰 `(40,20,30)`（risk 1，`reentrant-corner`）+ 6 个 `strength-concentration` 峰（risk 0.5，沿缺口根部 y=3..39）；`layers.strength` 有 14450 个采样，但绝对 `strength` 没有峰——0.019 MPa 远低于 10 MPa warn 线。
- `cellMm:16`：角峰与最近的应力集中峰合并，**顶部峰 `(40,20,30)`，risk 1，count 2，layers `reentrant-corner` + `strength-concentration`**。
- `stress` 元数据：`runId=r010`、`loadCase=gravity`、`warnAt=10`、`badAt=16.6667`、`concentrationPeaks=6`。

这表示融合图现在同时保留两种强度问题：

- **绝对强度风险**：0.019 MPa 远低于许用，所以 `strength` 层静默；
- **相对应力集中**：局部峰以 `strength-concentration` 的 0.5 进入 top-K，明确是“看这里”，不是“会断”。

### 6. 非平面布尔缝 + mesh health（2026-10-29 追加）

先量了“闭合锐边环”的规模，判断会不会刷屏：

| 件 | 100°（默认） | 80° |
|---|---:|---:|
| 果糖 B03 | 0 凸 / 0 凹 | 26 / 2 |
| 果糖 C3 | 0 / 0 | 12 / **44** |
| 天平盘 | 0 / 0 | 7 / 7 |

80° 时 C3 的 44 条凹环是球-球键颈，全是正常几何。**所以只报“非平面”闭合环**，并把 seam 限制在最长 8 条（总数在 `stats.nonplanar_seam_loops`）。

验证：

- 侧面打孔的圆柱（`cylinder-side-hole`，v009）：`closed_sharp_loops=4`，`nonplanar_seam_loops=2`，两条 `boolean-seam` 在 `x=±9.77`，二面角 110°、平面度偏差 0.23mm；`analyze` 里是 2 个 `risk 0.5` 的 look。
- 两个分离方块（`multi-body-probe`，v010）：`scan_attention` 报 `multi-body` 在 `(25,5,5)`；`analyze` 的峰 `risk 1`、layer `multi-body`。
- 平面孔/键颈（B03/C3/盘，80°）**不报 seam**；自检 `scripts/scan-seam-selftest.py` 在侧面孔上 6/6 通过，在双方块上确认 `multi-body`。

## 分析

- **锐角是几何问题，不是必然的应力热点。** 自重工况下根部应力低是诚实的；硬让应力层指向根部反而是错的。
- **接触/支撑边缘会主导自重工况的 top-K。** 地面夹持是理想化边界，接触边峰值一部分是伪影、一部分是真实接触应力；应作为“接触/边界问题”单独标注，不能直接当成零件本体的危险点。
- **90° 直角默认不报**是阈值语义，不是 bug；要覆盖直角用 `concaveMinDeg:80`。
- **两个问题可以分开指向不同位置**：自重工况下几何指根部、应力指接触开口；弯载下两者在根部重合。这正是“独立但可相互呼应”的预期行为，不应该强行合成一个 top-1。
- **seam 是低刷屏信号，不是全覆盖**：它只抓“闭合 + 非平面 + 锐边”的布尔缝；平面孔、90° 口袋、键颈都不报。C3 的 44 条键颈在 80° 下全是平面/圆环，正好被过滤掉。
- **mesh health 是现成的**：`multi-body` / `non-manifold` / `degenerate-faces` 本来就由 `scan_attention` 返回，`analyze` 会自动融合；这次只是补了命名、测试和说明。

## 遇到的问题

- 第一次用 90° L 形角测试，`scan_attention` 返回空；原因是默认阈值 100° 只收更尖的 V 形，不是检测失败。
- 第一次生成 V 缺口时 polyhedron 面朝向错误，切出来仍是 12 面的方块；改用 `linear_extrude + rotate` 后得到 24 面、1 条内凹棱链。
- 自重工况的应力峰值在接触边，容易被误读为“根部安全”或“接触边是缺陷”；需要把支撑/接触 patch 的语义说清楚。
- `excludeFromReport` 去掉开口角后，峰值只上移到 z≈3；根部仍低，说明不是单纯的支持伪影。

## 产物列表

**代码与脚本：**

- `examples/attention-contact-corner/v-notch.scad` —— 37° V 缺口块。
- `examples/attention-contact-corner/l-bracket.scad` —— 90° L 形块。
- `examples/attention-contact-corner/README.md` —— 夹具说明与结果摘要。
- `experiments/scripts/contact_corner_attention.mjs` —— 生成两个件、跑 scan 与两种 stress 工况，打印坐标/峰值。

**数据：**

- 生成语料在 `examples/attention-contact-corner/cad-data/`（已 gitignore）。
- 本次 run：V 缺口自重 `r004`；V 缺口弯载 `r006`；L 形自重 `r001`/`r002`。

**运行命令：**

```bash
DSH_CAD_PYTHON_ROOT=/home/songsenand/Project/ToyMarker/.tmp-motion-rerun/runtime \
  node experiments/scripts/contact_corner_attention.mjs
```

**环境依赖：**

- Node 26（直接跑 `.ts` 源，依赖类型剥离）。
- OpenSCAD（`generate_part`）。
- Python worker 运行时；`DSH_CAD_PYTHON_ROOT` 指向可写 runtime。

## 结论与下一步

- **能正常工作**：自重 + ground + 锐角检测都能跑；37° V 缺口被正确指出；弯载下应力与几何在根部重合。
- **融合图正确**：`analyze` 在 V 缺口件上只有一个峰 `(40,20,30)`（risk 1，`reentrant-corner`），没有被壁厚/悬垂整件事实淹没。
- **纯自重悬臂下，应力层自己就指向 V 缺口根部**（0.019 MPa），不需要外载——这是对“重力场景能否监测弯载 V 缺口”的直接肯定。
- **不能承诺“锐角一定同时是应力热点”**：地面支撑的自重下不是（压缩，根部不在弯曲路径）；悬臂自重下是；应力要载荷路径经过锐角才会指过去。
- **地面接触边会主导应力 top-K**：应把支撑/接触 patch 标成单独问题，或默认从“零件本体风险”里排除；不要把它和锐角根部混成一个 top-1。
- **90° 直角默认不报**：要覆盖直角，传 `concaveMinDeg:80`；是否改默认值需要单独拍板（改默认会让所有直角件都多一条 suspect）。
- 已接：`analyze` 支持 `stressRunId`，strength（绝对风险）与 `strength-concentration`（相对集中，0.5 look）两层；`cellMm:16` 可把角峰与最近的应力集中峰合并为 `count=2`。
- 下一步：支撑/接触 patch 单独一层，不参与“零件本体”的 top-K；给 `analyze` 暴露 `concaveMinDeg`（直角）；UI 默认 cell 大小。
