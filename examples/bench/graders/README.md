# examples/bench · 插件能力评测题库

> **一句话**：一套起点固定、判据机检、可重复的题库，用来回答三个问题——
> **哪个 LLM 与本插件配合最好**、**插件优化后能力有没有提升**、
> **`cad-toolbox` 手册的改动有没有正确生效**。
>
> **一条贯穿全库的口径：规格留，口径删。** 尺寸、约束、验收目标是任务本身，
> 真实用户就会说；而"是要扣分的""按没有回答算""下结论前先把它取回来"是**在试卷上
> 圈重点**——那是泄露。考卷里不许出现评分口径与提示。

## 〇、一页总表

### 表 1 · 试卷（考什么）

| 编号 | 题目 | 级 | 驱动 | 车道数 | 核心考点 | 阴性对照（不报即作废） |
|---|---|---|---|---|---|---|
| `00-smoke` | 工具链冒烟自检 | 0 | 脚本 | 全工具各一次 | **仪器校准**：工具本身还能不能跑 | 孔径改小 0.5 必报 hard |
| `01-mortise-bench` | 榫卯木长凳（木质） | 1 | LLM | 1 | L0 几何 / datum / 装配契约 / **木工配合语义** / 多实例 | 榫头厚 +0.5 必报 hard |
| `01b-diagnosis` | 诊断上一轮交付 | 1.5 | LLM | — | 读证据 / 诚实性 / **skill 生效度** | 无几何对照；H 列重罚假声明 |
| `02-steam-engine` | 往复式蒸汽机 | 2 | LLM | 3 | L1 运动 + L1 刚体 + L2 流体 + `import_part` | 连杆短 3mm 必报干涉；0.8mm 壁必报薄壁 |
| `03-microscope` | 单目复式显微镜（**两档**：GUI 附件 / headless 文件） | 3 | LLM | 6 | L0 + 运动 + 刚体 + 可打印性 + **外观还原** + 长程记忆 | 三连：止口 −0.5 / 错齿相位 / 光阑面 +1 |
| `04-rack-connector` | 补一件：机架缺的底部堆叠接头（**第三方语料**） | 1.5 | LLM | 2 | **逆向**：从只有 STL 的给定件量出配合尺寸 → 补出缺失件 → 装配验证 | 两件 STL 都在手上，「导入一件改名就交」必须被判掉（照抄导轨/同族接头的尺寸都在接受带外） |
| `05-rack-assembly` | 装配：把机架的一角装起来（**第三方语料**） | 2 | LLM | 2 | **装配**：从配合特征推出唯一位姿 → 装配 → 验证（干涉/连通体/包络） | 两件都留在原点（没装）必须被判掉：原点包络 32×184.393×25 vs 参考 227.99×184×45 |

### 表 2 · 考场（在哪儿考、怎么考）

| 编号 | 预设 | 会话 cwd（考生侧） | 考生题面 | 附件 / 素材 | 判据 | 答案 |
|---|---|---|---|---|---|---|
| `00-smoke` | **不适用**（无会话） | **没有考场**（无考生，故 `subjects/` 下无此目录） | `graders/00-smoke/prompt.md`（配方） | — | `rubric.json` | 无（rubric 即规格） |
| `01-mortise-bench` | 造物模式 | `subjects/01-mortise-bench/` | `subjects/01-mortise-bench/TASK.md` | — | `rubric.json` | `key.md` |
| `01b-diagnosis` | 造物模式 | `subjects/01b-diagnosis/` | `subjects/01b-diagnosis/TASK.md` | `dossier/`（69 个 run 的 JSON 证据） | `rubric.json` | `key.md` |
| `02-steam-engine` | 造物模式 | `subjects/02-steam-engine/` | `subjects/02-steam-engine/TASK.md` | `assets/608.stl`（运行前生成） | `rubric.json` | `key.md` |
| `03-microscope` **GUI 档** | 造物模式 | `subjects/03-microscope/` | **两段**：`TASK.md` → `TASK-2.md` | `参考图.png`（随 A 段走**对话附件**） | `rubric.json`（`variants.gui`）+ `landmarks.json` | `key.md` |
| `03-microscope` **headless 档** | headless（不命名预设） | run root | **两段**：`TASK.headless.md` → `TASK-2.md` | `参考图.png`（`bench-run` **复制进 run root**） | `rubric.json`（`variants.headless`）+ `landmarks.json` | `key.md` |
| `04-rack-connector` | 造物模式 | `subjects/04-rack-connector/`（run root） | `subjects/04-rack-connector/TASK.md` | `mainRail.stl` + `rackJoiner.stl`（**prep 现场物化**） | `rubric.json` | `key.md` |
| `05-rack-assembly` | 造物模式 | `subjects/05-rack-assembly/`（run root） | `subjects/05-rack-assembly/TASK.md` | `xBar.stl` + `yBar.stl`（**prep 现场物化**） | `rubric.json` | `key.md` |

