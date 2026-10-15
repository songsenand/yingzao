# ToyMarker 定位与哲学（边界文档）

**版本**：v1.0（2026-09-27）
**地位**：DESIGN.md 是实现决策档案（怎么做的、为什么这么做），本文档是定位档案（是什么、不是什么、为谁、边界在哪）。两者冲突时以本文档为准的定位语句为准。
**来源**：2026-09-26/27 定位讨论的全部结论落盘。

---

## 1. 定位演变（2026-09-27 修订）

```
玩具（ToyMarker 出身）
  → 不成熟的生产力工具（实测 LLM 建模能力超预期后）
  → 开放的 CAD harness（2026-09-27 起正式定位：不再限于内部工具，开放给更多人用）
```

- 名字是出身，不是定位。不急着改名，先改验收口径
- 开放化的前提：边界文档（本文档）与协议先稳住，哲学先行，边用边完善
- 野心的实现方式有对错之分：**以闭环实现则成 harness，以堆功能实现则变成第 12006 个 CAD 插件**

---

## 2. 核心命题：CAD harness 是什么

**排除法**：不是更强的 CAD 程序。不比特征数量、不比求解器精度、不与 SolidWorks 争功能面。

**正面命题**：

> LLM 现在就能写 OpenSCAD。生成几何从来不是瓶颈，**瓶颈是它不知道结果对不对**。
> 能生成但不能验证的系统，产出的是"看起来对"——玩具阶段人一眼看得出，生产阶段是致命的。

> **CAD harness = 让 LLM 生成的几何可验证、可迭代、可交付的基础设施。**
> 产品不是几何生成器，是**生成与真值之间的闭环**。

**四支柱 + 记忆**（已建成，恰好是基础设施要素而非功能列表）：

| 支柱 | 内容 |
|---|---|
| 真值引擎 | Manifold 布尔 / measure 家族 / datum 声明 |
| 分层验证 | L0 静态几何 / L1 刚体（physics + motion）/ L2 流体（MPM） |
| 双通道可视化 | LLM 的渲染图与帧数据；人的面板回放与标注 |
| 人的通道 | 会话 / 三发起路径 / 截图标注 / 版本审批 |
| 记忆 | 版本图 + manifest（意图、父版本、状态） |

依据：M4-PREP §3.3 扫描 12005 个插件的结论——**查看是 commodity，闭环才是壁垒**。闭环域零重叠。

**更深一层——真正的资产是协议，不是插件**：

v2.3 原则 1「模型输出意图/引用，几何引擎解析真值」是一条**协议声明**，与 OpenSCAD 无关。做扎实后可被任何几何内核实现（OpenSCAD / Replicad / Build123d / FreeCAD），可被任何 agent 消费。这是"CAD 界的 harness"的完整含义：**成为 LLM 与几何世界之间的标准接口**（类比 LSP 之于编辑器、MCP 之于工具）。当前插件只是协议的第一个实现。"定义哲学"要定义的就是这个最小真值协议。

---

## 3. LLM 时代的设计者：替代 / 增强 / 不可替代

**判据三问**（不是"LLM 能不能做到"）：
1. 意图从哪来？——工具只能答"怎么做"，不能答"要什么"
2. 对错有没有客观判据？——有判据的可闭环自审；判据在人手里的无法替代
3. 错了谁负责？——责任不能委托给没有后果的东西

### 3.1 可替代：操作员职能（M1 的本质）

特征：意图明确 + 结果可验证 + 执行路径机械。

- 建模执行（草图/特征/布尔的手工劳动）→ `generate_part` / SCAD
- 标准件 → BOSL2
- 迭代劳动（改→看→再改）→ 视觉循环（Agent 自审渲染图）
- 换算、命名、文件整理 → measure 家族 / 版本系统
- 学软件本身 → 归零

选型理由的显式化：**操作界面是给人的手设计的，LLM 的手是文本**——代码式 CAD 对人是学习成本，对 LLM 是母语。

### 3.2 可增强：检验员职能（M2/M3/M3.6/M4 的共同本质）

特征：人原本要做但做不起（贵/慢/需专家），现在每轮可跑。

- 增强的不只是效率，是**验证的时机**：从"终点一次性验收"移到"全程随时可问"
- L0/L1/L2 三层判据（主语物态）本质是"哪些问题可以不问人"的分层——能自动化的都是判据客观的
- **裁决不可替代**：间隙 0.75mm 是配合意图还是缺陷，只有人知道。工具报 truth，人判 good

### 3.3 不可替代：设计者职能

- 意图来源（零件干什么用、给谁用、坏了会怎样）
- 价值裁决（强度/重量/成本/美观的每次取舍都是价值观）
- 隐性约束（打印机悬垂角、孩子手指粗细、客户偏好——从没写下来的东西）
- 品味与验收（LLM 能描述"看到了什么"，不能拥有"喜不喜欢"）
- 责任签核
- 物理世界最终核对（仿真到头是趋势，最后一道关永远是手）

**现行证据**：历次验收的三层分工（脚本断言硬指标 → 模型判读图像 → 人复核）与本分类严格同构——**机器查可查的，LLM 看可描述的，人守不可让的**。这是哲学的落地，不是流程惯例。

**警惕替代过度的反噬**：人完全不碰几何 → 心理模型变浅 → 验收退化成橡皮图章 → 增强失效。人的通道必须保持**廉价可用的审问方式**（见 §4）。

---

## 4. 人的通道：做 / 看 / 指 / 说 / 判

| 动词 | LLM 时代 | 插件对应 |
|---|---|---|
| **做** | 交出 | generate_part / SCAD / 仿真三工具 |
| **看** | 双向（LLM 看 render_part，人看面板回放） | 产物浏览器：版本几何 + 运行回放（按产物种类自动呈现） |
| **指** | **必须保留，人的核心手势** | 标注红框、面板📏测量两点、回放暂停指认 |
| **说** | 升级为自然语言+澄清对话 | 会话 |
| **判** | **必须保留，人的核心权威** | approved / rollback / 三发起路径 |

总原则：**人指 WHAT、引擎算 WHERE、真值随产物流转**（§13.8 已确立，升格为总原则）。

**界面打扰原则（2026-09-28，来自实机反馈）**：面板**不因界面加载而自动弹出**——自动唤起只由**明确相关的事件**触发（本插件 = 会话出现 CAD 工具活动，即新版本产生），其余时候靠右栏 Tab 单击激活。依据：插件可能被装在通用工作区（代码仓库、文档项目），启动即弹模型预览是噪声；而"LLM 跑完 CAD 工具后预览自动出现"是有用的。**区分"加载即弹"（禁）与"相关事件即弹"（可）**——适用于所有面板。

**面板布局原则（2026-09-28，来自实机反馈；同日第四轮修正）**：既然**视觉是一等公民**，那么**模型预览必须占据首屏与最大面积**——视口置于面板最上方，**吃掉所有余量**（`aspect-ratio:1` 只作下限：正方形是地板不是天花板）；**版本历史、参数、验证报告、导出全部折进一行式折叠区**（默认收起），版本选择用下拉放在模型**之后**；**底部允许一条状态带**（结论 + 版本序号 + 出处），但必须 11px、单行、可省略——**视图之下，不许喧宾夺主**。空间不够时的让路顺序是**先滚折叠区、再缩视口**（`details` 收缩因子 100 : 视口 1）：实测 380×560 视口仍 355×352、详情区压到 41px 并滚动；380×400 极端情况下视口 355×233、详情区归零而面板不溢出。反面教材：把版本 chips 网格铺在首位，预览反被挤成 335×300 并溢出面板——**控件可以等，模型不能等**。附带一条几何纪律：**视口变高不等于模型变大**（取景由视口短边决定），所以"比正方形矮"是必须避免的，而"比正方形高"是白得的。实测与理由见 DESIGN.md §6.9 / §6.10（v2.14b），沙箱出图工具见 `dsh-cad-harness/sandbox/preview/`。

**零件从命名起就是版本控制对象（2026-09-28 四轮追问）**：不是"先做出零件、事后套版本"，而是**零件 = 版本库**：零件是仓库（可空存在）、版本是不可变提交（父子限同零件并校验）、运行是 CI 结果（挂版本上、可跨零件）。**缺 HEAD/回滚/审批**（详见 DESIGN §6.10 待办）——所以面板上的「跟随最新/已钉住」只是视图偏好，别把它当模型状态。**身份靠显式声明而不是推断**：实测 33 个版本里 32 个无 parent、同一零件被造成 5 个互不相干的根，任何文本/链式推断都会把「同零件换参数」和「不同零件」混为一谈。

