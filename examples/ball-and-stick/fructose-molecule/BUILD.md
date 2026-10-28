# 构建记录

> 本文件按时间顺序记录“做了什么、得到什么版本/run、关键数字”。不改写历史；修正用新行。
> 设计依据在 [`INTERFACE.md`](INTERFACE.md)，验收在 [`VERIFICATION.md`](VERIFICATION.md)。

## 执行者与回溯

| 阶段 | 执行者 | 时间（2026-10-28） | 产物 |
|---|---|---|---|
| 规格/几何源 | 父会话 | 12:39–13:12 | `spec/molecule.json`、`spec/scad/`、文档、预检 |
| 首次注册尝试 | 子智能体（builder #1） | 13:08–13:10 | 发现会话 header cwd=仓库根的结构性阻断；**未写版本** |
| 注册 + 静态检查 | 子智能体（builder #2） | 13:13–13:18 | v001–v039、`assembly.json`、r001/r002 |
| 仿真 + 打印 + 审计 | 子智能体（verifier） | 13:19–13:31 | GUIDE v040/v041、r003–r014、VERIFICATION |

> 回溯入口：本文件按阶段记录工具/版本/run；`cad-data/runs/` 保存每个 run 的完整报告和
> 几何快照；`spec/molecule.json` 是几何权威。根 `cad-data`/`assembly` 符号链接在构建后
> 已恢复为 glucose，查看本项目请用 cwd 指向本目录的会话。

## 阶段 A：规格与几何源（父会话，2026-10-28）

| 步骤 | 动作 | 结果 |
|---|---|---|
| A1 | 读取 PubChem CID 439709 的 3D SDF | 24 原子 / 24 键，C6H12O6，β-D-呋喃果糖 |
| A2 | 映射 PubChem 原子号到果糖 C1–C6/O1–O6/H01–H12 | 映射表见 SPEC.md §1 |
| A3 | 35 mm/Å 缩放、质心平移 | 224 × 201 × 129 mm；最远原子对 226.51 mm |
| A4 | 定义重/轻接口尺寸 | Ø11/Ø6.5；见 SPEC.md §5 |
| A5 | 生成 37 个唯一件 SCAD + 2 个 GUIDE 件 | `spec/scad/`，共 39 个文件 |
| A6 | OpenSCAD 预编译全部 STL | 39 个 STL 在 `.tmp/all2/`；37 个交付件 + 2 个 GUIDE。GUIDE-B03 初版 v038 有退化非流形边，去 bead 后 v040 水密；其余 38 件水密单实体 |
| A7 | 预检全装配干涉（Python/trimesh，非 CAD 工具） | 48 实例；最大干涉 0.0020 mm³（C3–B09，多边形拟合残差） |
| A8 | 预检插入路径（静态位姿扫描，非 CAD 工具） | B03 0–14 mm 无干涉；B15 0–10 mm 无干涉；最终座面残差 <0.001 mm³ |
| A9 | 预检错相（静态） | B03 5°/10°/15°/30°/180° 均有 0.39–10.06 mm³ 干涉；0° 才落座 |

> 阶段 A 的数字是**构建前预检**，不能替代 §B 的 CAD 工具 run。

## 阶段 B：子智能体注册与检查

