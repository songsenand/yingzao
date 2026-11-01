# 项目身份与隔离：从 cwd 到最近标记（B 方案）

> 状态：**B 已落地，C-lite 已落地，准生产阶段封版**：Phase 1 resolver + 测试 `a935778`；Phase 2 面板按标记发现 `e47fadd`；Phase 3 `projectCwdOf` 切 resolver + 删 `00a6013` 桥 `628ef7b`；C-lite 会话绑定 `48c1f09`。根 `cad-data` / `assembly` 别名已清理。**C-lite 为当前交付边界；`init_project` / `project_info` 已补上头less 的创建与可见性；C 的创建/切换 UI 与 D 暂缓，缺口触发器见 §6.4。**

## 0. 定位：B 是过渡阶段，不是最终形态

B 解决的是**准生产力工具**档：单用户、本地、项目数十个以内，不需要权限、共享、审计或跨机。它把 cwd 直连的路径耦合收敛成一个 resolver，成本低、可回退，足够支撑当前的分子示例与子智能体工作流。

但 B 仍是**路径身份**：项目移动/改名会换身份；没有权限、共享、审计；一个会话可以 `cd` 切换项目。大型项目/多人协作跑不掉，最终形态是 **C + D**：

| 阶段 | 定位 | 解决 | 不解决 |
|---|---|---|---|
| **B（现在）** | 准生产、过渡 | 子智能体、嵌套、面板、符号链接 | 移动/改名、多人、权限、跨机 |
| **C（中期）** | 生产单人/小团队 | 会话显式绑定项目，`cd` 不误切换；子智能体显式继承/覆盖 | 移动/改名、多人权限（需 D） |
| **D（长期）** | 生产多人/大型项目 | 稳定 `id` + 注册表 + 权限/共享/审计；按 id 选择，不按路径 | — |

**B 的 resolver 在 C/D 仍然有用**：它负责“从起点找到项目根/标记”；C/D 把“项目是谁”从路径换成 `id`，resolver 只是定位器。不要在 B 阶段过度投资路径 hack，也不要在准生产档硬上 C/D。

## 1. 问题

### 1.1 现状

- 项目根 = 会话 cwd：`projectDataDir(cwd) = <cwd>/cad-data`（`src/host/project.ts:54`）。
- 工具侧从 `exec.agent.session.header.cwd` 取项目（`src/host/project.ts:123`）；`00a6013` 起对 `delegationDepth > 0` 的会话改读 workingDirectory，这是过渡桥。
- `cad-data/project.json` 由 `ensureProjectDir` 在**第一次写**时落盘，记录 `cwd` / `key` / `title` / `createdAt`（`src/host/project.ts:193`）。
- 面板在会话 cwd 下**两层**内找 `<dir>/cad-data`（`src/host/workspaces.ts` 的 `MAX_DEPTH = 2`）。

这套模型把三件事绑在一个字段上：**进程在哪（working directory）**、**会话属于哪个 workspace（header.cwd）**、**语料属于哪个项目（project root）**。

### 1.2 已经发生的事故

| 事故 | 症状 | 根因 |
|---|---|---|
| 葡萄糖子智能体写错语料 | 7 个版本 / 30 个 run 写进 `examples/toy-balance2`，后来用 `migrate_corpus.py` 搬回 | 子智能体 header.cwd 是仓库根，插件按 header 取项目 |
| 果糖第一次注册失败 | 子智能体 `pwd` 是 `fructose-molecule`，`import_part` 却报 `ENOTDIR: mkdir '…/ToyMarker/cad-data'`；第一次 47 步 / 5.5 min 失败，重试 45 步 / 7.0 min 才成功 | 同上；父会话临时改根 `cad-data` 符号链接，目标目录不存在 |
| 面板看不到果糖 | `examples/ball-and-stick/fructose-molecule` 是第 3 层，`MAX_DEPTH = 2` 扫不到；只能加根目录别名 | 发现范围按深度，不按项目标记 |
| 葡萄糖搬目录 | `project.json.cwd`、run 的 `manifestPath` 仍指向旧路径 | 身份是路径，路径一改就断 |

