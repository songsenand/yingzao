# 项目 TODO（进行中）

> **2026-11-26 整理**：只列**未完成**；已完成/历史条目移到
> [`docs/archive/TODO-2026-11-26-pre-cleanup.md`](../archive/TODO-2026-11-26-pre-cleanup.md)。
> **规则**：本文件决定顺序/状态/优先级；设计细节留在来源文档。完成后**删除**本行，
> 不在这里保留“已收口”表。
> **状态词**：`next` / `doing` / `planned` / `partial` / `blocked` / `triggered`。

---

## 0. 顺序

1. **U20** 任意剖切 + 封盖
2. **Q1** 上下文 / 工具面 token 预算（可与 U20 并行）
3. **U21** 大网格加载进度 + WebGL 上下文恢复
4. **U11** 视口导航：正交/透视、六标准视图、轴吸附
5. **U19** 面板审计视图（audit + preflight）
6. **F1** 流体域闭合余项
7. **N15** 流体进度 / 取消（A：只做流体）

其余按 P 排队；0.2.0 门禁见 §0.1；`U13`/`U24` 只占位，不排期。

### 0.1 0.2.0 门禁（2026-11-26 定）

0.2.0 = **准生产基线**，目标、完成定义、里程碑见 [RELEASE-0.2.0.md](RELEASE-0.2.0.md)。
门禁共 **17 项**，每项必须有可复跑的证据；缺一项不发：

- **工具面 / token（先行，可与 U20 并行）**：Q1（Q2 已收口，见下）
- **已收口**：**Q2**（2026-11-26，冻结 ledger + 计数派生 + example，`accept-cad-all-surfaces` 7 红转绿）；**U12**（2026-11-27，逐件显隐/隔离/高亮，`accept-ui assembly-hide` 11 项 PASS + 截图）；**U11**（2026-11-27，等轴/顶/前/右 + 六向吸附 + 透视·正交 + Home，`accept-ui views` 13 项 + `accept-viewport-orbit` 视图数学断言）；**U22**（2026-11-27，BOM CSV 七列 + 转义 + 未确认工艺标记，`accept-bom-csv` 22 项 + `accept-ui bom-csv` 8 项，下载字节被截获校验）；**U19**（2026-11-27，审计视图 = 工具同一实现 `/api/cad/deliver/audit` → `deliveryAuditValue`，待办行携带 run/version 跳转，`accept-audit-gaps` 19 项 + `accept-ui audit-view` 8 项）；**U15**（2026-11-27，视口测量四族：距离/角度/剖面面积/孔 + 可命名删除的测量历史随截图；`accept-measure-families` 33 项 + `accept-ui measure-families` 8 项）；**F2**（2026-11-27，流体流轴改由**内腔**决定而非包围盒：Ø44×30 由 X 改为 Z，实体件回退并标注 `axisSource`；`accept-fluid-axis` 15 项，含旧规则反证）；**N15**（2026-11-27，流体长跑进度=已跑/总步数、取消=杀求解器进程；worker 进度帧 + `FluidJobRegistry` + 面板百分比/取消；`accept-fluid-jobs` 22 项 + `accept-ui fluid-job` 7 项）
- **主线**：U20、U21、F1、U14
- **收口**：Q3、Q4（含 R3/R6）、Q5、Q6

**`0.2.0-preview.1` 范围（2026-11-26 用户定）：M1 + M2 = 13 项**（Q2、Q1、U20、U21、U12、U11、
U19、U15、F1、F2、N15、U14、U22）。Q3–Q6 进 `0.2.0`（或可选 `preview.2`）；
U17/U16/U10 等争取项**不进 preview.1**，U17 起于 0.2.1 开头。

> U17、U16、U10、U18、U23、L1.13、L16、L10、U02、U01 不在门禁；同版有余力再做，
> 否则进 0.2.1（见 RELEASE-0.2.0 §3）。

---

## 1. P1 靠前（用户指定）

