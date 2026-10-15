# 执行摘要：XLB LBM 引擎落地（阶段 A：锁 + worker 引擎 + 验收）

## 动机
通用 CFD 引擎改道决策（DECISION-LOG 2026-10-15，含同日补记）选定双轨 LBM、XLB 先行。
probe（experiments/20261015_xlb_lbm_probe.md）证实 pip 车道成立并暴露三个需规避的缺陷。
本摘要落地阶段 A：依赖进 hash 锁、worker 引擎 op、解析真值验收。工具面（tools.ts schema）
在引擎验收通过后另行落地。

## 影响范围
- `dsh-cad-harness/scripts/gen-python-lock.mjs` —— PACKAGES 新增 XLB 依赖闭包
- `dsh-cad-harness/src/host/python-lock.ts` —— 生成产物（含新 REQUIREMENTS_LOCK_SHA256，
  触发运行时按既有协议重装 venv）
- `dsh-cad-harness/python/cad_worker/lbm_xlb.py` —— 新增：LBM 引擎（兼容 shim + 通道模板）
- `dsh-cad-harness/python/cad_worker/worker.py` —— 新增 lazy 加载器 + `lbm_channel` op
  + `versions` op 报告引擎存在性（对齐 numba 先例）
- `dsh-cad-harness/scripts/accept-lbm-channel.mjs` —— 新增验收脚本
- 不动：tools.ts（工具面下批次）、simulate_fluid（MPM 车道不变）、README（无用户可见变更）

## 具体操作步骤
1. **锁闭包**：以 probe venv 的 `pip install --dry-run --report` 在约束
   （numpy==2.5.3 / scipy==1.18.1 / trimesh==5.1.1 / warp-lang==1.12.1）下解析精确闭包，
   版本逐一进 PACKAGES；按 generator 报告的平台清单写 cad-exclude（预期：musl 全组排除
   ——jaxlib/warp/vtk 无 musl wheel；darwin-x64 视 jaxlib/warp 实际平台矩阵）。
   已知陷阱：probe 闭包基于 warp 1.18（拖 cyclopts/rich/pydantic 一串），钉 1.12.1 后
   该分支消失，闭包更小——以 dry-run 报告为准，不照抄 probe 安装清单。
2. **重生成锁**：`node scripts/gen-python-lock.mjs`，核对输出平台矩阵与 excludes；
   `--check` 通过。
3. **worker**：
   - `lbm_xlb.py`：`apply_compat_shims()`（overlap 检查 extend 版替换、打在
     `xlb.helper` 与 stepper 模块两个绑定名上）+ `zouhe_velocity_inlet()`（构造后
     `bc.prescribed_values = bc.profile()`，与上游 main 同语句——上游修复合并后此函数
     退化为直通）+ `run_channel()`（D3Q19/BGK/Equilibrium-外无、入口 ZouHe、半程反弹
     壁面；返回剖面/稳定标志/耗时）；
   - `worker.py`：`_load_lbm_xlb()`（显式路径 importlib，`python -I` 兼容，对齐
     `_load_mpm_numba`）；`op_lbm_channel`（`CAD_LBM_ENGINE=off` 响亮拒绝；ImportError
     自然冒泡为 ok:false 响亮失败）；HANDLERS 注册；`versions` op 报告 xlb 可用性。
4. **验收** `accept-lbm-channel.mjs`：
   - versions 报告 xlb 存在（本 target 在锁内）；
   - 通道 op：有限性、对称性（镜像误差）、确定度（两次运行逐位一致）；
   - 解析真值：充分发展剖面 vs 1.5U 抛物线，阈值=本机基线±余量（按 2026-10-11
     阈值纪律记录余量）；
   - shim 存在性断言：ZouHe shim 生效（构造后属性在、入口速度生效）+
     **未打补丁的 ZouHe 必须仍抛 AttributeError**（这是上游修复探测器：上游修好之日
     此断言变红，提示撤 shim——防 shim 残留静默失效）。

## 预期风险与验证
- 风险：锁重装（sha 变化触发全量重装 ~340MB，aliyun 源数分钟）；闭包约束冲突
  （pydantic-core 与 pydantic 版本强绑定；ml_dtypes/vtk 对 numpy 上限）→ 以 dry-run
  报告与 generator 错误暴露，逐个调版本；