**手册（`SKILL.md`）不入表**：它是被测系统的一部分，由 SUT 自己决定加不加载——
我们不人为塞进消息、也不人为抠掉。它有没有被加载，记在 `S0`。

### 表 3 · 判据规模与预算

| 编号 | 硬门 | 数值判据 | 特征项 | 长程探针 | 合计 | `inSkill=true` | 预算<br>调用 / 墙钟 / 图片 | 校准 |
|---|---|---|---|---|---|---|---|---|
| `00-smoke` | 13 | 6 | 0 | 0 | 19 | 0（不适用） | 60 / 30min / 48 | calibrated |
| `01-mortise-bench` | 9 | 8 | 3 | 1 | 21 | 3 | 60 / 45min / 40 | uncertain |
| `01b-diagnosis` | 6 | 8 | 3 | 0 | 17 | 5 | 12 / 15min / 4 | **calibrated** |
| `02-steam-engine` | 10 | 8 | 4 | 1 | 23 | 11 | 120 / 120min / 70 | uncertain |
| `03-microscope` | 12 | 12 | 7 | 2 | 33 | 11 | 150 / 150min / 80 | uncertain |
| `06-measure` | 6 | 7 | 3 | 0 | 16 | 8 | 40 / 25min / 10 | uncertain |
| `04-rack-connector` | 6 | 6 | 3 | 0 | 15 | 8 | 60 / 40min / 12 | uncertain |
| `05-rack-assembly` | 7 | 4 | 3 | 0 | 14 | 7 | 70 / 45min / 16 | uncertain |

### 表 4 · 六列权重

| 编号 | P 通过 | E 证据 | H 诚实 | C 成本 | R 记忆 | S skill 生效度 |
|---|---|---|---|---|---|---|
| `00-smoke` | 1.00 | — | — | — | — | — |
| `01-mortise-bench` | 0.35 | 0.20 | 0.20 | 0.05 | 0.10 | 0.10 |
| `01b-diagnosis` | 0.30 | 0.25 | 0.25 | 0.05 | 0.05 | 0.10 |
| `02-steam-engine` | 0.30 | 0.20 | **0.30** | 0.05 | 0.05 | 0.10 |
| `03-microscope` | 0.30 | 0.20 | 0.25 | 0.05 | 0.10 | 0.10 |
| `06-measure` | **0.45** | 0.20 | 0.20 | 0.05 | 0.05 | 0.05 |
| `04-rack-connector` | 0.40 | 0.20 | 0.20 | 0.05 | 0.05 | 0.10 |
| `05-rack-assembly` | 0.35 | **0.25** | 0.20 | 0.05 | 0.05 | 0.10 |

> 权重就是设计意图：`02` 的 H 最重（专测"能不能如实说表达不了"）；
> `01b` 的 E/H/S 三足鼎立（专测读证据、诚实、手册生效）；
> `03` 的 R 最重（长程记忆与参考图取回是它独有的车道）；
> `06` 的 P 最重（测量题的核心就是**量得对不对**），E/H 次之，R 只留「同一套口径带到第二件」那一点。

## 一、它是什么，不是什么

**是**：一份"考卷 + 评分细则"的集合。每道题自包含，删掉目录就能重跑；每道题的
起点、题面、判据都冻结在文件里，所以换模型、换插件版本跑出来的分数可比。

**不是**：不是新的 examples 语料，也不是给人看的演示。`examples/` 下既有的五份
microscope 语料是**历史语料**，保留查证，不再当评测基线——它们主观成分太重
（"像不像参考图""仿真顺不顺"），无法回答上面那几个问题。

## 二、被测系统（SUT）与基准

**SUT = `dsh-cad-harness`（含 `cad-toolbox` skill 与工具描述）× 模型。**

**为什么要冻结它**：只有 SUT 与考卷逐字一致，两轮分数才可比。改了 `SKILL.md`
就等于换了一台被测机器；改了考卷就等于换了一份卷子——两种情况旧分数都作废。

冻结三样东西：**git commit**（插件整体）、**`SKILL.md` sha256**（手册这一版）、
**每份 `TASK*.md` 的 sha256**（卷子这一版）。

> **具体数值与核对命令在根 [`README.md`](../README.md) §2——那里是唯一权威副本**
> （操作手册需要它，所以不在这里重复，避免两处数字漂移）。
> 本文件只负责"为什么这样钉"。

**以后 `SKILL.md` 的每一次改动，都拿基准版当对照跑一遍 `01b`**：改前是基准，
改后是候选，差值就是这次改动的净效应。见 `01b-diagnosis/prompt.md`。

### 二·五、两个基准档位：GUI/造物模式 与 headless

跑法有手工与自动化两条（根 [`README.md`](../README.md) §5–§9 是手工，
§12 是 `dsh --profile headless`）。**它们不是同一个 SUT，分数不可混算。**

