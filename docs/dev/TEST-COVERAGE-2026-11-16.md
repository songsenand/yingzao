# 工具单元测试覆盖率：实测报告（2026-11-16）

> **范围**：`dsh-cad-harness/` — 43 个注册工具、163 个 `accept-*.mjs`（新增 `accept-tool-boundary`）。
> **基线**：改进前的套件数字取 `de65c97`；改进后的数字取当前树（含 `9fffec2`，该提交删除了
> `physics.ts` 的 TS 引擎，`tools.ts` 与本文引用的工具模块未变）。工作树新增
> `scripts/coverage-tools.mjs`（测量工具）、`scripts/accept-tool-boundary.mjs`（边界验收），
> 并修复了它抓到的两个 bug（§7.2）。
> **证据等级**：`[实测]` 本次跑出的数字，可用文末命令复现；`[静态]` 读文件可核；`[未测]`。
> **口径**：覆盖率是 V8 的行/函数覆盖（TypeScript 按 Node 的类型擦除原地对齐，字节偏移与源码一致）；
> 「工具边界」指调用注册后的 `tool.execute(...)`，与「实现层单测」区分。

---

## 0. 三句话

1. **实现层覆盖不低**：`src/` 行覆盖 **82.1%**（34430/41960），函数覆盖 81.4%。几何、测量、
   转轴、CNC/EDM 等实现模块普遍 92–100%。
2. **工具边界是原来的短板**：改进前 43 个工具里只有 **18 个**被任何验收脚本真正执行过（41.9%）；
   162 个脚本里只有 **17 个**碰过工具边界（10.5%）。新增 `accept-tool-boundary.mjs` 后为
   **28/43（65.1%）**——本机 Python 运行时不可用，14 行按名 SKIP；有运行时的机器上预计 **42/43**
   （只剩 `simulate_fluid` 未入表）。`tools.ts` 行覆盖 61.1% → **65.0%**，函数 42.7% → **49.3%**。
3. **缺口集中在两处**：改进前 25 个从未执行的工具 handler（其中 7 个连实现层也弱），以及
   `deliver-plan.ts`（12.5% → 45.2%）、`appearance.ts`（38.3% → 80.8%）、`stress.ts`（49.5%）、
   `fluid.ts`（64.8%）。

这与 2026-10-23 审计的教训是同一类：验收脚本直接调 `def.execute()` 或实现函数，
**工具自身的参数默认值、argError 文案、输出契约**没有经过真实调用——
当时四个工具的 `output.schema` 与实现不一致，全套验收仍是绿的（`docs/AUDIT-2026-10-23.md` A1）。

> **已经动手（见 §7）**：新增表驱动的 `scripts/accept-tool-boundary.mjs`（43 个工具的 schema 半 +
> 逐工具 fixture 半），并已并入 `npm run accept`。它在第一次运行里抓到两个真 bug（`check_sheet2d`
> 输出契约、`check_appearance` 空轮廓行崩溃），都已修复。

---

## 1. 怎么测的 `[实测]`

```bash
cd dsh-cad-harness
node scripts/coverage-tools.mjs --json coverage.json
```

脚本做三件事：

1. 每个测试进程用 `--import` 预加载一个解析钩子，把 `@deepseek-ai/dsh-tools` 重定向到 shim；
   shim 的 `defineTool` 包一层 `execute`，把 `{tool, ok, test}` 追加到 JSONL；
2. 测试进程带 `NODE_V8_COVERAGE` 运行，收集 V8 覆盖；
3. 汇总两者：哪些工具被调用、成功/失败次数、`src/` 各文件行/函数覆盖率。

本次运行环境说明（影响下面「红」的归因）：

- 沙箱只允许写工作区，因此 `DSH_HOME` 指到 `dsh-cad-harness/.tmp-dsh`，Python 运行时
  （3.1 GB，位于 `~/.dsh/cad/runtime`）以符号链接复用，只把 `runtime/tmp` 换成可写目录。
- 7 个脚本在临时 `DSH_HOME` 里没有 Python 运行时，直接失败（不是覆盖缺口）。
- 3 个导入脚本在临时 home 里现场 pip 安装依赖，120 s 内跑不完（`import`、`import-cad`、`import-3mf`）。
- `accept-ui` 需要浏览器/WebGL 画面，超时。

---

## 2. 套件结果 `[实测]`

