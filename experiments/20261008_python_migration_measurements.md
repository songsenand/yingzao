# 实验报告：Python 迁移的"明确负收益"到底存不存在

## 目标
> 用户定下的判据是「**对 LLM，Python 是第一语言，能迁的默认迁 Python，只有明确负收益的
> 才不做**」，并且明确要求：**"明确负收益"必须用数据说话**。
>
> 我此前凭直觉列了几条"负收益"（每次调用起新进程、`measure_closest` 没有空间索引、
> 面板/图片过 IPC）。本实验把它们全部换成实测数字，好让"保留 TS"这件事要么有依据、
> 要么撤回。

## 假设
> - H1：每次工具调用起一个新 Python 进程的代价足以毁掉小工具 → "负收益"。
> - H2：`measure_closest` 在 Python 侧没有 three-mesh-bvh 那样的索引，会明显退化。
> - H3：面板载荷/渲染图片经 worker IPC 会变慢，所以 HTTP 路由与图片处理应留在 TS。

## 方法
> - 脚本：`dsh-cad-harness/scripts/measure-python-migration.mjs`（四个测量段 E1–E4）。
> - 运行时：**插件自己供给的运行时**（`$DSH_HOME/cad/runtime` 同款产物），本实验
>   provision 到 `.tmp-measure-runtime`：
>   ```bash
>   DSH_CAD_PYTHON_ROOT=<repo>/.tmp-measure-runtime \
>   DSH_CAD_PYTHON_MIRROR=https://registry.npmmirror.com/-/binary/python-build-standalone \
>   DSH_CAD_PYTHON_INDEX_URL=https://mirrors.aliyun.com/pypi/simple \
>   node -e "await import('./src/host/python-runtime.ts').then(m=>m.ensurePythonRuntime())"
>   # 实测 683.7 s（含下载 + 七个依赖安装）
>   ```
> - 网格与查询点：`examples/microscope4/cad-data/runs/r024/parts/整机.stl`
>   （28,830 三角面），**同一批 200 个确定性伪随机点**（LCG seed=42）喂给两侧。
> - E1 每档 10 次取中位数；worker 往返 200 次取中位数；E2 逐点计时；E3/E4 各 20/10 次。
> - 索引对照：先在**没有 rtree** 的 venv 里测（naive 路径），再 `pip install rtree 1.4.1`
>   重测（indexed 路径）——因为 rtree 不在当前锁里，它是否可用本身就是要测的事。

## 结果

### E1 冷启动与常驻 worker（median）

| 场景 | 中位数 | 说明 |
|---|---|---|
| 裸解释器 `-I -c pass` | **11.69 ms** | 进程启动下限 |
| `import numpy, scipy` | **90.24 ms** | |
| `import numpy, scipy, manifold3d, trimesh, skfem` | **443.69 ms** | **一次工具调用的真实代价** |
| 常驻 worker 往返（空载） | **0.02 ms** | JSON-lines，200 次 |
| 常驻 worker 往返（全工具集已导入） | **0.02 ms** | 同上 |

### E2 最近点（同一网格 / 同一 200 点）

| 路径 | ms/query | 200 点总计 | 与 TS 的最大距离偏差 |
|---|---|---|---|
| three-mesh-bvh（TS） | **0.0204** | 4.1 ms（BVH 构建 14.7 ms） | — |
| trimesh **+ rtree**（indexed） | 0.6111 | 122.2 ms | **0 mm** |
| trimesh **无索引**（naive） | 4.58–7.13 | 915–1426 ms | **0 mm** |

`rtree 1.4.1` 的 wheel 覆盖我们的**全部七个目标**（macos x86_64/arm64、manylinux
x86_64/aarch64、musllinux x86_64/aarch64、win_amd64），0.37–1.48 MB，**py3 标签、不需编译器**。

### E3 面板载荷（34 KiB，60 个版本的 scad + datums）

| 路径 | 中位数 |
|---|---|
| Node 直读磁盘 + 解析（120 个文件） | 0.90 ms |
| worker 往返（同载荷） | **0.25 ms** |

### E4 渲染图片（178 KiB PNG → 237 KiB base64）

| 路径 | 中位数 |
|---|---|
| 宿主读文件 + base64 编码 | 0.15 ms |
| worker 往返（237 KiB 载荷） | **0.82 ms** |

## 分析

