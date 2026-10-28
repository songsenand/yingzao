# BUILD —— β-D-吡喃葡萄糖球棍模型（制造与验证记录）

> 设计已冻结：`spec/design.md` 与 `spec/parts/*.scad` 未改动。本文只记录**制造性/装配/运动**这一步实际跑出来的结果。
> 语料根：`examples/ball-and-stick/glucose-molecule/cad-data`（11 个版本 / 7 个零件 / 31 个运行）。
> 子智能体的会话 cwd 是仓库根，版本与运行最初落在根 `cad-data`（当时符号链接到 `examples/toy-balance2`），
> 交付前用 `scripts/migrate_corpus.py` **整体迁到本目录并恢复了原语料**；版本号/运行号保持不变，
> 所以本文引用的 vNNN / rNNN 全部有效。根目录的 `cad-data`、`assembly` 符号链接已改为指向本示例。

## 1. 一句话结论与交付清单

7 个零件已按冻结的 SCAD 注册为版本（48 件 / 7 种）；单件打印性**全部被 `fdm-pla-0.4` 的 1.2 mm 壁厚规则排除**
（预期内的弹性卡脚与球口环带，见 §3）；六元环子装配 **37/37 接口判定 pass、0 未声明近邻**（r097）；
代表性子装配 **0 干涉、0 过紧**（阈值 1e-6 mm，r098）；插拔行程只出现**卡珠挤过喉口的 6 次 0.769 mm³ 挤压**，
就位与拔出位姿 **0 干涉**——但刚体引擎据此把该 run 判为 `fail`（引擎边界，见 §6）；
**整机 48 节点 / 145 接口契约已判定：145/145 pass、0 未声明近邻（r100）**。
此前 816 s 的超时来自 O(n²) 近邻扫描；AABB 宽相位后同一契约约 10.2 s，工具预算内完成。
因此本版可以交付"整机契约 + 零件/子装配"的证据；整机 **1128 对** `validate_assembly`
仍是设计方的离线 manifold 复核，不是本次工具证据（§4.2 / §6）。

| 零件（文件名） | 中文零件名 | 版本 | BOM 数量 |
|---|---|---|---|
| `atom_C.scad` | 碳原子 C | **v031** | 6 |
| `atom_O.scad` | 氧原子 O | **v032** | 6 |
| `atom_H.scad` | 氢原子 H | **v033** | 12 |
| `stick_7.2.scad` | 键棒 7.2 (C-O 环) | **v038** | 2 |
| `stick_6.6.scad` | 键棒 6.6 (C-C) | **v039** | 5 |
| `stick_5.2.scad` | 键棒 5.2 (C-H/C-O) | **v040** | 12 |
| `stick_4.8.scad` | 键棒 4.8 (O-H) | **v041** | 5 |
| **合计** | **7 种** | — | **48 件** |

**第一版棍 v034–v037 保留在历史里**（不删除）：那四件的开缝从尖端 0.4 mm 处才开始，尖端留了一圈实心端盖，
四瓣卡脚在自由端又被连成一片（等于两端固支），卡珠压不动；缝端面与导入锥面之间还夹出一条 0.038 mm 的薄唇。
v038–v041 的开缝改为**从尖端 0.0 起**（`cube` 的 z 起点 0.4→0、高 2.4→2.8 mm），四瓣才是真正的悬臂。

## 1.5 一个容易被误读的视图（r098 的装配静置视图）

r098 的视口截图是 **5 件子装配**（C1 + 4 根键），不是整机。它看起来"歪"有三个原因，都不是几何错误：

1. **四面体本身就不对称**：C1 的 4 个孔两两 109.47°，其中 3 个朝上（与竖直成 70.53°）、1 个正朝下；
   再加上键长不同（22 / 22 / 20 / 18），任何一台相机都不能把它拍成对称的。
2. **视口按球的包围盒（17.18 mm）取景**，广角近距 → 圆柱会被透视拉成锥形、看起来"斜"。
3. **球的紫色上那团暗红斑是 z-fighting**：台肩面与定心平台的间隙正好是 0.00 mm，两个面共面时
   渲染器会闪色。它是"零间隙接触"的显示副作用，不是缝隙。

