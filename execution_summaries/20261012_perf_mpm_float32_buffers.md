# 执行摘要：MPM 内核内存/性能重写（float32 + 复用缓冲）——顺带修好 fluid-sign，fluid 转为 canonical

## 动机
> 用户问：①"simulate_fluid 需要有这么大的 cache 么？必须的么？"②"accept-fluid-sign 不对拍的原因需要找到"。
> 两问指向同一件事：内核的内存与数值精度。实测发现 **941 MB 峰值**（状态只有 68 MB）——于是重写。

## 影响范围
> - `dsh-cad-harness/python/cad_worker/worker.py`：重写 `_mpm_step_once` + 新增 `_mpm_scratch`/`_weights32`；
>   粒子状态改 float32（与 TS 的 `Float32Array` 一致）；网格质量/动量保持 float64（与 TS 一致）
> - `dsh-cad-harness/src/host/fluid.ts`：**默认走 Python canonical**（`DSH_CAD_FLUID_PYTHON=0` 才回 TS oracle）
> - `dsh-cad-harness/src/host/mpm.ts`：`jitter` 加诊断幅度开关（`CAD_MPM_JITTER_AMP`，仅诊断）
> - 文档：矩阵 row 16 与批次 4、DESIGN §26.4

## 具体操作步骤（内存去哪了 + 怎么改）
> 剖析（564k 粒子、24×24×100 网格）：**状态 68 MB，峰值 941 MB** —— 差额全是我实现的临时数组：
> 每个 tap 新建 `contribution(n,3)`、`dist(n,3)`、`weight(n)`、**int64 的 (n,3) 扁平索引及其 ravel 拷贝**（约 59 MB/tap × 27 tap），
> 外加 `B(n,3,3)` 与 `stress(n,3,3)` 各 40 MB、`C_new` 再 40 MB。**这些都不必要**。
> 改法：① 粒子状态与临时量 **float32**（TS 正是 Float32Array）；② **按轴 (n,) 散射**，不再构造 (n,3) 索引；
> ③ **秩 1 累加** B（9 个 (n,) 分量）替代 (n,3,3)；④ 每世界**复用 scratch 缓冲**（网格数组 `fill(0)` 复用）。

## 预期风险与验证
> - **内存**：564k 粒子尺度峰值 **941 MB → 229 MB（4.1×）**，1927 → 1124 ms/step；
>   工具尺度（26,923 粒子、52³ 网格）**峰值 21.1 MB / RSS 58.3 MB、77.7 ms/step**，状态仅 1.6 MB。
> - **数值反而更准**：`accept-mpm-parity` 逐粒子漂移 **9.8e-6 → 1.9e-6 格（9.5e-7 mm）**，因为 float32 与 TS 同型。
> - **性能**：真实工具场景 **7.2× → 4.22×**（600 步、26,923 粒子：TS 5.9 s vs Python 24.7 s）。
> - **`accept-fluid-sign` 的根因找到了**（详见下）：**不是逻辑错误**，而是"每步 ~1e-6 的数值差 + 投影×入口正反馈"
>   被放大成 20% 的宏观差。证据链：步数 10/30 两侧计数器**逐位相同**（入口 band/floored/injected、投影 inside/killed、avgV）；
>   约 100 步开始分叉；**去掉入口后 600 步两侧又一致**（0.5018 vs 0.5226）。改成 float32 后差异缩小到带内 ⇒
>   **`accept-fluid-sign` 在 Python 路径 16/16 通过**。
> - **canonical 切换验证**：`accept-m4` 默认路径 PASSED、`DSH_CAD_FLUID_PYTHON=0`（TS）PASSED、
>   `accept-fluid-sign` 默认路径 **OK (16 passed)**；`accept-mpm-parity` 全过；`tsc` 干净。
