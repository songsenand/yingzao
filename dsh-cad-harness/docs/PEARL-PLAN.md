# 珍珠项链（M1–M14 执行记录）

> **历史文档（2026-11-06 起）**：珍珠执行层已降级，V1 证据验证取代其模型可见面。
> 决策见 `docs/PEARL-TO-VERIFY-DECISION-2026-11-06.md`；本文只作为实现记录保留，不再更新。

> 阶段报告：[PEARL-REPORT-2026-11-05](PEARL-REPORT-2026-11-05.md)

> 状态：M1–M8 已落地（checker/planner/fit observe/rulepack/profile/model contract/write_assembly）；M6 加入 model observer；M7 加入六颗珍珠只读账本、失败定位与 wood/deliver observer；M8 加入 `pearl_run` gate、一个 deadline 预算、`on_fail.kind`、probe 空槽合法化；M9 加入项链契约（两契约、阶段、失败 owner、原子写入）；M10 固定 no-progress + 全局 4 轮 repair 策略；M11 加入 contract-round executor、preflight 集成和 round deadline；M12 加入 step bind/input 契约、quiet/loud 输出；M13 接入真正的 CAD tool dispatch；M14 补 difficult 解释语义、repair loop/history、delivery artifact；几何自动修复仍不存在（repair loop 只负责编排）。
> 注意：M1 尚未接入 host 运行时；验收脚本直接 import TS 模块，现有工具/preset 行为不变。
> 目标：不推翻现有工具/四组/preset；先证明“固定珍珠 + 模板 + probe 槽”可读、可校验、可预算。

## 1. 范围

M1 包含：

- 6 颗固定珍珠：`brief → model → fit → make → review → deliver`
- 每颗 1–3 个模板（JSON，可读、可 diff）
- 每颗一个 `probe` 槽：LLM 可写检测脚本，统一 `checker/v1` 协议
- 只读 planner：算出步骤、预算、coverage；不真正调用工具
- 验收脚本：checker 协议、manifest、planner

M1 不包含：

- host 内强制执行模板（Phase 3b）
- UI 面板、跨平台沙箱、checker 市场
- 现有工具改名/合并

## 2. 预算基线

来自 2026-11-03 A1–A3（插件）/ B1–B3（裸 SCAD）六次八仙桌 run：

| 指标 | A 均值 | B 均值 |
|---|---:|---:|
| 步数 | 119.7 | 131.7 |
| prompt tokens | 21.5M | 21.1M |
| 输出 tokens | 187k | 190k |
| 读图 | 20.3 | 43.3 |
| 耗时 | 32.4 min | 35.4 min |

初始预算取“参考 run 的 p50 + 1 个 probe 槽”，硬上限取 p95；季度校准。
预算字段：`maxDistinctTools / maxCalls / maxCost / maxProbe=1`。

## 3. 珍珠边界

| 珍珠 | 只回答 | 不回答 |
|---|---|---|
| brief | 需求是否已变成可检查约束 | 不建模 |
| model | 几何是否可编译、可版本化 | 不判断装配 |
| fit | 装不装得进去 | 不修几何、不判强度 |
| make | 做不做得出来 | 不判美观 |
| review | 关键视图是否看过 | 不替代 audit |
| deliver | 能不能交、证据是否新鲜 | 不重新设计 |

## 4. 失败边

每颗珍珠的模板声明 `on_fail`：

- `fit.fail` → `model`（带 witness/attention）
- `make.fail` → `model`
- `review.fail` → `model`
- `deliver.fail` → 对应证据珍珠（`fit/make/review`）

规则：只允许声明边；同一 failure signature 再次出现即 stop；全局最多 4 个 repair round，超过 `blocked`。

## 5. 验收

```bash
node scripts/accept-checker-protocol.mjs
node scripts/accept-pearl-manifests.mjs
node scripts/accept-pearl-plan.mjs
```

每条验收都必须能指名一个观察；失败即 M1 未完成。

## 6. M1 验收结果（2026-11-03）

```text
npm run typecheck   -> 0
npm run build       -> built lib/index.js + lib/client.js
npm run accept:m1   -> OK
```

- 样例 `leg-fit`：0.5 mm 过盈 → `fail`（2000 mm³ AABB），clear → `pass`。
- 负样本 `fixtures/overlap.json` 被拒绝；probe 仅在自检通过后挂载。
- 非 JSON/超时/缺 witness/coverage 不完整/未知 criterion/路径逃逸 → `error`/`blocked`，不会 pass。
- 6 颗珍珠、10 个模板、每颗 1–3 个模板、每颗 1 个 probe 槽，全部通过 plan 与预算检查。
- 仍是 M1：planner 不调用工具；Phase 3b 强制执行未开始。

## 7. M2 观察结果（2026-11-03）

`fit/static` 的 observe-only 版本读取已有 `assembly` + `assembly-check` run，不调用工具：

| 项目 | 观察结果 | 说明 |
|---|---|---|
| A1 | **blocked** | 0 接口 / 44 未声明；0 hard 是空契约 |
| A1 修复副本 | **pass**（warn 36 未声明） | 补 v032–v036 datum，8 条腿—边框接口 8/8 通过；r030/r031 |
| A2 | **blocked**（strict）/ **pass**（默认 warn） | 32 接口 / 32 通过；18 条未声明；strict 下 blocked，默认只 warn |
| A2 修复副本 | **pass**（strict） | 65 接口 / 0 未声明；E6，33 步 / 2.05M / ~8.5 min |
| A3 | **blocked** | 0 接口 / 63 未声明；0 hard 是空契约 |
| A3 修复副本 | **pass**（warn 55 未声明） | 补 v023–v026 datum，8 条腿—边框接口 8/8 通过；r034/r037；4 处面板拼缝微干涉 0.0274 mm³ 在 epsilon=1 下不计 |

`budgetUsed = 2 tools / 2 calls`，远低于 `fit` 预算（4/30）。
契约还会校验 `sourceVersionIds` 是否与装配一致；版本集不同则 `stale-contract`，不会拿旧契约给新装配背书。

A1 修复副本的闭环：`blocked(0 接口)` → 用 `set_datums` 生成 v032–v036（几何 SHA 不变）→ 在 `assembly/manifest.json` 加 8 条 `distance` 接口 → `check_assembly` r030（8/8 pass）→ `validate_assembly` r031（34 件/561 对，0 干涉）→ `fit` 观察 **pass**，只剩 36 条未声明接触的 warn。