- **H1 成立，但它不是"工具归属"问题。** 443.69 ms vs 0.02 ms ≈ **2×10⁴**。每调用一个新进程
  会毁掉所有小工具的体验；而常驻 worker 把它压到 20 微秒——**比 Node 直读磁盘（0.9 ms）
  还便宜**。⇒ 这唯一被证实的负收益，解法是 `HARNESS §12.3` 的 worker，不是"把工具留在 TS"。
- **H3 被推翻（两条都）。** 34 KiB 载荷过 IPC 0.25 ms，比直读磁盘快；178 KiB 图片过 IPC
  0.82 ms。**传输从来不是瓶颈**，我先前把它当成"保留 TS"的理由是错的。
  （图片仍必须交给宿主 `ctx.attachments`——那是 ① 类 API 边界，不是性能。）
- **H2 部分成立、但不足以否决迁移。** 没有索引时 Python 慢 **224–350×**；加上 rtree 仍慢
  **30×**；但**绝对耗时是 122 ms / 200 点**，而精度与 TS **完全一致（Δ=0 mm）**。
  对一个低频、点数有限的工具调用，122 ms 完全可接受。⇒ `measure_closest` **可以迁**，
  代价是给锁加一个 `rtree`（七平台全有 wheel）。
- **①类（平台接线）不需要 benchmark。** `ctx.tools.register`、`ctx.attachments`、
  `connection.fetch.register` 都是宿主进程内的 cordis 服务，跨进程够不着——这是 API 边界
  事实，证据是代码位置而非耗时：`tools.ts` 的 `ctx.attachments.saveImages(...)`、
  `index.ts` 的 `connection.fetch.register(...)` / `connection.rpc.intercept(...)`。

**汇总：按目前的实测，没有任何工具因为性能被排除在 Python 之外。**
唯一阻塞迁移的是"worker 还没落地"。

## 遇到的问题

1. **第一次 E2 测出 308 mm 的"不一致"是我自己的 bug**：我用了 three-mesh-bvh 的旧签名
   `closestPointToPoint(point, target, min, max)`，`target` 根本没被写入，于是"最近点"恒为
   原点、距离恒为到原点的距离。是脚本里的 **agreement 断言**把它抓出来的——这正是"测量里
   必须带对拍"的价值。改成现代 API `closestPointToPoint(point).distance` 后 **Δ=0 mm**。
2. **解释器下载走 GitHub 直连时 ~20 分钟没下完**（本次网络），换 npmmirror 镜像后整段
   provision 683.7 s 完成。印证了供给设计里"镜像兜底"的必要性。
3. `trimesh.proximity.on_surface` 在没有 rtree/embree 时**直接抛 ModuleNotFoundError**
   （而不是自动退化），所以"无索引"必须显式走 `closest_point_naive` 才能测到——脚本里两条
   路径都测。

## 产物列表

**代码与脚本：**
- `dsh-cad-harness/scripts/measure-python-migration.mjs` —— 四段测量（E1 冷启动/worker、
  E2 最近点、E3 面板载荷、E4 图片载荷），支持 `--only e1|e2|e3|e4`、`--runtime <dir>`、
  `--image <png>`、`--out <json>`；结果按段合并进同一份 JSON。

**数据：**
- `dsh-cad-harness/data/bench/python-migration.json` —— 本次最终结果（E2 含 rtree 索引路径）
- `dsh-cad-harness/data/bench/python-migration-nortree.json` —— **安装 rtree 之前**的快照
  （indexed 路径失败、仅 naive 可用），是"无索引会怎样"的原始证据

**运行命令：**
```bash
# 1) 供给测量用运行时（约 11 分钟；镜像可换）
DSH_CAD_PYTHON_ROOT=$PWD/.tmp-measure-runtime \
DSH_CAD_PYTHON_MIRROR=https://registry.npmmirror.com/-/binary/python-build-standalone \
DSH_CAD_PYTHON_INDEX_URL=https://mirrors.aliyun.com/pypi/simple \
node -e "await import('./dsh-cad-harness/src/host/python-runtime.ts').then(m=>m.ensurePythonRuntime())"

# 2) 四段测量（--only 可单跑；重复跑会按段合并）
cd dsh-cad-harness
node scripts/measure-python-migration.mjs --runtime ../.tmp-measure-runtime
node scripts/measure-python-migration.mjs --runtime ../.tmp-measure-runtime --only e2   # rtree 前后各一次
node scripts/measure-python-migration.mjs --runtime ../.tmp-measure-runtime --only e4

# 3)（可选）加上索引再测一次
../.tmp-measure-runtime/venv/bin/python -m pip install rtree==1.4.1
```

