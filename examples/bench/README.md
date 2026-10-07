# examples/bench · 测评操作手册

> **本文件回答一个问题：怎么跑一轮测评。**
>
> 它**刻意不含"考什么"、判据与答案**——因为本文件位于考生侧上一层，是最容易
> 被读到的位置。内容约束见 [`graders/README.md`](graders/README.md) §四。
> 设计理由、判据（`rubric.json`）、答案（`key.md`）、六列评分与状态表，
> 全部在 [`graders/README.md`](graders/README.md)。

## 0. 全流程一句话

```
备料（一次） → 记基准 → 逐题开新会话、逐字发题面 → 每题跑 N≥3 轮
              → 每轮记分 → 收结果 → 复核（标的物与指纹）
```

---

## 1. 三个目录各自是什么

| 目录 | 是什么 | 会话能看到吗 |
|---|---|---|
| `subjects/` | **考生侧**。会话的 cwd 只能落在这里。只放**有考生**的题；每题目录里有考卷 `TASK.md` 与题面指定要考生看的素材 | ✅ 考生场地 |
| `graders/` | **评分方**。题面来源、判据、答案、操作说明、参考图、地标 | ❌ 绝不进会话 |
| `tools/` | 评分方工具：净化参考图、物化 01b 的待诊断语料 | ❌ |

`00-smoke` 是**仪器校准**，没有考生，因此没有考场、也不在 `subjects/` 下：
它的配方与判据在 `graders/00-smoke/`，由脚本在临时目录里直接驱动工具。

---

## 2. 基准（唯一权威副本，每次跑完都要记）

**被测系统 SUT = `dsh-cad-harness`（含 `cad-toolbox` skill 与工具描述）× 模型。**

| 项 | 基准值（2026-10-05 冻结） |
|---|---|
| git commit | **首次包含 `examples/bench/` 的那次提交**——`git log --diff-filter=A --format=%H -- examples/bench` 即可取到。（它的前一次是 `76b6661f`，只有插件侧、没有题库。）之所以不硬编码 hash：提交的 hash 无法写进它自己。 |
| `SKILL.md` sha256 | `8e2717f9694e6a1d5a5a18e26ced68fa9972f4e25304bcde476266618bc44da3`（313 行） |
| `01-mortise-bench/TASK.md` | `3c2a285a61c27b4f9131c3d47cd120e56811b1408be56619a424dff90f94ad89` |
| `01b-diagnosis/TASK.md` | `b4ed3957032b9a2e4d3ca8ce05b53bf6beff055dd89cd2efeeced348ad4e3509` |
| `02-steam-engine/TASK.md` | `e3768a0dff1aa916e7122fb6af8e4b1a40fb2b80ccfc6a9f7bc662bf3f2bcd48` |
| `03-microscope/TASK.md`（A 段 · **GUI 档**） | `93f602114329f2be53e0244f366e1f4f04e784f2ecea2e4f0888846d7792ccdb` |
| `03-microscope/TASK.headless.md`（A 段 · **headless 档**） | `c93d8db2054fb35310a9655ab1db8faa89c5789bdc35507a3d38a3f79e7a8d66` |
| `03-microscope/TASK-2.md`（B 段 · 两档共用） | `0a6207570d2b4b232133fff66236d272e162d06476356baebdb09d14c2c14e20` |

**为什么记这些**：只有 SUT 与考卷逐字一致，两轮分数才可比。改了考卷就必须重录
指纹并重跑基线——**旧分数作废**。

```bash
# 开跑前核对（考卷在考生 cwd 里，Agent 对它有写权限，所以每轮都要核）
sha256sum examples/bench/subjects/*/TASK*.md
# 与上表逐条比对，并把它写进当轮的分数文件
```

---

## 3. 备料（只做一次）

### 3.1 `02` 的导入件（必须生成）

`608.stl` 是生成物、不入库，运行前生成一次：

```bash
cd examples/bench/graders/02-steam-engine/assets
OPENSCADPATH=<repo>/lib openscad -o ../../../../subjects/02-steam-engine/assets/608.stl make-608.scad
```

