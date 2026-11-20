# 0.1.1 版本目标：CadQuery 成为一等公民

> **发布版本号**：`0.1.1-preview.1`（用户 2026-11-20 确认；不要直接发 `0.1.1` 正式版）。

> **状态**：2026-11-19 方向确认（用户）。本文只写 0.1.1 的**目标、范围、验收、排期**；
> 顺序与状态以 [TODO.md](TODO.md) 为准，架构细节进 `DESIGN.md`。
>
> **2026-11-19 追加**：dsh 0.2.2-rc.1 移除了 `@deepseek-ai/dsh-tool-subagent-control/list-agents`
> 子路径，已发布包里的预设整块失效（无「营造模式」）。新增发布阻断项 **L1.8**（§4.5），
> 与 CQ 主线无关，但不修不发。
>
> **非目标**：通用引擎平台、第三个引擎、社区/用户自行接入、插件市场。
>
> **2026-11-19 追加（渲染器）**：OpenSCAD 作为插件**常驻依赖**保留，负责四视图、剖切、运动/装配关键帧与网格导出；**不替换**为 Matplotlib/F3D/自写光栅器。CadQuery 只是新增作者引擎；一个项目仍只有一个作者引擎。

---

## 0. 一句话

**0.1.1 只做一件事：让 CadQuery 与 OpenSCAD 同等地走通「生成 → 验证 → 渲染 → 装配 → 导出 → 交付审计」。**

不是“支持更多引擎”，而是“第二个引擎不破坏现有闭环”。泛化只做 CadQuery 逼出来的那一层，
不提前为第三个引擎或社区适配设计。

---

## 1. 目标（可证伪）

0.1.1 收口时，下面每一条都要能指名一个观察：

1. **同一零件、两个内核**：同一个 bracket（4 孔 + fillet + datum 轴）在 OpenSCAD 和 CadQuery
   下都能编译、四视图渲染、测量、装配检查、STL 导出；bbox/体积差在声明阈值内，datum 差 ≤ 0.01 mm。
2. **切内核不改历史**：项目默认从 OpenSCAD 切到 CadQuery 后，v001 仍按 OpenSCAD 渲染/测量；
   v002 记 CadQuery；删掉 v001 的 STL 且**对应作者引擎**不可用时，得到 `skipped`/finding，
   **不是**用 CadQuery 重建。
3. **失败有 code + fix**：缺 pack、坏 pack、语法错误、Python 异常、超时、空结果、非实体，
   各有稳定错误码与下一步；不是只甩一条 traceback。
4. **旧项目零迁移**：旧 `model.scad` 可读；没有 `backend` 字段的旧版本按 OpenSCAD 解释；
   `scadCode` 旧参数仍可用。
5. **接入成本受控**：CadQuery 的接入只新增一个 provider + 一个 GUIDE + 必要的 seam 改动；
   核心路径不再出现 `if (kernel === 'openscad')` 式分支。用 `git diff --stat` 记录改动的核心文件数。
6. **doctor 说真话**：`dsh-cad-doctor --json` 同时报 OpenSCAD 与 CadQuery 的版本/pack 状态；
   CadQuery 缺包时给安装命令，不静默回退。
7. **既有门禁不回归**：`npm run accept:preview` 仍全绿；新增 `accept:cadquery` /
   `accept:kernel-switch` / `accept:engine-seam` 有数字。
8. **预设不静默漂移**：把 0.1.0-preview.5 装到 dsh 0.2.2-rc.1、不跑 `dsh-cad-setup` 时，
   `doctor` 报 `preset-standard-drift` 并给 fix；跑一次 `npx dsh-cad-setup` 后转 pass，
   重启后「营造模式」出现；发布物本身不再携带失效行（`prepublishOnly` 卡住）。

---

## 2. 为什么是 CadQuery，为什么不是第三个引擎

**选 CadQuery 的理由：**

- 它是“代码驱动 B-rep”里训练语料最多、LLM 最容易写对的之一；
- 本地无头、可 pin、能出 STL 和 STEP；
- Python 生态与现有 runtime 重合（Python 3.13 + OCP cp313 wheel）；
- 它能把“第二后端”这条路的坑一次性暴露：源码语言、datum、错误语义、原生格式、安装包。

**不接第三个引擎的理由（2026-11-19 用户拍板）：**

- 第一梯队的目标是“每个后端都好用”，不是“后端数量多”；
- 第三个引擎至少等 0.1.1 稳定、有真实需求、且 3-task benchmark 证明 LLM 能写好；0.1.2/0.2 都不排，0.3 才评估；
- 社区/用户自行接入后置到 0.4+/1.0 前。