**光照是"看"的一部分，不是装饰（2026-10-01）**：视口的职责是**让人看清形状**，而形状靠的是**明暗变化**。两条硬判据：①**主光必须跟着相机**（三点光挂在相机上）——世界固定的主光意味着"你想看的那一面正好没被打光"，转到背面就白转；②**环境光不能吃掉明暗**——环境占比从 33% 降到 8%（key 2.4 / fill 0.5 / rim 0.85 / 半球 0.24），正对光与背对光的对比 3× → 11×，另加胶片式高光收束，避免正打的面被削平成白（削平 = 一点信息都不剩）。**沙箱实测**（同机位同零件、按颜色只取模型像素）：色调方差 18.5→42.2、动态范围 95→125，两端无压死无削平，证据图 `sandbox/shots/lighting-{before,after}-*.png`。判据可以**在没有 GPU 的地方**验证为场景图性质（`scripts/accept-lighting.mjs`：rig 是否在相机上、转相机时主光是否跟转、环境占比与对比度），像素面靠 `sandbox/preview/shot-gl.mjs`（Xvfb + llvmpipe；本机 `firefox --headless` **建不出 WebGL 上下文**，这条以前没人发现，等于"看图"这一步断着）。

**背景也是"看清"的一部分，而且要让人自己选（2026-10-01）**：底色不是装饰——**零件与底色的明度差**决定了读不读得出形。零件的亮面是有限的（实测 p98≈183），所以：**亮底**（纸白 243）里零件**整体偏暗**，轮廓清楚、形体发闷；**暗底**（石墨 65 / 深蓝 38）里**亮面跳出来**（p98−底色 = +104 / +127），形体最立得住。两种都对，用途不同——**所以给四个预设让人选**（纸白 / 暖灰 / 石墨 / 深蓝，选择记进 localStorage），而不是替人决定。配套两条工程约束：①**覆盖层必须随底反色**（标尺与读数是 DOM，写死的深色在暗底上直接消失；用 WCAG 对比度验收，≥3:1，实测 9.0~13.4:1）；②**切换只改一个属性，不重建场景**（`scene.background = …`；重建要付一个 WebGL 上下文并会重新取景）。控件位置也定死：**放在视口右上角「复原」旁边的一个小色块**，**不加第六个工具 chip**——chip 行在 355px 宽度下已经占满，再加一个就要换行盖住模型。

**控件的坐标系由它的父级决定——挂错父级就是坐标错位（2026-10-01，同日第二遍）**：背景色块第一版挂在**面板层**却用 `top:36` 定位（那是浏览行的高度），于是胶囊盖在了「零件/记录」选择器上；第二版挪进视口包装层时手工搬动括号，又把嵌套弄坏。两条判据：①**绝对定位元素必须挂在它坐标所相对的那个容器里**——"想让它出现在视口里"就该挂视口（本插件最终走 overlay 的 `chrome` 槽，与「复原」同一坐标系）；②**挂完用 DOM 探针报坐标，不要在截图里找**（`data-bg-picker` + 沙箱探针打印 `x/y/w/h`，一击命中；在像素里找一个浅底色块是这次最耗时的一步）。另外：面板返回的 JSX 里手工搬动大段 `React.createElement` 括号必错，**搬完先 `tsc` 再看逻辑**——括号平衡器写三遍不如解析器说一遍。

**同一角落的控件必须同款（2026-10-01）**：背景选择器第一版用底色填充整个胶囊——结果在浅底上胶囊"消失"进视口、在暗底上又和白色「复原」打架，而且没写字号字体（继承默认，和「复原」不是一套字）。定死的规矩：**同角落的控件必须共用同一套底盘**（白板 + `1px #d5d9dd` + `11px/16px`，与「复原」逐字段一致），**图标家族也要一致**（这一角是 `⤾ 复原` / `🎨 背景`；色块本身当图标在浅底上读作"没勾的复选框"，弃用）。

**视口必须自带度量与方位（2026-09-28 三轮反馈）**：任何 3D 视口都要能回答两个问题——**"这有多大"**（标尺/比例尺）与**"这是哪个方向"**（坐标系三轴），并配一个**复原视图**（转飞/缩放过头后一键回初始取景）。角标位置固定：**坐标系左下、标尺右下**。实现走 DOM 角标（每帧读活相机），不画进 WebGL：不被模型裁切、四处视图复用同一套、且**无头浏览器能直接截到**（WebGL canvas 不进 `--screenshot`，这决定了它可验收）。依据与实测见 DESIGN.md §6.9c。

**图像只有一条正路进上下文（2026-10-01 定）**：图像**不许**以 base64 或 data URI 写进文本，也**不许**把"复制到剪贴板、请用户自己粘"当作唯一路径（那是把插件的活推给人）。正规接口只有两个方向，且**上下文里永远只有引用、字节走附件通道**：

| 谁产图 | 走哪条 | 关键调用 |
|---|---|---|
| 宿主工具（渲染图、求解标注图） | 工具结果的 `content` 里带 `ImageBlock` | `ctx.attachments.saveImages([{ data, mediaType, name }])` → `output.render(args, value)` 或 `finalizeContent(exec, result)` 返回 `[{type:'text',…},{type:'image', attachment: ref}]` |
| 浏览器面板（视口截图） | 直接发进会话 | `sessions.scope(id)` → `sessions.sessionOf(actx)` → `conversation.createDrafts(id, [file])` → `conversation.sendSession(face, text, ids, 'queue')` |

**三个易被"某处看到的示例"带偏的幻觉**（对着 0.1.5-rc.3 的类型声明与打包产物核过）：`ctx.attachments.create({data, mimeType})` **不存在**（真名 `saveImage`/`saveImages`，字段是 `mediaType`）；工具结果**没有** `attachments:` 字段（`ToolExecutionSuccess = {isError, value, content, meta?, additionalContexts?, concludesTurn?}`，多写的键会被 output schema 判违规）；图像**不会**"被框架自动加入"。**交付任何图像功能前先问一句：模型下一回合真的能看到它吗？** 答不上来就是没做完。详见 DESIGN.md §6.9o。

**图片会累积，所以必须修枝（2026-10-01 定）**：会话每步重发全史，而每轮 `generate_part` 带 4 张渲染图 → 图片数**单调累积**（本仓实测峰值 88 张/请求 ≈ 88k 图片 token，语料合计 36M）。规则：

1. **保留窗口写死，不做启发式**。本仓取"最新 6 轮（24 张）"，一次丢 2 轮（量子 8）→ 在飞窗口 17..24 张，最坏仍 ≥ 设计触发线 4 轮；量子存在的意义是**前缀稳定一段**，provider 前缀缓存不被每步打断。
2. **只投影请求，不改日志，也不改界面**。`llm/stream` 是深冻结的（请求 content 是会话日志的纯函数，**架构上禁止改写**）；durable 表面替换（`surfaceOp: replace` + `compaction/prune`）会连**对话记录里的图一起抹掉**。两者都不选，用适配器的 offload 投影。
3. **占位必须可回取**。`offloadedImageText(ref, access)` 带附件身份**和本地规范化路径**，模型真要看细节可以 `read_image` 取回；剪枝是省 token，不是删信息。
4. **计费必须与实收一致**。适配器的定价对已 offload 的图按 0 视觉 token 计——否则"剪了却还按没剪算"，压缩会在错误的位置触发。
5. **遥测要报实收数**。`usage.jsonl` 的 `images` = 提供商实收张数，`imagesBeforePrune` = 历史张数；报虚高数会让人对预算产生错误判断。

实现与验收见 DESIGN.md §13.10（`cordis.patch.yml` + `src/host/image-budget.ts` + `scripts/accept-image-budget.mjs`）。

**模型可见的东西属于 agent plane（2026-10-01 定）**：DSH 是两层 composition——**profile（host plane）**装注册表/沙箱/持久化/模型路由，**preset（agent plane）**装**工具、prompt section、projection**，且只有选了该 preset 的会话看得见。所以：

