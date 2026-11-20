# 项目 TODO 总表

> **状态**：单一索引（2026-11-12 创建；2026-11-19 按 0.1.1 目标重排）。
> **作用**：把散落在 `RELEASE-0.1.1.md`、`RELEASE-0.1.0-PREVIEW.md`、
> `ASSESSMENT-2026-10-28.md`、`DESIGN.md §12`、`UI-PLAN.md` / `UI-EXECUTION.md`、
> `PROJECT-SCOPE.md`、`DECISION-LOG.md` 的“未决/非目标/后续”收成一张有序的表。
> **规则**：本文件决定**顺序、状态、优先级**；设计细节留在来源文档。不要在两处同时维护状态。
> **状态词**：`next`（下一批）/ `doing` / `planned` / `blocked` / `triggered` / `done` / `dropped`。
> **时间口径**：0.1.1 = 当前（目标 4–6 周）；0.1.2 = 其后；0.2–0.4 = 中远期；1.0 = 冻结。

---

## 0. 现在只做一件事

**0.1.1：CadQuery 成为一等公民。**

不是做“通用引擎平台”，而是让 **OpenSCAD 和 CadQuery 两个后端都能完整走通**
「生成 → 验证 → 渲染 → 装配 → 导出 → 交付审计」。第三个引擎、社区适配都不在 0.1.1。

详细目标/范围/验收：[RELEASE-0.1.1.md](RELEASE-0.1.1.md)。

**引擎策略（2026-11-19 用户拍板）：**

- 第一梯队只放「市面上最常见、LLM 最擅长」的引擎；当前 = **OpenSCAD + CadQuery**。
- **OpenSCAD 是常驻依赖**：四视图、剖切、运动/装配关键帧与网格导出统一走 OpenSCAD；不替换为 Matplotlib/F3D/自写光栅器。CadQuery 只是新增作者引擎；一个项目仍只有一个作者引擎。
- **第三个引擎不排 0.1.2/0.2**；至少等 0.1.1 稳定、有真实需求、且 3-task benchmark 证明 LLM 能写好，0.3 才评估。
- **社区/用户自行接入后置到 0.4+/1.0 前**；0.1.x 不做公开 engine 协议、不做市场、不承诺“任意引擎”。
- 泛化只为「第一梯队接入不重复改核心」服务；不为未知引擎设计。

**0.1.0-preview 已收口：** preview.5 已发布；N01–N19 完成/部分完成。
preview 期间的长证据表不再逐行维护，保留在 §6 与 release notes。

---

## 1. 0.1.1（当前，目标 4–6 周）

> 原则：只做 CadQuery 逼出来的最小 seam；不为第三个引擎/社区适配提前抽象。
> 出口必须可证伪，不能写成“更好/更多”。

