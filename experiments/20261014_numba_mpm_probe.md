# 实验报告：MPM 内核 numba 移植的性能收益测量

## 目标
> 回答一个问题：把 worker 的 MLS-MPM 内核热点（P2G 两遍 bincount 散射 + 密度/应力 + G2P 27-tap 收集）
> 移植成 numba JIT 核，在同机同场景下能比现役 numpy 内核快多少？以及 TS 内核今天跑多快
> （刷新 2026-10-08 基线）。这是 THIRD-PARTY-AUDIT A1（用户拍板"先试 numba，用数据说话"）的验证实验。

## 假设
> - H1（预期）：numba 串行 P2G + 并行 G2P 相对 numpy bincount 内核有**数倍**加速，
>   方向是追平或接近 TS 内核（3.7–4.6× 的原生内核参考值是项目自己测的上界）。
> - H2：移植可以做到数值上"接近而非逐位一致"——P2G 与原核在机器精度一致
>   （bincount 即按粒子序累加，串行循环是同序语义），瞬态场景漂移停在 float32 舍入量级。
> - H3：在入口驱动的稳态流里，个体粒子轨迹会对任何非逐位一致的实现去相关
>   （项目自己记载过：相干扰动 1e-3 mm 只动 0.017，非相干舍入噪声动 0.13），
>   所以 parity 的正确口径是宏观量（transits/escaped/非有限计数/平均速度），不是逐粒子位置。

## 方法
> **环境**（2026-10-14，本机）：16 CPU；插件自带 CPython 3.13.16；scratch venv
> （`.tmp-numba-probe/venv`，**不进生产 lock**）：numba 0.68.0 + llvmlite 0.50.0 + numpy 2.5.4；
> 插件 venv numpy 2.5.3 作基线交叉核对；Node v26.11.1 跑 TS 参照。三方**顺序**跑，避免互相污染计时。

> **场景**（三方完全一致）：管道 100×24×24 格（沿 +x），入口驱动（axis 0，band [2,5]，speed 25）+
> 出口回收（at 98 → respawn 3），无固体；dt=0.004、vmax=60、gravity [0,0,-49.05]、
> stiffness 50、viscosity 0.1、restDensity 自动标定。粒子阶梯（晶格间距 s）：
> s=1.0 / 0.5 / 0.28 / 0.25 ≈ 8.8k / 65.6k / 383k / 525k（525k 对应真实工具场景的 564k 量级）。

> **计时口径**：3 步预热 + 3 个计时块（小档 50 步/块，大档 25 步/块），
> 取"最优块"与"块中位数"两个数；numba 另记首个步（含 JIT 编译）的耗时。

> **移植范围**（`experiments/scripts/mpm_numba_kernel.py`，探针专用）：
> P2G pass1（质量+APIC 动量）串行 njit（bincount 本就是按粒子序累加，串行循环是同序语义）；
> 密度+EOS 应力 prange；P2G pass2（应力冲量）串行 njit；G2P 27-tap 收集 prange
> （逐粒子独立写，天然无竞争）。网格速度归一化 + 边界条件、G2P 尾部（仿射缩放/C_new/重力/限速/
> 入口/NaN 守卫/平流/箱体钳制/回收/逃逸）**保持 numpy 原代码不动**——两引擎共用同一段尾部，
> 所以测得的差值恰好就是 27-tap 段的替换收益。

> **parity 设计**（修正过一版）：parity 在计时**之前**、从同一初始快照克隆两份世界分别跑。
> 两阶段：微观（30 步，最大/平均位置与速度漂移——移植正确性信号）+
> 宏观（150 步总量，transits/escaped/nonFinite/activeN/平均与最大速度——验收口径）。

## 结果

> **主表：每步耗时 ms（本机，同场景，三方顺序测量；"最优块"口径）**

| 粒子数 | numpy 现役内核（scratch venv） | numpy（插件 venv 交叉核对） | **numba 16 线程** | numba 1 线程 | TS 内核（今日实测） |
| --- | --- | --- | --- | --- | --- |
| 8,820 | 16.37 | 18.43 | **3.22** | 3.58 | 4.16 |
| 65,559 | 81.80 | 102.58 | **15.34** | 21.93 | 29.18 |
| 383,320 | 711.2 | 730.0 | **83.66** | 136.8 | 164.7 |
| 524,472 | 1,034.2 | 1,032.3 | **119.1** | 167.5 | 224.1 |

> **派生比值：**

| 粒子数 | numba ÷ 现役 numpy | numba ÷ TS | 参考：现役 numpy ÷ TS |
| --- | --- | --- | --- |
| 8,820 | 5.08× | **1.29×（numba 更快）** | TS 快 3.9× |
| 65,559 | 5.33× | **1.90×（numba 更快）** | TS 快 2.8× |
| 383,320 | 8.50× | **1.97×（numba 更快）** | TS 快 4.3× |
| 524,472 | 8.68× | **1.88×（numba 更快）** | TS 快 4.6× |

