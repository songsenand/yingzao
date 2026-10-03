# microscope3 设计对话审计 · 还有什么可提升

依据：`examples/microscope3/{PROJECT.md, DESIGN-REPORT.md, assembly/*}` + 真实语料
`~/.dsh/cad/microscope3-1091031a/`（16 零件 / 36 版本 / 32 runs，2026-10-01）。

## 语料里的客观事实（复核自 run/manifest，不是抄报告）

- 版本返工分布：**调焦滑座 9 版**、齿轮轴 4 版、压片簧 3 版、弯臂/精调环 3 版；
  调焦线两个零件从 15:46 一直改到 16:17（31 分钟）——大头全部烧在 §5.1 的角度/弧度 bug 上。
- runs：assembly-check ×12（几乎每次改版后都重跑 ✓ supersede 链 r019→r024→r026→r028→r030→r031 正常）、
  motion ×10、assembly(validate) ×7、physics ×3。
- r025（最终 motion）实际报告值：行程 25.49mm、干涉 0、关节漂移 0 —— 与 DESIGN-REPORT 一致 ✓。
- r021（整机 5° 斜面）实际报告值：`settledPenetrationMm: 6.4088, settled: false`，
  且底座整体下陷（final z=−4.0）——报告 §6 如实转述了 ✓。
- generate_part 的输出 schema 里**没有 solid/watertight 字段**（tools.ts 已核实）；
  只有 import_part 和 measure_part 会报。这是本轮最大事故的直接放大器（见 P0-1）。

## 上一轮修复的落地确认（都起作用了）

| 修复 | microscope3 里的证据 |
|---|---|
| workspace 优先的 manifest 解析 | `assembly-check-report.json.manifestPath` 直接指向 examples 目录 ✓ |
| validate_assembly 装配渲染图 + 摘要文本 | 7 次 assembly run，agent 不再手读 report.json |
| motion pivot 修复 + pitchRadiusMm | r025 行程 25.49、0 干涉、0 漂移；报告 §4 明说"不用正弦近似" |
| prismatic（两处） | M2 滑座、M4 问题 4 的准确表述都依赖它 |
| check_assembly `skipped` 数组 + motion-clearance 证据链 | 28 接口 pass、skipped=0、IF-07 引用 r025 |
| adjacencyThresholdMm + undeclared | 故意不声明的弯臂↔载物台被抓出 ✓ |
| merge_parts | 整机刚体 v031 一次成功（对照 microscope2 手工 2.5min+失败） |

---

## 本轮新暴露的问题（按优先级）

### P0-1 generate_part 不报 watertight —— 本轮最大事故的直接放大器

**现场**：齿轮轴的角度/弧度 bug 产出非闭合网格 + 假齿形。`measure_part` 本来一秒就能抓到，
但 generate_part 的返回里没有 watertight 字段，agent 没理由对每个新版本多调一次 measure_part；
结果错误齿形被当滚刀去切齿条，连锁打补丁（滑座 9 版、轴 4 版），最后靠**用户截图**才发现。
DESIGN-REPORT §5.1 自己写的教训："watertight 应该在用任何零件之前先过一遍"——
这句话不该靠纪律，该靠工具。

**修法**：generate_part 成功路径里本来就在 parse STL 算 bbox（tools.ts L460），
顺手跑同一个真值检查，把 `solid / watertight / triangles / shells / genus` 加进结果与 schema；
**非闭合时在 finalizeContent 文本里加显式警告**（"非闭合网格——后续所有几何检查都在假前提上运行"）。
可选加硬一点：`allowNonSolid` 语义与 import_part 对齐。

### P0-2 OpenSCAD 度/弧度陷阱没进 skill

**现场**：`sin/cos` 吃度、`asin/acos/atan` 吐度，渐开线公式要弧度；**节圆上恰好抵消**，
自检数值看起来是对的，离节圆整片垮掉。这是 OpenSCAD 画齿轮/螺纹/凸轮的通用雷，microscope2 没踩是因为没画渐开线。

**修法**：SKILL.md 加一条显式规则（`d2r/r2d` 换算 + "用 `measure_part` 的 watertight 自检齿形"）。
顺带把 §5.1 教训的后半句也写进去：渲染"像不像"是次要证据，watertight 是首要证据。