A3 同理：v023–v026 + 8 条接口（r034）→ 全桌 r037（32 件/496 对，0 干涉/0 过紧，epsilon=1）→ `fit` **pass**，55 条未声明接触 warn。A3 的 4 处面板拼缝微干涉 0.0274 mm³ 在 epsilon=1 下不计。**注意：这是家具样本的阈值，不应写进核心 `fit/static`；核心模板已移除这些 args，阈值由项目/rule pack 声明。**

这验证了回退路径：`fit` 失败不是回去改几何，而是回到 `model/contract` 补 datum/接口，再重跑证据。
这证明 `fit` 模板能把“0 干涉”和“接口覆盖”分开看；也证明 A1/A3 的绿色审计如果不看 coverage 会误判。

```bash
node scripts/fit-observe.mjs /tmp/ab-round/A2/examples/cad-data
npm run accept:m2
```

## 8. 机制实验：为什么 A1/A3 停在 0 接口（2026-11-03）

在 A1 副本上做单变量干预（几何不变，只补装配契约）：

| 组 | 干预 | 接口 | 未声明 | 步数 | prompt | 耗时 | fit |
|---|---|---|---:|---:|---:|---:|---|
| E0 | 原始 A1（设计时） | 0 | 44 | 121 | 24.5M | ~31 min | blocked |
| E1 | 任务出口：至少 8 条腿—边框接口 | 8 | 73 | 39 | 3.2M | ~4.3 min | pass（warn 73） |
| E2 | 加 datum/interface 模板 | **81** | **0** | 45 | 4.5M | ~10.1 min | pass |
| E3 | 加 fit-gate 反馈 | **81** | **0** | 66 | 7.2M | ~9.4 min | pass |
| E4 | **产品化的 INTERFACE-GUIDE**（A3） | **71** | **0** | 41 | 3.7M | ~11.3 min | pass |
| E5 | **guide-only**（A3，无 0 目标提示） | **63** | **0** | 38 | 3.1M | ~6.5 min | pass |
| E6 | A2 补 18 条（guide） | **65** | **0** | 33 | 2.05M | ~8.5 min | pass（strict） |

结论（初步）：

- **不是能力问题**：A2 已经证明工具链能做 32 条；E2/E3 证明同一套工具能做 81 条。
- **只加任务出口会诱发最小合规**：E1 精确停在 8 条，73 条未声明仍 pass（warn）。
- **降摩擦最划算**：E2 用模板做到 81/0，代价只有 10 分钟；比 E3 的 gate 反馈更省。
- **gate 也有效**：E3 也做到 81/0，但步数/token 更高；适合作为兜底，不适合唯一手段。

`fit` 现在默认 `undeclaredPolicy:warn`，`--strict` 才 block：E1 的 8/73 默认 pass（warn），strict 下 blocked；E2/E4/E5 的 0 未声明在两种模式下都 pass；A2 默认 pass（warn），strict 下需要补 18 条。

下一步不是先加 `requiredInterfaceGroups`，而是：
1. 把 E2 的 datum/interface 模板产品化进 `fit` 珍珠；
2. 再决定 `fit` exit 是否要求 `undeclared=0` 或关键组覆盖（E1 证明只看 interfaces>0 会被最小合规绕过）。

已落地：`pearls/fit/INTERFACE-GUIDE.md`，`pearl.json` 的 `guide` 字段，以及 `npm run guide:fit`。

E5 去掉了 prompt 里的“undeclared 尽量 0”，只留 guide；仍然做到 63/0，6.5 min。这证明 **guide 本身是有效变量**，不是提示词。

E6 用同一份 guide 把 A2 从 32/18 补到 65/0，strict 下 pass；说明 strict 不是“只能靠新任务”，存量也能修。
E4 用这份产品化 guide 在 A3 上做到 71 接口 / 0 未声明 / 0 hard / 0 干涉，几何 SHA 不变；耗时 11.3 min、3.7M prompt，比 E3 的 gate 更省。

注意：E4 的 prompt 里也写了“undeclared 尽量为 0”，所以它不是纯 guide 单变量；guide 本身也把“0 或逐条解释”写进完成判据。下一轮应去掉 prompt 里的 0 目标，只留 guide，确认是模板而不是提示词在起作用。


## 9. 事故修正：核心 pearl 不得内置任务专用规则

最近两次修正曾把八仙桌的接触组（腿/边框/牙板/穿带）写进 `pearls/fit/INTERFACE-GUIDE.md`，并由 `prompt.ts` 注入每个 `fit` 任务；还把 `epsilon=1`、`adjacency=0.2` 写进核心模板，把 `undeclaredPolicy:block` 设为默认。

这是**任务特化污染核心**：减速器、四连杆会收到家具模板；家具阈值可能吞掉别的任务的真实干涉；`undeclared` 被当成硬需求。

已修正：

- 核心 guide 改为通用（`pearls/fit/INTERFACE-GUIDE.md`）；
- 家具规则移到 `examples/pearls/fit/wood-furniture/`；
- 核心模板不再硬编码阈值；
- `fit` 默认 `warn`，strict opt-in；
- `pearls/probes.json` 清空，`leg-fit` 样例移到 `examples/pearls/`；
- 验收加“核心 guide 不得含家具词”的防回归；
- 预算仍只是默认，且 `fit` 的 4 tools / 30 calls / 600 s **不覆盖 datum/接口修复**（E4 总耗时 11.3 min 就是证据）。

详见 `docs/DECISION-LOG.md` 2026-11-03 条目。

## 10. M3：rulepack/v1 落地

领域规则现在有正式容器：

```text
examples/rulepacks/wood-furniture/
  rulepack.json          # id/version/pearl/guide/thresholds/requiredGroups/policy/probes
  INTERFACE-GUIDE.md     # 家具接触组，不再进核心
```

- `src/host/pearls/rulepack.ts`：`validateRulePack` / `loadRulePack`；
- `schemas/rulepack.schema.json`：契约文档；
- `scripts/accept-rulepack.mjs`：加载、guide、阈值、required groups、policy、probe allowlist 的验收；
- `npm run accept:m3`：M2 + rulepack。

核心 `fit` 仍是通用机制；家具规则必须由项目**显式选择** rule pack 才生效。  
还没做的是“项目 profile 如何选择 rule pack”和“`model` 里的 contract 由谁产出”；这两项是下一步。

## 11. M4：项目 profile + 三示例标准 + model contract