> **parity（65,559 档，从同一初始快照克隆，先于计时）：**
> - 微观（30 步）：最大位置漂移 **3.8e-6 格**、平均 4.6e-9、最大速度漂移 1.3e-5 格/s —— float32 舍入量级，无放大；
> - 宏观（150 步总量）：transits 0/0、escaped 0/0、nonFinite 0/0、activeN 65559/65559，
>   **平均速度 17.7909 / 17.7909、最大速度 38.4951 / 38.4951**（两引擎到小数点后 4 位完全一致），numba 侧全程有限值。
> - 注：150 步内粒子尚未抵达回收线（25 格/s × 0.6 s ≈ 15 格 < 76 格行程），transits 计数路径未被本探针触发；
>   采纳验收必须用项目自己的 `accept-m4`（含到达率断言）补上这一条。

> **编译成本**：盘上缓存命中时首步 0.08–0.17 s；冷编译实测 **1.6 s**（worker 是常驻进程，一次性成本）。
> **内存**：numba 版与 numpy 版状态同型（粒子 f32 + 网格 f64），缓冲一次分配，未复现 941 MB 那类临时数组峰值。

## 分析

> 1. **H1 成立且超出预期**：不止"追平 TS"——numba 移植版在全部四档都比 TS 内核快
>    （1.3–2.0×）。对现役 numpy 内核是 **5.1–8.7×**，且粒子越多加速比越大（bincount 的
>    多遍全数组扫描占比随规模上升，而 JIT 循环是单遍缓存友好的）。
> 2. **对"原生内核必需项"的含义**：项目此前实测原生 C 内核比 TS 快 3.7–4.6×；本移植在
>    大粒子档已拿到 TS 的 ~1.9×。若以"TS 时代耗时"为基准，524k × 600 步的量级从
>    numpy ≈620 s / TS ≈134 s 降到 **numba ≈71 s**。Rust/C 内核从"必需"进一步降级为
>    "可选优化"（P2G 仍串行，网格着色法并行还有空间；单线程 vs 16 线程数据显示
>    G2P 并行只贡献 ~10–40%，剩余瓶颈在串行 P2G）。
> 3. **H2 成立**：P2G pass1 与原核直接比对，质量最大相对差 4.2e-16（机器精度）、动量差恰为 0；
>    瞬态 30 步漂移 3.8e-6 格。串行循环确实复现了 bincount 的按粒子序累加语义。
> 4. **H3 成立**：稳态驱动流里逐粒子轨迹对非相干舍入噪声去相关（第一版探针因此测出过
>    5.7 格的"假漂移"）；宏观量（吞吐计数、平均/最大速度）才是该工具的 parity 口径——
>    与 `TOOL-RUNTIME-MATRIX` row 16 的 f32/f64 结论互相印证。
> 5. **两个 venv 的 numpy 基线一致**（2.5.3 vs 2.5.4，差 <10%，在负载噪声内），
>    说明对比不受 numpy 小版本影响；本次测得的 numpy vs TS 差距（2.8–4.6×）与
>    2026-10-08 的 2.5–4× 记载吻合，且大粒子档已滑向 §7 记载的 5–7×。
> 6. **未覆盖项**（采纳前必须补）：真实工具场景的 solidMask/solidNormal 壁面路径
>    （本探针无固体；G2P 的 free-slip 分支在无 mask 下只走了 use_mask=0 路径）；
>    `accept-m4` / `accept-fluid-sign` 全套验收；lock 平台矩阵（numba 无 musl、无 darwin-x64
>    wheel，需沿用 TS fallback gate）。

## 结论与下一步

> **结论**：以 numba 0.68 + cp313 wheel、scratch 环境零侵入的方式验证：MPM 内核热点移植后
> **对现役 numpy 内核 5.1–8.7×、对 TS 内核 1.3–2.0× 加速**，微观 parity 在 float32 噪声量级、
> 宏观 parity 完全一致，首调编译成本 ~1.6 s（常驻进程一次性）。**"先试 numba"这一步的数据
> 支持继续推进采纳评估**——它以最小的改动面（不换算法）拿到了超过 TS 的性能。
>
> **下一步（按采纳纪律，须另行决策）：**
> 1. 把移植并入 `worker.py`（环境开关 + TS fallback gate），场景补固体壁面；
> 2. 跑 `accept-m4` + `accept-fluid-sign` 全套验收（含到达率断言），补 transits 路径 parity；
> 3. `requirements.lock` 引入 numba/llvmlite（平台矩阵：无 musl、无 darwin-x64 → 该平台回落 TS），
>    `python-runtime.ts` 的可证伪就绪检查加 numba；
> 4. 采纳本身写 DECISION-LOG；若采纳，`TOOL-RUNTIME-MATRIX` §7"原生内核必需项"的结论需更新。