考卷里写的是相对路径 `assets/608.stl`，相对 cwd 解析，所以位置必须对。
生成后先自己 `import_part` 验一次——**它不是闭合实体就会被拒收**，那是守卫不是障碍。

### 3.2 `01b` 的完整语料（可选）

`subjects/01b-diagnosis/dossier/` 已入库（JSON 证据，约 1.1MB），**只读证据就够了**。
只有要让它跑 `delivery_audit` 交叉核对时才需要完整语料：

```bash
node examples/bench/tools/materialize-01b.mjs corpus
```

### 3.3 `03` 的参考图（不用备，但别忘）

参考图源在 `graders/03-microscope/参考图.png`，**两档各自把它送到考生手里**：

| 档位 | 怎么送 |
|---|---|
| **GUI 档** | 作为**对话附件**随 A 段题面发出；`subjects/` 里**故意不放**（放了会绕过回收机制） |
| **headless 档** | `bench-run.mjs` 把它**复制进 run root**，题面写"工作目录下的 `参考图.png`" |

两档的分**不混算**——headless 档测不到 `recall_reference_image`。

### 3.4 换了参考图才要做的事

```bash
python3 examples/bench/tools/purify-reference.py <原图> examples/bench/graders/03-microscope/参考图.png
```

脚本会剥掉非主体碎片（水印）并重算 `landmarks.json`；**裁切后若仍残留碎片它会拒绝写文件**。

---

## 4. 每题的场地与题面

| 编号 | cwd（= 场地） | 考生题面 | 附件 | 素材 | 预设 | 预算（调用/墙钟/图片） |
|---|---|---|---|---|---|---|
| `00-smoke` | **无**（无会话） | 无 | — | — | — | 60 / 30min / 48 |
| `01-mortise-bench` | `subjects/01-mortise-bench/` | `TASK.md` | — | — | 造物模式 | 60 / 45min / 40 |
| `01b-diagnosis` | `subjects/01b-diagnosis/` | `TASK.md` | — | `dossier/` | 造物模式 | 12 / 15min / 4 |
| `02-steam-engine` | `subjects/02-steam-engine/` | `TASK.md` | — | `assets/608.stl` | 造物模式 | 120 / 120min / 70 |
| `03-microscope`（**GUI 档**） | `subjects/03-microscope/` | **两段**：`TASK.md` → `TASK-2.md` | `参考图.png`（对话附件） | — | 造物模式 | 150 / 150min / 80 |
| `03-microscope`（**headless 档**） | run root | **两段**：`TASK.headless.md` → `TASK-2.md` | runner 复制进 run root | 同上 | headless | 同上 |

**题面一律逐字发出，不加、不改、不解释、不补充。**
**`00-smoke` 不是给模型做的题**，它是仪器校准，见 §7。

---

## 5. 跑一轮的固定条件

缺一件，分数就不可比：

1. **新会话 + 空语料**：语料落在 `<cwd>/cad-data/`，所以每题天然一份独立语料。
   要重跑就删掉该目录。
2. **预设 = 造物模式**。**先把它设为默认预设再新建会话**——面板上的选择只作用于
   "当前那个空白会话"，不会继承给之后新建的会话。
3. **模型与路由**：同一模型、同一 reasoning 档位，记进分数文件。
4. **重复**：每个（模型 × 题目）跑 **N ≥ 3** 轮，报**中位数与离散度**。
   单次差异是噪声，不足以支撑结论。
5. **手别伸进考生目录**：不要在跑的过程里往 `subjects/<题目>/` 加删文件——
   那会让"这一轮到底喂了什么"说不清。
6. **不要人为贴或删 skill 正文**：手册出不出现由 SUT 自己的加载逻辑决定；
   它有没有被加载，是要记录的事实（记作 `S0`），不是要控制的变量。
7. **记时间**：开工时间、`/api/cad/usage` 的 `calls` 起点。
8. **M0 检查**：确认面板里零件列表是空的（否则你复用了旧语料）。

---

## 6. `03` 是两段的，别一次发完

`03` 的 A 段只给规格，B 段才给验收要求。**两段之间有必须核对的前置条件。**