项目现在通过 `pearl-profile.json` 选择珍珠/模板/rule pack：

```json
{
  "pearl": "fit",
  "template": "mechanism",
  "rulePack": "../rulepacks/mechanism"
}
```

三示例检测矩阵：

| 示例 | profile | 接口 | 未声明 | 观察 |
|---|---|---|---:|---:|---|
| roberval-balance | mechanism / fit.mechanism | 26 | 0 | pass |
| windup-frog | mechanism / fit.mechanism | 14 | 9 | pass + warn |
| eight-immortals-table | wood-furniture / fit.static | 0 | 47 | blocked（负样本） |

实现：

- `src/host/pearls/profile.ts` + `schemas/project-profile.schema.json`；
- `pearls/model/templates/assembly.json`：`set_datums → write_assembly → check_assembly`，`retry:4`（self-return allowance）；
- `pearls/model/ASSEMBLY-CONTRACT.md`：通用契约写法；
- `scripts/project-check.mjs` / `scripts/accept-project-standards.mjs`；
- `npm run accept:m4`。

**M5 补完：** `write_assembly` 已实现（create/merge/replace、expectedHash、version/datum/direct-child 校验、原子写入）；`model.assembly` 不再用 `run_python`。

**遗留：** `retry` 仍只是声明，未接 runtime；三示例只覆盖 `fit`，还没覆盖 make/review/deliver；`write_assembly` 的 `replace`/递归子装配还没有三示例覆盖。

### M5 实跑：三个示例的 `write_assembly → check_assembly`

用真实工具（不是核心函数直调）在三个示例副本上跑 `model.assembly` 的契约写入：

| 示例 | `write_assembly` counts | changed | `check_assembly` | 结论 |
|---|---|---|---|---|
| windup-frog | 12 children / 14 interfaces | true | 14/14, 0 hard, 9 undeclared | `check`（未声明是功能接触） |
| roberval-balance | 13 / 26 | **false**（字节级无变化） | 26/26, 0 hard, 0 undeclared | `pass` |
| eight-immortals-table | 28 / 0 | true | 0/0, 0 hard, 63 undeclared | `check`（负样本：空契约） |

实跑发现并修正：`replace` 曾用 `root.name` 覆盖顶层 manifest `name`（windup 的顶层名会被改成“发条青蛙机芯”）。现在 `replace` 保留已有顶层 `name`，验收新增了这条断言。

结论：`write_assembly` 在三种不同装配上可用；roberval 字节级幂等，windup/table 保持各自语义；table 仍是空契约负样本，不应被写成 pass。


## 12. M6：model observer，三示例的 model/fit 分层

新增 `observeModel(projectRoot)`：只读校验 assembly manifest 的 schema、child version、datum 端点和直接 child；它**不判断接口覆盖**。

三示例现在同时有 `model` 和 `fit` 两层状态：

| 示例 | model | fit |
|---|---|---|
| roberval-balance | pass（13 / 26） | pass（26/26, 0 undeclared） |
| windup-frog | pass（12 / 14） | pass + warn（14/14, 9 undeclared） |
| eight-immortals-table | **pass**（28 / 0，空契约结构合法） | **blocked**（0 接口 / 47 未声明） |

这证明 model 和 fit 的边界是清楚的：空契约可以是合法 model artifact，但不能是 fit pass。

`node scripts/project-check.mjs examples/eight-immortals-table` 现在输出 `{ model, fit }`；`accept-project-standards` 增加 model 断言和“无契约项目 blocked”的负样本。

## 13. 失败定位：what / why / where

`fit` 和 `model` 的 observer 现在都输出 `failures[]`：

```json
{
  "code": "undeclared-adjacency",
  "severity": "warn",
  "what": "assembly-check r068: 9 contact pairs are still undeclared",
  "why": ["a real joint was not declared", "the pair is a non-structural contact", "..."],
  "location": {
    "kind": "pair",
    "parts": ["base", "cam"],
    "bboxMin": [-4, -6, 3.6],
    "bboxMax": [8, 6, 5.6],
    "center": [2, 0, 4.6],
    "sizeMm": [12, 12, 2],
    "approximate": true
  },
  "evidence": { "run": "r068", "undeclared": 9 },
  "next": ["review undeclared pairs; declare the ones that are structural joints"]
}
```

- `what`：失败判据的可读陈述；
- `why`：**可能原因**，不是已证明的根因；
- `location`：`pair` / `interface` / `part` / `manifest` / `unknown`；AABB 或 manifest 路径；
- `approximate: true` 永远是 true：这是包围盒/契约位置，不是点云最近点；
- `evidence`：原始 run/计数；`next`：下一步。

三示例的实测：

| 示例 | 失败定位 |
|---|---|
| windup | `undeclared-adjacency` → `base` ↔ `cam`，center `[2, 0, 4.6]`，size `12×12×2` |
| table | `no-declared-interfaces` → manifest；`undeclared-adjacency` → `leg_pp` ↔ `rail_pp`，center `[420,420,760]`，size `60×60×20` |
| roberval | 无 failure |

**限制：** 位置是 AABB 包络；`manifest` 类失败没有几何位置；`make/review/deliver` 还没有 observer，因此它们还不会产出 failure。

## 14. M7：三示例六颗珍珠只读账本

`observeLedger(projectRoot)` 把已有 run/文件映射成六列，**不调用任何工具**：

| 示例 | brief | model | fit | make | review | deliver | overall |
|---|---|---|---|---|---|---|---|
| roberval-balance | pass | pass | pass | warn | unobserved | unobserved | warn |
| windup-frog | pass | pass | pass(warn) | warn | warn | unobserved | warn |
| eight-immortals-table | pass | pass | blocked | pass (wood stock) | pass | unobserved | blocked |

证据规则：

- `brief`：`PROMPT.md` 存在即 pass，**只证明需求输入存在，不评价质量**；
- `make`：有 `printability` 时按当前版本聚合；`difficult`→warn，`excluded`→fail，缺 run→warn；木作 rule pack 有 `make.stockMm/cutlist` 时检查毛料是否放得进原料（按尺寸排序，允许旋转），只判断下料，不判断纹理/榫卯；两者都没有→unobserved；
- `review`：当前版本 `visual-review.json` 的 top+iso+note；部分→warn，全无→unobserved；
- `deliver`：`delivery-audit` run；没有就是 unobserved；
- `overall` 优先级：blocked > fail > warn > unobserved > pass。

