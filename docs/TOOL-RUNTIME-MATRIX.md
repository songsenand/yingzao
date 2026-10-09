# 工具运行时矩阵（v2：判据是"Python 是第一语言"）

> **v1 作废**。v1 用"性能/精度"当判据，把大部分工具判成"保留 TS"——判据错了。
> 用户 2026-10-08 修正：**Python 是 LLM 的第一语言，能迁到 Python 的应当优先迁移，
> 只有明确负收益的才不做**。本文件是**提案**，未实施任何迁移。

## 0. 判据与前置条件

**默认**：领域逻辑 → Python。
**保留 TS 只有三类理由**（每条都要写出来）：

| 类别 | 含义 | 例子 |
|---|---|---|
| ① 平台接线 | DSH 规定的宿主面，Python 根本够不着 | cordis 生命周期、`ctx.tools.register`、`ctx.attachments`、`connection.fetch` 路由、面板/回放、会话与项目路径解析、`llm/stream` 遥测 |
| ② 明确负收益 | 迁移让某件事确定变差，且理由可复核 | 逐请求热路径引入 IPC；缺少必要的 Python 依赖导致退化 |
| ③ canonical 冲突 | 同一问题域只能有一个权威实现，换边需要重新定基线 | 物理（TS `rapier3d-compat` 0.20 ↔ Python `rapier3d` 0.36） |

**前置条件：常驻 worker（HARNESS §12.3）必须先落地。**
**实测**（本机，2026-10-08，脚本 `dsh-cad-harness/scripts/measure-python-migration.mjs`，
报告 `experiments/20261008_python_migration_measurements.md`）：
裸解释器 **11.7 ms**；`import numpy, scipy` **90.2 ms**；**全工具集
（+manifold3d/trimesh/skfem）443.7 ms** —— 这是"每次调用起一个新进程"的真实代价；
而**常驻 worker 往返 0.02 ms**（200 次中位数，比 Node 直读磁盘的 0.9 ms 还便宜）。
443.7 ms → 0.02 ms ≈ **2×10⁴**。
⇒ **这是唯一被数据证实的"负收益"，而它的解法是 worker，不是把工具留在 TS。**
batch 0 不是优化项，是让"能迁就迁"成立的前提。

## 1. 分层：接线 vs 领域

| 层 | 内容 | 归属 |
|---|---|---|
| 平台接线 | 工具 schema 与注册、预设可见性过滤、图片附件与裁剪策略、HTTP 路由、面板与回放数据、会话/项目路径、usage 遥测 | **TS**（§12.1，不可动） |
| 领域逻辑 | 几何生成与解析、测量、装配契约、仿真、导入/合并、交付审计、版本与零件记录 | **Python**（默认） |

目标形态：`tools.ts` 收缩成"schema + 转发到 worker"，领域代码进 `python/cad_worker/`。

## 2. 逐工具：拆开"领域部分"与"接线部分"