```
发 A 段（TASK.md，带参考图附件）
  → 等它把 M1–M4 做完、停下来
  → 逐条核对 graders/03-microscope/prompt.md 里的前置条件
  → 发 B 段（TASK-2.md）
  → 分别打 A 分与 B 分，再算差值
```

**B 段那条消息的时间戳就是评分分界**：之前的 run 归 A，之后的归 B。

三条纪律：

- **发 B 段前不要与模型讨论 A 段的结果**——那会让第二段的结果不再干净。
- **前置条件必须真的核对**，不能默认成立；不成立时对应项记 `N/A`，并在结果里注明。
- **A 段题面发出前，确认首条消息真的带上了图**。漏了不会报错——模型只会照着文字
  硬猜外形，然后一路绿灯交卷。这是整条链上唯一靠人记得的环节。

其余三题都是一段，发完等它收尾即可。

---

## 7. 仪器校准（`00-smoke`）：先跑它，再跑题

```bash
# 1) 先确保发货产物是当前源码构建出来的 —— 它检验的是 lib/index.js，不是 src
cd dsh-cad-harness && node esbuild.mjs && cd ..

# 2) 跑校准（无会话、无模型调用；临时目录里直接驱动工具，跑完自删）
node examples/bench/graders/00-smoke/bench-smoke.mjs
```

**它全绿之前，跑出来的任何评测分数都不作数。** 理由：一次失败的评测无法区分
"插件退化了"与"模型变笨了"，两者都表现为"分数掉了"，处置却相反。

`bench-smoke.mjs` 的期望行为表是 `graders/00-smoke/rubric.json`：13 条硬门 +
6 条数值。**判据只有那一份**——脚本读它执行，不复制它；rubric 里声明而脚本没
实现的条目会被记 FAIL（判据覆盖有洞）。结果落在 `graders/00-smoke/scores/`。

> ⚠️ **第 1 步不能省。** 脚本加载的是 `package.json` 的 `main`（`lib/index.js`），
> 而 `scripts/accept-*.mjs` 直接 `import` 的是 `src/host/*.ts`——**两者不是同一个
> 被测对象**。改完源码不重建，accept 套件会全绿而仪器实际是坏的。这不是假设：
> 2026-10-07 的前置条件核查正是抓到这个（`compile.ts` 已修的 BOSL2 接线没进
> bundle，而 `accept-bosl2.mjs` 因为读源码所以照旧全绿）。所以
> **`accept-*.mjs` 绿 ≠ 仪器可用**，二者不可互替。

**旁证：插件侧回归套件。** 它们测源码、随插件版本走，是另一条独立证据：

```bash
cd dsh-cad-harness
for s in scripts/accept-*.mjs; do
  node "$s" >/dev/null 2>&1 && echo "PASS $(basename $s)" || echo "FAIL $(basename $s)"
done
```

**这套旁证的判据是 25/25 全绿。** 有 FAIL 就去查是**插件退化**还是**检查过期**——
2026-10-05 的基线跑抓到的第一个 FAIL 就是后者（`accept-tool-scope.mjs` 在验一个
上游已删除的包，那一段还因此 SKIP 掉了一条本该覆盖的断言）。仪器发红时，
**先修仪器再跑模型**。

常用开关：`--skip-fluid`（跳过 MPM 那一步，对应两项记 skip）、`--fluid-steps <n>`、
`--keep`（保留临时目录）、`--json`。

---

## 8. 每轮要记的东西

写到 `graders/<题目>/scores/<模型>-<时间戳>.json`（该目录已 gitignore）。
`03` 写两份（`-A` / `-B`）外加一份 `-delta`；`01b` 的分轮方式见
`graders/01b-diagnosis/prompt.md`。

**必备字段：**

```jsonc
{
  "example": "03-microscope",
  "model": "…", "reasoningEffort": "…",
  "startedAt": "…", "wallClockMin": 0,
  "sut": { "gitCommit": "…", "skillSha256": "…" },
  "taskSha256": ["…", "…"],          // 03 是两段
  "s0": true,                         // skill 是否被加载（transcript 可观测）
  "toolCalls": 0, "images": 0, "imagesPruned": 0,
  "columns": { "P": 0, "E": 0, "H": 0, "C": 0, "R": 0, "S": 0 },
  "gatesFailed": [], "falseClaims": [],
  "notes": "…"
}
```

