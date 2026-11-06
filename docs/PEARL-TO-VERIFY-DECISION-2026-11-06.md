# 珍珠链降级与 V1 证据验证决策报告（2026-11-06）

> **状态**：决策记录，不是发布说明；本报告先于代码变更。
> **决策**：采用 D 方案——**不回撤** `38b2d45`，在已有基础上做“降级提交”；只做 **V1 证据验证**，V2/V3/V4 暂缓，V5 不做。
> **关联**：`docs/DECISION-LOG.md` 2026-11-06；`dsh-cad-harness/docs/PEARL-PLAN.md`（历史）；`dsh-cad-harness/docs/PEARL-REPORT-2026-11-05.md`（历史）。

---

## 1. 摘要

**原意**：一个珍珠 = 一个更高阶、可插拔、可注册的 agent 工具；简单任务跑完默认珍珠串就结束；复杂任务可对珍珠内部做一定程度的重组；所有注意力引导用热力图驱动，失败和 block 都在热力图上，agent 可选择热力图或文本。

**实际**：珍珠层变成了第二套 workflow 框架 + 配置 + 第二契约 + 账本；38 个工具一个没少；模型可见概念增加；执行层半接线；人类面板零珍珠引用。

**结论**：

- 工具表面按**输出语义**（交付/检测/仿真/仪器）分组；
- 六问降为**覆盖报告**，不再作为工具分类；
- **只做 V1**：只读证据验证（CLI + 报告 + 退出码），不跑 CAD、不写 run、不判设计；
- **不回撤**混合大提交，前向降级；执行器/契约/模板/repair 先降级、V1 绿后再删；
- **无 owner 角色**：政策是用户的声明；无政策 → advisory。

**一句话**：我们把一张检查表做成了生产线，还顺手把裁判席搬了过来；V1 把它改回检查表。

---

## 2. 背景与时间线

- 2026-11-03 至 11-05：珍珠层 M1–M16 快速落地，最终提交 `38b2d45`（2026-11-05 20:08 +0800）。
- `38b2d45` 是**混合大提交**：167 个文件、48,149 行新增；`main` 比 `origin/main` 领先 14 个提交，尚未 push。
- 提交内包含三类东西：
  1. **珍珠框架**：`src/host/pearls/` 21 个文件、`pearls/` 清单与 11 个模板、profile/template/contract/repair/probe、珍珠验收脚本、珍珠文档；
  2. **可复用基础设施**：`write-assembly.ts`、`checkers/` 协议、`delivery-audit` 持久化、5 个 schema、rulepacks、`examples/eight-immortals-table/`、motion fixture；
  3. **文档/工具面**：skill 的 Pearl workflow 小节、`pearl_run` 工具、`preflight` 的 pearl gate、DESIGN §35、TOOL-CONTRACTS、DECISION-LOG。

**三示例现状**（只读账本实跑）：

| 示例 | overall | 关键证据 |
|---|---|---|
| windup-frog | warn | fit pass（9 未声明接触）；make/review/deliver warn |
| roberval-balance | fail | 9 个打印件缺 visual review；deliver fail |
| eight-immortals-table | blocked | fit blocked（0 接口）；3 个未登记 STL；deliver fail |

---

## 3. 诊断：哪里偏了

### 3.1 表面没有减少

| 判据 | 期望 | 现状 |
|---|---|---|
| 入口更少 | 模型选择变少 | 38 个工具一个没少，另加 profile/template/rulepack/probe/contract 与双态 `pearl_run` |
| 概念更少 | 六问替代三组 | 两套分类法并存：工具三组 + 六珍珠；`deliver` 既是组名又是珍珠名 |
| 可发现 | 能查到六问/模板/规则包 | 没有 catalog 工具；skill 的 profile 示例缺 `schemaVersion/id/version`，照抄会被 loader 拒绝 |
| 可强制 | 珍珠是必经之路 | 没有 `pearl-profile.json` 时 `preflight` 把 pearl 放进 `notCovered`，不影响 verdict |
| 可闭合 | 六问闭环 | repair loop/项链契约/motion 证据/语义失败都只接了一半 |