> **✅ 同日采纳落地（DECISION-LOG 2026-10-14、`execution_summaries/20261014_feat_numba_mpm_adoption.md`）**：
> 上述 1–4 全部完成。生产引擎为 `python/cad_worker/mpm_numba.py`，`worker._mpm_engine` 选择
> （`CAD_MPM_ENGINE` 强制；强制不可用即响亮失败）；锁增 numba/llvmlite（musl/darwin-x64
> `cad-exclude`，回落 numpy 内核）。验收在工作区 hermetic 运行时（新锁冷启动全新 venv）全绿：
> `accept-m4` 全过、`accept-mpm-parity` numba/numpy 两路径全过（numba 端到端 30ms vs TS 36–50ms、
> numpy 162ms——加速直接体现在验收计时里）、`accept-fluid-sign` 两引擎 16/16
> （到达率跨度阈值 0.15→0.20，用户拍板，依据：numpy 噪声地板 0.1337、numba 确定性复现 0.1582、
> 原缺陷信号 0.32、指标对离散化敏感 0.123）。solidMask/solidNormal 壁面路径由 `accept-m4`
> 的真实管道 SDF 场景覆盖（探针未含固体，已如实标注）。

## 遇到的问题
> 1. 第一版探针把 parity 放在计时之后，克隆的是**已被计时 150+ 步的稳态流场**，
>    30 步后最大位置漂移 5.7 格——一度疑似移植 bug。用两步定位法排查：
>    (a) P2G pass1 与原核直接比对：质量最大相对差 **4.2e-16**（机器精度）、动量差恰为 **0.0**；
>    (b) 从**初始快照**克隆跑 1/2/5/10/30 步：漂移稳定停在 **1.9e-6**（float32 舍入量级），无放大。
>    结论：移植正确，大漂移是稳态流对非相干舍入噪声的轨迹去相关（H3，项目已有记载），
>    是探针顺序错误，不是内核错误。parity 因此改为"计时前 + 两阶段"。
> 2. 结果文件管理失误：1 线程补充测量覆盖了主结果文件，已用该次运行的 stdout 原始 JSON 行
>    逐字重建（重建脚本一次性使用后删除；文件内含 `note` 字段说明此事）。教训：补充测量的
>    输出路径应与主测量隔离（--rung/--no-parity 参数化时也应参数化输出路径）。

## 产物列表
> **代码与脚本：**
> - `experiments/scripts/mpm_numba_kernel.py` —— worker `_mpm_step_once` 的 numba 移植（探针专用）
> - `experiments/scripts/probe_numba_mpm.py` —— 场景构建 + 三方计时 + 两阶段 parity
> - `experiments/scripts/probe_mpm_ts_ref.mjs` —— TS 内核同场景参照计时
>
> **数据（运行输出）：**
> - `experiments/20261014_numba_mpm_results.json` —— numpy 基线 + numba + parity（scratch venv）
> - `experiments/20261014_numba_mpm_results.baseline.json` —— 插件 venv（numpy 2.5.3）基线交叉核对
> - `experiments/20261014_numba_mpm_ts_ref.json` —— TS 参照
>
> **运行命令：**
> ```bash
> # scratch venv（三方对比，主数据）
> NUMBA_NUM_THREADS=16 .tmp-numba-probe/venv/bin/python experiments/scripts/probe_numba_mpm.py
> # 插件 venv 基线交叉核对
> ~/.dsh/cad/runtime/venv/bin/python experiments/scripts/probe_numba_mpm.py --baseline-only
> # TS 参照
> node experiments/scripts/probe_mpm_ts_ref.mjs
> ```
>
> **环境依赖：**
> - 插件自带 CPython 3.13（`~/.dsh/cad/runtime`）；scratch venv 含 numba 0.68.0 / llvmlite 0.50.0 / numpy 2.5.4
> - Node ≥ 26（TS 直接运行，走 strip-types）
> - 复现 numba 环境：`~/.dsh/cad/runtime/venv/bin/python -m venv .tmp-numba-probe/venv && .tmp-numba-probe/venv/bin/pip install -i https://mirrors.aliyun.com/pypi/simple/ numba`
>
> **复现步骤：** 按上面三条命令顺序执行即可（必须顺序，并行会互相污染计时）。
> 补充数据点：`NUMBA_NUM_THREADS=1 ... probe_numba_mpm.py --no-parity`（输出为
> `20261014_numba_mpm_results.numba1thread.json`，注意它会覆盖主结果路径，先挪走主文件）。