1. **凡是"模型看得见"的开销，一律问它挂在哪一层。** 工具表不是免费的：它随每次请求发出，且被 harness 算作请求信封的**唯一计价字段**。本仓实测：不挂 CAD 的会话 27 工具 ≈ 6.8k token，挂了 37~38 工具 ≈ 11.1~11.4k —— **+4.5k/请求**。插件挂在 profile 层 = 每个会话（含纯编程）都在替它付费。
2. **系统提示词 ≠ 请求载荷。** 系统提示词是会话表面上的节点（由 persona 拥有）；插件"没改提示词"不等于"没有代价"。
3. **不要为了摘工具而把插件行挪进 preset**——浏览器半边的发现依赖 profile 的 composed rows（带 `dsh.client` 的包要出现在行里），挪走 UI 就没了。正确做法是**拆职责**：路由/遥测/UI 留全局，**工具可见性按 preset 收窄**（`ctx.tools.restrict`，必须在 agent 自己的 ctx 上调）。
4. **"要求重开会话才生效"的改动，只能装在项目开始前**：按 preset 收窄工具表曾在项目中途上线 → 被否决并全量回退（preset 是**会话的创建事实**，只在会话还空白时可改，规则一上线就让所有已存在会话失去工具）→ 同日在新项目开始前重新装上（DESIGN §13.11）。教训不是"方案错"，而是**采纳时机是方案的一部分**；判断标准是先问"对正在进行的会话有没有影响"，不是"省多少"。
5. **验收要看"模型实际收到什么"**：会话日志的 `request/header` 是 durable 的工具表快照——打印每个会话真实发出的工具数与目录 token，才算证明了改动（`scripts/inspect-tool-catalog.mjs`；不启动 dsh 的prospective 版本是 `scripts/measure-tool-cost.mjs`，它把源码里的描述换进最近一次真实请求再重新计价）。
5b. **削成本优先于分层**：CAD 工具表 4,621 tok 里，工具级描述只占 1,764（38%），脚手架占 1,698（37%），参数级描述 1,152。把"选型判据/全局约定/反直觉事实"从工具描述搬进 **skill**（按需加载、且发现根挂在 CAD preset 上所以编程会话连目录项都看不到），**每次请求省 1,227 tok、−27%，且对任何会话零打扰**。剩下可削的是脚手架与参数描述，风险更高，要单独权衡（DESIGN §13.12）。
6. **"零打扰"是硬门槛**：判断一个成本方案能不能上，第一条不是"省多少"，而是**"对正在进行的会话有没有影响"**。省 token 的方案如果要求人重开会话，就不合格（本轮实测教训）。

**一个项目一份语料：插件不许有"全局设计"（2026-10-01 定）**：实机反馈——新项目打开 CAD 面板，零件下拉里还是旧项目画的零件。根因不是 UI：所有 store 在插件 `apply` 时按**插件安装目录**开了一次，于是整个 profile 只有一个语料；又因为 `ensurePart()` **按名字全局匹配**，新项目里一个叫"底座"的零件会**认领**旧项目那个"底座"，两个项目的修订史被静默缝合（比显示问题严重得多）。

1. **项目身份 = 会话的工作目录（cwd）**。cwd 是**已经存在**的创建事实（会话日志本就按 cwd 分目录，`workspaceRegistry` 的成员判定也以它为准），而且符合人对项目的直觉：**同目录多会话共享零件，新建目录就是新项目**。
2. **两侧都必须带项目，缺一不可**。工具侧从 `exec.agent.session.header.cwd` 取（**没有模块级 store**）；浏览器侧走 `?project=<绝对目录>`，客户端用 `withProject()` 这**唯一**的 URL 构造器。只修面板等于只把症状盖住：工具仍会跨项目认领同名零件，而且版本/运行 id 是**每语料自增**的（两边都有 `v001`），平坦命名空间上的 `?id=r001` 本来就是歧义的。
3. **读取不创建，写入才落盘**。目录不存在 = 空语料 = 新项目的正常状态，不是异常。这条决定了"新项目打开就是空的"。
4. **遥测反过来，留在 profile 层**。usage 一次观察所有会话的 `llm/stream`，量的是**请求**不是**设计**——按项目切开只会让每个项目的数字都残缺。**凡"模型/人看得见的东西"先问它属于哪一层**（承本条上文的第 1 条）。
5. **迁移必须可重跑**。旧 dsh 进程重启前仍会往老路径写东西，所以迁移脚本按条目合并、冲突 id 拒绝覆盖并报出、遥测按行去重追加——**不猜、不覆盖、可重复执行**。
6. **判据**：任何 `join(pluginRoot, …)` 形式的持久化路径，当场回答**"第二个项目来了会怎样"**。"插件级单例"是隐形的功能缺失，不是省事。

实现与验收见 DESIGN.md §13.13（`src/host/project.ts` + `scripts/accept-project-scope.mjs` 真路由隔离取证 + `scripts/migrate-to-projects.mjs`）。

**两半的作用域不一致时，面板必须说出来（2026-10-01 定，实机踩坑）**：本插件的**人的半边是全局的**（路由、面板、遥测），**模型的半边是按预设的**（工具表、skill 目录）。于是会出现一种静默失败——**标准模式**的会话里，面板一切正常、零件列表空空如也，而 Agent **一个 CAD 工具都没有**。实测代价：Agent 拿不到工具就自己读插件源码、用 bash 调 OpenSCAD 硬画，最后报 `Error: skill "cad-toolbox" is unknown or no longer available`（skill 根挂在同一个预设上，所以连技能也一起没了）；人看到的只是一句莫名其妙的报错。

规矩：
1. **"零打扰"不等于"零提示"**：能静默降级的是**噪声**（不自动弹面板），不能静默的是**能力缺失**。人的通道必须能回答"现在到底是没零件，还是我这边根本没接通"。
2. **不要让客户端去猜服务端的决定**：宿主把 `toolScope` 与开放它的 preset 列表用 `GET /api/cad/scope` **如实报出**（这是唯一免带 `project` 的 CAD 路由之一），客户端用 `cadToolsVisible(scope, preset)` 判定——**判据只有一份，镜像关系写在注释里**。
3. **判据要与宿主规则逐条对齐，且不确定时沉默**：宿主规则是 `tool-scope.ts` 的 `decideToolScope`；preset 未知（老会话）就**不提示**，宁可漏报不可误报。
4. **创建事实不可改，所以提示要给动作，而且要给对**：preset 在会话开始后锁死，提示必须按"还能不能救"分流——**会话还空白** → "现在重新选一次还来得及"（宿主 `lastTurn = 0` 时确实接受切换）；**已经开始** → "新建会话，或在设置里把「造物模式」设为默认预设"。报错一条等于把人指向走不通的路。
5. **界面不许显示一个还没提交的状态（2026-10-01，实机踩坑的根因）**：出厂预设芯片把**暂存**值直接画成"已选中"，而暂存要在"一个空白会话成为 current"时才提交，遇到不空白就**静默丢弃**——人看到「造物模式」选好了，会话却是「标准模式」出生的（日志里 header 从出生就写死 standard、全程没有 `agent-preset/selected`，而会话空白了 42 秒，所以既不是选太晚也不是选太早）。判据两条：**任何"待提交"状态必须与"已生效"在视觉上可区分**；**丢弃必须说话**。
6. **诊断纪律：日志只能证明"没生效"，不能证明"没选"**。第一版复盘把根因写成"人没选"，依据只是日志里写着 standard——那是在怪用户，而真相是产品 bug。写归因时把"我看到了什么"和"我推断发生了什么"分开。
7. **创建事实不是当前状态（2026-10-01，第二遍才查对）**：`session.header.agentPreset` 是**出生**什么，切换**永远不改写它**；"现在跑什么"在 `agentPreset` **投影**里。本插件用会话头做判据，于是把"出生 standard、后来切到造物模式"的会话继续判成非 CAD 会话——**切换成功了，工具还是没给**（日志实证：切换事件 seq=4，之后 seq=18 的真实请求仍是 27 工具 / CAD 0）。判据：读任何 durable 字段前先问"**这是记录当时，还是描述现在**"；同一条错误还要查量具——`inspect-tool-catalog.mjs` 也犯了，已改成"切换事件优先、会话头兜底"并显示 `standard→cad`。
8. **读别人的 store，抄出厂的调用点，不要抄类型名（2026-10-01，第三次踩坑）**：`SnapshotStore` 长得像有 `.get()`，实际只有 `getSnapshot()`——本插件用 `.get?.() ?? .value` 读会话列表，`undefined` 一路静默传下去，最后表现成"面板永远是空的"（不报错、不警告，而且**换哪个会话都一样**）。查法很简单：`grep -rn "list\.getSnapshot()"` 在本机出厂代码里有 **21 处**、`.get()` **0 处**。判据：**任何"取不到就静默用默认值"的读法都是可疑的**，尤其是它会决定"向服务端要哪个对象"的时候；宁可让它响，也不要让它静默地要错东西。配套一条：**空状态必须点名自己读的是哪个对象**（这次给空列表加了 `（项目：microscope2）`），否则"没数据"和"读错了"无法区分。

