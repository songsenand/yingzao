# 第三方库替代审计（自研代码盘点）

> **日期**：2026-10-14
> **范围**：`dsh-cad-harness` 插件的自研实现——Host TS 领域模块（16 文件 / 6635 行）、
> Python worker 领域运行时（5270 行）、Client 面板（约 4700 行）、供给与工具链基础设施。
> 不含 `examples/`、`verification/`、`lib/BOSL2`、`bench` 题库侧内容。
> **题库侧素材的来源与许可另立清单**：`examples/bench/ATTRIBUTION.md`（一题一行；第三方几何
> 一律物化不入库）。本节范围内的许可结论**不覆盖题库**——两边不要互相引用为"已审计"。
> **性质**：证据型盘点 + 候选评估。**本文不做出任何引入决策**；引入属"不可逆或高成本决策"，
> 需按 `AGENTS.md` §二 另行落 `docs/DECISION-LOG.md`。

---

## 0. 结论摘要

**"大多数工具都是自己实现的"在代码层面成立，在算法层面被高估了。**
读进去会发现三种情况：**（a）已经站在第三方库上**（Python 领域层如此占多数）；
**（b）是领域规则而非通用算法**（装配契约、工艺否决、交付审计……本来就没有库）；
**（c）是平台接线**（dsh 的 tools/attachments/路由/面板，跨进程够不着别的实现）。

排除以上三类后，**真正与现成库功能重叠、且值得讨论替换**的只有 6 处：

| 优先级 | 自研 | 位置 | 结论 |
|---|---|---|---|
| **A1** | MLS-MPM 流体内核 | `worker.py` ≈500 行 + `mpm.ts` 551 行 | **值得动**：性能已被项目自己判为"实际必需项"；三候选已核实平台覆盖 |
| **A2** | CPython 运行时供给 | `python-runtime.ts` 927 + `python-lock.ts` 94 + `tar-extract.ts` 303 行 | **需用户裁决**：uv 能力吻合，但**无官方 npm 分发**，只能走第三方包装器或自管二进制 |
| **B1** | 纯 JS tar.gz 解压 | `tar-extract.ts` 303 行 | **可替代**：modern-tar 已核实（纯 JS/零依赖/MIT/含 symlink 支持），但需复刻 4 项行为 |
| **B2** | STL→SDF 网格场 | `sdf.ts` 239 行 | 可选：库能覆盖一部分，但都是重依赖，且 `solidNormal` 轴码是本项目语义 |
| **B3** | worker 侧四元数/欧拉/周期/插值 | `worker.py` 约 200 行 | 可换已锁定包（scipy），**唯一零新增依赖**的去重点；受 parity 约束 |
| **B4** | 手写 schema 校验 | `process-profile.ts` / `manifest.ts` | 小收益：schema 文件已存在，可换 zod/ajv |
| **B5** | 壁厚 / 局部厚度 | `worker.py`：`_ray_spans` + `check_printability` 壁厚半 | **审计中的新发现**：已锁定的 `trimesh` 自带 `proximity.thickness`（`max_sphere` / `ray` 两种方法）。可作壁厚的**交叉校验**，或替换 `check_printability` 的壁厚半；但数值语义不同（特征尺寸 vs 法向对壁距离），须过 `accept-printability-parity` 45 项 |

另外发现 **3 项与"换库"无关但同属自研卫生**的问题（见 §7）：
`networkx` 锁定进 venv 但全仓库零使用；MPM 内核有约 70 行死代码；
`op_void_reach` 未注册进 OPS/HANDLERS（疑似迁移遗漏）。

**最重要的反面结论**：本项目大量"TS 与 Python 两份实现"**不是重复造轮子，而是刻意的 parity oracle**
（外加 darwin-x64 无 wheel 时的 fallback）。把两侧都换成同一个库会**摧毁 oracle 的独立性**——
这类代码不应按"重复实现"处理。详见 §6。

---

## 1. 范围与方法

**方法**：逐文件读源码 → 划出"通用算法"与"编排/领域规则"的分界 → 拿**已锁定依赖**的能力做第一轮对照
→ 只对"需要新增依赖"的项做外部核查（下载实际分发包 / 查 registry 与 PyPI 元数据 / 读 GitHub API）。

**判据四项，缺一不可**：

1. **功能覆盖度**：覆盖现有语义（含边界行为），不是名字像；
2. **验收口径**：项目对每个领域工具都有 parity 或解析真值验收，替换必须过同一套；
3. **依赖代价**：pnpm build-script 门禁、Python wheel 平台矩阵、bundle 体积、供应链面；
4. **许可与维护**：license 相容、仍在维护、有无单一维护者风险。

---

## 2. 已生效的硬约束（先决定"能不能换"）

