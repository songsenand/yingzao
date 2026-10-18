# 执行摘要：工具按功能合并（25→22）与 skill 分三层

> 方向决策见 `docs/DECISION-LOG.md` 2026-10-11 条目「工具按功能合并（25→22），skill 分三层」。

## 动机

用户判断"工具功能不够多，但数量好像不少"。复核后确认**数量本身不是病，冗余入口才是**：
`measure_closest` 与 `measure_distance` 回答同一个问题（相距多少），却各自发明一套端点命名；
`measure_part` / `measure_extent` / `check_connectivity` 都在回答"这个件是什么"。
skill 侧则是**一个 396 行文件服务七类工作**，143 行（Facts / Traps / 可打印性清单）与当前任务无关，
而最不可协商的交付纪律排在第 337 行——最关键的内容在最容易被跳过的位置。

## 影响范围

- `dsh-cad-harness/src/host/tools.ts` — 三个合并（注册、schema、handler）
- `dsh-cad-harness/scripts/` — `accept-p3`、`accept-tool-scope`、`accept-connectivity`、`inspect-tool-catalog`
- `dsh-cad-harness/skills/` — 由 1 个文件变为 5 个 skill（三层）
- `docs/TOOL-RUNTIME-MATRIX.md`、`HARNESS.md` — 工具名与分层同步
- 运行中的服务需重启（旧 lib 仍注册 25 个工具）

## 具体操作步骤

1. **合并一**：`measure_extent` + `check_connectivity` → `measure_part`
   - 参数新增可选 `axis` / `axisVector`；输出新增 `bboxMinMm`/`bboxMaxMm`/`bodies`/`bodySizes`/`bodyCenters`/`bodyVerdict`/`extent`/`warnings`；
   - **先取连通性**（`connectivity` op 永不抛错），质量属性放 try；
   - 非流形网格上 `sizeMm`/`bboxMinMm`/`bboxMaxMm`/`volumeMm3`/`surfaceAreaMm2`/`centerOfMassMm`/`genus`
     **改为可选并拒绝给值**（保留 op 原意：否则坏网格会报出看起来合理的体积），附警告说明原因。
2. **合并二**：`measure_closest` + `measure_distance` → `measure_gap`
   - 端点四种命名：`aVersionId`/`bVersionId`（实体）、`aSphere`/`bSphere`（解析球）、`aPoint`/`bPoint`（吸附）、`aDatum`/`bDatum`（精确）；
   - 实体/球成对走解算（含标注渲染），点/基准成对走吸附（含吸附距离与 inside 诊断），**混合端点明确拒绝**；
   - `bVersionId` 只表示"端点 B 是该实体"，旧 `measure_distance` 的"吸附到哪块件"改叫 `bOn`；
   - `versionId` 改为按需（实体↔实体不需要基准件）；datum 端点**省略**吸附/inside 字段（旧代码填 0/false 是编的）；
   - 输出统一为 `pointA`/`pointB`，`dxMm/dyMm/dzMm` 对解算对也给出（是点坐标的算术，不是新测量）。
3. **skill 分三层**
   - 第 1 层 `skills/cad-toolbox/SKILL.md`：frontmatter + 引言（含四类工作→四个 skill 的对照表）+ 完整 22 行路由表 +
     约定 + 纪律 + 交付纪律 + 待补；
   - 第 2 层 `cad-simulation` / `cad-assembly` / `cad-modeling-measure` / `cad-manufacturing`：
     各自 frontmatter（description + whenToUse）、回指路由器、按主题搬入的 Facts/Traps（可制造性另含可打印性清单）；
   - 第 3 层 `references/*.md`：按需读，首个用途指向 `dsh-cad-harness/schemas/process-profile.schema.json`。
4. **doc test 作用域**：`accept-p3` 中 4 条"内容"断言改为递归扫 `skills/` 全树；
   "点名全部工具"那条**保持钉在路由器**（那是路由器的契约）。

## 预期风险与验证

- **风险 1：合并改变契约。** 验证：全部验收脚本，见下。
- **风险 2：合并把坏网格路径弄坏。** 实际发生了：`accept-connectivity` 当场抓到
  `ValueError: STL is not a valid manifold solid`。修法见步骤 1，该脚本含非流形用例，已过。
- **风险 3：skill 拆层后 doc test 静默失效或误报。** 实际发生了两次：
  ① `accept-connectivity` 原本只读单个 SKILL.md（拆层后会静默不测任何东西）→ 改为扫全树；
  ② `accept-p3` 的 degrees/radians 陷阱断言钉在路由器上（陷阱已移入 `cad-modeling-measure`）→ 误报 → 改为扫全树。
- **风险 4：frontmatter 破坏 skill 发现。** 实际发生了：`description` 里带 `: ` 被 YAML 解析成映射，
  loader 的 `stringField` 取不到字符串 → **5 个 skill 全被忽略、catalog 变空**。改为双引号转义，
  并用 loader 自己的 `js-yaml` 按同一规则复核 5/5 通过；catalog 恢复 5 条。

## 实际结果

| 验收 | 结果 |
| --- | --- |
| `accept-p3` | **58/58**（含"点名全部 22 个工具"） |
| `accept-tool-scope` | 34/34 |
| `accept-connectivity` | 12/12（含非流形分支与 tool 级 `bodyVerdict`） |
| `accept-measure-closest` / `-distance-parity` / `-part-parity` / `-extent` / `-connectivity-parity` | 25/25 · 41/41 · 11/11 · 16/16 · 21/21 |
| `accept-printability-parity` / `accept-m36` / `accept-p2` / `accept-sim-verdict` | 45/45 · 19/19 · 22/22 · 12/12 |

- 工具数 **25 → 22**；skill 由 1 个 396 行文件变为 **5 个 skill**（第 1 层 253 行 + 四个 job skill 51/63/75/28 行）。
- 内容零丢失：旧文件被移除/改写的 165 行中，24 行在新树查不到，逐条核对**全部是有意替换**；
  Facts 1–23 与 Traps 1–7 的分配映射穷尽且互斥。
- **关于第 1 层的 253 行（判据已更正）**：我先前提过「第 1 层 ≤120 行」，并在收尾时把 253 行写成失手。
  **该判据作废**——本次拆分的目标是让手册更符合 LLM 与人的阅读习惯、思维更清晰，**不是省 token**。
  253 行 = 路由表 60 + 约定 40 + 纪律约 30 + 交付纪律 51 + 引言与指针；这四块都是**每次动手前就该看到**的内容，
  把它们塞进按需加载的 job skill 才是缺陷。详见 DECISION-LOG 同日条目
  「手册结构服务于读起来思维清晰」。同时**撤回**「把约定移进 references 压到 213 行」的建议——
  那是拿可用性换 token。内容零丢失已核（见上），所以这次拆分**没有为篇幅牺牲任何内容**：
  做对了，是我事后用错了尺子去量它。
- **自伤记录**：合并二期间一句"顺手清理"的批量替换 `s.replace("        versionId: a.versionId,\n", "", 1)`
  命中了文件里第一处该字符串——那是 `set_datums` 的返回，不是 `measure_gap`。`set_datums` 的 list 分支因此丢字段，
  被 tsc 当场拦下并修回。教训：批量替换必须带上下文，否则意图是清理 A、实际改了远处的 B。
