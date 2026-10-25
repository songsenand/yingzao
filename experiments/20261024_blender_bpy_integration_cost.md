# 实验报告：Blender bpy 接入成本


> **历史记录（2026-10-25 更新）**：bpy 艺术 lane 及其文件（`skills/cad-art/`、`examples/art-decor-panel/`、`src/host/art-render.ts`）已按 D 方案移除；下面的命令与路径是当时实验的记录，不再代表当前仓库路径。移除决策见 `docs/DECISION-LOG.md` 2026-10-25。

> 日期：2026-10-24 ｜ 环境：Linux x64 / 16 核 / 30 GB / Arch
> 对照：系统 Blender 5.2.3 LTS；插件运行时 CPython 3.13.16；bpy 5.2.3
>
> **一句话结论：bpy 现在“能接”，而且渲染不慢——但把它作为运行时依赖接进来的成本不在 CPU，
> 在 1.3 GB 磁盘、4/7 平台缺口、GPL-3.0 的链接边界、Python 3.13 的死绑定，以及常驻 worker
> 的 stdout 协议冲突。若目的只是“玩具艺术面”，外部 Blender CLI 用同样的脚本、同样的耗时，
> 却把许可与 ABI 边界留在进程外；bpy 进锁的性价比很低。**

## 目标

回答一个决策问题：**把 Blender 的 Python 库 `bpy` 接进 dsh-cad-harness，成本是多少；现在值不值得做。**

范围限定在“渲染/可视化面”：

- bpy 作为**渲染器**（PNG / 材质 / 灯光 / 未来 GLB）接入；
- 不讨论用 bpy 替代 OpenSCAD 做参数化几何生成——那会推翻 DESIGN v2.13 的“SCAD 是模型来源、
  Python 只做分析/仿真/装配检查”，是架构变更，不是依赖引入。

## 假设

1. “成本”按**用户装完插件后真的可用、可维护、许可清楚**来算，不是“本机能跑通”；
2. bpy 当前版本 5.2.3 提供 `cp313` wheel，正好匹配运行时 CPython 3.13.16——这是与 2026-09
   那次“Blender bpy 按需”判断不同的事实，必须先验证；
3. 成本至少包括：下载/磁盘、首装时间、平台矩阵、许可、工程接线、常驻内存、后续升级；
4. 渲染速度不是唯一指标：给 LLM 判读几何的图，与给人看的“艺术图”，是两种负载。

## 方法

- 从阿里云镜像取 `bpy-5.2.3-cp313-cp313-manylinux_2_28_x86_64.whl`（402,843,256 B），
  在**独立 venv**（CPython 3.13.16）安装；不碰 `$DSH_HOME/cad/runtime/venv`。
- 用 `resource.getrusage(RUSAGE_CHILDREN).ru_maxrss` 量子进程**峰值 RSS**；Wall 含解释器/Blender 启动。
- 样本：`examples/microscope4/cad-data/runs/r024/parts/整机.stl`（真实装配件，非玩具立方体）。
- 三种负载：
  1. `views`：前/侧/俯/轴测四视图，Workbench（无材质）；
  2. `views`：四视图，Cycles CPU 512/32；
  3. `art`：单张材质 hero（Principled BSDF + 地面 + 三点面光），Cycles 1024/64。
- 同一份 `render_views.py` 分别用 `python`（`import bpy`）和 `blender -b -P` 执行，直接对比。
- 另测：`import bpy` 单独成本、常驻 worker 基线 RSS、bpy 渲染的 stdout/stderr 分流、
  OpenSCAD 512 单帧基线。
- 平台与许可：PyPI JSON 元数据 + Blender 官方镜像 5.2/4.5 构建清单。

复现命令与产物见 [`experiments/20261024_blender_bpy_cost/`](20261024_blender_bpy_cost/README.md)。

## 结果

### 1. 安装与磁盘

| 项 | 实测 |
|---|---|
| wheel（manylinux_2_28_x86_64） | **402,843,256 B / 384.2 MiB** |
| 阿里云下载 | **30.3 s @ 12.7 MiB/s（13.3 MB/s）**（PyPI 直连在本机曾停滞，未完成） |
| 安装（含依赖） | **69.5 s**（下载 30 s + 解包/写入约 40 s） |
| bpy 安装后 | **883 MiB** |
| 独立 venv（含 numpy 等） | **1009 MiB** |
| `import bpy` | **0.37–0.48 s，343–461 MiB RSS** |