| ID | P | 状态 | 事项 | 出口（可证伪） | 估时 |
|---|---|---|---|---|---|
| L1.0 | P0 | done | CadQuery 可行性探针 | 功能通过：同一 bracket（4 孔 + fillet + datum）编译成功，STL 水密，bbox delta 0，volume delta -0.09 mm³；pack **1.4–1.6 GiB**（VTK 639 / casadi 277 MiB 主因），安装 197 s，import 0.88 s；trame/matplotlib 可省、**VTK 不可省**；报告 `experiments/20261120_L1.0_cadquery_probe.md` | 2d |
| L1.1 | P0 | done | 最小引擎 seam | `compile(source,{kernel})` 唯一入口；`EngineAdapter={id,compile}`，render/export 移出 adapter；`compileAndRender`/`compileStlOnly` 只差 `render` flag；`accept:engine-seam` 14/14、`accept:backend` 18/18、`accept-assembly`/`accept-inspect`/`accept-icd` 绿；fake engine 覆盖注册/未知/planned/重复/无 compile | 5d |
| L1.2 | P0 | done | CadQuery provider | `compile(...,{kernel:"cadquery"})` bracket 成功（STL 127,884 B）；`datum/datum_axis/datum_plane/datum_cyl` 与 SCAD 同一 DatumSet；`cadquery_syntax`/`cadquery_exception`/`cadquery_timeout`/`cadquery_no_result`/`cadquery_pack_missing` 各有 code+fix；`doctor` 探针 pass；pack `--target` 不污染 venv、不自动下载；`accept:cadquery` 23/23、`accept:backend` 24/24 | 7–10d |
| L1.3 | P0 | done | 源码/版本 pin + 分派 | `saveVersion` 支持 `sourceCode`/`sourceFile`/`backend`；manifest 记 `sourceFile` + `backend.kernel`；`readVersionSource` 兼容旧 `model.scad`；切内核后 v001 源/STL 不变；jobs 按 pin 分派（CQ 缺 pack → `cadquery_*`，不是 model.scad）；assembly 重建/export 按 sourceFile；`accept:kernel-switch` 15/15 | 3–4d |
| L1.4 | P0 | done | 统一验证入口 | `validateVersionGeometry`：STL 走 Manifold（designEvidence=mesh）；STEP 走 `import_mesh`（cascadio）+ 版本 `brep` 的 OCP BRepCheck；`stl_missing/stl_invalid/stl_not_manifold`、`step_missing/step_invalid/step_not_solid/step_invalid_brep/step_artifact_mismatch` 各有 severity+fix；`/api/cad/export?format=step` 只读 `model.step`；`accept:step-validation` 23/23、CQ STEP 23/23 | 3–4d |
| L1.5 | P1 | done | CQ 作者层 + 1 个示例 | `generate_part` 接受 `code`/`scadCode`（二选一）；CQ 编译后用 STL→OpenSCAD 出图；版本记 `model.py`+`cadquery`；`cad_session info` 报 `kernel`/`kernelSource`，`init_project` 可写 `defaultKernel`；`docs/llm/cadquery.md` + `examples/cadquery/bracket.py`；`accept:cadquery-authoring` 12/12 | 3–4d |
| L1.6 | P0 | done | 验收 + 跨内核回归 | Linux 全绿：engine 14/14、cadquery 23/23（临时 pack）、kernel-switch 15/15、step 21/21、authoring 16/16、kernel-context 10/10、setup 11/11、setup-kernel 10/10、doctor 21/21、jobs 18/18、export-http 26/26、`accept:release` PASS；Windows/macOS 未实跑，状态如实写进 release；diff 53 files/28 package 源码或脚本，按 seam 解释 | 2–3d |
| L1.7 | P0 | done | 文档/发布/许可 | README 技术栈/边界 + CadQuery；limits（pack 1.4–1.6 GiB、OpenSCAD 常驻、Python 无沙箱、VTK 不渲染）；install/`--kernel`；`RELEASE-NOTES-0.1.1`；NOTICE/THIRD-PARTY 补 CQ/OCP/VTK；版本号 `0.1.1-preview.1`；类型声明随包 | 2–3d |
| L1.8 | P0 | doing | 预设与 dsh 版本对齐（发布阻断） | 预设按 dsh 0.2.2-rc.1 重生成；`doctor` 增 `preset-standard-drift`（21/21）；`prepublishOnly` 改为 machine-neutral `check-release-preset`（不再依赖本机 skill 绝对路径）；README 升级提示；RELEASE-NOTES 记 preview.2–.5。**余项：发布 `0.1.1-preview.1` 修订版，latest 仍是坏包** | 1–2d |
| L1.9 | P0 | done | 安装时内核选择 | `dsh-cad-setup --kernel openscad|cadquery`；TTY 且无 flag 时询问（默认 openscad）；写 `backend.json` 并保留 compileBackend/binaryPath；CadQuery 只提示显式 pack（~1.6 GiB），不自动下载；`accept:setup-kernel` 10/10 | 1–2d |
| L1.10 | P0 | done | 会话内核上下文 | 每 agent 注册 `cad-kernel` prompt context（仅 CAD/no-preset 会话）；内容由项目 marker → 全局 `backend.json` 动态解析；CQ 明确 `generate_part({code})`/禁止 scadCode，SCAD 反之；`accept:kernel-context` 10/10 | 1d |
| L1.11 | P1 | done | 同 prompt 内核质量实验 | 同一 60×40×6 brief 经真实 `generate_part` 跑 OpenSCAD/CadQuery：bbox/水密/genus 一致，体积差 0.00066%、面积差 0.0019%；发现 CQ `.box` 原点偏移未被验证捕获，新增 `datum_outside_bbox` warn；报告 `experiments/20261120_L1.11_kernel_quality.md` | 1d |
| L1.12 | P0 | done | OpenSCAD 高版本强制 | 编译/provision/doctor 全部按最高版本选择；插件 2026.09.23 不被系统 2021.01 覆盖；`accept:backend` 24/24、`accept-provision` 22/22、`doctor` 21/21 | 1d |
| U03 | P1 | done | `assembly.json` 封印契约 | 唯一写入口 `cad_assembly write`：必须有 `reason` + `expectedRevision`（create=0），返回 `changeId`/`diff`；`assembly.seal` + `assembly/changes/` 链；通用 `write`/`edit` 走 CAD fs policy → `FS_PERMISSION_DENIED`；直改 → `contract-tampered`，`dsh-cad-contract rebuild` 恢复；`accept:assembly-contract` 30/30 | 3–5d |
| L1.4b | P2 | planned | 单件 STEP 直通（可选） | CQ 版本可下载 `model.step`；内核 `BRepCheck`；manifest 记 provenance；不做 ZIP/往返 | 2–3d |