实测（用位姿算，不用声明的方向）：4 条键的 peg 轴与 socket 轴夹角 180.000°（共线、朝内），
轴线偏移 0.00003–0.00004 mm，台肩面到定心平面 0.0000 mm，peg 尖端入孔 3.200 mm（孔底还差 0.20 mm）。
`renders/interface_section.png` 是同一接口的真剖面（左 1:1、右约 3 倍）。
**勘误**：先前做过一张 `interface_xray.png`，棍被放低了 3.2 mm（把节点中心算成了 L/2 而不是
L/2+3.2），看起来"台肩在平台上"其实是把 peg 插穿到孔底之外——该图已删除，换成这张由
`spec/make_figure_section.py` 计算、并带数值自检（卡脚壁 0.40：剖面 u∈[2.10,2.50]）的剖面图。

## 2. 几何真值（`measure_part`）

| 版本 | 零件 | 三角面 | 闭合 | 连通体 | 体积 mm³ | 表面积 mm² | 包围盒 mm |
|---|---|---|---|---|---|---|---|
| v031 | 碳原子 C | 9306 | true | 1 | 2258.187 | 1230.980 | 17.179 × 17.164 × 16.480 |
| v032 | 氧原子 O | 6486 | true | 1 | 1940.191 | 951.606 | 15.941 × 15.981 × 15.232 |
| v033 | 氢原子 H | 4596 | true | 1 | 807.666 | 522.375 | 11.986 × 11.986 × 11.093 |
| v038 | 键棒 7.2 | 2620 | true | 1 | 270.786 | 408.414 | 6.200 × 6.200 × 13.600 |
| v039 | 键棒 6.6 | 2620 | true | 1 | 252.694 | 396.731 | 6.200 × 6.200 × 13.000 |
| v040 | 键棒 5.2 | 2620 | true | 1 | 210.481 | 369.471 | 6.200 × 6.200 × 11.600 |
| v041 | 键棒 4.8 | 2620 | true | 1 | 198.420 | 361.682 | 6.200 × 6.200 × 11.200 |

按 BOM 数量求和：**40 205.174 mm³**（6×v031 + 6×v032 + 12×v033 + 2×v038 + 5×v039 + 12×v040 + 5×v041）。
若 PLA 取 1.24 g/cm³，约 **49.9 g**（密度是假设值，不是测量值）。设计文档同口径。

## 3. 单件打印性（`check_printability`，profile `fdm-pla-0.4`）

每个版本都返回了完整回复；下表是回复原文的数值，run 编号见括号。

| 零件 | 版本 (run) | 顶层 verdict | profile 判定 | 排除证据（rule / 实测 vs 要求 / 位置） | 薄区（面积 / 占比） | 朝下悬垂面 |
|---|---|---|---|---|---|---|
| 碳原子 C | v031 (r089) | `difficult` | **`excluded`** | `wallMinMm` 0.50 mm < 1.2 mm @ [-6.73, -3.96, 0.48] | 15/621 采样，2.4 mm²（0.19%） | 121.4 mm²，z ∈ [-7.6, 7.2] |
| 氧原子 O | v032 (r090) | `difficult` | **`excluded`** | `wallMinMm` 0.50 mm < 1.2 mm @ [7.29, 0.11, 0.83] | 11/649，1.7 mm²（0.18%） | 84.7 mm²，z ∈ [-7.1, 6.6] |
| 氢原子 H | v033 (r091) | `difficult` | **`excluded`** | `wallMinMm` 0.37 mm < 1.2 mm @ [3.35, 0, 4.6] | 7/657，0.5 mm²（0.10%） | 32.8 mm²，z ∈ [-5, 4.6] |
| 键棒 7.2 | v038 (r092) | **`excluded`** | **`excluded`** | `wallMinMm` 0.223 mm < 1.2 mm @ [2.06, -0.4, -6.4] | 392/655，167.7 mm²（**41.05%**） | 37.3 mm²，z ∈ [-4.2, 6.4] |
| 键棒 6.6 | v039 (r093) | **`excluded`** | **`excluded`** | `wallMinMm` 0.223 mm < 1.2 mm @ [2.06, -0.4, -6.1] | 392/655，167.9 mm²（42.32%） | 37.3 mm²，z ∈ [-3.9, 6.1] |
| 键棒 5.2 | v040 (r094) | **`excluded`** | **`excluded`** | `wallMinMm` 0.223 mm < 1.2 mm @ [2.06, -0.4, -5.4] | 392/655，167.9 mm²（45.45%） | 37.3 mm²，z ∈ [-3.2, 5.4] |
| 键棒 4.8 | v041 (r095) | **`excluded`** | **`excluded`** | `wallMinMm` 0.223 mm < 1.2 mm @ [2.06, -0.4, -5.2] | 392/655，167.9 mm²（46.43%） | 37.3 mm²，z ∈ [-3, 5.2] |