bpy 5.2.3 的 `Requires-Dist` 是 `cattrs, cython, numpy<3.0,>=2.2, requests, zstandard`。
锁的安装方式是 `pip install --no-deps`（锁即闭包），所以这些依赖不能靠 pip 解析：
`attrs`、`charset_normalizer`、`idna`、`urllib3`、`certifi` 是新出现的，要**逐条进锁并带 hash**；
`numpy` 与 `typing_extensions` 已在锁里，不增加新条目。

与现有运行时的叠加（本机实测）：

| 组成 | 现有 | 加 bpy 后（进锁） |
|---|---|---|
| `venv/` | 1434 MiB | 约 1434 + 883 + 45 ≈ **2362 MiB** |
| `cache/`（wheel 缓存） | 613 MiB | 约 **1016 MiB**（+403 MiB） |
| `python/` | 109 MiB | 109 MiB |
| **合计** | **2156 MiB** | **约 3487 MiB** |

即：**下载 +403 MB，磁盘 +1.3 GB，首装 +70 s（镜像顺利时）**。README 现在写的“约 380–400MB 磁盘”是 v1 依赖集的早期估计；锁后来加入 numba/jax/warp/xlb，
本机实测已到 2.1 GB。加 bpy 后实际磁盘会到 ~3.4 GB，这个差距值得在文档里一并校正。

### 2. 渲染耗时与内存

样本为整机 STL；RSS 是进程峰值。

| 负载 | bpy 模块 | Blender CLI | bpy RSS | CLI RSS |
|---|---|---|---|---|
| Workbench 512 单张 | 0.76 s（render 0.26 s） | 1.34 s | 672 MiB | — |
| Workbench 1024 单张 | 0.81 s（render 0.31 s） | 1.25 s | 743 MiB | 841 MiB |
| **Workbench 1024 四视图** | **1.20–1.33 s**（batch 0.79–0.82 s） | **1.32 s**（batch 0.77 s） | **657–684 MiB** | 858 MiB |
| Cycles 512/32 单张 | 1.40 s（render 0.92 s） | 1.68 s（render 1.05 s） | 766 MiB | 841 MiB |
| **Cycles 512/32 四视图** | **4.42 s**（batch 3.89 s） | **4.35 s**（batch 3.82 s） | **737 MiB** | 858 MiB |
| Cycles 1024/64 单张（无材质） | 4.77 s（render 4.28 s） | 5.30 s（render 4.67 s） | 1409 MiB | 1356 MiB |
| **Cycles 1024/64 材质 hero** | **13.32 s**（render 12.82 s） | **13.07 s**（render 12.48 s） | **1286 MiB** | 1353 MiB |
| EEVEE 512 单张（headless） | — | **12.41 s**（render 11.70 s，user 71 s） | — | — |
| OpenSCAD 512 单帧（fresh xvfb） | — | **3.24 s** | — | **150 MiB** |

> 以上是本机 16 核 CPU / 软件 GL 的结果。Cycles 是 CPU 渲染，4 核笔记本会明显更慢（未测）；
> Workbench 的软件 GL 路径也受 CPU 影响。跨平台数字未测，平台结论只来自 wheel/官方构建清单。

关键观察：

- **bpy 与 CLI 的耗时几乎相同**（Workbench 四视图 1.3 s vs 1.3 s；Cycles 512 四视图 4.4 s vs 4.4 s；
  材质 hero 13.3 s vs 13.1 s）。同一场景两条路径出的图肉眼无差；Workbench 的输出尺寸相同、但字节不全等（Blender 构建/Python 版本不同），Cycles 也因采样/降噪不逐字节一致——它们服务于判读，不是真值。
- bpy 只在 Workbench 四视图上省约 170–200 MiB RSS；到 Cycles 材质图，两者都是 1.3 GB 量级。
- **headless EEVEE 不可用**：没有 GPU/GL 时走软件 GL，512px 要 11.7 s、71 s CPU 时间；服务器上不要选它。
- **给 LLM 判读几何，Workbench 四视图 1.3 s 就够**；材质 hero 13 s 是“给人看”的负载，不能塞进每次
  `generate_part`。
- 与 OpenSCAD 对比：fresh xvfb 3.24 s/150 MiB，但项目用共享 Xvfb 并文档化“~300 ms/帧”；也就是说
  **Workbench 四视图与现有链路同量级，Cycles 材质图慢约一个数量级**。

### 3. 与常驻 worker 的兼容性

| 项 | 实测/事实 |
|---|---|
| worker 基线 RSS | **36 MiB**（hello 后、ping 后均不变） |
| `import bpy` 后（独立进程实测） | **461 MiB**（相对 worker 基线 +425 MiB 是推断） |
| 渲染时 | 0.66–1.4 GB |
| 线程模型 | Blender Python API 不是线程安全的，`bpy.ops.render.render()` 阻塞；worker 本来就是单线程串行 |
| **stdout** | `bpy.ops.render.render()` 把 `Saved: …`、`Timer …` 写到 **stdout**；而 worker 的 stdout **专门留给 JSON-lines 帧** |

