# 验证记录

> 只写实际跑过的检查；未跑/不可跑的写“未验证”，不要用设计目标代替结果。
> 最新 run id 以本文件与 `cad-data/runs/manifest.json` 为准。

## 1. 几何与水密

| 项 | 方法 | 结果 |
|---|---|---|
| 48 实例水密、单实体 | `check_parts` measure（B3；measure 半不写 run）+ `measure_part` 复核 | 39 个唯一件均 `bodies=1`；修复后 **39/39 `watertight=true`**。GUIDE-B03 旧版 `v038` 的非流形缺陷由 `v040` 修复、GUIDE-B15 由 `v041` 复核：两件 `watertight=true`、`bodies=1`、`genus=0`，体积 1505.695 / 504.604 mm³ |
| 唯一件包络/体积 | `measure_part` 抽查（修复后的 GUIDE 件） | `v040` 12.8 × 12.8 × 24.98 mm；`v041` 8.3 × 8.3 × 17.92 mm；其余件见 `cad-data/versions/` |
| 球心距与键表一致 | `check_assembly` **r007** 的 120 个静态接口（coaxial + distance + diameter-match） | 120/120 pass，0 硬冲突（详见 §2） |

## 2. 装配契约

| 项 | 方法 | 结果 |
|---|---|---|
| 120 个静态接口（同轴/贴合/孔径） | `check_assembly` **r003**（120 接口）与 **r007**（122 接口，含 2 motion） | r003：120/120 pass；r007：**122/122 pass**；`judgement = not-excluded`；`hardViolations 0`、`intentFlags 0`、`skipped 0`、`undeclared 0`（adjacency 0.75 mm） |
| 未声明近邻 | 同上 `undeclared` | **0**（r003、r007） |
| 代表性子装配干涉 | `validate_assembly` **r002**（ε=0.01 mm³，clearance=0.05 mm） | 5 件 10 对：**0 干涉、0 too tight**；最大干涉 **0.000 mm³**；4 个 mating 对间隙 0.000 mm（设计贴合，非缺陷） |
| motion 半 | r007 的 2 个 `motion-clearance` 接口（`params.runId`=r004/r005） | **2/2 pass**；接口实测距离 **0.000 mm**（容差 0–0.25）；所引 run 均 24/24 采样、干涉 0 次 |

接口定义：

- 每个键两端各 2 个静态接口：同轴（轴-轴偏移 ≤0.25 mm）、端面距离（0–0.25 mm）。
- 每个键 1 个孔径/轴径接口：Ø 间隙 0.05–0.35 mm（名义 0.2）。
- 结果必须读 `judgement`，不是 `overallStatus`；`skipped` 不能当通过。

## 3. 插入仿真

| 样本 | 行程 | 结果 | run |
|---|---:|---|---|
| B03 重接口，0° 对 key | 12 mm（实测 11.534 mm） | **pass**：24/24 采样 × 5 对 = 120 次干涉检查，最大采样间隔 3.78°；**干涉 0 次**；最终位姿 = 座面 | **r004**（负样本后复核 **r013**） |
| B15 轻接口 | 10 mm（实测 9.780 mm） | **pass**：24/24 × 5 = 120 次；**干涉 0 次**；最终位姿 = 座面 | **r005** |
| B03 错相 15°（负样本） | 12 mm | **fail（预期）**：干涉 2 次 —— t=0.241 s C3↔GUIDE-B03 **0.08 mm³**；t=0.250 s（最终位姿）**10.06 mm³** | **r006** |

仿真设置（可复现）：C3 `fixed`；GUIDE `kinematic`，位置 = `guide_final_position`（**不是** `expected_t0_position`），振荡 `amplitude·sin(2πt/T + π/2)`，T=1 s、phase=π/2，故 t=0 在 +d、t=0.25 s 回到座面；`cycles=0.25`；dummy Crank `kinematic` + Base `fixed` 置于 (500,500,·)，`joints: []`，Crank 绕 Z 以 2π rad/s 驱动。正样本用 `guide_rotation`，负样本仅换成 `guide_wrong15_rotation`。