### 3.2 成本账

- 珍珠层：**21 个文件、2,343 行、52 个导出类型**。
- 模板/清单：**690 行 JSON**；schema：**约 480 行**。
- 文档：PEARL-PLAN 981 行 + PEARL-REPORT 340 行 + `docs/llm/pearls.md` 134 行 + DESIGN §35 83 行 + DECISION-LOG 11-04/05 152 行 ≈ **1,690 行**；而描述 38 个工具的 skill 共 314 行。
- 状态词汇：至少 **6 套**——`PearlStatus`、`ExecutionStatus`、`RepairAction`、`Judgement`、`CheckerStatus`、`RunStatus`，外加工具 `verdict`/`overallStatus`。
- `pearl_run` 是 38 个工具里**唯一没有 `returns:` 契约**的；gate 输出约 **31KB**（紧凑 JSON）。

### 3.3 两套分类法

- 输出语义（交付/检测/仿真/仪器）回答“这个输出允许说什么”，映射到权限：交付可 block、检测永不 block、仿真只产证据、仪器只给真值。
- 六问（brief/model/fit/make/review/deliver）回答“我在哪个阶段/还缺什么”，是生命周期/覆盖问题。
- 两者正交，却都被当成工具表面。结果：同一工具服务多颗珍珠，`check_assembly` 同时出现在 model/fit（以及 preflight 的交付序列）里；`deliver` 名字冲突。

### 3.4 半接线

- `runTemplateRepairLoop` 只被验收脚本调用，`pearl_run`/`preflight` 都不调用。
- `writeNecklaceContract` 只在 CLI/验收写；宿主只在内存构建，从不写、从不查 stale；三示例都没有 `necklace-contract.json`。
- `pearl_run({execute:true})` 没有工具级验收；`accept-execute-template` 用的是 fake dispatcher。
- 人类面板零珍珠引用（`grep -n pearl src/client` 为空）；六列账本只存在于工具 JSON。

### 3.5 证据问题（r073）

- 报告/fixture/commit/DECISION-LOG 均称 `fit.mechanism` 实测：`r073：49 checks / 46 events，首个 cam↔slider 0.145mm³ @0.042s`。
- 同一提交的 DESIGN §35.6 却写“`fit.mechanism` 的 motion 输入尚未实测”。
- windup-frog 语料的最后一条 run 是 **r069（2026-11-02）**，不存在 r073；最接近的 r028 是 `49 checks / 46 events`，但首对是 `base↔slider 0.03mm³`；r065 是 `cam↔slider 22.099mm³`、25 events；全仓扫描没有任何 `0.145mm³` 事件。
- 结论：该验收主张无法用仓库内证据复核；`cad-data/` 被 gitignore，run 证据不在版本库里。这违反 HARNESS §11.9（就绪必须可证伪）。

### 3.6 语义问题

- `explained-undeclared` 是 `info` finding，但 `failureFor` 把 `info` 映射成 `hard`；实测 `observeFit` 返回 `explained-undeclared:hard`，下游会让 `pass` 变成 `repair-needed`/`difficult`。
- `semanticFailure` 只认 `judgement` 字符串和 `overallStatus=fail`；`check_printability` 返回 `verdict: 'excluded'`，`semanticAttention` 对 `check_appearance` 的对象型 `judgement` 无效。实测：`semanticFailure({verdict:'excluded'}) → undefined`。

### 3.7 场地原则违反

| 场地该做的 | 珍珠层实际做的 | 违反点 |
|---|---|---|
| 提供能力/执行/地图 | 提供能力 + 一套 workflow DSL | runtime 越权做了 skill/用户的“路线决定” |
| 质检**交付物** | 项链契约、六套状态词、repair loop | 从“质检”滑到“裁决/第二真相” |
| 让人/agent 自己决定做什么 | profile/template/budget/probe 规定怎么做 | 替用户生产 |
| 三通/示例/原材料 | 2,343 行框架 + 1,690 行文档 | 产品表面，不是场地条件 |
| 度量场地可用性 | 验收数 contract/dispatch/probe | 度量对象错了 |
| 缺口明说、给替代路径 | P1 清单当产品债追 | 把场地条件当产品缺陷 |