### P0-3 measure_closest 在坏网格上给假余量

**现场**：§5.1 第 4 条——bug 存续期 `measure_closest` 报 0.05mm"余量"，是假象。
工具对输入网格不做闭合性把关，最近点对在开放网格上没有定义良好的意义。

**修法**：measure_closest（以及 measure_distance 的表面吸附）先查输入版本的 watertight，
非闭合时在结果里加 hard warning（不拒绝，但要吼）。

### P1-1 同轴度算子仍然缺席（PROJECT 缺口 ②，本轮裁决：该做了）

**现场**：接口 14/15 退化成"两点 distance"代理，报告 §3 自己承认 `skipped=0` 是因为
"都写了 check: distance"——**这是把缺口藏进声明里，不是消掉缺口**。
PROJECT 的裁决标准写得很清楚："优先级看这次 M3 有多难受"——它难受了，还写进了"没做干净"。
axis/cylinder datum 都解析得出来，缺的只是消费它们的算子。

**修法**：`coaxial`（两 cylinder datum 的轴间距 + 中点错位）作为 L0 算子，
配套 `parallel` 可以顺带。这条从 microscope2 拖到 microscope3 了，不该拖到第三个项目。

### P1-2 validate_assembly 表达不了"装配位姿"（§5.2 位姿记账）

**现场**：`carriage↔shaft` 在名义位姿报 11.62mm³，真实啮合角差 0.7 rad。把转角写进清单
`transform` 能修干涉，但会连坐转走 D 形轴端和 datum（旋钮 D 孔对不上、datum 飘 6.91mm）。
根因：清单 transform 绕**零件原点/世界原点**转，而"装配位姿"需要的是**绕某个 datum 轴转一个角**，
且 datum 本身要跟着转。

**修法**：清单 per-part `pose: {about: <datumAxis>, angleDeg}`——绕自身 datum 轴的装配转角，
datum 随动。这是 §5.2 那段分析的直接产品化，也让 motion 起步位姿能等于啮合位姿。

### P1-3 simulate_physics 多 shell 刚体的穿透数会骗人（r021 = 6.41mm）

**现场**：46-shell 合并体、底面只有 4 个胶垫圈接触，接触求解退化，穿透 6.41mm、`settled: false`。
PROJECT 的验收线是 <0.05mm，agent 只能靠自己去解释"这是工具侧观察不是设计结论"——
工具应该自己说这句话。

**修法**：物理 run 报告里加输入诊断（shell 数、与地面的接触面对数），
当 shell 多且接触稀疏时给 metrics 附注 "penetration unreliable for this contact topology"。
更好的方向（可后置）：落地前把多 shell 体按 shell 拆成复合刚体再喂 rapier。

### P1-4 prismatic 的"保持力"语义（PROJECT 缺口 ④，本轮裁决：改名字了，但没解决）

**现场**：报告 §5 问题 4 的表述很准确——prismatic 有了，但它是运动约束不是保持力模型，
"装得对不对"能仿真，"保持得住吗"仿真不了。缺口没消失，只是换了名字。

**修法**（务实版，不必上完整摩擦求解）：给 prismatic 关节加可选 `staticFriction` 参数，
物理 run 结束后做一个解析判定：`μ·m·g_normal` vs 沿轴重力分量，报"自锁 / 会滑"结论 +
明确标注这是准静态解析不是动力学。够回答显微镜/蒸汽机这一类问题。

### P2-1 螺纹面亚 µm³ 干涉噪声

**现场**：`fine-ring↔mount` 0.36mm³ 残差（多边形分段），最终 check 里仍是噪声。
给 validate_assembly 加 `interferenceEpsilonMm3`（默认给个 1e-3 级），小于它的干涉归"贴合/残差"不算违规。

### P2-2 斜面重心得手算重力向量

**现场**：PROJECT 得教 agent `[9810·sin5°, 0, −9810·cos5°]`。给 simulate_physics 加
`tiltDeg` 便捷参数（或文档一行公式），省掉一次容易错的手算。

### P2-3 打印约束是"第三类知识"——本轮 agent 表现好，纯靠自觉

