# 执行摘要：MPM 内核 numba 探针（性能测量）

## 动机
> `simulate_fluid` 的 Python MPM 内核比 TS 慢 5–7×，原生内核已被判定为该工具的实际必需项
> （THIRD-PARTY-AUDIT A1、TOOL-RUNTIME-MATRIX §7）。用户拍板先试 numba，并以本次实测的
> 基线数据对比其真实收益，用数据决定是否采纳。

## 影响范围
> - 新增 `experiments/scripts/probe_numba_mpm.py`（探针：基线 + numba 移植 + parity + 计时）
> - 新增 `experiments/scripts/mpm_numba_kernel.py`（worker `_mpm_step_once` 的 numba 移植，探针专用）
> - 新增 `experiments/20261014_numba_mpm_probe.md`（实验报告）
> - 新增 `experiments/scripts/probe_mpm_ts_ref.mjs`（TS 内核同场景参照计时）
> - **不改动**：`python/cad_worker/worker.py`、`requirements.lock`、`src/host/**` 生产路径

## 具体操作步骤
> 1. 建 scratch venv（插件自带 CPython 3.13），阿里云镜像装 numba（含 llvmlite），不进生产 lock。
> 2. 基线：进程内直接 import `worker.py`，用 `op_mpm_create` 建同样的管道场景
>    （100×24×24 网格、入口驱动 + 回收），直接调 `_mpm_step_once` 计时
>    （预热 5 步 + 计时 50 步，粒子阶梯 ≈11.5k / 92k / 268k / 737k）。
> 3. numba 版：把 P2G 两遍 bincount 散射、密度/应力、G2P 27-tap 收集移植为 @njit 核
>    （P2G 串行保持散射语义，G2P prange 并行；网格更新与驱动暂留 numpy），同场景计时。
> 4. parity：同一初始世界分别跑 numpy 版与 numba 版 30 步，
>    对比最大位置漂移、transits/escaped/nonFinite、无 NaN。
> 5. TS 参照：`createMpmWorld` 同场景计时，刷新 2026-10-08 的 TS 基线。

## 预期风险与验证
> - 风险：numba 移植与原内核浮点求和顺序不同 → 数值微小分叉。验证：parity 容差断言 +
>   宏观指标（transits/穿透）一致；精确逐位 parity 不作为本探针目标（报告如实记录差异量级）。
> - 风险：numba 对 numpy 2.x 的 API 支持差异。验证：scratch venv 内先 `import` 冒烟再跑。
> - 风险：计时受机器负载扰动。验证：每档预热后取中位数；同机同场景三方对比，不跨机比较。
> - 生产路径零改动 → 现有验收（`accept-m4`、`accept-fluid-sign`）不受影响，无需重跑。
