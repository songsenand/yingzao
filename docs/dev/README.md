# 维护者文档

这是给**改这个项目的人**看的。Agent 默认不加载这里的文件；如果一条事实是 Agent 做决定需要的，它应该出现在 `skills/` 或 `docs/llm/`，而不是只在这里。

## 入口

| 文档 | 讲什么 | 什么时候读 |
|---|---|---|
| [HARNESS.md](../../HARNESS.md) | 它是什么、不是什么、边界、取舍原则 | 第一次接触项目 |
| [DESIGN.md](../../DESIGN.md) | 当前设计：架构、模块、接口、环境变量与诊断开关全集 | 改架构/接口前 |
| [PROJECT-SCOPE.md](PROJECT-SCOPE.md) | 项目身份与隔离：cwd 选择器 + `cad-data/project.json` 标记；B 设计与 C/D 路线 | 改项目解析/子智能体 cwd 前 |
| [DECISION-LOG.md](../DECISION-LOG.md) | 历史取舍（append-only，不回改） | 想知道“当初为什么这么选” |
| [UI-PLAN.md](../UI-PLAN.md) | 面板/交互的计划与已完成项 | 改 UI 前 |
| [UI-EXECUTION.md](../UI-EXECUTION.md) | UI 的执行记录 | 查 UI 改动历史 |
| [AUDIT-2026-10-23.md](../AUDIT-2026-10-23.md) | 一次全量审计的发现与修复 | 查已知缺陷/修复依据 |
| [ASSESSMENT-2026-10-28.md](ASSESSMENT-2026-10-28.md) | 能力评估：玩具→准生产的证据、缺口与路线图 | 排优先级/看现状 |
| [TEST-COVERAGE-2026-11-16.md](TEST-COVERAGE-2026-11-16.md) | 工具单元测试覆盖率实测：9 surface/39 op（当时口径；当前 45 op）、172 个 accept 脚本、src 行 89.0% / 函数 83.0% | 补测试/判断工具面质量 |
| [DSH-MATRIX.md](DSH-MATRIX.md) | 本地 DSH 版本矩阵：13 个 in-range 0.2.x 的 rc/alpha 实测表、T0–T2 断言与复现 | 判断支持范围/加版本前 |
| [PLAN-2026-11-26.md](../PLAN-2026-11-26.md) | 2026-11-26 新提三项（流体管外/视口/大项目规划）的证据、已修项与出口 | 做 F1/F2/U10/U11/G1/G2 前 |
| [PLUGIN-GAP-2026-11-26.md](../PLUGIN-GAP-2026-11-26.md) | 插件能力快照：51 条（16 有/7 部分/28 无）、最该补的 10 条 | 排 UI/装配/人的动作优先级前 |
| [TODO.md](TODO.md) | **项目 TODO（只列未完成）**：最近的顺序、P0/P1/P2 排队、长期/不排期；已完成看归档 | 每次开工前/发布前每天 review |
| [RELEASE-0.2.0.md](RELEASE-0.2.0.md) | **0.2.0 准生产基线**：五条完成定义、17 项门禁、争取项/不做项、里程碑与证据 | 排 0.2.0、判断“能不能发”时 |
| [RELEASE-0.1.1.md](RELEASE-0.1.1.md) | 0.1.1 版本目标：CadQuery 成为一等公民；范围、验收、排期；L1.8 预设与 dsh 版本对齐（已发布，历史） | 查 0.1.1 设计与发布记录时 |
| [RELEASE-NOTES-0.1.2.md](RELEASE-NOTES-0.1.2.md) | **0.1.2-preview.1 发布说明**：C1–C12 用户可见变化、升级须知、已知问题、证据表与发布步骤 | 发布/查本版变化时 |
| [RELEASE-NOTES-0.1.1.md](RELEASE-NOTES-0.1.1.md) | 0.1.1-preview.1 发布说明与已知问题（历史） | 查 0.1.1 发布记录时 |
| [RELEASE-0.1.0-PREVIEW.md](RELEASE-0.1.0-PREVIEW.md) | 0.1.0 预览版发布计划：L2 外壳的 P0/P1 索引；C1 风险标注导出、A3 后端选择、A2 安装时预设（历史） | 查预览版设计/历史时 |
| [RELEASE-NOTES-0.1.0-preview.2.md](RELEASE-NOTES-0.1.0-preview.2.md) | preview.2 发布说明：9 surface、标准件库 v0、球阀示例、证据修复、已知问题与门禁证据 | 打 tag/写 release body 前 |
| [SCHEMA.md](SCHEMA.md) | 项目 schemaVersion、迁移前备份与拒绝策略 | 改 schema/迁移项目前 |
| [NAME.md](NAME.md) | 品牌名、包名、插件 id、preset id、CLI/数据目录的改名边界 | 改名前/对外命名前 |
| [THIRD-PARTY-AUDIT.md](../THIRD-PARTY-AUDIT.md) | 第三方依赖与素材的许可审计 | 引入依赖/素材前 |
| [INTERFACE-FIGURE-PLAN.md](../INTERFACE-FIGURE-PLAN.md) | 接口示意图的延期方案 | 做接口图前 |
| [AGENTS.md](../../AGENTS.md) | 编码纪律：提交信息 Why / Verified / Risk、决策记录、文档同步 | 每次提交前 |
| [CONTRIBUTING.md](../../CONTRIBUTING.md) | DCO、贡献流程 | 第一次提交前 |

## 三条规矩

1. **DECISION-LOG 只追加**，不改历史条目。
2. **DESIGN 记“当前有效”**，不记历史；历史在 DECISION-LOG。
3. **文档同步**：用户看得见的变化 → `README.md` / `docs/user/`；架构变化 → `DESIGN.md`；Agent 决策需要的事实 → `skills/` / `docs/llm/`。

## 新维护者的阅读顺序

1. `HARNESS.md`（边界与原则）
2. `DESIGN.md` 的目录 + 架构图（不必一次读完 3700 行）
3. `docs/DECISION-LOG.md` 最近 10 条
4. `AGENTS.md`（提交与文档纪律）
5. 跑一次 `npm run accept`（在 `dsh-cad-harness/` 下）