**六条场地测试**（后续变更评审用）：

1. **减法**：删掉它，agent 是失去能力，还是只失去便利？
2. **零读**：新会话能否不读源码/文档、一次调用回答它要回答的问题？
3. **规定 vs 条件**：它规定“怎么做”，还是提供“能做什么”的条件？
4. **权威**：它拥有一个事实，还是指向一个已有事实？
5. **判断**：它 block 的是证据缺失，还是设计意图？
6. **忽略**：agent 忽略它，场地还能正常用吗？

---

## 4. 共识 C1–C9 与三个正交轴

| # | 共识 |
|---|---|
| C1 | 工具会继续增长，但“新增能力 = 新增顶层工具”不是默认；先参数/模式/检查，后新工具 |
| C2 | 编组目标是减少默认决策、消除重叠与歧义，不是把工具贴成一张表 |
| C3 | 分层 = 默认（聚合）→ 下钻（单珍珠/单域）→ 逃生（原子工具，由失败点名）；三层共享证据 |
| C4 | 聚焦 = 可行动（verdict + top witness + why + next），不是更短；其余是稳定指针 |
| C5 | 聚焦不能隐藏 `unobserved`/`stale`/`blocked`；缺失必须与通过同屏可见 |
| C6 | 所有珍珠/检查共享一个报告契约、一个状态推导；不再新增第二套状态词 |
| C7 | 注意力是**一份数据两种渲染**：agent 默认文本/JSON，用户网格/热力图；同版本、同 run、同 id |
| C8 | 非空间失败上状态网格，不伪造坐标；空层不显示绿色；热力图只是空间视图 |
| C9 | “减轻负担”必须可度量：新会话问“fit 缺什么”= 1 次调用 + 0 次源码阅读；schema token 不增；珍珠文档 = 1 页；面板与工具同源同值 |

**三个正交轴**：

| 轴 | 回答 | 正确用途 | 不该用途 |
|---|---|---|---|
| 输出语义 | 这个输出能说什么？ | 工具分组、skill 路由、权限 | 回答“做完没有” |
| 生命周期（六问） | 还缺什么？ | coverage 报告、`preflight` 的一段、面板网格 | 做工具表面/执行框架 |
| 注意力 | 往哪看？ | 热力图（用户）+ 文本 `nextLook`（agent） | 变成第二套状态/契约 |

---

## 5. 决策

### 5.1 工具表面 = 输出语义

- 交付（可 block）、检测（永不 block）、仿真（只产证据）、仪器（只给真值）。
- 这条轴稳定、已有实现（`CAD_TOOL_GROUPS`/preset/skill/accept）、成本低。
- 不做“六珍珠工具表面”；六问只作覆盖报告的行。

### 5.2 六问降为覆盖报告

- 保留六行：`requirements / model / fit / make / review / delivery`。
- 行 id 可沿用 `brief/model/fit/make/review/deliver` 的内部映射，但模型可见面不再出现“珍珠”叙事。
- 六行是“还缺什么”的检查表，不是工具分类。

### 5.3 只做 V1

**范围**：只读证据验证 CLI（`verify`），输出六行报告 + findings + 退出码。

**非目标（写死）**：

- 不跑 CAD、不重算、不写 run、不修几何、不写契约；
- 不接 CI、不做面板（V1.1）、不做 profile/template DSL；
- 不判设计好坏；设计阈值最多 `warn`；
- 不设 owner/SLA/审批流；政策是用户声明。

**V2/V3/V4 暂缓，V5（自动修复/迭代）不做。**

### 5.4 不回撤，前向降级（D）

见第 6 节。

### 5.5 保留 / 降级 / 删除