**边界（必须保留）**：GUIDE 件去掉了卡扣凸缘；刚体引擎不能模拟杯壁弹性张开。
因此这些 run 证明的是**导向、同轴、端面落座、key 唯一**，不是“卡扣保持力”。
卡扣保持力由静态几何、梁模型估算和 PRINT.md §6 的实物拉脱试验负责。

## 4. FDM 可制造性

| 件 | profile | 工具 verdict / profile verdict | 最薄壁 | 悬垂 | witness 与复测 |
|---|---|---|---:|---:|---|
| C3（v001） | `fdm-pla-0.4-fructose` | `difficult` / **`excluded`** | 0.65 mm @[-13.13,12.50,11.71] | 512.7 mm² | 沿报告射线：0.65 → 空档 **1.417** → 0.751 mm。0.65 恰为 `spline_pos` 普通 **rib 宽度**（w=0.65），1.42 mm 是 12 齿相邻 rib 间距 → **rib 侧面，不是自由壁** |
| O5（v002） | 同上 | `difficult` / **`excluded`** | 0.65 mm @[-13.30,12.65,8.20] | 354.7 mm² | 0.65 → 空档 **1.214** → 1.155 mm；同样为 12 齿 spline rib（R=12.5 球） |
| H（v013） | 同上 | `difficult` / **`not-excluded`** | 2.95 mm | 41.6 mm² | 无壁厚 witness；`difficult` 仅由 41.6 mm² 朝下悬垂（球底与环形槽）触发 |
| B03（v016） | 同上 | `difficult` / **`excluded`** | 0.488 mm @[-4.00,-4.51,-12.38] | 114.9 mm² | 单段 0.488；出口法向水平（= cup OD）、入口法向斜（= lead-in 锥面），点位于 **225° 泄压缝口** → **杯口 lead-in 尖唇**，非 0.8 杯壁。无槽角杯壁（z=−9，15°）实测 **0.799 mm** |
| B15（v028） | 同上 | `difficult` / **`excluded`** | 0.694 mm @[-3.64,0.27,8.87] | 64.0 mm² | 单段 0.695；同样为 lead-in 锥面↔OD 尖唇，位于 **180° 泄压缝口**。无槽角杯壁（z=−7，15°）实测 **0.799 mm** |

run 映射：**r008** C3、**r009** O5、**r010** H、**r011** B03、**r012** B15；**r014** 是用修复后的 profile 文件复跑 H 的 schema 接受性确认（结果同 r010）。薄区面积占比分别为 2.15% / 1.81% / 0% / 1.83% / 0.06%。

**结论口径（按指示不重分类、不改任何阈值）**：4 件 `excluded` 保留。witness 的 0.65 mm 是**正特征 rib 宽度**、0.488/0.694 是**杯口尖唇**（且都在泄压缝口），均不是承力杯壁（杯壁 0.799 mm）；但这仍是低于声明 0.75 mm 阈值的真实几何，故**不把 excluded 改写成 pass**。3 个 atom/bond 件的 0.8 mm 杯壁与 0.65 mm rib 属设计有意，见 `PRINT.md`。

**profile 文件（已修复）**：原 `spec/process-profile-array.json` 的 4 条 `applies:false` 规则缺 `decidable`（schema 要求每条规则都有），曾被 `check_printability` 拒绝。现 `spec/process-profile.json` 与 `spec/process-profile-array.json` 均已补齐（draft/escape/toolRadius=`geometry`，surfaceRa=`not-decidable`），**所有阈值逐字未变**；用修复后文件复跑 H（**r014**）被接受，profileHash **`d83ff0bc10dfdfd6`** 与 r008–r012 相同——旧 run 的等价副本与当前文件解析一致，既有证据继续有效。

通用 `fdm-pla-0.4` 的 1.2 mm 壁厚门槛会把 0.8 mm 卡扣杯壁判为薄壁；本模型用
`spec/process-profile-array.json` 声明 0.75 mm 的专门窗口。这个 profile 是**声明**，必须
在用户机器上用 C3/B03 试配校准；未校准前，“not-excluded”不等于“一定能打”。