| 步骤 | 工具 | 版本/run | 结果 |
|---|---|---|---|
| B1 | 确认 cwd / cad-data 写路径 | pilot `v001`（Fru-C3） | **通过（2026-10-28 第二次尝试）**：根 `cad-data` 已重指本目录，但其目标目录原本不存在，`mkdir` 报 `ENOTDIR`；补建 `cad-data/` 后 pilot 导入成功，`v001` 落在本目录 `cad-data/versions/v001/`（`readlink -f` 已核对），未写入 glucose。**构建结束后父会话已把根 `cad-data`/`assembly` 符号链接恢复为 glucose**；本项目语料仍在本目录。详见“失败与修正” |
| B2 | `import_part` ×39（`render:false`，未用 `allowNonSolid`） | `v001`–`v039` | 39/39 成功，映射见 `spec/version_map.json`。267 个 datum 与 `spec/import_manifest.json` 逐项比对（kind/point/dir/radius）**完全一致**。`Fru-H` 只注册一次（`v013`，12 实例共用）。GUIDE-B03 导入时丢弃 56 个退化三角形 |
| B3 | `check_parts` measure ×4 批（12/12/12/3） | 无 run（measure 半不写 run） | 39 件均 bodies=1；38 件 watertight=true。**GUIDE-B03（`v038`）watertight=false**（非流形，见失败表）；工具级 `failures:[]` |
| B4 | `emit_manifest.py` → `assembly/assembly.json` | 48 实例 / 120 静态接口 | 脚本读到全部 39 个 versionId，与 `spec/version_map.json` 一致 |
| B5 | `check_assembly`（静态，adjacency 0.5 mm） | **r001** | **pass / judgement `not-excluded`**：120 接口 120 pass；`hardViolations 0`、`intentFlags 0`、`skipped 0`、`undeclared 0` |
| B6 | `validate_assembly`（C3/C4/H04/B03/B15，位姿取 `molecule.json`；ε=0.01 mm³，clearance=0.05 mm） | **r002** | **pass**：5 件 10 对，**0 干涉、0 too tight**，最大干涉 **0.000 mm³**；4 个 mating 对（C3↔B03、C3↔B15、C4↔B03、H04↔B15）间隙 0.000 mm（设计上贴合，非缺陷） |
| B7 | `simulate_motion` B03 正样本（C3 fixed / GUIDE-B03 kinematic，12 mm·sin(2πt+π/2)，周期 1 s；位置=最终座面，不是 t0） | **r004**（复核 **r013**） | **pass**：24/24 采样 × 5 对 = 120 次干涉检查，最大采样间隔 3.78°；**干涉 0 次**；行程 11.534 mm；最终位姿 = `guide_final_position` |
| B8 | `simulate_motion` B15 正样本（振荡 10 mm） | **r005** | **pass**：24/24 × 5 = 120 次；**干涉 0 次**；行程 9.780 mm；最终位姿 = 座面 |
| B9 | `simulate_motion` B03 错相 15° 负样本（`guide_wrong15_rotation`，其余同 B7） | **r006** | **fail（预期负样本）**：采样 24/24；**干涉 2 次** —— t=0.241 s C3↔GUIDE-B03 0.08 mm³，t=0.250 s（最终位姿）10.06 mm³；证明 key/相位唯一 |
| B10 | 重新 `emit_manifest.py`（`spec/runs.json` = r004/r005，加 2 个 motion-clearance 接口） | `assembly/assembly.json` | 48 实例 / **122 接口**（120 静态 + 2 motion）；`version_map.json`：GUIDE-B03=`v040`、GUIDE-B15=`v041` |
| B11 | `check_assembly`（**绝对** manifest 路径，避免根符号链接入档） | **r007** | **pass / judgement `not-excluded`**：122/122 pass；hard 0 / skipped 0 / undeclared 0；motion 半由 r004、r005 举证，接口实测距离 **0.000 mm**（容差 0–0.25） |
| B12 | `check_printability` 代表件 ×5（`process-profile-array.json`，`mode:"both"`） | **r008** C3 / **r009** O5 / **r010** H / **r011** B03 / **r012** B15 | C3 `excluded` 0.65<0.75 @[-13.13,12.5,11.71]；O5 `excluded` 0.65 @[-13.3,12.65,8.2]；H `not-excluded`（最薄 2.95）；B03 `excluded` 0.488 @[-4,-4.5,-12.38]；B15 `excluded` 0.694 @[-3.64,0.27,8.87]。悬垂 512.7 / 354.7 / 41.6 / 114.9 / 64.0 mm²。薄跨实测见失败表；**未改任何阈值**（profile 文件仅补 `decidable`） |
| B13 | `delivery_audit`（绝对 manifest；claims **assembly + motion**；不声明全件可制造；exempt `.tmp/all2`、`.tmp`） | 无 run（审计只读） | 精确 verdict：**`difficult`（0 blocked / 2 warn / 2 info）**。warn：v038/v039 未被引用（已被 v040/v041 取代）；27 个仓库级 harness fixture 3MF 早于最新版本。info：3 组重复 run、overlay 复现。stale 0、newest-unvalidated 0。**不声明全件可制造**：printability 仅 5 个代表件（r008–r012），36/41 未覆盖。**不写成 pass**。详见 `VERIFICATION.md` §6 |

## 失败与修正