| 处理 | 对象 |
|---|---|
| **保留** | `src/host/pearls/{observe,model,failure}.ts`（观察/失败契约）；`write-assembly.ts`（`inspectAssemblyContract`）；`checkers/`（协议/负样本）；`delivery-audit.ts`（`auditDelivery`/持久化）；`examples/`；`examples/rulepacks/`；`write_assembly` 工具；`pearl-profile.json` 作为 rulepack 指针可保留 |
| **降级（先不删）** | `pearl_run` 工具（标 DEPRECATED，仍在工具组）；`preflight` 的 pearl gate（标 legacy）；skill 的 Pearl workflow 小节；PEARL-PLAN/REPORT/docs/llm/pearls.md（标历史）；DESIGN §35（加“被 V1 取代”注记） |
| **后续删除（V1 绿后）** | `execute/execute-template/contract/repair*/profile/plan/run/inputs/context/prompt/format/types`；`pearls/` 模板与清单；`necklace-contract`/`project-profile` schema；珍珠验收脚本；`pearl_run` 注册与 `preflight` pearl gate |

---

## 6. 为什么不 revert/reset

### 6.1 git 事实

- `38b2d45` 是混合大提交：167 文件、48k 行；含珍珠框架 **和** V1 依赖的好资产（`write-assembly`、checkers、三示例、rulepacks、`delivery-audit` 持久化、schemas）。
- `main` 领先 `origin/main` 14 个提交，**尚未 push**；理论上可 reset，但代价高。
- 工作区还有未提交的 `PEARL-PLAN`/`docs/llm/pearls.md` 修改和未跟踪的 PEARL-REPORT。

### 6.2 方案对比

| 方案 | 操作 | 保留 | 丢失/风险 | 工作量 | 历史 | 结论 |
|---|---|---|---|---|---|---|
| A. revert 整个提交 | `git revert 38b2d45` | 历史；可再 cherry-pick | 删掉 write_assembly/checkers/示例/rulepacks/schemas/delivery-audit 持久化；V1 需重建；与未提交改动冲突 | 中–高 | 一次巨回撤，读者困惑 | 不推荐 |
| B. reset 到 HEAD~1 | `git reset` | 工作树可保留 | 重写历史；丢签名；167 文件重新拆分；易漏 | 高 | 最干净但最危险 | 不推荐 |
| C. 拆分 38b2d45 | soft reset + 选择性提交 | 好资产独立成提交 | 167 文件手工分类；tools/package/skill 混合，易错 | 高 | 很干净 | 收益低，不推荐 |
| **D. 前向降级** | 新提交：从模型面移除珍珠，保留基础 | **全部好资产**；V1 可直接开工 | 珍珠代码暂时还在仓库 | 低 | 清楚：add → demote → V1 | **采用** |
| E. D + 后续删除 | D 之后清理 | 好资产；最终无珍珠框架 | 需一次清理提交 | 低–中 | 清楚 | 终态 |

### 6.3 理由

1. V1 依赖该提交的好资产；回撤等于先拆地基再重建。
2. 项目历史纪律是“记录、不抹除”（DECISION-LOG append-only、记录类不回改）；前向提交记录这次转向，revert 抹掉一段历史。
3. 风险最低：不动已提交代码，不重写 167 文件；V1 可立即在现有基座开工。
4. 删除可后置：V1 绿后再删执行器/契约/模板，风险更小。

---

## 7. 迁移计划

```text
1) 报告提交（本次，先于代码）
   - docs/PEARL-TO-VERIFY-DECISION-2026-11-06.md（本文件）
   - docs/DECISION-LOG.md 追加一条（append-only，指向本文件）
   - 三份珍珠文档的“历史”横幅随第 2 步降级提交
     （避免把工作区里已有的未提交珍珠修改混进报告提交）

2) 降级提交（D5 第一阶段）
   - skill：Pearl workflow 小节 → Evidence verification (V1)
   - pearl_run 描述标 DEPRECATED；仍在工具组（避免 accept-tool-groups 红）
   - preflight 的 pearl gate 暂留，标 legacy
   - 代码不删；只在模型可见面移除
   - DESIGN §35 加“被 V1 取代”注记

3) V1 提交
   - src/host/verify/* + scripts/verify.mjs + scripts/accept-verify.mjs
   - docs/llm/verify.md
   - package.json：verify / accept:verify
   - 不改 accept:m16，保持绿色

4) 清理提交（V1 验收后）
   - 删除/归档执行器/契约/模板/repair/profile/plan/run/inputs/context/prompt/format/types
   - 删除 necklace/project-profile schema、珍珠验收脚本
   - 移除 preflight 的 pearl gate、pearl_run 工具
   - 保留 observe/model/ledger/failure、write_assembly、checkers、delivery-audit、examples、rulepacks
```