读法（重要）：

- **这是预期内的排除，不是隐藏的失败。** 球的 0.50 / 0.37 mm 是 socket 口那一圈 0.9 mm 深平台在球面上留下的
  环带（设计 §5 预判的"球口 0.56 mm 环带"）；棍的排除来自 **0.4 mm 卡脚壁 + 0.6 mm 开缝**，弹性件本来就只有
  1–2 圈线宽，不是承力壁。**没有为了让检查变绿而改模型或换阈值。**
- 棍的最薄采样值是 **0.223 mm**，比名义 0.40 mm 更小：位置在卡脚靠近尖端、孔（Ø4.2）与开缝相交的转角处，
  是采样打到的真实薄边；同一批零件 **41–46% 的表面**低于 1.2 mm，因为四瓣卡脚 + 两道开缝本身就占了卡脚
  外表面的大部分。这个占比说明它是"成片的弹性薄壁"，不是"实心件收敛到棱线的薄边"——按工具的定义，
  它落进排除是自洽的。
- 朝下悬垂面（37.3–121.4 mm²）只进入 `findings`，**不构成 profile 的排除证据**（该档的排除 witness 只有
  `wallMinMm`）。悬垂需要支撑或改打印朝向；球按自身 +Z 姿态打印，泪滴排屑方向是按这个姿态算的，
  翻过来打会失效。
- `notApplicable`：`draftMinDeg`（FDM 无脱模）、`escapePassageMinMm`（无被埋介质）、`toolRadiusMm`（非切削）。
  `unevaluable`：`tolMm`（需要外部声明的要求）、`surfaceRaUm`（不是几何事实）。profile 里的
  `featureMinMm / gapMinMm / bridgeMaxMm / holeAspectMax` **本工具不评估**，所以别把它们当"已通过"。

工具状态注记：首轮 7 次调用都返回
`Error: check_printability: … missing required property "value.surfaceAreaMm2"` ——
worker 的返回体漏了 schema 里 required 的 `surfaceAreaMm2`。已在 `python/cad_worker/worker.py`
补上该字段，并重启 worker（旧进程缓存旧代码，用一次 120 s 的 `check_assembly` 超时把它杀掉）后，
7 个版本全部正常返回。上表是修复后的结果。

## 4. 装配契约（`check_assembly`）

### 4.1 六元环子装配 —— 可判定清单 `assembly/assembly_ring.json`（r097）

12 节点（O5、C1–C5 + 6 根环上键棒），**37 接口**：12 条 `coaxial` + 12 条 `distance` + 12 条
`diameter-match` + 1 条 `motion-clearance`。

```
overallStatus: pass      judgement: not-excluded
summary: {interfaces: 37, pass: 37, hardViolations: 0, intentFlags: 0, skipped: 0, undeclared: 0}
hardViolations: []   skipped: []   undeclared: []
```

- **skipped：0 条**（没有"判不了"的接口，也没有缺失容差）。
- **undeclared：0 对**（66 对近邻扫描里没有未声明的接触）。
- `motion-clearance`（`行程-B02-a`，C1.sock1 ↔ B02.pegA）的判定是 **pass，但只判了静态距离**：
  `measured 0.0001 mm`，detail 原文写着
  `— motion half NOT evidenced: run simulate_motion over the travel and cite it with params.runId`。
  即：**接口位置对，但"行程那一半"没有被这条清单认领**（清单按 §6 的决定不引用 r084 作为通过证据）。

### 4.2 整机清单 `assembly/assembly.json` —— 145/145 pass（r100）

48 节点 / **145 接口**（24 根棍 × 2 端 × 3 条 + 1 条 motion-clearance）。AABB 宽相位后，
`check_assembly` 在 120 s 预算内返回：

```
r100 · pass · 145 接口 · 通过 145 · 硬冲突 0 · skipped 0 · 未声明 0
```

此前两次以绝对路径调用都超时：

```
Error: python worker assembly_contracts timed out after 120000 ms
```

原因不是清单写错，而是 **O(n²) 近邻扫描的计算量**：1128 对零件，每对做一次 Manifold 布尔 + 两次
采样式最近距离（10 对 7.2 s → 1128 对约 816 s）。**这是工具限制，不是几何不合格**。
2026-10-28 的 AABB 宽相位把 48 节点契约降到约 **10.2 s**（commit `8963118`），整机契约因此
第一次在工具内跑完；r100 是整机契约证据，r097/r099 仍是六元环子装配的聚焦证据。