失败同样带 `what/why/location`：make 定位到版本的 `minWallAtMm` 点，review 定位到版本/part，缺证据定位到 manifest。

实现：

- [ledger.ts](src/host/pearls/ledger.ts)
- `node scripts/pearl-ledger.mjs examples/windup-frog`
- `project-check` 现在同时输出 `model` / `fit` / `ledger`
- `accept-project-standards` 增加六列断言

**限制：** table 的 make 是 pass 仅表示毛料尺寸能放进 1000×300×300（未判断纹理/榫卯/出材率）；roberval 的 review/deliver 仍是 unobserved，三示例的 deliver 都没有 audit run。`make` 的 `difficult` 不是最终制造结论，只是当前工艺 profile 的 warn。

## 15. 对照计划的缺口登记（2026-11-04）

已完成（可验收）：

- M1 checker 协议 / 六珍珠 / 11 模板 / 规划器；
- M2 `fit` observe（static/mechanism，strict opt-in）；
- M3 `rulepack/v1`；
- M4 项目 profile + 三示例标准；
- M5 `write_assembly` + 真实三示例 replace/check；
- M6 `model` observer（空契约合法，fit 不合法）；
- M7 六列 ledger + failure what/why/where + wood make + delivery artifact observer。

### P0：结构缺口（不补，项链仍只是“可读账本”）

| 缺口 | 现状 | 影响 |
|---|---|---|
| `pearl.run` / host 执行 | **read-only gate 已存在**；工具执行/return/retry 仍不存在 | 能强制 evidence gate，不能自动执行工具或 branch |
| 项目 profile 自动加载 | `pearl_run` 自动读；其他工具/preset 不会自动选 | 会话中的普通工具仍不知道 rule pack |
| 预算依据/执行 | 项目 profile 已声明 budget，plan 检查 tools/calls；wall-clock/真实调用仍未强制 | “预算内”仍不可引用 |
| probe 槽 | 占位 allowlist 已清空；空槽合法 | 仍没有真实 detector，只是接口合法 |
| 跨域测试 | 只有 3 个家具/机构示例 | 不能证明通用 |

### P1：语义缺口（observer 已能跑，但深度不足）

| 缺口 | 现状 | 影响 |
|---|---|---|
| `brief` | 只看 `PROMPT.md` 是否存在 | 不评价需求质量 |
| `make` | printability 逐版本；wood 只查毛料尺寸（排序后可旋转） | 不判纹理/出材率/榫卯；`difficult` 只 warn |
| `review` | 只看 `visual-review.json` 的 top+iso+非空 note | 不判图像/note 质量；roberval 仍 unobserved |
| `deliver` | 读可选 `delivery-audit.json`；`delivery_audit` 本身不落 run | 三示例仍全部 unobserved |
| `fit.mechanism` | 只读 assembly/check，不接 motion/motion-clearance | 机构 fit 没有运动覆盖 |
| `fit` 覆盖 | `undeclared` 可 warn/block，但没有 required groups/解释通道 | 只能“全 0”或全局策略 |
| failure location | AABB / 点 / version / manifest；why 是假设 | 不是精确接触面；多失败只取第一个位置 |

### P2：平台/体验缺口

| 缺口 | 现状 |
|---|---|
| ledger 持久化 | 每次 on-demand 读文件，没有历史/趋势 |
| 三示例 deliver | 没有 audit artifact，不能判 |
| `write_assembly` 覆盖 | create/merge/replace 核心测试；三示例只真实跑了 replace，merge 真实路径未跑 |
| `write_assembly` 递归/子装配 | 未在示例覆盖 |
| `model.assembly` retry | `retry:4` 声明 + no-progress，runtime 未执行 |
| GUI 集成 | 没有珍珠/ledger 面板；只有 CLI/JSON |

### 立即建议顺序

1. 让 `delivery_audit` 落一个 `assembly/delivery-audit.json`（或 run），三示例 deliver 才不会永远 unobserved；
2. 接 `fit.mechanism` 的 motion/motion-clearance 证据；
3. 给 rule pack 加 required groups + explained undeclared；
4. 再做 `pearl.run`（先 `model.assembly`，再全链）和预算执行；
5. 最后才扩跨域示例和 GUI。

## 16. P0 gate-level 落地与真实缺口

新增 [run.ts](src/host/pearls/run.ts) / `pearl_run` 工具 / `npm run run:pearl`：

- 自动读 `pearl-profile.json`；
- 用 **profile 的 budget** 规划（不再用 pearl 默认静默替代）；
- 未声明 budget → 只 warn；运行期只用一个 `maxCostSeconds` deadline（executor 尚未接）；
- 规划预算（distinct tools/calls）实际检查；
- 输出 probe 配置、六列 ledger、局部失败；
- **不执行 CAD 工具**：它是证据/预算/模板门禁，不是 Phase 3b 执行器。

三示例：windup/roberval `warn`，table `blocked`；budgetSource 都是 `profile`。

P0 仍未完成的部分（不能伪装成完成）：

| 项 | 状态 |
|---|---|
| `pearl.run` **执行工具** | 未做；只有 read-only gate |
| return/branch/retry 执行 | 未做；`retry:4` 仍是声明，repair policy 已固定 |
| 预算的 wall-clock 执行 | 未做；executor 尚未接；不建 soft 层 |
| probe 实际 detector | 未做；占位 allowlist 已清空，空槽合法 |
| 跨域示例 | 仍只有 mechanism/wood 三个示例，没有 enclosure/钣金 |
| `write_assembly` 真实 merge/create/嵌套 | 只有三示例 replace + 核心测试 |

因此准确说法是：**P0 的门禁层已补齐；P0 的执行层没有。**

## 17. 轻量 watchdog：一个 deadline，不建软层

最终选择最轻的方案，不再维护 step soft/hard 两套阈值：

- **每个 pearl run 只有一个 `maxCostSeconds` 硬 deadline**；到点 abort，状态 `blocked`，原因 `deadline`；
- **单步超时用工具已有的 `timeoutMs`/`withDeadline`**；没有显式值的工具由 `CAD_TOOL_TIMEOUTS` 覆盖，默认 120s；不在珍珠层复制一套；
- **不新增 step trace schema**：`step_start/step_end/tool_result` 已经能回答“卡在哪一步”，需要时再读 JSONL；
- **不设 soft 层**：没有“p95 软阈值 + 2×p95 硬阈值”的脚手架，拆除成本为零；
- LLM 只在 deadline/异常之后做 post-mortem，不进入 hot path。