### 1.3 成本 / 收益

**收益**：零配置；`cd` 即上下文；删目录即删语料；会话日志与面板天然对齐；不需要注册表。

**成本**：项目身份是**隐式**的，而且路径有多个含义（header.cwd / workingDirectory / 项目根）。每增加一个场景就要补一条规则：

- 子智能体 → 改根符号链接 / delegationDepth 特判；
- 嵌套项目 → 面板深度 / 根别名；
- 目录迁移 → `project.json.cwd`、run 的绝对路径、迁移脚本；
- 子智能体 `cd` 进 `spec/` → 会在 `spec/` 里新建语料（当前修法的盲区）。

结论：**cwd 是好的“选择器”，不是好的“身份”**。单项目单会话时收益压倒成本；多分子、子智能体、示例嵌套、目录迁移一出现，成本就不匹配了。

## 2. 需求

1. 每个项目有自己的 `versions/`、`runs/`、`assembly/`；版本号 / run 号项目内自洽。
2. 选择项目仍然零配置：`cd` 到项目（或其子目录）就是选择它。
3. 子智能体用 `subagent({cwd})` 指到项目根或子目录时，CAD 工具写到同一个项目，不需要符号链接。
4. 嵌套项目（如 `examples/ball-and-stick/<molecule>`）可被面板发现，不受“两层”限制。
5. 不静默跨项目写；第一次写要能看见解析出的项目根。
6. 项目可整体拷走 / 归档；删目录即删项目。
7. 目录移动 / 改名后的稳定身份是后续目标（C/D），B 不承诺。

## 3. 决策：B（最近标记）

### 3.1 定义

- **项目身份 = 最近的、包含 `cad-data/project.json` 的祖先目录**。标记的父目录就是项目根。
- **cwd 只是选择器**：从 Agent 的当前工作目录开始向上找；第一个标记胜出。
- **没有标记**：当前工作目录是“新项目候选”；第一次**写**才创建 `<cwd>/cad-data/` 和标记。读取不创建。
- **workspace 是容器**：目录里有 `cad-workspace.json`（且没有 `cad-data/project.json`）时，解析结果是
  **workspace**，不是项目；写路径在 workspace 根上直接拒绝。项目必须在其子目录里显式建 marker。
- **写目标 fail-closed**：未绑定会话的 cwd 在祖先项目内、自己无 marker 时，首次 CAD 写被拒绝；
  必须 `init_project` 或 `bind_project`。不再静默绑祖先，也不事后搬语料。
- **嵌套项目**：目录自己带标记就胜出；要建嵌套项目，必须显式创建标记，不能靠“碰巧在父项目里”。
- **符号链接不再用于项目切换**；根 `cad-data` / `assembly` 别名已清理。

### 3.2 解析规则

`resolveProjectRoot(start)`：

1. `canonical = realpath(start)`（解析符号链接；失败则 `resolve(start)`）。
2. 从 `canonical` 向上逐级：
   - `<dir>/cad-data/project.json` 存在 → 返回 `<dir>`（新式标记）。
   - `<dir>/cad-data/` 存在但没有 `project.json` → 返回 `<dir>`，标记为 **legacy**；第一次写时补写 `project.json`。
   - `<dir>/cad-workspace.json` 存在（且没有上面的 cad-data）→ 返回 `<dir>`，标记为 **workspace**；写路径拒绝。
3. 到文件系统根都没有 → 返回 `canonical`，标记为 **new**；第一次写时创建 `cad-data/project.json`。

规则要点：

- **最近优先**：子目录里有自己的标记，就用子项目；否则用父项目。
- **legacy 兼容**：老语料没有 `project.json` 也能继续用；补标记不搬数据。
- **不读 `project.json.cwd` 来解析**：标记的**位置**才是权威；`cwd` 只是记录，目录移动后可能过期。
- **不向上越过文件系统根**；每级只做一次 `exists`，结果按 canonical 缓存。
- **第一次写回显**：写结果带 `project` / `store` 根，误判当场可见（不是替代解析，是安全网）。

### 3.3 场景表