| # | 工具 | 领域部分（迁 Python） | 接线部分（留 TS） | 判定 | 代价/备注 |
|---|---|---|---|---|---|
| 1 | `generate_part` | SCAD 预置（datum 模块、BOSL2 路径）、编译调用与结果解析、版本落盘 | schema、四视图附件 | **领域半区已迁移（2026-10-08，批次 2）** | **SCAD 文本协议归 Python**：datum 预置（写方）、OpenSCAD 输出的 ERROR/WARNING + 四种 datum echo（读方）、`// PARAMS` 解析都在 worker（`scad_prelude`/`scad_parse_output`/`scad_parse_params`）。**OpenSCAD 进程留 TS**（二进制发现、内置快照与 xvfb、超时、临时文件）——那是这台机器的工具链，不是几何。验收：合成输出逐字段精确、预置含四个模块与四个 echo 标记、真实编译里四种 datum 全部原值返回、语法错误仍可读 |
| 2 | `create_part` | 零件命名/唯一化 | schema | **P** | 小 |
| 3 | `set_datums` | datum 读写 | schema | **P** | 小 |
| 4 | `import_part` | STL 解析、单位/水密/焊接、datum 归一化、版本落盘 | schema、渲染附件 | ✅ **已迁移（2026-10-08，批次 2）** | worker 的 `import_mesh` op：二进制/ASCII 解析、壳数、单位缩放、焊接、Manifold 实体判定与诊断都在 Python，**焊接后的网格由 Python 写出**（那就是存进版本的东西）；TS 侧只剩路径/扩展名检查、sha256、unit 校验、datum 与存版。**真值验收**（不是 oracle）：20 mm 立方体 = 8000 mm³、1 inch = 25.4 且体积 ×25.4³、ASCII 与二进制同结果、两个不相接体 = 2 壳 + 警告、开口网格被拒并给边诊断、绕向反转被单独识别、整机 710012.998 mm³ / 28830 面 / 26 壳逐项对上。**顺带修掉一个真实缺陷**：TS 的 `parseStl` 数了退化面却把计数丢掉（恒返回 0），所以"退化三角形被丢弃"这句从未出现过；Python 报真数 |
| 5 | `merge_parts` | Manifold 布尔 | schema、渲染附件 | ✅ **已迁移（2026-10-08）** | worker 的 `merge_solids` op：各件以**路径**进，**合并后的 STL 由 Python 写出**（谁算谁交付），TS 侧只剩解析、provenance、渲染与存版。**parity**：三角数/体积/尺寸/壳数与 TS 完全一致；**两件并集与真实零件（1.44 MB）的 STL 逐字节相同**；三件带共面接触时仅**三角形顺序**不同（几何指纹与顶点集完全相同，已实测非我方代码所致——Python 侧 `(a+b)+c`、`a+(b+c)`、`batch_boolean` 三种写法字节都一样）。耗时 0.56×–1.2× |
| 6 | `validate_assembly` | 干涉/间隙/包围盒/渲染编排 | schema、图片附件 | ✅ **已迁移（2026-10-08）** | 求解在 worker 的 `validate_assembly` op（parts 以**路径**进，报告原样回）；TS 侧只剩 schema、part 解析/位姿拼装、run 持久化与渲染。`validateAssemblyInTs` 保留为 parity oracle。**8 个用例全字段一致**（含真实零件、rotate、matrix/pose 路径、干涉、too_tight、非实体拒绝）；耗时 0.54×–1.78×，真实零件对 274→177 ms（0.65×）与 274→407 ms（1.48×） |
| 7 | `check_assembly` | 接口契约判定、距离查询 | schema | **P** | 纯领域规则 |
| 8 | `check_connectivity` | 连通分量/壳数 | schema | ✅ **已迁移（2026-10-08）** | worker 的 `connectivity` op：**按共享边**判连通（只共顶点算两块）、体序为 XY 包围盒面积降序（平局按首个三角形）。耗时 **0.68×/0.74×/0.76×**（Python 更快：92→62、72→53、6→5 ms）。**关键保真点**：水密用 TS 的严格判据（每条有向边恰好一次且反向边存在），**没有**换成 trimesh 更宽松的 `is_watertight`——反证用例：把一个立方体某个三角面绕向翻转，严格判据说"不水密"，trimesh 自己会说"水密" |
| 9 | `check_printability` | 壁厚/悬垂（可顺带从采样升级为精确） | schema | **P** | 精度是附带收益 |
| 10 | `measure_part` | 体积/质心/惯性/包围盒 | schema | ✅ **已迁移（2026-10-08）** | worker 的 `measure_part` op：焊接（同 TS 的 1e-5 key 与首现顺序）→ Manifold（体积/亏格，构造即有效性闸门）→ 三角面叉积面积 → 有符号四面体和质心 → 包围盒/水密/三角数；TS 侧只剩读文件（**按路径**，不复制字节）与版本号拼装。**`-0` 归一化照搬**（否则对称件曾全军覆没）。**parity 逐位相同**：立方体 8000 mm³、通孔板亏格 1、双壳件亏格 -1、球（`-0` 陷阱）、真实件 整机.stl 710012.998 mm³/28830 面/亏格 -2；坏网格两侧都失败 |
| 11 | `measure_distance` | 点/球距离 | schema | ✅ **已迁移（2026-10-08）** | worker 的 `measure_distance` op：吸附（精确最近点 + 命中三角面法线定内外）、吸附距离、分量、水密标志都在 Python；TS 侧只剩 datum 解析、警告文案与 datum 侧的后处理。**parity**：6 个用例（表面/内部/远处/跨件/关吸附/只吸附 a）全字段一致，真实零件 230 mm 一致；**并列最小点**（立方体正中心距六面都是 10 mm）显式作为"平局"用例：吸附距离与内外判定必须一致，具体坐标允许不同（TS 取 −Z 面、trimesh 取 −X 面，两者都正确）。水密标志仍是**严格判据**（绕向翻转的立方体：严格判据 false、trimesh true）。绝对耗时 0.6–3.0 ms（比值 5–8.7×，两边都是亚毫秒级，比值意义有限） |
| 12 | `measure_closest` | 最近点/最小间隙 | schema、渲染附件 | ✅ **已迁移（2026-10-08）** | 求解在 `worker.py` 的 `closest_mesh_mesh` / `closest_mesh_sphere`；TS 侧只剩 schema、版本→路径、警告文案与标注渲染。**parity：距离与 TS 逐位一致（Δ=0）**，解析真值也对（1 mm 间隙测成 1 mm、球探针 4 mm 间隙、吞掉顶面的球报 0 而非负间隙）。耗时 **0.89× / 8.43× / 0.98×**（TS 114/17/106 ms → Python 101/141/104 ms；8.43× 那次目标网格只有 12 个面，两边绝对量都是百毫秒级）。剪枝前最坏 **107×**（15.0 s，trimesh 对远离目标的查询点代价高），改包围盒下界分支定界后降到 **0.89×** |
| 13 | `render_part` | 渲染调用、视图拼接 | schema、图片附件 | **① 平台系留（2026-10-08 判定）** | 迁完 `generate_part` 的文本协议后复查：这里剩下的领域内容只有**四视图相机约定**（4 行常量）与 **OpenSCAD 调用**，其余是 PNG 附件与面板载荷。把 4 行常量搬到 Python 只多一次往返（实测 0.25 ms）而无领域收益 ⇒ 按①（平台/工具链）保留，不单列迁移项 |
| 14 | `simulate_physics` | 场景构建、步进、指标 | schema、关键帧渲染 | ✅ **已迁移（2026-10-08，批次 3）** | worker 的 `simulate_physics` op 逐行镜像 `runPhysics`（世界/关节/接触采样/指标/关键帧/时间线）；TS 侧只剩 schema、parts 落盘与关键帧渲染。`runPhysicsInTs` 保留为 **parity oracle**，也是 **darwin-x64 的 canonical**（锁里没有该平台的 wheel）。**验收**：`accept-physics-parity`（约束驱动最终 Δ **0.000 mm**、自由飞行+轻接触 0.056 mm、接触主导的倾倒 15.3 mm 且定性判定与关键帧标签集一致、hold 分析逐项精确）；**`accept-p2` / `accept-p3` / `accept-sim-verdict` 在 Python 侧重跑全过**（未改阈值） |
| 15 | `simulate_motion` | 机构装配、驱动/摆动、干涉时间线、跟随件指标 | schema、关键帧渲染 | ✅ **已迁移（2026-10-08，批次 3）** | rapier 在这里只当**约束求解器**（无碰撞体、无重力），判定来自**精确 Manifold 干涉时间线**——两部分都在 worker。**验收**：`accept-motion-parity`（干涉计数逐位相同 0/0、25/25、49/49；行程差 0.0000 mm；周期差 0.00000 s；关键帧标签序列含 `interference` 完全一致）+ **`accept-m36` 17/17 在Python 侧重跑通过**（含负例：连杆加长→检出干涉→`check`）。`runMotionInTs` 为 oracle + darwin-x64 canonical |
| 16 | `simulate_fluid` | MPM 内核 + SDF 场 | schema | **P（批次 4；接受慢）** | ⚠️ **实测**：Python 版比现役 TS 内核**慢 2.5–4×**；用户 2026-10-08 拍板**仍迁 Python**，并在工具上**标记"后续 Rust/C 加速"**（原生按阶段决定留中后期） |
| 17 | `recall_reference_image` | —（查 DSH 附件） | 全部 | **T** | 这是平台 API，不是领域 |
| 18 | `delivery_audit` | 交付规则、文件与网格核对 | schema | **P** | |
| 19 | `run_python` | 已落地 | — | 已落地 | |
| 20 | `python_runtime` | 已落地 | — | 已落地 | |

