# 01b · 实验设计：skill 改动的 A/B 试验台（**给操作者，不是考生题面**）

> **考生题面**：[`subjects/01b-diagnosis/TASK.md`](../../subjects/01b-diagnosis/TASK.md)
> —— 逐字作为首条消息发出。本文件说明这道题怎么兼作手册改动的对照台。

## 开跑前

| 项 | 值 |
|---|---|
| cwd | `examples/bench/subjects/01b-diagnosis/` |
| 预设 | 营造模式（**先设为默认预设再新建会话**）——与其余各题同一个 SUT |
| 附件 | 无 |
| 素材 | `subjects/01b-diagnosis/dossier/`（69 个 run 的 JSON 证据，已入库） |
| 记录 | commit、`SKILL.md` sha256、**`TASK.md` sha256**（见 README §二） |

可选的完整语料（要跑 `delivery_audit` 时才需要）：

```bash
node examples/bench/tools/materialize-01b.mjs corpus
```

## 这道题的两个身份

1. **诊断题**：给一份语料，看模型能不能自己读出"上一轮交付其实没验过机构、
   整机也从没通过"。
2. **`SKILL.md` 改动的 A/B 试验台**：同一份 `dossier`、同一模型、换手册版本跑两遍，
   差值就是这次手册改动的**净效应**。

第二个身份才是它在这套题库里的独特价值——因为手册的生效程度没法从生成类题目里
干净地读出来（那些题的能力提升可能来自模型、也可能来自手册，混在一起）。

## 为什么不藏手册

`cad-toolbox` skill 的「Delivery discipline」章节里写着 microscope5 的失败细节
（例如 "26 interfaces — zero of them motion-clearance"），一度被当成泄题。

**这个框架是错的**：插件的价值主张之一就是让手册把踩过的坑带到下一轮。
手册**能不能让模型做对**，是要被测的目标，不是要消除的噪声。所以：

- **不藏、不剥、不改**手册去迁就评测；
- 手册出不出现，**由 SUT 自己的加载逻辑决定**，我们不在消息里硬塞或硬删；
- 它有没有被加载，作为 `S0` 单独记录——**手册生效的第一环是"它得先被看见"**。

## 怎么跑

### 基准期（只有一版手册）

单臂：营造模式 + `subjects/01b-diagnosis/TASK.md` 原文。约 15 分钟。记下 `S0` 与 `S`。

### 手册改动期（有两版手册）

`SKILL.md` 是 SUT 的一部分，所以**两臂靠换文件来区分，而不是靠改消息**：

```bash
# 基准臂：让 SKILL.md 回到基准版本（§二 记的 sha256）
git stash push dsh-cad-harness/skills/cad-toolbox/SKILL.md   # 或 checkout 基准 commit 的该文件
# 跑一遍 01b，记 scoreBaseline / S_baseline / S0_baseline

# 候选臂：恢复你的改动
git stash pop
# 再跑一遍 01b，记 scoreCandidate / S_candidate / S0_candidate
```

**两臂必须同模型、同 `dossier`、同预设**；唯一变量是 `SKILL.md` 的内容。

### 其余固定条件

见根 [README §5](../README.md)。**不要**在消息里额外贴或删 skill 正文——
那样变量就从"手册内容"变成了"我们在消息里放了什么"。

## 差怎么读

主读数是 **`S`（skill 生效度）**，次读数是 `P`。定义 Δ = S_candidate − S_baseline：

| 结果 | 含义 | 该做什么 |
|---|---|---|
| **Δ ≥ +0.2** | 这次改动**生效了**：手册点名的事，模型更照做了 | 改动保留；把它写进下一步基线 |
| **\|Δ\| < 0.2 且 S 已高** | 天花板效应：手册本来就照做了 | 这条改动没有可测收益，考虑是否值得增加手册长度 |
| **\|Δ\| < 0.2 且 S 低** | 改动没生效 | 先查 `S0`：手册**被加载了吗**？加载了才轮到措辞问题 |
| **Δ ≤ −0.2** | 改动**有害**：手册变长反而让模型抓不住重点 | 回滚或拆分；对照 `C` 列看是不是上下文成本压过了收益 |

### 两个专门的观察项

- **`S0` 的漂移**：如果某次改动让 skill 不再被加载（例如描述字段被改窄），
  `S0` 会掉到 false。这时 `S` 记 `N/A`，而 `S0=false` 本身就是头号发现。
- **证据深度**：手册里**没有** `r046` / `r048`、覆盖率与时间戳。所以 `S` 之外，
  还要看 `c-evidence-depth`——一个把手册结论照抄一遍却给不出 run 级依据的回答，
  不应因为 `S` 高而被认为诊断做得好。见 `key.md` §七。

## 记录

```
graders/01b-diagnosis/scores/<模型>-<时间戳>-baseline.json   { commit, skillSha256, S0, S, P, citedRunIds }
graders/01b-diagnosis/scores/<模型>-<时间戳>-candidate.json  同上（附改动的说明）
graders/01b-diagnosis/scores/<模型>-<时间戳>-delta.json      { deltaS, deltaP, s0Drift, anchoringSuspect, 一句结论 }
```
