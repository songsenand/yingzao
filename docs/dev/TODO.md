# 项目 TODO 总表

> **状态**：单一索引（2026-11-12 创建）。
> **作用**：把散落在 `RELEASE-0.1.0-PREVIEW.md`、`ASSESSMENT-2026-10-28.md`、
> `DESIGN.md §12`、`UI-PLAN.md` / `UI-EXECUTION.md`、`PROJECT-SCOPE.md`、
> `DECISION-LOG.md` 的“未决/非目标/后续”收成一张有序的表。
> **规则**：本文件决定**顺序、状态、优先级**；设计细节留在来源文档。不要在两处同时维护状态。
> **状态词**：`next`（下一批）/ `doing` / `planned` / `blocked` / `triggered` / `done` / `dropped`。
> **时间口径**：近期 = 0.1.0-preview + 其后约 6 周；中远期 = 1–2 个季度。

---

## 0. 现在只做一件事

**0.1.0-preview：把外壳补到 L2。**
“装得上、查得出、拦得住（但允许带风险导出）、退得回。”

详细验收、设计、排期在 [RELEASE-0.1.0-PREVIEW.md](RELEASE-0.1.0-PREVIEW.md)。本文件只做索引和状态。

**2026-11-12 开工进展：**

- **已收口（13）**：N02（A2 预设路径）、N03（A3a 内核选择）、N04（A3b adapter 契约 + 编译经 registry 分发）、N06（A5 版本/兼容矩阵）、N07（B1 doctor）、N08（C1a 弹窗）、N09（C1b 文件名/清单/审计）、N10（C1c 自动化 override）、N11（C2 verify 随包）、N13（E2 预览文档）、N05（A4 失败分类 + state 落盘）、N12（E1 workflow + 本地 rehearsal）、N01（A1 tarball + `dsh plugin add` + 临时 profile 载入）。
- **P1 全部收口（6/6）**：N14 空状态、N15 作业/取消、N16 错误分类、N17 资源清理、N18 许可、N19 schema/迁移。

**验收证据（本机）：**

| 项 | 结果 |
|---|---|
| `npm run accept:setup` | 11/11 |
| `npm run accept:doctor` | 15/15（含 dsh 版本与 schemaVersion 注入） |
| `npm run accept:export-gate` | 26/26（含 microscope5 真实语料 blocked） |
| `npm run accept:export-http` | 24/24（单版本 + ZIP + 合并 STL：409 → 400 → 200 + `_UNVERIFIED` + 审计） |
| `npm run accept:export-dialog` | 9/9（fake DOM：弹窗 → 勾选 → confirm=1 → 下载文件名） |
| `npm run accept:bundle-load` | 4/4（临时 profile 载入 host/preset/skill provider） |
| `npm run accept:plugin-add -- --require` | 5/5（真实 `dsh plugin add` + `--dump-config`；`XDG_RUNTIME_DIR` 指向可写临时目录） |
| `npm run accept:backend` | 19/19（adapter registry + 版本 manifest backend pin） |
| `npm run accept:verify-cli` | 8/8 |
| `npm run accept:python-failure` | 27/27（分类 + state.json 落盘，不触发下载） |
| `npm run accept:license` | 15/15（LICENSE/NOTICE 已打包；无 AppImage/BOSL2/node_modules） |
| `npm run accept:clean` | 8/8（dry-run / apply / 非 harness 目录保留；doctor 报 stale） |
| `npm run accept:jobs` | 16/16（submit/done/cancel/timeout/重启/孤儿/10 连消/并发闸/HTTP） |
| `npm run accept:scope` | 10/10（runtime/backend 路由 + 5 种环境提示） |
| `npm run accept:i18n` | 17/17（zh/en key、英文无 CJK、通知/弹窗、locale 注册、英文 user+llm 文档齐全/链接可解析） |
| `npm run accept:run-facts` | 11/11（motion/fluid/assembly 的英文 headline/label/summary） |
| `npm run accept:ui-i18n` | 1/1（client 字符串字面量除术语外无中文，汉字只在 i18n.ts） |
| `npm run accept:error-envelope` | 35/35（8 类 code/stage/hint/cause；所有带输出契约的工具错误都挂上 envelope，消息不变） |
| `npm pack` | 113 files / 4.6 MB；含 LICENSE/NOTICE/README.en；tarball 内 preset 无 `/home/` |
| `npm run rehearse:preview` | PASS（build → accept:preview → pack → extract → setup → doctor → verify） |
| 解包 smoke | `setup` 写入后 `--check` 通过；`doctor` kind=degraded（仅 OpenSCAD 旧版）；`verify-cli` 可跑 |
| 未测 | GitHub Actions 实际运行；A4 真实断网/磁盘满注入（分类与 state 落盘已测） |