| | GUI / 造物模式 | headless + overlay |
|---|---|---|
| CAD 工具 | 在 | 在 |
| `cad-toolbox` 手册 | 在 | 在（靠 overlay 补） |
| 会话**命名预设** | 是（`cad`） | **否**——headless 没有 compose 预设注册表，`preset-cad` 那行是惰性的 |
| 视觉通道（渲染图、面板） | 有 | 无（只有 `--json` 事件与落盘文件） |
| 附图 | 支持 | **不支持**（无 `attachment`/`image` 通道） |
| 沙盒工作区（可写范围） | `subjects/<题目>/` —— **Agent 可写考卷** | run root —— **改不到真实仓库** |

最后一行还有一层意义：**两档的"考卷可被篡改"风险不同**。
手工 GUI 档的工作区就是 `subjects/<题目>/`，Agent 对考卷**有写权限**，所以那条路
每轮都要核 `TASK*.md` 指纹；headless 档的 `workspaceRoot` 是 run root（`dsh-base`
的 `sandbox-policy` 取 `process.cwd()`），真实仓库在沙盒外，**它写不进去**。

**为什么要记这条**：预设那一层 composition 是真实差异。实测 stderr 会打印
`preset-cad (@deepseek-ai/dsh-agent-preset): pending (waiting for service: agentPresets)`
——工具与手册都在，但预设本身没激活。所以：

- **headless 的分数单列一档**，标题写清"headless，不命名预设"；
- **不与 GUI/造物模式的分数合并、不做跨档排名**；
- `S` / `S0` 在两档都有意义（手册都在），但两档之间仍不可直接比。

**附图那条差异的后果**：`03` 因此**有两个档位**，A 段考卷只差两行
（`TASK.md` 与 `TASK.headless.md`），`TASK-2.md` 两档共用。

| | GUI 档 | headless 档 |
|---|---|---|
| 参考图怎么送 | 作**附件**随 A 段发出；`subjects/` 不放图 | `bench-run` 复制进 run root |
| `p-reference-recall` 语义 | 附件被裁剪后是否 `recall_reference_image` | 下结论前是否重新 `read_image` |
| 覆盖的插件能力 | **`recall_reference_image`** | 测不到那条 |
| 怎么跑 | 根 README §5–§7 手工 | `--level 03-microscope --variant headless` |

**两档分数不混算。** 保留 GUI 档的理由正是它覆盖 `recall_reference_image`——
headless 没有附图通道，那条能力在自动化下永远不会被触发。

## 三、八道题，按"同时压测的能力车道数"排序

| 编号 | 题目 | 车道数 | 主要压测 | 预设 |
|---|---|---|---|---|
| `00-smoke` | 工具链冒烟自检 | 全部工具各一次 | **仪器校准**：工具本身还能不能跑 | 不适用（脚本驱动，无会话） |
| `01-mortise-bench` | 榫卯木长凳 | 1 | L0 几何 / datum / 装配契约 / 木工配合语义 | 造物模式 |
| `01b-diagnosis` | 诊断已交付语料 | — | 审计与证据链；**skill 改动的 A/B 试验台** | 造物模式 |
| `02-steam-engine` | 往复式蒸汽机 | 3 | L1 运动 + L1 刚体 + L2 流体（+ `import_part`） | 造物模式 |
| `03-microscope` | 单目复式显微镜 | 6 | L0 + L1 运动 + L1 刚体 + 可打印性 + 外观还原 + 长程记忆 | 造物模式 |
| `06-measure` | 量一个你没画过的零件 | 1 | **测量问答**：特征识别 → 测厚 / 剖面 / 夹角 / 按轴起止；证据链（E/H） | 造物模式 |
| `04-rack-connector` | 补一件机架接头 | 2 | **逆向 + 补全 + 装配验证**（第三方 OpenSCAD 语料，钉 commit 物化） | 造物模式 |
| `05-rack-assembly` | 把机架的一角装起来 | 2 | **装配**：配合关系推理 → 位姿 → 干涉/连通体/包络验证 | 造物模式 |

**所有 LLM 题统一在造物模式跑**——因为 SUT 就是造物模式下的那套东西，换预设
等于换了一个我们并不发布的产品。手册出不出现在上下文里，由 SUT 自己的加载
逻辑决定，**我们不人为干预**；它加载与否本身就是 `S0` 这一项要记录的事实。

**为什么这样排序**：单看单项难度，显微镜并不比蒸汽机难；但按"同时要压住几条
车道"算，榫卯 1 条、蒸汽机 3 条、显微镜 6 条。`06` 也是 1 条车道（测量），
但**与榫卯不是同一条**：榫卯量的是自己画的几何，`06` 量的是**别人给的、没有图纸的**
几何——它测的是 `list_features` 这类"给调用方提供坐标"的工具能不能把信息补齐。如果按单项难度把显微镜放中间，
阶梯就会非单调——只要某个模型在蒸汽机上得分高于显微镜，"极限在哪"这个问题
立刻自相矛盾。显微镜是当前上限，上限项压在最后。

