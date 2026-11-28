> **归档（2026-11-26）**：这是清理前的 TODO 总表，保留已完成/历史条目以便追溯；
> 当前 TODO 见 [docs/dev/TODO.md](../dev/TODO.md)。

# 项目 TODO 总表

> **状态**：单一索引（2026-11-12 创建；**2026-11-25 按 `0.1.2-preview.1` 重排**）。
> **作用**：把散落在 `RELEASE-0.1.1.md`、`RELEASE-NOTES-0.1.1.md`、`RELEASE-0.1.0-PREVIEW.md`、
> `PLAN-2026-11-26.md`、`PLUGIN-ISSUES-2026-11-21.md`、`ASSESSMENT-2026-10-28.md`、`DESIGN.md §12`、
> `UI-PLAN.md` / `UI-EXECUTION.md`、`PROJECT-SCOPE.md`、`DECISION-LOG.md` 的“未决/非目标/后续”
> 收成一张有序的表。
> **规则**：本文件决定**顺序、状态、优先级**；设计细节留在来源文档。不要在两处同时维护状态。
> **状态词**：`next` / `doing` / `planned` / `partial` / `blocked` / `triggered` / `done` / `dropped`。
> **时间口径**：`0.1.1-preview.1` = 已发布（2026-11-20）；`0.1.2-preview.1` = **已发布**（2026-11-26，
> npm `latest`）；`0.1.2` 线剩余 = 当前；`0.2–0.4` = 中远期；`1.0` = 冻结。

---

## 0. 现在只做一件事

**`0.1.2-preview.1` 已发布（2026-11-26，npm `latest`）。现在做 §3 的 0.1.2 线剩余；发布路径与“手机批准 staged”的教训见 [RELEASE-NOTES-0.1.2.md](RELEASE-NOTES-0.1.2.md) §8。**

- 0.1.1 与 0.1.2-preview.1 的双内核主线都已收口；后续**不新增引擎、不改 seam**，先把 0.1.2 线的体验/证据补齐。
- 本版内容（C1–C12）已发布，见 §2 与发布说明；不再重复维护“待发清单”。
- **下次发布先问**：能不能用手机 npmjs.com → Staged Packages 批准？CLI token 只有 `package:write` 时 approve/reject 会 404、直发会 E409；不要先改版本号。
- **纠正一条历史结论**：npm `0.1.1-preview.1`（gitHead `f62124b`）已包含预设修复，不是坏包。
- **2026-11-26 用户新提四条**（流体仿真、面板视口、大项目混乱、引擎对比）已进 §3.5；
  证据与设计见 [PLAN-2026-11-26.md](../PLAN-2026-11-26.md)。流体 F1 本轮已 partial，其余不抢 0.1.2 发布线。

**引擎策略（2026-11-19 用户拍板，继续有效）：**

- 第一梯队只放「市面上最常见、LLM 最擅长」的引擎；当前 = **OpenSCAD + CadQuery**。
- **OpenSCAD 是常驻依赖**：四视图、剖切、运动/装配关键帧与网格导出统一走 OpenSCAD；
  不替换为 Matplotlib/F3D/自写光栅器。CadQuery 只是新增作者引擎；一个项目只有一个作者引擎。
- 第三个引擎不排 0.1.2/0.2；至少等真实需求 + 3-task benchmark，0.3 才评估。
- 社区/用户自行接入后置到 0.4+/1.0 前；0.1.x 不做公开 engine 协议、不做市场。

---

## 1. `0.1.2-preview.1` 发布阻断（R1–R8）

> 出口都必须可证伪；不通过不发。建议顺序：R1 → R2 → R3/R4 并行 → R5 → R6 → R7 → R8。