**待拍板（不阻塞开工，但阻塞收口）：**

| ID | 问题 | 推荐 | 影响 |
|---|---|---|---|
| Q1 | 第二个几何内核选谁 | **CadQuery**（比 FreeCAD 轻，Python 生态与现有 runtime 重合） | L1 的 2–3 周排期 |
| Q2 | 首发形态 | **GitHub Release tarball**，暂不上 npm | N01 的范围 |
| Q3 | OpenSCAD 最低版本 | **2025.06+（Manifold）**，旧版回落 CGAL 并警告 | N03/N07 |
| Q4 | L1 放在哪个预览 | **preview.2 或 preview.3**，不塞进 preview.1 | 中远期起始时间 |

---

## 1. 近期 TODO（0–6 周）

### 1.1 0.1.0-preview（P0 = 不发就别叫预览）

| ID | P | 状态 | 事项 | 出口（可证伪） | 详细 |
|---|---|---|---|---|---|
| N01 | P0 | done | 发布物与构建 | 干净机解压 tarball → `dsh plugin add -w` → 面板加载；不跑 build；包内 `lib/index.js` 比 `src` 新 | A1 |
| N02 | P0 | done | 预设 skill 路径 | 模板 + `dsh-cad-setup` 生成；换路径安装后 5 个 skill 全可见；包内无 `/home/` | A2 |
| N03 | P0 | done | 内核选择面 | `dsh-cad-setup` 只列真能工作的内核；现场获取并校验；`doctor` 打印 kernel/版本；切换写项目 pin | A3a |
| N04 | P0 | done | 适配器契约 | `CadBackend` 接口 + OpenSCAD adapter 抽出；现有 5 个工具路径行为不变；未知内核显式拒绝 | A3b |
| N05 | P0 | done | Python 首启 | 断网/超时/磁盘不足各返回 code+fix；有进度和重试；`DSH_CAD_PYTHON=system` 可用 | A4 |
| N06 | P0 | done | 版本/兼容矩阵 | `doctor` 打印 dsh/plugin/node；不兼容 fail 并给范围；CI 在声明支持的 dsh 上过 | A5 |
| N07 | P0 | done | `doctor` | 一条命令 `kind=ok`；8 种坏环境各唯一 kind+fix；`--json`；面板状态页 | B1 |
| N08 | P0 | done | 导出弹窗 | blocked 导出先 409 JSON；面板弹窗列 findings；必须勾选；`difficult` 不弹窗 | C1a |
| N09 | P0 | done | 文件名/清单/审计 | 三条导出路径都带 `_UNVERIFIED`；ZIP 含 `UNVERIFIED.md` + manifest；`exports/<id>/manifest.json` 可查 | C1b |
| N10 | P0 | done | 自动化 override | 无 `confirm=1` 返回 409；`confirm=1` 缺 reason 返回 400；有 reason 才 200 并留 override | C1c |
| N11 | P0 | done | `verify` 随包 | 干净安装后 `dsh-cad-verify` 可跑；不依赖 repo/tsx；Node 20/22 行为写清 | C2 |
| N12 | P0 | done | 最小 CI | tag 触发：typecheck + build + 核心 accept + 干净安装 + doctor + 立方体示例；失败不出包 | E1 |
| N13 | P0 | done | 发布文档 | 陌生人在干净 VM 15 分钟出 v001；known issues/预览语义/卸载/数据位置齐全 | E2 |

