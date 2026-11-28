[English](../en/llm/README.md) | 中文

# LLM 文档

这是给 **Agent** 看的参考层。用户文档在 `docs/user/`，不要混。

## 调用面（2026-11-16 起）

生产会话只暴露 **9 个 surface / 45 个 op**。调用格式是 `cad_<surface>({ action: "<op>", args: { … } })`；本文档统一用这个写法。旧工具名（如 `generate_part`、`check_assembly`）只是内部 op 名，直接调用会报 `unknown tool`。

| surface | actions |
|---|---|
| `cad_session` | `info` · `init` · `bind` · `review` · `kernel` |
| `cad_part` | `create` · `generate` · `import` · `merge` · `role` · `appearance` |
| `cad_assembly` | `write` · `validate` · `check` · `datums` · `suggest` |
| `cad_check` | `printability` · `sheet2d` · `turning` · `cnc` · `edm` · `parts` · `appearance` · `sweep` |
| `cad_simulate` | `physics` · `motion` · `fluid` · `lbm` · `stress` · `hotspots` |
| `cad_inspect` | `measure` · `features` · `attention` · `analyze` |
| `cad_see` | `render` · `review` · `reference` |
| `cad_python` | `run` · `runtime` |
| `cad_deliver` | `plan` · `preflight` · `audit` · `pearl`（已弃用） · `affected` · `retire` |

`catalog` / `help` 是每个 surface 自带的两个只读 action：`catalog` 列 op，`help` 给旧参数。

2026-11-25 新增的 6 个 action：`cad_session kernel`（切换项目作者内核）、`cad_assembly suggest`（接口建议）、`cad_check sweep`（运动前扫掠筛查）、`cad_simulate hotspots`（重力方向热点）、`cad_deliver affected`（改版后该重跑哪些检查）/ `retire`（退役 run）。参数与返回形状见 `TOOL-CONTRACTS.md`；长解释：`kernel` 见 `cadquery.md`，`suggest` / `sweep` 见 `assembly.md`，`hotspots` 见 `engines.md`，`affected` / `retire` 见 `delivery.md`。

## 阅读顺序

1. **`skills/cad-toolbox`** —— 先读路由：哪个问题找哪个工具、三组输出各允许说什么。
2. **`docs/llm/`（本目录）** —— 需要深度时读：引擎边界、陷阱、交付纪律、坐标/清单约定。
3. **`dsh-cad-harness/docs/TOOL-CONTRACTS.md`** —— 每个内部 op 的参数与字段权威（生成物，不手改；调用名以上表为准）。
4. **`HARNESS.md` / `DESIGN.md`** —— 只在问“为什么这样设计”时读。

## 本目录

| 文件 | 内容 | 状态 |
|---|---|---|
| `engines.md` | 运动/物理/流体/LBM/应力的模型边界，以及它们不能回答什么 | 已有 |
| `assembly.md` | 装配清单形状、七个 operator、pose、阈值、导入件/stock | 已有 |
| `manufacturing.md` | 可打印性清单、工艺档案、信任阶梯、校准、封闭腔/刀具可达 | 已有 |
| `processes.md` | 工艺目录：`allowed` 决策空间 vs `support` 评估器；planned/partial 的分级与 handoff | 已有 |
| `modeling.md` | 导入格式/单位、merge/genus、OpenSCAD 度数/radian、twist、参考图 | 已有 |
| `library.md` | 99 个标准件目录、fit/visual、BOSL2/弹簧 seed 的区分、当前未接入工具的事实 | 已有 |
| `delivery.md` | 交付纪律全文：claim、证据、覆盖、代表件 | 已有 |
| `conventions.md` | mm/z-up、datum、manifest、judge/scan/both、run | 已有 |
| `traps.md` | 长解释型陷阱（rack pitch、pivot、lattice units…） | 已有 |
| `verify.md` | V1 证据验证：六行、状态、claims/新鲜度、policy、退出码 | 已有 |
| `pearls.md` | 历史：六珍珠 gate/execute（已被 `verify` 取代，不再作为路径） | 历史 |

## 写作规则

- **祈使句**：写“做什么 / 不做什么 / 检查什么”，不写“这个工具的历史”。
- **每一行改变一个决策**。只解释“为什么”的，放 `DESIGN.md` / `DECISION-LOG.md`。
- **不写安装、营销、教程**；那是 `docs/user/` 和根 `README.md`。
- **不复制字段表**；字段在 `TOOL-CONTRACTS.md`，这里只写“字段意味着什么、什么时候不能信”。
- **长解释放这里，短规则留 skill**。skill 的每条规则应能指到本目录的一节。

## 权威顺序

| 事实 | 权威 |
|---|---|
| 调用名 / action | 本文档上表 + `skills/cad-toolbox` |
| 参数、字段、返回形状 | `dsh-cad-harness/docs/TOOL-CONTRACTS.md`（生成物，按内部 op 名索引） |
| 哪个工具、什么时候用 | `skills/cad-toolbox` |
| 字段的语义与陷阱 | 本目录 + 工具描述 |
| 当前设计/架构 | `DESIGN.md` |
| 历史取舍 | `docs/DECISION-LOG.md`（append-only） |

一个事实只在一个地方定义；其他位置给链接，不复制。
