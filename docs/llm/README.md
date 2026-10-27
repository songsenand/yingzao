# LLM 文档

这是给 **Agent** 看的参考层。用户文档在 `docs/user/`，不要混。

## 阅读顺序

1. **`skills/cad-toolbox`** —— 先读路由：哪个问题找哪个工具、三组输出各允许说什么。
2. **`docs/llm/`（本目录）** —— 需要深度时读：引擎边界、陷阱、交付纪律、坐标/清单约定。
3. **`docs/TOOL-CONTRACTS.md`** —— 参数与字段的**唯一权威**（生成物，不手改）。
4. **`HARNESS.md` / `DESIGN.md`** —— 只在问“为什么这样设计”时读。

## 本目录

| 文件 | 内容 | 状态 |
|---|---|---|
| `engines.md` | 运动/物理/流体/LBM/应力的模型边界，以及它们不能回答什么 | 已有 |
| `delivery.md` | 交付纪律全文：claim、证据、覆盖、代表件 | 待迁入 |
| `conventions.md` | mm/z-up、rotate、datum、manifest、run/证据 | 待迁入 |
| `traps.md` | 长解释型陷阱（rack pitch、pivot、lattice units…） | 待迁入 |

## 写作规则

- **祈使句**：写“做什么 / 不做什么 / 检查什么”，不写“这个工具的历史”。
- **每一行改变一个决策**。只解释“为什么”的，放 `DESIGN.md` / `DECISION-LOG.md`。
- **不写安装、营销、教程**；那是 `docs/user/` 和根 `README.md`。
- **不复制字段表**；字段在 `TOOL-CONTRACTS.md`，这里只写“字段意味着什么、什么时候不能信”。
- **长解释放这里，短规则留 skill**。skill 的每条规则应能指到本目录的一节。

## 权威顺序

| 事实 | 权威 |
|---|---|
| 参数、字段、返回形状 | `docs/TOOL-CONTRACTS.md`（生成物） |
| 哪个工具、什么时候用 | `skills/cad-toolbox` |
| 字段的语义与陷阱 | 本目录 + 工具描述 |
| 当前设计/架构 | `DESIGN.md` |
| 历史取舍 | `docs/DECISION-LOG.md`（append-only） |

一个事实只在一个地方定义；其他位置给链接，不复制。