| ID | P | 状态 | 事项 | 出口（可证伪） | 估时 |
|---|---|---|---|---|---|
| U20 | P1 | partial | 任意剖切 + 剖切面封盖 | **已落**：`SectionPlane`（点+法向）推广，轴切成为特例（逐字节等价）；catalog/封盖/拾取/切片全走同一平面；面板加「轴切/任意平面」切换 + 方位/仰角 + 保留·切除互换；`accept-section-free`（45° 立方体 565.685mm²、圆环 45° 椭圆 333.2mm²、孔被减掉、翻面同一刀、双体各自封盖）+ `accept-ui section-free`（12 项：封盖面积、孔占比 0.305、材质带 1 个裁剪面、裁剪生效使画面像素变化 9.4%→13.5%）。**余**：① 真机面板过一眼「斜切管道看到内腔」；② sandbox 冻结帧与画布重建的先后（截图抓到旧帧）并入 U21 | 2–3d |
| U21 | P1 | partial | 大网格加载进度 + WebGL 上下文恢复 | **已落**：`stream-progress.ts`（17 项断言）+ 面板进度 pill + `glLost`/`glEpoch` 自动重建（`accept-ui webgl-recover`）。**百万面实测（2026-11-27，sandbox 的软件 GL）**：999,698 三角形 / 47.7 MB，传输 **188 ms（254 MB/s，211 个进度 tick）**，STL 解析+bounds **82 ms（12.5M tri/s）**，首帧 **74 ms**，稳态 **63.9 ms/帧**（733×547，`gl.finish()` 同步后；`renderer.info` 证明确实画了 999,698 tri）。`accept-ui big-mesh` 8 项断言。**余**：真机切标签页手测（需你） | — |

## 2. P0 / P1 排队

| ID | P | 状态 | 事项 | 出口（可证伪） | 估时 |
|---|---|---|---|---|---|
| Q1 | P0 | **partial（只差 A/B 数据）** | 上下文 / 工具面 token 预算（节约 token） | **已落**：`accept-token-budget.mjs`（进 `accept:preview`）+ `TOKEN-BASELINE.json`（固定前缀 5,930 chars ≈1,483 tok；对照 45 旧工具 104,675 → **降 94.3%**，9 面在 6144 预算内）；`accept-skill-tools`/`token-budget` 守不回归。**已备**：`scripts/token-ab-report.mjs`（判定规则写死：两臂都通过且 ≥2/3 任务降 ≥20%，`--append` 写进实验报告）。**余**：跑三个任务的 A/B 并读数（需真会话，步骤见 `CHECKLIST-preview.1-signoff.md` §3） | 0.5d |
| Q3 | P0 | planned | 前向兼容契约 + 回归 | 写 `docs/dev/COMPATIBILITY.md`：0.2.0 起 surface/action 只增不删、项目 schema 读旧拒新、弃用至少跨 1 个 minor、CLI/env 稳定；`accept-compat`：0.1.2 golden 项目可开、工具契约快照只允许新增、未知 schemaVersion 拒绝 | 2d |
| Q4 | P0 | planned | 干净安装 / 升级 E2E + 问题收口 | 干净机器按 README 在 Linux/mac/Win 装 + 从 0.1.2 升级；doctor 修复路径、离线/代理、首跑耗时记录；发布前 open P0/P1 = 0；R3/R6 矩阵回填 | 3d |
| Q5 | P1 | planned | 用户文档 0.2.0 覆盖 + 中英对照 | 覆盖矩阵（安装/首件/验证/视口/剖切/装配/测量/导出/交付/升级/排障）无空缺；中英同文件集、同标题、版本号一致；截图更新；`accept-docs-parity` 进 CI | 4–5d |
| Q6 | P0 | planned | 0.2.0 发布工程 | 版本号、release notes、迁移指南、CI 全绿、tag、npm staged（手机批准提示）、发布后 `doctor`/`verify`/安装冒烟、回滚包 | 1–2d |
| F1 | P0 | **已收口** | 流体域闭合与「管外」审计 | 薄壁政策（`accept-fluid-wall-policy` 19）+ dx 收敛曲线（`accept-fluid-convergence` 9：0.90/0.82/0.32，**不收敛**，只可同 dx 比较）+ **粒子级约束**（`accept-fluid-constraint` 11：Ø34@dx1 穿透 7,098→0、到达率 0.031→0.385、`escaped+active=count0` 精确、关掉约束复现 7,098）+ **两引擎 parity 已跑**（py 0.3989 vs ts 0.3852，py 穿透 0）。环境注记：受限沙箱的 `~/.dsh` 只读，用 `DSH_CAD_PYTHON_ROOT=<工作区 symlink 目录>` 让 scratch 可写后 parity 真跑 | — |
| U14 | P1 | **已收口** | 任一检查一键重跑 | `run.json` 记 `request`；`check-rerun` 三态 direct/replay/needs-args；`repinRequest` 把版本钉到当前（joints 原样）；`simulate_stress` 的体已提取为 `runStressJob`（与工具同一实现）。证据：`accept-check-rerun` 37 项 + `accept-ui rerun-check` 11 项 + **`accept-stress` 37/37**（提取后的 job 真跑，`accept:release` 在可写 runtime 下 PASS） | — |
| U16 | P1 | planned | 结构化请求 + 几何标注 | 标注携带 `(versionId, 面/点, 相机)`，切视角仍回原位；请求草稿含版本 + 区域 bbox + 实测 + 目标值，一键发进会话 | 3d |
| U17 | P1 | planned | 接口 / datum 可视化（9a） | 点契约表一行 → 高亮两个零件、datum 点之间画线、显示实测间隙 vs 容差；不预生成接口图 | 3–4d |
| U10 | P1 | planned | 大装配视口布局：图例收纳 | 42 件回放的图例默认单行摘要 + 展开限高 2 排/搜索/「只看运动件」；视口高度占比 ≥ 基线 +20%，DOM 断言图例 ≤2 排 | 2d |
| U01 | P1 | partial | 面板视觉重做（签收） | tokens/亮暗主题已落；**余**：同一任务在新旧 UI 各跑一次，截图对照 + 用户签收 | 2d |
| U02 | P1 | partial | 更多高质量示例 | 4 个新示例已入库；**余**：干净环境按 README 复现并记录耗时；旋梭 README §6 的 6 项未决 | 3–5d |
| R3/R6 | P1 | partial | DSH 13 版本矩阵补跑 | 用 `0.1.2-preview.1` 在普通终端重跑 13 版本矩阵，结果回填 `DSH-MATRIX.md`；本地 `accept:release` 由 CI 两 job 覆盖的说明保留 | 1d |
| L1.13 | P1 | partial | 标准件目录工具入口 | `cad_part` 的 list/get/import-by-catalog、结构化 `libraryRef`、catalog 进 preview/release、E2E import→datum→check | 2–3d |
| L16 | P1 | planned | 示例语料重跑 | `windup-frog` r064 整机演示重跑；`accept-verify` 期望更新；各示例的 verify/README/截图一致 | 2–3d |