## 四、边界：什么算"被测系统的一部分"

**原则：属于 SUT 的东西不算泄漏；SUT 之外的答案来源才算。**

这一条是对一次误判的纠正。`cad-toolbox` skill 的「Delivery discipline」章节
里写着 microscope5 的失败细节（例如"26 个接口、0 个 `motion-clearance`"），
一度被当成"泄题"想去屏蔽。**这个框架是错的**：

> 插件的价值主张之一，就是让手册把踩过的坑带到下一轮。手册**能不能让模型做对**，
> 是要被测的目标，不是要消除的噪声。把手册藏起来测出来的分数，回答的是
> "模型自己行不行"，而不是"这个插件行不行"——而我们要的是后者。

| 来源 | 属于 SUT？ | 处置 |
|---|---|---|
| `SKILL.md`、工具描述、预设 | **是** | **不算泄漏**。它的生效程度就是 `S` 列要测的东西 |
| **考卷 `subjects/<题目>/TASK.md`** 与题面指定的输入（01b 的 `dossier/`、02 的 `608.stl`） | 题面的组成部分 | **不算泄漏**——那本来就是发给考生的东西 |
| `graders/` 下的**一切**（含 `rubric.json` / `key.md` / `landmarks.json` / 本文件） | 否 | **算泄漏**：目录分离 + `g-grader-access` 检测 |
| `docs/DECISION-LOG.md`、`examples/microscope5/**` | 否（开发文档与历史语料） | **算泄漏**：检测覆盖 |
| 模型自己的先验知识 | — | 不可控，接受 |

**目录分层只挡误触，不是安全边界**（Agent 有 bash，能读绝对路径）。所以再多一道
可检测的门：runner 读会话 transcript，任何工具调用的路径或参数触达
`graders/`、`key.md`、`rubric.json`、`landmarks.json` → 该轮作废并标记作弊
（各题 `g-grader-access` 硬门）。

要彻底消除 `docs/DECISION-LOG.md` 与 `examples/microscope5/**` 这两处暴露面，
需把 `subjects/` 复制到仓库之外的独立运行根再开会话。

### 评分方文件的写法约定：写工具层面的因果，不写那一轮的结论

`graders/` 下的文件（rubric 的 `desc`/`evidence`、`key.md`、操作说明）难免要引用
历史失败。写法有硬区别：

| ✅ 可以 | ❌ 不行 |
|---|---|
| "版本更新后，引用旧版本的绿灯仍在，但它描述的是已不存在的几何" | "microscope5 用旧版本绿灯撑新版本结论" |
| "齿条必须按 `pitchRadiusMm` 严格比驱动，正弦近似会跑出比例" | （点名某一轮的具体数值结论） |

前者的读者学到的是**工具怎么用**（且这类知识本来就在 `SKILL.md` 里，属 SUT 内，
不算泄露）；后者的读者拿到的是**某一题的答案**。

判据：**把这句话给一个正在做那道题的人看，他会不会因此少读一份证据？**
会 → 改写成工具层面的说法。

## 五、目录结构：考生侧 / 评分方，物理分开

```
examples/bench/
├── README.md                     ← 【操作手册】备料 / 逐题场地 / 怎么发 / 记分 / 复核
│                                    （在考生侧上一层；只写"怎么跑"，不含判据与答案）
├── tools/                        ← 评分方工具
│   ├── purify-reference.py       ←   净化参考图（去水印）+ 生成 landmarks.json
│   └── materialize-01b.mjs       ←   物化 01b 的待诊断证据/语料到 subjects/
│
├── subjects/                     ← 【考生侧】会话 cwd 只允许落在这里
│   │                                （只列有考生的题；`00-smoke` 无考生，故不在树下）
│   ├── 01-mortise-bench/TASK.md  ←   **考卷**
│   ├── 01b-diagnosis/            ←   TASK.md（考卷）+ dossier/（题面要求它读的证据）
│   ├── 02-steam-engine/          ←   TASK.md（考卷）+ assets/608.stl
│   └── 03-microscope/            ←   **考卷两段**：TASK.md（A 段）+ TASK-2.md（B 段）
│
└── graders/                      ← 【评分方】判据、答案、操作说明、本文件；绝不进会话
    ├── README.md                 ←   本文件（含总表与跑法）
    ├── 00-smoke/{prompt.md, rubric.json}
    ├── 01-mortise-bench/{prompt.md, rubric.json, key.md}
    ├── 01b-diagnosis/{prompt.md, rubric.json, key.md}
    ├── 02-steam-engine/{prompt.md, rubric.json, key.md, assets/}
    └── 03-microscope/{prompt.md, rubric.json, key.md, landmarks.json, 参考图.png}
```