> 整机 **1128 对** `validate_assembly` 仍是设计方的离线 manifold3d 复核
> （0 干涉，**该数字不是本次 `check_assembly` 的 145 条接口证据**）。

## 5. 代表性子装配的间隙（`validate_assembly`）

取 C1（v031）+ 与之相连的 4 根棍（B01 v038、B02 v039、B08 v040、B10 v040），位姿全部照抄
`spec/instances.json`。三次运行只改 clearanceThreshold：

| run | 阈值 mm | 结论 | 干涉 | 过紧 |
|---|---|---|---|---|
| r082 | 0.75（默认） | fail | **0** | 2 |
| r096 | 0.02 | fail | **0** | 2 |
| r098 | 1e-6 | **pass** | **0** | **0** |

**这 2 个"过紧"是台肩面落在定心平台上的面接触，不是间隙不足。** 精确数值（r082/r096/r098 一致）：

| 对 | 干涉体积 mm³ | 最小距离 mm | 解释 |
|---|---|---|---|
| C1 ↔ B01 | 7.6333e-05 | 0 | 多边形拟合残差（< 1e-3 的 epsilon，计 ok） |
| C1 ↔ B10 | 1.8908e-04 | 0 | 同上，残差略大 |
| C1 ↔ B02 | 0 | **2.7655e-05** | 面接触，残差级间隙；默认 0.75 与 0.02 都判"过紧" |
| C1 ↔ B08 | 0 | **8.5558e-06** | 同上，更小 |
| B01↔B10、B01↔B02、B08↔B10 | 0 | 4.9843 | 相邻棍之间 |
| B02↔B08、B01↔B08 | 0 | 5.0020 | 相邻棍之间 |
| B02↔B10 | 0 | 5.0077 | 相邻棍之间 |

所以"就位无干涉"的干净证据是 **r098（阈值 1e-6 mm：0 干涉 / 0 过紧）**；
r082（0.75 mm）与 r096（0.02 mm）都只是把**面接触的 0.000  mm** 按阈值归成了"过紧"，
不代表几何有问题。四根棍两两之间的真实间隙是 **4.98–5.01 mm**。

## 6. 插拔行程仿真（`simulate_motion`）

场景：`C球` = 碳原子 C **v031**，`fixed`，位置 [0,0,0]；`键棒` = 键棒 6.6 **v039**，`kinematic`，
初始 [0,0,17.0]；振荡器沿 −Z、振幅 6.0 mm、周期 1.0 s。几何含义：C 球 sock0 平台在 z=7.70，
棍的 pegA 台肩面在 z = 17.0 − 6.6/2 = 13.70；振幅 6.0 让 t=T/4 时台肩正好落到 7.70（完全就位），
t=0 时离口 6 mm。

### 6.1 r083 —— 假绿，**不作为证据**

```
Motion pass. Ran 2000 steps / 1s.  Interference: 0 event(s)
Sampling: 25/24 poses × 1 candidate pair(s) = 25 interference checks
```

但 `metrics.followers` 为空，5 个关键帧里键棒的位置**全部是 [0,0,17]**——它根本没动。
原因：键棒同时是 `drive` 体，被建成 `kinematic_velocity_based()`，而振荡器用的是
`set_next_kinematic_translation`（位置型 API），对速度型刚体无效。**0 干涉无意义。**

### 6.2 r084 —— 真动了，物理上正确，但被引擎判 fail

修正办法：另给一个远离现场的 `曲柄`（kinematic，x=100）承担 `drive`，键棒只做振荡器。
结果（`runs/r084/report.json`）：

- 2000 步 / 1.0 s；**25/24 位姿**（`samplingSatisfied: true`），3 个候选对 → **75 次干涉检查**；
- 键棒 **行程 12.000 mm**（z 17 → 11 → 23 → 17）；最大关节漂移 0 mm（无关节）；
- **6 次干涉事件，全部是 C球↔键棒**：

| t (s) | 键棒 z (mm) | 干涉体积 (mm³) |
|---|---|---|
| 0.1245 | 12.771 | 0.769 |
| 0.1660 | 11.816 | 0.767 |
| 0.2075 | 11.213 | 0.255 |
| 0.2905 | 11.193 | 0.228 |
| 0.3320 | 11.779 | 0.767 |
| 0.3735 | 12.718 | 0.768 |