### 1.2 同一窗口内可带 known issue（P1）

| ID | P | 状态 | 事项 | 出口 | 详细 |
|---|---|---|---|---|---|
| N14 | P1 | done | 空状态/错误页 | 未选预设/运行时未就绪/缺包/面板空白各一条可操作文案 | B2 |
| N15 | P1 | done | 异步作业/取消 | submit 返回 id；cancel 后进程消失；重启 list 有记录；timeout 标 timeout | D1 |
| N16 | P1 | done | 错误分类 | 统一 `{code,stage,hint,cause}`；6 类故障注入各一码；日志带 runId | D2 |
| N17 | P1 | done | 资源清理 | 10 次取消无孤儿；临时目录有上限；并发有闸 | D3 |
| N18 | P1 | done | 许可/第三方 | 预览不含未合规 GPL 二进制；NOTICE/THIRD-PARTY 更新；BOSL2 缺失有明确降级 | E3 |
| N19 | P1 | done | 项目 schema/迁移 | 旧项目能开；未知新 schema 拒绝并说明；迁移前备份 | E4 |

> N15–N19 已完成；release notes 仍要显性列出边界（job 目前只覆盖 OpenSCAD 编译，不覆盖仿真/fluid）。

---

## 2. 中远期 TODO（1–2 个季度）

> **排序第一：L1 第二内核。** 用户 2026-11-12 明确：预览版只有一项菜单，后续逐步添加选项；
> 这件事优先级非常高，不能因为“当前 OpenSCAD 能用”就沉底。

### L1 第二内核（P0，中远期第一项）

**为什么第一：**

- 预览版“只有一项的菜单”是已知债；每多写一个 SCAD-only 的工具/prompt，未来适配成本就多一分。
- 用户已拍板“OpenSCAD 是默认后端，不是唯一后端”；现在不立适配器契约，后面会变成返工。
- 它同时解锁 STEP/BRep 精确 datum（L10）和非 OpenSCAD 用户。

**范围（首选 CadQuery，Q1 待拍板）：**

| 子项 | 内容 | 估时 | 状态 |
|---|---|---|---|
| L1.0 | 选型：CadQuery vs Build123d vs Replicad；定 source language、datum 方案、渲染路径 | 2d | planned |
| L1.1 | 适配器契约（复用 N04 的 `CadBackend`） | 含在 N04 | planned |
| L1.2 | CadQuery adapter：compile / datum / render / 错误语义 | 1w | planned |
| L1.3 | codegen：`create_part` 的 prompt、skill、示例、修复策略按内核分支 | 3–5d | planned |
| L1.4 | 安装：现场获取、版本 pin、代理/离线、`doctor` | 3d | planned |
| L1.5 | 验收：同一 bracket 示例在 OpenSCAD/CadQuery 都跑通；measure/assembly/export 不回归；内核切换写 pin | 5d | planned |

**出口：** 安装时菜单有两项且都能工作；同一零件语义在两个内核下生成、测量、装配、导出；
切换内核不重写旧版本；`doctor` 能说清每个内核的可用性；未知内核仍显式拒绝。

**非目标：** 不在 L1 做第三个内核；不追求两内核的几何逐字节一致（只要求语义/验收一致）。

### L2–L14 中远期

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
| L10 | P2 | planned | STEP 导出 / B-rep 精确 datum | 网格内核无法给 STEP；依赖 L1 | 导出 STEP；datum 从 B-rep 抽取 | DESIGN §12.4 |
| L11 | P2 | triggered | 外观检查 L1/L2 | 外观只在成套时判；规则/阈值未定稿 | `check_appearance` 接口与规则分层落地 | APPEARANCE-PLAN |
| L12 | P3 | planned | 研究储备：弹性本构 / 特征识别 / pixel-unproject | 未到产品化；先做场地评估 | 每项先写实验报告，不直接进工具面 | DESIGN §12.4；实验 20261107 |
| L13 | P2 | planned | 平台与分发：npm、Win/mac 全矩阵、插件市场 | 预览只承诺 tarball + Linux/macOS | npm 包、三平台 CI、安装/升级路径 | README；RELEASE |
| L14 | P3 | triggered | 多用户/云/移动 | 单用户本地够用 | 按 PROJECT-SCOPE 触发条件再评估 | DESIGN §2.2 |