**第一梯队当前只有两个：OpenSCAD + CadQuery。** 这不是临时状态，是产品选择。

---

## 3. 范围

### P0（不发就别叫 0.1.1）

| ID | 事项 | 出口 |
|---|---|---|
| L1.0 | CadQuery 可行性探针（**功能通过，体积待决策**） | bracket 编译/水密/bbox 通过；pack **1.4–1.6 GiB**（VTK/casadi 主因），trame 可省、VTK 不可省；见 `experiments/20261120_L1.0_cadquery_probe.md` |
| L1.1 | 最小引擎 seam（**已实现**） | `compile(source,{kernel})` 唯一入口；`EngineAdapter={id,compile}`，render/export 移出；`accept:engine-seam` 14/14、`accept:backend` 18/18、OpenSCAD accept 绿 |
| L1.2 | CadQuery provider（**已实现**） | `compile(...,{kernel:"cadquery"})` + 同 schema datum；syntax/exception/timeout/no-result/pack-missing 各 code+fix；doctor 探针；pack 显式 `--target`；`accept:cadquery` 23/23 |
| L1.3 | 源码/版本 pin + 分派（**已实现**） | `model.scad`/`model.py` + `sourceFile`/`backend`；旧行兼容；jobs/assembly/export 按 pin；`accept:kernel-switch` 15/15 |
| L1.4 | 统一验证入口（**已实现**） | STL→Manifold（designEvidence=mesh）；STEP→`import_mesh`+OCP BRepCheck；缺失/无效/不一致各有 code；`export?format=step` 只读版本目录；`accept:step-validation` 23/23 |
| L1.6 | 验收 + 跨内核回归（**已实现**） | 三个新 accept 有数字；`accept:preview` exit 0；Linux 实跑，Windows/macOS 未跑且不冒充；diff 规模已记录 |
| L1.7 | 文档/发布/许可（**已实现**） | README/DESIGN/limits/install/release notes/NOTICE；CQ pack/VTK/OCP 许可；`0.1.1-preview.1` |
| L1.8 | 预设与 dsh 版本对齐（**发布阻断**，与 CQ 无关） | 预设按目标 dsh 的 `standard.patch.yml` 重生成；`doctor` 增 `preset-standard-drift`；`prepublishOnly` 跑 machine-neutral `check-release-preset`；README 写明升级后重跑 setup；preview.2–.5 的已知问题进 release notes（§4.5） |
| L1.9 | 安装时内核选择（**已实现**） | `dsh-cad-setup --kernel openscad/cadquery`；TTY 无 flag 时询问；默认 openscad；CQ 只写选择并提示显式 pack（不自动下载）；`accept:setup-kernel` 10/10 |
| L1.10 | 会话内核上下文（**已实现**） | 每 agent 的 `cad-kernel` prompt context：项目 marker → 全局 backend；CQ/SCAD 写代码前直接知道用 `code` 还是 `scadCode`；非 CAD 会话不注入；`accept:kernel-context` 10/10 |

### P1（有时间就做，不阻塞发布）

| ID | 事项 | 出口 |
|---|---|---|
| L1.5 | CQ 作者层 + 1 个示例（**已实现**） | `generate_part` 的 `code`/`scadCode` 二选一；CQ 渲染走 STL→OpenSCAD；`cad_session info` 报 kernel；CQ GUIDE + bracket 示例；`accept:cadquery-authoring` 16/16 |
| U03 | 契约封印写入（已验证） | `write_assembly` 必须有 `reason` + `expectedRevision`；`assembly.seal` + `changes/` 链；通用 fs 写入拒绝；直改 `contract-tampered` + `dsh-cad-contract rebuild`；`accept:assembly-contract` 30/30 |
| L1.4b | 单件 STEP 直通（可选） | CQ 版本可下载 `model.step`；内核 `BRepCheck`；manifest 记 provenance；不做 ZIP/往返 |

### 不做（明确后移）

- **U01 面板视觉重做**、**U02 更多示例** → 0.1.2；
- **渲染器替换**（Matplotlib/F3D/自写光栅器）→ 不做；OpenSCAD 常驻依赖；
- **第三个引擎** → 不早于 0.3，且先跑 benchmark；
- **社区/用户自行接入** → 0.4+/1.0 前；
- 公开 `engine.json` 协议、通用 conformance kit、插件市场 → 0.3/0.4；
- STEP 完整审计路径（ZIP 纳入、往返、三平台）→ 0.1.2；
- 异步 render/sim job 全量（N15 剩余）→ 0.1.2。

---

## 4. 技术方案

> §4.1–§4.4 只做 CQ 逼出来的那一层；§4.5 是与 CQ 主线无关的发布阻断项。

### 4.1 最小 seam