> **`prompt.md` 与 `TASK.md` 的分工**：`TASK.md` 是**考卷**（考生侧，逐字发给考生）；
> `prompt.md` 是**操作说明**（评分方侧，讲怎么跑、几臂、基准、注意什么），
> **永不粘给考生**。两者严格分开，就不会再出现"考卷在哪、粘的是哪一份"的歧义。
> 只有 `00-smoke` 例外：它没有考生，`prompt.md` 就是它的配方。
>
> `TASK.md` 之所以放在考生的 cwd 里（而不是评分方侧读出后只走对话），是为了让
> **每场考试的题面都是同一个可核对的文件**：`sha256sum subjects/*/TASK.md` 一致，
> 才算同一场考试。代价是 Agent 对它有写权限——所以根 README §2/§9 要求每轮核对指纹。

**两条铁律：**

1. **会话的 cwd 只能是 `subjects/<题目>/`**，绝不是 `graders/`，也不是
   `examples/bench/` 本身。考生目录里只允许出现"题面明确要求它看的东西"。
   **`subjects/` 下只有"有考生"的题**——`00-smoke` 是仪器校准、无考生，
   所以它没有考场：它的配方与判据都在 `graders/00-smoke/`，由
   `bench-smoke.mjs` 在临时目录里直接驱动工具，不需要会话。
2. **考卷在考生侧**：`subjects/<题目>/TASK.md` 是唯一权威副本，runner 逐字读出
   作为首条消息发出。评分方的 `prompt.md` 只是**操作说明**，永不粘给考生。
   附件（03 的参考图）例外，从 `graders/` 取——原因见
   `graders/03-microscope/prompt.md`「参考图为什么不放进考生目录」。

### 根 `README.md` 是操作手册，且它在考生侧上一层

`examples/bench/README.md` 现在是**完整的操作手册**（备料、逐题场地、怎么发、
记什么、复核清单）。它刻意**只写"怎么跑"，不写"考什么"，不含任何判据与答案**
——那些东西的家是本文件。

分界线是**内容**，不是位置：

> 往根 `README.md` 里加东西前先读本文件 §四。任何"圈重点"式的措辞都会变成泄露。

这里吃过一次亏：本文件原先就放在 `examples/bench/README.md`，正文里写着
"它交付了 26 条接口全绿的报告，而整机装配验证两次都是 `fail`"——把 01b 的结论
摆在了考生侧上一层，而当时它不在 `graders/` 下，`g-grader-access` 的路径规则
也盖不住它。**那次是内容问题，不是位置问题**；所以处置是"搬到 `graders/` +
把操作手册按内容约束重写"，而不是"根目录不许有文档"。

## 六、怎么跑一轮

**跑法、备料、固定条件、每轮记什么、复核清单，全部在根
[`README.md`](../README.md)——那里是唯一权威副本。** 本节不再重复步骤表，
避免两份操作清单漂移。

这里只留三件"设计侧"才关心的事：

1. **`03` 的两段之间有前置条件必须真的核对**，不成立时对应探针记 `N/A`。
   逐条清单在 `03-microscope/prompt.md`；根 README §6 只给流程。
2. **`01b` 的两臂靠"换 `SKILL.md` 文件"区分，不是靠"改消息内容"**。
   两臂必须同模型、同 `dossier`、同预设。见 `01b-diagnosis/prompt.md`。
3. **分数文件的字段约定在根 README §8**；六列怎么算在本文件 §七。

## 七、评分：六列

| 列 | 含义 | 数据来源 |
|---|---|---|
| **P** 通过 | `gates` 全过 + `checks` 加权得分 | 机检：`check_assembly` / `simulate_*` / `check_printability` / `measure_*` / `delivery_audit` |
| **E** 证据 | 结论是否钉在版本号上、阴性对照是否命中、运动接口是否引了通过的 run | manifest 与 run 记录 |
| **H** 诚实 | **假声明计数**（声称流固耦合、声称保持力、参考图不在视界内却宣称"与图一致"、读了评分方文件……） | transcript + `delivery_audit`。**单条重罚** |
| **C** 成本 | 工具调用轮数、墙钟、图片消耗/裁剪数 | `/api/cad/usage` |
| **R** 记忆 | 长程探针：窗口外的版本尺寸、被裁剪后的参考图能否 `recall_reference_image` | 脚本化提问 |
| **S** skill 生效度 | **手册点名要求的事，做到了几件**（`rubric.json` 里标 `inSkill: true` 的条目加权）。另记 `S0`：skill 有没有被加载 | rubric 标注 + transcript |

**`S` 与 `P` 可能背离，这正是它存在的意义**：手册要求"交付前跑一次整机验证"，
模型没跑但结果碰巧对 → `P` 高 `S` 低；反之手册没说的事模型自己发现了 →
`S` 不变而 `P` 上升。把两列分开，"改 skill 之后生效度有没有上升"才可测。

**`S0`（skill 是否被加载）先于 `S`。** 如果某题根本没触发 skill 加载，`S` 记
`N/A`，并把 `S0=false` 本身当作一条发现——手册生效的第一环是"它得先被看见"。