## 3. P2 排队

| ID | P | 状态 | 事项 | 出口（可证伪） | 估时 |
|---|---|---|---|---|---|
| U18 | P2 | planned | 爆炸动画 / 导出（9b） | 0→100% 播放/暂停、导出 GIF/WebM、重开预览保持爆炸状态 | 1–2d |
| U23 | P2 | planned | 带标尺的视图导出 | PNG 带比例尺，可选分辨率/透明背景，标注已烘焙 | 0.5–1d |
| L10 | P2 | planned | STEP 完整导出路径 | STEP 回读往返；B-rep 与 STL 体积/bbox 一致性；三平台 smoke | 3–5d |
| P2-10 | P2 | partial | 装配可装入性 | 已判封闭腔/大面积不可达；**余**：全序列插入检查 | 2–3d |

## 4. 长期 / 待想清楚

| ID | P | 状态 | 事项 | 说明 |
|---|---|---|---|---|
| G1 | P1 | planned | 项目级规划工件 | 最小 plan schema（需求→零件→接口→验证）+ 阶段门；回放同一需求，版本数 −30%、漏孔级联 0 次 |
| G2 | P1 | planned | 大项目混乱归因摸排 | 计划优先 vs 无计划两组，记录返工轮数/触及零件数；产出归因表，先于 G1 |
| E1 | P1 | partial | 引擎×大项目量化 | 回顾已完成；余：受控 pilot（3 task × 5 会话/组，补 token/墙钟仪表），再决定是否扩到 40–60/组 |
| U13 | P2 | triggered | 优化历史版本的选择与展示方式 | 占位，不预设做法；触发 = 想清楚用户在什么场景下要找旧版/对比/回看 |
| U24 | P3 | triggered | 版本/运行备注 | 确有需要时再做：给版本/run 写一句人话，sidecar 存储、列表可见、可搜索 |