最后一条是硬冲突：在 `worker.py` 里 `import bpy` 再渲染，会把非 JSON 行混进协议流，host 侧
`PythonWorker.ingest()` 会解析失败。可行做法只有两种：

1. **专用 bpy 子进程**（推荐）：独立进程、独立 stdout，host 用文件/退出码收结果；多一个进程生命周期
   和超时管理。
2. **fd 级重定向**：在每次 bpy 调用前后 `dup2` 把 fd 1 指到 stderr；C 库缓冲与异常路径都要兜住，
   脆弱且难测。

再叠加 +425 MiB 常驻内存（worker 用于所有几何工具），**“把 bpy 放进现有 worker”不成立**。

### 4. 平台矩阵

项目当前 7 个目标；bpy 5.2.3 只发 4 个 wheel：

| 项目目标 | bpy 5.2.3 | Blender CLI 5.2.3 | Blender CLI 4.5 |
|---|---|---|---|
| linux-x64-gnu | ✅ manylinux_2_28 | ✅ | ✅ |
| linux-arm64-gnu | ❌ | ❌ | ❌ |
| linux-x64-musl | ❌ | ❌ | ❌ |
| linux-arm64-musl | ❌ | ❌ | ❌ |
| darwin-arm64 | ✅ | ✅ | ✅ |
| darwin-x64 | ❌ | ❌ | ✅ |
| win32-x64 | ✅ | ✅ | ✅ |

- bpy 5.2.3 / CLI 5.2.3 都是 **3/7**；CLI 4.5 因仍发 macOS x86_64 而是 **4/7**。
- bpy **4.5 要求 Python 3.11**，与运行时 3.13 不兼容；不能靠“装旧 bpy”补 macOS Intel。
  CLI 4.5 没有这个问题（它用自己的 Python）。
- **Linux arm64 与 musl 在所有版本都缺**；如果项目要继续承诺这 4 个目标，bpy 不能是“保证可用”的一等能力。
- wheel 是 `manylinux_2_28`（glibc ≥ 2.28）；pbs 解释器本身的 glibc 基线更老。也就是说会出现
  “Python 能跑、bpy 装不上”的发行版（CentOS 7 / Debian 9 一类），需要额外的平台门与话术。
- 官方 Blender 5.2.3 构建同样只有 linux-x64 / macos-arm64 / windows-x64/arm64；**bpy 的 wheel 矩阵
  不是打包疏忽，而是 Blender 5.x 的官方平台矩阵**。换 CLI 不会自动多出 Linux arm64/musl。

### 5. 许可

- PyPI metadata：bpy 5.2.3 `License: GPL-3.0`；wheel 的 `dist-info` 里**没有** license 文件。
- Blender 本身是 GPL-2.0-or-later；bpy 是 Blender 作为 Python 模块的产物，按 GPL 处理。
- 项目是 Apache-2.0，且 `docs/THIRD-PARTY-AUDIT.md` 的结论是“本项目自身不含任何 GPL/AGPL/LGPL 代码”，
  并把 OpenSCAD 的 GPL-2.0 归为“**独立程序调用，非链接**”。
- **bpy 打破的正是这条边界**：`import bpy` 是进程内链接，不是独立程序。按 GPL 的通常解释，
  这会形成结合 work；具体义务（是否必须把插件整体按 GPL-3.0 分发）需要法务裁决，不是工程能拍板的。
- 如果只是用户在 overlay 里自己装、项目不分发，风险话术与“运行期由用户获取”相近；但
  `python_runtime action=install` 是插件主动安装，**“不分发”的辩护会变弱**。
- CLI 路径把许可边界留在进程外，和 OpenSCAD 同构；若随插件分发 Blender 快照，仍需履行 GPL 的
  源码提供义务，但不牵连插件自身代码。

### 6. 工程接线估算

> 人日是按代码面估算的，**未实施**；用于比较量级，不是承诺。

