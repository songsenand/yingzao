# 实验报告：`list_features` 在大网格上 24–43s 的根因定位与修复

## 目标

回答 2026-10-11 记下的那条未修风险——"`list_features` 在 11–21MB 网格上单次 24–43s；
按版本缓存只解决重复调用，首次调用仍昂贵"——**时间到底花在哪**，并据此把首调成本降下来。

## 假设

先验猜测（写下来是为了能被推翻）：

- H1：大头在 `trimesh.load` 解析 11–21MB 二进制 STL。
- H2：大头在 `mesh.facets`（共面三角形聚类）这类 O(n log n) 的网格遍历。
- H3：大头在**逐孔射线探深**（`withHoleDepth` 默认开，每个孔一次 `_ray_spans`）。

## 方法

工具：`cProfile` + 自写探针 `experiments/scripts/probe_list_features_perf.py`（直接调
`worker.op_list_features`，绕开 host 侧的 JSON/IPC，把 worker 内部成本单独暴露出来）。

对照组：探针带 `--legacy`，把 2026-10-13 之前的两条代码路径**原样装回去**——

1. `_watertight_bad_edges` 用 `np.unique` + `np.isin` 的旧实现；
2. `_mesh_watertight` 退化成"每次调用都重算"（即 `_ray_spans` 每孔重算一次）。

这样 before/after 由同一脚本、同一台机器、同一份 fixture 测得，不引用别处的历史数字。

夹具：项目自己的语料 `examples/microscope2/cad-data/versions/` 下 4 个真实零件，
覆盖"三角形多但孔少"与"孔多"两类：

| fixture | 大小 | 三角形 | 孔 |
| --- | --- | --- | --- |
| v015 | 11.61MB | 232,166 | 2 |
| v023 | 11.10MB | 222,056 | 50 |
| v029 | 17.49MB | 349,834 | 2 |
| v036 | 21.50MB | 430,064 | 39 |

环境：numpy 2.5.3 / trimesh 5.1.1 / cpython 3.13.16，运行时装在 `~/.dsh/cad/runtime/venv`。

## 结果

### 1. cProfile：57s 里有 51s 花在同一个函数上（v036，21.50MB）

修复前，`op_list_features` 墙钟 **56.45s**（profiler 开销在内）：

```text
ncalls  tottime  cumtime  function
    40    0.288   50.863  worker.py:577(_watertight_bad_edges)     ← 严格水密测试
    39    0.004   50.936  worker.py:1789(hole_depth)               ← 每个孔一次
    39    0.004   50.935  worker.py:1170(_ray_spans)
   201   42.657   42.657  numpy .../_unique_hash                   ← numpy 哈希路径
    40    0.405   24.760  numpy .../_isin
   243    6.410    6.410  numpy ndarray.sort
   975    0.040    1.466  worker.py:1215(probe)                    ← 真正在打射线：1.5s
```

`_is_watertight` 被调 **40 次**（39 个孔 + op 自己 1 次）。`_ray_spans`（`worker.py:1212`）
每次都重新问一遍"这个网格水密吗"，而这个问题只看 `mesh.faces`，与射线无关。
**射线本身只花了 1.5s；剩下 50s 是把同一个问题问了 40 遍。**

### 2. 微基准：这两个 numpy 原语走的是哈希路径

1,290,192 个 int64 键（= 430k 三角形 × 3）：

| 调用 | 耗时 |
| --- | --- |
| `np.unique(a)` | **765.1 ms** |
| `np.unique(a, return_counts=True)` | 59.6 ms |
| `np.sort(a)` | 55.4 ms |
| `np.isin(x, y)`（两个 1.29M 数组） | **750–1539 ms** |
| `np.searchsorted(sorted_y, x)` | **26.5 ms** |

`np.unique` 不带 `return_counts`、以及 `np.isin`，都走 numpy 的哈希路径。
同一条规则用"排序 + 二分"表达，快 **10–28×**。

### 3. 修复后：同一夹具 66.7s → 4.5s

探针 `--no-profile` 直接调 op（首次调用记为 cold，同进程第二次为 warm）：

| fixture | legacy cold | legacy warm | new cold | new warm | 提速（cold） |
| --- | --- | --- | --- | --- | --- |
| v036 21.50MB / 39 孔 | 66.68s | 65.99s | **4.54s** | 4.12s | **14.7×** |
| v023 11.10MB / 50 孔 | 36.29s | 38.76s | **3.03s** | 2.61s | **12.0×** |
| v029 17.49MB / 2 孔 | 5.81s | 5.86s | 3.17s | 2.70s | 1.8× |
| v015 11.61MB / 2 孔 | 4.05s | 4.18s | 2.34s | 1.90s | 1.7× |

**成本与孔数成正比，与三角形数几乎无关**：v029 三角形更多（349,834 vs 222,056）但只有 2 个孔，
legacy 5.81s；v023 孔有 50 个，legacy 36.29s。这直接印证了"逐孔重算水密性"是主因。

### 4. 修复后的剩余成本（v036，分阶段实测）

| 阶段 | 耗时 |
| --- | --- |
| `trimesh.load` | 0.750s |
| `mesh.facets`（50,193 个共面区域） | 0.413s |
| `mesh.facets_boundary` | 0.964s |
| `_mesh_watertight`（现在只算 1 次） | 0.162s |
| 射线探深（975 条射线 = 39 孔 × 25） | ~1.5s |