9. **限制要能解除，否则就不要提前挂**：`ctx.tools.restrict()` 返回**解除 disposer**，所以"按预设收窄"必须同时编排 `agent-preset/selected`——把 disposer 存下来，切到 CAD 就调掉。只能收紧不能放松的规则，遇到"会话还能改预设"这条事实就是个定时炸弹。

**量具**：`dsh-cad-harness/scripts/inspect-tool-catalog.mjs`（只读，读会话日志的 `request/header`）打印每个会话**真实发出**的工具表大小与 CAD 占比。任何关于"这次改动省了多少"的说法都必须由它出数。

按 preset 收窄的实现与回退记录见 DESIGN.md §13.11。

**面板交互原则：产物即主体，不给模式开关（2026-09-28 二轮反馈）**：人**只选产物**（零件版本 / 验证运行），**呈现方式由产物自己是什么决定**——版本给几何视口，物理/机构运行给时间轴回放，流体运行给粒子回放，清单检查给报告卡片。**禁止让人先选"看什么类型的东西"再选产物**：那是把引擎内部的呈现差异泄漏成用户决策，而且必然会撒谎——旧版的「动作/流体」Tab 取的其实是"最近一次运行"，与选中的版本无关，停在那个 Tab 上版本下拉是个死控件。推论：**产物必须自带身份与出处**（运行有 id/时间戳/kind/`sourceVersionIds`），没有出处就如实说"内联 SCAD 场景"，不许硬塞给某个版本；**"相关验证"由 provenance 生成**，不靠人记。默认跟随最新产物，可一键钉住。

生产力阶段的补充缺口——**权威编辑**：真实场景里人会下精确命令（"这个孔改 10mm 且保持同心"）。不需要人回去拖鼠标建模，但需要**约束保持下的精确编辑 + 可追溯**。PARAMS/Customizer 只改顶层标量，够不上。待建。

---

## 5. 各里程碑的设计哲学

| 里程碑 | 定位 | 一句话哲学 |
|---|---|---|
| M1 视觉循环 | 替代建模操作员 | 意图进、代码出、引擎真值、LLM 自审；人第一次介入是验收不是操作 |
| M2 装配验证 | 增强检验员 | 验证从一次性终点动作变为全程随叫随到；判读可自动化，裁决留给间隙的"故意" |
| M3 刚体物理 | 增强检验员 | 把"打印了才知道"提前到打印前；mm 单位贯穿 = 人无需翻译 |
| M3.6 机构运动 | 增强 + 装配语义显式化 | 关节声明 = 装配意图第一次显式建模；负样本验收 = 验证器自身可信 |
| M4 流体 | 增强（民主化） | 趋势判断给用不起 CFD 的人；主语物态选型 |
| M4R 场地化 | 哲学转折点 | LLM 是有场地的工程师不是填表员；插件 = 场地 + 看台，不是包工头 |
| M5 分析 | 解读归 LLM | 插件不越权做解读 |

---

## 6. 三层能力开放原则（防矫枉过正，2026-09-27 确立）

> **场地思路反对的是"收窄能力"（包工头），不反对"标注能力"（导览）。**

M4R 已写"文档 = 源码 + JSDoc + examples"，skill 是第三通道：

| 通道 | 何时被消费 | 回答的问题 |
|---|---|---|
| JSDoc / 源码 | LLM 读码时 | 函数的精确行为 |
| examples/ | LLM 动手前 | 一个能跑的完整样子 |
| **skill** | **任务开始前主动加载** | **场地里有什么？我的问题该走哪条路？** |

skill 补的是前两者够不到的：JSDoc 是查字典，examples 是看样本，但 LLM 面对上万行源码首先需要**地图**——不知道 `sdf.ts` 存在的 LLM 不会去读它的 JSDoc。工具描述里的三层判据交叉引用（L0/L1/L2 选型、simulate_* 互相指路）就是 skill 思想的雏形。

**试金石**：
- 合格的 skill = 删掉它，LLM 读源码也能达到同等效果，只是更慢——它是导览手册
- 伪 API 的 skill = 删掉它能力就没了——说明能力被锁进了窄接口，该拆

skill 只能做三件事：描述现有能力、传递决策经验（哪类问题走哪个工具、什么参数范围已验证）、指出陷阱（mm 单位制、z-up、精度旋钮是 dx 不是粒子数）。不能做：替代真实库函数、冻结场景语义、把本该 LLM 写的判断写成规则。

**完整表述**：**库给能力，runtime 给执行，skill 给地图——三层都是场地的一部分，缺一层场地就不完整。**

---

## 7. 缺口与边界：玩具 → 生产力工具

规矩：**缺口要填，边界要声明并把手交接干净**。把边界当缺口追 = 范围蔓延；把缺口当边界 = 永远停在玩具。

| 维度 | 玩具档 | 生产力档 | 判定 |
|---|---|---|---|
| 判据 | 看着对 | 数值对 + 工艺可行 + 可复现 | 缺口（工艺可行性无验证） |
| 失败 | 报错重来 | 可预测失败 + 边界明确 | 缺口（边界未文档化） |
| 交付 | STL 能打印 | 可交付、可交接 | 导出已建（stl/3mf/obj/off/wrl，导入件同样可用）；**STEP/DXF 导入已建（2026-10-15，§7.3）**；IGES 仍是边界 |
| 互操作 | 无 | 在既有件上设计 | **已建（STL 2026-10-01；STEP/DXF 2026-10-15）**：外部几何作为一等版本进入项目，直接参与装配检查与三层验证；IGES 见 §7.3 |
| 规模 | 单件 | 装配体 | 缺口（见 §8，立场已修订） |
| 人 | 提需求、看结果 | 精确编辑 + 签核 + 可追溯 | 缺口（权威编辑，§4） |
| 精度 | 趋势判断 | 需要时交给认证工具 | **边界**（做交接契约，不填） |
| 内核 | CSG 网格 | B-rep + 约束求解 | **边界**（可插拔，不自造） |

### 7.1 STEP 实测结论（2026-09-27）