| 路线 | 要做什么 | 估算 |
|---|---|---|
| **A. bpy 进锁** | bpy 及其 9 个新依赖进锁与平台 exclude；readiness probe 特判（否则每次 status 都 import bpy）；专用 bpy 子进程 + fd/超时；`render_part`/新工具 + 面板/附件；平台门与话术；许可审计/NOTICE/README；三平台测试 | **7–10 人日** + 持续升级 |
| **B. bpy 走 overlay** | 只加 skill + 示例脚本 + 一条验收；核心代码零改动；明确“用户自装、平台不保证、LLM 需再 `read_image`” | **0.5–1 人日** |
| **C. Blender CLI** | `CAD_BLENDER_BIN`/PATH 探测；固定 studio 场景；`render_part` 加 `engine=blender`（不新增工具，省工具表 token）；OpenSCAD 回退；测试/文档；可选快照下载 | **4–6 人日** |
| **D. headless three.js** | 复用现有 three.js + puppeteer/Chromium 出 PBR 图；不引 GPL；但多一个 Chromium 运行时 | **5–7 人日**（未实测，仅作备选） |

A 的隐藏项：按现有惯例，bpy 还要进 `LOCKED_IMPORTS`（否则 readiness 不校验它）。该 probe 会 import 每个锁定包；
bpy 一进锁，**每次 `python_runtime status`/provisioning 自检都会多 0.4 s 和 340–460 MiB 的瞬时峰值**，
除非专门为它开一个“不 import 的版本检查”特例。这又是一个
“锁里多一个包”之外的接线点。

## 分析

### 为什么“性能”不是问题

2026-09 的直觉是“bpy 重、启动慢”。实测不成立：`import bpy` 0.37–0.48 s；Workbench 四视图 1.3 s；
Cycles 512 四视图 4.4 s。**bpy 的运行时性能与 CLI 同级**，且比 fresh-xvfb 的 OpenSCAD 单帧还快。
所以“接不接”不应该由渲染速度决定。

### 为什么“进锁”仍然贵

把 bpy 当运行时依赖，等于同时买了五样东西：

1. **+1.3 GB 磁盘 / +403 MB 下载**，所有用户都付，哪怕从不渲染；
2. **4/7 平台缺口**，且 Linux arm64/musl 不是“少个可选功能”，是这些目标上艺术渲染直接不可用；
3. **GPL-3.0 的进程内链接**，与项目现有 Apache-2.0 + “无 GPL 代码”的审计结论冲突；
4. **Python 3.13 死绑定**：bpy 5.2 要求 `==3.13.*`，项目未来升 3.14 要等 Blender 发 cp314 wheel；
5. **worker 协议冲突**：stdout 被 bpy 写日志，必须另起进程，+425 MiB 常驻内存不能进现有 worker。

这五项里，只有第 1 项能靠“懒安装”缓解；2–5 都跟着“bpy 是运行时依赖”这个身份走。

### 四条路线的成本对比

| 路线 | 用户代价 | 项目代价 | 平台 | 许可 | 适合 |
|---|---|---|---|---|---|
| bpy 进锁 | +403 MB 下载 / +1.3 GB 盘 / 首装 +1–3 min | 7–10 人日 + 持续升级 | 3/7 | GPL-3.0 链接，需裁决 | 必须“纯 Python、无外部程序”且接受以上 |
| bpy overlay | 用户自己装 ~1 GB | 0.5–1 人日 | 3/7，用户自担 | 用户自装，项目不分发 | 让 LLM 偶尔写 bpy 脚本；不是一等能力 |
| Blender CLI | 0（已装）或可选 ~1 GB 快照 | 4–6 人日 | 3/7（5.2）/ 4/7（4.5 mac x64） | 独立进程，同 OpenSCAD | 一等艺术渲染，且不想动 Python 锁 |
| headless three.js | Chromium ~150–300 MB | 5–7 人日 | Linux/Windows/macOS（Chromium 可用处） | MIT/BSD | 只要 PBR 预览、不要 Cycles 级真实感 |

### 建议

1. **现在不要把 bpy 加进 `PACKAGES`/`python-lock.ts`。** 渲染速度不是理由，1.3 GB + 4/7 + GPL +
   3.13 绑定才是成本。
2. **若只是想让 LLM 试试 bpy**：走 overlay + skill（B）。用现成的
   `python_runtime action=install packages:["bpy==5.2.3"]`，在 skill 里写清平台、1 GB 体积、
   “出图后要再 `read_image`”的用法。**不要承诺平台支持**。
3. **若艺术渲染要成为一等能力**：走 CLI（C），不要 bpy。理由是同脚本同耗时、许可边界干净、
   不受 Python 3.13 绑定；用 `render_part` 的 `engine=blender` 而不是新增工具，省工具表 token。
   优先支持 Blender 4.5 LTS（覆盖 macOS Intel）与 5.2 LTS（新特性），只在用户请求时出 1 张 hero，
   **不要**把 Cycles 塞进每次 `generate_part`；几何判读继续用 Workbench/OpenSCAD 四视图。