| 指标 | 数字 |
|---|---|
| `accept-*.mjs` | 162 |
| 绿灯 | 147（其中 8 个在修正可写 `runtime/tmp` 后重跑转绿） |
| 红 | 11 |
| 超时 | 4 |
| PASS 断言 | 2583 |
| FAIL 断言 | 7 |

红的 15 个脚本归因：

| 类别 | 脚本 | 与覆盖率的关系 |
|---|---|---|
| 临时 `DSH_HOME` 无 Python 运行时 | connectivity, motion-pivot, p0, p1, p2, p3, sim-verdict | 环境，非缺口 |
| 现场 provisioning 超时 | import, import-cad, import-3mf | 环境，非缺口 |
| 需要浏览器 | ui | 未测 |
| 当前树上独立存在的红 | attention-source（2 断言）、image-budget（2）、tool-scope（1）、python（1） | 与本测量无关；无插桩时同样失败（attention-source / image-budget / tool-scope 已复核） |

---

## 3. 工具边界：改进前 18/43 `[实测]`（基线）

被真正执行过的 18 个工具（71 次调用；17 个有成功路径，9 个有错误路径，8 个两者都有）：

| 工具 | 调用 | ok / fail | 触及它的脚本 |
|---|---|---|---|
| bind_project | 4 | 4 / 0 | check-parts, part-role, set-datums-versioned |
| check_parts | 8 | 6 / 2 | check-parts |
| check_printability | 1 | 1 / 0 | check-parts |
| create_part | 2 | 2 / 0 | tool-contracts, tool-output |
| generate_part | 5 | 3 / 2 | check-parts, generate-screen, p3 |
| import_part | 4 | 3 / 1 | import |
| init_project | 5 | 5 / 0 | check-parts, generate-screen, tool-contracts, tool-output |
| measure_part | 2 | 0 / 2 | connectivity |
| project_info | 5 | 5 / 0 | check-parts |
| python_runtime | 1 | 1 / 0 | python |
| recall_reference_image | 7 | 4 / 3 | recall |
| review_visual | 2 | 1 / 1 | check-parts |
| run_python | 1 | 1 / 0 | python |
| set_datums | 9 | 7 / 2 | set-datums-validation, set-datums-versioned |
| set_part_role | 4 | 2 / 2 | part-role |
| simulate_lbm | 1 | 1 / 0 | lbm-channel |
| simulate_motion | 8 | 2 / 6 | motion-nodrive, motion-pivot, sim-verdict |
| simulate_physics | 2 | 2 / 0 | physics-sanity |

其中 `measure_part`、`simulate_motion` 的 fail 含「Python 未就绪」的环境错误，
真正的参数/前提错误来自 `import_part`、`recall_reference_image`、`review_visual`、
`set_datums`、`set_part_role`、`check_parts`。

**从未经注册工具执行过的 25 个**：

```
analyze, attach_appearance, check_appearance, check_assembly, check_cnc_access,
check_edm_access, check_sheet2d, check_turning, deliver, delivery_audit,
list_features, measure_angle, measure_gap, measure_section, measure_thickness,
merge_parts, pearl_run, preflight, render_part, request_review, scan_attention,
simulate_fluid, simulate_stress, validate_assembly, write_assembly
```

这 25 个不是都「没测」。按实现模块的覆盖率分两档：

| 档 | 工具 | 实现模块行覆盖 | 含义 |
|---|---|---|---|
| A：实现层测过，边界没测 | check_assembly, check_cnc_access, check_edm_access, check_sheet2d, check_turning, delivery_audit, measure_angle/gap/section/thickness, merge_parts, preflight, scan_attention, render_part, list_features, request_review, validate_assembly, analyze, write_assembly, pearl_run | 83–100% | 逻辑有单测；但工具的参数校验、默认值、输出契约、错误文案没有真实调用过 |
| B：两层都弱 | deliver, attach_appearance, check_appearance, simulate_stress, simulate_fluid | 12.5–64.8% | 优先补 |

`python_runtime` / `run_python` 虽在 18 个之内，其实现层 `python-tools.ts` 函数覆盖只有 29%——
只走到了 status 与一次执行，安装/overlay 等分支没经过工具面。

---

## 4. 模块覆盖率：整体 82.1%，尾部很尖 `[实测]`

`src/` 合计：行 **82.1%**（34430/41960）、函数 **81.4%**（1760/2161）。

工具实现模块：