| 场景 | 解析结果 |
|---|---|
| 顶层会话在项目根 | 项目根 |
| 顶层 `cd` 进 `spec/` | 同一个项目（最近标记在父级） |
| 顶层 `cd` 到兄弟项目 | 兄弟项目（它有自己的标记） |
| 顶层 `cd` 到 `/tmp/new`（无标记） | `/tmp/new` 作为新项目候选；第一次写才创建 |
| 子智能体 `cwd` = 项目根 | 项目根 |
| 子智能体 `cwd` = 项目子目录 | 同一个项目 |
| 子智能体 `cwd` = 兄弟项目 | 兄弟项目 |
| 父项目里显式建了嵌套标记 | 嵌套项目（最近优先） |
| 父项目内的子目录，自己无标记 | **不是可写目标**：未绑定会话的首次 CAD 写被拒绝，要求 `init_project` 或 `bind_project` |
| 根有 `cad-workspace.json` | **workspace**：容器，不是项目；写路径拒绝，项目在其子目录 |
| 老语料只有 `cad-data/`、无标记 | 该项目根；第一次写补标记 |
| 符号链接路径 | 先 realpath，再按真实路径找标记 |

> C-lite（2026-10-28）在 B 之上加了会话绑定：第一次 CAD 调用后，上表的“切换”只对
> 新会话/未绑定会话成立；已绑定会话 `cd` 不切换。
>
> **写目标 fail-closed（2026-11-01）**：未绑定会话的 cwd 在祖先项目内、自己却没有 marker 时，
> 首次 CAD 写直接拒绝（不静默绑祖先、不事后搬家）。选择是显式的：`init_project` 把当前目录
> 变成项目，`bind_project` 明确选择祖先项目，或 `cd` 到项目根。`project_info` 的 `ambiguous`
> 会提前说出这个状态。

### 3.4 不做什么

- 不做稳定 `id` / 注册表（C/D）。
- 不做“一个会话同时属于多个项目”。
- 不把 `cd` 当项目切换的唯一手段；`cd` 只是改变起点，标记决定边界。
- 不用符号链接、根别名、`MAX_DEPTH` 特判来补项目切换。
- 不重写历史 run 的绝对 `manifestPath`；那是历史证据。

## 4. 落地

### 4.1 API

- 新增 `resolveProjectRoot(start): { root, marker: 'project' | 'legacy' | 'workspace' | 'new' }`；同步实现（`existsSync` + 缓存），放在 `project.ts`。
- `projectStoresFor` 走 `resolveProjectCwd(exec, { requireExplicit: true })`：workspace / 未标记子目录直接拒绝；
  `projectCwdOf` 保持宽松（读/测试）。`init_project` / `bind_project` 不走 `projectStoresFor`。
- `projectCwdOf(exec)` 改为：
  1. 取 Agent 的 **workingDirectory**（`agent.ctx.get('workingDirectory').get(agent.session)`）；没有 service 时回退 `session.header.cwd`；
  2. 对起点调用 `resolveProjectRoot`，返回 `root`。
  - **不再按 `delegationDepth` 特判**；B 落地后 `00a6013` 的桥删除。
- `projectStores(root)` 不变：调用方传**已解析的根**；`projectDataDir(root)` 仍是 `<root>/cad-data`。
- `ensureProjectDir(project)`：标记写在 `<root>/cad-data/project.json`；`project.json.cwd` 写解析后的根，不写起点。
- 面板 `discoverWorkspaces`：从“两层内找 `<dir>/cad-data`”改为“按标记扫描”（`cad-data/project.json`，legacy 的 `cad-data/` 也算），保留 `SKIP` / 目录数上限；不再用 `MAX_DEPTH = 2` 作为项目边界。

### 4.2 兼容与迁移