- 插件层未实现：`tools.ts` EXPORT_FORMATS 白名单仅 stl/3mf/obj/off/wrl
- 链路层走 `exportScad()` → OpenSCAD CLI `--export-format`
- 内核层无此能力（实测 snapshot 二进制 `--help`）：输出类型无 step，实验特性亦无 import_step
- **定性**：不是配置遗漏，是内核类别缺口（网格 vs B-rep）。网格→B-rep 是逆向工程不是格式转换
- **归期**：内核可插拔（中期）。路线：Replicad（TS+WASM+OCCT，留在 Node 栈）/ Build123d 或 FreeCAD headless（Python sidecar 单点转换服务）
- 过渡期：3MF 已够切片/打印链路；STEP 缺失不阻塞"不成熟生产力工具"定位
- 顺带发现：snapshot 实验特性含 `python-engine`（PythonSCAD）与 `ai-features`——LLM 可用 Python 驱动 OpenSCAD 几何，语料红利 + 真实语言生态，零成本躺在手里的升级，待试探
- **python-engine 试探结论（2026-09-28，已确认可用；⚠️ 同日裁决不采用——见 §12.2 架构 A，本节转为存档备查）**：
  - **启用**：`openscad --enable python-engine --trust-python -o out.stl file.py`；环境三件套：快照 `usr/lib` 进 LD_LIBRARY_PATH（现有）+ 快照 `usr/bin` 进 PATH + `PYTHONHOME=<快照>/usr`。快照自带完整 Python 3.10 运行时与 `openscad-python` 解释器；`--trust-python` 是 GUI"信任脚本"对话框的 CLI 等价物（上游 issue #5909）
  - **API 形态**：`from openscad import *`；**子对象在前**——`translate(child, v)`、`rotate(child, a)`（`translate(v)` 会把参数表当子对象列表）；union = `union(a,b)` / `a.union(b)` / `a | [b]`，差 = `-`，交 = `&`；OO 方法全套存在（`python_oo_*` 符号表：translate/rotate/scale/union/difference/hull/linear_extrude/rotate_extrude/offset/projection/mesh…）；`show(part)` 输出
  - **对 LLM 循环的核心收益**：错误反馈是**真 Python traceback**（SyntaxError 带行号+指示符、TypeError 带可读信息如 "Invalid Cube dimensions"）——显著优于 SCAD 解析器的裸 syntax error；`print()` 走 stderr（与 echo 同通道）→ **datum 约定零成本移植**（`print("DATUM|name|x,y,z")` + stderr 行解析）
  - **性能**：法兰盘（6 螺栓孔+中心孔，**Genus=7 拓扑精确**、Manifold NoError）全程 36ms；math/json/os 等 stdlib 直接可用
  - **风险**：探针中 `dir()` 内省触发过一次 segfault（exit 139）——稳定性未完全验证，进管线前需做稳定性冒烟；设置项存 GUI 配置（headless 下靠 flags 规避，已验证）
  - **定性**：不是换内核——同一 Manifold 内核 + 真实语言前端；真值引擎/measure/验证管线**全部无改动复用**。这是"内核可插拔"在执行层的第一次预演（协议不变、前端可换），与 §8 装配表示立场同向：表达是关键。集成改动量预估：compile.ts 加一条 `.py` 分支（flags+env+stderr 解析 datum），~半天

### 7.2 内核可插拔候选盘点（2026-09-27 调研）

按内核语义分类（不是按品牌）：CSG/网格（OpenSCAD、JSCAD、PythonSCAD）、代码驱动 B-rep（Build123d、CadQuery、**Replicad**）、AI 原生（Zoo KCL——竞品参照非依赖）、全功能脚本面（FreeCAD headless、Blender bpy）、fRep/SDF（libfive/Curv，与 MPM SDF 管线同构，暗线）。

LLM 适配度判据：训练语料密度 > headless 可执行 > 错误反馈质量 > 输出语义 > 运行时可嵌入。

近期动作：~~试 `python-engine`~~（已试探，裁决不采用，见 §12.2）。中期插拔第一站：Replicad。生产力桥：Build123d/FreeCAD headless 转 STEP（**B-rep 后置，见 §12.6**）。玩具艺术面（有机形状）：Blender bpy 按需立项。

### 7.3 归因修正：STL 导入不是内核缺口（2026-10-01）

**本节修正 §7 表格的一处归因错误，代价是一整条能力被无关的内核问题扣住。**

原表述把「STEP 导入导出」与「导入既有 CAD」并成一行，一起判为"内核类别缺口（网格 vs B-rep）"并一起后置。对 STEP 成立；对 STL **不成立**：

- **STL 就是网格，而本 harness 的真值引擎全部是网格的**——Manifold 布尔（`assembly.ts`）、BVH 最近距离、rapier（`physics.ts`）、MPM/SDF、measure 家族。`mesh.ts` 的 STL 解析已存在数月并在 5 个模块里使用，`renderVersionFrame` / `physics.ts` 早就在用 `import("...stl")` 渲染。
- 真正缺的不是"读一个 STL"，而是**"落成一个版本"**：`generate_part` 是几何进版本库的唯一入口，且只收 SCAD 源码（`saveVersion` 的 `scadCode` 曾为必填、无条件写 `model.scad`）。于是版本库事实上等于"SCAD 源码库"，**几何不是可以独立存在的对象**——"一人设计、他人使用"的协作与拼装由此断开。

**已建（v2.15，2026-10-01）**：`import_part` 工具 + `src/host/import.ts`。三条设计原则，与 §2 的核心命题同构：

1. **导入 = 验收，不是搬运**。文件字节不是真值，Manifold 接受的网格才是。导入跑同一个真值引擎并如实报出水密性、体积、亏格、**壳数**、退化三角形；**非实体默认拒收**（错误里给出坏边数与修法），因为存下来会让每个下游工具对"不是一个实体"的东西给出自信的数字。`allowNonSolid` 只用于查看坏几何，并把该版本打上标记，让几何工具明确拒绝它。
2. **导入 = 一个版本，不是第二条通道**。用 `source.kind = imported` 区分来源；11 个工具**零改动**对它生效（`accept-import.mjs` 断言导入件的 `measureVersion` 与生成件逐字段相等）。这是"以闭环实现能力"而非"堆一个导入按钮"的判据。
3. **外部件必须能进契约**。datum 是接口地址，而 STL 不带 datum；导入时接受 `datums` 声明并写进同一个 `datums.json`。**由此 §11 记录过的"stock 件不能作接口端点"对被导入件不再成立**——它有版本、有网格，因此被完整检查（manifest 因此新增 `source: 'imported'`，只有无版本的 `stock` 才跳过）。

**单位是声明不是推断**：STL 无单位，`unit`（mm/cm/m/inch）与 `scale` 由调用方声明，在**任何测量之前**作用一次并原样记入 `import.json`。25.4 倍错误是这一类导入的经典失败模式。

**边界（2026-10-15 起：STEP/DXF 已建，IGES 仍是边界）**：`import_part` 现在直接读 `.step/.stp`——cascadio（MIT，OpenCASCADE 打包成 STEP→GLB 转换器）进锁、worker 的 `import_mesh` op 内嵌转换；GLB 中间格式声明**米**（探针实测，bbox 0.01 = 10mm），worker ×1000 落 mm，`appliedScale` 如实含此步。`.dxf` 走 ezdxf：`$INSUNITS` 优先于调用方单位；2D 闭环轮廓**必须给 `depthMm`** 才挤出成实体（manifold3d `CrossSection` EvenOdd——轮廓不是实体）；3D 网格实体走 STL 同款焊接尾流。探针数据 `experiments/20261015_cad_import_probe.md`；验收 `accept-import-cad.mjs`；决策 DECISION-LOG 2026-10-15。**IGES 不变**：cascadio 0.1.1 对 IGES **静默失败**（stderr 打 OCCT 错误、不写输出文件——实测），且无其他读取器，`.iges/.igs` 仍返回可行动边界（转 STEP/STL）。`replicad` + `opencascadejs`（~55MB wasm）那条线的剩余价值收窄为两件还没做的事：**STEP 导出**与从 B-rep 抽取**精确**孔/轴 datum（网格细分只给网格级的）；是否引入仍是内核可插拔线上的决定，未做出。

---

## 8. 装配表示：代码库类比（2026-09-27 立场修订）

**原立场（已放弃）**："5/20/50 件对应完全不同的表示，先定规模再定表示"——把规模当门控。

**修订立场（采纳项目所有者判断）**：**大型代码库 harness 能编辑（DSH/Claude Code 编辑几十万行），装配理论上同样可以。关键不在规模门控，在表达。**

代码库规模的解法从来不是"把代码库塞进上下文"，而是**让大代码库可导航的表示与工具**。装配体与代码库结构同构：

| 代码库 | 装配体 | 已有/待建 |
|---|---|---|
| 文件 = 持久状态 | 零件文件 + 版本 | 版本系统（需扩展到装配级版本图） |
| import / API | 接口契约（谁配谁、间隙意图） | datum() 是种子，待推广 |
| grep | 邻接查询 / 空间查询（谁碰到这个面） | 待建（装配 manifest 的查询面） |
| LSP / go-to-def | datum / 接口名解析 | datum() 已有 |
| 类型系统 | 配合类型不匹配 = 编译错误 | 待建（轻量契约） |
| 测试 | L0/L1/L2 验证 | **已有** |
| CI（变更传播） | 接口变更 → 波及零件重验 | 待建（增量验证） |
| lint | 间隙/标准化检查 | validate_assembly 部分 |
| PR review | 接口级人审 | 人审通道部分 |
| 包管理（类型+实例） | 标准件复用（20 颗螺丝 = 1 类型 20 实例） | 待建 |