```ts
interface EngineAdapter {
  id: string;
  source: { language: 'scad' | 'py'; extension: string };
  capabilities: { brep: boolean; step: boolean; datums: 'helper' | 'native' | 'none' };
  detect(): Promise<{ ok: boolean; version?: string; reason?: string; fix?: string }>;
  compile(source: string, opts: CompileOptions): Promise<{
    ok: boolean;
    stl?: Uint8Array;
    step?: Uint8Array;
    datums: DatumSet;
    diagnostics: Diagnostic[];
    meta: { kernel: string; version: string; units: 'mm'; durationMs: number; brepValid?: boolean };
  }>;
}
```

- `compile` 是唯一必需方法；渲染/导出不进入 adapter，统一走 OpenSCAD。
- 渲染统一走现有“STL → `renderStlViews`”，CadQuery 不引入 VTK/OSMesa。
- 网格格式导出统一走现有 STL 路径；只有 STEP 是原生格式。
- **不**在核心路径里按 kernel 写分支；分支只允许出现在 provider 内部。

### 4.2 源码与版本

- 版本目录：`model.scad` 或 `model.py`；manifest 记 `sourceFile`。
- 版本 manifest：`backend: { kernel, version, options }`；旧版本没有该字段 → OpenSCAD。
- 项目默认：`cad-data/project.json` 可选 `defaultKernel`；没有 → 全局 `backend.json` → `openscad`。
- 旧 `model.scad` 继续可读；不迁移、不改写旧目录。
- `jobs` / `assembly-check` 重建 / export 路由都按**版本 pin** 分派，不用“当前默认”。

### 4.3 验证复用

| 检查 | STL | STEP |
|---|---|---|
| 解析/截断/空 | `parseBinaryStl` | `import_mesh` 的 STEP 分支（cascadio） |
| 实体/水密/非流形 | Manifold | 同一个 `import_mesh` + Manifold |
| 体积/bbox/壳体/绕向 | Manifold | 同一个 |
| 单位 | 调用方声明 | `import_mesh` 已归一化 STEP 米→毫米 |
| B-rep 拓扑有效性 | 不适用 | provider 调 `shape.isValid()` / `BRepCheck_Analyzer` |
| 精度/公差 | 三角化 | provider 在 `meta` 报 `tolerance` |
| 版本绑定 | 版本目录 | 同一个 + `model.step` hash |
| 壁厚/干涉/打印/运动 | STL | **仍用 STL** |

**原则：** 设计证据仍然只有一份——STL 网格。STEP 有效不等于设计通过；manifest 要写清
`validatedBy: OCP` 与 `designEvidence: mesh`，不能把 B-rep 有效包装成“已认证”。

### 4.4 CadQuery provider

- **OpenSCAD 始终安装**：CadQuery pack 是增量；四视图/剖切/运动帧/网格导出仍走 OpenSCAD，不引入 VTK/Matplotlib。
- Python 3.13 + `cadquery-ocp` 7.9.x（cp313 wheel，manylinux_2_31；Linux 基线 glibc ≥ 2.31）。
- 最小 pack，不装 `trame`/`vtk` 可视化闭包；目标 300–500 MB，实测后写进文档。
- 一次编译一个子进程；超时/取消/崩溃隔离；不常驻 OCP。
- runner 注入 `datum` / `datum_axis` / `datum_plane` / `datum_cyl`；支持 `result` /
  `show_object` 收尾；导出 STL；有 STEP 能力时导出 `model.step` 并 `isValid()`。
- 错误码：`engine_pack_missing` / `engine_import_error` / `engine_compile_error` /
  `engine_timeout` / `engine_empty_result` / `engine_invalid_brep` / `engine_artifact_mismatch`。
- 安全边界：生成的是 Python，会以用户权限执行；不是沙箱。写进 `docs/user/limits.md`。
- 许可：CadQuery/OCP 的 PyPI 元数据是 Apache-2.0；底层 OCCT 的义务仍要按实际 wheel 审计，
  更新 NOTICE / THIRD-PARTY-AUDIT；不把 wheel 打进 npm 包。

### 4.5 预设与 dsh 版本的耦合（发布阻断）

`presets/cad/preset.patch.yml` 不是引用，而是**从当前安装的 dsh 的 `presets/standard.patch.yml`
逐字复制**生成（`scripts/preset-lib.mjs`）；`prepack` 在打包机跑一次，就把上游那一版的内部行
固化进 tarball。dsh 的预设是**整块挂载**：任何一行插件起不来，整个预设失败（模式不出现），
没有降级。

dsh 0.2.2-rc.1 移除了 `@deepseek-ai/dsh-tool-subagent-control/list-agents` 子路径
（`list_agents` 并入主插件）。已发布的四个版本都还带着这一行：