- 现有 6 个 example 已有 `project.json`（葡萄糖、果糖、toy-balance、toy-balance2、microscope5、multirotor-propeller）；其余老语料按 legacy 处理，**不需要搬数据**。
- legacy 语料（只有 `cad-data/`）第一次写补标记；读取照常。
- 根 `cad-data` / `assembly` 符号链接、`fructose-molecule` 根别名：**已在 2026-10-28 收尾时清理**；查看用 cwd 指向分子目录或 `?project=`。
- **2026-11-01 收口**：根 `cad-data`（v001–v007 + frog 副本）与根 `assembly/` 已清理；校准/简易件归档到
  `docs/archive/cad-calibration-2026-11-01/`，frog 只保留 `examples/windup-frog/cad-data/`；根改为
  `cad-workspace.json` 容器。
- `project.json.cwd` 过期不自动改写；等 C/D 的稳定 `id` 再处理迁移。
- `docs/llm/conventions.md` 的“子会话 CAD 项目跟随 working directory”在 B 下仍然成立，但描述改成“最近的 `cad-data/project.json`”。

### 4.3 面板

- 只读扫描，不创建标记；新项目在第一次写之前不出现在面板（和现在“空语料”一致）。
- 扫描顺序稳定（路径序）；同一项目只出现一次（realpath 去重）。
- 目录数上限、`SKIP` 列表保留，防止把 `node_modules` 扫进来。

### 4.4 测试

- 单元（`accept-project-scope` 扩展或新 `accept-project-root`）：
  - 根 / 子目录 / 兄弟项目 / 无标记 / legacy / 符号链接 / 权限失败。
  - `projectCwdOf`：workingDirectory 优先、无 service 回退 header、无 agent 回退 process.cwd。
- 集成：
  - 子智能体 `cwd` = 项目根 / 子目录 → 写同一个 `cad-data`；
  - 顶层 `cd` 进子目录 → 不新建语料；
  - `cd` 到兄弟项目 → 切换；
  - 新目录第一次写 → 创建标记；
  - 面板能发现第 3 层及更深的项目。
- 回归：`accept-project-cwd` 改成 B 的语义；`accept-project-scope` 全过；`npm run accept` 全过。

## 5. 风险

- **行为变化**：在项目子目录里调用工具，现在会归到父项目；这是 B 的目的，但会改变“子目录 = 新项目”的旧习惯。
- **legacy 误判**：任何名为 `cad-data/` 的目录都会被当成项目标记；本仓库里这是约定，但外部目录可能误伤。用 `project.json` 优先、legacy 只做兼容，并在第一次写时补标记。
- **向上越界**：cwd 在某个父项目内部时，会归到那个项目；这是“最近标记”的定义，不是 bug。
- **符号链接 / 权限**：realpath 失败、目录不可读时回退到起点；需要测试。
- **性能**：每次解析向上 `exists`；按 canonical 缓存，写入新标记时失效。
- **身份仍是路径**：移动/改名仍会换项目；B 不解决，C/D 才解决。

## 6. 中长期路线（C/D）

### 6.1 C：会话显式绑定（中期）

**最终形态**：会话创建时确定 `projectId` / `projectRoot`；工具从绑定取项目，`cd` 只改工作目录；子智能体继承或显式 `project` 覆盖；需要切换时用显式命令/新会话。

**C-lite（先落地，2026-10-28）**：不改 DSH 会话创建/UI，插件在**第一次 CAD 工具调用**时把 B 解析出的项目根写入
`$DSH_HOME/cad/sessions/<sessionId>.json`，之后该会话固定用它。
- 子智能体独立绑定：`cwd` 在父项目内 → B 找到父项目（等同继承）；`cwd` 指向别的项目 → 绑定那个项目（等同显式覆盖）。
- 显式切换：新会话；创建时选项目的 UI 是后续层。
- **写目标显式**：`init_project` 创建 marker；`bind_project` 显式选祖先；两者都不复制/移动语料。
  未绑定且 cwd 在祖先项目内的子目录，首次写被拒绝（避免“写错到根、再搬家”）。
