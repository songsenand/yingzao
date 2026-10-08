# 执行摘要：插件自带 Python 运行时（宿主运行期供给）

## 动机
> 插件要分发给别人，而"目标机器上有可用的 Python"不成立：发行版解释器 3.8~3.14
> 不等、PEP 668 禁装包、conda/pyenv 各自为政。仿真/分析/几何处理的领域能力一直被
> 这个缺口卡着（HARNESS §12 的"Python 领域运行时落地"自 2026-09-28 起挂待办）。
> 用户拍板：**必须解决，且要让别人装完插件就自动有运行时**。决策全文见
> `docs/DECISION-LOG.md` 2026-10-08 条目。

## 影响范围
> - 新增 `dsh-cad-harness/src/host/python-runtime.ts`（供给：探测/下载/校验/解包/venv/装锁/状态）
> - 新增 `dsh-cad-harness/src/host/python-worker.ts`（执行：`run_python` 的子进程与 traceback）
> - 新增 `dsh-cad-harness/src/host/python-tools.ts`（注册 `run_python` / `python_runtime`）
> - 新增 `dsh-cad-harness/src/host/tar-extract.ts`（纯 JS tar.gz 解包 + 安全校验）
> - 新增 `dsh-cad-harness/src/host/python-lock.ts`（**生成物**：解释器锁 + 依赖锁 + 索引表）
> - 新增 `dsh-cad-harness/scripts/gen-python-lock.mjs`（生成/校验上面那份锁）
> - 新增 `dsh-cad-harness/scripts/accept-python.mjs`（验收）
> - 改 `src/host/tools.ts`（接线注册）、`src/host/index.ts`（模式配置 + eager 预热）、
>   `src/host/tool-scope.ts`（`pythonRuntime` 配置项）
> - 文档：`HARNESS.md` §12.7、`DESGIGN.md` §26 + §12.3 表格行、`docs/DECISION-LOG.md` 新条目
> - 运行时数据落 `$DSH_HOME/cad/runtime/`（跨项目共享，不进工作区、不进 git）
> - 本仓库没有 README.md，故环境变量记进 DESIGN/HARNESS

## 具体操作步骤
> 1. 新增 `src/host/tar-extract.ts`：`node:zlib` 解 gzip + 纯 JS 解析 tar（ustar/GNU
>    longname/pax、文件/目录/符号链接/权限位），拒绝绝对路径、`..` 越界与逃逸符号链接。
>    实测 pbs 归档只有 `0`/`2` 两种成员 + 9 个顶层 LICENSE，**LICENSE 保留在解释器旁**。
> 2. 新增 `scripts/gen-python-lock.mjs`：从 pbs 官方 `SHA256SUMS` 与 PyPI JSON 生成
>    `src/host/python-lock.ts`——pin `cpython-3.13.16+20261003` 的七个目标（linux gnu/musl
>    × x64/arm64、darwin arm64/x64、win32-x64）归档名 + sha256，六个依赖的按平台 wheel hash，
>    以及 pip 索引表。带重试；`--check` 供 CI 检漂移。
> 3. 依赖锁用 `--require-hashes --only-binary=:all:`；**rapier3d 无 darwin-x64 wheel**，
>    用生成的 `# cad-exclude-targets: darwin-x64` 指令在写盘时裁掉该块（PEP 508 marker
>    与 `--hash` 续行组合被 pip 拒，实测）。
>    依赖集除决策里那六个外，**同日补入 `scikit-fem 12.0.2`**：本仓库已有
>    `scripts/xval-cantilever-scikitfem.py`（并行提交 256674a 的 scikit-fem 交叉验证），
>    跑不了仓库已有 Python 工作的运行时不叫交付；纯 Python wheel，只依赖 numpy+scipy。
> 4. 新增 `src/host/python-runtime.ts`：平台/架构/libc 探测 → 来源优先级（DSH 载体
>    primary runtime → 已有安装 → 下载 pbs）→ 校验 sha256 → 解包到
>    `$DSH_HOME/cad/runtime/python/<ver>` → `-m venv` → `pip install --require-hashes`
>    → 写 `state.json`；索引/镜像可配、逐级兜底、进度回调、幂等、repair、`off`/`system` 模式。
> 5. 新增 `src/host/python-worker.ts`：临时脚本 + `-I` 隔离 + 进程组超时清理 + stdout/stderr
>    截尾 + **traceback 提取**（SyntaxError/TypeError 都带行号）。
> 6. 新增 `src/host/python-tools.ts`：注册 `run_python`（code/script/args/cwd/timeoutSec）与
>    `python_runtime`（status/provision/repair），走同一个 `registerTool` 助手 → 同受预设过滤。
> 7. `src/host/index.ts`：`configurePythonRuntime` 读配置，`eager` 时后台预热（不阻塞激活）。
> 8. 新增 `scripts/accept-python.mjs`：锁完整性 / 解包器安全 / 真实供给 / 执行与 traceback /
>    关闭开关；`--quick` 跳网络段，`--archive` 可离线喂归档。
> 9. `HARNESS.md` §12.7 记规范与变量表；`DESGIGN.md` §26 记设计与边界；表格行改 🚧。

## 预期风险与验证
> - **风险：首次下载体积大（解释器 33MiB + 依赖 ~230MB）且直连 PyPI 慢。**
>   验证：索引可配 + 默认带镜像兜底 + 进度可见；本机实测默认源 11m44s，镜像秒级。
> - **风险：解包安全**（路径穿越/符号链接逃逸）。验证：验收含 3 条恶意归档断言。
> - **风险：平台矩阵缺口**（rapier3d 无 darwin-x64、musl 与 glibc 产物不同）。
>   验证：锁按目标裁剪；不支持的目标明确报错而不是半装。
> - **风险：pnpm 装插件时被脚本闸门拦住。** 验证：方案不含 postinstall，安装期零脚本。
> - **风险：磁盘占用 ~350MB 且用户不知情。** 验证：`python_runtime` 报占用与路径；
>   `DSH_CAD_PYTHON=off` 可整体关闭。
> - **验证方式：** `node scripts/accept-python.mjs`（含真实供给）+ `node scripts/accept-tool-scope.mjs`
>   （工具目录仍受预设过滤，18 个注册点全过）+ `node esbuild.mjs` 重建 `lib/index.js`。
> - **已知既有问题（未在本轮修）**：`tsc --noEmit` 有 1 条 `src/host/fluid.ts:370`
>   的既有类型错误（本轮未触碰该文件）；README 缺失。