| 版本 | `list-agents` 行 | `modelSelectionSettings` | 装到 0.2.2-rc.1 且未跑 `dsh-cad-setup` |
|---|---|---|---|
| 0.1.0-preview.2 / .3 / .4 / .5 | 2 处 | 1 处 | 预设整块失败，无「营造模式」 |

**处置：**

1. **已重生成**（2026-11-19）：删除 `list-agents` 行；`modelSelectionSettings` →
   `modelSelection` + `modelDiscovery`；补 `tool-fs.applyPatch`；`tool-plugin-manager` 门控对齐。
   证据：28 行插件名全部可解析；强制启动失败转储里 `preset-cad` 为 `active`，无 `never started`。
2. **doctor 增 `preset-standard-drift`**：用 `buildPreset()` 生成期望文本与磁盘比对，
   不一致 fail 并给 fix（`npx dsh-cad-setup` + 重启）。现有 `preset-skill-path` 只查 skill
   路径，查不出这种漂移。
3. **`prepublishOnly` 跑 `node scripts/check-release-preset.mjs`**：用 packed（无本机路径）预设比对目标 dsh；`setup --check` 仍是安装后自检。原句保留为历史：
   dsh 一致，不发布自相矛盾的包。
4. **README 安装/升级段**：写明「升级 dsh 后要重跑 setup」；已发布版本的已知问题写进
   `RELEASE-NOTES-0.1.1.md`。
5. **latest 不能停在坏包上**：先发一个带新预设的修订（preview.6 或 0.1.1-preview.1），
   再谈 0.1.1 正式版。

**不做：** 不追求「一次生成、跨版本通用」。预设必须完整声明 `plugins` 列表，没有继承/引用，
只能靠「生成 + 检查」；若 dsh 将来支持预设继承，再改为引用。

### 4.6 U03 契约封印（已验证）

`assembly/assembly.json` 是**物化视图**；权威历史是 `assembly/changes/`，二进制封印是
`assembly/assembly.seal`。唯一写入口是 `cad_assembly`（`action: "write"`）和
`dsh-cad-contract write`：

- 每次写必须有 `reason` + `expectedRevision`（`create` 为 0），返回 `changeId`/`diff`；
- 通用 `write`/`edit`/`apply_patch`/`delete` 命中契约路径 → CAD fs policy 返回
  `FS_PERMISSION_DENIED`；bash 直改字节 → 封印 hash 不匹配 → `contract-tampered`，
  `dsh-cad-contract rebuild` 从日志恢复；
- `assembly-check` 报告/pointer 记录 `contractRevision`/`contractHash`；`delivery-audit`
  在契约 revision 变化时给 `contract-changed-since-check`，旧检查不再被当作当前证据。

实现：`src/host/assembly-seal.ts`、`src/host/assembly-contract.ts`、`src/host/fs-policy.ts`、
`scripts/contract.mjs`；项目 ZIP 也携带 `assembly.seal` + `changes/`。验收：`npm run accept:assembly-contract` **30/30**；
`accept:write-assembly` / `accept:tool-contracts` 仍绿。

### 4.7 L1.0 探针结果（体积风险，L1.2 前需决策）

CQ 2.8 在现有 Python 3.13 runtime 上功能可用：60×40×6 bracket（4×Ø4.5、R4 竖边圆角）与 OpenSCAD 等价件 bbox 完全一致，STL 水密、单 body，volume 差 -0.09 mm³（-0.0007%）；import 0.88 s、build+export 约 0.04 s。

但 **pack 体积是 1.4–1.6 GiB**，不是预估的 300–500 MB：vtkmodules 639 MiB、casadi 277 MiB、llvmlite 173 MiB、OCP 166 MiB、scipy 109 MiB。`import cadquery` 不加载 trame/matplotlib（可省），但 **VTK 是硬依赖**（`shapes.py` 顶层 + STL 三角化），casadi 也被 `assembly -> solver` 顶层拉起。安装约 197 s（本机 2.4 MB/s，非 clean-room）。

**决策（2026-11-20）：** 用户明确现阶段体积不是问题，接受 1.4–1.6 GiB，继续 L1.2；体积必须在 README/limits/安装说明中明示。lazy-import `Assembly/solver`、`--no-compile` 作为可选优化，不作为 0.1.1 前置。L1.1 已完成。

### 4.8 L1.1 引擎 seam（已实现）

