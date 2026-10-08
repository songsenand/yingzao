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
| 1 | `generate_part` | SCAD 预置（datum 模块、BOSL2 路径）、编译调用与结果解析、版本落盘 | schema、四视图附件 | **P** | OpenSCAD 仍是外部二进制，Python 一样调 |
| 2 | `create_part` | 零件命名/唯一化 | schema | **P** | 小 |
| 3 | `set_datums` | datum 读写 | schema | **P** | 小 |
| 4 | `import_part` | STL 解析、单位/水密/焊接、datum 归一化、版本落盘 | schema、渲染附件 | **P** | numpy 解析比 JS 快 |
| 5 | `merge_parts` | Manifold 布尔 | schema、渲染附件 | **P** | Python 侧 `manifold3d` 是**同一个 C++ 内核**，不丢性能 |
| 6 | `validate_assembly` | 干涉/间隙/包围盒/渲染编排 | schema、图片附件 | **P** | 同上 |
| 7 | `check_assembly` | 接口契约判定、距离查询 | schema | **P** | 纯领域规则 |
| 8 | `check_connectivity` | 连通分量/壳数 | schema | **P** | numpy/trimesh |
| 9 | `check_printability` | 壁厚/悬垂（可顺带从采样升级为精确） | schema | **P** | 精度是附带收益 |
| 10 | `measure_part` | 体积/质心/惯性/包围盒 | schema | **P** | manifold3d + trimesh |
| 11 | `measure_distance` | 点/球距离 | schema | **P** | 依赖 batch 0（否则冷启动负收益） |
| 12 | `measure_closest` | 最近点/最小间隙 | schema | **P** | 已实测：加 `rtree` 后 0.61 ms/点（TS 的 three-mesh-bvh 是 0.02 ms/点，慢 30×）**但精度完全一致（Δ=0 mm）**，200 点 122 ms 可接受 ⇒ 可迁；代价是锁里加 `rtree 1.4.1`（七平台全有 py3 wheel，无需编译器） |
| 13 | `render_part` | 渲染调用、视图拼接 | schema、图片附件 | **P** | |
| 14 | `simulate_physics` | 场景构建、报告 | schema | **待裁决** | ③ canonical：Python 绑定是 0.36，TS 是 0.20，数值可能微差；darwin-x64 必须 TS（已拍板） |
| 15 | `simulate_motion` | 同上 | schema | **待裁决** | 同上 |
| 16 | `simulate_fluid` | MPM 内核 + SDF 场 | schema | **P** | 收益最大（实测 564k 粒子 600 步 114s） |
| 17 | `recall_reference_image` | —（查 DSH 附件） | 全部 | **T** | 这是平台 API，不是领域 |
| 18 | `delivery_audit` | 交付规则、文件与网格核对 | schema | **P** | |
| 19 | `run_python` | 已落地 | — | 已落地 | |
| 20 | `python_runtime` | 已落地 | — | 已落地 | |

**非工具车道**：体素 FEM（现为 `scripts/probe-*.mjs`，手写 matrix-free CG）→ **P + 工具化**，
实现直接落 Python/scikit-fem（已在锁里）。

## 3. "明确负收益"的实测判定（2026-10-08）

v2 初稿凭直觉列了三条"负收益"，用户要求**用数据说话**。实测结果**推翻了其中两条**，
详见 `experiments/20261008_python_migration_measurements.md`：

| 我原先的说法 | 实测 | 判定 |
|---|---|---|
| 每次调用起新进程 = 0.1–0.3 s，小工具负收益 | 全工具集冷启动 **443.7 ms**；常驻 worker 往返 **0.02 ms** | ✅ **成立，但解法是 worker**，不是保留 TS |
| `measure_closest` 没有 Python 空间索引 → 负收益 | 无索引 4.6–7.1 ms/点（慢 224–350×）；**加 rtree 0.61 ms/点（慢 30×）**；精度 **Δ=0 mm**；200 点共 122 ms | ❌ 撤回：可接受，代价是加 `rtree` |
| 面板载荷/渲染图片过 IPC → 负收益 | 34 KiB 面板载荷 **0.25 ms**（直读磁盘 0.9 ms）；178 KiB 图片 **0.82 ms** | ❌ 撤回：传输从来不是瓶颈 |

