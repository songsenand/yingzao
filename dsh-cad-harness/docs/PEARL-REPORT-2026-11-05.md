# 珍珠串阶段报告（2026-11-05）

> **历史文档（2026-11-06 起）**：珍珠执行层已降级，V1 证据验证取代其模型可见面。
> 决策见 `docs/PEARL-TO-VERIFY-DECISION-2026-11-06.md`；本文只作为实现记录保留。

> 状态：阶段性总结，不是发布说明。  
> 当前代码仍是**六颗珍珠**；本报告中的 `function` 是**拟议的第七颗**，尚未实现。  
> 本报告合并了：`brief`/`model` 的定位、仿真的两类划分、`function` 珍珠设计、当前进展与原计划偏差。

---

## 1. 摘要

当前珍珠串已经具备：

- 六颗固定珍珠与 11 个模板；
- 装配契约 + 项链契约；
- 六列 evidence ledger；
- `pearl_run` 的 gate 与 `execute:true` 真实工具 dispatch；
- 语义失败识别（`judgement=excluded` / `overallStatus=fail`）；
- `difficult` 的解释要求；
- 局部失败定位与 witness；
- probe 模板（`fit-clearance`）；
- delivery artifact；
- repair loop / no-progress / 历史。

但仍有明确边界：

- **不是几何修复引擎**；几何由 LLM/agent 决定；
- **不是完整自动执行器**；`execute:true` 只执行当前模板；
- **不是完整 probe 库**；只有一个 probe 模板；
- **功能仿真还不是独立珍珠**；当前只有 `fit/mechanism` 的运动一致性检查。

---

## 2. 七颗珍珠（拟议）

| 珍珠 | 回答的问题 | 主要工作 | 当前状态 |
|---|---|---|---|
| `brief` | 需求是否变成可检查的约束？ | 材料/工艺/包络/禁项/验收/场景 | 薄：只登记项目 + 查 `PROMPT.md` |
| `model` | 几何是否可编译、可版本化？ | 版本、BOM、datum、装配契约 | 有模板/observer，结构检查为主 |
| `fit` | 装得进去吗？ | 干涉、接口、运动可行性 | 有 static/mechanism；motion 已实测 |
| `make` | 做不做得出来？ | 毛料、printability、壁厚、外观 | wood/fdm 基础版 |
| **`function`（拟）** | **在声明场景下，是否达到功能目标？** | 功能仿真、metric vs target、claim witness | **未实现** |
| `review` | 关键视图是否真的看过？ | 渲染 + 视觉 review | 只查 top+iso+note |
| `deliver` | 能不能交？证据是否新鲜？ | preflight、claims、delivery_audit | artifact 已有，claims 未全接 |

### 依赖顺序（拟）

```text
brief
  → model
      → fit
          → function
      → make / review（可并行）
          → deliver
```

- `function` 依赖 `model` + `fit`；
- `make` / `review` 可与 `function` 并行；
- `deliver` 依赖所有珍珠的证据。

> 这是对“固定六颗”的明确修改。若确认，需要同步 `PEARL_IDS`、ledger、contract sections、`CONTRACT_STAGES`、schemas、acceptance 和文档。

---

## 3. `brief` 与 `model`

### 3.1 `brief`：需求契约

`brief` 不建模，负责把自然语言任务收敛成可证伪的约束：

```text
材料/工艺
包络/尺寸
禁项
验收判据
场景/目标
must / nice-to-have
```

例子：

```text
任务：做一个能称 5g 的天平

brief 应产出：
- 工艺：FDM
- 包络：≤ 200×150×120 mm
- 验收：5g 在 100mm 处，倾斜 ≥ 2°
- 禁项：未声明接触
- 非目标：外观
```

当前 `brief`：

- 模板只有 `project_info` + `init_project`；
- observer 只看 `PROMPT.md` 是否存在；
- 不解析验收项、不解析场景。

结论：现在是“项目登记”，还不是“需求契约”。

### 3.2 `model`：产物契约

`model` 不替代 agent 建模，负责检查建模产物是否可被后续珍珠引用：

```text
version 是否存在
BOM 引用的 version 是否存在
assembly.json 是否合法
datum/接口端点是否存在
契约是否引用当前版本
```

它不判断：

