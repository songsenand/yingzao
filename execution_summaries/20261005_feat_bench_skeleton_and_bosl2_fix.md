# 执行摘要：评测题库骨架 + BOSL2 接线修复

## 动机

现有 `examples/` 的五份显微镜示例主观成分过重，无法回答两个问题：
（a）插件优化后能力是否真的提升；（b）哪个 LLM 与本插件配合最佳。
用户拍板建立一套"从易到难"的可重复题库，并确定为可自动评分的形态。

核查中同时发现一个会让整个评测失效的缺陷：`compile.ts` 把 `OPENSCADPATH`
指向 `lib/BOSL2` 而非其父目录 `lib`，导致所有 `include <BOSL2/...>` **静默失败**
（OpenSCAD 只给 WARNING、顶层对象为空、编译仍报成功）。microscope5 交付摘要
第 7 条"BOSL2 在编译环境不可用：齿轮为手写渐开线（弧段法），螺纹为
rotate_extrude 弧段法"正是这次缺陷的现场记录——一次工具接线 bug 被记成了模型的
短板。跑基线前必须修掉。

## 影响范围

- `docs/DECISION-LOG.md`：追加 7 条方向性决策（append-only）。
- `.gitignore`：评测基准的生成物规则（考生侧语料、导入件、评分方打分输出）。
- `dsh-cad-harness/src/host/compile.ts`：`OPENSCADPATH` 解析逻辑。
- `dsh-cad-harness/scripts/accept-bosl2.mjs`（新增）：BOSL2 接线回归钉子。
- `dsh-cad-harness/scripts/accept-motion-pivot.mjs`（新增）：pivot 重基回归钉子。
- `examples/bench/`（新增）：`subjects/`（考生侧）+ `graders/`（评分方）两侧，
  五道题的题面/判据/答案、净化后的参考图与地标、两个工具脚本。
- `execution_summaries/`：本文件。

## 具体操作步骤

1. **决策记录**：`docs/DECISION-LOG.md` 追加 6 条——题库定位与按"综合度"排序、
   木质长凳不压打印性、外观以图为准、参考图净化与 band4 剔除、BOSL2 修复与
   回归钉子、rubric+runner 交付形态。
2. **修 BOSL2**：`src/host/compile.ts` 的 `bosl2Dir` 改为按"包含 `BOSL2/` 的那一层"
   解析，兼容打包（`<plugin>/../lib`）与直跑源码（`<plugin>/src/../../lib`）两种
   `pluginRoot` 语义，并把 `lib/BOSL2` 自身也列入搜索路径，使裸
   `include <std.scad>` 同样可用。
3. **新增 `scripts/accept-bosl2.mjs`**（14 项断言）：路径形状、`spur_gear(mod=1,teeth=20)`
   外径 22±0.5、`screw("M6",length=20)`、裸 include 拼写。
4. **新增 `scripts/accept-motion-pivot.mjs`**（12 项断言）：默认 pivot 取自首个
   命名该件的关节锚点、无关节时回退几何中心、显式 `pivot` 覆盖、且 run 内存的
   STL 真被平移到该点、整圈关节漂移与违规。**此前 `grep -l pivot scripts/*.mjs`
   为空**，这条历史故障没有任何覆盖。
5. **`examples/bench/`**：`README.md`（跑法、五列评分、rubric 格式、状态表）+
   `00-smoke/`（无 LLM 的仪器校准配方 + rubric）、`01-mortise-bench/`、
   `01b-diagnosis/`、`02-steam-engine/`（+ `assets/`）、`03-microscope/`，
   每题 `prompt.md` + `rubric.json` + `key.md`（00-smoke 无 key，rubric 即规格）。
6. **参考图**：新增 `tools/purify-reference.py`，从用户提供的 `显微镜参考图.png`
   剥离 122 个水印碎片、裁切到主体 +60px 边距，输出
   `03-microscope/参考图.png`（530×887）与 `landmarks.json`（十段剖面，band4 标为
   转换器带并排除）。脚本内建守卫：裁切后若仍残留非主体碎片则拒绝写文件。
7. **`tools/materialize-01b.mjs`**：`dossier` 模式生成入库的 JSON 证据子集
   （69 个 run 的 run.json/report.json + assembly.json + cad-data manifest，
   约 1.1MB）；`corpus` 模式生成可被 CAD 工具读取的完整语料（gitignored）。
   两种模式都**刻意排除** microscope5 的 PROJECT.md / execution_summaries / docs
   ——读被告的自述不叫诊断。