| 模块 | 行覆盖 | 函数覆盖 | 说明 |
|---|---|---|---|
| `src/host/tools.ts` | 61.1% | 42.7% | 41 个工具的定义都在这里；未执行的 handler 是主要缺口 |
| `src/host/python-tools.ts` | 76.5% | 29.0% | 只测了 status / 一次 run |
| `src/host/deliver-plan.ts` | **12.5%** | 8.3% | `deliver` 工具的全部规划逻辑，基本没测 |
| `src/host/appearance.ts` | **38.3%** | 12.5% | `attach_appearance` / `check_appearance` |
| `src/host/stress.ts` | **49.5%** | 11.1% | `simulate_stress`；求解器有测试，交付/注意力分支薄 |
| `src/host/fluid.ts` | **64.8%** | 83.3% | `simulate_fluid` 未从工具面调用 |
| `src/host/assembly-render.ts` | 58.6% | 20.0% | 装配视图渲染 |
| `src/client/run-chart.ts` | 43.0% | 59.1% | 浏览器侧，非本套件目标 |
| `src/client/heat.ts` | 48.9% | 44.4% | 同上 |
| `src/host/assembly.ts` | 98.1% | 90.0% | 对照：实现层充分 |
| `src/host/assembly-check.ts` | 92.7% | 96.0% | 对照 |
| `src/host/measure.ts` | 100% | 100% | 对照 |
| `src/host/turning.ts` | 100% | 100% | 对照 |
| `src/host/cnc-access.ts` | 100% | 100% | 对照 |
| `src/host/inspect.ts` | 99.2% | 98.5% | 对照 |
| `src/host/delivery-audit.ts` | 95.5% | 96.8% | 对照 |
| `src/host/preflight.ts` | 97.7% | 90.0% | 对照 |

> **加入 `accept-tool-boundary` 后（同一台机器、provision 后实测；`tools.ts`/`deliver-plan.ts`/
> `appearance.ts`/`stress.ts`/`fluid.ts` 自 `de65c97` 起未改，数字可直接比较；`src/` 的合计是
> 合并口径的近似，因为 `physics.ts` 在测量窗口内被 `9fffec2` 删除）**：`src/` 87.9% 行；
> `tools.ts` 80.1% / 58.0%；`deliver-plan.ts` 47.4% / 45.5%；`appearance.ts` 80.8% / 70.0%；
> `stress.ts` 78.3% / 60.0%；`fluid.ts` 64.8% / 83.3%。上表是改进前的基线，保留用于对照。

---

## 5. 建议与状态

1. **补一个表驱动的工具边界验收** —— **已完成**，见 §7。边界覆盖 18/43 → **43/43**。
2. **补 B 档实现层** —— 进行中：`appearance.ts` 38.3% → **80.8%**（`attach_appearance` 现在有真实调用与 GLB 校验），
   `stress.ts` 49.5% → **78.3%**（`simulate_stress` 有了带支撑的边界用例），`deliver-plan.ts` 12.5% → **47.4%**
   （`deliver` 的边界已通，但规划分支仍只走到主路径）。`fluid.ts` 仍为 64.8%——`simulate_fluid` 只走了一次
   30 步的短管，湍流/帧输出等分支没有覆盖。
3. **把 `tools.ts` 的函数覆盖率作为可见指标** —— 现在 **58.0%**（改进前 42.7%）。它比行覆盖率更能说明
   「还有哪些 handler 的分支从没跑过」。
4. **CI 里先不设阈值，先存报告** —— `node scripts/coverage-tools.mjs --json coverage.json`
   作为非阻断报告，看清趋势后再决定阈值；`accept-tool-boundary.mjs` 已并入 `npm run accept`。

**不建议**把 82.1% 的行覆盖当作「工具测得好」的证据：行覆盖主要来自实现模块，
而模型真正调用的是工具壳；两者的差距就是 2026-10-23 那类输出契约 bug 的生存空间。

---

## 6. 复现

```bash
cd dsh-cad-harness

# 工具边界验收（约 10 秒；无 Python 运行时也绿，相关行按名 SKIP）
npm run accept:boundary

# 全量覆盖率（约 15–20 分钟；需要本机 Python 运行时与 OpenSCAD）
node scripts/coverage-tools.mjs --json coverage.json

# 子集（快速看工具边界）
node scripts/coverage-tools.mjs --tests tool-,measure --json coverage.json

# 复用上一次的工作目录（脚本会打印路径）
node scripts/coverage-tools.mjs --reuse /tmp/cad-coverage-xxxx --json coverage.json
```

`coverage.json` 含：`tests.rows`（每个脚本的状态/断言数）、`tools.rows`（每个工具的调用与错误）、
`src.modules`（每个源文件的行/函数覆盖）。