- 装不装得进去（`fit`）；
- 做不做得出来（`make`）；
- 功能是否达到（`function`）；
- 好不好看（`review`）；
- 能不能交（`deliver`）。

一句话：

> **agent 负责“做出来”；`brief` 定义“什么叫对”；`model` 保证“产物能被引用”。**

当前 `model` 的缺口：

- `write_assembly` 三示例只跑 replace；
- merge/create/嵌套未真实覆盖；
- 不判断几何质量（这是有意的）。

---

## 4. 仿真一分为二

| 类别 | 问题 | 例子 | 归属 |
|---|---|---|---|
| **一致性/可行性** | 基本物理/装配是否自洽？ | 空载天平是否站得稳；装配/运动是否干涉；机构是否装得进去 | `fit` / `make` |
| **功能目标** | 在声明场景下是否达到目标？ | 5g 砝码是否让天平倾斜 ≥2°；发条青蛙是否跳起 ≥X mm；流道是否无死区 | **`function` 珍珠** |

### 4.1 一致性检查

特点：

- 不需要用户给“功能目标”；
- 默认应跑；
- 可以作为 `fit` / `make` 的 gate 或 warn；
- 失败是“设计不一致”，不是“没达到产品指标”。

当前接入：

```text
fit/static      validate_assembly + check_assembly
fit/mechanism   + simulate_motion
make/fdm        check_printability
```

### 4.2 功能目标

特点：

- 必须有 **scenario + target + acceptance**；
- 没有场景/目标 → `unobserved` / `not-applicable`，不是 pass；
- 输出是 **claim 的 witness**，不是默认 gate；
- 由 `brief` 声明，由 `function` 执行，由 `deliver` 消费。

---

## 5. `function` 珍珠设计（未实现）

### 5.1 问题

> 在声明场景下，是否达到功能目标？

### 5.2 输入

```json
{
  "scenario": {
    "kind": "balance-load",
    "massG": 5,
    "positionMm": [100, 0, 0]
  },
  "target": {
    "metric": "tiltDeg",
    "op": ">=",
    "value": 2,
    "unit": "deg"
  }
}
```

### 5.3 模板（拟）

| 模板 | 工具 | 用途 |
|---|---|---|
| `mechanism` | `simulate_motion` | 行程、周期、跳起、卡滞 |
| `static` | `simulate_physics` | 载荷、倾斜、稳定性 |
| `flow` | `simulate_fluid` / `simulate_lbm` | 流量、死区 |
| `strength` | `simulate_stress` | 强度目标 |

### 5.4 状态

| 状态 | 条件 |
|---|---|
| `pass` | 场景/目标已声明；run 新鲜；metric 达标 |
| `warn` | 达标但证据弱/覆盖不全 |
| `fail` | metric 未达标，或仿真硬失败 |
| `blocked` | 缺场景/目标、版本过期、run 缺失 |
| `not-applicable` | 项目没有功能目标 |
| `unobserved` | 有目标但没跑 |

### 5.5 失败归属

`function` 不能变成第二个 `fit`：

| 失败原因 | 回退 |
|---|---|
| 干涉/装不进去 | `fit` |
| 目标未达到 | `function` / `model` |
| 几何/版本过期 | `model` |
| 场景/目标没写 | `brief` |

---

## 6. 当前进展

### 已完成的主线

| 层 | 结果 |
|---|---|
| 六珍珠/模板 | 6 个固定 pearl、11 个模板；step 有 `args/bind/when/parallel` |
| 双契约 | `assembly.json` + `necklace-contract.json`；read/validate/stale/history/expectedHash |
| 证据账本 | 六列 status/evidence/failures；`difficult` 要求解释 |
| 执行 | `pearl_run({execute:true})` 真实 dispatch；serial/parallel、transient、on_fail route |
| 预算 | 一个模板 deadline + 每工具 timeout；慢但未超时只记日志 |
| repair | no-progress + 全局 4 轮 + history；不自动改几何 |
| 发现能力 | fit 干涉/接口/未声明解释、motion 负 fixture、probe 模板、deliver artifact、witness |

### P0 状态

| 项 | 状态 |
|---|---|
| `fit.mechanism` motion fixture + 实测 | ✅ r073：49 checks / 46 events，首个 `cam↔slider 0.145mm³ @0.042s` |
| probe 模板 | ✅ `fit-clearance` + negative sample + profile 选择 |
| deliver artifact | ✅ 三示例写 `assembly/delivery-audit.json` |
| fit witness | ✅ `semanticDetail` 提取 pair/体积/时间 |
| 跨域样本 | ❌ 延后 |