8. **02 的导入件**：`graders/02-steam-engine/assets/make-608.scad` 提供 608 轴承
   示意实体（OD22/孔8/宽7）的生成源；生成的 `subjects/.../608.stl` 不入库。
9. **考生侧 / 评分方分离**（用户拍板）：`examples/bench/` 拆成
   `subjects/<题目>/`（会话 cwd 只能落这里，只放题面要求它看的东西）与
   `graders/<题目>/`（题面、rubric、答案、夹具、参考图、地标，绝不进会话）。
   题面与附件由 runner 从 `graders/` 读出后作为对话文本/附件发出。
   每份 `rubric.json` 的 `gates` 首位新增 `g-grader-access` 硬门：
   transcript 中任何工具调用的路径或参数触达 `graders/`、`key.md`、
   `rubric.json`、`landmarks.json` → 该轮作废。
10. **手册的定位纠正 + 基准冻结 + `S` 列**（用户拍板）：初版把 `cad-toolbox` skill
    里已写明 microscope5 失败细节这件事，当成"泄题"去设计掩蔽方案。用户指出这个
    框架是错的——**手册是 SUT 的一部分，不是污染源**；正确的做法是把"手册能否
    正确生效"变成被测指标，而不是改手册。
    落地：①SUT 定义为 `dsh-cad-harness`（含 skill）× 模型，并随 git commit +
    `SKILL.md` sha256 冻结为基准 v0；②边界规则改为"属于 SUT 的不算泄漏，
    SUT 之外的答案来源才算"，取代"防泄漏"表述；③**所有 LLM 题统一在造物模式跑**，
    手册出没出现由 SUT 的加载逻辑决定，不人为干预；④每份 rubric 的所有条目标注
    `inSkill`，`scoring.columns` 加入 `S`（skill 生效度）与 `S0`（是否被加载）；
    ⑤01b 的对照由"有/无手册"改为**skill 版本 A/B**（换文件而非改消息），
    主读数为 `S`，成本从 30 分钟回到 15 分钟单臂。
    分类标注实测：`SKILL.md` 中 "negative control"/"阴性" 出现 **0** 次，
    `coaxial` 3 次、`delivery_audit` 1 次、`staticFriction` 2 次、`datum` 18 次
    ——手册确有覆盖也有遗漏，`inSkill` 因此有真实区分度。
    **负面控制全部落在能力项**：手册从未要求跑阴性对照，所以"阴性对照有没有命中"
    不会被 `S` 列掩盖。
    考生题面单独拆出为 `arm-A.md`，`01b/prompt.md` 改为操作者侧的实验设计。
11. **题库手册归位 + 一页总表**（用户要求"总结当前的试卷和考场"时自查命中）：
    按上一步的边界规则逐文件复查，发现 `examples/bench/README.md` 正文里就写着
    01b 的结论（"26 条接口全绿……两次都是 `fail`"），而它不在 `graders/` 下，
    `g-grader-access` 的清单式路径规则盖不住。处置：手册移入
    `graders/README.md`；检测规则收紧为"`graders/` 下的一切"；
    根目录只留不含任何判据/答案的导航桩；在手册里新增 §〇 一页总表
    （试卷 / 考场 / 判据规模与预算 / 六列权重），并声明**手册不入考场**——
    由 SUT 自己决定加不加载，是否加载记在 `S0`。
12. **考卷落到考生侧并与操作说明分家**（用户提问"考卷在哪里？要确保提示词都相同"）：
    原先五份文件都叫 `prompt.md`，其中四份其实是考卷、只有 01b 是操作者说明
    （考卷另在 `arm-A.md`），既答不出"考卷在哪"，也没有任何东西能证明两轮用的是
    同一份文字。处置：考卷统一为 **`subjects/<题目>/TASK.md`**（唯一权威副本，
    考生可见——它本来就是发给考生的东西）；`graders/<题目>/prompt.md` 只作
    操作说明、永不粘给考生；每份 `rubric.json` 记 `taskFile`（路径 + sha256）；
    README §六 要求开跑前核对 `sha256sum subjects/*/TASK.md` 并写进分数文件。
    参考图仍只从评分方侧作对话附件发，**不**放进考生目录（否则 `p-reference-recall`
    探针失效）。