**因此当前没有任何工具因性能被排除在 Python 之外。** 仍然保留 TS 的只有：

| 保留项 | 理由类别 | 具体依据 |
|---|---|---|
| 工具 schema 与注册、预设可见性过滤 | ① 平台接线 | `ctx.tools.register` 是宿主进程内服务 |
| 图片附件与裁剪策略 | ① 平台接线 | `ctx.attachments.saveImages(...)` 只能在宿主调用（tools.ts）；图片**必须**经它交付 |
| HTTP 路由、面板、回放 | ① 平台接线 | `connection.fetch.register` / `connection.rpc.intercept` 在宿主进程内（index.ts） |
| 会话/项目路径解析、usage 遥测 | ① 平台接线 | 读的是 DSH 会话与 `llm/stream` 钩子 |
| `recall_reference_image` | ① 平台接线 | DSH attachments API |
| darwin-x64 的物理 | ③ canonical | 用户已拍板：无 wheel，该平台继续用 TS |

> ① 类不是性能问题，是 **API 边界事实**（跨进程够不着），所以它不需要 benchmark，
> 需要的是代码位置作证。② 类才是要数字的，而目前 **② 类为空**。

## 4. 两个结构性裁决（比单个工具更重要）

**Q1：领域数据归谁？** `parts/versions/runs/assembly.json` 现在是 TS 代码 + 磁盘 JSON。
- 方案 A：Python 拥有领域存储，TS 只代理（彻底；但面板路由要么走 worker，要么继续读文件）
- 方案 B：**文件即契约**（schema 固定，两侧读写；TS 路由直读文件）← **建议 B**
  理由：面板保持零 IPC，迁移可以**逐工具**进行，不必一次性搬存储。

**Q2：物理 canonical 是否随迁？—— 用户裁决：方案 A（随迁 Python，darwin-x64 例外）。**
Python 的 `rapier3d` 是同一 Rust 内核的官方绑定（TS 侧是 `rapier3d-compat` 0.20，
Python 侧 0.36），**换边必须重跑物理基线**（TS 侧现有 17/17 + 24/24 验收）。

## 5. 批次（batch 0 是前提）

| 批次 | 内容 | 解锁什么 |
|---|---|---|
| **0** | 常驻 worker + JSON-lines 协议（§12.3）；验收写进"worker 往返 < 1 ms、冷启动 400+ ms"这对数字 | 让"能迁就迁"成立 |
| 1 | 纯计算域：`simulate_fluid`、FEM（工具化）、`measure_*`（含 `measure_closest` + `rtree`）、`check_*` | 收益最大、无 UI 耦合 |
| 2 | 生成/渲染/导入/合并的领域部分（1、4、5、6、13） | 领域代码集中到 Python |
| 3 | 存储与装配清单（Q1=B：保持"文件即契约"） | 收尾 |
| 4 | 物理随迁（Q2=A）：`simulate_physics`/`simulate_motion` 换 Python `rapier3d`，**重跑物理基线**；darwin-x64 永远走 TS | canonical 换边 |

## 6. 单个工具"迁移完成"的定义

1. **工具名不变**，模型无感（`run_python` 才是开放场地，工具是窄接口）；
2. 领域逻辑在 `python/cad_worker/`，TS 侧只剩 schema + 转发；
3. **有前后对照**：同输入同输出 + 耗时对比，写进验收脚本；
   对照口径见 `experiments/20261008_python_migration_measurements.md`（E1 冷启动/worker、
   E2 最近点、E3 面板载荷、E4 图片载荷）；
4. 现有验收（`scripts/accept-*.mjs`）更新并通过；
5. canonical 归属在决策记录里写明。
