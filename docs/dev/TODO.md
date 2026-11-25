# 项目 TODO 总表

> **状态**：单一索引（2026-11-12 创建；**2026-11-25 按 `0.1.2-preview.1` 重排**）。
> **作用**：把散落在 `RELEASE-0.1.1.md`、`RELEASE-NOTES-0.1.1.md`、`RELEASE-0.1.0-PREVIEW.md`、
> `PLUGIN-ISSUES-2026-11-21.md`、`ASSESSMENT-2026-10-28.md`、`DESIGN.md §12`、
> `UI-PLAN.md` / `UI-EXECUTION.md`、`PROJECT-SCOPE.md`、`DECISION-LOG.md` 的“未决/非目标/后续”
> 收成一张有序的表。
> **规则**：本文件决定**顺序、状态、优先级**；设计细节留在来源文档。不要在两处同时维护状态。
> **状态词**：`next` / `doing` / `planned` / `partial` / `blocked` / `triggered` / `done` / `dropped`。
> **时间口径**：`0.1.1-preview.1` = 已发布（2026-11-20，npm `latest`）；`0.1.2-preview.1` = 当前，
> 发布阻断；`0.1.2` 线剩余 = 其后；`0.2–0.4` = 中远期；`1.0` = 冻结。

---

## 0. 现在只做一件事

**`0.1.2-preview.1`：把 2026-11-20 之后已经落地、但还没进版的改动收成可发布的预览版。**

- 0.1.1 的双内核主线已经收口（L1.0–L1.12 全绿，`0.1.1-preview.1` 已发布）。本版**不新增引擎、不改 seam**。
- 本版内容是 11-20 → 11-25 的 33 个提交（截至 2026-11-25），按 §2 归为 C1–C12：关节包络/fit、扫掠筛查、motion gear、
  悬垂政策、热力图图层、analyze probe/look、generate dryRun/preflight、插件 issue 修复、
  DIN 2098 弹簧参数、四个新示例、主题变量、CI 分层、DSH 矩阵、TS oracle 退役。
- **本版没有“再写一个功能”的阻断项；阻断项全在“包与说明”**：版本号/tag、发布说明、预设与 dsh 对齐、
  文档口径、门禁覆盖、全矩阵证据、许可打包、发布后验证（§1 的 R1–R8）。
- **版本线（2026-11-25 用户确认）**：下一版按 `0.1.2-preview.1` 发；0.1.1 线不再单独补发修订版。
  若决定先补 0.1.1 修订版，把 R1/R2 的版本号改成 `0.1.1-preview.2` 即可，其余不变。
  依据见 DECISION-LOG 2026-11-25。