13. **考卷口径线 + 03 拆两段**（用户拍板："在试卷上圈出重点才算是泄露"；
    选定"先在 03 试点两段"+"这批一次做完"）：
    - **口径线：规格留，口径删。** 从四份考卷删/改 6 处评分口径与提示——
      "是要扣分的"/"按没有回答算"/"填错……扣得多"/整段参考图提示/
      "考的是"→"做的是"/"刻意剔除"→"没随交付留下"。
    - **修掉一处真泄漏**：`01b` 考卷原以 `r048` 为示例，而它正是答案中
      "覆盖全部 16 件、fail"的两次之一。改为中性占位。
    - **`03` 拆两段**：A 段 `TASK.md` 只给规格（几何、契约格式、里程碑、阴性对照、
      可打印性报告、固定视角出图）；B 段 `TASK-2.md` 才给验收仪式（外观逐项对照并
      修正最不像的两处、机构进契约被机检、整机级验证 + 对应最终版本的整机渲染、
      `delivery_audit`）。各判据加 `stage` 标记（A 26 / B 6 / 共用 1），
      新增 `delta = B − A` 与 `c-appearance-diff`。
    - **补判据缺口**：`03` 新增 `c-stdlib-used`（`inSkill: true`）；
      `02` 的 `stability.json` 加 `counterweightMassG` / `criticalTiltDeg`；
      四份考卷统一收尾清单。更正此前"标准库判据第 2、3 题都成立"的说法——
      `02` 规格里没有齿轮/螺纹，如实不设。
    - **两段的可实施性**：分界靠 B 段 user 消息的时间戳**事后切分**，不需要写会话
      驱动器；发 B 段前须核对 transcript 已出现参考图的 `image omitted` 占位。
    - **指纹全部重录**（考卷改过，旧指纹作废）。
14. **`00-smoke/rubric.json` 的泄露体检与三项顺延**（用户提问"会不会泄露答案？
    需不需要移动到答案的文件夹？"）：查实它**已在评分方侧**
    （`realpath` 指向 `examples/bench/graders/00-smoke/rubric.json`，`subjects/` 里
    `rubric.json` 数为 0），因此**不需要为防泄露而移动**。逐级扫答案要素：
    `01`/`01b`/`03` **零命中**，`02` 仅命中 `staticFriction`/`保持力`，而这两条
    `SKILL.md` 里同样有（属 SUT 内，按口径线不算泄露）。发现一处该改：
    `g-delivery-audit` 的 `evidence` 写着"microscope5 用旧版本绿灯撑新版本结论"，
    是 `01b` 结论③④的转述。用户决定**暂不动**，三项随 `bench-smoke.mjs` 一并定
    （中性化该句 / 定归属 / 逐条确认 `evidence`→`accept-*.mjs` 映射），
    已登记在 `graders/README.md §九`。
    另把一条**写法约定**写进 `graders/README.md §四`：评分方文件引用历史失败时
    **写工具层面的因果，不写那一轮的结论**；判据是"把这句话给一个正在做那道题的
    人看，他会不会因此少读一份证据"。
15. **删掉 `subjects/00-smoke/`**（用户指出"里面压根就没有试卷"）：该目录只有
    一个 `.gitkeep`，是为凑 1:1 目录镜像而留的空壳，而 `00-smoke` **没有考生、
    没有考卷、也没有考场**——它由 `bench-smoke.mjs` 在临时目录里直接驱动工具，
    不需要会话。删掉后 `subjects/` 只剩有考生的四题，与"考卷在考生侧"的规则
    一致。`graders/README.md` 的表 2、目录树与铁律 1 已注明；
    `graders/00-smoke/prompt.md` 开头补了"本级无考场"的说明；
    根目录导航桩同步。**未改任何 rubric 或考卷，指纹不变。**
16. **操作手册回到根 `README.md`**（用户要求"详细说明如何进行测评"）：
    先前把手册整份搬进 `graders/`、根目录只留导航桩，是把**位置**当成了防线，
    代价是操作者找不到跑法。改为**按内容分工**：
    - 根 `README.md` = **操作手册**（详细）：目录含义、基准指纹表、备料命令、
      每题场地与题面（含 03 两段流程）、每轮固定条件、记分字段、复核清单、
      常见错误、索引；**只写"怎么跑"**。
    - `graders/README.md` = **设计与判据**：考什么、排序理由、SUT 与基准的道理、
      边界与写法约定、六列评分、rubric 格式、状态与待办。
    - **同一数字只留一处权威副本**：指纹表移去根 README §2，`graders §二` 改为
      讲理由并指向它；`graders §六` 的步骤表删除改为指针，避免两份清单漂移。
    - **内容约束**写进根 README 顶部并回引 `graders §四`：不得含答案、不得含
      "考什么"、不得含测试设计意图（点名探针/硬门、写"两臂"、"自发 vs 被要求"、
      暴露 `inSkill` 等字段名）。
    - 擦洗后实测：答案要素与测试设计要素的词频**全部为 0**（首轮草稿曾各命中
      1–2 处，逐条改写）；交叉引用（`§六`→根 `§5`、`§二`→根 `§2`）已修正。
    - **未改任何考卷，四份指纹不变。**