**判断标准随之改变**：从"多少件装得进上下文"改为——

> **一个新会话能否只靠局部视图 + 查询，正确修改 50 件装配中的一个零件？**

**实验 A0'（取代原 A0 规模探针）**：按代码库方式建装配表示（零件文件化 + 接口契约 + 邻接查询），在 50 件装配上测导航正确性：新会话（无历史上下文）能否在不读全部零件的前提下完成一次指定零件修改并通过 L0 验证。人类工程师也从不把整台机器放在脑子里——他们看图纸；图纸的等价物就是这个表示。**定位：这是必做的第一步（表示不建则装配线无法继续），不是"做不做"的可选探针——实验只回答"表达方案是否正确"，不回答"要不要做"。**

此前识别的三个装配缺口不变，只是解法归入代码库类比：装配语义易失（joints 现场声明即丢）→ 契约文件；版本模型零件级 → 版本图；上下文装不下 → 懒加载 + 查询，而非缩小装配。

---

## 9. 竞争参照：对手是测量仪器，不是假想敌

- **Zoo（原 KittyCAD）KCL 的教训**：发明零预训练语料的新语言 = 生态尺度的包工头。LLM 时代核心技术问题是"模型已经会什么"（语料逻辑），互联网时代是"你控制什么"（平台逻辑）——KCL 用平台打法补语料短板，飞轮转不起来。可取的洞察："文本表示要为 diff/流式优化"——正确结论是在已有语言上做表示层，不是发明语言
- **Onshape FeatureScript MCP 的启示**：巨头下场的赢面路线恰恰也是场地路线——没发明语言（FeatureScript 2014 年就有、有语料）、协议而非包装（MCP）、骑在真 CAD 上。**这验证哲学的正确性，不是威胁**
- 我们不竞争、不以盈利为前提（可盈利更好）。对手的用法：每季度瞄一眼——**有没有人也在做验证闭环**（而不是又一个建模入口）。目前 12005 插件零重叠，巨头发布全在建模侧，闭环这个位置只有我们坐着
- 真正的竞争在狗食原则：内部工具的死法不是被竞品打死，是没人用还继续养。开放化同理——**缺口的真伪由真实任务裁决，不由讨论裁决**

---

## 10. 开放化（2026-09-27 定位变更）

从内部工具到开放工具，顺序：

1. 边界文档（本文档）先行——开放前先说清是什么/不是什么
2. 协议先稳——datum/真值/契约的表示是开放的第一接口，先于 UI 开放
3. examples + skill 先行——开放的最小形态是"别人（和别人的 agent）能用场地"，不是营销页
4. 两档保真度显式并存：玩具档（快速验证/教学）与生产档（真实交付），验收口径分开

---

## 11. 下一步排序（2026-09-28 修订：装配与视觉表达优先，内核后置）

1. **找一个真实项目做压力测试**——"边用"的"用"，缺口的真伪由它裁决
2. **A0' 装配表示 + 装配视觉表达（主工作线，必做）**——表达的两个面同建：
   - 代码面：零件文件化 + 接口契约 + 邻接查询（§8 映射表）——**v1 已交付 2026-09-28**（datum 三类扩展 / assembly.json / L0 算子 distance+diameter-match / hard-intent 双通道 / 邻接发现 / check_assembly 工具+路由 / 验收 accept-assembly 14/14；见 DESIGN.md v2.7，schema 见 ASSEMBLY-SCHEMA-PROPOSAL.md）。待续：层级递归（v2）、L1 运动接口（v2）、spring/流道（v3）
   - 视觉面：装配级视觉语言——部件显隐/高亮、剖切、爆炸视图、接口（datum）可视化标记、装配回放（motion playback 已有底子）。依据：复杂装配下渲染图判读会退化（遮挡/细节小），"视觉管像不像、数值管对不对、**装配关系管接没接对**"——第三类判断需要装配级视觉表达支撑，且为 LLM 判读与人审共同依赖 **（未开工）**
3. **skill 化**——把三层判据选型、参数甜点、陷阱清单写成 skill（§6）
4. **权威编辑通道**——约束保持的精确编辑 + 可追溯（§4 缺口）
5. ~~**python-engine 集成**~~ **取消（2026-09-28）**——架构 A 不用 OpenSCAD 内嵌 Python（§12.2）；试探结论存档备查（§7.1）
6. **Replicad/STEP 桥**（后置，内核可插拔是防御性储备，不是当前目标）
7. **Python 领域运行时落地**（§12）：**供给 v1 已落地 2026-10-08**（独立解释器 + 锁定 venv + `run_python` / `python_runtime`，见 §12.7）；**待做**：常驻 worker + JSON-lines 协议（§12.3），第一步接 M4R 支柱 A 的 `examples/` 场景脚本
7. 每季度：竞态追踪（§9 最后一项）

**2026-10-01 插队交付并已落盘**：**外部 STL 导入（`import_part`）**——不在上面 1-7 的任何一条里，因为它是被错误归因（§7.3）掩盖的缺口，由"多人协作 + 拼装"的真实需求裁决出来的。它同时把第 2 条代码面的"零件文件化"补上了外部来源那一半：现在版本库里有几何是别人给的。**未做的邻接面**：按版本号把已有件布尔合成新件（真正的"拼接"），它需要版本图记住自己的来源版本（§8 映射表的"版本模型零件级 → 版本图"）。

---

## 12. 运行时分工与引擎默认策略（2026-09-28 裁决）

### 12.1 一句话分工

> **TS 是平台接线层，Python 是领域运行时。** 不是"减少 TS"，而是让 TS 只干接线。

- **TS 不可动（平台规定）**：dsh 插件宿主面（`ctx.tools.register` / `connection.fetch.register` / `ctx.attachments` / cordis 生命周期）、浏览器面板与回放
- **Python 扩张**：几何分析、仿真、装配检查、场景脚本——领域运行时

### 12.2 架构裁决：A —— LLM 写 SCAD，Python 只做分析/仿真/装配检查

- 模型来源仍是 **SCAD**（LLM 写）；Python **不做几何生成**（那是 OpenSCAD 的活）
- **不使用 OpenSCAD 内嵌 python-engine**。实测 `ldd bin/squashfs-root/usr/bin/openscad` → 链接 `libpython3.10.so.1.0`：内嵌解释器 **ABI 绑死 3.10**，换版本需自己构建 OpenSCAD；且它装不了我们要的生态（无 pip 环境、venv 还要 GUI 手动建）。**→ §7.1 的 python-engine 试探结论转为存档备查，集成项取消**
- 保留价值：若将来改选 B（Python 生成 SCAD 文本）或 C（模型内 Python 表达式），§7.1 记录的启用三件套与 API 形态（子对象在前、`--trust-python`、`PYTHONHOME`）仍可直接用

### 12.3 Worker 规范（Python 领域运行时）

- **版本：3.13**（`cadquery-ocp` 有 cp311-cp314 wheel，3.13 生态最稳）；与 OpenSCAD 内嵌 3.10 **互不干涉**（两个进程）
- **形态**：常驻进程（`python/cad_worker`），宿主侧**唯一接线点** `src/host/python-worker.ts`——延续"引擎只在少数几处导入"的同一条纪律
- **协议**：`{id, op, params}` → `{id, ok, result}` / `{id, ok:false, error, traceback}`，带 `protocolVersion`；**大载荷（STL/帧）走文件路径**，不走 stdio
- **运维**：venv 锁定（`requirements.lock` 含 hash）+ health check + 自动重启；worker 崩溃不带崩插件
- **错误反馈**：返回完整 traceback（Python 侧核心优势）
- **2026-10-08 实测（原型 `dsh-cad-harness/scripts/proto-python-worker.mjs`，报告
  `experiments/20261008_python_migration_measurements.md`）**：
  spawn→hello 握手 **15.6 ms**，之后每次调用 **~20 µs**；
  **"大载荷走文件路径"被证实且阈值更低**——参数侧 1M float64：inline JSON 5.6 MiB
  **106 ms** vs 文件 7.6 MiB **0.72 ms（148×）**；结果侧 100k×3 float32：inline JSON 98 ms /
  inline base64 16 ms / 文件 **0.92 ms**。**1 MiB 量级就该走文件**，base64 只适合几十 KiB。
  失败帧带完整 traceback（7 行，含 worker 内帧）。
  ⚠️ **v1 的 worker 是单线程串行**（两个并发请求耗时 = 串行和 140.5 ms）：宿主侧并发工具调用
  会**排队**，**超时预算必须把排队算进去**；要真并行只能靠 Python 侧异步分派（IO 型）
  或 worker 池（CPU 型）——几何/仿真都是 CPU 密集，v1 先串行并明确记录。
