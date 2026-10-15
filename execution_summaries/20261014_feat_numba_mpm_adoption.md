# 执行摘要：MPM 内核 numba 引擎采纳（CAD_MPM_ENGINE 门控）

## 动机
> 探针实验（`experiments/20261014_numba_mpm_probe.md`）证实 numba 移植对 numpy 内核
> 5.1–8.7×、对 TS 内核 1.3–2.0× 加速且 parity 达标，用户拍板采纳（DECISION-LOG 2026-10-14）。

## 影响范围
> - 新增 `dsh-cad-harness/python/cad_worker/mpm_numba.py`（生产 numba 引擎：P2G×2 + 密度/应力
>   + G2P 的 @njit/prange 核；网格边界与驱动/审计尾部与 numpy 内核逐行同构；缓冲挂
>   `world["mpmNumbaScratch"]`，一次分配复用）
> - 修改 `dsh-cad-harness/python/cad_worker/worker.py`：`_mpm_engine()` 选择器（强制 numba
>   缺失即响亮失败）+ `_load_mpm_numba()` 显式路径加载（worker 以 `python -I` 启动，
>   脚本目录不在 sys.path）+ `_mpm_step_once` 分发 + `op_versions` 增 numba + 模块头注
> - 修改 `scripts/gen-python-lock.mjs`：PACKAGES 增 numba 0.68.0 / llvmlite 0.50.0
>   （`cad-exclude` musl×2 + darwin-x64）
> - 重新生成 `src/host/python-lock.ts`（REQUIREMENTS_LOCK + REQUIREMENTS_LOCK_SHA256）
> - 修改 `src/host/python-runtime.ts`：LOCKED_IMPORTS 增 numba
> - 修改 `scripts/accept-fluid-sign.mjs`：到达率跨度阈值 0.15 → 0.20（依据写入注释）
> - 重建 `lib/`（host bundle）

## 具体操作步骤
> 1. 写 mpm_numba.py（从探针内核生产化：缓冲进 world、mask 用 uint8 view、尾部逐行对齐）。
> 2. worker 接线（引擎解析 + 分发 + 版本清单）。
> 3. 锁：gen-python-lock.mjs 增包 → 重新生成（PyPI 实拉哈希）→ python-runtime.ts 就绪检查增 numba。
> 4. `pnpm run build`。
> 5. 工作区 hermetic DSH_HOME 冷启动全新运行时（`DSH_CAD_PYTHON_INDEX_URL` 指阿里云镜像，
>    11 包哈希校验安装 ~1 分钟；pypi.org 直连实测过慢故用文档化镜像开关）。
> 6. 验收：`accept-mpm-parity`（numba 与 numpy 两路径，注意该脚本默认指向旧
>    `.tmp-measure-runtime`，须传 `--runtime`）、`accept-m4`、`accept-fluid-sign`（两引擎）。

## 预期风险与验证
> - 风险：numba 与 numpy 的浮点求和序不同 → 宏观指标漂移。验证：`accept-fluid-sign`
>    到达率跨度 numba 0.1582 / numpy 0.1337，直接断言（符号/掩码/穿透/种子）两引擎全过；
>    numba 两次运行逐位一致（确定性）。阈值 0.15→0.20 经用户拍板（依据见验收注释与
>    DECISION-LOG）。
> - 风险：平台缺口（musl/darwin-x64 无 wheel）。验证：`cad-exclude` 指令 + `_mpm_engine`
>    自动回落 numpy 内核；强制 numba 而不可用时抛错（已由 accept 首轮失败路径实测）。
> - 验收结果：`accept-m4` 全过（含 38k 粒子真实管道、弯头、沉降）、`accept-mpm-parity`
>    两路径全过（numba 路径 Python 30ms vs TS 36–50ms；numpy 路径 162ms）、
>    `accept-fluid-sign` 两引擎 16/16。
> - 未动项：`mpm.ts`（TS oracle 与 darwin-x64 fallback 保留）、TS↔Python kernel parity 的
>    分层契约不变。