## 5. 视觉检查

| 件 | 视图 | 结论 |
|---|---|---|
| C3 | iso 512 px | 球体 + 3 重 1 轻凸台；重凸台端面 12 条 spline rib，杯壁 4 条泄压缝；无可见破面/错位 |
| B03 | iso 512 px（另加 zoom×0.5 全景） | 两端杯 + 12 齿 pocket + 4 条泄压缝；导向件无 bead 环；杯口 lead-in 完整 |
| H | iso 512 px | 球体 + 光滑轻凸台（无 spline）+ 环形槽；与轻接口设计一致 |
| 装配 | 检查渲染/面板 | 未另跑全装配渲染；motion 关键帧（r004/r005/r013）显示导向件与 C3 落座、dummy 件远离模型 |

`scan_attention`：`v001`（8018 面）与 `v016`（4220 面）均 `watertight=true`、`bodies=1`，**无 >100° 凹角链**（“无可疑处”）。这是**检测**（where to look），不是验收结论。

## 6. 审计

| 项 | 结果 |
|---|---|
| `delivery_audit`（claims：assembly + motion） | 精确 verdict：**`difficult`**（⚠ DIFFICULT；**0 blocked / 2 warn / 2 info**）；41 versions / 39 parts / **14 runs**；stale runs **0**；newest-unvalidated **0** |
| claim `assembly` | 有证据（**r007**，122/122，`not-excluded`） |
| claim `motion` | 有证据（**r004/r005** 正样本 + **r013** 复核；**r006** 为预期负样本） |
| claim `manufacturability` | **不声明**。只做了 5 个代表件（r008–r012）；审计要求每个 part 的 fresh printability run，缺 **36/41**。代表件抽查 ≠ 全件覆盖；因此**没有**全件可制造的交付声明 |
| warn 1 | v038/v039 未被任何 run 引用（预期：GUIDE-B03/B15 已由 v040/v041 取代；旧版保留作历史） |
| warn 2 | 27 个 `dsh-cad-harness/scripts/fixtures/*.3mf` 是仓库级 fixture，早于本项目最新版本，非本交付物 |
| info | 3 组重复 run（4 个 run 无新信息）；14 个 run 使用用户 overlay 包，需同样环境复现 |
| 未注册几何 | `.tmp/all2`、`.tmp` 已声明 exempt；从仓库根扫描时 `cad-data/`（含 run 快照）被正确跳过 |
| 未解决项 | ① 36/41 未做 printability（**因此不声明全件可制造**）；② 审计仍有 2 条 warn，故 verdict 是 `difficult`，**不写成 pass** |

## 7. 结论与边界

- **装配**：48 实例、120 个静态接口 **120/120 pass**（r003），加入 2 个 motion 接口后 **122/122 pass**（r007），`judgement = not-excluded`，0 hard / 0 skipped / 0 undeclared。
- **运动**：B03 正样本 0 干涉（r004/r013）、B15 正样本 0 干涉（r005）；B03 错相 15° 在最终位姿产生 **10.06 mm³** 干涉（r006，预期负样本）。
- **可制造性**：仅 5 个代表件按声明 profile 筛查（r008–r012）；4 件 `excluded`（witness 已复测为 0.65 花键肋宽 / 0.488–0.695 杯口尖唇，不是 0.799 杯壁），H `not-excluded`。**这不是“全件可打印”的证明**，且 profile 尚未在用户机器校准。
- **不声称**“实物已打印/已通过拉脱试验”；只声称 CAD 证据 + 打印协议。
- **不声称**“卡扣力已仿真”：GUIDE 件已去 bead，仿真只覆盖导向/同轴/落座/key 唯一。
- **交付状态**：审计精确 verdict = **`difficult`（0 blocked / 2 warn / 2 info）**，**不是 pass**；装配/运动可声明，**全件可制造与实物打印不声明**。未解决项见 §6。