17. **headless 自动化通道**（用户提问"能不能在沙盒里跑"→ 选定 B→A→C 执行）：
    查实 `dsh` 自带官方非交互入口 `@deepseek-ai/dsh-headless`，且
    `~/.dsh/profiles/headless/` 已链好本插件。**三次实测**：
    - `--help`/`--dump-config`：`--json`、`--session-id` 可用；模型来自
      `agent-default-model`（可 `--patch` 覆盖）。
    - 真跑一次：`exit=0`；模型列出 17 个 CAD 工具（**工具在**）；stderr
      `preset-cad … pending (waiting for service: agentPresets)`（**手册不在**）；
      `step_end.usage` 自带 token 成本。
    - 带 overlay 再跑：`skill` 加载 `cad-toolbox` 返回 `completed` +
      `<skill_content name="cad-toolbox">`（**手册已挂上**）；`tool_call` 事件为
      `{callId, tool, input}`，**`input` 带完整参数**（`g-grader-access` 可直接扫）。
    产出：`examples/bench/tools/headless-overlay.yml`（接回手册根 + 每轮钉模型）；
    根 README 新增 §12；`graders/README.md` 新增 §二·五（两档基准不可混算）；
    DECISION-LOG 第 18 条。
    **收益**：run root 开在仓库外 → 考生目录里不再有任何评分方材料，
    探索工作区时不会顺带撞见。
    **但不等于物理隔离**（Agent 能读绝对路径），`g-grader-access` 仍然必要。
    **已知限制**：headless 无附图通道（`attachment`/`image` 零命中）→ `03` 出
    headless 版（参考图放 run root），`p-reference-recall` 语义相应变化。
18. **`examples/bench/tools/bench-run.mjs`**（C）：把 headless 命令封成"一题一轮"。
    做七件事：仓库外建 run root → 复制考生侧 → **核对考卷指纹**（不符即拒绝开跑）
    → 查素材（02 的 `608.stl`、01b 的 `dossier`）→ 生成当轮 `model-overlay.yml`
    → 逐段跑 `dsh`（`03` 两段共用 `--session-id`，两份事件流天然是分界）
    → 写 `run-record.json`（退出码、耗时、`usage`、sessionId、指纹核对、**原命令**）。
    纪律写死在代码里：run root 落在仓库内直接拒绝；`03` 打印待办并拒绝。
    `--dry-run` 不花模型调用即可预览。另把 `headless-overlay.yml` 拆成**只管手册**，
    模型由每轮生成的小 overlay 承担（避免两份文件写同一行时谁赢说不清）。
19. **更正一处过强的表述**：先前说"run root 开在仓库外 → `graders/` 物理够不到"
    **是错的**——Agent 有 bash，能读绝对路径，`ls /` 一样能发现仓库。run root 在外
    只消除**探索工作区时的顺带发现**。已在根 README §12.4、`graders/README.md`、
    DECISION-LOG 与本文四处改正，并明确 **`g-grader-access` 仍然必要**（实现上现在
    更简单：直接扫 `tool_call.input`）。真正的物理隔离需要容器/独立挂载。
20. **`03` 保留两档**（用户拍板）：新增 `subjects/03-microscope/TASK.headless.md`
    （与 `TASK.md` **只差 2 行**）；`TASK-2.md` 里"附件里的参考图"改成档位中立的
    "参考图"（两档共用一份第二段）。**`TASK.md` 指纹未变**（`93f60211…`），GUI 档
    与既有记录不作废。`graders/03-microscope/rubric.json` 改用
    `variants.{gui,headless}`；`bench-run.mjs` 加 `--variant`（`03` 默认 `headless`；
    `gui` 档在 headless 下如实拒绝并指路）。
    理由：全自动是手段不是目的——headless 没有附图通道，
    `recall_reference_image`（18 条工具之一，只在附件被裁剪时触发）会**永远不被
    调用**，等于题库少测一条插件能力。两档并存的增量成本只有"两行考卷 + runner
    一次复制"。文档同步：根 README §2/§3.3/§4/§12.5、`graders/README.md`
    §二·五/表 1/表 2、`graders/03-microscope/prompt.md`；DECISION-LOG 第 19 条。