| 约束 | 出处（已验证） | 对替代的含义 |
|---|---|---|
| 依赖的 install 构建脚本被 pnpm 门禁挡住 | `tar-extract.ts` 头注 L3-21、`python-runtime.ts` L3-16、DESIGN §4 | 新 npm 依赖须**纯 JS/WASM**，或**随包分发预编译产物**（被 esbuild 打包则安装期无风险） |
| 插件自带 CPython，venv 锁 9 包，**7 个平台目标** | `python-lock.ts` L35-72（linux-gnu ×2、linux-musl ×2、darwin ×2、win-x64） | 新 Python 依赖要进 lock，且要有对应平台 wheel；缺平台要靠既有 fallback |
| 不引入 Vite；Client 走自带 esbuild，除 react 外全部打进 bundle | `esbuild.mjs`、DESIGN §4.3 | 新 UI 依赖直接计入 `lib/client.js`（现 1.08 MB）与 `lib/index.js`（现 4.05 MB） |
| "引擎只在少数几处导入" | DESIGN §31.3 | 替换要落在同一边界模块内 |
| 断言必须可重复 | `DECISION-LOG` 多条、`fluid.ts` L236-268 | 替换后行为需确定性（MPM 的 f32 保真是**刻意选择**） |
| headless 无 X（OpenSCAD 除外，走共享 Xvfb） | `compile.ts` L174-213 | 依赖 GPU/GL 的库不可用于 Host 主路径 |
| 已裁决：OpenSCAD WASM 不用 | DESIGN §4.3 | `compile.ts` 的 CLI 封装不在替代范围 |
| 已裁决：`pythonocc-core`/`PyChrono` 不用（conda-only） | DECISION-LOG 2026-09-27（补记） | B-rep/STEP 路线固定为 FreeCAD headless → OCP → Replicad |
| 已裁决：能用 rapier 的都用 rapier | DESIGN §31.4 | 自研物理不是"缺库"，是表达层选择 |

> **重要背景**：项目**已经主动做过**"用现成库替掉自研数值"的动作，且方法成熟：
> `experiments/20261013_section_mic_feasibility.md` 用 **shapely 的 `maximum_inscribed_circle`**
> （已在依赖里）替掉体素小球扫掠求通道瓶颈，精度从"3 个槽宽全被压成 1.600mm"变为
> "精确命中 1.5/2.0/3.0"，耗时 1–2 ms vs 1.7–2.8 s。本审计是把这种判断批量做完并留下清单。

---

## 3. 当前依赖清单

**npm（Host 与 Client 共用依赖树）**

| 包 | 用途 |
|---|---|
| `manifold-3d` | 布尔/体积/水密/焊接（唯一"实体"来源），Host 侧 external（WASM） |
| `three` + `three-mesh-bvh` | 渲染、几何、射线、最近点（Client 打包；Host 侧测量也用） |
| `@dimforge/rapier3d-compat` | 刚体/约束 |
| `@deepseek-ai/dsh-*` | 平台接线（external） |

**Python venv（`python-runtime.ts` L574-588 锁定）**

`numpy`、`scipy`、`trimesh`、`manifold3d`、`networkx`、`scikit-fem`、`rtree`、`rapier3d`、`shapely`

> **可零成本利用**：`trimesh.proximity/ray/graph/intersections`、`scipy.ndimage/sparse/interpolate/signal/spatial`、
> `shapely` 全套多边形运算、`manifold3d` 布尔与体积。worker 已经大量在用（见 §4.2）。
> **可移除**：`networkx` 除版本清单外零使用；`scikit-fem` 仅被 `scripts/xval-cantilever-scikitfem.py`
> 与 `scripts/measure-python-gains.mjs` 使用，不在 worker 里。

**外部程序**：OpenSCAD CLI（仓库内 AppImage/squashfs）；BOSL2（`lib/BOSL2`，经 `OPENSCADPATH`）。

---

## 4. 自研清单（按区域）

### 4.1 Host TS 领域模块（6635 行）

| 模块 | 行数 | 自研内容 | 已用库 | 替代判断 |
|---|---|---|---|---|
| `mesh.ts` | 369 | 二进制/ASCII STL 精确判别与解析、1e-5 量化焊接、严格水密、union-find 连通体、散度定理体积、二进制写出 | 无 | **部分**：解析/写出可对 three `STLLoader`/`STLExporter`（已在依赖树，`examples/jsm/exporters/STLExporter.js` 已确认存在）；但"长度恒等式判别 + 字节一致焊接"是验收依赖 |
| `sdf.ts` | 239 | 三向非轴射线奇偶定符号 + BVH 最近点距离 + solidNormal 轴码 + 三线性插值 | three-mesh-bvh、manifold-3d | 见 B2 |
| `solidify.ts` | 134 | manifold 编排 + 错误分类 | manifold-3d | 无需替代 |
| `measure.ts` | 179 | 表面吸附、mesh↔mesh / mesh↔球最近点（**parity oracle**） | three-mesh-bvh | oracle 保留；生产已在 worker |
| `assembly.ts`/`assembly-check.ts`/`manifest.ts` | 214/767/288 | 装配清单、五算子契约、干涉/间隙判定（oracle + worker 双路） | manifold-3d | 领域规则 |
| `physics.ts`/`motion.ts` | 694/675 | rapier 编排、关键帧、干涉时间线、准静态 hold 分析；含手写四元数/欧拉数学 | rapier3d-compat、manifold-3d | 数学见 B3；干涉时间线无替代 |
| `fluid.ts` | 754 | 场景组装、驱动、守恒审计、预设推导、私有二进制格式 CADFSDF1/SEED/SNAP | 自研 mpm/sdf | 格式是契约 |
| `mpm.ts` | 551 | **MLS-MPM 内核**（P2G/G2P、APIC、自由滑移重归一、入口/回收） | 无 | 见 A1（TS 版为 oracle + darwin-x64 fallback） |
| `fluid-render.ts` | 185 | 手写 PNG 编码器（CRC32/IHDR/IDAT）+ z-buffer 点云 splat | `node:zlib` | 见 C1 |
| `tar-extract.ts` | 303 | 纯 JS tar.gz 流式解包 + 路径逃逸拒绝 | `node:zlib` | 见 B1 |
| `compile.ts` | 454 | OpenSCAD CLI 发现/调用、共享 Xvfb、diagnostics | 子进程 | 自研合理 |
| `import.ts`/`inspect.ts`/`version.ts`/`runs.ts`/`parts.ts`/`products.ts`/`project.ts` | 349/475/299/264/177/121/179 | 导入管线、版本级封装、版本库/运行库/零件身份/项目作用域 | manifold-3d | 领域与平台 |
| `image-offload.ts`/`image-budget.ts`/`usage.ts`/`tool-scope.ts`/`delivery-audit.ts`/`process-profile.ts` | 445/62/274/210/218/235 | 图像经济策略、计量、预设可见性、交付规则、工艺档案 | dsh API | **故意的"反替换"**（`image-offload.ts` 是 dsh 原生 compaction 的**策略替身**）；`process-profile` 校验见 B4 |

