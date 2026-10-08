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