计划层的 `maxDistinctTools/maxCalls` 仍是静态结构检查（超了就 blocked）；`maxCostSeconds` 只是运行 deadline，不在 plan 层判。

`on_fail.kind` 保留三类：

| kind | 例子 | 处理 |
|---|---|---|
| `transient` | 超时、runtime 未就绪、锁竞争、进程崩溃 | 同参数自动重试，最多 2 次 |
| `repair` | 缺 datum/版本、契约过期、干涉、证据缺失 | 带 failure context 回到目标，改完再跑；同一 signature 重复即停，全局最多 4 round |
| `unrecoverable` | 路径逃逸、未知工具、参数非法、权限、deadline | 不重试，blocked |

当前 `model.assembly` 的 `retry:4` 是 self-return allowance；真正的 executor 还没接。repair 语义已固定为 no-progress + 全局 4 round，不假装已经执行。


工具超时审计：`npm run accept:m8` 检查默认 120s、`check_assembly` 300s 等；慢但未超时只记录现有 `step_end`，不杀、不降级。

## 18. 项链契约：把六颗珍珠串起来

采用**两个契约**，不把装配契约变成杂物袋：

1. `assembly/assembly.json`：几何/接口契约，仍归 `model`/`fit`；
2. `necklace-contract.json`：项链契约，记录六颗珍珠的 status、evidence、failures、assembly hash，是“线”。

依赖顺序（并行安全）：

```text
brief
  → model
      → fit / make / review（可并行）
          → deliver
              → final compare（对照 brief/acceptance）
```

不是固定脚本；`CONTRACT_STAGES` 只表达依赖。`next` 由 failures 推导：

- `no-declared-interfaces` / `stale-contract` / interference → `model`
- `undeclared-adjacency` → `fit`
- `make.*` → `make`
- `review.*` → `review`
- `deliver.*` → `deliver`

失败后只回退到 owner，不整链重跑；同一 failure signature 重复即停，全局最多 4 个 repair round。

契约字段：

```json
{
  "schemaVersion": 1,
  "status": "warn",
  "complete": false,
  "assembly": { "path": "...", "hash": "sha256:...", "counts": {...} },
  "sections": {
    "brief": { "status": "pass", "evidence": {}, "failures": [] },
    "model": { ... }, "fit": { ... }, "make": { ... }, "review": { ... }, "deliver": { ... }
  },
  "next": ["make", "review", "deliver"]
}
```

- `complete` = 六列都已有证据（不一定是 pass）；
- `unobserved` 明确挡住 complete；
- 写入是显式、原子、带 `expectedHash` 的；不自动覆盖；
- assembly hash 用于发现“契约比装配旧”。

三示例：

| 示例 | contract.status | complete | next |
|---|---|---|---|
| windup | warn | false | fit, make, review, deliver |
| roberval | warn | false | make, review, deliver |
| table | blocked | false | model, fit, deliver |

实现：`contract.ts`、`contract-build.mjs`、`necklace-contract.schema.json`、`accept-contract.mjs`、`npm run accept:m9`。

**注意：** 这是“线”和索引，不是执行器。它能把“谁先谁后、失败回谁、证据是否齐”说清楚，但实际调用工具、写 section、执行 repair 仍需 executor。

## 19. 缺口复核（2026-11-04，M13 后）

验收状态：`npm run accept:m13`、typecheck、build 全绿。

### P0：执行层

| 缺口 | 现状 | 风险 |
|---|---|---|
| `pearl_run` 执行 | `execute:true` 已 dispatch CAD 工具；gate 仍只读 | 已不再是“只读” |
| `on_fail` / retry | transient 重试、on_fail route 已接 | 不会自动改项目后重跑 |
| repair round | contract 里的 `repair.round` 恒为 0；未持久化历史 | no-progress 只算当前轮 |
| 总 deadline | `executeTemplate` 一个 deadline；工具各有 timeout | 跨 round 的整链 deadline 未统一 |
| profile 自动加载 | `pearl_run`/`preflight` 读；普通工具不知道 | 会话中仍可能绕过 rule pack |
| probe detector | allowlist 空槽合法，但没有真实 detector | 自定义检查未使用 |
| 跨域 | 仍只有 mechanism/wood 三示例 | 通用性未证 |

### P1：契约/observer 的缺口

| 缺口 | 现状 |
|---|---|
| 契约读取/校验 | ✅ `readNecklaceContract` 校验 schema、读 hash、对照 assembly hash；`contract:check` CLI |
| 契约覆盖 | ✅ 已有文件被改动时没有 `expectedHash` 会拒绝；同内容幂等 |
| deliver | `delivery_audit` 不落 `delivery-audit.json`；三示例仍 unobserved |
| fit.mechanism | 只读 assembly/check；motion/motion-clearance 未接；实测用 static 副本 |
| brief | 只检查 `PROMPT.md` 存在 |
| make | wood 只查毛料尺寸；printability 只按当前版本，不判纹理/出材率 |
| review | 只检查 top+iso+非空 note，不判图像/note 质量 |
| failure location | AABB/点/版本/manifest；粗定位，符合当前选择 |

### P2：覆盖/平台

| 缺口 | 现状 |
|---|---|
| `write_assembly` 真实路径 | 三示例只跑 replace；merge/create/嵌套未真实跑 |
| `write_assembly` 运行记录 | 工具成功但不落 run artifact |
| contract 历史 | 每次 derived，没有版本历史/趋势 |
| preflight 集成 | ✅ `preflight` 会跑 contract round；但不自动 `execute:true` |
| GUI | 没有 ledger/contract 面板 |

### 结论

- 门禁层：model/fit/ledger/contract/pearl_run 可读、可验收；契约 read/validate/stale 已补；
- 执行层：能 dispatch 单个模板；repair loop 可编排重跑，但几何修改由 LLM/agent 决定；
- 契约层：能 build/write/read/check；
- 观测层：仍有 deliver、roberval review、table make 深度等未观测项。

下一步优先级：**fit.mechanism 实测 + 真实 probe 模板目录 + deliver 证据覆盖**；不做几何 solver。

## 20. 执行层 v1：contract round + preflight gate + deadline

### `executeContractRound`

[execute.ts](src/host/pearls/execute.ts)：