### 4.2 Python worker（`python/cad_worker/worker.py`，5270 行）

> **前提**：worker **已经大量站在库上**——`trimesh.proximity`（最近点）、`trimesh.graph`（面邻接/连通）、
> `trimesh.intersections.mesh_plane`（截面）、`shapely`（polygonize/unary_union/LineString/
> representative_point/minimum_bounding_radius）、`scipy.ndimage`（体素形态学）、
> `scipy.sparse.csgraph`（连通）、`manifold3d`（布尔/体积/焊接）、`numpy`（全部向量化）。

| 自研块 | 行区间 | 已用包 | 替代判断 |
|---|---|---|---|
| `_closest_side`/`_closest_between_meshes` | 208-305 | numpy、trimesh.proximity | **无直接替代**：注释实测 trimesh 对远点 0.45 ms/点、真实件 15 s vs TS 141 ms |
| `op_void_reach`（球扫掠可达） | 355-532 | trimesh、scipy.ndimage | 部分（可压为 `binary_opening`，但远场连通语义不完全等价）；**且未注册，当前死代码** |
| `op_connectivity` + 严格水密 | 535-701 | scipy.csgraph、trimesh.graph | **功能可换**（trimesh `is_watertight ∧ is_winding_consistent`）；自研版是 10× 优化 + 缓存，建议保留 |
| STL 解析/焊接栈 | 704-830 | numpy、manifold3d | 部分（trimesh 语义可替，字节级 parity 阻碍） |
| `_min_distance_via_sampling` | 833-847 | numpy、trimesh | 无直接替代（trimesh 无 mesh-mesh 距离 API） |
| `measure_distance` + `_snap_to_surface` | 1201-1260 | trimesh.proximity | 主体已库 |
| `_ray_spans`（壁厚核心） | 1263-1482 | trimesh.ray + rtree | **无直接替代**：17 探针投票解"射线落接缝"静默失败，是自研价值；但 trimesh 另有 `proximity.thickness`（见 B5），可作交叉校验 |
| 2D 环/拟合工具 | 1593-1753 | numpy、shapely | 部分：`_chain_loops`→`shapely.ops.polygonize`、`_simplify_closed`→`shapely.simplify` |
| `op_list_features` | 1756-2131 | trimesh.facets、scipy.csgraph、shapely | **保留**：特征语义层无轻量等价物，门限是多轮实测教训载体 |
| `op_measure_section` | 2134-2360 | trimesh.intersections、shapely | 已是库为主（范例级） |
| 轴/线度量 | 2363-2627 | numpy、trimesh | 无（库无直线-直线距离 API） |
| **四元数/欧拉/凸性/周期** | 2770-2873 | scipy、manifold3d | **最实的去重点**（见 B3） |
| **MLS-MPM 内核** | 2932-3438 | numpy | 见 A1；含约 70 行死代码（`_mpm_taps`/`axis_weights`/`weights_of`/`op_mpm_step` 不可达块） |
| SDF 读取/采样/投影 | 3461-3860 | numpy | 部分：三线性→`scipy.ndimage.map_coordinates`；梯度→`scipy.ndimage.gradient`；二进制格式是契约 |
| `op_check_printability` | 3879-4205 | numpy、trimesh | 部分：悬垂可换 trimesh 属性；**拔模锥精确证明无库对应**；壁厚半见 B5（`proximity.thickness`） |
| `op_measure_part` | 4208-4268 | manifold3d | 可直接换 trimesh（同公式），保留仅为 parity |
| `op_simulate_motion`/`_physics` | 4282-5021 | rapier3d、manifold3d | 编排；**干涉时间线与 hold analysis 无替代** |
| import/merge/写 STL | 5024-5185 | numpy、manifold3d、trimesh.graph | 胶水；`_shell_count` 已是库 |