**现场**：PROJECT 缺口 ⑧ 的担心**没有成立**：DESIGN-REPORT §7 主动交代了免支撑/层方向/
桥接跨度/打印时长，质量很高。但这是模型自觉 + 提示词点名，不是工具或 skill 保证的。
低风险改法：把 §7 那套检查单浓缩进 SKILL.md（悬垂轴沿 Z、桥接 ≤30mm、弹性件竖打、
螺纹牙距下限），不改工具。

## 不用改的（本轮证据）

- **面板通道**：缺口 ⑦ 担心"没人用面板"，实际本轮两次靠面板截图发现真 bug（§5.1、§5.3）——
  面板价值被证实，渲染图 + 面板双通道成立。
- **图片修剪**：本轮未见"记不清第 3 版"的失败（缺口 ⑥ 未触达）。
- **supersede 机制**：12 次 assembly-check 链条干净，老 run 标注 `supersededBy` 正确。
- **外购件绕行模式**（缺口 ①）：agent 按 PROJECT 教的方法把 stock 件折进 datum，
  15 条生成↔生成接口全机检——模式可行，"stock 件占位几何"仍是真缺口但可以继续等蒸汽机项目。
- **PROJECT §5 记录表是空的**：不是插件问题，是试用纪律问题；工具用时数据我已从语料里补齐。

## 建议动手顺序

1. **P0-1** generate_part 报 watertight（半小时级，杠杆最大）
2. **P0-2** skill 写入度/弧度陷阱 + "watertight 优先于渲染"（纯文档）
3. **P0-3** measure_closest/distance 对坏网格吼（小）
4. **P1-1** `coaxial` 算子（中，欠了两轮的债）
5. **P1-2** 清单 per-part datum 装配位姿（中）
6. **P1-3 / P1-4** 物理侧两个诚实性补丁（中）
7. P2 三条顺手做

---

## 修复记录（2026-10-02，按上文建议顺序全部落地）

| 项 | 改动 | 验证 |
|---|---|---|
| P0-1 | `generate_part` 每次保存都报 `watertight / triangles / shells`；非闭合时结果文本加 ⚠️ 警告、`warnings` 数组带可执行建议 | accept-p3：开口 polyhedron → `watertight:false` + 文本尖叫；闭合 cube → true 静默 |
| P0-2 | SKILL.md「Traps」新增两条：度/弧度陷阱（节圆抵消的阴险性、microscope3 案例）与「Watertight beats pretty」 | accept-p3 用 grep 断言（文档测试） |
| P0-3 | `measure_closest` / `measure_distance` 对非闭合输入加 hard warning（不拒绝，datums 仍精确解析） | accept-p3：开口片有警告、闭合件静默、数值不受影响 |
| P1-1 | `coaxial` L0 算子：轴线-轴线间距（skew/parallel 通式）+ 轴间角；轴不平行时在 detail 里点名"offset pass ≠ bores line up"（hard 升级）；点端点 → skipped 带指引 | accept-p3：0.5mm 平行轴实测 0.5；0.8 vs 0.2 → hard；点端点 → skipped |
| P1-2 | manifest 节点 `transform.pose {datum, angleDeg(, axis)}`：绕**自身 datum 轴**的装配转角，datum 随动；`validate_assembly` 的 parts 也接受同名 `pose`；走 3×3 矩阵进 solidify，不经欧拉角折叠 | accept-p3：90° 摇臂 datum 尖端精确落靶、几何真的撞障碍、无 pose 对照全不成立；validate_assembly 同样两态 |
| P1-3 | `simulate_physics` 报告 `metrics.notes`：shell 总数 ≥4 时明说"穿透数是求解器伪象，配合检查走 check_assembly/validate_assembly" | accept-p3：4-shell 有注、单件无注、finalize 文本带出 |
| P1-4 | prismatic 关节 `staticFriction` 参数 → 准静态自锁判定（μ·m·\|g⊥\| vs m·\|g∥\|），报告与文本都显式标注"解析估计，非仿真" | accept-p3：竖直滑块 cap=0 → SLIDES，结论进 finalize 文本 |
| P2-1 | `validate_assembly` 新参数 `interferenceEpsilonMm3`（默认 1e-3）：低于它的干涉按"贴合残差"记 `ok`，体积仍然可见 | accept-p3：~1mm³ 重叠默认=interference，epsilon 100 → pass 且体积可见 |
| P2-2 | `simulate_physics` 新参数 `tiltDeg`（+ `tiltAboutAxis`，默认 [0,1,0]）：斜面场景不用手算重力向量；显式 gravity 仍然优先 | accept-p3：平面上不动，tiltDeg 45 滑出 551mm |