**非工具车道**：体素 FEM（现为 `scripts/probe-*.mjs`，手写 matrix-free CG）→ **P + 工具化**
（批次 4）。**实测前提**：scikit-fem 的稀疏组装比 TS 全过程慢 3–17×（求解本身反而快）。
用户 2026-10-08 拍板：**接受慢，仍迁 Python，并在工具上标记"后续 Rust/C 加速"**；
若未来改用 Python 侧 matrix-free（而非照搬 scikit-fem 组装），该成本前提需重新实测（见 §2.1）。

### 2.1 已实测的 TS ↔ Python 差异（2026-10-08）

用户阶段决定：**现在只比 JS/TS 与 Python 实现**，原生留中后期。方法、原始数据与完整讨论见
`experiments/20261008_python_migration_measurements.md` 补充 2
（脚本 `scripts/measure-python-gains.mjs`，数据 `data/bench/python-gains.json`）。

| 车道 | TS 现役 | Python | 比值 | 一致性 |
|---|---|---|---|---|
| MPM 内核（每步） | 3.1 / 23.4 / 88.3 ms | 11.4–12.7 / 59–71 / 230–263 ms | **慢 2.5–4×** | 同一算式 |
| 体素 FEM（悬臂梁） | 0.1 / 1.7 / 27.8 s（总） | 组装 1.7 / 10.7 / 80.1 s + CG 0.04 / 1.2 / 4.9 s | **组装慢 3–17×**；CG 求解快 1.5–2.3× | δ 一致（n=4/8）；n=16 CG 未收敛，作废 |
| Manifold 布尔+体积 | 134.6 ms | 44.0 ms | **快 3.06×** | 体积 Δ=0 |
| 最近点（200 点） | 0.0204 ms/点 | 0.61 ms/点（rtree） | 慢 30×，绝对 122 ms | Δ=0 mm |
| STL 解析+焊接 | 18.9 ms | 21.7 ms（trimesh）／≈0（零拷贝） | 0.87× / 更快 | 面数一致 |
| 连通体+水密 | 85.2 + 18.4 ms | 30.2 + 24.0 ms | **快 1.7× / 慢 1.3×** | 都 26 体、watertight |
| （原生 C 参考，中后期） | — | — | 快 3.7–4.6× | 同一算式 |

