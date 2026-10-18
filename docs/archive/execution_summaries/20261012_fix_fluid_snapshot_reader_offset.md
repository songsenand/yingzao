# 执行摘要：修掉流体快照读取的 offset 漏项（00-smoke 抓到；accept-m4 补上完整性判据）

## 动机
> 用户要求"在沙箱中测试 `examples/bench/graders/00-smoke/`"。这是**仪器校准**级：无 LLM，
> 由脚本驱动工具各一次，13 硬门 + 6 数值。**第一次跑就崩在步骤 17（`simulate_fluid`）**：
> `RangeError: offset is out of bounds at bin.set(snap.posMm, 0)`（回放帧缓冲溢出）。

## 影响范围
> - `dsh-cad-harness/src/host/fluid.ts`：`readSnapshotFile` 的 speed 切片（Python 快照读取路径）
> - `dsh-cad-harness/scripts/accept-m4.mjs`：新增快照完整性判据（4 条）

## 具体操作步骤
> 1. **定位**：用 `runFluid` 分别走 TS 与 Python 两条路径打印快照数组长度 ⇒
>    TS `972/324`（=3n/n，正确），Python `972/0`（speed 恒为空）。把 Python 侧快照文件
>    抓下来做字节级解析：文件本身**完全正确**（8×{16B 头 + 972×4 pos + 324×4 speed} = 41612B，
>    恰好消费完）⇒ 问题在读侧。
> 2. **根因**：`readSnapshotFile` 里 speed 切片的**末端漏了累计偏移 `offset`**：
>    `slice(byteOffset + offset, byteOffset + n * 4)`。第一个快照起 `offset` 就已大于 `n*4`
>    ⇒ 切片为空（首个快照也只是被截短），于是 speed 长度恒为 0 ⇒ 回放缓冲 `Float32Array(4*n)`
>    的 `bin.set(posMm, 0)` 溢出。改为 `byteOffset + offset + n * 4`。
> 3. **补判据（覆盖洞）**：`accept-m4` 一直请求快照（snapshotCount 2/4）却只查 `metrics`，
>    从不看快照内容 —— 所以这个缺陷在全部验收里都是绿的。新增 4 条：
>    快照条数、`posMm.length === 3 × speedMmPerSec.length`、速度非空且有限、位置在网格范围内。

## 预期风险与验证
> - **风险点**：快照数组同时喂"渲染帧"与"回放帧"，长度错位会静默产出空/错帧，指标全绿。
> - **验证**：修复后两条路径均为 `972/324`；`accept-m4` **PASSED**（含新增 4 条判据）；
>   `tsc --noEmit` 干净；重建 bundle 后重跑 **`00-smoke` 全绿**：
>   **13/13 硬门 + 6/6 数值**，工具调用 31/60、图片 43/48、墙钟 **64.1s/1800s**，
>   结果写入 `examples/bench/graders/00-smoke/scores/smoke-2026-10-09T14-58-59-994Z.json`。
> - **为什么此前没发现**：单元级 parity 验收普遍用 `snapshotCount: 0`；`accept-m4` 请求了快照
>   但不校验内容。这一级"仪器校准"存在的意义正在于此 —— 它抓到的是一个**插件侧真缺陷**，
>   而不是模型能力问题。