- 风险：xlb 0.3.1 import 可能引用锁外模块（probe 时 cyclopts 在场）→ 验收的 import
  步骤直接暴露，缺谁补谁进 PACKAGES；
- 风险：Poiseuille 阈值无先例 → 首跑取基线，阈值=基线±20%（余量入验收注释）；
- 验证方式：`node scripts/accept-lbm-channel.mjs` 全绿 + `gen-python-lock.mjs --check`。

## 结果与偏差（2026-10-15 收尾补记）
- **验收 11/11 全绿**（accept-lbm-channel.mjs）：versions 报告 xlb、冒烟稳定、
  确定性逐位一致、Poiseuille 发展带 0.753∈[0.60,0.95]、镜像对称 0.00%、
  ZouHe 入口生效（inletUx=0.0498≈U）、修复探测器 upstreamZouheFixed=false、
  `CAD_LBM_ENGINE=off` 响亮拒绝。性能：**2.06 ms/步 @ 48×24×24（CPU）**，
  20000 步 41s——与 300s 工具超时模型匹配。
- **偏差 1（闭包）**：首装失败暴露两个漏钉的传递依赖 `opt_einsum`（jax 无版本依赖）
  与 `attrs`——已补进 PACKAGES 并重生成锁（新 SHA `fc83267d…`）；随后
  closure.txt ↔ lock 子串比对 NONE，闭包完整。
- **偏差 2（generator 的 pbsSums 走 github.com）**：本沙箱对该主机被阻；用文件内
  已有的 npmmirror 镜像跑临时副本生成（SHA256SUMS 字节相同，产物一致）。
  已知既有行为，未改 committed 脚本；`--check` 在 github 可达的环境照常工作。
- **偏差 3（验收自动 repair）**：新锁使既有 venv 必然缺 imports（state=failed）——
  验收脚本在 not ready 时自动走 `repairPythonRuntime`（对齐 python_runtime
  action=repair 的设计路径），之后每轮为热启动。
- **本机基线**（验收注释中的阈值依据）：发展带取 [0.60,0.95]（基线 0.753 ± 余量）、
  镜像对称 ≤5%（实测 0.00%）、`upstreamZouheFixed===false` 为修复探测器
  （上游修复发版之日该断言变红，提示撤 shim）。
- **待办（下一批次）**：tools.ts 工具面（`simulate_lbm` 窄 schema）+ DESIGN.md
  同步（引擎车道定稿后一并）+ 上游发版追踪（xlb release / PR #168）。

## 补记（工具面 + 文档同步，同日第二批）
- **tools.ts**：新增 `simulate_lbm`（对齐 simulate_fluid 输出形态 `overallStatus +
  metrics`）：四参 `cells / reynolds / latticeVelocity / steps`；`overallStatus` 按发展比
  分档（developed ≥0.9 / developing ≥0.6 / underdeveloped / diverged）；finalizeContent
  报峰值 vs 理论 1.5U、镜像对称、入口生效，并给出"发展长度随 Re 增长"的读取提醒。
- **skill 两层同步**：cad-toolbox 路由表新增通道流行 + Discipline 节新增
  `simulate_lbm` 注意事项（peakUx vs 1.5U、stable:false=越界非部分答案、镜像对称是
  诚实性检查）；cad-simulation 深度节新增四条"不显然事实"（lattice units 换算归
  LLM 声明、发展长度、阶段 A 无嵌固件、无耦合），front-matter 补 trigger。
- **DESIGN.md**：§2.1 做表新增 LBM 行；§2.2 不做的"工业级 CFD"条目修订（真实 NS
  通道模板 ≠ 工业级保证）；新增 **§29（v2.33）** 完整记录决策链（SU2→改道→双轨）、
  引擎车道、三处规避、工具面、验收与边界。
- **验收扩展**：accept-lbm-channel 新增第 6 节——通过 `registerCadTools` 最小 ctx
  驱动**真实 simulate_lbm 工具对象**（注册 + 转发 + overallStatus 分档），
  补齐"工具层转发断言"。
- **运维教训**：`job_kill` 落在运行时 repair 中途会把 venv 打成半残
  （"present on disk, not importable"）——repair 期间不可中断；冷供给（重抽解释器
  + 全量装包）约 6–11 分钟。
