# 执行摘要：00-smoke 判据驱动迁移到新工具表

## 动机
> 2026-10-10 ~ 10-12 的测量能力批次把工具表从 20 件改组（`measure_closest` +
> `measure_distance` → 合并进 `measure_gap`；`check_connectivity` + `measure_extent`
> → 合并进 `measure_part`），但仪器校准脚本 `bench-smoke.mjs` 没有跟上，
> 跑到第 5 步直接崩溃（`tool measure_distance not registered`）。
> 按 README §7"仪器发红时先修仪器"，本次把三处调用迁到新 API。
> **判据 id 与期望值一个不动**——判的东西一样，只是调用方式换了。

## 影响范围
> - `examples/bench/graders/00-smoke/bench-smoke.mjs`（三处工具调用 + 步骤文案）
> - `examples/bench/graders/00-smoke/rubric.json`（仅 `c-measure-close` /
>   `c-connectivity` 两条 desc 文案里的工具名，判据结构不变）
> - `examples/bench/README.md`（§7 校准命令补 `DSH_CAD_PYTHON_ROOT` 说明——沙箱/隔离
>   HOME 下运行时指向已 provision 的 runtime）

## 具体操作步骤
> 1. `bench-smoke.mjs` 步骤 5：`measure_distance({versionId, aPoint, bPoint})`
>    → `measure_gap`（同名参数；输出 `distanceMm`/`aSnapDistanceMm`/`bSnapDistanceMm`
>    均保留，见 tools.ts:2560 迁移注释）
> 2. `bench-smoke.mjs` 步骤 6：`measure_closest({aVersionId, bVersionId})`
>    → `measure_gap`（输出 `pointA/pointB/method` 不变）
> 3. `bench-smoke.mjs` 步骤 7：`check_connectivity({versionId})`
>    → `measure_part`，读 `bodyVerdict`/`bodies`/`bodyCenters`（tools.ts:2539-2542）
> 4. rubric.json 同步两条 desc 里的工具名

## 预期风险与验证
> - 风险点：`measure_gap` 的 point/pair 端点拼写混用会显式拒绝（v1 设计）；
>   步骤 5/6 各自只用一种拼写，不受影响
> - 测试方式：`DSH_CAD_PYTHON_ROOT=<workspace runtime 副本> node
>   examples/bench/graders/00-smoke/bench-smoke.mjs`，13 硬门 + 6 数值判据全绿