- 以 `CONTRACT_STAGES` 表达依赖；
- 每轮 `buildNecklaceContract`（读证据）；
- 用 `decideRepair` 判断：新 signature → `repair-needed`；同 signature → `no-progress`；round 4 → `exhausted`；
- 返回 `stages` / `repair` / `next` / `failures`；
- 一个 round 包在 `withDeadline` 里（默认 profile `maxCostSeconds`）；
- deadline 失败 → `pearl.deadline`，blocked。

**这不是 CAD 工具执行器**：它执行的是“六珍珠证据轮次”，工具调用仍发生在各珍珠内部/外部。真正的 tool dispatch 还没接。

### preflight 集成

`preflight` 现在：

- 只有项目有 `pearl-profile.json` 时才跑 pearl gate；
- 用 `executeContractRound`，不是直接 `runPearl`；
- `pearl` step 进入 judgement：
  - blocked/fail → excluded；
  - warn/repair-needed/unobserved → difficult；
  - pass → not-excluded；
- 无 profile → 列入 `coverage.notCovered`，不假装通过。

### deadline

- 一个 round 一个 `maxCostSeconds` deadline；
- 工具级 `CAD_TOOL_TIMEOUTS` 是 step 的硬超时；
- 慢但未超时：只记录现有 step 日志，不杀、不降级。

### 验收

```text
npm run accept:m11 -> OK
```

覆盖：

- table round 0 → blocked（fit blocked），但 repair route 仍指向 model；
- 同签名 round 1 → no-progress/blocked；
- windup → make/review；
- deadline 1ms → pearl.deadline blocked；
- 阶段列表完整。

### 未完成

- 真正 dispatch CAD 工具；
- 把 repair route 变成自动回退执行；
- 工具级 timeout 的完整 runtime 验证；
- deliver artifact。

## 21. step 输入契约、输出风格、三示例执行结果

### step 输入契约

`TemplateStep` 增加 `bind`：

```json
{
  "id": "interfaces",
  "tool": "check_assembly",
  "bind": {
    "manifestPath": { "from": "project", "path": "assembly.path" }
  }
}
```

来源：

- `project`：profile/rulepack/assembly parts/path；
- `input`：调用者提供的参数（如 `gap`、`motion`、`contract`、`versionId`、`claims`）；
- `step`：前面步骤的输出；
- `contract`：项链契约；
- `failure`：失败上下文。

`resolveStepArgs` 按 binding 解析；缺值抛 `MissingStepInput`，不猜。`buildStepContext` 从 assembly manifest 生成 `assembly.parts`。

已给 fit/model/make/review/deliver 的关键 step 加 binding；没有 caller 输入的 step（如 `write_assembly` 的 root、`measure_gap` 的版本）会明确要求 input，而不是空跑。

### 输出风格

`formatContractRound`：

- pass：一行 `pearl: pass · round 0/4`；
- warn/repair-needed：紧凑 `! code @ where` 列表；
- blocked/fail：逐项 `what / why / where / next`，错误必须喧嚣。

`execute-contract` 默认文本，`--json` 才输出完整对象。

### 三示例执行结果（round 0）

| 示例 | status | next |
|---|---|---|
| windup-frog | repair-needed | fit, make, review, deliver |
| roberval-balance | repair-needed | make, review, deliver |
| eight-immortals-table | blocked | model, fit, deliver |

table 的 hard failure 是空契约；windup/roberval 的 make/review/deliver 警告被保留为下一步。

### 边界

执行器仍是 **contract-round / evidence round**：`resolveStepArgs` 已定义 step 的可执行输入，但还没有真正 dispatch CAD 工具。下一步接 `ctx.tools.execute` 时，参数不再靠猜。

验收：`npm run accept:m12`、typecheck、build 全绿。

## 22. CAD tool dispatch（实际接入）

`pearl_run` 现在有两条路径：

- `execute:false`：原 read-only gate；
- `execute:true`：`executeTemplate` 按模板步骤真正 dispatch `ctx.tools.execute`。

### 执行链

```text
profile → pearl/template
  → buildStepContext（assembly.parts / assembly.path）
  → resolveStepArgs（literal + bind）
  → serial or declared parallel group
  → ctx.tools.execute(tool, args)
  → semanticFailure(value)（judgement=excluded / overallStatus=fail）
  → transient retry（≤2）
  → on_fail route
  → quiet/loud formatter
```

关键点：

- `validate_assembly` 返回 `judgement=excluded` 时，工具调用成功也算 step fail；
- 因此不会再把“工具成功但几何失败”误报成 pass；
- `pearl_run` 的 execute 模式用 `formatTemplateExecution`：pass 一行，错误逐项；
- 真正的 CAD 工具参数来自 binding，不再猜。

### 实际三示例（static 模板）

为了避免 mechanism 模板缺 `motion` 输入，三示例都用 `fit/static` 的副本测试；原 profile 的 mechanism 未改。

| 示例 | execute 结果 | step | 说明 |
|---|---|---|---|
| windup | repair-needed，next model | interference fail 11.9s | 22 too_tight |
| roberval | repair-needed，next model | interference fail 10.3s | 2 interference + 10 too_tight |
| table | repair-needed，next model | interference fail 10.3s | 8 interference + 55 too_tight；check_assembly `difficult`（0 接口/63 未声明） |

实际工具确实被调用，并写入了新的 `validate_assembly` / `check_assembly` run。

### 修掉的真实 bug

`PEARLS_ROOT` 原先固定 `../../../pearls`：源码 `src/host/pearls` 对，但 esbuild bundle 在 `lib/` 时解析到 `/Project/pearls`，导致 `pearl_run` 在 profile 加载阶段 ENOENT。现在按候选路径探测 `fit/pearl.json`，源码和 bundle 都可用。

### 边界

- 实际测试是临时副本，不是仓库 examples 本身；`static` 模板替代了 windup/roberval 的 mechanism；
- `execute:true` 返回 **template execution**，不是项链 gate；table 的 execute 是 `repair-needed`，gate 仍可能 `blocked`；
- repair loop 已能编排重跑，但不会自己改几何；
- `gaps` 这种 `when: interference.fail` 的诊断步骤当前被 on_fail 短路，不会执行；
- `preflight` 仍用 contract-round，不调用 execute:true。

## 23. P0 收口：difficult、repair loop、deliver artifact

### difficult 不是 fail

`judgement=difficult` 不判失败，但必须解释：

- `semanticAttention()` 把它记成 `explanationRequired` / `attention`；
- `formatTemplateExecution` 在 pass 或 fail 的输出里都加 `⚠ explanation required: ...`；
- LLM 必须说明“哪里 difficult、为什么接受/不接受”；沉默不算解释。