### 顺手修掉的一个回归（回归测试抓到的）

`accept-m36`（滑块曲柄，行程应 40mm）报 44mm：上一轮"每步追踪行程"把**建模位姿与关节约束不一致的初始瞬态**也种进了极值（活塞起点 80，运动学要求 76，80−36=44 正是 44）。修法：前 5% 步骤为 warm-up，之后从活动位姿重新播种极值 —— microscope2 的单调行程少报问题（原修动机）依然被覆盖。修后 m36 行程恰 40，p2 的 25.49 断言不受影响。

### 验证

- `scripts/accept-p3.mjs` 新增，28 条断言全过；期间抓到两个我自己的 bug：
  `composeAffine` 漏加 `a.t`（pose/平移复合时平移被丢——恰是 P1-2 要防的那类错）和
  `eulerMatrix` 转置错误，都被验收夹具当场暴露。
- 全量回归 15 个脚本全绿（p0/p1/p2/p3/m2/m3/m4/m36/measure/import/assembly/image-budget/tool-scope/project-scope/inspect），`tsc --noEmit` 干净，`lib/index.js`/`lib/client.js` 已重建。
- 真实语料复核（临时副本，未写真实数据）：microscope3 语料在本轮审计后又被用户推进到 **v050 / 27 条接口**；用新代码重跑其清单 → **27/27 pass、0 hard、0 skipped、undeclared 5**，全部数值与既有判定一致（pose/matrix/epsilon 均向后兼容）。
- 运行中的 DSH（http://127.0.0.1:4096）仍需重启 profile 才吃到 host 改动。

---

## 用户感受两项（2026-10-02 追加）

### ① 上下文用得太快 —— 消耗在哪、插件能省的已省

量化盘点（microscope3 语料 36 版本 / 32 runs 量级）：

| 消耗源 | 量级 | 谁管 |
|---|---|---|
| **图片** | 每次 generate_part 挂 4 张、validate 3 张、physics 4 张；一个下午累计 150+ 张进上下文，DSH 预算（24 张）外的先被裁，窗口内的每张都是真 token | **本轮已改**：`generate_part` 新增 `views` 参数 |
| finalize 文本 | 每次仿真 300–800 字符（motion/physics/fluid 的指标行、generate 的尺寸行） | 已是最小必要（P2-12 压过一轮） |
| check_assembly 结果 JSON | 27 接口 ≈ 2–3KB | 可接受（skip 明细是 P2-9b 的产出，砍了就回到"绿了但没人验过"） |
| 系统提示词 / 对话历史 / 图片裁剪窗口 | 大头，但不在插件手里 | DSH 本体 |

**本轮改动**：`generate_part` 接受 `views: ["top","front","side","iso"]` 子集；数值迭代（改个孔径、改个长度、用 measure 验证的那种）传 `["iso"]` 就够，四视图留给真正改形状的版本。SKILL.md 已写明"图片是最大的上下文开销"及何时省。不认识的名字不会静默挂零张（回退全四张）。验收 4 条断言进 accept-p3。

### ② 截图不给输入文字的机会 —— 已加发送对话框

原来 📸 一点就带着自动说明直接排队发送，用户只能事后补一条消息（再烧一轮）。现在：

- **📸 先弹发送框**：预览图 + 可编辑文本框（默认已填好视图/测量说明，可直接改写成"这个孔太小，改 Ø12"）；
- **「✓ 发送到会话」**：文字随图片作为**同一条消息**给模型（Ctrl+Enter 同效），不再需要补消息；
- **「只存托盘」**：不发送，存进截图列表，以后补备注再 ↻发（原来的行为仍可达）；
- 「取消」丢弃；点遮罩等同取消。三个回放视图（物理/机构/流体）的 📸 也走同一个框。