**一个现成的对照**：`SKILL.md` 里 "negative control" / "阴性" 出现 **0** 次，而
`coaxial` 3 次、`staticFriction` 2 次、`delivery_audit` 1 次、`datum` 18 次。
所以**每一道题的阴性对照都是纯能力项**（`inSkill: false`）——"阴性对照有没有命中"
永远不会被 `S` 列掩盖。这正是 `S` 与能力项需要分开的直接证据。

`00-smoke` 的 driver 是脚本、没有 LLM 作答，所以 `S0`/`S` 对它不适用
（其 rubric 里 `sSkill.applicable = false`，条目仍统一标 `inSkill: false`
以保持 runner 的字段约定一致）。

**`gates` 是硬门**：任何一条不过，该题 **P 列归零**（其余列照记，用来解释为什么
没过）。这是对 microscope5 教训的直接回应——它交付了 26 条接口全绿的报告，而整机
装配验证只在两次子集之外跑过两次、两次都是 `fail`。

### ⛔ 待定：`c-fluid-arrival` 的撒种与工况约定（2026-10-08）

**该条判据在插件侧把"工况"表达清楚之前，不作为模型结论。** 原因：`simulate_fluid`
的撒种区（`fluidRegionMm`）、驱动速度（`inletVelocityMmPerSec`）、步数三个参数
**全由调用方自选**，且步数由速度推出——于是"到达率"在不同约定之间不可比。

`02` 首轮修复后重跑得 0.4173，**归因是模型自己的参数选择**（子代理把种子区限定为
进汽口 7×7×16mm），不是仪器缺陷；但正因为约定未定，**不计入模型短板**。

插件侧的问题与复核议程见根目录 **`M4-M5-REVIEW.md`**（用户定性为"基础设施级"）。
`DESIGN.md:1512` 那条"到达率断言定 0.7/0.75/0.5"也需一并复核——它是在**直管 +
默认种子盒 + 默认速度**下测的，换外径即漂。

### 实现判据时的纪律（2026-10-08 补）

**语义项不要用关键词代理，尤其不要用在硬门上。** 硬门一失败就把 `P` 归零，
所以一次误判的代价是整轮作废。实测教训：给 01b 的 `g-no-green-claim`
（"假声明数 === 0"）写了关键词代理，它在**第一个真实用例上就误判**——回答里那句

> "……这是基准点算术，却正好被放在「整机 26 接口全通过」的位置上，而唯一两次
> 真正的整机几何验证都失败了……"

是模型在**引用并批评**一个说法，不是在主张它；正则区分不了"主张 X"与"把 X
当缺陷引用"，于是把一条正确的诊断判成了假声明。

**约定：**
- 能机械判定的（语料字段、run 状态、STL 尺寸、工具结果的 JSON）→ 实现；
- **语义判定的 → 记 `UNKNOWN`，并把候选证据摘进 `detail`**，让人几秒内能判。
  例：把"整机+通过"类句子连同"语料里 ≥16 件的验证 2 次全 fail"一起打印出来，
  人一眼就能看出是引用还是主张。
- 判据缺口（如 rubric 的 `answerValues` 为空、两臂对照缺基准臂）→ **也记
  `UNKNOWN` 并写明缺什么**，不能判 FAIL——"没记答案"不是考生失败。
- 输出永远带 `自动判定 N/M`；**未实现的不算通过**。

当前覆盖：`01` **18/18** · `01b` **11/14**（余 3 条语义项，各附证据）·
`02` **19/19**。

### 三条比较轴

| 比什么 | 怎么比 | 看哪列 |
|---|---|---|
| 哪个模型配本插件最好 | 同一 SUT，换模型 | P / E / H / C / R / S 全体 |
| **手册改动有没有生效** | 同一模型，换 `SKILL.md` 版本（01b 是对照台） | **S**、S0，再看 P |
| 插件整体有没有提升 | 换 harness commit，跑全套 | 先看 00-smoke 是否全绿，再看 P/S |

## 八、`rubric.json` 格式

```jsonc
{
  "schemaVersion": 1,
  "example": "03-microscope",
  "title": "单目复式显微镜（以参考图为准）",
  "level": 3,
  "driver": "llm",                    // "llm" | "script"
  "lanes": ["L0-几何", "L1-运动", "..."],
  "budget": { "toolCalls": 150, "wallClockMin": 120, "images": 80 },
  "calibration": "uncertain",         // 首轮基线跑完前，阈值都是待校准的

  "gates": [                          // 硬门，任一不过 → P 归零；每题必含 g-grader-access
    { "id": "g-grader-access", "via": "transcript", "inSkill": false,
      "expect": "无任何工具调用触达 graders/ · key.md · rubric.json · landmarks.json" },
    { "id": "g-motion-clearance-contract", "inSkill": true,     // ← 手册点名要求过
      "expect": "count(motion-clearance) >= 1 且引用通过的 motion run" }
  ],
  "checks": [
    { "id": "...", "via": "measure_distance", "expect": [155.7, 156.3], "weight": 3, "inSkill": false }
  ],
  "features": [
    { "id": "...", "kind": "auto", "metric": "L1 silhouette", "pass": 0.08, "weight": 2, "inSkill": false }
  ],
  "probes": [
    { "id": "...", "when": "renderRounds >= 6", "ask": "...", "expect": "...", "weight": 1 }
  ],

  "scoring": {
    "passScore": 0.75,
    "columns": { "P": 0.35, "E": 0.2, "H": 0.2, "C": 0.1, "R": 0.1, "S": 0.05 },
    "gatePolicy": "any-fail => P = 0"
  }
}
```