- **纠正一条过时结论**：npm `latest` 的 `0.1.1-preview.1`（gitHead `f62124b`）**已包含预设修复**，
  不是坏包；“latest 仍是坏包、待发 0.1.1 修订版”的记录作废。

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
| R1 | P0 | next | 版本号、根 shim 与 tag | 包与根 `package.json` 版本均为 `0.1.2-preview.1`（根依赖范围 `^0.1.2-preview.1`）；`node scripts/sync-root-version.mjs --check` exit 0；tag `v0.1.2-preview.1` 的 gitHead 与 `npm view dsh-cad-harness@0.1.2-preview.1 gitHead` 相等 | 0.5d |
| R2 | P0 | next | 新建 `RELEASE-NOTES-0.1.2.md` | §2 的 C1–C12 每条都有对应小节；升级须知（装后必须重跑 `dsh-cad-setup`）保留；已知问题至少覆盖：render/sim 仍同步、标准件目录无工具入口、CQ pack 1.4–1.6 GiB、DSH 0.2.3-alpha.1 上游不可用、平台证据（Linux 本机实跑；macOS/Windows 走 CI：tag 全矩阵，夜间也有 macOS 全量 + Windows smoke）；含 Linux `accept:release` 与全矩阵 run 的链接 | 1d |
| R3 | P0 | next | 预设与 DSH 兼容矩阵 | 用发布机的 dsh 重生成 `presets/cad/preset.patch.yml`；`node scripts/check-release-preset.mjs` exit 0；`dsh-cad-doctor` 的 `preset-standard-drift` PASS；`DSH-MATRIX.md` 重跑 13 个 in-range 版本并把“插件版本”改为 0.1.2-preview.1；README 的版本表与矩阵一致 | 1d |
| R4 | P0 | next | 用户文档 + 架构文档同步 | 根 README/README.en 与包 README/README.en（npm 页）的徽章与安装段 = 0.1.2-preview.1；新能力（fit/扫掠/gear、dryRun/preflight、热力图、悬垂政策）在用法/已知边界有落点；`docs/user/preview.md`(+en) 改名并补本版能力与边界，`docs/user/install.md`、`docs/user/README.md`、`dsh-cad-harness/library/README.md` 同步；`docs/llm/library.md`(+en)、`skills/cad-toolbox/SKILL.md` 的版本口径更新；DESIGN.md 补新增模块语义（joint fit、sweep、gear、heat layers、overhang、dryRun/preflight、oracle 退役）；`grep -rn "0.1.1-preview.1"` 只命中历史文件（`RELEASE-0.1.1.md`、`RELEASE-NOTES-0.1.1.md`、DECISION-LOG、archive） | 2d |
| R5 | P1 | next | 发布门禁补齐 | `accept:preview` 当前只覆盖 29 个脚本（`accept` 68 个）。本版相关的 15 个缺口：`accept-library-catalog`、`accept-tokens`、`accept-measure-part-smoke`、`accept-measure-gap-smoke`、`accept-check-assembly-branches`、`accept-assembly-golden`、`accept-heat-layers`、`accept-overhang-policy`、`accept-analyze-peaks`、`accept-generate-preflight`、`accept-motion-gear`、`accept-check-sweep`、`accept-motion-fit-tool`、`accept-motion-joint-pairs`、`accept-plugin-issues`。其中 `accept-plugin-issues` 与 `accept-motion-joint-pairs` 连 `accept` 聚合都没进，`accept-library-catalog`/`accept-tokens`/`accept-plugin-issues` 没有 `accept:*` 别名；先把别名与聚合补齐，再全部接进 `accept:preview`。出口：`accept:release` 全绿；preview 覆盖的脚本数从 29 增至 ≥43 | 1d |
| R6 | P0 | next | 发布证据：全矩阵 + 本地 release gate | tag 前一次 `workflow_dispatch` 全矩阵 run 成功（Ubuntu + macOS + Windows smoke + CadQuery pack），run 链接进发布说明；Linux 本地 `npm run accept:release` PASS；若 Windows 失败，发布说明如实写并开 issue，不阻塞 Linux 预览 | 1d（等 CI） |
| R7 | P1 | next | 许可与打包 | 把 `RELEASE-LICENSE-CHECKLIST.md` 的版本标题与勾选项更新到 0.1.2-preview.1；`accept:license`、`npm pack --dry-run`、`rehearse:preview` 全过；包内无 `cad-data/`、`bin/`、BOSL2、site-packages；NOTICE 覆盖 CQ/OCP/VTK；DIN 2098 估算参数在 `library/README.md` 标明 `source=estimated` | 0.5d |
| R8 | P0 | next | 发布后验证 | `npm view dsh-cad-harness dist-tags.latest` = 0.1.2-preview.1；干净 profile 按 README 安装 → `dsh-cad-setup` → `dsh-cad-doctor` → 生成 bracket → 导出 STL/STEP，日志留档；从 0.1.1-preview.1 升级时 `doctor` 能指出 `preset-standard-drift` 并给修复命令 | 0.5d |

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
| C11 | 退役 TS oracle：measure/assembly/motion 的 parity 脚本删除，改 Python smoke + golden/分支覆盖 | `dc4af83`、`88e1174`、`c838f25`、`8ed9040`、`1fd9703`；`accept-measure-part-smoke` / `accept-measure-gap-smoke` / `accept-check-assembly-branches` / `accept-assembly-golden` / `accept-motion-joint-pairs` |
| C12 | 根 shim 版本脚本 + CI 校验；`dsh plugin add github:…` 解析到真实包 | `70a0e1e`、`8e0b3fa`；fast gate 的 `sync-root-version --check` |

---

## 3. 0.1.2 线剩余（不阻断 `0.1.2-preview.1`）

> 这些是原 0.1.2 主题（体验/证据/示例）里**还没做完**的部分。本版先发已落地的改动；
> 它们随 `0.1.2-preview.2` 或 0.2 继续。不要因为“0.1.2 要发”而临时开工。

