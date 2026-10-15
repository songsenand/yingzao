# 实验报告：XLB 作为插件 pip 车道 LBM 引擎的可行性探针（含 SU2 不可压通道对照）

## 目标
在"通用 CFD 引擎改道"决策（DECISION-LOG 2026-10-15）之后，验证 XLB 0.3.1 能否作为
插件 Python worker 内嵌的 LBM 引擎落地：安装进 hash 锁 venv、以官方 API 跑通
3D 不可压通道流（Re=100）、给出 CPU 性能量级，并暴露 0.3.1 的真实缺陷清单。

## 假设
pip 车道分发成立（xlb 纯 py wheel + jaxlib cp313 wheel）；JAX CPU 上 10⁵–10⁶ 格子的
小算例能进 300s 工具超时模型；API 可被窄 schema 工具包裹；0.3.1 的成熟度风险未知。

## 方法
- 隔离 venv：`~/.dsh/cad/runtime/venv/bin/python3.13 -m venv`（与插件运行时同解释器，
  绝不动生产锁环境）；源走插件同款 `mirrors.aliyun.com/pypi/simple`（pypi.org 的
  files.pythonhosted.org 慢通道实测 16 分钟，aliyun 后正常）。
- `pip install xlb`（0.3.1，纯 py wheel 112KB）→ 39 包 ~340MB（jax/jaxlib 0.11.2、
  warp-lang、pyvista、vtk、trimesh 等）。
- 算例：48×24×24 通道流，D3Q19 + FP32FP32 + BGK，Equilibrium 入口（u=0.05 lattice）/
  DoNothing 出口 / 半程反弹壁面，ω=1/(3ν+0.5)，Re=100；JAX CPU 8 线程。
- 对照组：SU2 v8.5.0 不可压通道（conda-forge 二进制 + 手写 .su2 网格 + cfg 迭代）。

## 结果
**安装/分发**
- pip 车道成立：xlb 纯 py + jaxlib 0.11.2 cp313 manylinux wheel（89.9MB）已核实并实装成功。
- 兼容性坑 ①：`xlb 0.3.1` 与最新 `warp-lang 1.18.0` 不兼容（`from warp.utils import
  ScopedTimer` 已被移除，import 即炸）；回退 **warp-lang==1.12.1** 后 import 通过
  （仍有 DeprecationWarning，说明 1.12 也已在该弃用路径上）。

**运行**
- `warp-lang==1.12.1` + JAX CPU 下：27648 格子，**1.67 ms/步**（含 20000 步全程稳定，
  finite=True），600 步冒烟 0.84–0.88s；对 10⁵–10⁶ 格子量级估算仍在"分钟级"，
  与 300s 工具超时模型匹配（生产精度需实测更大网格）。
- 物理定性正确：20k 步后中心线剖面呈对称抛物线形（峰值 0.0301，理论充分发展 0.0749，
  尚在发展中——发展长度/边界条件工程调优属后续验收工作，非阻塞缺陷）。

**暴露的 0.3.1 缺陷（按严重度；含当日补录验证）**
1. **ZouHeBC 运行时必炸**：`bc_zouhe.py` 的 `get_rho`/`get_vel` 引用 `self.prescribed_values`，
   但 `__init__` 只赋值 `self.prescribed_value`——该属性从未被赋值（全文件 grep 证实）。
   **补录（同日验证）**：wrapper 层 1 行补丁（构造后 `bc.prescribed_values =` 形状修正的
   数组）即修复；实测"补丁 ZouHe 速度入口 + DoNothing 出口"20k 步稳定、有限、
   **逐位确定**（两次运行指标完全一致），剖面发展明显优于 Equilibrium 入口
   （峰值达理论值 75% vs 40%）。但"补丁 ZouHe 速度入口 + ZouHe 压力出口"组合发散
   （NaN）——压力出口的量纲约定/角点重叠需专门的 BC 配对工程，属阶段 A 验收内容。
   注意：替换 EquilibriumBC 是**降级权宜**（物理不等价），生产路径应走补丁修复。
2. **check_bc_overlaps 在 numpy 2.5.x 下必炸**：`index_list[d] += bc.indices[d]` ——
   **numpy 2.5.x 改变了 `list += ndarray` 的语义**（list 被数组语义接管：空 list 视为
   shape (0,) 去和 (N,) 广播，最小复现 `il=[[],[],[]]; il[0]+=np.arange(3)` 即 ValueError；
   Py3.13/3.14 + numpy 2.5.4 一致）。规避：wrapper 中替换为 extend 版实现（已验证）。
   **补录（同日验证）**：插件运行时 venv 的 **numpy==2.5.3 实测同样中招**——这是
   **插件级环境发现**：worker 自身代码与锁内库中任何 `list += ndarray` 累加写法
   都是潜在地雷（现有验收未触发 ≠ 不存在）。
   **补录（同日排查完毕）**：worker 全量 `+=` 扫描（worker.py 61 处 + mpm_numba.py 28 处）
   ——全部为 `ndarray += ndarray`（正常 numpy 行为，不受影响）或 int/str/float 累加，
   **零处 `list += ndarray`**，现有 worker 代码无罪；风险在未来代码与锁内其他库的升级。
   防御：编码规范避开该写法（用 `list.extend(arr)` / `list(arr)`），xlb 一类新依赖
   在 wrapper 层隔离此类雷。
3. **循环约定未文档化**：双缓冲返回顺序是 `(f_1, f_0) = stepper(f_0, f_1, ...)`（新状态在
   第一个返回值；读错缓冲区会得到"全场静止"的假象，本次 probe 实际踩中并误诊过一次）。