| ID | P | 状态 | 事项 | 出口（可证伪） | 估时 |
|---|---|---|---|---|---|
| R1 | P0 | done | 版本号与根 shim | 包与根 `package.json` 均为 `0.1.2-preview.1`（根依赖 `^0.1.2-preview.1`）；`node scripts/sync-root-version.mjs --check` 输出 in sync（2026-11-25）。tag 的 gitHead 校验移到 R8，发布时做 | 0.5d |
| R2 | P0 | done | 新建 `RELEASE-NOTES-0.1.2.md` | C1–C12 各有小节，升级/已知问题/发布步骤齐全；证据表已回填 CI run 45645941780、许可/打包与 `publish --dry-run` 结果。发布后由 R8 追加 npm 安装记录 | 1d |
| R3 | P0 | partial | 预设与 DSH 兼容矩阵 | 预设 `setup --check` ok、`check-release-preset` ok、`doctor` 的 `preset-standard-drift` PASS（2026-11-25）；**13 版本矩阵尚未用 0.1.2-preview.1 重跑**：本沙箱无 systemd 用户总线，kern 起不来，需普通终端重跑或等 tag CI，结果回填 `DSH-MATRIX.md` | 1d |
| R4 | P0 | done | 用户文档 + 架构文档同步 | 根 README/README.en 与包 README/README.en 已到 0.1.2-preview.1，新能力进“本版变化/已知边界/预览说明”；`docs/user/{preview,install,README}`(+en)、`docs/llm/library.md`(+en)、`skills/cad-toolbox/SKILL.md`、`library/README.md` 版本口径更新；DESIGN.md 新增 §38（dryRun/preflight、sweep、fit/gear、悬垂、热力图/主题、oracle 退役、示例展示）；examples 索引按“进新退旧”移动 3 个；`grep "0.1.1-preview.1"` 只剩历史文件与旧运行说明 | 2d |
| R5 | P1 | done | 发布门禁补齐 | `accept:preview` 从 29 增至 44 个脚本：本版 15 个验收全部接入（assembly golden/分支、measure 两个 smoke、motion joint-pairs/gear/sweep/fit、overhang/heat/analyze/generate-preflight、library-catalog、tokens、plugin-issues）；`accept` 聚合也纳入 plugin-issues（68→69）。15 个脚本逐个 exit 0（本地用可写 runtime overlay；assembly/motion 的 EROFS 是沙箱只读导致，不是脚本问题） | 1d |
| R6 | P0 | partial | 发布证据：全矩阵 + release gate | CI [run 45645941780](https://github.com/songsenand/yingzao/actions/runs/45645941780)（commit `da2fc2d`）：Ubuntu/macOS `accept:preview`、Windows smoke、CadQuery job 全 PASS；本地单条 `accept:release` 未跑（沙箱），其组成由 CI 两个 job 覆盖。**余**：DSH 13 版本矩阵需普通终端重跑（或另立 CI job） | 1d |
| R7 | P1 | done | 许可与打包 | `accept:license` 15/15；`npm pack --dry-run` 651 files / 10.1 MB packed / 34.1 MB unpacked；`npm publish --dry-run --tag preview` exit 0；CI Ubuntu 解包后 setup/doctor smoke PASS（含 packed preset 无绝对路径）。本机未跑 `rehearse:preview`（沙箱），其链路由 CI 同步骤覆盖 | 0.5d |
| R8 | P0 | done | 发布与发布后验证 | **已发布 `0.1.2-preview.1`**（2026-11-26 00:39 +08）：`dist-tags.latest` 指向本版，gitHead `d229536`，shasum `dbe385ed…`；由维护者在手机 npmjs.com 的 Staged Packages 批准（CLI token 只有 `package:write`，approve/reject 404、直发 E409）。发布路径与下次提示见发布说明 §8 | 0.5d |

> R5 的缺口依据：`accept:preview` 覆盖 29 个脚本，`accept` 是 68 个脚本。上面 15 个缺口里，
> 13 个脚本在 `accept` 里但不在 `accept:preview`/`accept:release` 里；另 2 个
> （`accept-motion-joint-pairs`、`accept-plugin-issues`）连 `accept` 聚合都不在。

---

## 2. 本版内容：已进树、发布说明必须覆盖（C1–C12）

> 这些不是“待做”，是“已做但未进版”。发布说明漏一条，用户就看不到一条。若发布前回滚某项，
> 从说明里删掉并记 DECISION-LOG。

| ID | 改动 | 证据 |
|---|---|---|
| C1 | 关节包络/fit、扫掠筛查、motion gear 与工具面 | `ad6d9ca`；`accept:motion-gear` / `accept:check-sweep` / `accept:motion-fit-tool` / `accept:tool-params` / `accept:tool-contracts` |
| C2 | 悬垂改为支撑成本，工艺档案 `hard` 才 gate | `30a0151`；`accept:overhang-policy` |
| C3 | 热力图支持用户切换图层 | `fb571ac`；`accept:heat-layers` |
| C4 | analyze 的融合峰补 probe/look | `34cc50a`；`accept:analyze-peaks` |
| C5 | generate_part 增加 dryRun/preflight 门禁 | `5497ab4`；`accept:generate-preflight` |
| C6 | 插件 issue P0-01–P3-15（P2-10/P3-15 部分修） | `b4f7476` + [PLUGIN-ISSUES-2026-11-21.md](../PLUGIN-ISSUES-2026-11-21.md)；`accept-plugin-issues.mjs`（**未进门禁**，见 R5） |
| C7 | DIN 2098 六个规格补弹簧参数（`source=estimated`） | `b8242a2`；`accept-library-catalog` |
| C8 | 四个新示例：缝纫旋梭、三速后拨（各含 CadQuery 变体） | `18a0245`；[examples/README.md](../../examples/README.md) |
| C9 | 面板配色改 CSS 变量、跟随宿主亮/暗主题 | `4e2a553`；`accept-tokens` + `accept-ui` 的 `assert=theme` |
| C10 | CI 分层（快检/夜间全量/tag 门）+ 并发取消 + 运行时缓存；本地 13 版本 DSH 矩阵 | `0d8a85e`、`75293b1`；`.github/workflows/preview.yml`、[DSH-MATRIX.md](DSH-MATRIX.md) |
| C11 | 退役 TS oracle：measure/assembly/motion/printability 的 parity 实现删除，改 Python smoke + golden/分支覆盖 | `dc4af83`、`88e1174`、`c838f25`、`8ed9040`、`1fd9703`、`150c26b`；`accept-measure-part-smoke` / `accept-measure-gap-smoke` / `accept-check-assembly-branches` / `accept-assembly-golden` / `accept-motion-joint-pairs` |
| C12 | 根 shim 版本脚本 + CI 校验；`dsh plugin add github:…` 解析到真实包 | `70a0e1e`、`8e0b3fa`；fast gate 的 `sync-root-version --check` |

---

## 3. 0.1.2 线剩余（不阻断 `0.1.2-preview.1`）

> 这些是原 0.1.2 主题（体验/证据/示例）里**还没做完**的部分。本版先发已落地的改动；
> 它们随 `0.1.2-preview.1` 或 0.2 继续。不要因为“0.1.2 要发”而临时开工。

| ID | P | 状态 | 事项 | 剩余出口（可证伪） | 估时 |
|---|---|---|---|---|---|
| U01 | P1 | partial | 面板视觉重做 | tokens 与亮/暗主题已落（C9），`accept-tokens` 零字面量、`accept-ui` 的 `assert=layout` 覆盖密度/对齐；**余**：同一任务在新旧 UI 各跑一次，截图对照 + 用户签收（U01 ③） | 2d |
| U02 | P1 | partial | 更多高质量示例 | 4 个新示例已入库并进索引；展示策略已执行（ball-and-stick、multirotor-propeller、toy-balance2 移到历史表，目录/语料未删除）。**余**：干净环境按 README 复现并记录耗时；旋梭 README §6 的 6 项未决（5 项待办 + 1 条教训：带耦合 physics、时序脚本按 r101 重算、旧 run `retire` 后 audit 可判、GT2 齿形、新件工艺筛查/视觉复核） | 3–5d |
| L10 | P2 | planned | STEP 完整导出路径 | 单件 + 项目 ZIP 的 STEP 已有；**余**：STEP 回读往返；B-rep 与 STL 体积/bbox 一致性；三平台 smoke | 3–5d |
| N15 | P1 | partial | 流体长任务的进度 / 取消（A 方案） | 只做流体，不做通用异步 job：进度 = 已跑步数/总步数；取消 = 终止本次 worker 请求并标 `cancelled`，不留孤儿 worker。语料：fluid 中位 37s、最长 161s；motion/physics ≤13s，暂不扩。出口：161s 的流体跑能看到百分比，取消后 1s 内回到空闲且 run 标 cancelled | 2d |
| L1.13 | P1 | partial | 标准件目录工具入口 | 99 specs / 14 families 与 `accept-library-catalog` 已通；**余**：`cad_part` 的 list/get/import-by-catalog、结构化 `libraryRef`、catalog 进 preview/release、E2E import→datum→check | 2–3d |
| P2-10 | P2 | partial | 装配可装入性 | 已判封闭腔/大面积不可达；**余**：全序列插入检查 | 2–3d |
| P3-15 | P3 | partial | 参数/schema 小问题 | `-0.0` 已修；余 `/tmp` 路径可见性属 harness core，插件侧不做（可转 `dropped`） | — |
| L16 | P1 | planned | 示例语料重跑 | `windup-frog` 的 r064 整机演示未重跑；`accept-verify` 期望随语料更新；每个示例的 verify/README/截图一致 | 2–3d |

---

## 3.5 2026-11-26 用户新提四项（流体/视口/大项目/引擎对比）

| ID | P | 状态 | 事项 | 剩余出口（可证伪） | 估时 |
|---|---|---|---|---|---|
| F1 | P0 | partial | 流体域闭合与「管外」审计 | 已修种子（Ø60/Ø30 的 27.5% 管外种子被拒；同类管道 run 现在会报管外，而不是假 pass）；新增 `outsideSnapshotMax`、`seedStats.rejectedOutside`；`accept-fluid-sign` 21/21、`accept-m4` 全过。**余**：壁厚 <2 格的政策（拒绝或自动细化）与验收；穿壁后的粒子级约束/入口回流；dx 减半的收敛曲线 | 2–3d |
| F2 | P1 | planned | 流体预设流轴与短粗件 | `deriveFluidPreset` 取包围盒最长轴，Ø44×30 的管会沿横截面驱动（实测 46 个管外粒子）。出口：长径比 <1 的管选对轴且 `outsideSnapshotMax`=0；加一条对应验收 | 1d |
| U10 | P1 | planned | 大装配视口布局：图例收纳 | 42 件回放的图例是 flex-wrap 的 42 个 chip（约 6 排、~120px），挤压 `flex:1` 视口。出口：默认单行摘要 + 展开限高 2 排/搜索/「只看运动件」；42 件时视口高度占比 ≥ 基线 +20%，`sandbox` DOM 断言图例 ≤2 排 | 2d |
| U11 | P1 | planned | 视口导航：正交/透视、六标准视图、轴吸附 | 角落三轴（`overlay.ts`）随相机转但只读，没有顶/前/侧/等轴按钮。出口：点 +X/−X/+Y/−Y/+Z/−Z 吸附、顶/前/侧/等轴一键、Home 复原、透视/正交切换；`accept-viewport-orbit` 扩断言 + 截图 | 2d |
| U13 | P2 | triggered | 优化历史版本的选择与展示方式 | **占位，不预设做法**：触发条件 = 想清楚用户在什么场景下要找旧版/对比/回看；届时再定怎么改，不写历史栈、快捷键、频率闸门等具体机制 | — |
| U12 | P1 | next | 装配预览：逐件显隐 / 隔离 / 高亮 | 爆炸只能整体看，不能单独看一对配合。出口：整机/装配视图中隐藏或隔离单件后，其余件仍可爆炸；选中件高亮；不改相机取景；`sandbox` 场景断言 + 截图 | 2–3d |
| U14 | P1 | planned | 任一检查一键重跑 | 现在只有流体按钮。出口：从当前版本重跑制造/应力/装配/运动/物理任一检查，来源版本 = 当前版本，新 run 出现且可取消；复用 `runFluidJob` 的手动发起路径 | 2d |
| U15 | P1 | planned | 测量家族 + 测量历史 | 面板只有距离与壁厚；角度/间隙/剖面面积/孔特征在宿主工具里已有。出口：四种测量能在视口完成；测量列表可命名/删除并随截图带走 | 2–3d |
| U16 | P1 | planned | 结构化请求 + 几何标注 | 现在只有「截图 + 自由文本」。出口：标注携带 `(versionId, 面/点, 相机)`，切视角仍回到原位；请求草稿含版本 + 区域 bbox + 实测 + 目标值，一键发进会话 | 3d |
| U17 | P1 | planned | 接口 / datum 可视化（9a） | 契约表一行只有数字，3D 看不出是哪两个面。出口：点接口行 → 高亮两个零件、在 datum 点之间画线、显示实测间隙 vs 容差；不预生成接口图 | 3–4d |
| U18 | P2 | planned | 爆炸动画 / 导出（9b） | 现在只有静态滑块。出口：0→100% 播放/暂停、导出 GIF/WebM、重开预览保持爆炸状态 | 1–2d |
| U19 | P1 | planned | 面板审计视图（audit + preflight 合并） | 面板只显示 run 卡片，看不到 `cad_deliver audit` 的 blocked/warn 清单和“哪一步没跑”。出口：机器页列出 blocked/warn/pass 行 + preflight 未覆盖项，点行跳对应 run；与工具**同一实现**，不写第二套判定 | 2–3d |
| U20 | P1 | next | 任意剖切 + 剖切面封盖 | 现在只有 x/y/z + 滑块，斜切内部流道做不到，切开是空壳。出口：任意平面（点+法向）、保留/切除互换、封盖；斜切管道能看到空腔；截图 | 2–3d |
| U21 | P1 | next | 大网格加载进度 + WebGL 上下文恢复 | 百万面网格失败只显示卡片，切标签页回来可能白屏。出口：加载有进度；上下文丢失后自动重建，不白屏；不做 LOD | 2d |
| U22 | P1 | planned | BOM CSV 导出 | 机器页有节点表，但没有数量/材料/工艺/来源，也没有 CSV。出口：一键导出 `零件名,版本,数量,材料,工艺,来源,库存编号`，直接给加工/报价/采购 | 1d |
| U23 | P2 | planned | 带标尺的视图导出 | 截图是画布原样，没有比例尺/分辨率/透明背景。出口：导出 PNG 带比例尺，可选分辨率与透明背景，标注已烘焙 | 0.5–1d |
| U24 | P3 | triggered | 版本/运行备注 | **确有需要时再做**：给版本或 run 写一句人话（“这版打印过/孔紧/不要用”），sidecar 存储、列表可见、可搜索；不预设现在就做 | 1d |
| G1 | P1 | planned | 项目级规划工件（长期） | 无「需求→零件→接口→验证」矩阵与阶段门；绕线器 20 件/76 版/86 run（66% 非 pass）。出口：最小 plan schema + 人确认 + 阶段门接入 audit；回放同一需求，版本数 −30%、漏孔级联 0 次 | 5–8d |
| G2 | P1 | planned | 大项目混乱归因摸排（先于 G1 实现） | 判别 H-LLM vs H-插件：计划优先 vs 无计划两组，记录返工轮数/触及零件数/首次运动 pass 前版本数；产出归因表与下一步 | 2–3d |
| E1 | P1 | partial | 引擎×大项目量化（CQ vs OpenSCAD） | 回顾完成：两对示例是**同题材不同 brief**（旋梭 1.5× 带传动 vs 2× 齿轮；后拨 0/5/10 内置定位 vs 0/4/8 外置指拨），fail% 方向相反（旋梭 CQ 66.7% vs SCAD 46.6%，z=−2.19；后拨 CQ 5.8% vs SCAD 19.6%，z=+2.66），且计入 `check` 后后拨优势消失（z=+0.79）、唯一显著的是旋梭 CQ 更差（z=−2.08）；CQ 两版确实做了更大装配（29/17 件），但旋梭 CQ 只有 42 run（SCAD 103）。报告 `experiments/20261126_engine_large_project_retro.md`、脚本 `experiments/scripts/20261126_engine_corpus_stats.py`。**余**：受控 pilot（3 task × 5 会话/组，冻结 brief/SUT/rubric，补 token/墙钟/返工轮数仪表），再决定是否扩到 40–60/组 | 3–5d pilot |

> 四项都不阻塞 `0.1.2-preview.1`（已发布）。F1 只做了「种子与审计」层，
> 不要把它读成「流体已加强完成」；U10/U11 与 L8 的 UI 批次、X14 的点选延后不冲突；
> E1 的回顾报告是 `experiments/20261126_engine_large_project_retro.md`，不属于 [PLAN-2026-11-26.md](../PLAN-2026-11-26.md)。

---

## 4. 引擎路线（0.1.1–1.0）

| 阶段 | 目标 | 触发/说明 |
|---|---|---|
| 0.1.1 | OpenSCAD + CadQuery 两个一等公民 | **已发布** `0.1.1-preview.1`（2026-11-20） |
| 0.1.2 | **不新增引擎**；把 11-20 之后的改动发成预览版，再补 §3 的剩余项 | **当前**；发布阻断见 §1 |
| 0.2 | **不新增引擎**；深度/质量（STEP 完整、BRep datum、示例重跑） | 0.1.2 稳定 |
| 0.3 | 第三个引擎**评估**（build123d/FreeCAD 二选一） | 真实需求 + 3-task benchmark；不承诺一定接 |
| 0.4 | 社区/用户自行接入（本地 manifest + conformance + unverified） | 0.3 稳定 + 用户请求；不做市场 |
| 1.0 | 第一梯队冻结 + 社区路径文档化 | 兼容矩阵/迁移 |

**第一梯队准入标准（不变）：**

1. LLM 能稳定写出非平凡零件（首次编译通过率/修复轮数有数据）；
2. 本地无头、确定性、可 pin；
3. 输出闭合网格；能声明 datum；
4. 有安装/平台/许可方案；
5. 有 GUIDE + 示例 + acceptance；
6. 有真实用户需求。

少一条 → 只能是 community adapter，不能叫 first-class。

**第三个引擎的触发（不早于 0.3）：**

- 有真实用户需求（不是“技术上能接”）；
- 3-task benchmark（bracket / 齿轮副 / 扫掠或螺纹）证明 LLM 能写好；
- 接入不要求改核心（最多一个 provider + 一个 GUIDE）；
- 否则不排。

**社区适配的触发（0.4+）：**

- 第一梯队稳定；
- 有用户愿意自带 GUIDE/验收；
- 信任/安装/版本/许可方案定稿；
- 否则不做。

---

## 5. 中远期（L2–L14；L16 见 §3）

> L1 已在 §1/§3/§7；L10 已在 §3，L15 已延后为 §6 的 X14。这里不重复“第二内核”。

| ID | P | 状态 | 事项 | 为什么/触发 | 出口 | 来源 |
|---|---|---|---|---|---|---|
| L2 | P1 | planned | 判据供给产品化 + 判据标定 | r104 0/25 vs r007 122/122：手写契约会漏判据；0.25/0.75 是声明值 | `assembly.json` 成为构建产物；coupon 实测回填 tolerance/壁厚/卡扣 | ASSESSMENT G1/G1.5 |
| L3 | P1 | planned | 装配清单 v2 + 装配级版本图 | 层级/端口/介入分级未做；拼接依赖版本图 | 跨层变换、端口解析、`review: auto\|human`、A@v3+B@v7→装配 v12 | DESIGN §12.2 |
| L4 | P1 | planned | 物理验证回路 | 试打/卡尺/拉脱未做；卡脚力是梁模型 | 实测回填 profile 与 tolerance；拉脱/试打步骤文档化 | ASSESSMENT G8；实验 20261108 |
| L5 | P1 | planned | 检查器标定 + bench 重跑 | 无变异测试；旧 bench 指纹失效；成本未测 | 50 个已知缺陷的检出率/误报率；新 SUT 指纹；token 成本 | ASSESSMENT G3/G4/G7 |
| L6 | P1 | planned | 权威编辑 + 审批/回滚 | `status` 恒 draft；回滚无一键；Customizer 只改顶层标量 | 版本标签/HEAD/回滚；约束保持的编辑通道 | DESIGN §12.3；limits |
| L7 | P2 | partial | 装配视觉表达 + 接口解释图 | 2026-11-26 已落：装配 run 的爆炸视图（滑块）+ 整机预览（直接读 assembly.json 的 part@version/transform，不依赖 assembly run）；纯几何单测 9/9。**余**：逐件显隐/隔离/高亮、datum/接口连线、爆炸动画/导出/状态保持；E10 按需接口图仍冻结 | 余项待逐条确认后写入；E10 按需接口图 | DESIGN §12.2；UI E2/E10；[GAP](PLUGIN-GAP-2026-11-26.md) |
| L8 | P1 | planned | UI 剩余批次 | 面板仍是只读证据浏览器；但 tokens/暗色（C9）已完成 | 按 UI-EXECUTION 推 M-UI1→M-UI6；先做 T2.2/T2.6/T5.2 收尾 | UI-PLAN / UI-EXECUTION |
| L9 | P2 | triggered | C/D：会话显式绑定 / 稳定 id + 注册表 | 当前 C-lite 够用；触发条件见 PROJECT-SCOPE §6.4 | 创建时选项目、恢复确认、移动/多人/跨机 | PROJECT-SCOPE §6 |
| L11 | P2 | triggered | 外观检查 L1/L2 | 外观只在成套时判；规则/阈值未定稿 | `check_appearance` 接口与规则分层落地 | APPEARANCE-PLAN |
| L12 | P3 | planned | 研究储备：弹性本构 / 特征识别 / pixel-unproject | 未到产品化；先做场地评估 | 每项先写实验报告，不直接进工具面 | DESIGN §12.4；实验 20261107 |
| L13 | P2 | planned | 平台与分发：Win/mac 全矩阵、插件市场 | npm 已发布；CI 已分档（C10）；预览只承诺 Linux/macOS | tag 全矩阵证据 + 安装/升级路径；市场另议 | README；RELEASE |
| L14 | P3 | triggered | 多用户/云/移动 | 单用户本地够用 | 按 PROJECT-SCOPE 触发条件再评估 | DESIGN §2.2 |

> L16（示例语料重跑）已并入 §3，不在这里重复状态。

---

## 6. 条件触发 / 冻结（不要现在做）

| ID | 事项 | 当前处置 | 触发条件 |
|---|---|---|---|
| X1 | 外观检查 L1/L2 | 冻结，只留方案 | 成套外观成为验收项；规则/阈值定稿 |
| X2 | 接口解释图 E10 | 冻结，只留方案 | 契约表成为主审阅入口；再出现“图/数不一致” |
| X3 | 两 run 对比 / ghost | 冻结 | 仿真结果对比成为真实任务 |
| X4 | 面板 GLB viewer | 冻结 | 外观/GLB 交付成为真实需求 |
| X5 | Blender bpy lane | 冻结 | 不恢复；L1/L2/appearance 均在围栏内 |
| X6 | 珍珠执行层 | 降级/不恢复 | 除非有新的、与 V1 不重叠的契约需求 |
| X7 | 弹性 MPM | 研究储备 | 软体成为真实任务，且 rapier 不够 |
| X8 | K 因子/展开图 | 显式 handoff | 有折弯角/厚度/中性层模型或原始平板 DXF |
| X9 | 多用户/云/移动 | 不做 | PROJECT-SCOPE §6.4 的六条触发条件任一 |
| X10 | npm / 插件市场 | npm 已发布；市场不做 | 有外部用户与收录需求 |
| X11 | 第三个几何引擎 | **不排 0.1.2/0.2；0.3 才评估** | 真实需求 + 3-task benchmark + 不改核心 |
| X12 | 社区/用户自行接入 | **0.4+/1.0 前再做** | 第一梯队稳定 + 信任/安装/版本方案定稿 |
| X13 | 渲染器替换（Matplotlib/F3D/自写光栅器） | **不做**；OpenSCAD 常驻依赖 | 除非 OpenSCAD 无法满足渲染/剖切且用户重新拍板 |
| X14（原 L15） | 视口内选中零件 | **延后**；等视口功能更全面再评估（用户 2026-11-25） | 显隐/高亮/剖切/爆炸等视口能力到位，点选成为真实任务 |

---

## 7. 已收口（不要重复立项）

### 7.1 0.1.1 线

| 事项 | 证据/日期 |
|---|---|
| `0.1.1-preview.1` 发布 | 2026-11-20；npm `latest`；gitHead `f62124b`；包内预设 `list-agents` 出现 0 次（坏包问题已修） |
| L1.0 CadQuery 可行性探针 | pack 1.4–1.6 GiB、安装 197s、import 0.88s；`experiments/20261120_L1.0_cadquery_probe.md` |
| L1.1 最小引擎 seam | `compile(source,{kernel})` 唯一入口；`accept:engine-seam` 14/14、`accept:backend` 18/18 |
| L1.2 CadQuery provider | `accept:cadquery` 23/23；错误码 + fix 齐全；`doctor` 探针 pass |
| L1.3 源码/版本 pin + 分派 | `accept:kernel-switch` 15/15 |
| L1.4 统一验证入口 | STL Manifold + STEP cascadio/OCP BRepCheck；`accept:step-validation` 23/23 |
| L1.5 CQ 作者层 + 示例 | `accept:cadquery-authoring` 12/12；`docs/llm/cadquery.md` + `examples/cadquery/bracket.py` |
| L1.6 验收 + 跨内核回归 | Linux 全绿；Windows/macOS 状态如实写进 release |
| L1.7 文档/发布/许可 | README/limits/install/NOTICE/THIRD-PARTY、版本号与类型声明 |
| L1.8 预设与 dsh 对齐 | `fa41acd` + `f62124b`；`doctor` 的 `preset-standard-drift`；0.1.1-preview.1 已带修复 |
| L1.9 安装时内核选择 | `accept:setup-kernel` 10/10 |
| L1.10 会话内核上下文 | `accept:kernel-context` 10/10 |
| L1.11 同 prompt 内核质量 | 体积差 0.00066%；报告 `experiments/20261120_L1.11_kernel_quality.md` |
| L1.12 OpenSCAD 高版本强制 | `accept:backend` 24/24、`accept-provision` 22/22 |
| L1.4b 单件 STEP 直通 | `accept:step-validation` 23/23；`accept-project-export` 断言 `parts/A_v001.step`；ZIP 逐件带 STEP |
| U03 `assembly.json` 封印契约 | `accept:assembly-contract` 30/30 |

> 0.1.1 明确不做（已按计划后移，不再是“待办”）：U01/U02、渲染器替换、第三引擎、社区接入、
> 公开 `engine.json` 协议、STEP 完整审计路径、异步 render/sim 全量。

### 7.2 0.1.0 预览线与更早

| 事项 | 证据/日期 |
|---|---|
| 0.1.0-preview.5 发布 | npm + tarball；N01–N19 完成/部分完成 |
| N01–N13 预览 P0 | 见 `RELEASE-0.1.0-PREVIEW.md` 与 release notes |
| N14/N16/N17/N18/N19 | 预览 P1 收口；N15 仅 OpenSCAD 编译 job（剩余见 §3） |
| 9 个作业面 cutover | 39 工具 → 9 surface；`accept-surface-cutover` PASS |
| 标准件库 v0 | 99 specs / 14 families；`accept-library-catalog` PASS（数据+脚本；工具入口见 L1.13） |
| 整项目导出 ZIP + 合并 STL | 2026-11-11，`accept-project-export` PASS（含逐件 STEP 断言） |
| 工艺目录 0 planned | 2026-11-12，`accept-sheet2d`/`accept-turning`/`accept-cnc-access`/`accept-edm-access` |
| 核心脊柱：派生义务不派生动作 | 2026-11-12，`experiments/20261112_core_spine_probe.md` |
| UI T0/T1/T2.1/T2.4/T2.5/T3/T4 | `docs/UI-EXECUTION.md` |
| 图片修剪 24 张窗口 | DESIGN §13.10 |
| 整项目导出的版本钉住规则 | DECISION-LOG 2026-11-11 |
| 硬阻断导出 | **已否决**，改为 C1 风险标注导出 |
| 单件外观判定 | **已否决**，外观只在成套时判 |

---

## 8. 来源索引（漏项时回这里找）

| 来源 | 里面有什么 | 本文件对应 |
|---|---|---|
| [RELEASE-0.1.1.md](RELEASE-0.1.1.md) | 0.1.1 目标、范围、验收、排期（已发布，历史） | §7.1 |
| [RELEASE-NOTES-0.1.2.md](RELEASE-NOTES-0.1.2.md) | **本版发布说明**：C1–C12 用户可见变化、升级、已知问题、证据表 | R2、R4 |
| [RELEASE-NOTES-0.1.1.md](RELEASE-NOTES-0.1.1.md) | 0.1.1-preview.1 发布说明与已知问题 | §7.1 |
| [RELEASE-0.1.0-PREVIEW.md](RELEASE-0.1.0-PREVIEW.md) | 预览版 DoD、P0/P1、C1/A3/A2 设计、排期（历史） | §7.2 |
| [RELEASE-NOTES-0.1.0-preview.2.md](RELEASE-NOTES-0.1.0-preview.2.md) | preview.2 发布说明与已知问题（历史） | §7.2 |
| [PLAN-2026-11-26.md](../PLAN-2026-11-26.md) | 2026-11-26 新提三项：流体管外实锤/审计、视口图例与轴、大项目规划空白的证据与设计 | F1、F2、U10、U11、G1、G2 |
| [PLUGIN-GAP-2026-11-26.md](../PLUGIN-GAP-2026-11-26.md) | 插件能力快照（候选，逐条确认后才写入）：51 条（16 有/7 部分/28 无）、最该补的 10 条 | 审 L7/L8/U11/U13/N15 时参考 |
| [PLUGIN-ISSUES-2026-11-21.md](../PLUGIN-ISSUES-2026-11-21.md) | 自行车后拨两次会话的插件 issue P0-01–P3-15、修复与复现 | C6、P2-10、P3-15 |
| [DSH-MATRIX.md](DSH-MATRIX.md) | 13 个 in-range 0.2.x 的本地实测表与断言 | R3、C10 |
| [ASSESSMENT-2026-10-28.md](ASSESSMENT-2026-10-28.md) | G1–G8 缺口、P0/P1/P2 路线 | L2–L5、L12 |
| [DESIGN.md §12](../../DESIGN.md) | 已完成/当前主线/待办/长期 | L3、L6、L7、L12 |
| [UI-PLAN.md](../UI-PLAN.md) / [UI-EXECUTION.md](../UI-EXECUTION.md) | 面板 P0/P1 与施工顺序 | U01、L8、L7 |
| [PROJECT-SCOPE.md](PROJECT-SCOPE.md) | B/C/D 路线与触发条件 | L9、L14 |
| [DECISION-LOG.md](../DECISION-LOG.md) 的“未决/非目标” | 单条决策留下的尾巴 | 全文，尤其 L11、X1–X12 |
| `experiments/` 最近报告 | 研究结论与下一步 | L4、L12、L1.0、L1.11 |
| [examples/README.md](../../examples/README.md) | 当前示例/归档/题库的分类与证据索引 | U02、L16 |
| [HARNESS.md §10](../../HARNESS.md) | 开放化顺序 | L13、X12 |
| [README.md](../../README.md) | 分发方式、平台与已知边界 | L13、R4 |

---

## 9. 更新纪律

1. **本文件是唯一 TODO 索引。** 新计划先在“来源索引”里登记，再在表里加行；不再新建第二张总表。
2. **ID 稳定。** 完成后不删行，移到“已收口”并写 commit / accept 脚本 / 实验报告。
3. **状态只在这里改。** 来源文档只写设计细节，不写“已完成/待办”的第二份状态。
4. **节奏：发布前每天 review；平时每周一。** 每次只回答三个问题：本周做哪三件、哪件被卡、哪件该降级。
5. **顺序冲突时：** 本文件决定顺序/状态，来源文档决定设计细节；不要让两个表互相覆盖。
6. **新增“未决”时：** 要么进“待拍板”，要么进“条件触发”，不要留在正文里当注脚。
7. **引擎纪律（2026-11-19）：** 第三个引擎和社区适配不因讨论自动进表；必须由用户拍板，并满足 §4 的触发条件。
8. **版本事实以 npm registry + git tag 为准（2026-11-25）：** 不保留“latest 坏包”这类会过期的断言；
   R1/R8 的出口就是版本事实的复核方式。
9. **staged 审批优先走手机（2026-11-26）：** `npm stage publish` 之后若 CLI 无 approve/reject 权限，先提示用户用手机 npmjs.com → Staged Packages 批准；不要先改版本号或换更高权限 token。

---

## 10. 当前建议（2026-11-25）

- **已发布（2026-11-26）**：`0.1.2-preview.1` 是 npm `latest`；CI run 45645941780 全绿；
  发布路径与手机批准 staged 的记录见发布说明 §8。
- **下一步**：① DSH 13 版本矩阵补跑（R3/R6 余项，普通终端）；② §3 的 0.1.2 线剩余
  （U02 复现记录、L10、N15、L1.13、P2-10、L16；U01 签收）；③ §3.5 的 F1/F2
  （流体先做壁厚政策与短粗件，再谈视口 U10/U11）；G2 摸排可与 UI 并行，G1 不抢发布线；E1 的受控 pilot 先补仪表再跑。④ 2026-11-26 逐条确认：1–3、5–6 = U12/U11/U14/U15/U16；4 = N15 按 A（只做流体进度/取消）；7 归 agent 侧（不做 UI 项）；8 = U13 占位；9 = U17（接口/datum）+ U18（爆炸动画/导出）；追加：U19（audit+preflight 合并）、U20（任意剖切+封盖）、U21（大网格/上下文恢复），其中 U20/U21 用户指定 P1 靠前，排在 U12 之前；E 拆成 U22（BOM CSV）+ U23（带标尺导出）；F = U24 备注，P3/triggered，确有需要时再做。
- **不要在发布后立刻做的**：第三个引擎、社区适配、渲染器替换；视口点选仍是 X14。
- **下次发布**：先问“能否用手机 npmjs.com 批准 staged”，再决定 token/版本号动作。