### 4.3 Client（约 4700 行）

| 模块 | 行数 | 自研机制 | 通用/业务 | 替代方向 |
|---|---|---|---|---|
| `panel.ts` | 2609 | 定像素探针点、双面拾取孪生、背面 tint、截图拼图、轮询/选择状态机、版面约束 | 混合 | `@react-three/fiber` + `drei`、`leva`（见 C3） |
| `section.ts` | 398 | 微米量化 + **Hierholzer 闭环**、嵌套分类封盖三角化、平面-三角形求交、顶点/孔心吸附 | 通用 | `polygon-clipping`/`clipper2`、`earcut`（three `ShapeUtils` 内部即 earcut） |
| `playback.ts` | 690 | 帧缓存+预取点云回放、轨迹姿态、手写 colormap | 通用（格式是契约） | R3F/drei Points、three `AnimationMixer`、`d3-scale-chromatic` |
| `overlay.ts` | 289 | 每帧 DOM 三轴/比例尺/世界点标签 | 通用 | `drei` GizmoHelper + Html（最干净；注意 L6-10：**刻意不用 WebGL**，因为 headless Firefox 不把 WebGL 合成进截图） |
| `lighting.ts`/`fit.ts` | 160/19 | 相机相对三灯 rig、aspect-aware 取景 | 通用 | `drei` Environment/Stage/`<Bounds>`（收益低） |
| `browse.ts`/`project.ts`/`index.ts` | 60/219/148 | 产物分类、dsh store 解析、按需开 tab | 业务 | 无 |

### 4.4 基础设施与工具链

| 模块 | 行数 | 自研内容 | 判断 |
|---|---|---|---|
| `python-runtime.ts` | 927 | 下载/校验/原子解压/venv/hash 锁安装/**可证伪的就绪检查**/状态机 | 见 A2 |
| `python-worker.ts` | 423 | JSON-lines 常驻 worker、id 关联、**超时即判死**、traceback 抽取 | 通用但有强耦合语义；库收益有限 |
| `python-lock.ts` | 94 | 7 平台 target + hash 锁 + 自造 `# cad-exclude` 指令 | 生成产物；见 A2 |
| `scripts/accept-*.mjs` | 87 个 / 约 13.7k 行 | 自研断言与夹具（无测试框架） | 低优先：需 hermetic DSH_HOME + 插件引导，迁移收益小 |
| `scripts/gen-python-lock.mjs` | 300 | 锁生成 | 与 A2 绑定，一并评估 |

---

## 5. 候选深度评估

### A1. MPM 内核 → numba / warp / taichi（**唯一有明确收益的替换**）

**动机不是"代码难看"**，而是性能已被项目自己判定为实际必需项：
`docs/archive/TOOL-RUNTIME-MATRIX.md` §7 结论是 `simulate_fluid` 比 TS 慢 **5–7×**（超出已批准的 2.5–4×），
"原生内核实测比 TS 快 3.7–4.6× ⇒ **已是该工具的实际必需项**"。
自研内核的维护面同样真实：`_mpm_step_once` 里 float32 复用缓冲、按轴散射、秩 1 累加，
都是为了绕开 numpy 表达式临时数组——这类优化手写一次就要一直维护。

**已核实的事实**（2026-10-14）：

| 候选 | 版本 | license | Python 3.13 wheel | 平台覆盖（项目 7 目标） | 分发体量 |
|---|---|---|---|---|---|
| **numba** | 0.68.0 | BSD-2 | ✅ 5 个 cp313 wheel | gnu-x64/arm64、darwin-arm64、win-x64 = **4/7** | 依赖 llvmlite（另一个较大二进制包） |
| **warp-lang**（NVIDIA） | 1.14.0 | Apache-2.0（轮子内含 libmathdx，NVIDIA SLA） | py3-none（Python 3.10–3.14） | 同上 **4/7** | Linux x64 轮子 **≈138 MB** |
| **taichi** | 1.7.4 (2025-07-31) | Apache-2.0 | ✅ cp313 manylinux_2_27_x86_64 | gnu-x64、darwin-arm64、win-x64 = **3/7**（缺 linux arm64） | Linux x64 轮子 **≈56 MB** |

**共同缺口**：三者**都没有 musl（Alpine）wheel，也都没有 darwin-x64 wheel**。
这不是致命问题——项目**已经有现成的 fallback 路径**：`fluid.ts` L245/L265 保留 `runFluidInTs`
作为 parity oracle 与 darwin-x64 fallback（`DSH_CAD_FLUID_PYTHON=0` 即选它）。
一个基于库的内核可以按"wheel 可用则用，否则回落 TS"来 gate，与现有模式一致。

**候选差异与建议顺序**：

1. **numba 先做**：改动最小（只把热点算子 JIT 化，**不换算法**，parity 风险最低）、依赖成熟、cp313 wheel 齐；
   局限是它不替你维护 MPM，只把 numpy 表达式换成编译后的循环——但它恰好命中当前瓶颈（内存流量）。
   参考：MPM 的 Python 版比 TS 慢 2.5–4× 已实测，而 TS 手写内核的并行散射是它的性能来源。