**六列怎么算**见 [`graders/README.md`](graders/README.md) §七。要点：

- **`gates` 是硬门**，任一不过 → 该题 **P 记 0**，其余列照记（用来解释为什么没过）；
- **`S` 只对"手册点名要求过"的条目计权**（哪些算，标注在 `rubric.json` 里）；
  `S0 = false`（手册没被加载）时 `S` 记 `N/A`；
- **`03` 的 A/B 两段分别记分**，不要合并。

---

## 9. 跑完的复核清单

- [ ] `sha256sum subjects/*/TASK*.md` 与 §2 的基准一致（不一致 → 上一轮会话改过考卷，
      从未污染的副本恢复后重跑）
- [ ] `graders/` 没有被读过：检查 transcript 里有没有触达 `graders/`、`key.md`、
      `rubric.json`、`landmarks.json` 的调用（各题 `g-grader-access` 硬门）。
      触达即该轮作废。
- [ ] 阴性对照**真的报错了**，而且改回之后**真的回到 pass**
- [ ] `03`：A 段那条消息带图；A→B 的分界时间戳已记录；前置条件核对结论已记录
- [ ] 分数文件写全了 §8 的字段
- [ ] 复制 `subjects/<题目>/` 下这一轮产出的机读文件（`joinery.json` /
      `motion.json` / `stability.json` / `optics.json` / `printability.json`）
      到 `graders/<题目>/scores/` 一起归档——它们是判据的输入

---

## 10. 常见错误

| 症状 | 原因 | 处置 |
|---|---|---|
| 分数高但看图一眼假 | 只看绿数字、没看渲染 | 交付纪律第 1 条；`graders/README.md` §四 |
| 结论看着成立，但证据对不上 | 结论引用的版本/运行与交付版本不一致 | 复核时逐条问"它验证的是哪个版本"；判据见 `graders/README.md` §七 |
| `03` 的外观分对不上 | A 段没带图 / 视角不统一 | 重跑；冻结相机的规格在 `TASK.md` 里 |
| `02` 的 `assets/608.stl` 找不到 | 忘了 §3.1 备料 | 生成后再开跑 |
| 两轮分数差很多但代码没改 | 起点不干净（复用了旧语料） | 删 `<cwd>/cad-data/` 重跑 |
| skill 好像没生效 | 先看 `S0`：它被加载了吗 | `S0=false` 本身就是一条发现 |

---

## 11. 这份文件里没有的东西

| 想看什么 | 去哪 |
|---|---|
| 每道题**考什么**、为什么这么排 | [`graders/README.md`](graders/README.md) §三 |
| 判据（`rubric.json`）与答案（`key.md`） | `graders/<题目>/` |
| 六列评分与三条比较轴 | [`graders/README.md`](graders/README.md) §七 |
| 边界规则：什么算泄露、`graders/` 的写法约定 | [`graders/README.md`](graders/README.md) §四 |
| 每题的详细操作说明（`01b` 的分轮、`03` 的两段与前置条件） | `graders/<题目>/prompt.md` |
| 自动化跑法为什么这么设计、它算哪一档基准 | [`graders/README.md`](graders/README.md) §二·五 |
| 评测跑在什么沙盒里、读写边界各到哪 | 本文件 §12.5 |
| 当前状态与待办 | [`graders/README.md`](graders/README.md) §九 |

> **往本文件里加东西前先读 `graders/README.md` §四。** 它位于考生侧上一层，
> 任何"圈重点"式的措辞都会变成泄露。

---

## 12. 自动化通道：`dsh --profile headless`

> **可选。** 按 §3–§9 手工跑同样有效；自动化是为了消掉人工误差，并让不同模型
> 可并行对比。

### 12.1 它是什么

`dsh` 自带一个非交互入口（`@deepseek-ai/dsh-headless`）：**跑一个任务、打印答案、
退出**——不开端口、不留进程。`~/.dsh/profiles/headless/` 里已经链好了本插件。