4. **若只是要“更好看的预览”而不是 Cycles 级真实感**：先评估 headless three.js（D），它复用现有
   前端栈、无 GPL、平台覆盖最好；代价是 Chromium 运行时与 5–7 人日。
5. **需要用户拍板的两件事**：GPL-3.0 是否可接受；是否接受 Linux arm64/musl 上艺术渲染不可用。
   这两件不是工程能自行决定的。

### 什么会推翻本报告

- bpy 发布 **cp314 + linux-arm64 + musllinux** wheel，且许可裁决通过 → 平台与 Python 绑定两条主要
  成本消失，A 路线可重估；
- 实测证明 bpy 能在 worker 内安全重定向 stdout，且增量 RSS < 100 MiB → worker 冲突论点减弱
  （但安装/许可/平台成本不变）；
- CLI 在目标机器上不可用或版本漂移导致维护成本高于 bpy → C 的推荐需重审；
- 艺术图成为核心交付（每次生成都要材质图）→ 13 s/张 × 多轮的成本会压过一切，届时应先优化
  渲染管线（降分辨率/采样、Workbench + 材质近似），而不是选 bpy 还是 CLI。

## 遇到的问题

1. **PyPI 直连停滞**：`pip install bpy` 从 pypi.org 在本机 6 分钟无进展；阿里云 12.7 MiB/s
   30 s 下完。项目的 `PIP_INDEXES` 已经阿里云优先，这条现实与现有决策一致。
   **另一个坑**：bpy 5.2.3 只收 `==3.13.*`；本机系统 `python3` 是 3.14，直接
   `python3 -m venv` 再装会报“no matching distribution”。必须用运行时 3.13.16 建 venv——
   这正是“bpy 把项目钉死在 3.13”的具体表现。
2. **pip 进度不可见**：非 TTY 下长下载没有进度行，看起来像挂死；`python_runtime` 的进度回调只抓
   `Collecting/Downloading/...`，403 MB 的包需要更细的进度或至少“仍在下载”的心跳。
3. **overlay 的依赖噪声**：只把 `bpy` 目录复制到 overlay、不装 `cattrs` 时，`import bpy` 会在
   addon 注册阶段抛 `ModuleNotFoundError`（但 import 仍成功）。正常 `pip install --target` 会带依赖；
   若做“精简 overlay”就会踩到。
4. **headless MESA**：`blender -b` / `import bpy` 都会打 ZINK/EGL 报错到 stderr；Workbench/Cycles
   仍能出图。日志消费者（LLM 或 host）会误判为失败，必须过滤已知行。
5. **单位**：STL 没有单位，Blender 把 mm 当 m。第一版材质图布光按“米”算，直接过曝；把物体缩到
   0.001 后才正常。生产脚本必须做 bbox 归一化，这不是可选优化。
6. **argv 差异**：`blender -b -P script.py -- args` 的 `sys.argv` 含 Blender 参数；模块形态是
   `argv[1:]`。同一脚本要兼容两种入口，必须显式取 `--` 之后。
7. **join 选择**：`bpy.ops.object.select_all(action='SELECT')` 后 join 会报 “No mesh data to join”；
   逐个 `select_set(True)` 仍会报（单对象 join 本来就不需要）。最终改为 `len(objs) > 1` 才 join。
   小坑，但说明“脚本能跑”与“脚本正确”差一层。

## 产物列表

**代码与脚本**（`experiments/20261024_blender_bpy_cost/`）：

- `render_views.py` — 同一份渲染脚本，模块/CLI 双入口；`views` 四视图，`art` 材质 hero
- `measure.py` — wall + 子进程峰值 RSS
- `import_bpy.py` — 只测 `import bpy`
- `worker_rss.py` — 常驻 worker 基线 RSS
- `README.md` — 复现命令与注意事项

**数据**：

- `results.json` — 本报告引用的全部数字
- `bpy-stdout-sample.txt` / `bpy-stderr-sample.txt` — stdout/stderr 分流证据

**输出**：

- `images/workbench-1024-iso.png` — Workbench 1024 轴测
- `images/cycles-512-iso.png` — Cycles 512/32 轴测
- `images/art-1024-iso.png` — Cycles 1024/64 材质 hero
- `images/cli-art-1024-iso.png` — CLI 同场景对照

**运行命令**：

