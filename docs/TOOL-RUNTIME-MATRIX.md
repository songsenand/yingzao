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
实测冷启动（本机，2026-10-08）：解释器本身 **11 ms**；`import numpy, scipy` 后 **~80 ms**；
再算上 manifold3d/trimesh/scikit-fem 的导入，**每次调用起一个新进程 ≈ 0.1–0.3 s**。
`measure_distance` 这类毫秒级工具，冷启动会把它放大 10–100×——那就是"负收益"，
但它**只是时序问题**：常驻 worker 把每次调用压到 IPC 量级（~ms）之后，这条理由消失。
⇒ **batch 0 = worker + JSON-lines**，它是"能迁就迁"的开关，不是可选项。

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
| 12 | `measure_closest` | 最近点/最小间隙 | schema | **P（条件）** | 需要 Python 空间索引：`rtree`/`embree`，或 manifold 自带距离查询；**先验证再迁** |
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

## 3. 明确不做（②类，逐条给理由）

| 项 | 为什么是负收益 |
|---|---|
| 面板/回放/缩略图/版本列表的 HTTP 路由 | 逐请求热路径；数据是磁盘 JSON，TS 直读即可，引入 IPC 只会变慢、变脆 |
| 图片窗口与裁剪策略 | DSH 平台事件（`IMAGE_OFFLOAD_REQUIRED` 等），Python 够不着 |
| usage 遥测 | `llm/stream` 宿主钩子 |
| `recall_reference_image` | DSH attachments 是平台 API |
| darwin-x64 的物理 | 用户已拍板：该平台继续用 TS（无 wheel） |
| 任何工具在 **worker 落地之前**的迁移 | 冷启动 0.1–0.3s 会把小工具全部变成负收益；这是时序问题，不是结论 |

## 4. 两个结构性裁决（比单个工具更重要）

**Q1：领域数据归谁？** `parts/versions/runs/assembly.json` 现在是 TS 代码 + 磁盘 JSON。
- 方案 A：Python 拥有领域存储，TS 只代理（彻底；但面板路由要么走 worker，要么继续读文件）
- 方案 B：**文件即契约**（schema 固定，两侧读写；TS 路由直读文件）← **建议 B**
  理由：面板保持零 IPC，迁移可以**逐工具**进行，不必一次性搬存储。

**Q2：物理 canonical 是否随迁？** Python 的 `rapier3d` 是同一 Rust 内核的官方绑定，
但版本是 0.36，TS 侧是 `rapier3d-compat` 0.20——**换边要重新定基线**（TS 侧现有
17/17 + 24/24 验收）。
- 方案 A：canonical 随迁 Python（darwin-x64 例外）——符合"Python 第一语言"，但要重跑物理基线
- 方案 B：canonical 留 TS，Python 只做交叉验证（现状）

## 5. 批次（batch 0 是前提）

| 批次 | 内容 | 解锁什么 |
|---|---|---|
| **0** | 常驻 worker + JSON-lines 协议（§12.3）+ 冷启动前后对照 | 让"能迁就迁"成立 |
| 1 | 纯计算域：`simulate_fluid`、FEM（工具化）、`measure_*`、`check_*` | 收益最大、无 UI 耦合 |
| 2 | 生成/渲染/导入/合并的领域部分（1、4、5、6、13） | 领域代码集中到 Python |
| 3 | 存储与装配清单（取决于 Q1） | 收尾 |
| 条件 | `measure_closest`（空间索引验证）、`simulate_physics`/`simulate_motion`（Q2） | 验证/裁决后进批次 |

## 6. 单个工具"迁移完成"的定义

1. **工具名不变**，模型无感（`run_python` 才是开放场地，工具是窄接口）；
2. 领域逻辑在 `python/cad_worker/`，TS 侧只剩 schema + 转发；
3. **有前后对照**：同输入同输出 + 耗时对比，写进验收脚本；
4. 现有验收（`scripts/accept-*.mjs`）更新并通过；
5. canonical 归属在决策记录里写明（Q2 裁决后）。