---

## 3. 条件触发 / 冻结（不要现在做）

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
| X10 | npm / 插件市场 | 预览后再评估 | preview.1 稳定、有外部用户 |

---

## 4. 已收口（不要重复立项）

| 事项 | 证据/日期 |
|---|---|
| 整项目导出 ZIP + 合并 STL | 2026-11-11，`accept-project-export` 16/16 |
| 工艺目录 0 planned（sheet2d/turning/cnc/edm 落地） | 2026-11-12，`accept-sheet2d`/`accept-turning`/`accept-cnc-access`/`accept-edm-access` |
| 核心脊柱：派生义务不派生动作 | 2026-11-12，`experiments/20261112_core_spine_probe.md` |
| UI T0/T1/T2.1/T2.4/T2.5/T3/T4 | `docs/UI-EXECUTION.md` |
| 图片修剪 24 张窗口 | DESIGN §13.10 |
| 整项目导出的版本钉住规则 | DECISION-LOG 2026-11-11 |
| 硬阻断导出 | **已否决**，改为 C1 风险标注导出 |
| 单件外观判定 | **已否决**，外观只在成套时判 |

---

## 5. 来源索引（漏项时回这里找）

| 来源 | 里面有什么 | 本文件对应 |
|---|---|---|
| [RELEASE-0.1.0-PREVIEW.md](RELEASE-0.1.0-PREVIEW.md) | 预览版 DoD、P0/P1、C1/A3/A2 设计、排期 | N01–N19 |
| [ASSESSMENT-2026-10-28.md](ASSESSMENT-2026-10-28.md) | G1–G8 缺口、P0/P1/P2 路线 | L2–L5、L12 |
| [DESIGN.md §12](../../DESIGN.md) | 已完成/当前主线/待办/长期 | L3、L6、L7、L10、L12 |
| [UI-PLAN.md](../UI-PLAN.md) / [UI-EXECUTION.md](../UI-EXECUTION.md) | 面板 P0/P1 与施工顺序 | L8、L7 |
| [PROJECT-SCOPE.md](PROJECT-SCOPE.md) | B/C/D 路线与触发条件 | L9、L14 |
| [DECISION-LOG.md](../DECISION-LOG.md) 的“未决/非目标” | 单条决策留下的尾巴 | 全文，尤其 L1/L11/X1–X10 |
| `experiments/` 最近报告 | 研究结论与下一步 | L4、L12 |
| [HARNESS.md §10](../../HARNESS.md) | 开放化顺序 | L13 |
| [README.md](../../README.md) | “分发方式待定” | L13、Q2 |

---

## 6. 更新纪律

1. **本文件是唯一 TODO 索引。** 新计划先在“来源索引”里登记，再在表里加行；不再新建第二张总表。
2. **ID 稳定。** 完成后不删行，移到“已收口”并写 commit / accept 脚本 / 实验报告。
3. **状态只在这里改。** 来源文档只写设计细节，不写“已完成/待办”的第二份状态。
4. **每周一 review 一次；preview 期间每天 review。** 每次只回答三个问题：本周做哪三件、哪件被卡、哪件该降级。
5. **顺序冲突时：** 本文件决定顺序/状态，来源文档决定设计细节；不要让两个表互相覆盖。
6. **新增“未决”时：** 要么进“待拍板”，要么进“条件触发”，不要留在正文里当注脚。

---

## 7. 当前建议（2026-11-12）

- **本周**：N02（A2）→ N07（doctor 骨架）→ N08（C1 弹窗/409）。
- **下周**：N09/N10（文件名/manifest/CLI）→ N01（打包）→ N12（CI）。
- **并行**：L1.0 选型（只做决策，不写代码），避免 A3b 的接口在预览后被推翻。
- **不要做**：新几何能力、第二个内核实现、UI 大改、bench 重跑；这些都排在 N 系列之后。
