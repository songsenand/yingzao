# 执行摘要：测量可用性重构（LLM 侧四件套 + 剖面/夹角）

## 动机
> 用户反馈「测距非常难用，三维空间中的点完全打不准」「夹角没有工具」。核到的根因是：
> `measure_distance` 要求调用方提供 3D 坐标，而 LLM 对外部几何（导入件、既有语料）
> **没有任何坐标来源**；渲染图又不带坐标轴与尺寸。bench 归因已量化后果——
> 01 的 `c-protrusion` / `c-measured-vs-datum` 失败的直接原因是**零 `measure_distance` 调用**。
> 完整讨论与用户拍板见 `docs/DECISION-LOG.md` 2026-10-12 条。

## 影响范围
> - `dsh-cad-harness/python/cad_worker/worker.py`（新增 5 个 op）
> - `dsh-cad-harness/scripts/gen-python-lock.mjs` → `src/host/python-lock.ts`（加 shapely）
> - `dsh-cad-harness/src/host/tools.ts`（新增 5 个工具接线）
> - `dsh-cad-harness/src/shared/types.ts`（worker 载荷类型）
> - `dsh-cad-harness/src/host/assembly-check.ts` + worker（`axisLineDistance` 领域半区迁移）
> - `dsh-cad-harness/src/client/panel.ts`（剖口 cap / 锁剖切面 / 特征吸附）
> - `dsh-cad-harness/skills/cad-toolbox/SKILL.md`（路由表加行 = **SUT 变更**）
> - `dsh-cad-harness/scripts/accept-measure-*.mjs`（验收）
> - `docs/TOOL-RUNTIME-MATRIX.md` / `DESGIGN.md` §13.8 / `HARNESS.md`
> - 受影响模块：测量家族、装配契约、GUI 拾取、评测基准（旧分数作废）