### P1 状态

| 项 | 状态 |
|---|---|
| explained undeclared | ✅ rulepack `undeclaredExplanations` + info witness |
| contract history | ✅ `necklace-contract-history.json` |
| required groups | ❌ rulepack 有字段，observer 未映射 |
| fit motion-clearance | ❌ motion run 未并入 fit 状态 |
| brief acceptance | ❌ 未解析 |
| make 深度 | ❌ wood 只查毛料；printability 深度不足 |
| review 深度 | ❌ 只查 top+iso+note；roberval unobserved |
| write_assembly merge/create/嵌套 | ❌ 未真实覆盖 |

---

## 7. 当前三示例

| 示例 | brief | model | fit | make | review | deliver | overall |
|---|---|---|---|---|---|---|---|
| windup | pass | pass | pass | warn | warn | warn | warn |
| roberval | pass | pass | pass | warn | unobserved | fail | fail |
| table | pass | pass | blocked | pass | pass | fail | blocked |

解释：

- **windup**：可判，但有未声明接触、printability difficult、review 缺记录、delivery warnings；
- **roberval**：fit 通过，但 deliver 被 9 个打印件缺 visual review 阻断；
- **table**：fit 被空契约阻断（0 interfaces），deliver 还有未登记 STL。

---

## 8. 与原计划的偏差

### 用户驱动的修正（不是缺口）

| 原计划 | 实际 | 原因 |
|---|---|---|
| 单一“契约作为线” | 双契约：装配契约 + 项链契约 | 避免 make/review/deliver 污染几何契约 |
| soft/hard 两层预算 | 一个 deadline + 工具 timeout | 用户要求拆除 soft 脚手架 |
| 每失败单元 `retry:2` | no-progress + 全局 4 轮 + transient 2 | 固定次数没有依据 |
| 自动修几何 / 自动 repair | 只做 route + repair loop；几何由 LLM/agent 决定 | 目标对齐后移除 |
| 空 probe 槽 | `fit-clearance` 模板 + profile 显式选择；不默认挂载 | 用户提出的 probe 模板思路 |

### 真正的计划偏差

| 项 | 现状 | 偏差程度 |
|---|---|---|
| 完整执行器 | 能 dispatch 单个模板；不能自动跑完整条项链并自动回退 | P0 执行层未满 |
| `fit.mechanism` | 有负 fixture，能发现 cam↔slider 干涉；不是通过的运动机构 | 只完成“能发现” |
| probe | 只有 1 个 `fit-clearance` 模板 | 样板完成，库未完成 |
| deliver | artifact 已写，三示例 deliver 可判 | 完成 |
| 跨域 | 仍只有 mechanism/wood | 按用户要求延后 |
| P1 | explained undeclared + contract history 完成；其余未完成 | 部分完成 |

---

## 9. 需要确认的设计决策

在实现 `function` 珍珠前，需要先确认：

1. **命名**：`function` 还是 `behavior`？
2. **是否固定七颗**：这会修改 `PEARL_IDS`、ledger、contract sections、`CONTRACT_STAGES`。
3. **scenario/target schema**：最小字段、单位、容差。
4. **metric 比较器**：`>=` / `<=` / 区间 / 百分比；是否允许 `warn` 带。
5. **失败归属**：干涉回 `fit`，目标未达回 `function`/`model`，场景缺失回 `brief`。
6. **无功能目标的项目**：`function` 是 `not-applicable` 还是直接不进入链条？

---

## 10. 验收

当前：

```text
npm run accept:m16 -> OK
npm run typecheck   -> 0
npm run build       -> 0
```

覆盖：

- contract / inputs / dispatch / output style；
- repair loop / no-progress / history；
- probe mount / negative sample / profile selection；
- explained undeclared；
- delivery artifact。

---

## 11. 一句话

> **当前项链能读、能写、能 dispatch、能发现并定位问题；但还不是自动跑完整链、自动修几何的系统。**  
> `brief` 是需求契约，`model` 是产物契约；仿真应分一致性检查（fit/make）和功能目标（拟议 `function` 珍珠）。
