# 工具面压缩方案（9 facade，Phase 3d 全量 cutover 探针）

> **状态**：方案 A 已确认（2026-11-16）；Phase 0/1/2 已落盘，Phase 3 的 36 工具 cutover 探针通过。
>
> **目标**：把模型可见的 CAD 工具从 40+ 压到 8–12 个，同时不丢掉
> gate、evidence、版本不可变和交付审计。
>
> **参照**：[sixtysevenlf/dsh-blender-plugin](https://github.com/sixtysevenlf/dsh-blender-plugin)
> 的 6 工具 facade + 228-op catalog 结构（`docs/architecture.md`、`src/tools/op/index.ts`）。

> **Phase 0 状态（2026-11-16）**：已落盘映射与测量。
> `src/host/tool-facades.ts`（9 facade / 39 个现有工具，data-only）；
> `scripts/audit-tool-surface.mjs` 实测 87,064 schema chars ≈ 21,766 tokens；
> `scripts/accept-tool-surface.mjs` PASS。未注册/删除/修改任何工具行为。

> **Phase 1 状态（2026-11-16）**：`cad_inspect` 原型已落盘（未注册）。
> 4 个旧 schema 11,594 chars → facade 549 chars（约 -95.3%）；
> `scripts/accept-cad-inspect-facade.mjs` PASS，catalog/help/未知 action/委派均覆盖。

> **Phase 2 状态（2026-11-16）**：`toolFacades: ["inspect"]` 是 opt-in，默认关闭。
> 默认 39 个旧工具不变；开启后 40 个（旧 39 + `cad_inspect`），用于对照。
> `accept-cad-inspect-registered.mjs` PASS；真实 `measure` 因本机 runtime 受限显式 SKIP，
> 委派由 Phase 1 的 fake legacy 覆盖。过渡期两者同时可见，schema 从 11,594 增到 12,143 chars，
> 不是净下降——Phase 3 隐藏旧四个后才算压缩。

> **Phase 3 状态（2026-11-16）**：`hideLegacy` 探针已验证 36 工具（39 - 4 + 1），
> 39 工具 schema 87,064 chars → 36 工具 76,019 chars（-11,045，约 -12.7%）。
> 默认生产仍是 39；真实 `measure(kind="part")` 需在可写 runtime / CI 再补，
> `accept-cad-inspect-registered` 显式 SKIP 了依赖 runtime 的 measure。

> **Phase 3b 状态（2026-11-16）**：`cad_check` + `cad_simulate` opt-in；
> check 7 ops / simulate 5 ops，cutover 29 工具，87,064 → 49,805 chars（-37,259，约 -42.8%）。
> `accept-cad-check-simulate.mjs` PASS；仍未注册到生产默认。

> **Phase 3c 状态（2026-11-16）**：inspect + check + simulate 三个 facade 同时 cutover：
> 26 工具，87,064 → 38,760 chars（-48,304，约 -55.5%）；
> 旧 16 个工具隐藏，三个 facade 保留。仍为 opt-in，生产默认 39。

> **Phase 3d 状态（2026-11-16）**：9 个 facade 全部落盘；opt-in 48 工具，
> 全量 cutover 后 **9 工具 / 3,868 chars**（87,064 → 3,868，-83,196，约 -95.6%）。
> `accept-cad-all-facades.mjs` PASS；`cad_deliver` 仍标记为顶层 gate。默认生产仍 39。

> **2026-11-16 方向修正（用户拍板）**：保留 **9 个作业面**，不做“数据域 4 工具”。
> 理由不是“9 更少”，而是 39→9 已经把 87 KB 降到约 6 KB（按 `cad_inspect` 实测外推），
> 9→4 只能再省约 2–3 KB（约 0.5–0.8k tokens），却把 20+ 个 action 塞进 `cad_artifact`，
> 增加跨域歧义；BOM/ICD 是 subject/context，不是工具命名空间。
> “删掉 facade 作为独立架构层”仍成立：9 个入口只是薄适配器 + 一个 catalog，
> 不拥有状态、不拥有生命周期。

## 0. 结论

推荐 **方案 A：按“作业面”做 9 个 facade，内部继续用 typed op 校验**。

不建议直接照搬 Blender 插件的 6 个工具：

- 它的 6 个不是 6 个能力，而是 `session / op / py / see / run / inspect`；
- 228 个操作藏在 `blender_op` 的 catalog 和通用 `args` 里；
- 我们真正要学的是 **按需展开 + catalog**，不是“数字越小越好”。

本方案的目标不是“工具少”，而是：

```text
顶层 schema 小
+ 操作仍可发现
+ 每个 op 仍有参数/输出校验
+ gate 仍然是 gate
```

## 1. 现状与基线

### 1.1 当前形状

发布版文档按 43 个工具描述；当前工作树在物理引擎重构中，注册数会略有变化。
方案按 **约 40 个语义工具** 处理，不依赖某个瞬间的精确数字。

39 个 base 工具的 `name + description + parameters` 实测约：

```text
87 KB
≈ 21,800 tokens（按 chars / 4 粗估）
```

最大的几个：

| 工具 | schema |
|---|---:|
| `simulate_physics` | 7.2 KB |
| `simulate_stress` | 5.4 KB |
| `simulate_motion` | 5.0 KB |
| `measure` | 4.3 KB |
| `import_part` | 2.7 KB |
| `delivery_audit` | 2.2 KB |

### 1.2 为什么现在这么多

每个工具是一个**语义动作**，而不是一个传输通道：

```text
generate_part
measure
check_printability
check_cnc_access
simulate_motion
delivery_audit
deliver
...
```

每个工具各自带：

- 参数 schema；
- 输出 schema；
- 参数错误文本；
- 输出契约校验；
- 与版本、evidence、policy、delivery 的绑定。

`tool-groups.ts` 只做**会话级可见性裁剪**（非 CAD 会话隐藏整组），
在 CAD 会话里仍是整个目录，所以不能减少 CAD 会话内的 40+ 个 schema。

### 1.3 参照插件的真实结构

`dsh-blender-plugin` 的 6 个工具：

| 工具 | 内部动作 |
|---|---|
| `blender_session` | 19 个 action：list/status/doctor/attach/claim/grant/pause/txn… |
| `blender_op` | 34 family / 228 op 的 catalog |
| `blender_py` | 任意 Python |
| `blender_see` | 视口/相机/自定义截图 |
| `blender_run` | 9 个 action：submit/status/wait/collect/cancel/tune… |
| `blender_inspect` | 25 个只读 addon command |

`blender_op` 的顶层 schema 只有：

```ts
{
  action: string,
  op: string,
  args: json,
  path?: string,
  attach_images?: boolean,
  ...
}
output: ANY_SCHEMA
```

关键不是“它只有 6 个”，而是：

```text
228 个 op 不进入顶层 schema
  → 模型先 op="catalog" 看目录
  → op="<name>_help" 看参数
  → 细节放 skill / catalog
  → 运行时再校验 args 和回执
```

所以它的**工具面**是 6，**操作面**是 228。复杂度没有消失，只是从
“工具列表”挪到了 catalog、dispatch 和 Python runtime。

## 2. 设计原则

### P1：工具面 ≠ 操作面

顶层工具是**作业边界**；具体操作是 catalog 里的 op。

### P2：gate 不能藏进通用 op

`deliver`、`delivery_audit`、`preflight` 必须保持可识别、可单独审计。
如果它们只是 `cad_op(op="deliver")` 的一个字符串，模型和人都更容易跳过。

### P3：参数可以通用，输出不能通用

顶层可以接受 `args: json`；但 dispatcher 必须按 op 校验**输出**，
不能学 `ANY_SCHEMA` 把回执形状完全交给 runtime。

### P4：按需展开，不按需猜

每个 facade 提供：

```text
action="catalog"   列动作
action="help"      列参数/输出/示例
```

skill 只写跨动作的工作流，不复制全部参数表。

### P5：旧名字可以被移除，但不能静默改变语义

当前是 0.1.0-preview，允许一次 breaking change；但要：

- 更新所有 skill、测试、文档；
- 在 CHANGELOG 里写明“工具名迁移”；
- 如保留别名，只保留一个 minor 版本，并标 deprecated。

## 2.5 为什么这次不是珍珠链：BOM/ICD 是稳定主轴

珍珠链的失败点之一，是它在工具之外又造了一套生命周期和契约，却没有一个已经稳定的数据主轴。
这次不同：当前流程已经把 BOM/ICD 放在中心。

- **BOM**：`assembly/assembly.json` 的零件、版本、装配位姿、角色、制造策略；
- **ICD**：同一 manifest 里的接口、datum、公差、运动/强度声明；
- **证据图**：versions / runs / claims / delivery audit 都引用这套 BOM/ICD；
- **交付计划**：`deliver` 从 BOM/ICD/claims/run 图派生，而不是由 facade 发明流程。

facade 只回答“这个动作怎么调”，不回答“现在该走到哪一步”。生命周期和判据仍然来自
BOM/ICD、claims、policy 和 run 图。这是珍珠链没有的稳定主轴，也是本轮抽象更稳的原因。

但 BOM/ICD 不是免死金牌：

1. 单零件任务可以没有完整 BOM/ICD，facade 必须降级，而不是强制先写装配；
2. BOM/ICD 只提供数据，不替 facade 做执行/状态管理；
3. 如果 facade 自己新增 `CadStatus`、repair loop 或第二份契约，它仍然会珍珠化。

**红线**：每个 facade action 必须能指向一个 BOM/ICD 锚点或一个已有 run/evidence；
没有锚点的“便利状态”不进入 facade。

## 3. 候选方案

### 方案 A（推荐）：9 个作业面 facade

把现有 39 个 base 工具按“作业面”分组：

| facade | 覆盖的旧工具 | 说明 |
|---|---|---|
| `cad_session` | `project_info`、`init_project`、`bind_project`、`request_review` | 项目选择、人类审阅队列 |
| `cad_part` | `create_part`、`generate_part`、`import_part`、`merge_parts`、`set_part_role`、`attach_appearance` | 零件生成/导入/合并/角色/外观 |
| `cad_assembly` | `set_datums`、`write_assembly`、`validate_assembly`、`check_assembly` | 装配契约 |
| `cad_check` | `check_sheet2d`、`check_turning`、`check_cnc_access`、`check_edm_access`、`check_printability`、`check_parts`、`check_appearance` | 制造/工艺检查 |
| `cad_simulate` | `simulate_physics`、`simulate_motion`、`simulate_fluid`、`simulate_lbm`、`simulate_stress` | 物理/机构/流体/应力 |
| `cad_inspect` | `measure`、`list_features`、`scan_attention`、`analyze` | 数值与“看哪里” |
| `cad_see` | `render_part`、`review_visual`、`recall_reference_image` | 渲染、视觉审阅、参考图 |
| `cad_python` | `run_python`、`python_runtime` | 插件自带运行时 |
| `cad_deliver` | `delivery_audit`、`preflight`、`deliver`、`pearl_run` | 交付门 + 审计 |

合计 **9 个顶层工具**，覆盖 39 个旧工具，不新增能力、不删能力。

> `cad_job` 先不建：当前 N15 只有编译 job，没有独立的模型面作业工具。
> 如果以后需要 render/simulation 的异步 submit/cancel，再增加第 10 个。

### 方案 B（已否决）：数据域 4 工具 / 6 个 Blender 式通道

| 工具 | 内容 |
|---|---|
| `cad_session` | 项目 + 会话 + 审阅 |
| `cad_op` | 其余全部操作（part/assembly/check/simulate/inspect） |
| `cad_see` | 渲染/审阅/参考图 |
| `cad_python` | Python 运行时 |
| `cad_deliver` | 交付门 |
| `cad_job` | 预留异步作业 |

优点：工具数最少，最接近 Blender 插件。

缺点：

- `cad_op` 会变成 30+ op 的“上帝工具”；
- 建模/装配/检查/仿真四类输出的语义差异被压进一个 `ANY_SCHEMA` 风险；
- 模型需要更多 `op=catalog` / `op=help` 调用；
- 不利于按 preset 做“只给检查、不给建模”的裁剪。

**结论（2026-11-16）：保留 A 的 9 个作业面；不做数据域 4。**
`cad_inspect + cad_check + cad_simulate` 不再合并为 `cad_op`；9 已经是当前收益/风险拐点。

## 4. Facade 契约

### 4.1 通用参数

每个 facade 只暴露少量通用字段：

```ts
{
  action: string,       // 该 facade 的动作
  args?: json,          // 动作参数
  project?: string,     // 可选，显式项目路径
  versionId?: string,   // 可选，显式版本
  dryRun?: boolean
}
```

具体参数由 `args` 承载，dispatcher 在 host 侧按 `facade + action` 校验。

### 4.2 catalog / help

每个 facade 必须支持：

```text
action="catalog"   → 该 facade 的动作列表（名字、一句话、是否 gate、是否需要会话）
action="help"      → 单个动作的参数、输出、示例、常见错误
```

例：

```text
cad_check({ action: "catalog" })
cad_check({ action: "help", args: { op: "printability" } })
cad_check({ action: "printability", args: { versionId: "v003", profileIds: ["fdm-pla-0.4"] } })
```

`catalog` / `help` 不执行 CAD，不启动 OpenSCAD/Python。

### 4.3 输出契约

虽然顶层 `output` 可以是一个通用信封，但 dispatcher 必须在返回前按
`op` 校验真实输出：

```text
value
  → validateOutput(facade, op, value)
  → 失败：host 侧错误，而不是把坏形状发给模型
  → 成功：再包成统一信封
```

这样保留 `blender_op` 的“小 schema”，但不接受它的 `ANY_SCHEMA` 漏洞。

### 4.4 错误契约

沿用现有 `argError` 的字段：

```text
cad_check: args.versionId 缺失
accepts: a saved version id like "v003"
example: cad_check({ action:"printability", args:{ versionId:"v003" } })
received: {...}
```

并加：

- `did_you_mean`：未知 action/op 时给出最近的名字；
- `facade` / `action` 两级命名；
- 不再出现“没有这个工具”这种无法定位的错误。

## 5. Gate 与 evidence

### 5.1 保留顶层 gate

`cad_deliver` 是顶层工具，包含：

```text
delivery_audit
preflight
deliver
pearl_run（deprecated）
```

理由：

- 交付门必须在工具列表里可见；
- 不能靠模型记得调用一个普通 op；
- 审计/证据/风险确认需要独立回执。

### 5.2 不因压缩而降低证据强度

- `cad_check` / `cad_simulate` 仍然写原来的 run / report / evidence；
- `cad_deliver` 仍然读原来的 `auditDelivery` / `verify`；
- 所有 op 仍然绑定 version、run、policy，不引入“临时脚本结果”。
- `cad_python` 仍是分析运行时；不能用它替代 gate。

## 6. 兼容与迁移

### 6.1 命名迁移

旧工具名不再注册到模型面；更新：

- `skills/cad-toolbox/SKILL.md`
- `skills/cad-modeling-*/SKILL.md`
- `docs/TOOL-CONTRACTS.md`
- `docs/llm/*`
- 所有 `accept-*.mjs`
- `DESIGN.md` §25.7 / tool scope

建议在 CHANGELOG 写一张旧→新表。

### 6.2 tool-groups 的语义变化

当前 `tool-groups.ts` 按**工具名**分组；facade 之后一个工具会跨多个组，
不能再用“工具名”表达“只给检查、不给仿真”。

两个选项：

1. **先只按 facade 分组**：sacrifice 细粒度，保证行为简单；
2. **facade + action 二级 scope**：`cad_check` 的 action 允许列表由 host 控制。

建议第一版不做二级 scope；`toolScope` 继续只在“CAD 会话 / 非 CAD 会话”
之间切换。等 facade 稳定后再加 action scope。

### 6.3 迁移顺序

**Phase 0：基线与护栏（不改行为）**

- 写 `scripts/audit-tool-surface.mjs`：统计工具数、schema chars、tokens；
- 冻结 39→9 的映射表；
- 加 `accept-tool-surface.mjs`：数量、预算、旧工具全覆盖。

**Phase 1：dispatcher + `cad_inspect` 试点**

- 引入 facade 注册和 catalog/help；
- 先迁 `measure` / `list_features` / `scan_attention` / `analyze`；
- 不删旧工具，只在新 facade 内部调用旧实现；
- 对比输出、错误、token。

**Phase 2：`cad_check` + `cad_simulate`**

- 迁移 7 个 check + 5 个 simulate；
- 为每个 op 建参数/输出校验表；
- 用 `accept-tool-boundary` 的 fixture 覆盖代表性 op；
- 确认 gate/evidence 不变。

**Phase 3：`cad_part` + `cad_assembly` + `cad_session` + `cad_see`**

- 迁移状态转换和渲染；
- `review_visual` 仍写 visual-review 证据；
- 面板/HTTP 路由不动，只改模型工具入口。

**Phase 4（单独 PR）：`cad_deliver` + 删除旧工具**

- 迁移 4 个交付动作；
- 删除旧注册，更新 skill/docs/tests；
- 全量 `accept:preview` + CI。

### 6.4 过渡别名

如果担心外部用户/缓存 skill 断掉，可以保留一个 minor 版本的
**deprecated alias**，但 alias 只做转发、不出现在 catalog、不写进新 skill。
一个 minor 后删除。

## 7. 验收

新增：

- `accept-tool-surface.mjs`
  - 顶层工具数 = 9（或选定的目标）；
  - 每个 facade 有 `catalog` / `help`；
  - 39 个旧工具全部有映射；
  - 顶层 schema 字节数低于预算（建议 < 15 KB）。
- `accept-op-catalog.mjs`
  - catalog 列出的 op 与 dispatcher 支持的一致；
  - 未知 op 返回 `did_you_mean`；
  - help 的示例真的可运行；
  - 每个 op 的输出过自己的 schema。

回归：

- `accept-tool-boundary`：所有 op 的代表性调用；
- `accept-tool-contracts`：参数描述、输出 schema；
- `accept-tool-groups`：facade 分组完整；
- `accept-p0` / `accept-p1` / `accept-p3`；
- `accept:preview` 全量；
- `rehearse:preview`。

## 8. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 模型不会用 catalog | 选错 op / 多一次调用 | catalog 返回示例；skill 写“先 catalog/help”；错误给 did_you_mean |
| 输出契约退化 | evidence 形状变松 | dispatcher 按 op 校验，不用 ANY_SCHEMA |
| gate 被藏起来 | 交付门被跳过 | `cad_deliver` 保持顶层 |
| tool-scope 语义破坏 | 非 CAD 会话看到/看不到错误工具 | 第一版只按 facade 分组；后续再做 action scope |
| 迁移破坏测试/skill | CI 红、旧提示失效 | 分阶段、旧名映射、CHANGELOG |
| token 没降反升 | catalog/help 调用成本 | 先量 baseline，再决定 A/B；目标用 audit 脚本验证 |
| “上帝工具”难维护 | 一个 facade 太大 | 每个 facade 一个模块，dispatcher 只做路由/校验 |

## 9. 需要确认的决策

1. **目标形态**：已确认 A（9 个）；数据域 4 / 6 工具不做。
2. **gate 是否保持顶层**：是否同意 `cad_deliver` 单独存在？
3. **兼容策略**：0.1.0-preview 直接 breaking，还是保留一个 minor 的旧名 alias？
4. **`toolScope`**：第一版是否只按 facade 分组，不做 action 级 scope？
5. **`cad_python`**：是否默认暴露？是否只允许分析、不允许写 evidence？
6. **时间**：先做 Phase 0–1（可回退），还是一次做到 Phase 4？

## 10. 下一步

如果同意方案 A，第一步只做 Phase 0：

- 写 `audit-tool-surface.mjs`；
- 冻结 39→9 映射；
- 不改任何工具行为。

拿到真实 token baseline 后，再决定 Phase 1 是否值得继续。

---

**参考**

- [dsh-blender-plugin](https://github.com/sixtysevenlf/dsh-blender-plugin)
  - `docs/architecture.md`：6 tools / 34 families / 228 ops
  - `src/tools/op/index.ts`：`blender_op` 的通用 `action + op + args`
  - `runtime/catalog/data.ts`：catalog 数据表