| 日期 | 现象 | 诊断 | 修正 | 证据 |
|---|---|---|---|---|
| 2026-10-28 | 首次 `import_part` 报 `ENOTDIR: mkdir '/home/songsenand/Project/ToyMarker/cad-data'`，`v001` 未写入 | 根 `cad-data` 符号链接已指向本目录，但**目标目录不存在**（悬空链接）；Node 递归 `mkdir` 遇到悬空链接返回 `EEXIST`→`stat` 失败→`ENOTDIR` | 补建目标目录 `examples/ball-and-stick/fructose-molecule/cad-data/`（不改符号链接），重试成功 | `readlink -f cad-data` → 本目录；`v001` 位于本目录 `cad-data/versions/v001/`；glucose 未改动（`git status` 0 条） |
| 2026-10-28 | `GUIDE-B03`（`v038`）`check_parts` 报 **watertight=false**（bodies=1，genus=0，体积 1505.695 mm³ 正常）；同一来源的 `Fru-B03`（`v016`）watertight=true | 源 STL 杆壁（r=5.6 mm，z=±10.492）有 **144 条被 4 个面共用的非流形边**、282 个零面积面、8 组重复面；**边界边 0 条**（无孔洞）→ 体积/干涉不受影响，但网格形式上非流形。属 OpenSCAD 导出该导向件的退化镶嵌，非 datum/导入错误 | `import_part` 已自动丢弃 56 个退化三角形；**未用 `allowNonSolid`**，也未改几何。GUIDE-B03 仅用于插入路径仿真、**不在交付 BOM**；已记入待 parent 处理 | `run_python`：edge-use 直方图 {2:5994, 4:144}，非流形点全部落在 r=5.6 圆周 |
| 2026-10-28 | **同上缺陷的修复**：修正后的 `.tmp/all2/GUIDE-B03.stl` 与 `GUIDE-B15.stl` 已水密 | 源 SCAD 已去掉卡扣 bead 环（导向件本就不交付 bead） | 重新 `import_part` 为**新版本** `v040`（GUIDE-B03，parent v038）/`v041`（GUIDE-B15，parent v039），`render:false`，cwd 外绝对路径；声明与原版**完全相同**的 6 个 datum（A/B_face、A/B_axis、A/B_cyl）。`measure_part`：两者 **watertight=true、bodies=1、genus=0**，bbox/体积与旧版逐位一致（1505.695 / 504.604 mm³）。`version_map.json` 改指 v040/v041；**交付件 Fru-B03（v016）/Fru-B15（v028）未改**；v038/v039 保留历史但不再被引用 | r004/r005/r013 的 `sourceVersionIds` 为 v040/v041；`readlink -f` 复核 symlink 仍在本题 |
| 2026-10-28 | `check_printability` **拒绝** `spec/process-profile-array.json`：4 条 `applies:false` 规则缺 `decidable` | profile 作者漏字段；schema `$defs/rule.required = [applies, decidable]`（每条规则都必须声明是否可由网格判定） | **未改任何阈值**：r008–r012 先用补齐 `decidable` 的等价副本跑（draft/escape/toolRadius=`geometry`，surfaceRa=`not-decidable`，profileHash `d83ff0bc10dfdfd6`）；父会话随后把 4 个字段补进 `spec/process-profile.json` / `spec/process-profile-array.json`，阈值逐字不变。修复后文件与旧 run 的等价副本**解析一致**——复跑 H（r014）profileHash 仍为 `d83ff0bc10dfdfd6`，r008–r012 证据无需重跑 | r008–r012 的 `profiles[].profileId` 与阈值和 spec 文件一致；r014 被 schema 接受且 hash 相同 |
| 2026-10-28 | 壁厚 witness 0.65（C3/O5）与 0.488/0.694（B03/B15）是否真是薄壁？ | `measure_thickness` 沿报告射线复测：C3 首段 0.65 → 空档 **1.417** → 0.751；O5 0.65 → 1.214 → 1.155；B03 单段 0.488；B15 单段 0.695 | **不是自由壁**：0.65 恰等于 `spline_pos` 普通 rib 宽度（w=0.65），1.42/1.21 mm 空档等于相邻 rib 间距（12 齿，r≈3.9–4.0）；B03/B15 的 0.488/0.695 是杯口 lead-in 锥面与 OD 之间的尖唇（出口法向水平=OD，入口法向斜=锥面），且落在 225°/180° 泄压缝口。**无槽角杯壁实测 0.799 mm**（B03 z=-9、B15 z=-7）。按指示**不重分类、不改 profile**：`excluded` 保留，“薄壁”指 rib/唇边而非承力杯壁 | 6 条 `measure_thickness` 射线；C3/O5 的 span/gap 与 SCAD `spline_pos(12,2.9,5.2,0.65,0.6,0.2)` 一致 |

## 产物清单

- `spec/molecule.json`：几何/接口/装配变换权威。
- `spec/scad/*.scad`：37 个交付件 + 2 个 GUIDE 件源文件。
- `spec/import_manifest.json`：注册清单（STL + datums）。
- `spec/version_map.json`：part → versionId。
- `spec/runs.json`：motion run 引用。
- `assembly/assembly.json`：装配契约。
- `cad-data/`：版本、run、报告（生成物）。