- 项目移动/改名：C 不解决，D 的稳定 id 才解决。
- 代价：插件私有 sidecar；无 DSH core 改动；无 `tools.ts` schema 改动，便于两条线并行。
- **G5 修正（2026-10-29）**：B 解析的"当前 cwd"此前读的是 `agent.ctx.get('workingDirectory')`——真实
  exec 上不存在这个形状，静默回退到会话头 cwd，C-lite 于是把**错误的根**固定了一整个会话
  （roberval-balance：语料落在仓库根，靠手工搬家）。现在插件经 `inject` 注入 DSH 的
  workingDirectory 服务（与 stock bash 工具同一来源 `ctx.workingDirectory.ensure(agent, signal)`），
  首绑解析的是会话的**实时** cwd；且首次绑定会在该次工具回复的 warnings 里回显绑定路径与
  解绑方法（删 `$DSH_HOME/cad/sessions/<id>.json`），绑错从"永久静默"变成"当场可见"。

### 6.2 D：稳定 id + 注册表（长期）

- `project.json` 增加稳定 `id`（UUID），路径只是 `root`；移动/改名只改 `root`，`id` 不变。
- 注册表（`$DSH_HOME/cad/projects.json` 或 DB）记录 id/root/owner/permissions；面板按 id 列表；run/assembly 引用 id。
- 多用户：权限、共享、审计、并发写、跨机同步。
- 解决：移动/改名、多人协作、跨机、权限；B/C 的路径身份退化为“定位缓存”。
- 代价：迁移、注册表一致性、权限模型、并发；不是当前该做的。

### 6.3 实施顺序（2026-10-28 用户定）

1. B resolver + 测试（不改行为）。**已完成（`a935778`）。**
2. 面板按标记发现。**已完成（`e47fadd`）。**
3. 删 `00a6013` 的 delegationDepth 桥 + 根 `cad-data` / `assembly` 别名；`projectCwdOf` 统一走 resolver。**已完成（`628ef7b`；根别名已清理）。**
4. C：会话显式绑定。**C-lite 已完成（`48c1f09`）；创建时选项目的 UI 留到下一层。**
5. D：稳定 id + 注册表 + 权限。

B 在准生产档够用；C/D 是最终形态，不要因为 B 够用就停在 B，也不要在 B 阶段过度投资路径 hack。

### 6.4 准生产封版与 C-lite 缺口触发器（2026-10-28）

**封版**：准生产阶段到此为止。C-lite 是当前交付边界，不再实现 C 的创建/切换 UI 或 D 的稳定 id/注册表。
2026-10-31 补：`init_project`（只写 marker，不 rebind）与 `project_info`（boundRoot/liveCwd/mismatch）
已落地，覆盖“新建子项目”和“知道绑到哪”两个缺口；这仍属 C-lite，不需要 C/D。
2026-11-01 补：写目标 fail-closed + `bind_project`；未标记子目录的首次写被拒绝，不再产生
“先写根、后搬家”的路径。语料复制仍不是合法操作；一个项目最终只应有一份 canonical corpus。

**触发条件（看到任一，提示用户补 C/D，不要绕）**：

1. 同一会话需要切换项目（`cd` 到兄弟项目，或工具需要另一个项目）；
2. 项目移动/改名，旧会话仍绑定旧 root；
3. 多人/多会话共享同一项目，需要权限、所有权或审计；
4. 一个会话要跨项目（联合装配、跨项目对比）；
5. 跨机/远程/云；
6. 需要创建时显式选项目，或恢复会话时确认项目。

**为什么不现在做**：当前是单用户、本地、项目数十个以内，C-lite 够用；C 的 UI/恢复和 D 的注册表/权限成本高，触发前做是过度设计。

**触发时怎么做**：先记录具体缺口（哪个会话、哪个操作、哪个 root），再开 C 或 D；不要用符号链接、复制语料、临时改 header 绕过。

## 7. 备选方案（为什么不是它们）

| 方案 | 为什么不选 |
|---|---|
| A. 纯 cwd（现状） | 每加一个场景补一条路径规则；子智能体、嵌套、迁移都要 workaround |
| C. 会话显式绑定 | 中期做；当前先用 B 解痛点；C/D 是最终形态 |
| D. 稳定 id + 注册表 | 长期做；当前先用 B；C/D 是最终形态 |
| E. 单语料 + 项目命名空间 | 版本号/run 号冲突、归档难、跨项目查询复杂 |