**0.1.1 不做：**

- U01（面板视觉重做）、U02（更多示例）→ 0.1.2；
- 渲染器替换（Matplotlib/F3D/自写光栅器）→ 不做；OpenSCAD 常驻依赖；
- 第三个引擎 → 不早于 0.3，且先跑 benchmark；
- 社区/用户自行接入 → 0.4+/1.0 前；
- 公开 `engine.json` 协议、conformance kit、插件市场 → 0.3/0.4；
- STEP 完整审计路径（ZIP/往返/多平台）→ 0.1.2，除非 L1.4 提前收口；
- 异步 render/sim job 全量（N15 剩余）→ 0.1.2。

**排期建议：**

- 第 1 周：L1.0 + L1.1（均已完成）；
- 第 2 周：L1.2（已完成；pack 1.4–1.6 GiB 已接受）；当前下一步 L1.3。
- 第 3 周：L1.3 + L1.4（均已完成）；当前下一步 L1.5。
- 第 4 周：L1.5 + L1.6（均已完成）+ L1.7（已完成）；当前下一步 L1.8 发布修订版。
- U03 已完成（`accept:assembly-contract` 30/30），不阻塞主线。
- 发布前：L1.8（预设对齐 + 发布检查，待发布）+ L1.9/L1.10（已完成）；不通过不发。
- 4 周是 MVP；含完整跨平台验收/STEP 往返按 6 周算。

---

## 2. 0.1.2（0.1.1 之后）

> 0.1.2 不新增引擎；先把 0.1.1 的体验/证据/示例补齐。

| ID | P | 状态 | 事项 | 出口 |
|---|---|---|---|---|
| U01 | P0 | planned | 面板视觉重做 | ①一套 token（间距/字号/圆角/状态色）落到 `tokens.ts` 并被 3 个主要视图引用；②对齐与密度检查脚本（无孤行、无 1px 抖动、控件行高一致）；③同一任务在新旧 UI 各跑一次，截图对照 + 用户签收 |
| U02 | P0 | planned | 更多高质量示例 | ①至少 3 个端到端示例，每个都含：零件 → 装配契约 → 仿真/检查 → 交付审计通过（或明确 difficult 并说明原因）；②每个示例有 README + 一段面板回放；③新人在干净环境按 README 复现成功（记录耗时） |
| L10 | P2 | planned | STEP 完整导出路径 | 单件 + 项目 ZIP 的 STEP；STEP 回读往返；B-rep 与 STL 体积/bbox 一致性；三平台 smoke |
| N15 | P1 | partial | 异步 render/sim job | submit/cancel/timeout 覆盖渲染与仿真，不再只有 OpenSCAD 编译 |
| L15 | P2 | planned | 视口内选中零件 | 视口内点选 → 高亮 + 显示零件名/版本/颜色/BOM 行；与 manifest 的 `color` 共用同一身份 |

> **排期变更说明（2026-11-19）**：U01/U02 原定随 0.1.1（用户 2026-11-16 指定）；
> 本次修订后移到 0.1.2，让 0.1.1 保持“第二内核”单一主题。若用户要求保留在 0.1.1，
> 0.1.1 需加 3–4 周。

---

## 3. 引擎路线（0.2–1.0）

| 阶段 | 目标 | 触发/说明 |
|---|---|---|
| 0.1.1 | OpenSCAD + CadQuery 两个一等公民 | 当前 |
| 0.1.2 | **不新增引擎**；U01/U02/STEP/异步 job | 0.1.1 稳定 |
| 0.2 | **不新增引擎**；深度/质量（STEP 完整、BRep datum、示例重跑） | 0.1.2 稳定 |
| 0.3 | 第三个引擎**评估**（build123d/FreeCAD 二选一） | 真实需求 + 3-task benchmark；不承诺一定接 |
| 0.4 | 社区/用户自行接入（本地 manifest + conformance + unverified） | 0.3 稳定 + 用户请求；不做市场 |
| 1.0 | 第一梯队冻结 + 社区路径文档化 | 兼容矩阵/迁移 |