**环境依赖：**
- 解释器与依赖：`python-build-standalone cpython-3.13.16+20261003` + 锁定的七个依赖
  （numpy 2.5.3 / scipy 1.18.1 / trimesh 5.1.1 / manifold3d 3.5.4 / networkx 3.7 /
  scikit-fem 12.0.2 / rapier3d 0.36.1）
- 测量额外装入：`rtree 1.4.1`（**不在当前锁里**）
- Node：v26.10.0；网格：`examples/microscope4/cad-data/runs/r024/parts/整机.stl`

## 结论与下一步
> 1. **batch 0（常驻 worker + JSON-lines）先做**：它不是"优化"，它是让"能迁就迁"成立的前提；
>    验收里要写进"worker 往返 < 1 ms、冷启动 400+ ms"这对数字。
> 2. **`measure_closest` 可以迁 Python**，代价是锁里加 `rtree 1.4.1`（七平台 wheel，无需编译器）；
>    若将来点数上千且成为瓶颈，再评估 native（先量后写）。
> 3. **面板路由与图片处理不因性能留 TS**：传输实测 0.25/0.82 ms。它们留在 TS 的唯一理由是
>    ①类 API 边界（`connection.fetch.register`、`ctx.attachments`）。
> 4. 本实验推翻了 v2 矩阵里两条"明确负收益"猜测，矩阵相应更新；**目前没有任何工具因性能被排除**。

---

## 补充：batch 0 协议原型实测（同日，脚本 `scripts/proto-python-worker.mjs`）

上面 E1 只回答了"要不要常驻 worker"。这一节回答"**协议本身该怎么写**"——特别是
HARNESS §12.3 那句"大载荷走文件路径"，此前只是断言，没有阈值也没有数字。

原型：Python 侧 hello 握手 + `for line in sys.stdin` 单线程循环，帧为
`{id, op, params}` → `{id, ok, result}` / `{id, ok:false, error, traceback, ms}`。

| 测点 | 结果 |
|---|---|
| P1 spawn → hello（`protocolVersion` 握手） | **15.64 ms**（n=5） |
| P2 ping 往返（冷 / 重库导入后） | **0.023 / 0.019 ms**（各 200 次） |
| P3 **参数侧** 1M float64：inline JSON **5.6 MiB** vs 文件 **7.6 MiB** raw | **106.4 ms vs 0.72 ms（148×）** |
| P4 **结果侧** 100k×3 float32：inline JSON 2.1 MiB / inline base64 1.5 MiB / 文件 1.1 MiB | **98.2 / 16.3 / 0.92 ms**（+宿主读文件 0.16 ms） |
| P5 失败帧 | `ok:false` + `ValueError: …` + **7 行完整 traceback**（含 worker 内帧） |
| P6 两个请求同时发出 | **140.5 ms = 串行**（120+20）；`serialized: true`；**id 关联正确** |

**分析：**

1. **§12.3 的"大载荷走文件路径"被证实，而且阈值比想象的更低。** 参数侧差 **148×**、结果侧
   inline JSON 差 **107×**、连 base64 inline 也差 **18×**。结论：**1 MiB 量级就该走文件**，
   不要等"大"载荷；base64 只适合小结果（几十 KiB）。
2. 帧形状与握手可用：启动 15.6 ms、之后每次调用 **~20 µs**，`protocolVersion` 在 hello 里带上。
3. **worker 是单线程串行的**：两个并发请求的耗时等于串行和。batch 0 必须写明：
   ① 宿主侧的并发工具调用会在 worker 里**排队**，**超时预算要把排队算进去**；
   ② 要真并行只有两条路——Python 侧异步分派（IO 型）或 worker 池（CPU 型）。
   v1 建议**先串行 + 明确记录**：几何/仿真都是 CPU 密集，多开进程抢同一颗核没有收益。
4. 失败帧带完整 traceback（P5）⇒ §12.3 的"错误返回完整 traceback"可验证，且不需要额外机制。

**产物：** `dsh-cad-harness/scripts/proto-python-worker.mjs`（原型 + 六个测点）、
`dsh-cad-harness/data/bench/python-worker-protocol.json`（原始数据）。

```bash
cd dsh-cad-harness
node scripts/proto-python-worker.mjs --runtime ../.tmp-measure-runtime
```

---

## 补充 2：TS ↔ Python 实现差异（同工作量对拍）