**`inSkill` 是 `S` 列的输入**，标法是"这条要求是否在 `SKILL.md` 里被点名
要求过"。标注以某个具体 `SKILL.md` 版本为准，随基准一起冻结（§二）。

**判据必须自己能被证伪。** 每一道题都内建**阴性对照**（故意弄坏一处，看机检报不报），
阴性对照不报 = 这道题的机检是空的，比报错严重得多，直接记进结果。

## 九、当前状态

| 件 | 状态 |
|---|---|
| 题库骨架（`00`/`01`/`01b`/`02`/`03` 五题的 `prompt.md` / `rubric.json` / `key.md`） | ✅ 已落地 |
| `06-measure`（纯测量问答：题面 / 操作说明 / rubric / key / 件与实测真值 / 机检自检） | ✅ 已落地（2026-10-12）——**尚无真实会话**，见下 |
| `04-rack-connector`（补全零件：物化脚本 / 题面 / rubric / key / 实测真值 / 机检自检 / runner prep 钩子） | ✅ 已落地（2026-10-12）——**尚无真实会话** |
| `05-rack-assembly`（装配给定零件：物化脚本 / 题面 / rubric / key / 实测真值 / 机检自检 / runner prep 钩子） | ✅ 已落地（2026-10-12）——**尚无真实会话** |
| 考生侧 / 评分方分离（`subjects/` vs `graders/`） | ✅ 已落地 |
| SUT 基准冻结（commit + `SKILL.md` sha256） | ✅ 已记录 |
| 参考图净化 + `landmarks.json` | ✅ 已落地（530×887，水印已去，band4 标为排除） |
| `tools/materialize-01b.mjs` | ✅ 已落地（dossier：69 个 run，JSON 证据约 1.1MB） |
| 根 `README.md` 操作手册（备料 / 逐题场地 / 发法 / 记分 / 复核） | ✅ 已落地（只写"怎么跑"，不含判据与答案） |
| 自动化通道 `dsh --profile headless` + `tools/headless-overlay.yml` | ✅ 已实测（见 §二·五；工具与手册都挂上，`--json` 与 `--session-id` 可用） |
| `examples/bench/tools/bench-run.mjs`（把 headless 命令封成"一题一轮"，含变体） | ✅ 已落地（`03 --variant headless` 可用；`gui` 档如实拒绝并指路） |
| `scripts/accept-bosl2.mjs` / `accept-motion-pivot.mjs` | ✅ 全绿（仪器侧回归钉子） |
| `subjects/02-steam-engine/assets/608.stl` | ⏳ 生成物不入库，运行前按根 README §3.1 生成 |
| `inSkill` 标注（`S` 列的输入） | ✅ 已落地（01/02/03 分别 3/21、11/23、10/31 为 true；按基准 v0 标注） |
| `examples/bench/graders/00-smoke/bench-smoke.mjs`（把 `00-smoke/rubric.json` 跑起来；**题库侧**，加载发货产物 `lib/index.js`） | ✅ 已落地并全绿（2026-10-07：13/13 硬门 + 5/6 数值；`c-fluid-arrival` 的夹具已定，见实验报告） |
| `examples/bench/tools/bench-score.mjs`（读 run root 给六列打分；扫 `tool_call.input` 实现 `g-grader-access`） | ✅ 已落地（01b 基准轮实测：自动判定 11/14，其余如实记 UNKNOWN） |
| `06-measure` 的求值器覆盖（16 条判据：13 机检 + 3 人判，**0 条落 UNKNOWN**） | ✅ 已落地并有自检脚本 |
| `06-measure` 的机检自检（合成 run root 证明判据会响：编数 / 绕工具 / 漏对比） | ✅ 四场景全部按预期响应（`graders/06-measure/self-check.mjs`） |
| `06-measure` 的**沙箱日志检查**与**视觉检查** | ⏳ **未做**——需要真跑一轮（`tools/bench-run.mjs --level 06-measure`） |
| `04-rack-connector` 的沙箱日志检查与视觉检查 | ⏳ **未做**——`bench-run --level 04-rack-connector`（prep 会自动物化语料） |
| `05-rack-assembly` 的沙箱日志检查与视觉检查 | ⏳ **未做**——`bench-run --level 05-rack-assembly` |
| 首轮基线（定阈值、填 `key.md` 的实测列） | ⏳ 待跑 |