**第一梯队准入标准：**

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

## 4. 中远期（L2–L16）

> L1 已提升到 §1；L10/L15 已移到 §2。这里不再列“第二内核”。

| ID | P | 状态 | 事项 | 为什么/触发 | 出口 | 来源 |
|---|---|---|---|---|---|---|
| L2 | P1 | planned | 判据供给产品化 + 判据标定 | r104 0/25 vs r007 122/122：手写契约会漏判据；0.25/0.75 是声明值 | `assembly.json` 成为构建产物；coupon 实测回填 tolerance/壁厚/卡扣 | ASSESSMENT G1/G1.5 |
| L3 | P1 | planned | 装配清单 v2 + 装配级版本图 | 层级/端口/介入分级未做；拼接依赖版本图 | 跨层变换、端口解析、`review: auto\|human`、A@v3+B@v7→装配 v12 | DESIGN §12.2 |
| L4 | P1 | planned | 物理验证回路 | 试打/卡尺/拉脱未做；卡脚力是梁模型 | 实测回填 profile 与 tolerance；拉脱/试打步骤文档化 | ASSESSMENT G8；实验 20261108 |
| L5 | P1 | planned | 检查器标定 + bench 重跑 | 无变异测试；旧 bench 指纹失效；成本未测 | 50 个已知缺陷的检出率/误报率；新 SUT 指纹；token 成本 | ASSESSMENT G3/G4/G7 |
| L6 | P1 | planned | 权威编辑 + 审批/回滚 | `status` 恒 draft；回滚无一键；Customizer 只改顶层标量 | 版本标签/HEAD/回滚；约束保持的编辑通道 | DESIGN §12.3；limits |
| L7 | P2 | planned | 装配视觉表达 + 接口解释图 | 复杂装配判读退化；契约表只有数字 | 显隐/高亮/爆炸/datum 标记；E10 按需接口图 | DESIGN §12.2；UI E2/E10 |
| L8 | P1 | planned | UI 剩余批次 | 面板是只读证据浏览器；P0 的判得准/交付就绪未完成 | 按 UI-EXECUTION 推 M-UI1→M-UI6；先做 T2.2/T2.6/T5.2 收尾 | UI-PLAN / UI-EXECUTION |
| L9 | P2 | triggered | C/D：会话显式绑定 / 稳定 id + 注册表 | 当前 C-lite 够用；触发条件见 PROJECT-SCOPE §6.4 | 创建时选项目、恢复确认、移动/多人/跨机 | PROJECT-SCOPE §6 |
| L11 | P2 | triggered | 外观检查 L1/L2 | 外观只在成套时判；规则/阈值未定稿 | `check_appearance` 接口与规则分层落地 | APPEARANCE-PLAN |
| L12 | P3 | planned | 研究储备：弹性本构 / 特征识别 / pixel-unproject | 未到产品化；先做场地评估 | 每项先写实验报告，不直接进工具面 | DESIGN §12.4；实验 20261107 |
| L13 | P2 | planned | 平台与分发：Win/mac 全矩阵、插件市场 | npm 已发布；预览只承诺 Linux/macOS | 三平台 CI、安装/升级路径 | README；RELEASE |
| L14 | P3 | triggered | 多用户/云/移动 | 单用户本地够用 | 按 PROJECT-SCOPE 触发条件再评估 | DESIGN §2.2 |
| L16 | P1 | planned | 示例语料重跑（windup 等） | 用户 2026-11-17：示例重跑交给 0.2。当前 `windup-frog` verify=blocked（motion r028/r063 干涉、printability r042 最薄 0.028mm），README 仍写 difficult | 每个示例的 verify/README/截图一致；`accept-verify` 的期望随语料更新；重跑记录写进示例 README | 用户 2026-11-17 |

---

## 5. 条件触发 / 冻结（不要现在做）

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

---

## 6. 已收口（不要重复立项）