`accept:boundary` 自己会设 `DSH_HOME` 到一个临时目录（夹具是新建项目，不碰真实语料）；
需要 Python 的行读取 `DSH_CAD_PYTHON_ROOT`（缺省 `$DSH_HOME/cad/runtime`），也可显式指向一个
已 provision 的运行时：`DSH_CAD_PYTHON_ROOT=~/.dsh/cad/runtime npm run accept:boundary`。

---

## 7. 已落地的改进（2026-11-16）

### 7.1 `scripts/accept-tool-boundary.mjs`（并入 `npm run accept`）

两半，都是对**注册后的工具**做真实调用：

- **schema 半（43 个，由注册表生成，不是手写清单）**：每个工具有必填字段时，空调用必须在一封回复里
  点名全部缺失字段；没有必填字段的工具只断言它声明了对象输出 schema——**不调用**，因为
  `simulate_lbm({})` 是合法调用，会真的开跑（第一版就被它挂住）。
- **fixture 半（24 行）**：在临时项目里用工具建两个零件 + 装配清单 + 一个最小 GLB，然后逐工具传
  **合法参数**调用一次并断言返回值的形状：`measure_*`、`list_features`、`scan_attention`、`analyze`、
  `check_printability`、`check_cnc/edm/turning/sheet2d`、`merge_parts`、`validate_assembly`、
  `check_assembly`、`check_appearance`、`deliver`、`delivery_audit`、`preflight`、`request_review`、
  `render_part`、`attach_appearance`、`simulate_stress`、`simulate_fluid`、`pearl_run`。
  需要 Python 的行在运行时不可用（或 `state != ready`）时**按名 SKIP**，绝不记成通过。

结果（本机 provision 后实测）：**72 条 PASS、0 FAIL、0 SKIP**；工具边界 **43/43**，109 次调用；
`src/` 行覆盖 **87.9%**（36149/41107），`tools.ts` **80.1% 行 / 58.0% 函数**。
同一套件在 Python 不可用时仍是绿的，但会显示 14 个 SKIP——本报告 §3 的 28/43 就是那次的结果。

### 7.2 它抓到的两个真 bug（已修）

1. **`check_sheet2d` 对没有圆孔的截面直接失败**（`src/host/sheet2d.ts`）。`metricsBase` 预置了
   `minHoleEffectiveMm: undefined` 等三个键；输出契约的 `lossless JSON` 检查把「键存在、值为
   undefined」判成非法，于是**每一次没有圆孔的 2D 筛查都报 "the body's value does not match its
   declared output schema"**，而模块级测试（`accept-sheet2d`）直接调 `analyzeSheet2d`，看不到这层。
   修法：只在实际测得时把字段放进对象。证伪：修复前合成 section 的 schema 校验有 1 条违规
   （`"value.metrics" must be a lossless JSON object`），修复后 0 条。
2. **`check_appearance` 在零件之间有竖直空隙时崩溃**（`python/cad_worker/worker.py`）。轮廓投影按行
   扫描，遇到两个零件之间的空行时对空数组取 `max()`，抛
   `ValueError: zero-size array to reduction operation maximum which has no identity`，整次调用失败。
   修法：空行宽度记 0（那正是真实轮廓：该高度没有材料）。证伪：修复前直接调
   `op_check_appearance`（两个相隔 30 mm 的立方体）抛同样的 ValueError；修复后返回
   `visibleSharpMm=310`、2 个 silhouette 条目；`accept-tool-boundary` 的该行现在会守住它。

### 7.3 本报告的一处更正

§6 原先写「脚本直接调 `execute`，绕过 runtime 的 `validateArgs`」——**不准确**：
`defineTool.execute` 自己会做入参 schema 校验。直接调 `execute` 缺的是 `ToolRuntime` 的超时/取消与
成功结果封装；输出契约已由 `withOutputContract` 在注册层补上。真正的缺口是**合法入参下的 handler 行为**，
即 §7.1 的 fixture 半。

**未测**：浏览器/WebGL 画面、真机 OpenSCAD 之外的内核、Windows/macOS 专属路径；
Python 子进程内部的覆盖（worker 是独立解释器，V8 看不到）；`ToolRuntime` 的超时/取消与成功结果封装
（脚本直接调 `execute`，经过的是 `defineTool` 的入参校验与 `withOutputContract` 的输出校验）。

---

## 9. 测试补强（2026-11-17 凌晨）

