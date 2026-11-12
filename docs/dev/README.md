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
| [TODO.md](TODO.md) | **项目 TODO 总表**：近期（0.1.0-preview）与中远期（第二内核等）的顺序、状态、出口 | 每次开工前/每周 review |
| [RELEASE-0.1.0-PREVIEW.md](RELEASE-0.1.0-PREVIEW.md) | 0.1.0 预览版发布计划：L2 外壳的 P0/P1 索引；C1 风险标注导出、A3 后端选择、A2 安装时预设 | 排发布/改导出/改后端前 |
| [SCHEMA.md](SCHEMA.md) | 项目 schemaVersion、迁移前备份与拒绝策略 | 改 schema/迁移项目前 |
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