- **就位帧 t=0.249/0.250（z=11.000，台肩 7.70）干涉 0**；**拔出/起始帧 t=0/0.5/1（z=17.000）干涉 0**；
  6 次事件集中在 0.1245–0.3735 s，即**卡珠（Ø5.40）挤过喉口（Ø5.20）的那一段**。单边挤压 0.10 mm，
  0.769 mm³ 与任务预期的 ~0.7 mm³ 量级一致（设计 §2.3 只估了力，没有估体积）。
- 引擎的判定：`status: fail` / `judgement: excluded` / "❌ 不可交付 · 干涉 6 次"。
  **这是引擎边界，不是设计缺陷**：刚性刚体无法表现四瓣卡脚的弹性，卡珠过喉口必然在布尔里"干涉"。
  所以 r084 **不是**"通过证据"，它是"挤压量被量化、且两端位姿干净"的行程证据。

### 6.3 结论：能否正确安装

- 能**插到位**：就位位姿 0 干涉（r084 的 t=0.25）+ 台肩落在平台的静态距离 0.0001 mm（r097）。
- 能**拔出来**：z=17 及以上 0 干涉（r084）。
- 中段只有**设计预期的卡珠挤压**（6 次、0.769 mm³ 量级、0.1 mm 单边）。
- 但**没有**任何工具的"pass"能覆盖弹性卡扣这一段：r084 被判 fail，r097 的 motion 半边明说未取证。
  真实插拔力仍须实物弹簧秤验证（见 §7）。

## 7. 本版已知问题 / 未验证项

1. **打印性排除（预期内）**：球的 socket 环带 0.50/0.37 mm、棍的卡脚壁最薄 0.223 mm（名义 0.40 mm），
   全部低于 `fdm-pla-0.4` 的 `wallMinMm 1.2`。它们是弹性/台阶特征，不是结构壁；但**这是本工具判定的
   excluded，不能用"设计意图"改写**。是否需要改设计（加厚卡脚、改材料、改工艺档案）由设计方决定。
2. **卡脚插拔力未实测**：设计 §2.3 的 ≈10 N（量级 6–14 N）是悬臂梁公式估算 + 材料牌号假设，
   没有弹簧秤数据。第一版打印后应实测一次并回填。
3. **5.7° 倾角机制未建模**：台肩未落座时 Ø5.00/Ø5.20 的 0.20 mm 间隙允许 ≤5.7° 倾角
   （atan(0.20/2.0)）。运动仿真按刚性/理想位姿，不建模这一项；装配后靠网络约束与重力压回。
4. **没有做整机 48 件的运动仿真**：只做了单接口（C球 + 一根棍）的行程；48 件网络在重力/装配顺序下
   的变形、回弹、累积误差都未仿真。
5. **整机契约已判定，但整机 1128 对 validate 仍是离线**：r100 的 145 接口全部 pass、0 未声明；
   整机 1128 对 0 干涉来自**设计方离线 manifold3d 复核，不是本次 145 条接口证据**。六元环子装配
   r099（37/37）仍保留为聚焦证据。
6. **行程仿真的引擎边界**：r083 是假绿（drive 体同时做振荡器 → 速度型刚体忽略位置目标，零件没动）；
   r084 真动了，但刚性引擎把弹性卡珠判成干涉 → `fail`。**两个 run 都保留**，不要引用 r083。
7. **第一版棍 v034–v037 的缺陷**（已修复，保留历史）：开缝从尖端 0.4 mm 起，留下实心端盖把四瓣在自由端
   连成一片（两端固支、卡珠压不动），且缝端与导入锥之间夹出 0.038 mm 薄唇。v038–v041 把开缝改到
   尖端 0.0 起后，卡脚才是悬臂。
8. **工具链缺陷（已修 / 未修）**：
   - `check_printability` 曾因 worker 未返回 required 的 `surfaceAreaMm2` 被 output schema 拒绝（已修，
     本次结果是修复后的）；
   - `check_assembly` 的回复 schema 未声明 `skipped[].measured`，**任何含 skipped 的回复都会被拒**
     （r077 上实测到 25 条 `skipped[N].measured` 报错）。本清单 skipped=0 所以未受影响；整机清单如果
     跑得完、又出现 skipped，会撞上这条。
9. **悬垂面**：球的 32.8–121.4 mm²、棍的 37.3 mm² 朝下悬垂面需要支撑或改朝向；球必须按自身 +Z 姿态打印
   （泪滴排屑方向按 +Z 算）。