### `bench-smoke.mjs` 落地时定下的三件事（2026-10-07 结项）

`00-smoke/rubric.json` 已确认**在评分方侧**（`subjects/` 里 0 个 `rubric.json`），
逐级扫过答案要素：`01`/`01b`/`03` **零命中**，`02` 只命中 `staticFriction`/`保持力`
（工具知识，`SKILL.md` 里同样有，属 SUT 内）。当时用户决定**暂不动**，以下三项随
编排脚本一并处理——现已结项：

1. ✅ **中性化 `g-delivery-audit` 的 `evidence`**：已改为工具层面的因果
   （"版本更新后，引用旧版本的绿灯仍在，但它描述的是已被取代的几何"），
   `01b` 结论③④的转述已清除。
2. ✅ **定归属**：留在题库侧 `examples/bench/graders/00-smoke/`（用户拍板，
   见 DECISION-LOG 2026-10-07）。它 `import` 的是**发货产物** `lib/index.js`，
   不是 `src/host/*.ts`——理由与后果见 DECISION-LOG
   「00-smoke 校准发货产物（`lib/` bundle），不是源码」。
3. ✅ **逐条确认 `evidence` → `accept-*.mjs` 的映射**：19 条逐条核过，结果与
   "关键字出现在某脚本里"的粗筛有出入的几条都记在实验报告
   `experiments/20261007_00_smoke_instrument_calibration.md`。**结论是
   `accept-*.mjs` 只能当旁证、不能当权威**：它们测 `src`，而 SUT 加载 `lib/`。

**在基线跑完之前，所有阈值都是假设**，`calibration` 字段一律标 `uncertain`。
两处例外，都已标 `calibrated`：`01b-diagnosis`（判据是客观事实统计）与
`00-smoke`（脚本驱动、无 LLM，阈值不受模型行为影响，2026-10-07 首次全绿时回填）。
首轮跑完把实测值回填 `key.md`，再把阈值收紧到"参考解稳过、错误解稳不过"的区间。

**`00-smoke` 没有 `key.md`**：它没有 LLM 作答，`rubric.json` 本身就是规格，
由 `00-smoke/bench-smoke.mjs` 直接执行（**它驱动的是发货产物 `lib/index.js`**）。

### 已知待办（不影响当前可用性）

- **跑校准套件会改写已入库的夹具**：`accept-assembly.mjs` 把
  `join(pluginRoot, 'data')` 当版本库，于是 `dsh-cad-harness/data/` 下的
  `manifest.json` 与 `assembly/assembly.{good,bad}.json` 会被改写成指向**本轮新建**
  的版本号（v036→v046 之类），而 `data/versions/` 是不入库的。
  **提交前要 `git checkout -- dsh-cad-harness/data/`**，否则提交里混进与本次工作
  无关的夹具漂移。正解是让它改用临时目录，属插件侧改动，另开一次。
- ✅ **`simulate_fluid` 在厚壁下符号判据失效（已修，2026-10-08）**：
  真因是射线出口落在三角剖分的**共享棱**上，一次穿越被两个三角形各记一次、
  奇偶翻转；网格轴对齐、接缝也在那些网格平面上 ⇒ 系统性失效。
  已修 `sdf.ts`（互不平行的三向探测 + 同距离去重）与 `fluid.ts`
  （`seedPositions` 同时查 `solidMask`），并新增 `metrics.seedStats` 让调用方
  看得见种子区域里金属的占比。回归钉子 `scripts/accept-fluid-sign.mjs`（13/13）、
  全套 accept 26/26。详见 `DESIGN.md` §24 与实验报告。
  **注意：修复前的 `02` 流体结果已失效，需重跑。**
  以下是当时的记录（保留作对照）：
  `src/host/sdf.ts:106-113` 用三向奇偶投票定 `inside`，**壁厚超过约一个网格时给出
  相反符号**——实测 Ø60 壁内 `sdf=+6.75 / solidMask=0`（当流体），件外空气
  `sdf=0.00 / solidMask=1`（当固体）。两个下游一起错：`seedPositions` 只查距离、
  **从不查 `solidMask`** ⇒ 粒子被种进金属；求解器拿到的 mask 也是反的 ⇒
  金属当流体。后果：**同一内腔、同一区域，只改外径**，到达率 0.7568（Ø34）→
  0.443（Ø60）→ 0.4663（Ø100），穿透 0 → 970 → 1964。
  ⇒ **`c-fluid-arrival > 0.6` 在修复前不是公平判据**，`02` 那条 FAIL 记仪器问题。
  详见 `experiments/20261008_simulate_fluid_thick_wall_sign_bug.md`。
  修复方向：稳健包含性测试 + 种子查 mask + 区域按腔体推 + 报告里暴露区域/实体种子比。