## 5. 中远期（不排期）

> 这些不是当前工作；细节在来源文档。第三引擎/社区接入仍按 2026-11-19 的引擎纪律，不因讨论自动进表。

| ID | 事项 | 一句话 |
|---|---|---|
| L2 | 判据供给产品化 + 标定 | `assembly.json` 成为构建产物；coupon 实测回填 tolerance/壁厚/卡扣 |
| L3 | 装配清单 v2 + 装配级版本图 | 跨层变换、端口解析、`review: auto\|human` |
| L4 | 物理验证回路 | 试打/卡尺/拉脱回填 profile 与 tolerance |
| L5 | 检查器标定 + bench 重跑 | 50 个已知缺陷的检出率/误报率；新 SUT 指纹 |
| L6 | 权威编辑 + 回滚 | 版本标签/HEAD/回滚；审批判定归 agent（2026-11-26） |
| L9 | 会话显式绑定 / 稳定 id | 创建时选项目、恢复确认、移动/多人/跨机 |
| L11 | 外观检查 L1/L2 | 成套外观的规则/阈值分层 |
| L12 | 研究储备 | 弹性本构 / 特征识别 / pixel-unproject |
| L13 | 平台与分发 | Win/mac 全矩阵、安装/升级路径；市场另议 |
| L14 | 多用户/云/移动 | 按 PROJECT-SCOPE 触发条件再评估 |

---

## 6. 来源索引

| 来源 | 里面有什么 | 对应 |
|---|---|---|
| [RELEASE-0.2.0.md](RELEASE-0.2.0.md) | 0.2.0 准生产基线的目标、17 项门禁、争取项、里程碑与证据 | Q1–Q6 及全部门禁 |
| [PLAN-2026-11-26.md](../PLAN-2026-11-26.md) | 流体/视口/大项目/引擎对比的证据与设计 | F1、F2、U10、U11、G1、G2、E1 |
| [PLUGIN-GAP-2026-11-26.md](../PLUGIN-GAP-2026-11-26.md) | 插件能力快照与逐条确认记录 | U10–U24 |
| [UI-PLAN.md](../UI-PLAN.md) / [UI-EXECUTION.md](../UI-EXECUTION.md) | 面板 D/E/R/F/G 表与施工历史 | U11、U15、U16、U19 |
| [RELEASE-NOTES-0.1.2.md](RELEASE-NOTES-0.1.2.md) | 0.1.2 发布说明与证据 | R3/R6 |
| [DSH-MATRIX.md](DSH-MATRIX.md) | 13 版本矩阵实测表 | R3/R6 |
| [ASSESSMENT-2026-10-28.md](ASSESSMENT-2026-10-28.md) | G1–G8 缺口与路线 | L2–L5、L12 |
| [DESIGN.md §12](../../DESIGN.md) | 当前主线/待办/长期 | L3、L6、L12 |
| [PROJECT-SCOPE.md](PROJECT-SCOPE.md) | B/C/D 路线与触发条件 | L9、L14 |
| [DECISION-LOG.md](../DECISION-LOG.md) | 历史取舍（append-only） | 全文 |
| [examples/README.md](../../examples/README.md) | 示例/归档/题库索引 | U02、L16 |
| [HARNESS.md §10](../../HARNESS.md) | 开放化顺序 | L13 |

## 7. 更新纪律

1. **本文件是唯一 TODO 索引。** 新计划先在来源索引登记，再在表里加行。
2. **完成后删除该行**，不保留“已收口”表；历史看归档文件或 git。
3. **状态只在这里改。** 来源文档只写设计细节，不写第二份状态。
4. **顺序冲突时**：本文件决定顺序/状态，来源文档决定设计细节。
5. **新增“未决”时**：要么进 §4（待想清楚/triggered），要么进 §5（不排期），不要留在正文里当注脚。
6. **引擎纪律（2026-11-19）**：第三引擎和社区适配不因讨论自动进表；必须用户拍板并满足触发条件。
7. **版本事实以 npm registry + git tag 为准**：不保留会过期的“latest 坏包”断言。
8. **staged 审批优先走手机（2026-11-26）**：`npm stage publish` 后 CLI 无 approve/reject 权限时，先提示用户用手机 npmjs.com 批准。