## 具体操作步骤
> **落地进度（2026-10-12）：**
> - [x] **`measure_thickness`**：worker op + `tools.ts` 工具 + `scripts/accept-measure-thickness.mjs`
>       （**35/35 绿**）。两个退化在落地时被抓到并修掉，见"预期风险与验证"。
> - [x] **`list_features`**：worker op + `tools.ts` 工具 + `scripts/accept-list-features.mjs`
>       （**31 项绿**）。范围比原计划扩了一点：除平面面与孔，还落了**圆柱识别**
>       （轴/直径/长度 + bore-vs-boss）。理由：平滑区域（smooth region）本来就要算，
>       在它上面做一次轴向 PCA + 圆拟合只多十余行，而"孔在哪、Ø 多少"正是显微镜语料
>       最需要的东西；拟合带残差门限，拟合不上就报 `curvedSurfaces` 并说明原因，
>       不会把圆锥/圆环说成圆柱。同时抓到一个真缺陷：**矩形的四个角共圆**，
>       只靠残差会把矩形孔判成圆孔，故加"环面积 ÷ 圆面积 ≥ 0.95"的面比判据。
> - [x] **`shapely` 接入**：`gen-python-lock.mjs` 加 `shapely==2.2.0`（9 个 wheel 覆盖
>       七目标、只依赖锁内 numpy），重新生成 `python-lock.ts`（`REQUIREMENTS_LOCK_SHA256`
>       `a21baffa…` → `adbf4296…`）；worker 的 `wanted` 与 `accept-python-worker.mjs`
>       的断言同步为九件。**锁变化触发 venv 重建已实测**：pip 按哈希装齐九件，
>       `requirementsSha` 与锁一致。
> - [x] **`measure_section`**：worker op + `tools.ts` 工具 + `scripts/accept-measure-section.mjs`
>       （**39 项绿**）。落地时抓到**两个真缺陷**（都有实测）：
>       ① **`polygonize` 需要精确共点**：同一表面点从共享一条边的两个三角形各算一次，
>       末位有差，GEOS 于是看到"开口线"——`$fn=64` 圆管在中间高度切出 **256 条线段却得到
>       0 个多边形**；1µm 网格吸附后正常。
>       ② **`polygonize` 不知道闭环哪一侧是材料**：槽腔会作为独立多边形一起返回
>       （实测 slot 得 1540 + 60 两块）。改用 `representative_point`（**不是 centroid**：
>       圆环的质心落在孔里）向实体提问后，只留材料多边形，空腔计入 `voidRegions`。
>       另有一处**量值口径**：剖面环含三角形对角线的中点，最小二乘拟合会把 tessellate 的孔
>       报小 0.007mm，故同时回报 `enclosingDiameterMm`（最小外接圆 = 标称直径）。
> - [x] **`measure_extent`**：worker op + `tools.ts` 工具 + `scripts/accept-measure-extent.mjs`
>       （**16 项绿**）。任意轴（`[1,1,0]` 投到 70.711mm）+ **两端极值顶点坐标**（正是后续
>       `measure_distance` 需要的点）+ 同回的轴对齐包络。按特征取长度**不在这里**：
>       `list_features` 已经给圆柱 `lengthMm` 与孔 `depthMm`，从特征本身取，避免两处数打架。
> - [x] **GUI 剖切面**：新增纯模块 `src/client/section.ts`（`clipCut` / `projectToCutPlane` /
>       `sectionSegments` / `sectionLoops` / `capTriangles` / `loopCentroids` / `planeToWorld` /
>       `nearestVertex` / `millimetresPerPixel`）+ `scripts/accept-section-pick.mjs`
>       （**34 项绿**）；`panel.ts` 接进四处：
>       ① **拾取点约束到剖切面**（剖切开着时，点击不再穿进开口打到深处内壁——那正是"看着相邻的
>       两点量出零件对角线"的成因）；
>       ② **9px 内吸附到最近顶点**（半径按像素给、用相机换算成毫米，缩放后含义不变）；
>       ③ **剖面轮廓**（橙色，裁剪面只是着色器效果、没有面可点，轮廓是让用户看见切面在哪儿的
>       唯一线索）；
>       ④ **封盖**（`capTriangles`：环链化 → 嵌套判定 → 三角化，孔被减掉而不是填上）+
>       **孔心吸附**（剖面里最想点的是孔的中心，而它不是网格顶点，所以剖面自身的环心也作为
>       吸附候选）。
>       落在独立 group 里，免得被测量标注的清空逻辑带走。客户端产物已重建（`lib/client.js`）。
>       **浏览器里的视觉确认需要你**（我无法操作 GUI）；纯几何已由验收脚本钉住，
>       接线还有 `accept-p3` 的面板守卫。
> - [x] **封盖数学的两个真缺陷**：`chainLoops` 原用贪心走边，遇到重边（重合三角形会产生）
>       会**提前闭环并丢掉其余几何**（实测 8 点环退化成 7 点）——换成 **Hierholzer**；
>       环的"外/内"不用"最大者为外"，改用**嵌套深度**（切割两个分离体时会有两个外环，
>       把第二个当孔会在封盖上多挖一个洞）。
> - [x] **一处 Python 优先的纠正**：`+x/-x` 轴解析原先被我写在 `tools.ts`，而
>       `measure_section`/`measure_extent` 的同类解析在 Python 里——两边重复且已经漂移
>       （只有一边接受带符号字符串）。现收敛为 worker 的**一个** `_axis_vector`，
>       三个 op 共用；`tools.ts` 回到"schema + 转发"（矩阵 §1 的目标形态）。
>       这是既有决策（"能迁就迁"，`docs/TOOL-RUNTIME-MATRIX.md`）的直接应用，未新开决策条目。
> - [ ] `measure_angle`、`check_assembly` 领域半区迁移：待做。
> - [x] **`SKILL.md` 随每件工具同步更新**（工具表 20 → 24、路由表加 4 行、新增
>       "你看不见的几何不要靠看图猜点"一段），因为 `accept-p3.mjs` 里有一条**文档
>       点名检查**：每个注册的工具名都必须出现在手册里——它会在下一件工具落地时
>       再次变红，正好当作"手册与目录不许漂移"的守卫。
>       **基准指纹（`SKILL.md` sha256）与本轮基线留到本批次收尾时一次性重录**；
>       中途每加一件工具都改一次基准表只会制造噪音。
>
> **原始计划：**
> 1. 新增 worker op `measure_thickness`：射线穿越 → 全部交点按距离排序 → 用法线符号
>    定"进出" → 配对成材料 span；交点去重 + 奇偶校验 + 水密警告；支持跨件（a/b 两条路径）。
> 2. `src/host/tools.ts` 新工具 `measure_thickness`：schema、版本→路径、datum 解析、警告文案、超时。
> 3. 新增 worker op `list_features`：trimesh `facets` 取平面面（法线/平面点/面积/质心），
>    facet 边界内环拟合圆得孔（中心/直径/轴向）；圆柱轴识别放第二阶段。
> 4. 新增 worker op `measure_section`：`intersections.mesh_plane` + shapely 多边形化 →
>    轮廓环（去共线、逐段长度与角度）、孔（内环：中心/直径）、平行相对段的壁厚候选；
>    平面内 2D 坐标系显式给出。
> 5. 新增 worker op `measure_extent`：按轴的起止/中心/截面外接。
> 6. 新增 worker op `measure_angle` 并把 `check_assembly` 的领域半区（契约规则 +
>    `axisLineDistance`）迁到 worker，TS 保留 oracle 与 store/manifest I/O。
> 7. `gen-python-lock.mjs` 加 `shapely==2.2.0`，重新生成 `python-lock.ts`；worker 的
>    `wanted` 依赖表加 shapely；锁变化触发 venv 重建。
> 8. GUI：剖口 cap（实时截面多边形）、开剖视时拾取点锁到切面并给 2D 坐标、悬停吸附
>    到最近顶点/边/孔心。
> 9. `SKILL.md` 路由表加 5 行 + 一条流程（"先剖视看结构 → `measure_section` 读数 →
>    要具体两点再 `measure_distance`；渲染图不带坐标，不要看图猜点"）。
> 10. 每步配 `scripts/accept-measure-*.mjs`（真值优先，parity 次之）并在 Python 侧跑通。