2. **warp 次之**：自带 APIC 流体示例，CPU 可跑，月度发版、NVIDIA 维护；代价是 138 MB 级轮子 +
   自带 CMake/NVRTC 生态（对"插件自带运行时、可证伪就绪"是新的运维面）。
3. **taichi 最后**：平台覆盖最差（缺 linux arm64）、发布节奏较慢（最新 1.7.4，2025-07），
   且 MPM 参考实现主要在**独立仓库** `taichi_elements`（维护状态需另查）。仓库本身仍活跃
   （2026-10-05 有推送、未归档、28.4k star、Apache-2.0）。

**验收要求（沿用项目纪律）**：同场景 parity（到达率、分段速度、穿透计数）+ 每步耗时 +
**确定性（同输入同输出）** + 平台 gate 行为 + 内存峰值（现为 229 MB @564k 粒子）。

> **✅ 2026-10-14 numba 探针已跑完（`experiments/20261014_numba_mpm_probe.md`）**：
> 同机同管道场景（100×24×24，入口驱动 + 回收，8.8k–524k 粒子阶梯）实测——
> numba 移植版对**现役 numpy 内核 5.1–8.7×**、**对 TS 内核 1.3–2.0× 加速**（四档全部快于 TS）；
> P2G 与原核机器精度一致（质量相对差 4.2e-16、动量差 0），瞬态 30 步漂移 3.8e-6 格，
> 150 步宏观量（transits/escaped/activeN/平均与最大速度）两引擎完全一致；
> 冷编译 1.6 s（常驻进程一次性）。
>
> **✅ 同日已采纳**（DECISION-LOG、`docs/archive/execution_summaries/20261014_feat_numba_mpm_adoption.md`）：
> `python/cad_worker/mpm_numba.py` 生产化，`worker._mpm_engine` 门控
> （`CAD_MPM_ENGINE` 强制；musl/darwin-x64 无 wheel 自动回落 numpy 内核）；
> 锁增 numba/llvmlite；全套验收在工作区 hermetic 运行时全绿
> （`accept-m4`、`accept-mpm-parity` 双路径、`accept-fluid-sign` 16/16，
> 其中到达率跨度阈值 0.15→0.20 经用户拍板）。

### A2. Python 运行时供给 → uv（**需用户裁决**）

`python-runtime.ts` 的绝大多数代码是"下载 → 校验 → 流式解包 → venv → pip 装 → 校验可导入"，
uv 的 `uv python install` / `uv venv` / `uv pip install --require-hashes` 正是这套流程的产品化实现。
`tar-extract.ts` L176-192 自己就写了"strip 布局恰为 `uv python install` 所产"——**作者已知 uv**。

**但已核实的两个硬事实改变了结论**：

1. **uv 没有官方 npm 分发**。npm registry 搜索"astral uv"只有第三方包装器：
   `@dataiku/uv` 0.12.0（MIT，月下载约 4.2k）、`@manzt/uv` 0.8.13（MIT，月下载约 1.4k）。
   二者都是个人维护的低流量包装器。
2. **uv 不能替掉已修缺陷的部分**：`missingLockedImports` 的"可证伪就绪"判定、
   `# cad-exclude` 指令与 reason 上报、`process.kill(-pid)` 杀孙进程、`.part` 原子 rename，
   都是**踩过真缺陷之后**加的（2026-10-11 venv marker 匹配却缺 rtree/shapely，
   工具静默报"干净"）。换成 uv 之后这些仍要自己写一遍——收益是删掉解包/venv 样板，不是删掉可靠性代码。

**三条路，等待裁决**：
（a）自管 uv 二进制（与"运行时是我们 ship 的 artifact"哲学一致，但新增二进制供应链 + 平台矩阵）；
（b）用第三方 npm 包装器（省事，但把供应链接到一个低流量个人包）；
（c）维持现状（`tar-extract.ts` + 自研供给），只做 §7 的清理。
**本文不建议在无裁决的情况下动这一块。**

### B1. `tar-extract.ts` → modern-tar（**可替代，但需复刻 4 项行为**）

**已核实**（我下载了 `modern-tar-0.8.5.tgz` 并读了 `dist/fs/index.d.ts` 与实际产物）：

- 0.8.5、**MIT、零依赖、纯 ESM**、`engines: node>=18`、unpacked 97.5 KB；
- 有独立的 `modern-tar/fs` 入口做"解包到文件系统"，产物里确实有 **symlink 创建与 `SymlinkError`**；
- `UnpackOptionsFS` 有 `maxDepth`（默认 1024，防深度炸弹）、`dmode/fmode`、`concurrency`；
  **未发现 `stripPrefix`** —— 剥离前导 `python/` 需要自己用 filter/map 实现；
- **它已经在项目的 `verification/` 锁文件里**：`@puppeteer/browsers@3.2.2` 的传递依赖
  （即"下载并解包浏览器归档"这件同类事），所以供应链暴露**不是新增**的（但会从 dev-only 变成随插件分发）。

**若替换必须复刻的行为**（都在 `tar-extract.ts` 头注里有明确理由）：