```bash
# bpy 5.2.3 要求 CPython ==3.13.*；系统 python3（3.14）装不上，必须用插件运行时
PY=${DSH_HOME:-$HOME/.dsh}/cad/runtime/venv/bin/python
"$PY" -m venv .tmp-bpy/venv
. .tmp-bpy/venv/bin/activate
pip install --index-url https://mirrors.aliyun.com/pypi/simple bpy==5.2.3

S=examples/microscope4/cad-data/runs/r024/parts/整机.stl
A=experiments/20261024_blender_bpy_cost
python $A/measure.py python $A/render_views.py -- $S $A/out/bpy-wb BLENDER_WORKBENCH 1024 32 views
python $A/measure.py python $A/render_views.py -- $S $A/out/bpy-art CYCLES 1024 64 art
python $A/measure.py blender -b --factory-startup -noaudio -P $A/render_views.py -- \
  $S $A/out/cli-art CYCLES 1024 64 art
```

**环境依赖**：

- CPython 3.13.16（pbs 运行时）；bpy 5.2.3；系统 Blender 5.2.3 LTS
- Linux x64 / 16 核 / 30 GB；RSS 用 Linux `/proc` 与 `RUSAGE_CHILDREN`
- 无法在 Windows/macOS 上复测：平台矩阵结论来自 PyPI wheel 与 Blender 官方构建清单，不是本机实测

## 结论与下一步

> **2026-10-24 补充**：下面的“经济不划算”是针对**进锁/预装**；按场地原则允许用户自装 bpy
> 作为艺术 lane 的成本，见文末补充（必做 L1 3–4 人日，L2+ 可选）。

**结论：bpy 作为运行时依赖是“技术可行、经济不划算”的选项。** 它的运行时成本与 CLI 同级，却多出 1.3 GB 磁盘、
4/7 平台缺口、GPL-3.0 链接边界、Python 3.13 死绑定和 worker stdout 冲突。对“玩具艺术面”这个目标，
外部 Blender CLI 用同一份脚本拿到同样的图，代价是 4–6 人日和一个可选外部程序；bpy 进锁则是
7–10 人日 + 上述五项长期成本。

**下一步（按优先级）**：

1. 若只想验证价值：走 overlay + skill，装 `bpy==5.2.3` 出一张 hero 图，确认“艺术面”是否真的影响
   用户的判断/购买意愿；**不写核心代码**。
2. 若确认要一等能力：实现 `render_part` 的 `engine=blender`（CLI），`CAD_BLENDER_BIN` + PATH 探测，
   OpenSCAD 回退；先支持 4.5/5.2 LTS，不打包快照（用户自装），文档写清平台矩阵。
3. 把“bpy 进锁”留到以下条件同时成立时再评估：bpy 发 cp314 + linux-arm64/musl wheel；
   GPL-3.0 经法务/用户明确接受；平台矩阵缩减到 3 个；艺术图成为核心交付而非可选增强。
4. 无论走哪条，**不要把 Cycles 放进每次 `generate_part`**：13 s/张 × 多轮会拖垮生成循环；
   几何判读用 Workbench 四视图（1.3 s），艺术图按需出 1 张。

---

## 补充（2026-10-24）：自装 bpy 作为“艺术能力拓展”的成本

> 上文的 0.5–1 人日是“只写 skill/示例”的口径；若要把雕塑/艺术/装潢明确为一条**被支持的
> 能力车道**，按本节从 3–4 人日起算。

前提：**不预装、不进锁、不随插件分发**；用户在需要时通过
`python_runtime action=install packages:["bpy==5.2.3"]` 装进 overlay。这样项目不再付
1.3 GB 全员磁盘、平台覆盖承诺和 GPL 分发的成本，但要付“让它成为一条车道”的成本。

### 分层成本

| 层 | 交付 | 人日 | 结果 |
|---|---|---|---|
| **L0 只允许** | 无（现有 overlay 已可用） | 0 | 用户能装，但 LLM 不知道该用；装失败/平台不符时只看到 pip 的原始报错 |
| **L1 允许且说清楚** | skill 决策树 + `render_studio.py` + 1 个雕塑/装潢样例 + acceptance（缺失时清晰报错、有则 64px 冒烟）+ README/DESIGN + 预检 | **3–4** | `run_python` + `read_image` 可用；无新工具 |
| **L2 一等可选工具** | `render_part engine=bpy`（优先）或 `render_art`；检查 overlay、专用子进程、附件、超时、CLI/OpenSCAD 回退 | **+2–3（5–7）** | 工具结果直接出图；UX 完整 |
| **L3 艺术建模 lane** | bpy 建模模板（bmesh/修改器/remesh/布尔）、STL/GLB 导出、`import_part` 回收、可打印性边界、脚本+种子入库、2–3 个装潢/雕塑样例 | **+3–5（8–12）** | bpy 不只是渲染器，而是艺术几何来源 |
| **L4 面板材质预览** | GLB 导出 + client GLTFLoader + 版本产物 | **+2–4（10–16）** | 人在面板里看到材质，不只看 PNG |