4. 索引格式 (3, N) 列式、无 config_template 类的单一权威参考——API 靠内省/源码考古
   （与 SU2 的 cfg 考古同类问题，但量级小得多，且全部可在 Python 层修）。

**SU2 对照组（同日）**
- conda-forge 8.5.0 二进制可跑（1.8s 启动）；但不可压通道 cfg 经 7+ 轮迭代仍未完全跑通：
  v8 大量改名 vs 官网文档停在 v7（`SOLVER= INCOMPRESSIBLE`→`INC_NAVIER_STOKES`、
  边界改 6/2 元组内联、`INC_ENERGY_EQUATION= NO`、粘性模型强制声明、`INC_INLET_TYPE`
  计数需对照 `CConfig.cpp`/`option_structure.inl` 源码）。网格管线（gmsh→CGNS/.su2）未开始。

## 分析
- 分发假设成立且是 XLB 的决定性优势：pip 进 hash 锁零摩擦，无二进制捆绑/编译链。
- "pip 可装"不等于"开箱即用"：0.3.1 存在 1 个 import 级破坏（warp 漂移）+ 2 个运行时缺陷
  （ZouHe、overlap 检查）+ 1 个文档缺口（循环约定）。全部可在我们的 wrapper 层修复/规避，
  且锁可以钉死（xlb==0.3.1 + warp-lang==1.12.1 + numpy 行为感知），但**落地时必须把
  这些规避写成有注释的补丁并纳入验收**，避免"静默假通过"。
- 性能量级符合预期（CPU 小算例可用）；GPU 加速在本机不可用（无 NVIDIA；rusticl CPU
  OpenCL 未测）。
- 对 SU2 的失望得到实证：问题不在"装不上"（conda 二进制其实能跑），而在**配置面考古成本
  与文档滞后**——这正是 LLM 能力维度的不达标项。

## 遇到的问题
- files.pythonhosted.org 慢通道（16 分钟）→ 换插件同款 aliyun 源解决。
- micromamba 家目录只读失败 → fake HOME 解决（SU2 probe 阶段遗留经验）。
- 本报告未完成项：Poiseuille 充分发展验收（剖面仅发展至理论值的 ~40%）、
  RegularizedBC 路径、Warp 后端、更大网格的性能曲线、rusticl OpenCL——留待落地阶段。

## 产物列表
**代码与脚本**
- `experiments/scripts/20261015_xlb_channel_smoke.py` —— XLB 通道冒烟（含全部规避补丁：
  warp 版本注释、overlap 替换、EquilibriumBC 替代 ZouHe、正确循环约定、Poiseuille 检查）
- `.tmp-su2-probe/`（SU2 对照组遗留，可删）：`channel.su2`、`channel.cfg`、
  `config_template.cfg`（v8.5.0 官方模板，gitee 镜像拉取）、`CConfig.cpp`、
  `option_structure.inl`、`su2_run.log` 系列、`xlb-venv/`（可删，重建命令见下）

**运行命令**
```bash
~/.dsh/cad/runtime/venv/bin/python3.13 -m venv .tmp-su2-probe/xlb-venv
.tmp-su2-probe/xlb-venv/bin/pip install -i https://mirrors.aliyun.com/pypi/simple xlb==0.3.1 "warp-lang==1.12.1"
cd .tmp-su2-probe && HOME=$PWD/fakehome MPLCONFIGDIR=/tmp/mpl ./xlb-venv/bin/python ../experiments/scripts/20261015_xlb_channel_smoke.py
```

**环境依赖**
- 插件自带 CPython 3.13（`~/.dsh/cad/runtime/venv/bin/python3.13`）；Linux x86_64；无 GPU
  依赖（JAX CPU）；网络需可达 mirrors.aliyun.com（或 files.pythonhosted.org，慢）。

## 结论与下一步
- **上游状态核查（2026-10-15，GitHub API）**：最新 release 仍为 **v0.3.1**（2026-01-12），
  tags 无更新；**ZouHe 缺陷在 main 分支已修**——JAX 后端 `self.prescribed_values =
  self.profile()`（随大重构 PR #159 进入，2026-05-15），**未包含在任何 release**；
  该 bug 无他人提 issue/PR（ZouHe 相关 13 条均非此问题）；open PR #168
  "Upgrading to Warp 1.16"（2026-09-28 活跃）说明上游正自行追赶 warp 兼容（即缺陷①），
  发版时间无信号。
  **shim 修订**：已实测把 wrapper 补丁改为与上游 main 完全同语句的
  `bc.prescribed_values = bc.profile()`（入口 0.0498≈U，结果与 reshape 版逐位一致）——
  将来升级撤除时零差异。
- **结论**：XLB 0.3.1 作为阶段 A 引擎可行，但落地必须包含三个已证实的规避
  （warp-lang==1.12.1 钉版、overlap 检查替换、ZouHe shim 镜像上游语句）并把它们写进
  执行摘要与验收脚本；"numpy 2.5.x `list += ndarray` 语义变化"是对插件全局的环境级发现，
  建议对 worker 现有代码做一次同款写法排查（已完成，见缺陷 2 补录）。
- **下一步（落地阶段 A，按执行摘要流程）**：
  1. `gen-python-lock.mjs` 新增 xlb==0.3.1 / jax / jaxlib / warp-lang==1.12.1
     （musl 等缺 wheel target 按 cad-exclude 惯例回落并披露）；
  2. worker 新增 LBM 引擎 op（命名/门控对齐 `CAD_MPM_ENGINE` 模式），
     内嵌上述规避补丁；
  3. 验收：Poiseuille 解析真值（发展长度收敛研究）+ 与 simulate_fluid（MPM）的
     定性对照 + 工具层转发断言（对齐 accept-p3 惯例）。