| 事项 | 证据/日期 |
|---|---|
| 0.1.0-preview.5 发布 | npm + tarball；N01–N19 完成/部分完成 |
| N01–N13 预览 P0 | 见 `RELEASE-0.1.0-PREVIEW.md` 与 release notes |
| N14/N16/N17/N18/N19 | 预览 P1 收口；N15 仅 OpenSCAD 编译 job |
| 9 个作业面 cutover | 39 工具 → 9 surface；`accept-surface-cutover` PASS |
| 标准件库 v0 | 99 个规范件；`accept-library-catalog` PASS |
| 整项目导出 ZIP + 合并 STL | 2026-11-11，`accept-project-export` 16/16 |
| 工艺目录 0 planned（sheet2d/turning/cnc/edm 落地） | 2026-11-12，`accept-sheet2d`/`accept-turning`/`accept-cnc-access`/`accept-edm-access` |
| 核心脊柱：派生义务不派生动作 | 2026-11-12，`experiments/20261112_core_spine_probe.md` |
| UI T0/T1/T2.1/T2.4/T2.5/T3/T4 | `docs/UI-EXECUTION.md` |
| 图片修剪 24 张窗口 | DESIGN §13.10 |
| 整项目导出的版本钉住规则 | DECISION-LOG 2026-11-11 |
| 硬阻断导出 | **已否决**，改为 C1 风险标注导出 |
| 单件外观判定 | **已否决**，外观只在成套时判 |

---

## 7. 来源索引（漏项时回这里找）

| 来源 | 里面有什么 | 本文件对应 |
|---|---|---|
| [RELEASE-0.1.1.md](RELEASE-0.1.1.md) | 0.1.1 目标、范围、验收、排期 | L1.0–L1.8、U03 |
| [RELEASE-0.1.0-PREVIEW.md](RELEASE-0.1.0-PREVIEW.md) | 预览版 DoD、P0/P1、C1/A3/A2 设计、排期（历史） | N01–N19 |
| [RELEASE-NOTES-0.1.0-preview.2.md](RELEASE-NOTES-0.1.0-preview.2.md) | preview.2 发布说明与已知问题（历史） | §6 |
| [ASSESSMENT-2026-10-28.md](ASSESSMENT-2026-10-28.md) | G1–G8 缺口、P0/P1/P2 路线 | L2–L5、L12 |
| [DESIGN.md §12](../../DESIGN.md) | 已完成/当前主线/待办/长期 | L3、L6、L7、L12 |
| [UI-PLAN.md](../UI-PLAN.md) / [UI-EXECUTION.md](../UI-EXECUTION.md) | 面板 P0/P1 与施工顺序 | U01、L8、L7 |
| [PROJECT-SCOPE.md](PROJECT-SCOPE.md) | B/C/D 路线与触发条件 | L9、L14 |
| [DECISION-LOG.md](../DECISION-LOG.md) 的“未决/非目标” | 单条决策留下的尾巴 | 全文，尤其 L11、X1–X12 |
| `experiments/` 最近报告 | 研究结论与下一步 | L4、L12、L1.0 |
| [HARNESS.md §10](../../HARNESS.md) | 开放化顺序 | L13、X12 |
| [README.md](../../README.md) | 分发方式、平台与已知边界 | L13、L1.7 |

---

## 8. 更新纪律

1. **本文件是唯一 TODO 索引。** 新计划先在“来源索引”里登记，再在表里加行；不再新建第二张总表。
2. **ID 稳定。** 完成后不删行，移到“已收口”并写 commit / accept 脚本 / 实验报告。
3. **状态只在这里改。** 来源文档只写设计细节，不写“已完成/待办”的第二份状态。
4. **每周一 review 一次；0.1.1 期间每天 review。** 每次只回答三个问题：本周做哪三件、哪件被卡、哪件该降级。
5. **顺序冲突时：** 本文件决定顺序/状态，来源文档决定设计细节；不要让两个表互相覆盖。
6. **新增“未决”时：** 要么进“待拍板”，要么进“条件触发”，不要留在正文里当注脚。
7. **引擎纪律（2026-11-19）：** 第三个引擎和社区适配不因讨论自动进表；必须由用户拍板，并满足 §3 的触发条件。

---

## 9. 当前建议（2026-11-19）

- **本周**：L1.0 CQ 探针 → L1.1 最小引擎 seam。
- **下周**：L1.2 CadQuery provider。
- **并行**：U03 已完成（`accept:assembly-contract` 30/30），不阻塞主线。
- **第 3–4 周**：L1.3 源码/版本 pin + L1.4 统一验证 → L1.5 作者层/示例 → L1.6 验收（已完成）→ L1.7 文档。
- **不要做**：U01/U02、第三个引擎、社区适配、公开 engine 协议、渲染器替换、STEP 完整审计路径。
- **判断泛化是否有效**：每加一个后端只允许改 1–2 个核心文件；超过就停下来修 seam，而不是继续加。