### 用户侧成本（自装者付）

- **403 MB 下载 / ~1 GB 磁盘**；镜像 1–2 min，直连可能 10–20 min；`python_runtime` 默认 15 min
  超时，慢网可能失败。
- **0.7–1.4 GB RAM/渲染**；Workbench 四视图 1.3 s，Cycles hero 13 s（16 核；4 核更慢）。
- **平台 3/7**：Linux arm64、musl、macOS Intel 没有 bpy 5.2.3 wheel。macOS Intel 可用同一份
  `render_studio.py` 的双入口，自备 Blender 4.5 跑；Linux arm64/musl 没有官方 Blender 构建。
- **GPL-3.0**；bpy 5.2.3 要求 `Python ==3.13.*`；headless EEVEE 12 s，不可用于 CI。
- **艺术输出不自动等于可打印**：要打印仍需 `import_part` + 水密/壁厚/悬垂检查。

### 为什么 L1 不是 0.5 天

0.5 天只够“写一段 README + 一个示例脚本”。要成为“被支持的车道”，还要：

- **预检**（Python 3.13、平台 wheel、glibc、磁盘）——避免用户下完 403 MB 才失败；
- **冒烟**（`import bpy` + 64px 渲染）——区分“装上了”与“能出图”；
- **缺失时清晰报错**——而不是 pip 的 `No matching distribution`；
- **单位/材质/灯光基线**——否则第一张图过曝，模型会误判“bpy 不行”；
- **验收**（有/无 bpy 两侧）+ 文档。

这些是 2–3 天的增量，所以 L1 是 3–4 天。

### 成本判断

- **只做 L1：3–4 人日**，无锁、无分发、无平台承诺；这是“允许自装 + 明确艺术场景”的最小可用交付。
- **L2：5–7 人日**；如果 `run_python` + `read_image` 的 UX 足够，L2 可以后置。
- **L3：8–12 人日**；只有真实雕塑/装潢项目要求 bpy 生成几何时才做。它引入第二个几何来源、
  版本/可复现性和可打印性边界，已经不是“渲染扩展”。
- **L4：10–16 人日**；GLB/面板是给人看的，优先级低于 L1/L2。

### 与“进锁”的差别

- 省掉 7–10 天锁集成、+1.3 GB 全员磁盘、平台覆盖承诺、GPL 分发裁决、readiness 特判。
- 代价是：艺术 lane 只在 3/7 平台可用；用户自付 ~1 GB；项目要维护 skill/脚本/验收；
  bpy 版本随用户，出问题要先问“你装的是哪个版本”。
- **不改变**“bpy 不能进现有 worker”的事实：L1 用 `run_python` 的每调用一进程；L2 若要常驻/
  工具化，才需要专用子进程管理。

### 按场地原则重评（2026-10-24）

上面的 3–4 / 5–7 / 8–12 / 10–16 是按“能力分层”算的工程账；按场地原则，**必做项只有 L1**，
其余是场地的可选投资，不是产品欠债。

| 场地要素 | bpy 对应 | 是否必做 | 成本 |
|---|---|---|---|
| 厂房/分区 | skill 说明“这是艺术 bay，不是核心几何 lane” | 必做 | 0.5 天 |
| 水（运行时） | overlay 安装、Python/平台/磁盘预检 | 必做 | 1–1.5 天 |
| 电（引擎） | `render_studio.py` 基线；L1 通过现有 `run_python` 的每调用一进程执行（避开 worker stdout） | 必做 | 1–1.5 天 |
| 路（通道） | L1 用现有 `run_python` + `read_image`；L2 才做附件工具 | 必做（用现有路） | 0.5 天 |
| 质检 | render-only 的“图出得来、单位/相机对”；printable 走 `import_part`/`check_printability` | 必做 | 0.5 天 |
| 原材料 | 1 个基线脚本 + 1 个样例；用户可自备 | 必做（各 1 个） | 0.5 天 |
| 更高支持 | L2 工具、L3 模板库、L4 GLB 面板 | 可选 | +2–3 / +3–5 / +2–4 |

**重评后的结论：**

- **必做成本 3–4 人日**，不是 5–7。L2 不是“完成度”的一部分，而是“这条路更好走”的投资；
  L3/L4 同理。场地原则不要求把每个 bay 都做成产品线。