10. **语料位置**：已迁移到 `examples/ball-and-stick/glucose-molecule/cad-data/`（v031–v041、r069–r099），
    原 `examples/toy-balance2/cad-data` 已恢复（30 版本 / 18 零件 / 69 运行）。迁移后重跑了一次六元环
    契约（**r099 pass**，37/37），确认迁移后的语料能被工具正常解析。
    另外：`examples/toy-balance2` 的语料里留了一个误跑的运行 **r077**（相对路径解析到了它的清单），
    结论是真的——那份清单 25 个接口**一个都没写公差**，所以 25 个全 skipped、13 对未声明；未替它改动。

## 8. 复现命令

```bash
cd /home/songsenand/Project/ToyMarker/examples/ball-and-stick/glucose-molecule

# 1) 几何真值 → SCAD + 位姿表（设计冻结，一般不需要重跑）
python3 spec/build_molecule.py        # → spec/molecule.json
python3 spec/gen_scad.py              # → spec/parts/*.scad + spec/instances.json

# 2) 装配清单（versions.json 由本步骤维护；不再带 "run"）
/home/songsenand/.dsh/cad/runtime/venv/bin/python spec/build_assembly.py
#    → assembly/assembly.json（48 节点 / 145 接口，BOM 真值）
#    → assembly/assembly_ring.json（12 节点 / 37 接口，可判定的六元环子清单）
```

注意：`run_python` 的默认 cwd 是仓库根，不是本目录；要么用上面 bash 里的绝对路径，要么显式传 cwd。

工具侧（agent 工具，不能在 shell 里直接跑）：

```text
generate_part   {part:"<中文名>", scadCode:<spec/parts/*.scad 全文>, views:["iso"]}
check_printability {versionId:"vNNN", profileIds:["fdm-pla-0.4"]}
check_assembly  {manifestPath:"/home/songsenand/Project/ToyMarker/examples/ball-and-stick/glucose-molecule/assembly/assembly_ring.json"}   # 必须绝对路径
validate_assembly {parts:[C1 v031, B01 v038, B02 v039, B08 v040, B10 v040 各自 rotate/translate 照 instances.json], clearanceThreshold:1e-6}
simulate_motion {parts:[C球 fixed v031@[0,0,0], 键棒 kinematic v039@[0,0,17], 曲柄 kinematic cube(4)@[100,0,0]],
                 joints:[], drive:{body:"曲柄",axis:[0,0,1],omegaRadPerSec:6.2832},
                 oscillators:[{body:"键棒",axis:[0,0,-1],amplitudeMm:6,periodSec:1}], cycles:1}
```

`spec/versions.json` 当前内容（不含 `run`，按 §6 的决定不把 r084 当通过证据）：

```json
{"parts": {"atom_C": "v031", "atom_O": "v032", "atom_H": "v033",
           "stick_7.2": "v038", "stick_6.6": "v039", "stick_5.2": "v040", "stick_4.8": "v041"}}
```

### 附：本文引用的运行编号

| run | 类型 | 用途 |
|---|---|---|
| r089 / r090 / r091 | printability | v031 / v032 / v033 的判定与排除证据 |
| r092 / r093 / r094 / r095 | printability | v038 / v039 / v040 / v041 的判定与排除证据 |
| r097 | assembly-check | 六元环子清单：37/37 pass、0 hard、0 skipped、0 undeclared |
| r082 | validate_assembly | 阈值 0.75 mm：0 干涉、2 过紧（面接触） |
| r096 | validate_assembly | 阈值 0.02 mm：0 干涉、2 过紧（残差 2.8e-05 / 8.6e-06 mm < 0.02） |
| r098 | validate_assembly | 阈值 1e-6 mm：0 干涉、0 过紧（干净的就位证据） |
| r083 | motion | 假绿：键棒没动，**不作证据** |
| r084 | motion | 真行程 12 mm：6 次卡珠挤压 0.769 mm³，就位/拔出 0 干涉，引擎判 fail |
| r099 | assembly-check | 迁移后重跑六元环清单（相对路径经根符号链接解析）：37/37 pass |
| r100 | assembly-check | 整机 145 接口：145/145 pass、0 hard、0 skipped、0 undeclared（AABB 宽相位后） |
| r077 | assembly-check | 反面教材：相对路径解析到 toy-pan-balance 清单，且暴露 skipped[].measured schema 缺陷 |