| ID | P | 状态 | 事项 | 剩余出口（可证伪） | 估时 |
|---|---|---|---|---|---|
| U01 | P1 | partial | 面板视觉重做 | tokens 与亮/暗主题已落（C9），`accept-tokens` 零字面量、`accept-ui` 的 `assert=layout` 覆盖密度/对齐；**余**：同一任务在新旧 UI 各跑一次，截图对照 + 用户签收（U01 ③） | 2d |
| U02 | P1 | partial | 更多高质量示例 | 4 个新示例已入库（旋梭、后拨各含 CadQuery 变体）。**展示策略（2026-11-25 用户）**：进新退旧——新示例进入“当前示例”展示时，把等量或更老的示例移到“历史/归档”，只改展示、不删除目录与语料。**余**：干净环境按 README 复现并记录耗时；`examples/README.md` 旋梭行仍写 r053/r052/r024，而旋梭 README 已是 r029/r101，需重跑或改索引；旋梭 README §6 的 6 项未决（5 项待办 + 1 条教训：带耦合 physics、时序脚本按 r101 重算、旧 run `retire` 后 audit 可判、GT2 齿形、新件工艺筛查/视觉复核）；0.1.2 先按展示策略把 3 个最老的当前示例（ball-and-stick、multirotor-propeller、toy-balance2）移入历史表 | 3–5d |
| L10 | P2 | planned | STEP 完整导出路径 | 单件 + 项目 ZIP 的 STEP 已有；**余**：STEP 回读往返；B-rep 与 STL 体积/bbox 一致性；三平台 smoke | 3–5d |
| N15 | P1 | partial | 异步 render/sim job | 当前 jobs 仍只覆盖 OpenSCAD 编译（`src/host/jobs.ts` 头注释）；submit/cancel/timeout 扩到渲染与仿真 | 3–4d |
| L1.13 | P1 | partial | 标准件目录工具入口 | 99 specs / 14 families 与 `accept-library-catalog` 已通；**余**：`cad_part` 的 list/get/import-by-catalog、结构化 `libraryRef`、catalog 进 preview/release、E2E import→datum→check | 2–3d |
| P2-10 | P2 | partial | 装配可装入性 | 已判封闭腔/大面积不可达；**余**：全序列插入检查 | 2–3d |
| P3-15 | P3 | partial | 参数/schema 小问题 | `-0.0` 已修；余 `/tmp` 路径可见性属 harness core，插件侧不做（可转 `dropped`） | — |
| L16 | P1 | planned | 示例语料重跑 | `windup-frog` 的 r064 整机演示未重跑；`accept-verify` 期望随语料更新；每个示例的 verify/README/截图一致 | 2–3d |

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
| L7 | P2 | planned | 装配视觉表达 + 接口解释图 | 复杂装配判读退化；契约表只有数字 | 显隐/高亮/爆炸/datum 标记；E10 按需接口图 | DESIGN §12.2；UI E2/E10 |
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
| [RELEASE-NOTES-0.1.1.md](RELEASE-NOTES-0.1.1.md) | 0.1.1-preview.1 发布说明与已知问题 | §7.1 |
| [RELEASE-0.1.0-PREVIEW.md](RELEASE-0.1.0-PREVIEW.md) | 预览版 DoD、P0/P1、C1/A3/A2 设计、排期（历史） | §7.2 |
| [RELEASE-NOTES-0.1.0-preview.2.md](RELEASE-NOTES-0.1.0-preview.2.md) | preview.2 发布说明与已知问题（历史） | §7.2 |
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

---

## 10. 当前建议（2026-11-25）

- **先做发布机械项**：R1（版本/tag）→ R2（发布说明）→ R3（预设/矩阵）→ R4（文档口径）。
  这四项不做完，后面的门禁与证据都会返工。
- **再补门禁**：R5 把 C1–C12 对应的验收脚本接进 `accept:preview`；当前 15 个本版相关脚本
  不在发布门禁里（13 个在 `accept` 聚合、2 个连聚合都没进）——等于“测了但不拦”。
- **证据一次做全**：R6 用一次 `workflow_dispatch` 全矩阵 + Linux `accept:release`；
  不要用“本机绿”代替 tag 证据。
- **打包与发布后**：R7/R8；干净 profile 安装记录是“包能用”的唯一证据。
- **本版不要做**：U01/U02 的视觉与示例重做、L10/N15、第三个引擎、社区适配、渲染器替换；视口点选已延后（X14）。
- **判断本版 ready 的一句话**：`npm view dsh-cad-harness dist-tags.latest` 指向 `0.1.2-preview.1`，
  且干净环境按 README 能装、能 `doctor`、能生成并导出——否则不算发完。
