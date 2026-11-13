[English](../en/llm/processes.md) | 中文

# 工艺目录：每一种常见方法都有验证方法

`manufacturing.allowed` 是**用户能拿到什么工艺**（决策空间）；`verification` 是**怎么验**。
两者分开；目录里没有“没有方法的 unsupported”：

| support | 含义 |
|---|---|
| **supported** | 评估器已实现，覆盖该类工艺的主要几何失效模式 |
| **partial** | 评估器已实现，只筛部分判据；`handoff` 列写明剩下的 |
| **planned** | 方法、判据、输入都已定义，评估器尚未实现；决策可记录，但不能读成 pass |

## 常见方法

| id | 工艺 | support | 验证方法（几何部分） | 需要输入 | 仍为 handoff |
|---|---|---|---|---|---|
| `fdm-pla-0.4` | FDM | supported | 壁厚/特征/间隙 + 悬垂面积 + 打印朝向 | 层高/喷嘴 profile | 层间强度、翘曲、实际打印 |
| `sla-resin` | 光固化 | **partial** | 壁厚/特征/间隙 + 悬垂/支撑 + 封闭腔排液可达性 | 树脂 profile、排液孔 | 吸盘效应、收缩、后固化 |
| `sls-pa12` | SLS/MJF | **partial** | 壁厚/特征/间隙 + 清粉可达性（粉末床自支撑，悬垂关闭） | 粉末 profile、清粉孔 | 清粉效果、嵌套/朝向成本、密度/翘曲 |
| `injection-pp` | 注塑 | **partial** | 壁厚/特征/间隙 + 拔模/倒扣（shipped profile；悬垂/桥接/排气显式不适用） | 最小壁厚、最小拔模角 | 充填/保压、缩水、翘曲、浇口/冷却 |
| `die-casting-alu` | 压铸 | **partial** | 壁厚/特征/间隙 + 拔模/倒扣（最佳开模方向求解） | 最小拔模、合金壁厚规则 | 充填/气孔、热裂、浇口/溢流、模具寿命 |
| `sand-casting` | 砂型铸造 | **partial** | 壁厚/特征/间隙 + 拔模（最佳起模方向） | 最小拔模、加工余量 | 收缩/气孔/砂眼、浇注/冒口 |
| `forging` | 模锻 | **partial** | 壁厚/特征/间隙 + 拔模（最佳模具方向） | 最小拔模、分型面 | 流线/飞边/模具磨损/裂纹 |
| `vacuum-forming` | 真空成型 | **partial** | 壁厚/特征/间隙 + 拔模（最佳脱模方向） | 板厚、最小拔模 | 拉伸比、壁厚分布、拉丝、冷却 |
| `cnc-3axis` | CNC 铣（含桌面） | **partial** | 壁厚/特征/间隙 + 圆孔刀具半径 + 深径比（`check_printability` + `cnc-3axis` 档案）；**六方向可达 + 最少装夹数**（`check_cnc_access`） | 刀具半径、深径比、壁厚规则、`maxSetups`、`requireAllAccessible` | 斜装夹/第四轴、刀具长度/直径/碰撞、夹具刚性、振刀/成本 |
| `cnc-turning` | 车削 | **partial** | 棒料直径 + L/D + 回转对称偏差（`check_turning`，绕主轴） | `barDiameterMm`、`maxLdRatio`、`symmetryToleranceMm`、`requireSymmetry` | 倒扣/沿轮廓刀具可达、振刀、表面、送料限制 |
| `laser-cut-sheet` | 激光切割 | **partial** | 2D 截面：圆孔直径/孔到外轮廓/孔间距，扣割缝（`check_sheet2d`） | `kerfMm`、`minHoleMm`、`minFeatureMm`、`minSpacingMm` | 非圆孔宽度、外轮廓窄筋、热影响区、锥度、表面 |
| `waterjet` | 水刀 | **partial** | 2D 截面：圆孔直径/孔到外轮廓/孔间距，扣割缝（`check_sheet2d`） | `kerfMm`、`minHoleMm`、`minFeatureMm`、`minSpacingMm` | 非圆孔宽度、外轮廓窄筋、锥度随厚度、表面、磨料成本 |
| `sheet-metal-bend` | 钣金折弯 | **partial** | 切割特征（圆孔/壁/间距，扣割缝）+ 可选折弯检查：**孔到折弯、最小翻边、折弯让位启发式**（`check_sheet2d` + `bendLines`） | `kerfMm`、min 孔/壁/间距、`bendLines`（u/v）、`minHoleToBendMm`、`minFlangeMm`、`minBendReliefMm` | 展开图/K 因子、让位槽几何、回弹、模具限制 |
| `edm` | 电火花 | **partial** | 壁厚/特征/间隙 + 圆孔电极/丝半径 + 深径比（`check_printability` + `edm` 档案）；线切割 2D 特征（`check_sheet2d`）；沉模**单轴电极可达**（`check_edm_access`） | 电极/丝半径、深径比、线割 `kerf`/min 孔/壁/间距、`burnAxis`/`requireAllReachable` | 电极形状/侧蚀/倒扣、电极损耗、最小特征、表面、加工时间 |
| `extrusion` | 型材挤出 | **partial** | 2D 截面：壁厚/圆孔/间距，扣割缝（`check_sheet2d`） | `kerfMm`、`minHoleMm`、`minFeatureMm`、`minSpacingMm` | 等截面校验、挤出胀大、冷却/翘曲、牵引速度、中空截面规则 |