### repair loop + history

新增：

- `repair-history.ts`：`assembly/pearl-repair-history.json`；
- `repair-loop.ts`：`runTemplateRepairLoop`；
  - 调用者提供 `repair(input): Promise<boolean>`；
  - 只有 repair 真的改了东西才重跑；
  - same signature → no-progress；
  - 总 deadline 覆盖所有 round；
  - 每 round 落 history。

它不是几何自动修复：`repair` 的回调必须由 agent/脚本提供，executor 不发明修改。

### deliver artifact

`delivery_audit` 现在写 `assembly/delivery-audit.json`；`observeDeliver` 从该文件读，不再永远 unobserved。新增 `persistDeliveryAudit`，acceptance 验证写出的 artifact 能被 observer 读成 pass。

### 仍未完成

- `fit.mechanism` 的三示例实测（需要 motion 输入）；
- 把 repair loop 暴露成 LLM 可调用的自动轮次（当前是 API/测试）；
- 真实 probe template 目录（本文件只固定“catalog 可选、不默认挂载”的语义）。

### 验收

```text
npm run accept:m14 -> OK
```


## 24. 目标边界：发现，不是修复

本插件的目标不是“自动修几何”。几何改动由 LLM/agent 决定；插件负责：

1. 发现失败（`what`）；
2. 定位（`where` / `location`）；
3. 给 witness（测量值、limit、run/version）；
4. 区分 `pass` / `difficult` / `fail`，把注意力引到该看的地方；
5. 在 LLM 改完后重验，并判断证据是否新鲜。

因此：

- `runTemplateRepairLoop` 只是重跑编排，不计算几何修改；
- `difficult` 要求 LLM 解释，不是插件替它决定；
- 不把“自动修几何”列为 P0/路线图；需要 solver 是另一个产品，不是当前插件。

下一步只做检测/证据能力：`fit.mechanism` 的 motion 输入、真实 probe 模板目录、deliver artifact 覆盖。

## 25. 按“发现/定位/重验”重排缺口（2026-11-05）

### 目标判定

一个缺口是否 P0，只看它是否直接提升：

1. 能不能发现失败；
2. 能不能定位到 part/pair/interface/manifest；
3. 有没有 witness（测量值、limit、run/version）；
4. 能不能把注意力引到该看的地方；
5. LLM 改完后能不能重验、判断证据是否新鲜。

**不按“能不能自动修”排序。** 几何修复不是插件目标。

### P0：先补“看得见”

| 顺序 | 缺口 | 为什么是 P0 | 验收 |
|---|---|---|---|
| P0-1 | `fit.mechanism` 没有真实 motion 输入/实测 | ✅ `examples/pearls/motion/windup-cam-slider.json`；真实 `simulate_motion` r073：49 checks / 46 events，首个 `cam↔slider 0.145mm³ @0.042s`；step 失败并带 witness | 保持 fixture 可复现 |
| P0-2 | probe 没有真实模板目录 | ✅ `fit-clearance` checker/v1 模板 + negative sample；profile 显式 `probe` 才挂载 | 继续加模板 |
| P0-3 | deliver artifact 未在三示例落地 | `deliver` 仍 unobserved，证据链断 | 三示例跑 `delivery_audit`，artifact 被 observer 读到 |
| P0-4 | 跨域样本缺失 | 只有 mechanism/wood，不能证明“发现能力”通用 | 加 enclosure/钣金/减速器至少一个负样本 |
| P0-5 | fit 定位仍粗 | AABB 近似，pair 有了但 witness 不够 | 至少一个真实干涉给出 pair + 体积/间隙 + 坐标 |

### P1：把“发现”做深

| 珍珠 | 缺口 | 现状 |
|---|---|---|
| brief | 只看 `PROMPT.md` 存在 | 不解析 acceptance/需求 |
| model | `write_assembly` 只实测 replace | merge/create/嵌套/运行记录未覆盖 |
| fit | required groups / explained undeclared 未实现 | 只有全局 undeclared policy |
| fit | mechanism motion-clearance 未消费 | `fit.mechanism` 只看静态 check |
| make | wood 只查毛料尺寸 | 不判纹理/出材率/榫卯；printability 深度不足 |
| review | 只查 top+iso+非空 note | 不判图像/note 质量；roberval unobserved |
| deliver | claims 覆盖不完整 | artifact 写入已有，三示例未跑 |
| contract | 历史/趋势 | ✅ `writeNecklaceContract` 追加 `necklace-contract-history.json`；repair round 仍有单独 history |

### P2：平台/体验

| 缺口 | 现状 |
|---|---|
| profile 自动加载 | 只有 `pearl_run`/`preflight` 读 |
| `preflight` 的 pearl 步骤 | 用 contract-round，不调用 `execute:true` |
| `gaps` 条件步骤 | 被 on_fail 短路，不执行 |
| write_assembly run artifact | 成功但不落 run |
| GUI/ledger 面板 | 无 |
| repair history 展示 | 有 JSON，无视图 |

### 当前三示例状态

| 示例 | brief | model | fit | make | review | deliver | overall |
|---|---|---|---|---|---|---|---|
| windup | pass | pass | pass | warn | warn | warn | warn |
| roberval | pass | pass | pass | warn | unobserved | fail | fail |
| table | pass | pass | blocked | pass | pass | fail | blocked |

### P0 实测记录

- **P0-1**：`examples/pearls/motion/windup-cam-slider.json`（drum fixed + cam drive 2π + slider ±2mm）。真实 run r073：49 次干涉检查，46 个事件；首个 `cam↔slider 0.145mm³ @ t=0.042s`，`samplingSatisfied=true`，`maxJointDriftMm=0`。这是“能发现运动问题”的证据，不是 pass。
- **P0-2**：`pearls/probe-templates/fit-clearance/`：checker/v1 + `negative.json`；`fit.probe.allowed=["fit-clearance"]`，但只有 profile 写 `probe` 才挂载；`accept:probe` 验证 mount/负样本/profile 选择/失败阻断。
- **P0-3**：三示例写 `assembly/delivery-audit.json`；deliver 不再 unobserved。
- **P0-4**：step 失败 error 从 `overallStatus=fail` 升级为带 pair/体积/时间；`validate_assembly` 的 `offenders` 也提取。

### 明确不做