- `src/host/compile.ts` 的 `compile(source, { kernel })` 是唯一编译入口；`compileAndRender` / `compileStlOnly` 只差 `render` flag，不再写死 `backendAdapter('openscad')`。
- `EngineAdapter` 只要求 `{ id, compile }`；`render`/`export` 从 adapter 接口移除，统一由 OpenSCAD 路径负责；OpenSCAD 的 `compileAndRender` 仍产出四视图，`compileStlOnly` 不渲染，行为不变。
- `src/host/backends/index.ts` 是注册表：重复/无 `compile` 注册、未知 kernel、planned kernel 全部 `backend_not_available` / `engine_registration` 拒绝，不静默回退。
- 验收：`accept:engine-seam` **14/14**、`accept:backend` 18/18、`accept-assembly` / `accept-inspect` / `accept-icd` 绿；`tsc` 0。

### 4.9 L1.2 CadQuery provider（已实现）

- `src/host/backends/cadquery.ts`：子进程执行作者脚本，pack 只通过 `PYTHONPATH` 注入，不污染 runtime venv、不自动下载；缺包直接给 `cadquery_pack_missing` + 安装命令。
- `python/cadquery_compile.py`：`result`/`show_object` 出几何，`datum/datum_axis/datum_plane/datum_cyl` 产出与 SCAD 相同的 `DatumSet`；语法/运行时/导出失败都写结构化结果。
- 错误分类：`cadquery_syntax`、`cadquery_exception`、`cadquery_timeout`、`cadquery_no_result`、`cadquery_pack_missing`（另有 `cadquery_export` / `cadquery_crash`），每条带 `fix`。
- `doctor` 的 `cadquery` 探针在 pack + runtime 就绪时跑真实 import；`accept:cadquery` **23/23**、`accept:backend` 24/24、`accept:doctor` 21/21。
- 注：L1.3 已把 `sourceFile`/`backend` pin 到版本；`generate_part` 的作者层 kernel 选择留到 L1.5，本步先提供 provider 与显式 `kernel:"cadquery"` 路径。

### 4.10 L1.3 源码/版本 pin + 分派（已实现）

- `saveVersion` 支持 `sourceCode` / `sourceFile` / `backend`；生成版本写 `model.scad` 或 `model.py`，manifest 记录 `sourceFile` 和 `backend.kernel`；`scadCode` 仍是兼容入口。
- `readVersionSource` 从 pin 读源码，旧行没有 `sourceFile` 时回退 `model.scad`/`model.py`；`revertVersion` 与 `set_datums` 的新版本保留源文件与 pin。
- `startCompileJob` 按版本 pin 分派：OpenSCAD 走原外部进程，CadQuery 走 provider；CQ 缺 pack 的 job 写 `cadquery.log` 并回 `cadquery_pack_missing`，不再报 “missing model.scad”。
- `check_assembly` 的 STL 重建、`/api/cad/export` 的非 STL 转换都按 `sourceFile` 选源；无 `.scad` 的 CQ/导入版本继续用 STL 包装。
- 验收：`accept:kernel-switch` **15/15**（v001 源/STL 不因 v002 切 CQ 而变；CQ job 分派证据）；`accept:version-index` / `accept:write-assembly` 绿；`tsc` 0。

### 4.11 L1.4 统一验证入口（已实现）

- `src/host/geometry-validate.ts` 的 `validateVersionGeometry` 是唯一入口：STL 先过 `parseBinaryStl` + Manifold `weldToSolid`，`designEvidence` 恒为 `mesh`；壁厚/干涉/打印/运动仍然只读 STL。
- STEP 存在时走 `importGeometry`（worker 的 `import_mesh` STEP/cascadio 分支）回读，并与 STL 的 bbox/volume 对比；版本 manifest 的 `brep.valid`（provider `BRepCheck_Analyzer`）作为 **provider claim** 记录，不替代设计证据。
- 代码：`stl_missing` / `stl_invalid` / `stl_not_manifold`；`step_missing`（默认 warn，`requireStep` 时 blocked）/ `step_invalid` / `step_not_solid` / `step_invalid_brep` / `step_artifact_mismatch`。
- CadQuery `compile(...,{step:true})` 导出 STEP + `meta.brepValid/toleranceMm`；`saveVersion` 写 `model.step`、`stepSha256`、`brep`、`designEvidence`。
- `/api/cad/export?format=step` 只读版本目录的 `model.step`；缺失返回 `step_missing`，绝不现场编译。
- 验收：`accept:step-validation` **23/23**（含库件匹配/缺失/坏 STEP/跨件 mismatch/BRepCheck=false/坏 STL）；`accept:cadquery` **23/23**（含 STEP 导出与 BRep 元数据）；`tsc` 0。

### 4.12 L1.5 CadQuery 作者层（已实现）