在 9-surface 架构上又补了一轮，`3209546` + 工作树改动之后的全量复测：

| 指标 | 现在 | 上一轮（§8） |
|---|---|---|
| accept 脚本 | 170：**166 绿 / 2 红 / 2 超时** | 154 绿 / 12 红 / 4 超时 |
| PASS 断言 | **2994** | 2774 |
| `src/` 行覆盖 | **88.3%**（36790/41667） | 86.9% |
| `src/` 函数覆盖 | **82.7%**（1933/2338） | 81.7% |
| 工具边界（套件内） | 37/39 | 36/39 |
| 边界验收（单独跑） | 39/39 工具 + 9 surface/39 op，177 PASS | 150 PASS |

### 9.1 抓到一个真 bug：`evidence.runId` 被静默丢弃

`check_assembly` 的生产路径是「宿主映射 → Python worker」，而宿主映射逐字段重建 interface 时**没有带 `evidence`**；worker 也只读 `params.runId`。结果：按文档用 `evidence: {runId}` 引用一个**不存在的 run**，返回 `pass`，而不是 hard-violation——正是 `accept-p2` 的 (b2) 断言抓到的。

修法两处：`assembly-check.ts` 的映射转发 `evidence`；`worker.py` 按 `evidence.runId` → `params.runId` 的优先级读取（与宿主 `citedRunId()` 一致）。证伪：修复前该断言 `P2 ACCEPTANCE FAILED (1)`，修复后 `P2 ACCEPTANCE PASSED`，且 `evidence.runId r006` 与 legacy `params.runId` 两条路径都通过。

### 9.2 按「agent 实际调用面」补的测试

- **surface 端到端**：fixture 里的每一行工具调用，现在再经 `cad_*.action` 走一遍，断言“同形状 + 该行语义断言仍成立”（不比字节相等：多数工具每次调用会写 run，`runId`/耗时会变）。surface 半原有的 27 个必填 op 的“空参委派到旧校验器”仍在。
- **surface 错误面**：未知 `action`、`help` 的未知 `op` 必须列出**全部**可接受值（由 `catalog` 生成，不写死），这是 agent 最常犯的错。
- `accept-skill-tools` 改为**注册表驱动**：39 op、每个 op 必须声明 `surface`（否则模型不可达）、9 个 surface 必须出现在技能里、契约表与注册表集合一致；`measure_part.axis` 等旧断言换成 `measure.axis/axisVector/aDatum/bOn`。
- `accept-p3` 的“每个工具都被手册点名”改为“每个 surface 被点名，且每个工具都有 surface”，交付纪律节按 `cad_check` 措辞校验。
- `accept-project-scope` 现在同时识别 `async execute(args, exec)` 与箭头式 `execute: async (a, exec)`（measure 合并后的写法），不再把真实签名误判为“没接 exec”。

### 9.3 测试基础设施

- 约 25 个脚本（parity / measure / physics / analyze-control…）的运行时默认值改为**尊重 `DSH_CAD_PYTHON_ROOT`**：有该环境变量时不再依赖仓库里的 `.tmp-*-runtime` 目录。此前这些测试会在全量跑里因为 `.tmp` 目录不存在而整片变红（§8 的 12 红里大半是它）。
- `accept-python-failure` 显式清掉继承来的 runtime override（它要断言 `DSH_HOME` 布局），跑完恢复。
- `accept-check-parts`、`accept-analyze` 的 Python 入口同样改为 env 优先。

### 9.4 仍未绿（4 个，均与本次改动无关）

| 脚本 | 原因 |
|---|---|
| `accept-attention-source` | 既有 2 条断言（面板 run 归属），与工具面无关 |
| `accept-python` | 在临时 home 里现场 provisioning，150 s 不够（环境） |
| `accept-tool-scope` | 既有 skill-root 路径断言（环境） |
| `accept-ui` | 需要浏览器/WebGL（未测） |

`tools.ts` 的边界在套件内是 37/39：差的 `python_runtime` / `run_python` 正是 `accept-python` 超时未跑的那两个；边界验收单独跑仍是 39/39。

### 9.5 顺手发现、未改的一处测试卫生问题

`accept-assembly.mjs` 直接 `openVersionStore(<plugin>/data)`，每跑一次就往仓库的 `data/` 里写新版本（本轮把 `assembly.good.json` 的 v111 改成 v141）。本轮已把 `data/` 回滚；建议后续让它用临时 `DSH_HOME`，和其余测试一样不碰仓库夹具。