- 自动移动零件/改尺寸/改 datum；
- 自动求解干涉；
- 自动决定“往哪挪多少”；
- 用 repair loop 冒充几何修复；
- 把几何 solver 塞进插件。

### 建议顺序

```text
P0-1 fit.mechanism motion
→ P0-2 probe template
→ P0-3 deliver artifact
→ P0-5 fit witness
→ P0-4 cross-domain
→ P1 depth
```


## 26. P1 进展：explained undeclared

规则包可以声明：

```json
"undeclaredExplanations": [
  { "a": "leg_pp", "b": "rail_pp", "reason": "intentional joint contact" }
]
```

`fit` observer：

- 把 explained pair 从 `counts.undeclared` 里扣除；
- 仍然产生 `explained-undeclared` info finding（可见，不是静默删除）；
- `undeclaredPolicy:block` 只对 **unexplained** 的 pair 生效；
- witness 里同时保留 `explained` / `unexplained` 数量。

验收：`accept:explained`。

## 27. 阶段总结与原计划偏差（2026-11-05）

### 已完成的主线

| 层 | 结果 |
|---|---|
| 六珍珠/模板 | 6 个固定 pearl、11 个模板；模板 step 有 `args/bind/when/parallel` |
| 双契约 | `assembly.json` + `necklace-contract.json`；read/validate/stale/history/expectedHash |
| 证据账本 | 六列 status/evidence/failures；`difficult` 要求解释 |
| 执行 | `pearl_run({execute:true})` 真实 dispatch；serial/parallel、transient、on_fail route |
| 预算 | 一个模板 deadline + 每工具 timeout；慢但未超时只记日志 |
| repair | no-progress + 全局 4 轮 + history；**不自动改几何** |
| 发现能力 | fit 干涉/接口/未声明解释、motion 负 fixture、probe 模板、deliver artifact、witness |

### 当前三示例

| 示例 | brief | model | fit | make | review | deliver | overall |
|---|---|---|---|---|---|---|---|
| windup | pass | pass | pass | warn | warn | warn | warn |
| roberval | pass | pass | pass | warn | unobserved | fail | fail |
| table | pass | pass | blocked | pass | pass | fail | blocked |

### 与原计划的偏差

| 原计划 | 实际 | 判定 |
|---|---|---|
| 单一“契约作为线” | 双契约：装配契约 + 项链契约 | **架构细化**，避免 make/review/deliver 污染几何契约 |
| soft/hard 两层预算 | 一个 deadline + 工具 timeout，不建 soft 层 | **用户驱动的简化** |
| 每失败单元 `retry:2` | no-progress + 全局 4 轮 + transient 2 | **用户驱动的修正** |
| 自动修几何 / 自动 repair | 只做 route + repair loop；几何由 LLM/agent 决定 | **目标修正**，不是缺口 |
| 空 probe 槽 | `fit-clearance` 模板 + profile 显式选择；不默认挂载 | **提前实现一部分** |
| 完整执行器/自动回退 | contract-round + 单模板 dispatch；preflight 用 contract-round | **部分偏差，P0 执行层未满** |
| 三示例 deliver 可判 | artifact 已写；deliver 变为 warn/fail/fail | **完成** |
| 跨域样本 | 仍只有 mechanism/wood | **按用户要求延后** |
| P1 全部 | explained undeclared + contract history 已完成；required groups/motion-clearance/brief/make/review/write_assembly 未完成 | **部分完成** |

### 最值得注意的偏差

1. **“自动修几何”是错误目标**：已从路线图移除；插件只负责发现/定位/witness/重验。
2. **执行层是“能 dispatch 一个模板”，不是“能自动跑完整条项链并修好”**：`pearl_run` 有 execute，但没有自动 repair 驱动/几何 solver。
3. **`fit.mechanism` 是负 fixture**：r073 证明能发现 cam↔slider 干涉，不是通过的运动机构。
4. **probe 只有一个模板**：`fit-clearance` 是目录/选择/负样本的样板，不是完整 probe 库。
5. **跨域未做**：当前不能证明发现能力不依赖 mechanism/wood。

### 验收

`npm run accept:m16`、typecheck、build 全绿。

## 29. 仿真一分为二：一致性检查 vs 功能目标

仿真不是一种珍珠，也不该被一句“场景驱动”排除。它分两类，接入点不同。

### A. 一致性 / 可行性检查

问题：**在基本物理/装配条件下，是否自洽？**

例子：

- 天平空载放在地面是否稳定；
- 装配/运动过程中是否干涉、装不进去；
- 机构是否有可行运动；
- 打印件是否站得住、壁厚是否成立。

特点：

- 不需要用户给“功能目标”；
- 默认应跑；
- 可以成为 `fit` / `make` 的 gate 或 warn；
- 失败是“设计不一致”，不是“没达到产品指标”。

接入：

```text
fit/static      validate_assembly + check_assembly
fit/mechanism   + simulate_motion
make/fdm        check_printability
```

后续可加：

```text
fit/static      simulate_physics（空载重力/稳定性）
make/*          支撑/落床可行性
```

### B. 功能目标

问题：**在声明场景下，是否达到声明目标？**

例子：

- 天平放 5g 砝码是否向一侧倾斜 ≥2°；
- 发条青蛙是否跳起 ≥X mm；
- 流道是否在目标流量下无死区；
- 机构是否完成规定行程。

特点：

- 必须有 **scenario + target + acceptance**；
- 没有场景/目标 → `unobserved` 或 `not-applicable`，不是 pass；
- 输出是 **claim 的 witness**，不是默认 gate；
- 由 `brief` 声明，由 `deliver` 消费。

接入：

```text
brief      acceptance/scenario contract
deliver    functional template:
             simulate_* (scenario input)
             compare metric vs target
             produce claim + fresh run
             delivery_audit
```

### 为什么不是第七颗珍珠

六颗珍珠是**固定决策边界**；仿真是**证据类型**。  
“功能是否达到目标”可以归入 `deliver`（能不能交），一致性检查可以归入 `fit`/`make`。  
如果单独做一颗 `simulate` 珍珠，它会：

- 对大多数项目 `not-applicable`；
- 或者强迫所有项目先声明场景；
- 或者把“场景”藏进模板，制造假通过。

### 当前缺口

- `brief` 还没有 acceptance/scenario 解析；
- `deliver` 还没有 claim-driven `simulate_*` 模板；
- `fit.mechanism` 只有 motion，没有空载稳定性；
- `simulate_stress/fluid/lbm/physics` 还没有接到 claim witness。