- `generate_part` 接受 `code`（CadQuery）或 `scadCode`（OpenSCAD），二选一；CQ 编译成功后把 STL 交给共享 `renderStlViews`（STL→OpenSCAD），不引入 VTK 渲染。
- CQ 版本写 `model.py`，manifest 记 `sourceFile` + `backend.kernel/version`；`scadCode` 路径行为不变。
- `cad_session` action `info` 增加 `kernel`/`kernelSource`；`init_project({defaultKernel})` 可写项目默认，优先级：项目 marker → 全局 `backend.json`。
- 作者文档：`docs/llm/cadquery.md`（中英）；示例：`examples/cadquery/bracket.py`（4 孔 + R4 + 4 类 datum）。
- skill `cad-modeling-measure` 顶部明确：kernel=cadquery 时走 `code` + CQ GUIDE，OpenSCAD 陷阱只适用于 openscad。
- 验收：`accept:cadquery-authoring` **16/16**（真实工具链：init→info→generate→版本 pin→bbox/render→拒绝双源）；`accept:cadquery` 23/23、`accept:step-validation` 23/23。

### 4.13 L1.9 安装时内核选择（已实现）

- `dsh-cad-setup` 新增 `--kernel openscad|cadquery`；TTY 且未给 flag、未 `--json`/`--check`/`--no-interactive` 时询问，默认 OpenSCAD。
- 选择写入 `$DSH_HOME/cad/backend.json`，保留已有 `compileBackend`/`binaryPath`；`--check` 只读，不改配置。
- 选 CadQuery 时只打印“pack 需显式安装（~1.6 GiB）”，不自动下载；OpenSCAD 仍是渲染/导出的常驻依赖。
- 验收：`accept:setup-kernel` **10/10**（显式 cadquery、默认 openscad、保留 options、未知内核、`--check` 只读）。

### 4.14 L1.10 会话内核上下文（已实现）

- `src/host/kernel-context.ts` 在 `agent/created`/预设切换时注册 per-agent 的 `cad-kernel` prompt context；只有 CAD preset / 无 preset（headless）会话注入，标准编码会话不付这份上下文。
- 文本：`CAD authoring kernel: cadquery|openscad (project|global)`。CQ 明确 `generate_part({code})`、`result/show_object`、禁止 scadCode；SCAD 明确 `generate_part({scadCode})`。这样模型在写第一行代码前就知道内核，而不是先猜再 `cad_session info`。
- 解析优先级与会话工具一致：项目 `defaultKernel` → 全局 `backend.json`；provider 每次组装重新读，setup/运行期切换下一次请求即生效。
- 无 `systemPrompt` 服务的 headless profile 只是不注入，不影响工具或 `cad_session info`。
- 验收：`accept:kernel-context` **10/10**（CAD/标准/无 preset、项目优先、切换 dispose/reinstall、无 prompt 服务不炸）。

### 4.15 L1.6 验收与跨内核回归（已实现）

**环境（2026-11-20，Linux x64）：** Node 26.13.1，dsh 0.2.2-rc.1，OpenSCAD 2026.09.23（Manifold），bundled Python runtime ready；CadQuery pack 在验证后已移除（1.6 GiB 临时安装，仅用于真实编译数字）。

| 验收 | 结果 | 说明 |
|---|---|---|
| `accept:engine-seam` | **14/14** | 注册/未知/拒绝/fake engine；OpenSCAD 默认不变 |
| `accept:cadquery` | **23/23**（有 pack） | bracket 编译、datum、错误分类、STEP/BRep；无 pack 时真实段 SKIP |
| `accept:kernel-switch` | **15/15** | v001 SCAD → v002 CQ；旧版本不重编译；CQ job 先返回 running |
| `accept:step-validation` | **23/23** | STL Manifold；STEP `import_mesh` + BRepCheck；datums/hash/mismatch/坏 STL |
| `accept:cadquery-authoring` | **16/16**（有 pack） | `generate_part({code})` 端到端、STEP、版本 pin、bbox、render |
| `accept:kernel-context` | **10/10** | 每会话内核上下文；项目优先；切换 dispose/reinstall |
| `accept:setup` / `accept:setup-kernel` | **11/11 / 10/10** | 预设、`--kernel`、默认/保留/拒绝 |
| `accept:doctor` | **21/21** | 两个内核状态；pack 缺失为 warn |
| `accept:preview` | **exit 0**（有 pack）/ 无 pack 亦 0 | 全链路；发布门 `accept:release` 强制 pack，不允许 SKIP 伪装 |

**跨平台：** Windows/macOS **未实跑**，因此不声明通过；发布说明只写 Linux 实测与平台 smoke 待办。代码已去掉 Linux 专用的无条件 `xvfb-run`、`new URL().pathname` 和 `:` 路径分隔假设；仍需真机 smoke。CadQuery 的 EGL/OSMesa 渲染问题不影响本步（渲染仍走 OpenSCAD）。