## `deliver` 怎么用

- `M:policy` 把每个 `allowed` 标成 `[supported]` / `[partial]` / `[planned]`；
- 允许集里有 `planned` 工艺 → 缺口 `process-planned`：“方法已定义，评估器未实现；不要读成 pass”；
- 零件被分配到 `planned` 工艺 → 该行 `unobserved`，`why` 写方法与所需输入，`next` 写“实现/接上评估器，或手工检查”，**不会**拿打印性 profile 冒充；
- unknown id → `process-unknown`。

## 实现顺序（每条都能独立验收）

1. **工艺流程档案（已完成，partial）**——CNC 3 轴、注塑、压铸、真空、砂铸、模锻、SLA、SLS 共用现有 `check_printability`：壁厚/特征/间隙 + **draft 求解器**（拔模/倒扣）+ **escape 可达性**（排液/清粉）。没有另造 `check_moldability`，因为 draft 求解器已经覆盖同一族几何。
2. **`check_sheet2d`（已完成，partial）**——对平板的截面做 2D 切割筛查：圆孔直径、孔到外轮廓、孔间距，扣割缝；覆盖激光、水刀、钣金、挤出。钣金可另传 `bendLines`（u/v）检查孔到折弯、最小翻边、折弯让位（启发式）；展开图/K 因子、让位槽几何仍是 handoff。
3. **EDM（已完成，partial）**——`schemas/examples/edm.json` 用 `toolRadiusMm`/`holeAspectMax`/壁厚规则覆盖**圆孔**电极/丝半径；线切割可再用 `check_sheet2d` 验 2D 轮廓/割缝；线切割 2D 用 `check_sheet2d`；沉模单轴可达用 `check_edm_access`；电极形状/侧蚀/损耗、表面、烧伤仍是 handoff。
4. **车削（已完成，partial）**——`check_turning` 验棒料直径/L/D/回转对称偏差；倒扣/沿轮廓刀具可达/振刀/送料仍是 handoff。
5. **CNC 六方向可达 + 装夹数（已完成，partial）**——`check_cnc_access` 用 ±X/±Y/±Z 可见性 + 贪心覆盖给出不可达面积和最少主方向装夹；斜装夹/刀具长度/夹具/振刀仍是 handoff，体素/斜方向可达可继续升 supported。
6. 每个评估器落地后，把目录里的 `support` 从 `planned` 改成 `partial/supported`，并写清 `handoff`。

## 什么不能被几何验证

充填/气孔/缩水/翘曲、振刀/让刀、回弹、热影响区、工时/成本——这些**不是**网格能回答的。目录把它们列在 `handoff`，由 CAE、供应商或物理测试接手；场地只负责把问题问清、把边界写明，不假装一个网格检查能给出合格证。
