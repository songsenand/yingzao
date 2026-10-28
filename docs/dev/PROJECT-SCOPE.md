# 项目身份与隔离：从 cwd 到最近标记（B 方案）

> 状态：**B 已落地**：Phase 1 resolver + 测试 `a935778`；Phase 2 面板按标记发现 `e47fadd`；Phase 3 `projectCwdOf` 切 resolver + 删 `00a6013` 桥 `628ef7b`。根 `cad-data` / `assembly` 别名已清理。决策记录见 `docs/DECISION-LOG.md` 2026-10-28。

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
- **嵌套项目**：目录自己带标记就胜出；要建嵌套项目，必须显式创建标记，不能靠“碰巧在父项目里”。
- **符号链接不再用于项目切换**；根 `cad-data` / `assembly` 别名已清理。

### 3.2 解析规则

`resolveProjectRoot(start)`：

1. `canonical = realpath(start)`（解析符号链接；失败则 `resolve(start)`）。
2. 从 `canonical` 向上逐级：
   - `<dir>/cad-data/project.json` 存在 → 返回 `<dir>`（新式标记）。
   - `<dir>/cad-data/` 存在但没有 `project.json` → 返回 `<dir>`，标记为 **legacy**；第一次写时补写 `project.json`。
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
| 老语料只有 `cad-data/`、无标记 | 该项目根；第一次写补标记 |
| 符号链接路径 | 先 realpath，再按真实路径找标记 |

### 3.4 不做什么

- 不做稳定 `id` / 注册表（C/D）。
- 不做“一个会话同时属于多个项目”。
- 不把 `cd` 当项目切换的唯一手段；`cd` 只是改变起点，标记决定边界。
- 不用符号链接、根别名、`MAX_DEPTH` 特判来补项目切换。
- 不重写历史 run 的绝对 `manifestPath`；那是历史证据。

## 4. 落地

### 4.1 API

- 新增 `resolveProjectRoot(start): { root, marker: 'project' | 'legacy' | 'new' }`；同步实现（`existsSync` + 缓存），放在 `project.ts`。
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

- 会话创建时确定 `projectId` / `projectRoot`；工具从绑定取项目，不再从 workingDirectory 推断。
- `cd` 只改工作目录，不切换项目；需要切换时用显式命令或新会话。
- 子智能体继承绑定，或显式 `project` 覆盖；不再依赖 `cwd` 猜。
- 解决：误 `cd` 切项目、一个会话多项目、子智能体项目漂移；仍不解决移动/改名（身份还是路径）。
- 代价：会话创建/恢复/UI/子智能体参数；现有会话默认绑定当前解析根。

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
4. C：会话显式绑定。
5. D：稳定 id + 注册表 + 权限。

B 在准生产档够用；C/D 是最终形态，不要因为 B 够用就停在 B，也不要在 B 阶段过度投资路径 hack。

## 7. 备选方案（为什么不是它们）

| 方案 | 为什么不选 |
|---|---|
| A. 纯 cwd（现状） | 每加一个场景补一条路径规则；子智能体、嵌套、迁移都要 workaround |
| C. 会话显式绑定 | 中期做；当前先用 B 解痛点；C/D 是最终形态 |
| D. 稳定 id + 注册表 | 长期做；当前先用 B；C/D 是最终形态 |
| E. 单语料 + 项目命名空间 | 版本号/run 号冲突、归档难、跨项目查询复杂 |