剩下的是 trimesh 自己的共面聚类 / 边界环 / 射线求交，**没有第二个 50s 级的病灶**；
若要再往下压，是另一个量级的问题（换后端/降采样），不在本轮范围。

### 5. 正确性对照

新旧 `_watertight_bad_edges` 在 17 个用例上**逐值一致**（0 处不一致）：闭合 box、缺一面、
翻一面、三角形重复、圆柱 `$fn=32`、icosphere、单三角形、退化三角形、空面集、
"两面共边"、6 组随机三角形集、以及真实 11.6MB 网格 v015。
`_is_watertight` 的布尔结论同步一致（对照实现保存在探针脚本的 `install_legacy_paths()` 里）。

## 分析

- **H1、H2 被推翻**：load 0.75s、facets 0.4s，都不是瓶颈。
- **H3 被推翻但接近真相**：瓶颈确实在 `withHoleDepth` 这条路上，但不在"打射线"，而在
  **射线路径上的前置检查**——每个孔都要重算一次严格水密性。孔数决定成本，这解释了此前
  观察里"10–21MB 之间耗时可以从 2.9s 跳到 42.8s"的不规律：决定因素是孔数，不是体积。
- 两处修复都没有语义分歧：一处是"同一问题问了 40 遍"（改成每个 mesh 只问一次），
  一处是"用了最贵的原语实现同一条规则"（改成排序 + 二分）。所以是纯成本修复，
  不需要新的决策权衡——但它产出了一条**后续纪律**，已记入 DECISION-LOG。

## 遇到的问题

1. **历史数字与本次"legacy"数字对不上**（记下来，避免误读）：
   2026-10-11 记录 v036 = 42.79s、v023 = 23.57s；本轮同夹具 legacy 测得 66.68s / 36.29s。
   两次不是同一条测量路径（前者经 host 工具层含 IPC，后者直接调 op；且机器负载不同），
   所以**本报告的结论只用同脚本的 legacy↔new 对照**，历史数字仅作旁证。
2. `v036` 的网格**不水密**（`_mesh_watertight` 返回 False），所以该 op 会带 warning 返回。
   不影响本次结论（水密性与否都要算，且算一次即可）。
3. 修复前 `_ray_spans` 是**每个孔**重算，而 `measure_thickness` 是**每条射线**重算——
   后者本轮一并受益，但没为它单独跑基准（同一条代码路径，收益方向一致）。

## 产物列表

**代码与脚本：**

- `experiments/scripts/probe_list_features_perf.py` —— 本实验的探针。默认 cProfile 排序输出；
  `--no-profile` 走 cold/warm 计时；`--legacy` 装回旧实现做对照（含正确性对照用的旧函数）。
- `dsh-cad-harness/python/cad_worker/worker.py` —— 被修的实现：
  `_watertight_bad_edges`（排序 + `searchsorted`）、新增 `_mesh_watertight`（每 mesh 一次）、
  `_ray_spans` / `op_list_features` / `op_measure_thickness` 改走缓存版。

**数据：**

- 夹具即项目语料，未复制：`examples/microscope2/cad-data/versions/{v015,v023,v029,v036}/model.stl`
  （11.10–21.50MB）。均为已保存版本，不可变。

**输出：**

- 无落盘产物；表格中的数字直接来自下方命令的标准输出。

**运行命令：**

```bash
P=~/.dsh/cad/runtime/venv/bin/python
V=examples/microscope2/cad-data/versions

# 修复后：分阶段画像 + cold/warm
$P experiments/scripts/probe_list_features_perf.py $V/v036/model.stl
$P experiments/scripts/probe_list_features_perf.py $V/v036/model.stl --no-profile

# 修复前（同一脚本装回旧实现）
$P experiments/scripts/probe_list_features_perf.py $V/v036/model.stl --no-profile --legacy

# 其余三个夹具同理，替换 $V/vXXX
```

**环境依赖：**

- python 3.13.16（`~/.dsh/cad/runtime/venv`），numpy 2.5.3，trimesh 5.1.1，scipy。
- 依赖锁：`~/.dsh/cad/runtime/requirements.lock`（仓库内为 `python/requirements.lock`）。
- 无需 GPU；纯 CPU，单线程。

**复现步骤：**

1. 确认 venv 存在：`~/.dsh/cad/runtime/venv/bin/python -c "import trimesh"`。
2. 按上面命令逐条跑；`--legacy` 与不带 `--legacy` 的输出并排即得第 3 节的表。
3. 正确性对照：探针脚本 `install_legacy_paths()` 内的 `legacy_bad_edges` 就是参照实现，
   逐用例比较 `worker._watertight_bad_edges(faces)` 与它即可（本轮 17/17 一致）。

## 结论与下一步

- 结论：`list_features` 大网格首调昂贵的根因是**逐孔重算严格水密性 × numpy 哈希路径**，
  两处修掉后 21.50MB / 39 孔零件从 ~40–66s 降到 **4.5s**（同脚本对照 14.7×）。
  2026-10-11 记录的那条风险**已消解**。
- 下一步（未做，按价值排序）：
  1. `accept-p3` / `accept-connectivity` / `accept-list-features` 回归已跑（见执行摘要）；
  2. 若还要再压剩余 ~4.5s，瓶颈转回 trimesh 的 `facets_boundary`（0.96s）与 975 条射线
     （1.5s）——前者可缓存，后者可降探针环数，但都需先问"精度是否还够"。
  3. `withHoleDepth=false` 在只需要孔位时是零成本开关，工具描述里已声明"默认 true（一孔一射线）"，
     数字更新后该默认值可以重新评估。