三个能力正好对上人工误差的每一处：

| 人工误差 | headless 怎么消掉 |
|---|---|
| 粘错题面、手改措辞 | 题面走 **stdin 逐字**（`< TASK.md`），配合 §2 的指纹可验 |
| 预设选错（标准 vs 造物） | 由 profile + overlay 固定，不再依赖"先设默认预设再新建会话" |
| 忘了跑 N≥3 | 脚本循环 |
| `03` 的 A/B 分界靠人记时间戳 | **`--session-id` 续同一会话** → 两次调用两份 JSONL，天然分界 |
| 忘记录成本 | `step_end` 事件自带 `usage`（input/output/cache token） |
| 复用旧语料 | run root 每轮新建 |
| 误触 `graders/` | run root 开在**仓库外** → 考生目录里没有任何评分方材料，探索工作区时**不会顺带发现**它们（注意：这不等于隔离，见 §12.4） |

### 12.2 命令形态

```bash
RUN=$(mktemp -d /tmp/bench-01-XXXX)          # run root 在仓库外
cp -r examples/bench/subjects/01-mortise-bench/. "$RUN"/

cd "$RUN"
# 第一段：**不要**带 --session-id —— 它只"认领已存在的会话"，未知 id 会直接报错。
# 让 dsh 自己新建，它会在开头的 session 事件里报出真 id。
dsh --profile headless \
    --patch /abs/path/examples/bench/tools/headless-overlay.yml \
    --json < "$RUN/TASK.md" > "$RUN/A.events.jsonl"
# 取回 id 后，第二段才用它继承同一会话：
#   dsh --profile headless --patch … --json \
#       --session-id "$(jq -r 'select(.type=="session").sessionId' "$RUN/A.events.jsonl" | head -1)" \
#       < "$RUN/TASK-2.md" > "$RUN/B.events.jsonl"
# exit 0 = 该段完成；1 = 中止或出错
```

**上面这一串已经封成脚本**（[`tools/bench-run.mjs`](tools/bench-run.mjs)）：建 run root、
复制考生侧、核对考卷指纹、查素材、生成当轮 model overlay、逐段跑、落事件流与
`run-record.json`。先 `--dry-run` 看它要跑什么，不花模型调用：

```bash
node examples/bench/tools/bench-run.mjs --level 01-mortise-bench --dry-run
node examples/bench/tools/bench-run.mjs --level 01-mortise-bench \
     --model deepseek-official/deepseek-flash --repeat 3 --tag m1
```

（`03` 目前会被它**拒绝**并打印待办：headless 没有附图通道，它的 headless 版考卷
还没出。）

`--json` 是 NDJSON 事件流，字段正是打六列要用的：

| 事件 | 带什么 |
|---|---|
| `session` | `sessionId` + `cwd`（**存下来，`03` 第二段要用它续**） |
| `status` | `turn_start` / `step_start` / **`step_end.usage`** / `turn_end.reason` |
| `tool_call` | `{callId, tool, input}` —— **`input` 带完整参数**，`g-grader-access` 直接扫它 |
| `tool_result` | `{callId, status, result}`（字符串按 8 KiB 截断） |
| `text` / `thinking` / `final` | 正文；`final` 不截断 |

### 12.3 必须带那个 overlay

**headless 组出了 CAD 的「工具」，但没组出 CAD 的「手册」。** 手册那一行嵌在
`cad` 预设的 `plugins:` 里，而 headless 没有 compose 预设注册表——实测 stderr：

```
dsh: warning: 1 entry did not activate
preset-cad (@deepseek-ai/dsh-agent-preset): pending (waiting for service: agentPresets)
```

不补的话 `S`/`S0` 失去意义（手册根本不在上下文里）。
[`tools/headless-overlay.yml`](tools/headless-overlay.yml) 在 profile 平面把手册根接回去，
并顺带承担**每轮钉模型**的职责（改 `agent-default-model` 那两行）。

### 12.4 隔离