- **平台 3/7 不是产品缺口，是场地条件**：像“这一侧没有接电”一样写在门口；用户可以自备
  Blender CLI（macOS Intel 可自备 4.5）或走 OpenSCAD；Linux arm64/musl 无官方 Blender，需自行
  构建。项目不必为了“产品完整”去补 CLI/arm64/musl 的兜底。
- **用户自备原材料可以补平台**：`render_studio.py` 本来就是双入口（bpy / `blender -b -P`），
  macOS Intel 用户可自备 Blender 4.5 跑同一脚本；项目不必为平台缺口做 CLI 集成。
- **QC 不能省**：render-only 也要有“图出得来、单位/相机对”的最低质检；printable 必须过现有
  真值引擎。否则“质检交付物”的场地承诺不成立；但 QC 不判断创意好坏。
- **原材料不必自建仓库**：一个 `render_studio.py` + 一个样例就够开场；L3 的模板库等真实用户
  提出再做。用户自带脚本/几何是合法输入，只要进场后能验收。
- **“不包打一切”省下的不是 3 天，是平台补齐、CLI 兜底、模板库、GLB 面板这些“产品完整度”
  工作**；它们从“欠债”变成“可选投资”。这正是场地与产品的分界。

### 建议

1. **先做 L1（3–4 天）**，把“允许”升级成“有地图、有基线、有验收”的车道。
2. **L2 只在真实使用中觉得 `run_python` 出图再 `read_image` 太绕时再做**；优先
   `render_part engine=bpy`，不新增工具。
3. **L3 等真实雕塑/装潢项目**；先做 1 个样例，验证“bpy 建模 → STL → import_part → 可打印性”
   闭环，再决定是否扩大。
4. **写死边界**：艺术渲染 ≠ 可打印；平台 3/7；bpy GPL-3.0 用户自装；不把 bpy 加进锁。
5. 方向性决策已按项目纪律补进 `docs/DECISION-LOG.md`（2026-10-24）；**L1 是否落地仍待确认**。

> **2026-10-25 实施**：L1 已落地——`skills/cad-art/`（SKILL + preflight + render_studio）、
> `examples/art-decor-panel/`、`scripts/accept-bpy-art.mjs`。验收在两侧跑过：
> 无 bpy（系统 Python 3.14 + 运行时 3.13；预期 `unsupported-python` / `not-installed`）与
> bpy overlay（`DSH_CAD_USER_SITE` 指向 5.2.3 的 site-packages；64px 四视图 + metadata），
> Blender CLI 双入口也通过。未动锁、未改 worker、未新增工具。

> **2026-10-25 L2 实施**：按“真实 UX 痛点”方案扩展了 `render_part`（不新增工具）：
> `engine=openscad|bpy|auto`、`mode=single|views|hero`、材质/背景/采样/曝光/灯光；已保存版本的图
> 作为 attachment 直接返回，不再需要 `read_image`；`auto` 只在 bpy 缺失/运行时未就绪时对
> single/views 回退 OpenSCAD，hero 与 section 不做静默降级。验收：无 bpy 侧（OpenSCAD
> single/views、自动回退、hero 拒绝、4 attachment）与 bpy overlay 侧（bpy views/hero、4/1
> attachment + metadata）均通过；工具数仍 28。

> **2026-10-25 真实 overlay 全链路（提交 8ef3588 之后）**：不是临时 site-packages。
> 用 `python_runtime action=install` 的同一实现 `installIntoPythonOverlay(["bpy==5.2.3"])`
> 把 bpy 装进 `$DSH_HOME/cad/runtime/user-site`（**996 MB**；bpy 5.2.3 LTS、Python 3.13.16；
> overlay 的 numpy 2.5.4 被锁定的 2.5.3 shadow）。`skills/cad-art/preflight.py --json`
> 返回 `status: ready`。
>
> 在真实 runtime/overlay 上执行 `render_part`：
> `engine="bpy", mode="views", imgSize=512` → 4 个文件 / 4 个 attachment；
> `mode="hero", samples=32` → 1 个文件 / 1 个 attachment，metadata
> `bbox_mm = 240×160×14`、`bpy_version = 5.2.3 LTS`、Cycles **1.98 s**。
> 工具代码、`runPython` 子进程、`render_studio.py`、PNG 都是真实路径。
>
> **边界（诚实标注）**：当前会话不是「造物模式」，工具表里没有 `render_part`，所以
> attachment sink 用本地文件记录，而不是 DSH 的真实 attachment 服务；真实 tool result
> 的 1/4 张 image block 走的是既有 `render_part` 管道（L2 只改了后端与返回字段）。
> 若要做“在造物模式 UI 里让 Agent 自己点一次”，需要另开 CAD 预设会话；本轮未起。