21. **沙盒写入 README**（用户要求）：查实 headless 跑评测**自带出厂文件沙盒**
    （`dsh-base` 组了 `sandbox-policy`/`sandbox-local`/`bash-sandbox`/`fs-sandbox`
    + 审批与权限预设）。根 README 新增 **§12.5**：写受限（`workspaceRoot =
    process.cwd()` = run root ⇒ **改不到真实仓库**）、读不受限（`dsh-fs-sandbox`
    原话"while preserving the local filesystem's read behavior"）、**bash 每条命令
    60 秒上限**、升级请求在 headless 下 fail-closed。`graders/README.md` §二·五
    的两档表加"沙盒工作区"一行（手工档考卷**可写**、headless 档写不进去）。
    DECISION-LOG 第 21 条。
22. **开测第 1、2 步执行完毕**：
    - 生成 `subjects/02-steam-engine/assets/608.stl`（已 gitignore），并用
      `importGeometry` 验**正例 + 反例**：正例 bbox 精确 `[22, 22, 7]`、
      2198.1 mm³；反例（砍半的网格）被拒。
    - 跑整套 25 个 `accept-*.mjs` 当仪器校准 → 首轮 24/25，
      `accept-tool-scope.mjs` 的 2 个 FAIL 判定为**检查过期**（在验上游已删除的
      `@deepseek-ai/dsh-agent-presets` 名册包；插件的 `preset-cad` 声明行在 web 档
      正确组出）。已修该脚本第 4、5 节 → **25/25 全绿**。详见
      `20261005_fix_stale_preset_scope_check.md`。
    - 附带修正：先前把 OpenSCAD 的 `Volumes: 2` 当成"夹具不相连"是**错的**——
      实测纯管件也报 2（外表面 + 内孔）；守门员是 `import_part`，不是那个计数。

## 预期风险与验证

- **风险点 1：BOSL2 修复改变 `OPENSCADPATH` 形状**，可能影响按旧路径写的 include。
  缓解：`lib/BOSL2` 自身也保留在搜索路径中，两种写法都能解析。
  **验证：`accept-bosl2.mjs` 14/14 全绿**（实测外径 21.99mm、面宽 6.00mm、
  M6 螺钉轴向 20.00mm）。
- **风险点 2：pivot 回归脚本可能测不到真实缺陷**。缓解：不只断言元数据
  `pivots`，还读取 run 目录下的零件 STL，断言其包围盒中心被平移到枢轴点
  （旧行为下零件会停在 x≈120）。**验证：`accept-motion-pivot.mjs` 12/12 全绿。**
- **风险点 3：参考图裁切后比例失真**。缓解：`landmarks.json` 只记归一化量
  （除以主体像素高），不记绝对像素；脚本对残留碎片有硬守卫。
- **风险点 4：题库判据过严或过松**。首轮基线跑完才能定阈值；所有 rubric 的
  `calibration` 字段一律标 `uncertain`（`01b` 除外，其判据是客观事实统计）。
- **风险点 5：考生侧 / 评分方分离只挡误触，不是安全边界**。Agent 有 bash，
  能读绝对路径。缓解分两层：目录分离（挡"列目录顺手读"）+ `g-grader-access`
  transcript 检测（挡主动去找）。已把两处无法在仓库内消除的残留暴露面
  （`docs/DECISION-LOG.md`、`examples/microscope5/**`）登记进 README §四；
  彻底消除需把 `subjects/` 复制到仓库之外的独立运行根。
- **已知缺陷（已处置）**：首版 `608.stl` 生成后 OpenSCAD 报 `Volumes: 2`
  （非单连通体，`import_part` 会正确拒收），且体积 4MB。已删除该产物，
  改为只保留 `make-608.scad` 作为生成源，并要求运行前生成一次。

## 未完成（移交下一步）

- `dsh-cad-harness/scripts/bench-smoke.mjs`：把 `00-smoke/rubric.json` 执行起来。
- `dsh-cad-harness/scripts/bench-score.mjs`：读语料输出 P/E/H/C/R 五列，
  并实现 `g-grader-access` 的 transcript 检测。
- 首轮基线：跑一遍定阈值，回填各 `key.md` 的"待基线回填"小节。

## 文档同步评估

- `README.md`（仓库根）：无环境变量/启动命令/对外 API 变更 → **不需要更新**。
- `docs/DESIGN.md`：本仓该文件为 `DESGIGN.md`；本次改动影响插件编译路径解析，
  **需要**在该文件登记 BOSL2 路径语义（下一步随基线一起补）。