发送通道没变：仍是 `sendSession` 排队模式，不打断运行中的回合；失败链（composer → 剪贴板 → 托盘）原样保留。

**生效方式**：host 侧（views 参数）要重启 profile；面板对话框刷新页面即可。

---

## 用户反馈三项（2026-10-02 第二批）

### ① 交付前必须视觉确认 —— 已立为纪律（三处落点）

- SKILL.md 新增 **Delivery discipline** 章节：绿色数字 ≠ 设计完成；交付前必须看过最终装配渲染图/面板截图，且**每个零件跑过 `check_printability`**（findings 要回答：修掉或有理由地辩护），三样齐了才能宣布完成。
- `validate_assembly` 的 finalize 文本末尾加了一行硬话：「交付前纪律：绿色数字 ≠ 设计完成——必须看过装配渲染图，并对每个零件跑过 check_printability」——在交付决定正在做出的地方说这句话，而不是只放在 skill 里。
- 工具数 14→15，SKILL.md 路由表新增 printability 行。

### ② 新工具 `check_printability`（第 15 个工具）

原理：表面采样 + 双面射线。壁厚 = 从采样面外 0.05mm 沿内法线打到对面壁的距离（第一 hit 是自身背面，取第二 hit）；悬垂 = 朝下且比 45°（可调）更平的面的面积（贴床 0.8mm 内豁免）。输出 min wall、薄点数、悬垂面积 + z 区间、带坐标的 findings、verdict（ok/check/unprintable，min wall < 0.4×阈值 判 unprintable）。

真机立功（microscope3 真实语料，temp 副本）：
- **载物台 min wall 0.46mm** @[-26,-13,188] → unprintable；
- **调焦滑座 min wall 0.045mm**（齿根/sliver）→ unprintable；
- **弯臂 0.60mm** @[-22,-29,173] + 2662mm² 悬垂（鞍面/腔顶）→ check；
- 压片簧 0.83mm → check（**故意薄**的弹簧——这正好演示 findings 的正确用法：修掉或有理由地辩护，不是无脑服从）；
- 镜筒 3.92mm → ok。
这就是"符合逻辑但打不出来"的那类问题，现在一秒可见。

### ③ 截图对话框：自动说明改为只读

对话框里 `CAD 视口截图 — 零件「弯臂」· 版本 v052 · …` 那段现在是**灰底只读条**（悬停提示"随图必发，不可编辑"），始终随图发送；下方文本框清空，placeholder 引导用户写自己的话（可留空）。发送 = 自动说明 + 用户的话合成一条消息。机器生成的事实不被误改，用户的表达空间完整保留。

验证：accept-p3 扩到 45 断言全过；回归 p0/p1/p2/m2/inspect/tool-scope 全绿；tsc 干净；bundles 已重建。host 侧（新工具 + 纪律行 + views）需重启 profile；对话框刷新页面即可。

### ④ 截图自动说明补全剖视信息 + 视图状态彻底复原（同日追加）

- **自动说明**新增两条事实（只在开剖视/测量时出现，不啰嗦）：
  - `剖视：沿 x 轴、保留 50% 侧` —— 模型必须知道画面里零件"缺一块"是剖视切出来的，不是几何残缺；
  - 两点测量带上**起止坐标**：`两点测量 24.00 mm（自 [x,y,z] 至 [x,y,z]）`，让模型能对上它在自己的坐标系里的位置。
- **⤾复原**现在除测量/壁厚/标注外，**同时关掉剖视并复位滑块**（提示语同步更新）。
- **切换零件/版本**时自动清空全部视图绑定状态：标注框、两点测量、壁厚探针、三个模式、剖视及滑块位置——否则会出现"在弯臂上量的数，配在镜筒的截图上"这种图文矛盾；剖视位置对新几何也没有意义（新模型的默认剖视轴由场景构建器重新挑选）。
- 实现备注：模型切换的复位 effect 必须声明在它引用的 state 之后（React 每次渲染顺序执行，`const` 未初始化前引用会 TDZ 崩溃）——第一版放错位置，自查发现后移正。
- 验证：accept-p3 全过（45+ 断言）、accept-p0 回归过、tsc 干净、client bundle 已重建。刷新页面生效。