1. **未知 typeflag 抛错**（"静默半解压的解释器比响亮的失败更糟"）；
2. **strip 前缀时顶层 LICENSE 必须随行**（"我们在再分发 CPython"，禁止 quiet omission）；
3. **Windows 无符号链接权限时延迟 copyFile** 的兜底；
4. **路径逃逸拒绝**（`safeJoin`/`safeLinkTarget`）+ 解压进度。

**结论**：收益是删约 300 行维护面；代价是一次行为复刻 + 供应链判断。
被 esbuild 打包后**不触发 pnpm build-script 门禁**，这一条原本的反对理由不再成立。
建议做法：先写一个"用 modern-tar 解 CPython 归档并与现有解包器逐成员比对"的探针，再决定。

### B2. `sdf.ts` → trimesh / libigl / OpenVDB（可选，**不建议现在动**）

现有实现：三向非轴射线奇偶投票定符号 + three-mesh-bvh 最近点距离 + `solidNormal` 轴码。
候选：`trimesh.proximity.signed_distance`（逐点，要自己铺满 10⁵–10⁶ 格，量级存疑）、
`mesh_to_sdf`（依赖 pyrender/GL，headless 可用性差）、OpenVDB `meshToLevelSet`（重 C++ 依赖，
Python 绑定历史上不完整）、libigl（依赖 embree，未在锁定列表）。
**判断**：`solidNormal` 轴码与 MPM 网格对齐是本项目语义，换库仍要自己写；
239 行且已验收，**收益不足以抵消一个重依赖**。若将来 MPM 迁到 numba/taichi 而需要把 SDF 也移到 Python，
再一并评估更合理。

### B3. worker 侧数学 → scipy（**零新增依赖，但受 parity 约束**）

`_quat_to_matrix3` / `_euler_to_quat` / `_scaled_axis_of_euler`（L2770-2812）可整体换
`scipy.spatial.transform.Rotation`（`from_quat/as_matrix/from_euler(degrees=True)/as_rotvec`）；
`_period_from_samples`（L2860-2873）可换 `scipy.signal.find_peaks(distance=3)`；
`_sdf_at`/`_sdf_at_many` 可换 `scipy.ndimage.map_coordinates(order=1)`，
梯度可换 `scipy.ndimage.gradient`（预计算整场，顺带更快）。
**唯一障碍**：这些函数是 TS 参考实现的逐位 parity 移植，注释明确声明 parity 验收。
**做法**：canonical（Python）换库、**oracle（TS）保持独立手写**，先跑 parity。
注意 `_scaled_axis_of_euler` 是"欧拉角×半径"的自定义语义（经 rapier `Rotation3.scaled_axis` 桥接），
**不能**直接当 `Rotation.as_rotvec()` 用，需逐项核对。

### B4. 手写 schema 校验 → zod / ajv（小收益）

`process-profile.ts` L79-131 手写校验、`manifest.ts` L205-227 结构检查，
而 `process-profile.schema.json` 已存在。可换 zod/ajv 消除手写校验，
但**校验错误文案是人读的唯一文档**（注释明确），换库需保住可读错误与"assumed 出处"语义。
建议随下次改动顺手做，不单独立项。

### B5. 壁厚 / 局部厚度 → `trimesh.proximity.thickness`（**审计新发现，值得做交叉校验**）

**事实**（读本地锁定的 trimesh 源码核实）：`trimesh/proximity.py` L546-597 提供

```python
trimesh.proximity.thickness(mesh, points, exterior=False, normals=None, method="max_sphere")
#   method="max_sphere" → max_tangent_sphere(...)，返回 radius * 2（最大内切球直径＝局部特征尺寸）
#   method="ray"        → longest_ray(mesh, points, ±normals)，返回沿法向的最长射线长度
```

`max_sphere` 走的是**最大内切球（shape diameter）**定义，正是"局部壁厚"的教科书定义；
项目现在的 `check_printability` 壁厚半是**沿内法向打到对壁**（`OPPOSITE_WALL_DOT < -0.5`
过滤共面 sliver，`inspect.ts` L66-73 有实测依据），两者在**平板/管壁**上应接近，
在**边角、薄肋、台阶**上会分叉（内切球给出的是局部特征尺寸，会更小）。

**两条用法，风险不同**：

1. **交叉校验（推荐先做，零风险）**：拿 `thickness(method="max_sphere")` 与现有射线壁厚
   在同一批探针上对照。若在已知真值夹具（3.000mm 壁、0.026mm 薄壁、Ø 管壁）上一致，
   就得到一个**独立第二意见**；若分叉，分叉本身就是有价值的诊断信息。
2. **替换壁厚半**：能删掉手写的对壁射线 + dot 过滤，但会**改变上报数值**，
   必须过 `accept-printability-parity`（45 项）与 `accept-measure-thickness`（43 项），
   并重新确认 0.026 / 0.2mm 那两个历史真值。另外 `max_tangent_sphere` 是迭代算法，
   **性能需实测**（现有基线：601 根射线 × 28830 三角形 = 0.121 s）。

`op_measure_thickness` 本体（多段 span + `nudgedMm`/`probeAgreement` 诊断 + 裁剪）
是**多段语义**，`thickness` 只给单值，**不构成替代**——这一点要看清楚，别被函数名误导。

### C 类：不建议动