**不做的**：不在第 1–3 步重写历史；不在 V1 绿之前删除 observer/ledger/failure；不把 `pearls/` 移到 `experimental/`（移动需改 import，风险更高）。

---

## 8. V1 契约摘要

### 8.1 D1–D6

| # | 决策 |
|---|---|
| D1 | 状态词汇：`pass / warn / fail / blocked / unobserved`；旧 `excluded/difficult/not-excluded` 在适配层映射；`not-applicable` → `unobserved` + reason |
| D2 | claims + 新鲜度：`claims.json` 或 `--claims`；无 claims → `warn: corpus audit only`，`--require-claims` → `blocked`；新鲜 = 版本集精确/包含 + 时间戳 |
| D3 | 报告是派生快照（stdout + `--out`），工具从不读；退出码 advisory 0 / blocking 0-1-2-3，`--strict` 把 warn 变 2 |
| D4 | V1 = CLI + 文本/JSON；面板/热力图 V1.1 |
| D5 | 旧珍珠面：skill/docs 先降级，代码保留；V1 绿后删除 |
| D6 | 命名 `verify` / `evidence-report.json`；政策是用户声明（`evidence-policy.json` 或 CLI），无 owner/SLA |

### 8.2 六行与来源

| 行 | 检查什么 | 来源 |
|---|---|---|
| `requirements` | claims/scenario 是否声明、可解析；PROMPT 是否存在 | `claims.json` / `PROMPT.md` |
| `model` | assembly 合法；版本/BOM/datum 可解析 | `inspectAssemblyContract` |
| `fit` | 干涉/接口/运动证据新鲜 | `observeFit` 的 `findings`（不用 ledger `failures`） |
| `make` | printability/壁厚；木作毛料 | `observeMake` + runs |
| `review` | 打印件 top+iso+note 是否新鲜（role-aware） | `auditDelivery.visual` |
| `delivery` | claims → witness；stale/missing；audit findings | `auditDelivery` + V1 claim checker |

### 8.3 状态映射

- 证据缺失/过期/引用不一致/未登记/未审阅 → `blocked`；
- 设计/声明阈值被违反 → `fail`；
- 弱证据/`difficult`/解释性 info → `warn`；
- 全部满足 → `pass`；
- 没有可检查对象 → `unobserved` + reason。

### 8.4 新鲜度

- 装配级：`run.sourceVersionIds` 集合相等 + `run.timestamp >= vTime`；
- 零件级：包含当前版本 + 时间戳；
- motion：与 claim `versionIds`（缺省=当前集）集合相等；
- 引用 `runId`：必须存在且满足；缺失/不新鲜 → `claim-run-missing`/`claim-run-stale`；
- 无 `sourceVersionIds`：不可证明新鲜 → `blocked`。

### 8.5 政策（无 owner）

```json
{
  "schemaVersion": 1,
  "id": "evidence-policy-v1",
  "mode": "blocking",
  "blockOn": ["evidence-missing", "evidence-stale", "claim-without-witness", "claim-run-missing", "claim-run-stale"],
  "warnOn": ["design-threshold", "difficult", "no-claims-declared"],
  "requireClaims": false,
  "exceptions": "evidence-exceptions.json"
}
```

- 政策是用户声明；可写文件，也可用 CLI 参数。
- 没有政策 → advisory；`approvedBy` 只出现在例外里，是自由文本，不是角色。
- 团队分权由团队自己定；场地只记录。

### 8.6 非目标