⇒ **"Python 一定更快"是错的**（MPM/FEM 组装），**"Python 一定更慢"也是错的**（Manifold/连通体）。
矩阵里的"收益"列现在只以这张表为准。

## 3. "明确负收益"的实测判定（2026-10-08）

v2 初稿凭直觉列了三条"负收益"，用户要求**用数据说话**。实测结果**推翻了其中两条**，
详见 `experiments/20261008_python_migration_measurements.md`：

| 我原先的说法 | 实测 | 判定 |
|---|---|---|
| 每次调用起新进程 = 0.1–0.3 s，小工具负收益 | 全工具集冷启动 **443.7 ms**；常驻 worker 往返 **0.02 ms** | ✅ **成立，但解法是 worker**，不是保留 TS |
| `measure_closest` 没有 Python 空间索引 → 负收益 | 无索引 4.6–7.1 ms/点（慢 224–350×）；**加 rtree 0.61 ms/点（慢 30×）**；精度 **Δ=0 mm**；200 点共 122 ms | ❌ 撤回：可接受，代价是加 `rtree` |
| 面板载荷/渲染图片过 IPC → 负收益 | 34 KiB 面板载荷 **0.25 ms**（直读磁盘 0.9 ms）；178 KiB 图片 **0.82 ms** | ❌ 撤回：传输从来不是瓶颈 |
| "MPM Python 化 5–20×""FEM 迁 Python 更快"（我在 v2 收益列里写的） | MPM：Python 慢 **2.5–4×**；FEM：scikit-fem 组装慢 **3–17×**（求解反而快） | ✅ **撤回原预期**：这两条是**新增的、有数据的负收益**（见 §2.1） |

**当前因性能保留 TS 的（②类，有数据）：**

| 保留项 | 数据 |
|---|---|
| `simulate_fluid` 的 MPM 内核 | Python 版比现役 TS 慢 2.5–4×（564k 粒子 600 步：TS 114 s → Python 约 290–390 s）；原生属**中后期** |
| 体素 FEM 若照搬 scikit-fem 路线 | 组装 1.7/10.7/80.1 s vs TS 全过程 0.1/1.7/27.8 s；**若在 Python 写 matrix-free 则此条不成立（未测）** |

**其余保留 TS 的（①/③类，非性能）：**

| 保留项 | 理由类别 | 具体依据 |
|---|---|---|
| 工具 schema 与注册、预设可见性过滤 | ① 平台接线 | `ctx.tools.register` 是宿主进程内服务 |
| 图片附件与裁剪策略 | ① 平台接线 | `ctx.attachments.saveImages(...)` 只能在宿主调用（tools.ts）；图片**必须**经它交付 |
| HTTP 路由、面板、回放 | ① 平台接线 | `connection.fetch.register` / `connection.rpc.intercept` 在宿主进程内（index.ts） |
| 会话/项目路径解析、usage 遥测 | ① 平台接线 | 读的是 DSH 会话与 `llm/stream` 钩子 |
| `recall_reference_image` | ① 平台接线 | DSH attachments API |
| darwin-x64 的物理 | ③ canonical | 用户已拍板：无 wheel，该平台继续用 TS |

