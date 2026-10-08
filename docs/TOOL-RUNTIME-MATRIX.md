# 工具运行时矩阵：哪些保持 TS、哪些迁 Python、哪些需要原生

> 2026-10-08 起草。用户要求"**先拉列表，再实现**"。**本文件是提案**：除
> "rapier3d 在 darwin-x64 的安装期确认"已落地外，下面没有任何迁移已实施。
> 决策依据（引擎归属、实测耗时）全部可在本仓库复核。

## 0. 判定方法：先问三个问题，再谈语言

1. **热活现在由谁干？**
   若已经是外部二进制（OpenSCAD）或原生 WASM（manifold = C++、rapier = Rust），
   迁 Python 只会**多一层进程边界并丢掉那层原生性能** → 保持 TS 接线。
2. **热循环是不是手写 JS 的数组/粒子循环？**
   是 → numpy/scipy 向量化通常有 5–50× 的空间，是迁移的首选。
3. **Python 之后还够快吗？**
   只有**实测仍不达标**才上 Rust/C++；而且"上原生"多半是换成现成 WASM 包
   （我们已经这么做了两次：CSG 用 manifold，刚体用 rapier），不是自己写内核。

> 反例警告：`measure_closest` 走 three-mesh-bvh（已高度优化的 JS BVH）。
> 把逐点最近点查询搬进 numpy 的 Python 循环**会更慢**——这类"看起来数值、
> 实际是空间索引"的活不适用第 2 条。

## 1. 现有 20 个工具的清点

| # | 工具 | 实现位置 | 热活在哪 | 现状耗时证据 | 判定 |
|---|---|---|---|---|---|
| 1 | `generate_part` | compile.ts | OpenSCAD CLI（C++）+ Manifold | 秒级（渲染 4 视图） | 保持 TS |
| 2 | `create_part` | parts.ts | 元数据 | 毫秒 | 保持 TS |
| 3 | `set_datums` | version.ts | 元数据 | 毫秒 | 保持 TS |
| 4 | `import_part` | import.ts + mesh.ts | STL 解析 + Manifold 校验 | 秒级 | 保持 TS |
| 5 | `merge_parts` | assembly.ts | Manifold 布尔（C++/WASM） | 秒级 | 保持 TS |
| 6 | `validate_assembly` | assembly.ts + assembly-render.ts | Manifold 布尔 + OpenSCAD 渲染 | 16 件 union+渲染实测 **2m27s**（瓶颈是 OpenSCAD，不是 JS） | 保持 TS |
| 7 | `check_assembly` | assembly-check.ts + measure.ts | BVH 距离查询（JS） | 秒级 | 保持 TS |
| 8 | `check_connectivity` | mesh.ts | 三角形并查集（JS） | 秒级 | 保持 TS（精度可另议） |
| 9 | `check_printability` | tools.ts + mesh.ts | BVH 射线**采样**（600–4000 样本） | 亚秒 | 保持 TS（精度可另议） |
| 10 | `measure_part` | inspect.ts + manifold | Manifold 体积/质心/惯性 | 秒级 | 保持 TS |
| 11 | `measure_distance` | measure.ts | 点/球距离 | 毫秒 | 保持 TS |
| 12 | `measure_closest` | measure.ts | BVH 最近点（JS） | 亚秒–秒级 | 保持 TS |
| 13 | `render_part` | inspect.ts + compile.ts | OpenSCAD CLI | 秒级 | 保持 TS |
| 14 | `simulate_physics` | physics.ts | rapier3d-compat（Rust/WASM） | 秒级（canonical） | 保持 TS |
| 15 | `simulate_motion` | motion.ts | rapier3d-compat（Rust/WASM） | 秒级（canonical） | 保持 TS |
| 16 | **`simulate_fluid`** | fluid.ts + **mpm.ts** + sdf.ts | **手写 JS 粒子循环** + BVH SDF | 实测线性：8.8k 粒子 **3.1ms/步**（600 步 2s）→ 564k 粒子 **189ms/步**（600 步 **114s**）；SDF 6.9 万格 260ms | **迁 Python（batch 2）** |
| 17 | `recall_reference_image` | attachments | IO | 毫秒 | 保持 TS |
| 18 | `delivery_audit` | delivery-audit.ts | 文件系统 + 网格检查 | 秒级 | 保持 TS |
| 19 | `run_python` | python-worker.ts | CPython 子进程 | — | 已落地 |
| 20 | `python_runtime` | python-runtime.ts | 供给/状态 | 冷启动 353–476s | 已落地 |

**非工具但同样在算的活**（决定 batch 1 的顺序）：

| 车道 | 实现 | 实测 | 判定 |
|---|---|---|---|
| 体素 FEM（承力与加强主线） | 仅 `scripts/probe-*.mjs`（手写 matrix-free CG） | 9.7k 单元 **5.7s** / 78k 单元 **16.1s** | **迁 Python + 工具化（batch 1）** |
| scikit-fem 交叉验证 | `scripts/xval-cantilever-scikitfem.py` | 5120 单元秒级 | 已在锁里，直接复用 |