不跑 CAD、不重算、不写 run、不修几何、不写契约、不接 CI、不做面板、不做 profile/template DSL、不判设计、不设 owner/SLA。

---

## 9. 验收

| 类别 | 断言 |
|---|---|
| 三示例 | windup `warn`、roberval `blocked`、table `blocked`；报告含 stale/missing 结论 |
| 负样本 1 | 改版本不重跑 → `blocked` / `claim-run-stale` |
| 负样本 2 | claims 声明 motion 但无 fresh run → `blocked` / `claim-without-witness` |
| 负样本 3 | `--require-claims` + 无 claims → `blocked` |
| 负样本 4 | 过期例外 → 恢复 `blocked` |
| 正样本 | 合成最小项目（assembly + 新鲜 run + review + claims）→ `pass` |
| 无 CAD | `CAD_OPENSCAD_BIN=/nonexistent DSH_CAD_PYTHON=/nonexistent` 仍成功 |
| 无写 | 运行前后 `cad-data/runs`、`assembly/` 哈希不变（除 `--out`） |
| 确定性 | 两次 `--out`，除 `generatedAt` 外字节一致 |
| 退出码 | advisory / blocking / strict 三模式各测 |
| 范围 | 不 import `beginRun`/`simulate_*`/`executeTemplate`（静态 grep 断言） |

实现方案另见后续 `dsh-cad-harness/docs/VERIFY-V1-PLAN.md`（本报告只冻结契约与决策）。

---

## 10. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| 行来源：`observeMake`/`CLAIM_EVIDENCE` 未导出 | 小重构：只加 `export`，不改逻辑 |
| 无 profile 时 wood/FDM 判断错 | 有 profile 用 rulepack；无 profile 看 `assembly/cutlist.json`；不确定 → `unobserved`/`warn` |
| 版本时间戳缺失 | `freshness-unverifiable` warn；不静默 pass |
| audit findings 没有 why/where/next | 一张 code→(why,next,where) 映射表；未知 code 给通用 next |
| 三示例预期与新映射不一致 | 契约已定；accept 写死预期，失败即说明映射错 |
| V1 被“顺便”推成 V2/V4 | 非目标 + accept 断言“无 CAD/无 run 写入”；新增先过场地测试 |
| 旧珍珠代码暂时还在 | skill/docs 先降级；V1 绿后清理提交删除 |
| 面板/热力图延后 | V1.1；V1 的 JSON 保留 `rows/findings/provenance` 供渲染 |

**开放问题（实现级，已有默认）**：

- V1 只做 CLI，不做 tool wrapper（agent 可通过 shell 调；需要时 V1.1 加 30 行 wrapper）。
- 报告 schema 先用 TypeScript 类型 + accept 形状断言；CI 需要时再加 `schemas/evidence-report.schema.json`。

---

## 11. 附录

### A. git 事实

- HEAD：`38b2d45`（2026-11-05 20:08:32 +0800），`main` 领先 `origin/main` 14 个提交，未 push。
- `38b2d45`：167 files changed，48,149 insertions，15 deletions。
- 关键新增：`src/host/pearls/`（21）、`checkers/`（4）、`write-assembly.ts`、5 schemas、`examples/eight-immortals-table/`、rulepacks、33 scripts。

### B. 文件清单（保留/降级/删除）

见 §5.5。

### C. 术语

- **V1**：只读证据验证（`verify`）。
- **输出语义**：交付/检测/仿真/仪器，映射“输出允许说什么”。
- **覆盖报告**：六行“还缺什么”的检查表。
- **场地测试**：减法/零读/规定vs条件/权威/判断/忽略。
- **Owner**：本报告明确**不设**；政策是用户声明。

### D. 参考

- 审计证据：本报告 §3（31KB gate、2,343 行/52 类型、6+ 状态词、r073、info→hard、semanticFailure）。
- 珍珠历史：`dsh-cad-harness/docs/PEARL-PLAN.md`、`PEARL-REPORT-2026-11-05.md`（均标历史）。
- 决策日志：`docs/DECISION-LOG.md` 2026-11-06。
- V1 契约：本报告 §8；实现方案另行。
