# 执行摘要：simulate_fluid 缺陷定位并修复——**SDF 实体掩码从未进入 MPM 网格更新**

## 动机
> 上一轮把 `simulate_fluid` 运行环接进 worker 后，高密度场景出现**系统性输运不足**
> （38,394 粒子到达率 0.098，TS 是 0.8643），当时**没有发布**，而是把 Python 路径退到
> `DSH_CAD_FLUID_PYTHON=1` 之后。本轮定位并修复，Python 成为 canonical。

## 影响范围
> - `dsh-cad-harness/python/cad_worker/worker.py`：
>   - `op_fluid_run`：**把 SDF 的 `solidMask`/`solidNormal` 装进世界**（这就是根因）
>   - 新增 `_ipc_uint8`：JSON 管线里 `Uint8Array` 会变成 `{"0":1,...}`，必须还原
>   - `op_mpm_create` 用 `_ipc_uint8` 接收掩码
> - `dsh-cad-harness/src/host/fluid.ts`：默认走 Python（`DSH_CAD_FLUID_PYTHON=0` 才回 TS oracle）；
>   保留 `CAD_FLUID_NO_PROJECT=1` 诊断开关；顶部注释记录这次的教训
> - `dsh-cad-harness/scripts/diag-fluid-projection.mjs`（新增诊断：投影开/关对拍）
> - 文档：矩阵 row 16、DESIGN §26.4

## 具体操作步骤
> 1. **二分**：先怀疑 SDF 投影，于是给两侧都加"跳过投影"的诊断开关，同一个 200 步场景四组对拍。
>    结果**关掉投影后仍然分歧**（TS avgV 11.8 vs py 16.0；maxV 214.8 vs 73.2）⇒ 投影不是（唯一）根因。
> 2. **按特性二分内核**（新增 `bisect`）：plain / +inlet / +mask / +inlet+mask。`+mask` 直接**报错**：
>    `int() argument must be ... not 'dict'` —— **JSON 没有 typed array**，`Uint8Array` 过管道后是
>    `{"0":1,...}`。
> 3. **根因**：`op_fluid_run` 收到了 SDF 文件（含掩码），但**只把它用于投影与近表面带，
>    从未装进 MPM 世界**。于是整场运行**没有任何壁面边界条件**：网格更新不会把壁面格的法向速度归零、
>    G2P 也不会把壁面格排出插值 —— 流体直接漏进壁里。低密度时投影单独还能把粒子大致挡在管内
>    （所以 case 1 只差一点），高密度时完全失控（0.098 vs 0.8643）。
> 4. 修复：`world["solidMask"] = sdf["solidMask"].astype(bool)`、`solidNormal` 同理，
>    在 `op_mpm_create` 之后立刻装配；同时加 `_ipc_uint8` 让掩码能过 JSON 管道。

## 预期风险与验证
> - **验证（`DSH_CAD_FLUID_PYTHON=1` 与**默认**各跑一次 `accept-m4`，均全过）**：
>   | 用例 | Python | TS canonical | 阈值 |
>   |---|---|---|---|
>   | case 1 直管（11,799） | 到达率 **0.7968**，出口 step 229 | 0.72 | ≥0.7 ✓ |
>   | case 1b 直管（38,394） | **0.8488** | 0.8643 | ≥0.75 ✓ |
>   | case 2 密封腔沉降 | avgV **2.2 mm/s** | 7.7 | <25 ✓ |
>   | case 3 90° 弯管 | **0.7054** | 0.63~0.7423 | ≥50% ✓ |
>   不变量（穿透 0／守恒 0／不分叉）与分速带流全部通过。
> - **教训（已写进矩阵与 DESIGN）**：
>   1. 内核级 parity **没有覆盖实体掩码**（parity 的配置里没有掩码）——"逐特性二分"才是定位手段。
>   2. **不变量是必要不充分**：壁面全丢的情况下穿透=0、守恒=0、不分叉**全都成立**，
>      **只有到达率这类"输运量"断言才抓得住"根本没有墙"**。
>   3. JSON 管线**没有 typed array**：`Uint8Array` → `{...}`，边界上必须显式还原。
> - **性能仍在**：case 1b 129 s vs TS ~25 s（≈5×），工具 300 s 预算下余量已不多；
>   原生 Rust/C 内核（比 TS 快 3.7–4.6×）仍是该工具的实际必需项。
> - 回归：`accept-m4` PASSED（默认路径）、`accept-fluid-sign`、`accept-mpm-parity`、
>   `accept-tool-scope`、`tsc` 均通过。