## 预期风险与验证
> - **已实测的两个退化（`measure_thickness` 落地时抓到，不是推断）：**
>   1. **射线正好落在三角形接缝/顶点上会整个漏检。** 在 `$fn=128` 的 OpenSCAD 圆管上，
>      从 `[-20,0,0]` 沿 `+x`（y=0、z=0，正好是圆柱的顶点线）**报 0 次穿越，而实际有 4 次**
>      ——连外壁都没命中。这是调用方最可能打的那一行（整数、主轴、一个孔），且**失败方向最坏**。
>      处置：请求线 + 两圈（1e-3mm / 1e-2mm）各 12 个垂直偏移，共 **25 个探针**，
>      取"内外行走自洽"的候选中得票最多者；垂直偏移对穿越距离的影响是 `d²/2R`
>      （d=0.01mm、R=10 时 5e-6mm，低于 0.001mm 报告精度），并回报 `nudgedMm`
>      与 `probeAgreement`；低于 1 时给出"贴切线"警告。
>   2. **射线正好躺在一个面内（切向）时不存在唯一答案。** 立方体棱线那一行各探针必然分裂
>      （一半命中一半落空），此时工具**声明歧义**而不是给一个自信的数
>      （实测 `agreement=0.64` + 警告）。
> - 其他风险点：
>   1. **射线在共享棱上重复计数**（`sdf.ts` 当年正是栽在这）→ 同距离聚类去重后，
>      `net == 0` 的簇判为切点丢弃并警告；`|net| > 1` 只记一次事件。
>   2. **开口网格上的一切距离都是谎言**（手册纪律）→ `measure_thickness` 回传
>      watertight 标志并在 false 时给出强警告，且"出口在材料内"与"奇偶为奇"分别单独报。
>   3. **特征识别的误判**（把平面判成圆柱、把圆角判成孔）→ 平面面走 trimesh `facets`
>      （共面连通域，误判率低）；孔要求"内环 + 拟合残差小于阈值 + 轴向与面法线一致"。
>   4. **SUT 变更使既有评测分数作废** → 重录 `SKILL.md` sha256、重跑基线，并在
>      bench README §2 基准表登记。
>   5. **shapely 引入新依赖** → 已验证 cp313 wheel 覆盖全部 7 目标、只依赖锁内 numpy；
>      重新生成锁后跑 `accept-python-worker.mjs`（含"八个依赖可导入"断言，需同步改成九个）。
>   6. **本机沙盒下 accept 套件会"假红"**，实测三种成因，必须在报告里区分开，
>      否则会把它们读成"插件退化"（`graders/README.md` §七 要的正是这个区分）：
>      - `~/.dsh/cad/runtime` 在会话工作区之外，写 `state.json` 报 `EROFS`
>        → 必须先 `export DSH_CAD_PYTHON_ROOT=<repo>/.tmp-measure-runtime`；
>      - 循环里跑会因争用而超时：`accept-inspect.mjs` 在循环里 FAIL、**单独跑 PASS**；
>        `accept-m3.mjs` 与 `accept-python.mjs` 在 400s 上限内 `exit=124`（超时，不是断言失败）；
>      - `accept-p3.mjs` 里有一条**过期检查**：它 grep 手册里的字面量 `Fifteen tools`，
>        而目录早已是 20 个（本轮 22），所以它为一个与它要守的东西无关的原因变红。
>        **已修**：改成"每个注册工具名都必须出现在手册里"（真不变量），并因此驱动了本轮
>        `SKILL.md` 的更新。这一类正是 `graders/README.md` 说的"检查过期 ≠ 插件退化"。
> - 测试方式：
>   - `node scripts/accept-measure-thickness.mjs`（解析真值：圆管/方壳/立方体/内起点/
>     顶点线退化/切向歧义/跨件间隙/开口网格/裁剪/落空/错误路径，**43 项全绿**）
>   - `node scripts/accept-list-features.mjs`（**31 项绿**）、
>     `node scripts/accept-measure-section.mjs`（**37 项绿**）、
>     `node scripts/accept-measure-extent.mjs`（**16 项绿**）
>   - `node scripts/accept-section-pick.mjs`（纯模块，**34 项绿**，不需要浏览器/运行时）
>   - `node scripts/accept-measure-angle.mjs`（待 `measure_angle` 落地）
>   - `accept-measure-*-parity.mjs` 保留 TS oracle 对拍
>   - `node scripts/accept-p3.mjs`：除原有 26 项外，**新增 8 项把四个新工具走一遍真实工具对象**
>     （`execute` 路径：版本号→路径、轴字符串/向量转发、schema 输出形状、worker 拒绝坏轴），
>     并新增 2 项面板接线守卫。此前四个 op 只有 worker 侧真值验收，**工具层转发无人覆盖**，
>     一个 schema/转发错误可以静默存在——这一块就是补这个洞。
>   - 全量旁证：`for s in scripts/accept-*.mjs; do node "$s"; done`（判据 25/25 全绿，
>     且必须带上面的 `DSH_CAD_PYTHON_ROOT`）
>   - 发货产物：`node esbuild.mjs` 后跑 `examples/bench/graders/00-smoke/bench-smoke.mjs`
>     （**它加载 lib/index.js，不是 src**）
