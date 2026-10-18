# 执行摘要：修复 run_python / python_runtime / measure_section 工具输出校验失败

## 动机
> 2026-10-14 沙箱实测 bench 试卷（见 `experiments/20261014_bench_sandbox_run.md`）时，
> 考生（glm-5.3-flash）的 `measure_section` 连试 3 次全部失败、`run_python` 连
> `print("hello")` 都失败。根因调查（子代理全程定位）发现两处 SUT 缺陷：
>
> 1. **lossless-JSON 检查拒收 undefined 值键**：框架（dsh-tools
>    `createSuccessResult` → `snapshotToolValue` → `walkJsonValue`）在校验 schema
>    **之前**就检查 execute 返回值，任何值为 `undefined` 的属性都算"有损"直接拒绝。
>    `python-tools.ts` 里 `exitCode ?? undefined` 这类写法在健康机器上也会产出
>    undefined 键（成功运行时 signal=null、traceback=null），所以 run_python /
>    python_runtime **每次调用必挂**。76 行注释写的就是"omitted, not null"——
>    意图正确，`?? undefined` 实现错了。
> 2. **measure_section 输出 schema 漏声明 `voidRegions`**：worker 两条路径都返回
>    该字段（worker.py:2170/2308），schema `additionalProperties: false` 未列 →
>    每次调用被 `value.voidRegions is not a declared property` 拒绝。测量批次回归。

## 影响范围
> - `dsh-cad-harness/src/host/python-tools.ts`：run_python 的 execute 返回值、
>   statusFields（修好 python_runtime）
> - `dsh-cad-harness/src/host/tools.ts`：MeasureSectionSolve 接口 + 输出 schema 补
>   `voidRegions`（integer, required）
> - 重建 `lib/index.js`（esbuild.mjs）；重跑 00-smoke 验证

## 具体操作步骤
> 1. `statusFields`：7 个 `?? undefined` 全部改为条件展开（真缺席键）；
> 2. run_python execute：先把三个可空字段从 `...result` 解构剔除，再按值存在与否
>    条件展开（`...result` 自身携带的 null 值键会被 schema 的
>    `type: integer/string` 行拒绝，必须剔除）；
> 3. schema/接口补 `voidRegions: number`（语义：截面内非材料封闭环数；
>    材料多边形数 + voidRegions = 切割找到的环总数）。

## 预期风险与验证
> - 风险点：tsc 通过；run_python 的 schema 字段本就全部声明（可选），无需改 schema；
>   durationMs 无 NaN 风险（`||` 兜底）。
> - 测试方式：① 00-smoke 全绿（它驱动 run_python 相关工具链）；② 真实 headless
>   会话让模型调 `run_python code=print('hello')` 与 `measure_section` 复测；
>   ③ 重跑 06-measure 看 `g-no-invented-numbers` 是否转好。
> - 评测纪律：SUT 变更 → 历史分数不可比（README §2）；测量批次后基线本就待重跑，
>   本次修复随该批次一并纳入。