| # | 项 | 理由 |
|---|---|---|
| C1 | `fluid-render.ts` 手写 PNG → pngjs/sharp | 185 行、零依赖、已验收；PNG 编码只占其中一小半，z-buffer splat 无库可换；注释里"zero new dependencies"是刻意设计 |
| C2 | 把 TS/Python"两份实现"合并为一个库实现 | **会摧毁 parity oracle 的独立性**（见 §6） |
| C3 | `panel.ts` → `@react-three/fiber` + `drei` | 无 Vite、bundle 会显著增大、面板价值在定制交互（定像素探针、双面拾取孪生、剖切封盖）；`overlay.ts` 甚至刻意不用 WebGL。收益只是省胶水 |
| C4 | `list_features` / `check_printability` 拔模锥 / `_ray_spans` 多段语义 | 无轻量等价库；且都修过真缺陷（射线接缝漏检、遍历序当距离序、共面退化面假 0、静默未测到）——换库等于丢掉这些防护。（壁厚**单值**那一半是例外，见 B5） |
| C5 | `python-worker.ts` JSON-lines IPC | ~140 行，与"超时即判死"语义强耦合；comlink 面向 postMessage 不适用 |
| C6 | `compile.ts`（OpenSCAD 编排）、`image-offload.ts`（策略替身）、各业务域模块 | 平台接线 / 领域规则，无替代对象 |
| C7 | `scripts/accept-*.mjs` → `node:test` | 87 个脚本需要 hermetic DSH_HOME + 插件引导，迁移收益小、回归面大 |

---

## 6. 特别说明：为什么"两个实现"不该按重复造轮子处理

本项目 TS 侧保留了大量几何/物理实现，读起来像重复，实际有三种身份：

1. **parity oracle**：`measure.ts`、`assembly-check.ts`、`inspect.ts`、`physics.ts`、`motion.ts`、
   `fluid.ts` 头注都写明"生产在 Python worker，本文件是 parity oracle"。
   oracle 的**全部价值**在于它是**独立实现**——如果两侧都调用 `scipy`/`trimesh`，
   验收就退化成"同库自证"，恰好是这套 harness 最反对的那种"无法证伪的通过"。
2. **platform fallback**：darwin-x64 没有 `rapier3d` wheel（`python-lock.ts` L85-88 的 `cad-exclude` 注释），
   所以 TS 版是该平台的 canonical。
3. **真实自研**：`mesh.ts`、`sdf.ts`、`mpm.ts`、`tar-extract.ts`、`fluid-render.ts`。

**推论**：替换只能动"canonical 侧"，oracle 侧必须保持独立。
这条规则应写进任何后续替换方案的验收设计里。

---

## 7. 立即可做的清理（不需要任何新库）

| # | 项 | 事实 | 建议 |
|---|---|---|---|
| 1 | `networkx==3.7` 锁定进 venv 但零使用 | 全仓库仅出现在 `worker.py` L136 的版本清单 | 从 lock 移除；`op_versions` 的 `wanted` 列表同步 |
| 2 | `scikit-fem==12.0.2` 仅被探针脚本使用 | `scripts/xval-cantilever-scikitfem.py`、`measure-python-gains.mjs` | 决定归属：若探针保留，把它移出插件运行时锁、单独 dev 环境；否则一并移除 |
| 3 | MPM 死代码约 70 行 | `_mpm_taps` L3061-3087、`axis_weights` L3090-3099、`weights_of` L3102-3111 无调用点；`op_mpm_step` L3388-3394 为 return 后不可达块 | 删除 |
| 4 | `op_void_reach` 未注册 | L355-532 存在，但 OPS（L79-110）与 HANDLERS（L5188-5219）都没有它 | **确认是否迁移遗漏**：若已被 MIC 方案取代（`experiments/20261013_section_mic_feasibility.md`），删除并写决策记录；否则补注册 |

---

## 8. 若采纳替换，必须遵守的迁移纪律

沿用 `docs/archive/TOOL-RUNTIME-MATRIX.md` §6 的既有纪律：

1. **工具名/schema 不变**，模型无感；
2. **同输入同输出对照**：parity 或解析真值 + 耗时对比，写进 `scripts/accept-*.mjs`；
3. **canonical 归属写明**：同一问题域只能有一个权威实现（现有先例：两套 rapier 的裁决）；
4. **决策记录**：依赖引入属"不可逆或高成本决策"，按 `AGENTS.md` §二写 `docs/DECISION-LOG.md`；
5. **实验报告**：候选对比（如 numba vs warp vs taichi）按 `AGENTS.md` §四落 `experiments/`；
6. **文档同步**：影响架构则更新 `DESIGN.md`；影响依赖清单则更新 `HARNESS.md` §12.4。

---

## 9. 待用户裁决

1. **A1**：是否启动 MPM 候选 probe？建议顺序 numba → warp → taichi，用真实工具场景做 parity + 每步耗时 + 确定性。
2. **A2**：Python 运行时是否允许引入 uv（自管二进制 / 第三方 npm 包装器 / 维持现状，三选一）？
3. **B1**：是否值得为删 300 行 tar 解包代码做一次 modern-tar 行为比对探针？
4. **B3**：canonical 侧换 scipy 的"顺手清理"是否单独立项，还是并入后续相关改动？
5. **B5**：是否先用 `trimesh.proximity.thickness` 对现有壁厚做一次**交叉校验**（零风险、可立刻做）？
6. **§7**：`networkx`/`scikit-fem` 与 `op_void_reach` 归属的确认。