- **2026-10-08 batch 0 已落地**：worker 在 `dsh-cad-harness/python/cad_worker/worker.py`，
  宿主侧 `src/host/python-worker.ts` 的 `PythonWorker` / `ensurePythonWorker()`（单例 + 崩溃重启）
  + `resolveWorkerScript()`（源码与打包两种深度）；`package.json.files` 加了 `python/`。
  v1 ops：`ping` / `versions` / `stl_stats` / `closest_points` / `crash`。
  **2026-10-12 现状**：`OPS` 已扩到 **30 个**（与 `HANDLERS` 一一对应，`hello` 帧会报全表），
  覆盖测量家族（`measure_part` / `measure_distance` / `measure_closest` / **`measure_thickness`** /
  **`list_features`** / **`measure_section`** / **`measure_extent`** / **`measure_angle`** / **`assembly_contracts`**）、运动/刚体/流体、
  SCAD 文本协议与导入合并；依赖集 **9 件**（新增 `shapely 2.2.0`，给剖面多边形化用；
  锁由 `scripts/gen-python-lock.mjs` 生成，改锁会经 venv marker 触发重建）。
  验收 `scripts/accept-python-worker.mjs`（8 组断言全绿）：握手 **14.8 ms**、ping **0.026 ms**
  中位数（200 次）、**大载荷按文件往返并与 TS 结果 Δ=0**、失败带完整 traceback、
  kill 后重启、**并发请求严格串行（116 ms → 230 ms）**、打包检查。
  `run_python` 的一次性进程保持不变——两种形态共用一个接线点。
  ⚠️ **worker 是子进程，生命周期必须归插件管**：`index.ts` 的 `ctx.effect` 注册
  `resetPythonWorker()`，卸载即停；否则它的 stdio 句柄会吊住宿主的事件循环（实测：
  迁移 `validate_assembly` 后 `accept-m2.mjs` 挂住不退出）。任何用到 worker 的脚本
  收尾时也要显式 `resetPythonWorker()`。

### 12.4 pip 生态（实测 2026-09-28；2026-10-14 增 numba/llvmlite）

| 包 | 版本 | wheel | 用途 |
|---|---|---|---|
| `manifold3d` | 3.5.4 | 42 | 与 Host 侧同一几何内核，Python 可用 |
| `trimesh` / `numpy` / `scipy` | 5.1.0 / 2.5.3 / 1.18.1 | 1 / 65 / 60 | 网格与数值分析 |
| `mujoco` / `pybullet` | 3.14.0 / 3.2.7 | 32 / 9 | 备选物理（exploratory） |
| `cadquery-ocp`（OCP） | 8.0.1.0.0 | 20（cp311-cp314） | B-rep/STEP（**后置**，见 §12.6） |
| `build123d` / `cadquery` | 0.13.0 / 2.8.0 | 1 / 1 | OCP 之上的 CAD API |
| **`rapier3d`** | **0.36.0** | 6 | rapier 官方 Python 绑定（f32） |
| **`numba` / `llvmlite`** | **0.68.0 / 0.50.0** | 5 / 5（cp313） | **MPM 内核 JIT 引擎**（2026-10-14 采纳：对 numpy 内核 5.1–8.7×、对 TS 1.3–2.0×，`experiments/20261014_numba_mpm_probe.md`）。cp313 wheel 仅 manylinux x64/arm64、macOS arm64、Windows x64/arm64——**musl 与 darwin-x64 由 `cad-exclude` 裁剪**（原因随包走），这些目标经 `worker._mpm_engine` 自动回落 numpy 内核；`CAD_MPM_ENGINE=numba` 强制时缺失会**响亮失败**，绝不静默回落 |

**conda-only（不用）**：`pythonocc-core`、`PyChrono`。注：PyPI 上的 `pychrono` 是**抢名的无关包**，不是 Project Chrono。

### 12.5 引擎默认策略：rapier 优先（2026-09-28 裁决）

> **能用 rapier 的都用 rapier**（无脑默认）；只有用户明确强调或 LLM 明确要求时，才走自实现的 MPM 脚本。

