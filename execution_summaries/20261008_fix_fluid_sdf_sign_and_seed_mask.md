# 执行摘要：修复流体 SDF 的符号判据与种子掩码

## 动机
> 用户要求修复一个已在两处影响判分的插件侧问题：`00-smoke` 记录的"厚壁到达率
> 0.93→0.097"，以及 `02-steam-engine` 首轮 `c-fluid-arrival` 的 FAIL
> （0.3554 vs 判据 >0.6）。按"先怀疑仪器"的纪律复现后确认为插件缺陷：
> **厚壁下 `solidMask` 是反的**，且种子只查距离、不查掩码。

## 影响范围
> - `dsh-cad-harness/src/host/sdf.ts`（符号探测 + 新增 `solidMaskAt`）
> - `dsh-cad-harness/src/host/fluid.ts`（种子查掩码 + `metrics.seedStats`）
> - `dsh-cad-harness/scripts/accept-fluid-sign.mjs`（**新增回归钉子**）
> - `DESGIGN.md` §24、`examples/bench/graders/README.md` §九、
>   `experiments/20261008_simulate_fluid_thick_wall_sign_bug.md`
> - `lib/`（`node esbuild.mjs` 重建；**SUT 加载的是它，不是 `src/`**）

## 具体操作步骤
> 1. **插桩定位**：照抄 `sdf.ts` 建 BVH 的方式，从壁内点打三条轴射线并打印命中。
>    得到 `+x 命中 2 次 distances=[50.0,50.0]`——**同一次穿越被相邻两个三角形各记
>    一次**，因为出口点正落在盖面三角剖分的共享棱上（`face 415`/`face 500` 共有棱
>    `(50,15,0)–(50,30,0)`）。网格轴对齐、接缝也在网格平面上 ⇒ 系统性失效。
> 2. **`sdf.ts`**：三条探测方向改为**互不平行且避开坐标轴**（`SIGN_RAYS`）；
>    命中的**同距离重复计数去重**（一次穿越算一次）；仍取"≥2 条奇数"多数判定。
>    头注释与模块注释同步。
> 3. **`sdf.ts`**：导出 `solidMaskAt()`（最近格吸附；0/1 掩码不能插值）。
> 4. **`fluid.ts`**：`seedPositions` **先查 mask 再查距离**，并把拒绝原因分开计数；
>    返回 `{seeds, rejectedWall, rejectedSolid}`。
> 5. **`fluid.ts`**：`metrics.seedStats = {accepted, rejectedWall, rejectedSolid,
>    solidFraction}`——把"种子区域里金属占多少"暴露给调用方，不再沉默浪费。
> 6. **新增钉子** `scripts/accept-fluid-sign.mjs`：三种壁厚下的腔心/壁内符号、
>    穿透为 0、种子记账、以及"同内腔不同壁厚到达率跨度 < 0.15"。
> 7. `node esbuild.mjs` 重建 bundle。

## 预期风险与验证
> - **风险点 1：改动影响所有流体/物理仿真。** 符号判据与掩码是 `mpm.ts` 的直接输入。
>   **验证：全套 `accept-*` 26/26 通过**（含新增的那个），无连带回归。
> - **风险点 2：只改源码不改 bundle。** 上一轮就栽过——`00-smoke` 校准的是**发货
>   产物** `lib/index.js`，而 BOSL2 修复当时只在 `src/` 生效。
>   **验证：`node esbuild.mjs` 重建后断言 `lib/index.js` 含新符号。**
> - **风险点 3：把"修复"做成"又一次改数值"。** 我**没有**顺手改种子区域推导
>   （那是独立的一次数值变更，会再次移动基线）。本次只修正确性：
>   符号 + 掩码 + 可观测性。区域问题写进 §24.4 待独立验证。
> - **风险点 4：拿旧结果当新结论。** 修复改变了工具行为 ⇒ **修复前的 02 流体结果
>   已失效**，已在三处文档显式标注"需重跑"。
> - **验证数据**：
>   | | 修复前 | 修复后 |
>   |---|---|---|
>   | Ø60 / Ø100 壁内符号 | +6.75 / +16.75 · mask 0 | **−6.75 / −16.75 · mask 1** |
>   | 穿透（Ø60 / Ø100） | 970 / 1964 | **0 / 0** |
>   | 同内腔只改外径的到达率跨度 | 0.443–0.7568（0.32） | 0.6739–0.7568（**0.08**） |
> - **附带**：跑 accept 套件会改写 `dsh-cad-harness/data/` 下三个**已入库**的夹具
>   （`accept-assembly.mjs` 把它当版本库），提交前已 `git restore --staged
>   --worktree` 还原。该 wart 已记在 `graders/README.md` §九。
