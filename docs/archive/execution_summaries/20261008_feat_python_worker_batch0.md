# 执行摘要：Python 常驻 worker（batch 0）+ rtree 进锁

## 动机
> 判据「对 LLM，Python 是第一语言，能迁的默认迁 Python」已经过用户确认，但迁移有个
> 前提一直没落地：**每次工具调用起一个新 Python 进程要 443.7 ms**（全工具集已导入），
> 而常驻 worker 的往返只要 **0.02 ms**。用户 2026-10-08 拍板「batch 0 开工」，同时批准
> `rtree 1.4.1` 进锁（`measure_closest` 迁移的实测前提）。
>
> 本摘要按 AGENTS.md 要求补写：改动已随实验推进完成，此处如实记录范围与验证。

## 影响范围
> - `dsh-cad-harness/python/cad_worker/worker.py`（新增）
> - `dsh-cad-harness/src/host/python-worker.ts`（新增 `PythonWorker` / `ensurePythonWorker` 等）
> - `dsh-cad-harness/package.json`（`files` 加 `python/`）
> - `dsh-cad-harness/scripts/gen-python-lock.mjs` + `src/host/python-lock.ts`（加 `rtree`）
> - `dsh-cad-harness/scripts/accept-python.mjs`（依赖数 7 → 8）
> - `dsh-cad-harness/scripts/accept-python-worker.mjs`（新增验收）
> - `HARNESS.md §12.3` / `DESGIGN.md §26.4` / `docs/DECISION-LOG.md` / `docs/TOOL-RUNTIME-MATRIX.md`
> - **未受影响**：所有既有工具实现（`tools.ts` 等一行未动）；`run_python` / `python_runtime` 行为不变。

## 具体操作步骤
> 1. 新增 `python/cad_worker/worker.py`：常驻 worker，hello 带 `protocolVersion` 与 ops；
>    帧 `{id, op, params}` → `{id, ok, result}` / `{id, ok:false, error, traceback}`；
>    v1 ops = `ping` / `versions` / `stl_stats` / `closest_points` / `crash`；
>    **大载荷走文件路径**（点集 `.f64` 进、距离与最近点 `.f64` 出），诊断一律走 stderr。
> 2. 修改 `src/host/python-worker.ts`：新增 `PythonWorker` 类（id 关联、超时即判死、
>    崩溃/退出时拒绝所有挂起请求）、`ensurePythonWorker()`（进程内单例 + 崩溃重启）、
>    `resolveWorkerScript()`（源码 `<plugin>/src/host` 与打包 `<plugin>/lib` 两种深度）、
>    `workerScratchDir()`。注意**不用 TS 参数属性**——Node 的 strip-only 类型擦除不支持它。
> 3. 修改 `package.json`：`files` 加 `"python/"`，否则打包后 worker 不存在。
> 4. 修改 `scripts/gen-python-lock.mjs`：加 `rtree 1.4.1` 并重新生成 `python-lock.ts`；
>    同步 `accept-python.mjs` 的依赖数与导入检查。
> 5. 新增 `scripts/accept-python-worker.mjs`：八组断言（握手/延迟/依赖/按文件载荷与数值一致/
>    traceback/kill 后重启/并发串行/打包）。
> 6. 同步文档：`HARNESS.md §12.3`、`DESGIGN.md §26.4`、`docs/DECISION-LOG.md`、
>    `docs/TOOL-RUNTIME-MATRIX.md`（batch 0 标已落地、批次表重排）。

## 预期风险与验证
> - **风险点 1：worker 崩溃把插件带崩。** 处理：`fail()` 拒绝全部挂起请求并标记死亡，
>   `ensurePythonWorker()` 下次调用重新拉起；验收里 kill -9 后重启通过（pid 17 → 48）。
> - **风险点 2：并发工具调用在单线程 worker 里排队导致超时。** 处理：不隐藏这个事实，
>   验收显式断言串行（116 ms → 230 ms），写进 HARNESS/DESIGN 让宿主把排队算进超时；
>   超时的请求直接判死并重启，避免复用"半个 worker"。
> - **风险点 3：大载荷走 pipe 拖慢或撑爆缓冲区。** 处理：按文件传参/回传，并与 TS 结果对拍；
>   验收断言返回字节数（1600 + 4800）与 **max |Δ| = 0 mm**。
> - **风险点 4：加依赖后老 venv 语义不一致。** 处理：锁变化改 `requirementsSha`，
>   provisioning 自动重建；本次加 rtree 时实测到该机制生效（旧 venv 被重建并装上 rtree）。
> - **验证方式：**
>   ```bash
>   cd dsh-cad-harness
>   node scripts/accept-python-worker.mjs --runtime ../.tmp-measure-runtime   # 8/8 全绿
>   node scripts/accept-python.mjs --quick                                   # 锁与开关断言
>   node scripts/accept-tool-scope.mjs                                       # 回归
>   node esbuild.mjs                                                         # 打包通过
>   ```
>   验收实测：握手 14.8 ms、ping 0.026 ms 中位数（200 次）、八个依赖可导入、
>   最近点与 three-mesh-bvh 一致（Δ=0，engine=rtree）、traceback 完整、kill 后重启、
>   并发严格串行、`python/` 在 `files` 里。