---

## 附录：本次核查的关键事实与来源

| 事实 | 来源 |
|---|---|
| taichi 1.7.4：Apache-2.0，`requires_python <4.0,>=3.9`，cp313 wheel 仅 manylinux_2_27_x86_64 / macosx_11_0_arm64 / win_amd64；上传 2025-07-31 | PyPI `taichi/1.7.4/json`；GitHub API `taichi-dev/taichi`（未归档，2026-10-05 推送，28.4k star） |
| warp-lang 1.14.0：Apache-2.0（含 libmathdx 的 NVIDIA SLA），py3-none 轮子 manylinux_2_28_x86_64 ≈138 MB / manylinux_2_34_aarch64 / macosx_11_0_arm64 / win_amd64；Python 3.10–3.14；CPU 可跑 | PyPI `warp-lang/json` |
| numba 0.68.0：`requires_python >=3.10`，classifiers 3.10–3.15，5 个 cp313 wheel（含 manylinux x86_64/aarch64、macosx_12_0_arm64、win_amd64） | PyPI `numba/json`（实际下载元数据解析） |
| modern-tar 0.8.5：MIT、零依赖、ESM、node>=18、97.5 KB；`fs` 入口含 symlink 与 `SymlinkError`、`maxDepth`；未见 `stripPrefix` | `registry.npmjs.org/modern-tar/latest` + 下载 tarball 读 `dist/fs/index.d.ts` 与产物 |
| modern-tar 已是本项目 verification 的传递依赖 | `verification/pnpm-lock.yaml` L234/L300/L333（`@puppeteer/browsers@3.2.2`） |
| uv 无官方 npm 包；仅 `@dataiku/uv@0.12.0`、`@manzt/uv@0.8.13` 两个第三方包装器 | `registry.npmjs.org/-/v1/search?text=astral uv` |
| three 0.170 自带 `STLLoader`（`panel.ts` 已在用）与 `STLExporter` | `node_modules/three/examples/jsm/exporters/STLExporter.js` 存在 |
| 项目 7 个 Python 平台目标；rapier3d 缺 darwin-x64 有显式 `cad-exclude` 注释 | `python-lock.ts` L35-72、L85-88 |
| `networkx` 零使用；`scikit-fem` 仅探针脚本使用 | 全仓库 grep（`worker.py` L136-137 仅版本清单） |
| 当前 bundle 体积：`lib/client.js` 1.08 MB、`lib/index.js` 4.05 MB | `ls -la dsh-cad-harness/lib/` |
| MPM 性能：TS 3.1/23.4/88.3 ms/步 @8.8k/70.6k/262k 粒子；Python 慢 2.5–4×；原生比 TS 快 3.7–4.6× | `experiments/20261008_python_migration_measurements.md` L200/L210-217、`docs/archive/TOOL-RUNTIME-MATRIX.md` §7 |
| 已用 shapely `maximum_inscribed_circle` 替掉体素瓶颈法（替换先例） | `experiments/20261013_section_mic_feasibility.md` |
| 已锁定的 trimesh 自带 `proximity.thickness`（`max_sphere` → `max_tangent_sphere`；`ray` → `longest_ray`） | 本地 venv `.tmp-measure-runtime/venv/lib/python3.13/site-packages/trimesh/proximity.py` L546-597 |

---

## 2026-10-16：项目自身许可与依赖复核

**项目许可：Apache-2.0**（全文见 `LICENSE`，第三方声明见 `NOTICE`）。

**直接依赖（18 个）逐项复核结果——全部为 MIT 或 Apache-2.0，无任何 GPL/AGPL/LGPL：**

| 许可 | 依赖 |
|---|---|
| Apache-2.0 | `@dimforge/rapier3d-compat`、`manifold-3d`、`puppeteer`、`@puppeteer/browsers`、`typescript` |
| MIT | `@deepseek-ai/*`（cordis、dsh-api-session-controller、dsh-attachment、dsh-client-connection、dsh-tools）、`@types/*`、`esbuild`、`react`、`three`、`three-mesh-bvh` |

**BOSL2 不随仓库分发：** 它在本地 `lib/BOSL2/`，而 `lib/` 在 `.gitignore` 中——**仓库里没有它**。
其许可为 **BSD 2-Clause**（Copyright (c) 2015-2024 Revar Desmera），本项目提供
`dsh-cad-harness/scripts/accept-bosl2.mjs` 作为使用者的**校验**入口（它只编译一个测试齿轮核对接线，不负责下载）。

**运行期由用户获取、本项目不分发：** OpenSCAD（GPL-2.0，独立程序调用，非链接）、
Python 运行时与科学计算包（`python_runtime` 在用户机器上下载）、题库第三方素材
（Pixabay 等，**物化不入库**，逐项登记见 `examples/bench/ATTRIBUTION.md`）。

**结论：** 以 Apache-2.0 发布不存在 copyleft 牵连；`NOTICE` 与本节共同满足 Apache-2.0 的声明义务。