| 要隔离的 | 怎么做 | 够到什么程度 |
|---|---|---|
| 顺带发现 `graders/` | run root 开在仓库外（`mktemp -d /tmp/...`） | 考生目录里没有评分方材料，探索时不会撞见 |
| 语料 | run root 里自然只有它自己 | 干净，无需手工删 |
| 会话与附件 | 隔离的 `DSH_HOME`（可选；同一轮的两段必须用同一个） | 会话不混入日常 |

> ⚠️ **run root 在仓库外 ≠ 隔离。** Agent 有 bash，能读绝对路径，`ls /` 一样能
> 发现仓库。上面做的只是**消除顺带发现**。真正的物理隔离需要容器、独立挂载或
> 独立机器——**在那之前，`g-grader-access` 这条检测仍然必要**
> （实现上现在更简单：直接扫 `tool_call.input`，不必解会话日志）。

### 12.5 评测跑在**文件沙盒**里（连带三条后果）

**这不是我们加的，是 `dsh` 出厂就有的。** headless profile 组了 `dsh-base`，而
`dsh-base` 组了整套沙盒（`dsh-sandbox-policy` + `dsh-sandbox-local` +
`dsh-bash-sandbox` + `dsh-fs-sandbox` + 审批与权限预设）。实测组合：

```yaml
- id: sandbox-policy
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
    workspaceRoot: !!js process.cwd()          # ← headless 下就是 run root
- id: bash-sandbox
  config: { timeoutMs: 60000 }                 # ← 每条 bash 命令 60 秒上限
- id: approval
  config: { policy: "… === 'danger-full-access' ? 'never' : 'ask'" }
```

所以一次 headless 评测的实际边界是：

| | 边界 | 对评测的意义 |
|---|---|---|
| **写** | 只能写 `workspaceRoot` —— cwd，也就是 **run root**（加平台临时区） | **Agent 改不到真实仓库**：`subjects/` 的原件是只读的。手工 GUI 档里工作区**就是** `subjects/<题目>/`，它可写——所以那条路每轮都得核指纹；自动化这条路天然免疫 |
| **读** | **不受限**（`dsh-fs-sandbox` 的原话：confines writes and edits "**while preserving the local filesystem's read behavior**"） | `g-grader-access` 仍然必要。这是设计如此，不是配置能关的 |
| **bash** | 每条命令 `timeoutMs: 60000` | CAD 的渲染/仿真可能超 60 秒 → 要让它进 job/后台，别在一条命令里硬等 |
| **升级** | 命中拒绝后模型可申请一次更宽的模式（`sandbox_permissions` + `justification`），需人工批准；审批策略是 `ask` | **headless 没有可应答的人 → 请求 fail closed**，它**不可能**自己放宽。好事（没有未经审阅的写），但要留意首轮出现拒绝 |

**想让"读"也关掉，只有两条路**：给上游提一个 read-jail 模式（Landlock/Seatbelt
本身支持读限制，但当前模式词汇是 **file-effect only**，是设计边界不是配置）；
或者**套容器**：`docker run` 只挂 run root，仓库根本不进容器，绝对路径也就解析不到。
代价是镜像里要有 node + dsh + 本插件 + **OpenSCAD**。

### 12.6 三条纪律

1. **headless 是"功能等价近似"，不是同一个 SUT。** 它少了"会话命名预设"那一层
   composition。所以它在基准里**单列一档**，分数**不与 GUI/造物模式混算**。
2. **`03` 有两个档位，别混算。** headless 档走 `--variant headless`（参考图由 runner
   复制进 run root）；GUI 档保留**附件**语义，走手工（§5–§7）。
   headless **没有附图通道**——`dsh-headless` 的配置 schema 就是
   `Config = { task, sessionId, json }`（`files` 是 `filesystem` 的误命中）。
   **但 GUI 档不能丢**：只有附件档才会触发 `recall_reference_image`，那是插件的
   一条真实能力，丢了就没人测它了。
3. **第一段不带 `--session-id`，第二段带第一段报出的那个 id。**
   `--session-id` 是"**认领一个已存在的会话**"——未知 id 直接报错（实测踩过）。
   两段还必须**同一个 cwd、同一个 profile**：继承会话时 headless 会校验这两项，
   不一致会在任务开始前就失败。`bench-run.mjs` 已经把这个顺序写死了。