## 2. 分类结论

### A. 迁 Python（有明确数量级或能力收益）

| 项 | 为什么 | 预期收益 | 验收对照 |
|---|---|---|---|
| **A1. 体素 FEM 工具化 + Python 实现** | 现在是脚本不是工具；scikit-fem 已在锁里；sparse 组装/直接解是 numpy/scipy 的主场 | 同算例预期 **5–20×**，且拿到 scikit-fem 的独立实现做对拍 | 悬臂梁 δ/σ vs 梁理论（已有基线 5.7s/16.1s 与 −3.5%/−0.9%） |
| **A2. MPM 内核 numpy 化** | 540 行手写粒子循环，P2G/G2P 是纯数组运算；线性扩展说明算法没问题、只是每步常数大 | 预期 **5–20×**（564k 粒子 600 步从 114s 降到个位数~十几秒） | `data/bench/mpm-scaling.json` 的阶梯可直接复用（同场景、同 ms/step 口径） |
| **A3. `check_connectivity` / `check_printability` 精度升级** | 现在分别是"并查集+壳数"与"射线采样估计"；numpy 可给**精确**面积/厚度场 | 质量 > 性能（采样误差 → 精确值） | 现有验收（accept-connectivity）+ 显微镜语料对照 |
| **A4. `measure_part` 扩展** | manifold 已够快，但 trimesh 提供惯性张量/剖面/水密修复等更全的量 | 能力 > 性能 | 现有质量特性数值对照（microscope2 的 864.2cm³/907.5g） |

### B. 需要原生（Rust/C++）——**先量后写，且优先换现成包**

| 项 | 触发条件（实测门槛） | 首选做法 |
|---|---|---|
| B1. MPM 内核 | A2 之后仍 >10 万粒子 × 600 步 > 10s | Rust 内核（napi/wasm）或直接换成已有的并行 MPM 实现 |
| B2. 空间索引密集查询 | `measure_closest`/SDF 在**百万级**格点或面片上成为瓶颈 | 先试 manifold 自带距离查询 / parry3d / embree 绑定；不自己写 BVH |
| B3. CSG / 刚体 | 已经是原生（manifold / rapier） | **不重复造**：这两个领域的"高性能"已解决 |

### C. 保持 TS（14 项，理由见 §1 表）

工具 1–15、17、18：热活是 OpenSCAD 二进制、manifold、rapier 或纯 IO。
迁移它们只会增加进程边界、丢掉原生性能，并把已经验收过的路径重新打开一遍。

### D. 迁移规则（**需要你确认**）

1. **工具名不变，换的是后端实现。** 模型不应在 `simulate_fluid` 和
   `simulate_fluid_py` 之间做选择；`run_python` 才是"开放场地"，工具是"窄接口"。
2. **canonical 唯一**：同一问题域只能有一个 canonical（HARNESS §12.5）。
   物理 canonical 仍是 TS 的 `rapier3d-compat`；Python `rapier3d` 只做交叉验证，
   且在 **darwin-x64 上根本不装**——该平台物理继续用 TS 引擎（**已实现**：
   锁里 `# cad-exclude: darwin-x64 | …`，安装期写进 `state.json`，
   `python_runtime` 会明说"这台机器上没有 rapier3d，原因是没有 wheel、物理留在 TS"）。
3. **先量后迁**：每个迁移都带前后对照数字（上表的"验收对照"列），
   没有对照就不算完成。

## 3. 建议批次

| 批次 | 内容 | 为什么排这个顺序 | 预估 |
|---|---|---|---|
| **1** | A1：体素 FEM 工具化 + Python/scikit-fem 实现 | 是你当前主线（承力与加强）；Python 生态现成；有现成对拍 | 1 个工具 + 1 个验收 |
| **2** | A2：MPM numpy 化（工具名仍是 `simulate_fluid`） | 收益最大；有现成 bench 阶梯做对照 | 内核重写 + bench 对照 |
| **3** | A3/A4：精度与能力迁移 | 质量收益，不紧急 | 两个工具的增量 |
| 4（条件触发） | B1/B2：原生内核 | 只有实测不达标才做 | 待量 |

## 4. 明确不做

- 不迁 OpenSCAD 驱动的工具（1、6、13）：瓶颈在外部渲染器，迁了更慢。
- 不迁 manifold/rapier 驱动的工具（5、7、10、14、15）：已经是原生。
- 不为"用上 Python"而迁元数据/IO 工具（2、3、17、18）。
- 不在没有前后对照数字的情况下宣称"迁移完成"。

## 5. 待拍板

1. 上面的分类（A/B/C）是否同意？
2. batch 1 是否就做 **A1（FEM 工具化 + Python）**？工具名叫什么
   （`check_stress` / `simulate_stress` / 别的）？
3. §2.D 的三条规则（工具名不变、canonical 唯一、先量后迁）是否确认？
4. 原生（Rust/C++）是否只作为"实测不足"的后备，而不是并行推进？