用户 2026-10-08 阶段决定：**现在只做 JS/TS 与 Python 实现的差异对比**；"用 C/C++/Rust
替代性能不够的 Python 代码"属于**中后期**，现在做太早；原生基准正在做的那一件补完即止。

方法：`scripts/measure-python-gains.mjs`（M1–M5）。每个用例同输入、同工作量、同机器：
TS 侧直接 import 插件**现役模块**，Python 侧用供给运行时里的库。原始数据
`data/bench/python-gains.json`。

| 车道 | TS 现役实现 | Python 实现 | 比值 | 结果一致性 |
|---|---|---|---|---|
| **MPM 内核**（P2G→格点→G2P，27 邻域，每步） | 3.1 / 23.4 / 88.3 ms @ 8.8k / 70.6k / 262k 粒子 | numpy+bincount 12.7 / 71.2 / 263.2 ms；scipy CSR 11.4 / 59.1 / 230.1 ms | **Python 慢 2.5–4×**（0.24–0.40×） | 同一算式 |
| **体素 FEM**（悬臂梁 100×10×10，端部 100 N） | 0.1 / 1.7 / 27.8 s（**总**，含组装；@640/5120/40960 单元） | scikit-fem：**组装 1.7 / 10.7 / 80.1 s** + CG 求解 0.044 / 1.16 / 4.91 s | **组装是瓶颈：Python 的组装单项就比 TS 全过程慢 3–17×**；**CG 求解本身反而快 1.5–2.3×** | n=4/8 的 δ 与 TS 一致（−3.5% / −0.9%）；**n=16 的 CG 未收敛（δ=−83%），该点作废** |
| **Manifold 布尔 + 体积**（两件并集） | 134.6 ms | 44.0 ms | **Python 快 3.06×** | 体积 Δ = 0 mm³ |
| **最近点查询**（28,830 面，200 点） | 0.0204 ms/点（three-mesh-bvh） | 0.61 ms/点（trimesh + rtree） | Python 慢 30×，但 **200 点共 122 ms** | Δ = 0 mm |
| **STL 解析 + 焊接**（1.4 MB） | 18.9 ms | trimesh 21.7 ms；numpy 零拷贝视图 ≈ 0 ms | 0.87× / 更快 | 三角面数一致 |
| **连通体 + 水密**（整机 STL） | 解析+水密 85.2 ms，连通体 18.4 ms | trimesh 30.2 ms，split 24.0 ms | **Python 快 1.7× / 略慢 1.3×** | 都判 watertight=true、**都是 26 个连通体** |
| （原生 C 参考，**中后期**用） | — | — | 原生 C 比 TS 快 **3.7–4.6×** | 同一算式 |

**分析：**

- 我此前在矩阵里写的"MPM Python 化 **5–20×**""FEM 更快"**都被数据推翻**。真实情况分三类：
  1. **Python 更快**：Manifold 布尔（3×）、连通体判定（1.7×）、STL 零拷贝解析——
     "Python 生态里现成的高质量实现"赢过我们的手写版本。
  2. **打平但可接受**：最近点查询（慢 30×，绝对量 0.61 ms/点、200 点 122 ms）。
  3. **Python 更慢**：MPM 内核（2.5–4×）、FEM 的**稀疏组装**（3–17×）。
- **FEM 的结论要拆开看**：慢的是 scikit-fem 的组装，不是求解；CG 求解比我们的 matrix-free
  还快。所以"FEM 迁 Python"的真实成本取决于是否照搬 scikit-fem 的组装路线——若在 Python 里
  写同样的 matrix-free 内核，组装成本就不存在（但那等于用 numpy 重写 TS 的算法，而 MPM 的
  数据提示这未必划算）。
- **n=16 那个点作废是这套测量最重要的副产品**：CG 在 139k DOF 上没收敛（δ 偏 −83%），
  是"结果一致性"列把它抓出来的。只盯耗时会把一个错误的解当成 5.7× 的胜利。

**产物：** `dsh-cad-harness/scripts/measure-python-gains.mjs`（M1–M5）、
`scripts/native/mpm-kernel-bench.c`（原生参考，中后期决策用，**不参与构建**）、
`data/bench/python-gains.json`（最终）、`data/bench/python-gains-firstrun.json`（含第一版
scikit-fem 直接解的时间，供对照）。

```bash
cd dsh-cad-harness
node scripts/measure-python-gains.mjs --runtime ../.tmp-measure-runtime              # 全部
node scripts/measure-python-gains.mjs --runtime ../.tmp-measure-runtime --only m4    # 单段
```