> ① 类不是性能问题，是 **API 边界事实**（跨进程够不着），所以它不需要 benchmark，
> 需要的是代码位置作证。② 类才是要数字的——现在 ② 类**不再是空的**（MPM/FEM 两条），
> 而且这两条都来自同一次测量，不是直觉。
> **原生（C/C++/Rust）是 ② 类的解法，但那是中后期的事**（用户 2026-10-08 阶段决定：
> "用 C/C++ 或 Rust 替代性能不够的 Python 代码，现在做太早"）；本阶段只做 TS ↔ Python 对比。

## 4. 两个结构性裁决（比单个工具更重要）

**Q1：领域数据归谁？** `parts/versions/runs/assembly.json` 现在是 TS 代码 + 磁盘 JSON。
- 方案 A：Python 拥有领域存储，TS 只代理（彻底；但面板路由要么走 worker，要么继续读文件）
- 方案 B：**文件即契约**（schema 固定，两侧读写；TS 路由直读文件）← **建议 B**
  理由：面板保持零 IPC，迁移可以**逐工具**进行，不必一次性搬存储。

**Q2：物理 canonical 是否随迁？—— 用户裁决：方案 A（随迁 Python，darwin-x64 例外）。**
Python 的 `rapier3d` 是同一 Rust 内核的官方绑定（TS 侧是 `rapier3d-compat` 0.20，
Python 侧 0.36），**换边必须重跑物理基线**（TS 侧现有 17/17 + 24/24 验收）。

## 5. 批次（batch 0 是前提；排序依据 = §2.1 的实测）

| 批次 | 内容 | 为什么排这个位置 |
|---|---|---|
| **0** | ✅ **已落地（2026-10-08）**：常驻 worker + JSON-lines（`python/cad_worker/worker.py`、`PythonWorker`、验收 `accept-python-worker.mjs` 8 组断言全绿：握手 14.8 ms、ping 0.026 ms、大载荷按文件且 Δ=0、kill 后重启、并发串行） | 让"能迁就迁"成立，是所有迁移的前提 |
| 1 | **Python 更快的那些**：~~`measure_closest`~~ ✅、~~`check_connectivity`~~ ✅、~~`validate_assembly`~~ ✅、~~`merge_parts`~~ ✅、~~`measure_distance`~~ ✅（均 2026-10-08）。**批次 1 完成**（STL 零拷贝解析随这些工具一并落地：`closest_points`/`stl_stats` 用 numpy 视图，不再整份拷贝） | 数据支持"迁了更好"；五个已迁移，parity + 解析真值 + 反证/平局用例都过 |
| 2 | 生成/渲染/导入的领域部分（1、4、13）与存储（Q1=B 文件即契约）：~~`import_part`~~ ✅、~~`generate_part` 的 SCAD 文本协议~~ ✅（2026-10-08）；`render_part` 判定为 ① 平台系留（理由见 row 13）。**批次 2 完成** | 无性能争议，纯搬家；文本协议是唯一真正的领域半区 |
| 3 | 物理随迁（Q2=A）：~~`simulate_physics`~~ ✅、~~`simulate_motion`~~ ✅（2026-10-08）。**probe**：`experiments/20261008_python_rapier_probe.md`；**基线重跑**：`accept-p2`/`accept-p3`/`accept-sim-verdict`/`accept-m36(17/17)` 在 Python 侧全过、**未改任何阈值**。**批次 3 完成** | canonical 换边 |
| 4 | `simulate_fluid`（MPM 内核）、体素 FEM：**迁 Python（用户 2026-10-08 拍板：接受 2.5–4× 的慢）**，并在每个工具上**标记"后续 Rust/C 加速"** | 判据优先于该量级性能差；原生按阶段决定留中后期 |

## 6. 单个工具"迁移完成"的定义

1. **工具名不变**，模型无感（`run_python` 才是开放场地，工具是窄接口）；
2. 领域逻辑在 `python/cad_worker/`，TS 侧只剩 schema + 转发；
3. **有前后对照**：同输入同输出 + 耗时对比，写进验收脚本；
   对照口径见 `experiments/20261008_python_migration_measurements.md`
   （E1 冷启动/worker、E2 最近点、E3 面板载荷、E4 图片载荷、M1–M5 TS↔Python）；
4. 现有验收（`scripts/accept-*.mjs`）更新并通过；
5. canonical 归属在决策记录里写明。