**改动规模：** 当前 `git diff --stat` 53 files / +1742/−483（27 个 package 内源码/脚本；审计后又修了跨平台、job、遍历、导出、solid、types 等）。核心触点仍是 seam 的必需触点（provider、compile、tools、version/jobs、assembly/export、validation、kernel context、setup），不是散落改动。

**发布门：** `DSH_CAD_REQUIRE_CQ=1` 下跑 `npm run accept:release`（内部跑 `accept:preview` + `accept:step-validation`）；缺 pack 直接失败，不再把 SKIP 当绿。

### 4.16 干净 Linux 安装的内核选择验证（2026-11-20）

在**解包后的 npm tarball**（`0.1.1-preview.1`，不是源码 checkout）上，用临时 `HOME`/`DSH_HOME`、
`--openscad=off` 和 PTY（`socat ... EXEC:...,pty,raw`）验证：

- 输入 `2` → `dsh-cad-setup` 提示 CadQuery、写入 `backend.json {kernel:"cadquery"}`、预设生成成功、exit 0；
- 直接回车 → 默认 OpenSCAD、写入 `{kernel:"openscad"}`、exit 0；
- 运行时 `scripts/backend.mjs --show --json` 能读回所选 kernel；`dsh-cad-setup` 的 `--kernel`/
  `--no-interactive` 非交互路径由 `accept:setup-kernel` 覆盖。

限制：这是 Linux x64 的 clean-tarball 验证；Windows/macOS 仍未实机 smoke。

### 4.17 OpenSCAD 版本选择：最高版本优先（2026-11-20）

- 编译解析、`dsh-cad-provision`、`doctor` 都探测所有候选并按版本号最高者选择；系统 PATH /
  `CAD_OPENSCAD_BIN` / `backend.json` 的旧版本不再因为“先命中”而覆盖插件内高版本快照。
- 同版本时保留 env/backend/plugin/PATH 的显式优先级；`compile.ts` 同时修正了源码 checkout 下
  插件快照路径（`<plugin>/src/../../bin`）与 bundled 路径（`<plugin>/../bin`）。
- 验证：`accept:backend` **24/24**（fake 旧 `CAD_OPENSCAD_BIN` 与旧 PATH 均不得覆盖插件 2026.09.23）；
  `accept-provision` 22/22；`provision --check` 返回 plugin 2026.09.23；`doctor` 报 2026.09.23 + Manifold；
  `setup --openscad=auto` 在系统 2021.01 + 插件 2026.09.23 下把 `binaryPath` 写成插件快照。

### 4.18 GitHub CI 平台矩阵（2026-11-20）

`.github/workflows/preview.yml`：

- `verify`：`ubuntu-latest` + `macos-latest`，build + `accept:preview`；Linux 额外打 tarball 并做解包
  `setup --check`；macOS 用 `provision-openscad` 准备 OpenSCAD。
- `windows-smoke`：build、provision、setup、doctor，并新增 `accept:setup-kernel` / `accept:backend` /
  `accept:engine-seam` / `accept:kernel-context`（Windows 上 TTY 交互不做 CI，flag 路径覆盖）。
- `cadquery`：仅 tag 或手动触发；安装 3.13 + bundled Python runtime + 固定 CadQuery pack，
  跑 `accept:cadquery` / `accept:cadquery-authoring` / `accept:step-validation`；不把 1.6 GiB pack
  变成每次 PR 的税。
- dsh pin 从 `0.2.1-rc.2` 更新到 `0.2.2-rc.1`。
- 触发：`main` push、PR、tag `v0.*`、手动；CQ 只在前两者之外执行。

限制：Windows 仍不是完整 `accept:preview`；macOS 没装 CQ pack；真机首次运行结果需看 GitHub run，
本地只能校验 YAML/脚本。

---

## 5. 排期（4 周 MVP / 6 周稳妥）

| 周 | 内容 |
|---|---|
| 第 1 周 | L1.0 CQ 探针 → L1.1 最小 seam |
| 第 2 周 | L1.2 CadQuery provider（已完成） |
| 第 3 周 | L1.3 源码/版本 pin + L1.4 统一验证（均已完成） |
| 第 4 周 | L1.5 作者层/示例 + L1.6 验收（均已完成）+ L1.7 文档 |
| 发布前 | L1.8 预设对齐 + L1.9 安装内核选择 + L1.10 内核上下文 + `accept:release`（不通过不发） |
| 并行 | U03 `assembly.json` 门槛 |

- 4 周是 MVP：Linux 实跑 + 单件 STEP 可选；Windows/macOS 只做 smoke。
- 6 周是稳妥：含完整跨平台验收、STEP 往返、文档打磨。