- 这是**默认偏置，不是取消分层判据**：`能用/不能用` 的判据仍是 L0/L1/L2 的**主语物态**——离散刚体/约束/接触/**可变形体** → rapier；连续介质流动/颗粒流 → rapier 无求解器 → MPM
- **软体也归 rapier**：rapier Python 绑定实有 `add_soft_body` / `add_soft_body_cluster` / `cut_soft_body`（**JS 绑定没有**）→ MPM 弹性本构降级为"显式要求才做"
- **防越界条款**（默认偏置的风险对冲）：答案若属于连续介质问题（流量/死区/灌装/颗粒），必须来自 MPM，**不允许用 rapier 输出充当该类答案**；越界使用（任一方向）应说明理由供人审
- **canonical 绑定纪律**：物理 canonical = TS 侧 `rapier3d-compat` 0.20（已验收 17/17 + 24/24）；Python 绑定 0.36 在物理迁 Python 前只作 exploratory。**同一个问题域只能有一个 canonical**

### 12.6 B-rep/STEP 后置（含实测反馈）

- 创始人实测：**`pythonocc-core` 效果不佳**（非 OCP；两者体验差异大——pythonocc-core 是 SWIG 直译 + conda-only，OCP 是 pybind11 + pip wheel）。OCP/CadQuery 路径**未被否定，但也未验证**
- 裁决：B-rep/STEP **继续后置**（本就排在装配与视觉表达之后）；将来真要 STEP 时按此顺序评估：**FreeCAD headless（Python，成熟 STEP 双向）→ cadquery-ocp → Replicad(JS/WASM)**
- 主循环**不需要 OCCT**：网格几何/装配检查/仿真用 manifold3d/trimesh/numpy；OCCT 只在 B-rep 任务里出现，可 lazy import 或独立 worker
- **2026-10-01 补充**：**STL 导入已交付，且不需要 OCCT**（§7.3）——"导入既有件"这条缺口的一半被证明与 B-rep 无关。STEP 导入的评估顺序不变，但已手头核实 `replicad` + `replicad-opencascadejs` 1.1.0 的 API（`importSTEP` / `exportSTEP` / `setOC`）与体量（~55MB wasm，无传递依赖），它是"留在 Node 栈"的那条路，且能顺带提供 B-rep→精确 datum。**引入与否是内核可插拔线上的决定，未做出。**
- **2026-10-15 补充**：**STEP 导入已交付，走的是 Python worker 而不是 Replicad**——`cascadio`（MIT，OpenCASCADE→GLB 转换器）+ `ezdxf`（MIT，DXF）进锁，`import_mesh` 内嵌转换，产物仍是焊接后的 `model.stl`，下游零改动（§7.3、DECISION-LOG 同日）。§7.1/本节的评估顺序（FreeCAD headless → cadquery-ocp → Replicad）**保留给还没做的部分**：STEP 导出与 B-rep 级精确 datum。IGES 维持边界（cascadio 静默失败已实测）。

---

### 12.7 Python 运行时供给（2026-10-08 落地 v1）

**决策与实测依据**见 `docs/DECISION-LOG.md` 2026-10-08 条目。一句话：**解释器是随插件
供给的产物，不是宿主机器的能力**——"别人机器上一定有可用的 Python"不成立（发行版 3.8~3.14
不等、PEP 668 禁装包、conda/pyenv 各说各话）。

- **来源**：python-build-standalone `install_only_stripped`，pin `cpython-3.13.16+20261003`。
  七个目标（linux gnu/musl × x64/arm64、darwin arm64/x64、win32-x64）的归档名与 sha256 锁在
  `dsh-cad-harness/src/host/python-lock.ts`，由 `scripts/gen-python-lock.mjs` 从官方
  `SHA256SUMS` 与 PyPI JSON 生成（`--check` 供 CI 校验漂移）。
- **时机**：**运行期**，不是安装期。`auto`（默认）启动只做健康检查、首次 `run_python`
  阻塞供给；`eager` 启动即后台预热；`off` / `system` 见下表。**没有 postinstall**——
  pnpm 11 会拦依赖脚本并要求 GUI 批准后重试，失败还回滚 `package.json`，安装期供给不成立。
- **落点**：`$DSH_HOME/cad/runtime/`（`python/<版本>`、`venv/`、`cache/`、`state.json`），
  跨项目共享；运行时**不进项目目录、不进 git**。
- **依赖**：numpy / scipy / trimesh / manifold3d / networkx / **scikit-fem** / **rtree** /
  **shapely** / rapier3d 0.36 / **numba 0.68 + llvmlite 0.50**（共 11 个），全部
  `--require-hashes --only-binary=:all:` 锁定，因此**任何平台都不需要编译器**。
  **rapier3d 没有 darwin-x64 wheel**：用户 2026-10-08 拍板——该平台**物理继续用 TS 引擎**，
  Python 侧不装它。**numba（2026-10-14 采纳）同样缺 musl 与 darwin-x64 wheel**，同一
  `cad-exclude` 机制裁剪；MPM 引擎的选择在 worker 内部解决（`worker._mpm_engine`，
  env `CAD_MPM_ENGINE`）：能 import numba 就用 numba，否则回落 numpy 内核——回落是
  平台事实不是故障，但**强制 `CAD_MPM_ENGINE=numba` 而不可用时必须响亮失败**。
  安装期写进 `state.json.skipped`，`python_runtime` 明说"这台机器上没有 rapier3d，因为没有
  wheel、物理留在 TS canonical"——**安装时就要确认下来**，不能让缺包看起来像坏包。
  **反向情形（2026-10-11 修）**：锁里**有**、venv 里却 import 不动的包，以前会被
  "标记文件匹配"判成已就绪（本机实测：标记 `requirementsSha=08b72cc0…` 而当前锁是
  `a21baffa…`，`rtree`/`shapely` 都 import 不了，`status` 仍报 `ready`）。
  现在 `venvIsCurrent` 之外**必须真的 import 一遍锁定包**才算 current：装完先验证再写标记
  （验证不过就抛错、不写标记，下次自动重试），`python_runtime` 新增 `missingPackages`，
  非空即 `state: failed`。**"就绪"必须是可证伪的**。
- **工具面与手册分层（2026-10-11）**：CAD 工具 **22 个**（由 25 个按功能合并：`measure_extent` +
  `check_connectivity` → `measure_part`；`measure_closest` + `measure_distance` → `measure_gap`；
  worker op 未变）。手册拆为三层：`skills/cad-toolbox/SKILL.md` 是**唯一点名全部工具的路由器**
  （约定 + 纪律 + 交付纪律），四个按工作的 skill（`cad-simulation` / `cad-assembly` /
  `cad-modeling-measure` / `cad-manufacturing`）按需加载，长案例史进各自 `references/`。
  doc test 的作用域据此分开："是否点名全部工具"钉在路由器上，"是否讲了某条陷阱/纪律"扫全树。
- **工具面**：`run_python`（内联 `code` 或既有 `.py` 脚本、超时、stdout/stderr、完整 traceback）
  与 `python_runtime`（status / provision / repair）。两者随 CAD 预设做可见性过滤，与其余
  CAD 工具同一条纪律。§12.3 的**常驻 worker 已于 2026-10-08 落地**（batch 0）：
  `python/cad_worker/worker.py` + `src/host/python-worker.ts`，同一接线点旁的第二种形态；
  由它驱动的**已迁移工具**（首批 `measure_closest`、`check_connectivity`）**要求运行时已就绪**，
  未就绪时 `ensurePythonWorker()` **3 ms 内**抛出可执行指引，而不是在工具的 60–180 s 超时里
  冷装（冷装实测 6–11 分钟）。
- **第一次用之前要做一次供给**：调用 `python_runtime` 工具 `action: "provision"`（有进度日志、
  不受其他工具超时限制），或设 `DSH_CAD_PYTHON=eager` 让启动时自动装。**代价（实测）**：
  归档 33 MiB → 解包约 105 MB + 依赖约 230 MB ≈ **380–400 MB**（本机实测 `state.json`
  报 **402,590,642 B**），全部在 `$DSH_HOME` 下、
  不进项目与 git；耗时 **3–11 分钟**（同一台机器两次实测：走 npmmirror + 阿里云 **174.6 s**
  与 683 s；GitHub 直连曾 >20 分钟）。本机若有 CPython ≥3.10，可用 `DSH_CAD_PYTHON=system`
  跳过解释器下载（依赖仍按 hash 锁定，但解释器不再是那个 pin 住的构建）。
- **不做沙箱**：子进程以宿主用户身份运行，与 `bash` 同级。本插件的主张是**可复现**
  （锁定的解释器与依赖），不是隔离——把它说成沙箱才是真的撒谎。

| 变量 | 作用 | 默认 |
|---|---|---|
| `DSH_CAD_PYTHON` | `auto` / `eager` / `off` / `system` | `auto` |
| `DSH_CAD_PYTHON_BIN` | `system` 模式下的解释器绝对路径 | PATH 上的 `python3`（须 CPython ≥3.10） |
| `DSH_CAD_PYTHON_MIRROR` | 解释器归档的下载根（替代官方源） | 官方 GitHub，失败依次转镜像 |
| `DSH_CAD_PYTHON_INDEX_URL` | pip 索引 | PyPI → 阿里云 依次尝试（同日实测 npmmirror 的 PyPI 路径 404、TUNA 403） |
| `DSH_CAD_PYTHON_ROOT` | 运行时落点覆盖（测试/多实例用） | `$DSH_HOME/cad/runtime` |

**Opt-in 开关（默认关；标准/日常会话行为不变）：**

| 变量 | 作用 |
|---|---|
| `DSH_CAD_IMAGE_WINDOW=1` | 让**没有预设名的会话**也套用造物模式的 **24 张图像保留窗口**。为什么需要：headless（`dsh --profile headless`）不 compose 预设注册表（`preset-cad` 停在 pending），于是 `presetOfSession` 为 null、窗口不生效——2026-10-10 实测 03-microscope 的渲染会话把请求堆到 **70 张图**，被上游以 `Too many images in request: 70 > 64` 拒绝，A 段 exit 1、B 段直接不跑。带真预设的会话（`standard`/`cad`）**不受此开关影响**。 |

**诊断开关（只用于定位，**绝不可在生产设置**；全部只影响日志/对照，不改变工具 schema）：**

| 变量 | 作用 |
|---|---|
| `DSH_CAD_FLUID_PYTHON=0` | 让 `simulate_fluid` 回退到 TS oracle（默认走 Python canonical） |
| `CAD_FLUID_NO_PROJECT=1` | 跳过流场的 SDF 投影（二分"投影 vs 内核"用） |
| `CAD_FLUID_DEBUG_PENETRATION=1` | `fluid_run` 返回穿透深度分布、梯度、投影/入口计数器 |
| `CAD_FLUID_DEBUG_PROJECT=1` | TS 侧返回投影/入口计数器（与上一条对拍用） |
| `CAD_FLUID_DT` | 覆盖流场时间步（量"离散化 vs 舍入"用；步数需同步调整） |
| `CAD_MPM_JITTER_AMP` | 覆盖 MPM 初始抖动的幅度（量结果对输入扰动的敏感度用） |

**实测（本机 Arch Linux，2026-10-08）**：归档 33.4MiB 压缩 / 105MB 展开 / 下载 3.5s；venv +
八个依赖全部命中预编译 wheel；**冷启动（下载归档 + 装约 230MB 依赖）实测 353–476 秒**，
视镜像与网络而定；总占用 **381–383 MiB**；**默认 PyPI 直连同一批依赖用了 11m44s**，
故索引必须可配且默认带镜像兜底，供给过程必须有进度（`python_runtime` 与 `run_python`
都会回报阶段与错误）。

**验收**：`node dsh-cad-harness/scripts/accept-python.mjs`——锁完整性、解包器安全
（拒绝路径穿越/绝对路径/逃逸符号链接）、真实供给（建 venv + 装锁 + 六库导入）、执行与
traceback、关闭开关。`--quick` 跳过网络段。

---

**本文档结束。** 定位级变更在此追加版本记录；实现级变更仍归 DESIGN.md。