---

## 6. 验收清单

- [x] `accept:engine-seam`：注册/未知/拒绝/fake engine；OpenSCAD 行为不变（14/14）。
- [x] `accept:cadquery`：bracket 编译、datum、错误分类、缺包/超时；doctor 探针（23/23，含 STEP/BRep 元数据）。四视图/测量/装配/导出留到 L1.6。
- [x] `accept:step-validation`：STL Manifold；STEP `import_mesh` + BRepCheck；缺失/坏 STEP/mismatch/坏 STL/datums/hash/datum_outside_bbox（23/23）。
- [x] `accept:kernel-switch`：v001 SCAD → v002 CQ；旧版本不被重编译；旧项目零迁移（15/15）。
- [x] `accept:preview` 仍全绿（exit 0；无 pack 时 CQ 真实编译段 SKIP）。
- [x] `dsh-cad-doctor --json` 报两个内核的版本/pack 状态：OpenSCAD 2026.09.23；CadQuery pack 未装 → warn（可选）。
- [x] `git diff --stat`：34 files / 19 package files / 13 core；核心改动集中在 engine seam/provider、compile、tools、version/jobs、assembly/export、validation、kernel context、setup（§4.15）。
- [x] `preset-standard-drift`：把含 `list-agents` 的旧预设放回原位时 `doctor` 报 fail + fix；
      重生成后 pass。（accept:doctor 21/21；手工回放同样结果）
- [x] `prepublishOnly`：`check-release-preset` 用 packed preset 比对目标 dsh，不依赖本机 skill 路径；`setup --check` 仍用于安装后自检。
      （旧预设：`npm publish --dry-run` 退出 1；当前预设：`--tag preview` 下退出 0）
- [x] release notes 记录 preview.2–.5 的已知问题（dsh 0.2.2-rc.1 上无「营造模式」）与修复版本。
      （`RELEASE-NOTES-0.1.1.md` §2）
- [ ] README/DESIGN/limits/install/release notes 同步。
- [ ] pack 安装体积/时间/离线失败有实测记录。

---

## 7. 风险与未决

| 风险 | 影响 | 处置 |
|---|---|---|
| CQ pack 体积/下载时间 | 首用体验 | 最小 pack、进度、镜像、doctor 报体积；不自动下载 |
| OpenSCAD 常驻依赖 | CQ 安装体积增加；用户可能以为可以删 OpenSCAD | 已决定保留；doctor/README 写清“作者引擎 vs 渲染依赖”；不做替换 |
| Python 代码执行 | 安全边界 | 明确“无沙箱”；子进程/超时/临时 cwd；不承诺隔离 |
| OCP 许可/平台 | 分发合规 | 按 wheel 内容审计；不打包；doctor 报平台 |
| STEP 范围膨胀 | 拖慢 0.1.1 | 只做单件直通；ZIP/往返/审计放 0.1.2 |
| U01/U02 排期变更 | 用户预期 | 本文已标注后移；若保留在 0.1.1，需加 3–4 周 |
| 预设随 dsh 版本漂移 | 升级后「营造模式」静默消失（preview.2–.5 已发生一次） | L1.8：doctor 漂移检查 + 发布前检查 + README 升级段；不追求跨版本通用 |
| 版本号口径 | 发布语义 | 已确认：`0.1.1-preview.1`（不要直接发 `0.1.1` 正式版） |

---

## 8. 文档同步

- `README.md`：技术栈、已知边界（STEP 能进不能出的措辞）、安装、**升级 dsh 后重跑
  `dsh-cad-setup`**。
- `DESIGN.md`：引擎 seam、版本 pin、验证边界（B-rep vs 网格证据）。
- `docs/user/limits.md`：pack 大小、OpenSCAD 渲染依赖、Python 执行无沙箱、平台基线。
- `docs/user/install.md`：CadQuery pack 安装/卸载。
- `docs/llm/modeling.md` + `skills/`：CadQuery 作者陷阱与 GUIDE 路由。
- `NOTICE` / `docs/THIRD-PARTY-AUDIT.md`：CadQuery/OCP。
- `docs/dev/RELEASE-NOTES-0.1.1.md`：发布说明与已知问题（含 preview.2–.5 在 dsh 0.2.2-rc.1
  上没有「营造模式」）。

---

## 9. 与 TODO 的关系

- 本文是 0.1.1 的**目标/设计**；[TODO.md](TODO.md) 是**顺序/状态**。
- L1.0–L1.8 是本文的执行项；U03 是并行项。
- 第三个引擎、社区适配不在本文范围；它们的触发条件写在 TODO §3/§5。
