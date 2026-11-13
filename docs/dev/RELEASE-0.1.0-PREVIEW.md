# 0.1.0-preview 发布计划：把外壳补到 L2

> **状态**：P0 13/13 完成；P1 5/6 收口 + N15 只交付 **OpenSCAD 编译 job**（2026-11-13）。证据见 [TODO.md](TODO.md)。
> **英文入口**：README.en.md + docs/en/user 全套 + docs/en/llm + HARNESS.en.md；客户端 UI 文案已全量英文化（`accept:ui-i18n`）。
> **总索引**：[TODO.md](TODO.md)（顺序/状态）；本文件是 0.1.0-preview 的详细设计。
> **目标**：不是把 L2 全部做完，而是让 `0.1.0-preview` 达到四条底线：
> **装得上、查得出、拦得住（但允许带风险导出）、退得回。**
> **口径**：只认能指名观察的证据；"完成"必须能说出哪个观察会证伪它（HARNESS §11.9）。

---

## 0. 预览版 DoD

发布前必须全部为真：

1. 陌生人在干净机器上解压 tarball，**不读源码、不跑 build**，15 分钟内看到第一个版本（不含 Python 运行时下载）。
2. `doctor` 一条命令能区分：没装好 / 没配好 / 项目坏了 / 能力缺包，并给下一步。
3. 被门拦住的项目的产物，**导出时必须弹窗确认，且产物文件名带 `_UNVERIFIED` 标注**；不能静默流出。
4. 带输出契约的工具错误与 export 路由都有 `code + stage + hint`，不需要作者读日志；独立 CLI 仍以 stderr 文本为准。
5. 卸载/升级不会丢项目，也不会留下孤儿进程。
6. release notes 明确写"这是预览版，不承诺生产"。

---

## 1. 已拍板的决策

### 1.1 C1：导出是"风险标注导出"，不是硬阻断

用户决策（2026-11-12）：**blocked 时允许导出，但必须有弹窗 + 文件名双重提示。**

设计要点：

- `pass`：正常导出。
- `difficult`：允许导出，回执/文件内警告；不改文件名（避免把"有保留"误读成"未验证"）。
- `blocked` / `excluded` / 有 blocked-severity finding：
  - Web 面板：弹窗列出 top findings + 未检查项 + next look；必须勾选"我已阅读风险"；
  - 文件名：单版本 `<part>_<version>_UNVERIFIED.<ext>`；整项目 `<project>_UNVERIFIED.zip`；合并 STL `<project>_UNVERIFIED.stl`；
  - 文件内：ZIP 根放 `UNVERIFIED.md` + `export-manifest.json`；
  - 审计：把 override 原因、时间、findings 写进项目 `exports/<exportId>/manifest.json`；
  - 直接 API 调用：无 `confirm=1&reason=...` 时返回 409 JSON，不返回文件。
- 文件名不是安全边界：用户可改名；真正的保证是 manifest + 审计记录。文件名是"第一眼提示"。

**明确不做**：不做"记住本次不再提示"；blocked 每次导出都要重新确认。

### 1.2 A3：OpenSCAD 是默认后端，不是唯一后端

用户决策（2026-11-12）：**安装时允许选择后端，安装后允许切换。**

**产品层只有一个选择：几何内核（kernel）。** `manifold` / `cgal` 不是第二层产品概念，它只是 OpenSCAD 适配器内部的编译选项（高级设置）。

| 层 | 含义 | 预览版 |
|---|---|---|
| `kernel` | 几何内核：OpenSCAD / CadQuery / FreeCAD / … | **只交付 OpenSCAD 适配器**；其他登记为 `planned`，不可选 |
| OpenSCAD 适配器内部 | `manifold` / `cgal` / `auto` | 可作为高级选项切换，不进入主流程 |

预览版承诺：

- `setup --openscad=auto` 自动准备 OpenSCAD（>= 2025.06 才有 Manifold）：系统已有就用，
  没有则官方快照优先、官方不可达/过慢才切 OSS；插件不随包分发内核。
- `dsh-cad-backend` 在安装时/运行时选择 kernel 与 compileBackend，写入 `$DSH_HOME/cad/backend.json`；
  `doctor` 校验路径、版本和可选后端。
- 未实现的内核显示 `planned`（禁用），API 返回 `backend_not_available` + 原因，不静默回退。
- 新版本记录 `{kernel, options, version}`，旧版本不重写（N03/N04 已接线）。

**关键区分**：选择器 + 配置 + 校验是 1–2 天；**让一个内核真正可被本工具链消费**是适配器工作。
"能装"不等于"能用"，难点在源码语言、datum 声明、编译/渲染、错误语义和测试矩阵。

**待确认**：如果"不同后端"指预览版就要带第二个**可工作的几何内核**（CadQuery/FreeCAD），那是另一个 2–3 周/内核的项目，不在此计划内。

### 1.3 A2：预设 skill 路径必须由安装时生成

`presets/cad/preset.patch.yml` 当前硬编码本机绝对路径：

```yaml
customSkillDirs:
  - /home/songsenand/Project/ToyMarker/dsh-cad-harness/skills
```

换机器/换目录后工具还在、skill 静默消失。预览版必须改成：

- `prepack` 打包时**去掉** skill-provider 行（不把打包机的绝对路径带进包）；
- `dsh-cad-setup` 在安装时从已安装的 `standard.patch.yml` 重新生成 `preset.patch.yml`，
  写入本机包根的 `skills/` 绝对路径；
- `postpack` 恢复 checkout 的开发用 preset；`prepack` / CI 检查包内无 `/home/`；
- `doctor` 验证 5 个 skill 都能加载、preset 指向当前 `skills/`。

---

## 2. 工作流与优先级

> 估时按 1 人计，粗估。P0 = 不发这个版本就别叫预览；P1 = 可带 known issue，但必须在文档和 doctor 里显性化；P2 = 预览后。
> **下表“现状/缺口”保留开工前口径，不等于当前状态；当前完成情况见 §6.5 与 TODO。**

| ID | P | 工作项 | 现状 / 缺口 | 完成判据（可证伪） | 估时 |
|---|---|---|---|---|---|
| **A1** | P0 | 发布物与构建 | `private: true`、无 `prepack`、`files` 不含 `scripts/` 和 `docs/`；`lib/` 需先 build | 干净机解压 tarball → `dsh plugin add -w` → 面板加载；全程不跑 build；包内 `lib/index.js` 存在且比 `src` 新 | 1.5d |
| **A2** | P0 | 预设 skill 路径 | 硬编码本机绝对路径；无 setup 命令 | `prepack` 去行 + `dsh-cad-setup` 生成；包内无 `/home/`；换路径后 5 个 skill 全可见 | 2–3d |
| **A3a** | P0 | 内核选择面 | 无 install-time 选择；OpenSCAD 路径/版本写死 | `dsh-cad-backend` 列出内核（预览：OpenSCAD available，cadquery/freecad planned）；写入 `backend.json`；`doctor` 打印 kernel/compileBackend；未知内核拒绝 | 1–2d |
| **A3b** | P0 | 适配器契约 | 无 backend 接口；`generate_part` 只收 `scadCode`；datum/render/parse 都是 SCAD 专用 | `CadBackend` 接口 + OpenSCAD adapter 抽出；现有 5 个工具路径行为不变；未知内核显式拒绝 | 3–4d |
| **A3c** | P2 | 第二个内核 | 无 CadQuery/FreeCAD 适配器 | 每个内核 2–3 周：源码语言、datum、编译/渲染、错误语义、测试矩阵 | 2–3w/内核 |
| **A4** | P0 | Python 首启 | 400MB 下载只有"首次慢"，无进度/重试/离线错误 | 断网/超时/磁盘不足各返回 code+fix；有进度和重试；`DSH_CAD_PYTHON=system` 可用 | 2–3d |
| **A5** | P0 | 版本/兼容矩阵 | 依赖钉 0.1.5-rc.3，宿主 0.2.1-rc.2；无 `engines`/peer；无版本暴露 | `doctor` 打印 dsh/plugin/node；不兼容 fail 并给范围；CI 在声明支持的 dsh 上过 | 1d |
| **B1** | P0 | `doctor` 环境自检 | 只有交付用 `preflight`，没有安装/环境诊断 | `dsh-cad-doctor` 一条命令 `kind=ok`；8 种坏环境各唯一 kind+fix；`--json`；面板状态页 | 2–3d |
| **B2** | P1 | 空状态/错误页 | 已实现：环境提示与空状态 | 未选预设/运行时未就绪/缺包/面板空白各一条可操作文案 | 0.5–1d |
| **C1a** | P0 | 导出弹窗 | 导出无审计；`deliver` 只读；`verify --block` 是独立 CLI | blocked 导出先 409 JSON；面板弹窗列 findings；必须勾选确认；`difficult` 不弹窗 | 1–2d |
| **C1b** | P0 | 文件名/清单/审计 | 无 `_UNVERIFIED`；无 export manifest | 单版本/整项目/合并 STL 三条路径都带后缀；ZIP 含 `UNVERIFIED.md` + `export-manifest.json`；项目 `exports/<id>/manifest.json` 可查 | 1–2d |
| **C1c** | P0 | 自动化 override | 无 CLI 导出策略 | 无 `confirm=1` 的 HTTP 调用返回 409；`confirm=1&reason=...` 才写文件；reason 为空返回 400；导出记录留 override | 0.5–1d |
| **C2** | P0 | `verify` 随包 | `scripts/verify.mjs` import `.ts`，不在 `files`；Node 20 跑不了 | 干净安装后 `dsh-cad-verify` 可跑；不依赖 repo checkout；Node 20/22 行为写清 | 1d |
| **D1** | P1 | 异步作业/取消 | 编译 job 已实现；渲染/仿真仍同步 | submit 返回 id；cancel 后进程消失；重启后 list 有记录；timeout 标 timeout | 3–5d |
| **D2** | P1 | 错误分类 | 已实现：工具错误挂 code/stage/hint/cause | 统一 `{code,stage,hint,cause}`；6 类故障注入各一码；日志带 runId | 1–2d |
| **D3** | P1 | 资源清理 | 已实现：clean/10 连消/并发闸/孤儿清理 | 10 次取消无孤儿；临时目录有上限；并发有闸 | 1–2d |
| **E1** | P0 | 最小 CI | 无 `.github`，发布靠手工 | tag 触发：typecheck + build + 核心 accept + 干净安装 + doctor + 立方体示例；失败不出包 | 2–3d |
| **E2** | P0 | 发布文档 | 安装文档假设源码/作者；无 known issues | 陌生人在干净 VM 15 分钟出 v001；known issues/预览语义/卸载/数据位置齐全 | 1–2d |
| **E3** | P1 | 许可/第三方 | 已实现：LICENSE/NOTICE 进包，无 GPL 二进制 | 预览不含未合规 GPL 二进制；NOTICE/THIRD-PARTY 更新；BOSL2 缺失有明确降级 | 0.5–1d |
| **E4** | P1 | 项目 schema/迁移 | 已实现：doctor schema 检查 + 备份/拒绝策略 | 旧项目能开；未知新 schema 拒绝并说明；迁移前备份 | 1–2d |
| **F1** | P2 | 审批/回滚 | `limits.md` 明说没有 | 实现或 release notes 明示"预览不支持" | — |
| **F2** | P2 | L0-first 证据分级 | 无分级 | 预览后做 | — |
| **F3** | P2 | 参考图量测 | 只有 `recall_reference_image` | 预览后做 | — |

---

## 3. C1 详细设计：风险标注导出

### 3.1 判定来源

导出前统一调用 `auditDelivery` + `verify` 的 policy：

- 有 blocked-severity finding，或 policy 的 `blockOn` 命中 → `blocked`；
- 只有 `difficult` / warn → `difficult`；
- 无 claims 且 policy 为 advisory → `pass`（但 manifest 记 `advisory`）。

不允许"某个导出路径忘了审"：单版本导出、整项目 ZIP、合并 STL、装配导出都必须走同一个 `preExportAudit()`。

### 3.2 弹窗

- 标题：`此版本未通过验证`
- 内容：verdict、top 5 findings（code / 位置 / 实测 vs 要求）、`notCovered` 列表、next look。
- 必勾：`我已阅读以上风险，仍要导出`。
- 原因：可选，默认 `user override`；填写后进 manifest。
- 按钮：`仍要导出（未验证）` / `取消`。
- 弹窗里显示最终文件名，避免用户导出后才发现后缀。

### 3.3 文件名规则

```text
单版本:   <part>_<version>_UNVERIFIED.<ext>
整项目:   <project>_UNVERIFIED.zip
合并 STL: <project>_UNVERIFIED.stl
```

- Windows 安全字符；总长度 <= 120；保留扩展名。
- ZIP 内部：`UNVERIFIED.md` + `export-manifest.json` 放根；零件文件保持原名（避免切片软件里全是后缀）。
- 用户改名后后缀消失，但 sidecar/manifest 仍在；文档明确"文件名是提示，不是保证"。

### 3.4 Manifest

```json
{
  "schemaVersion": 1,
  "exportId": "exp-20261112-001",
  "exportedAt": "2026-11-12T12:00:00+08:00",
  "project": "…",
  "verdict": "blocked",
  "findings": [{ "code": "…", "severity": "blocked", "detail": "…" }],
  "notCovered": ["…"],
  "versions": ["v012"],
  "policy": { "mode": "blocking" },
  "override": { "reason": "…", "confirmedAt": "…", "surface": "web" },
  "files": [{ "path": "…", "sha256": "…" }]
}
```

### 3.5 验收用例

1. blocked 零件直接 `GET` 导出 → 409 JSON，不写文件。
2. 面板导出 → 弹窗；不勾选时按钮禁用；勾选后文件名带 `_UNVERIFIED`。
3. blocked 项目 ZIP → 文件名带后缀，ZIP 内有 `UNVERIFIED.md` 和 manifest。
4. `difficult` → 不弹窗，manifest 记 `difficult`。
5. `pass` → 无后缀、无弹窗。
6. 自动化路径：无 `confirm=1` → 409；`confirm=1` 缺 `reason` → 400；有 reason → 200 + manifest。
7. 改名导出物 → sidecar/manifest 仍能追溯。
8. 两条导出路径都拦：单版本 + 整项目。

---

## 4. A3 详细设计：内核选择，不是"编译后端选择"

### 4.1 协议层没绑定，实现层绑定了

**你说得对**：HARNESS 的定位是"模型输出意图/引用，几何引擎解析真值"，这条协议不绑定 OpenSCAD。但当前的实现确实绑定了：

| 环节 | 现在的绑定 | 证据 |
|---|---|---|
| 代码生成 | `create_part` 的参数叫 `scadCode`，描述写"Complete OpenSCAD source"；版本文件是 `model.scad` | `src/host/tools.ts:979-985` |
| 编译 | `compile.ts` 直接 `spawnOpenscad`，参数是 `--export-format binstl`、`--backend=Manifold`、`--camera`、`xvfb-run` | `src/host/compile.ts:220-376` |
| datum | `datum()` 是 SCAD 顶层函数；编译前把 `datumPrelude()` 前置进 SCAD | `src/host/compile.ts:367-373` |
| 渲染 | `renderScadPng` 走 OpenSCAD 的 `--render`/`--camera` | `src/host/compile.ts:290-313` |
| 参数解析 | `parseParams` 调 Python 的 `scad_parse_params` | `src/host/compile.ts:329` |
| 工具面 | `simulate_physics`/`simulate_stress`/装配渲染等大量工具接受内联 `scadCode` | `src/host/tools.ts:81, 1685, 1849` |
| skill | 5 个 skill 教的是 SCAD 语法、BOSL2、$fn、OpenSCAD 陷阱 | `dsh-cad-harness/skills/` |
| 测试 | accept 脚本默认跑 OpenSCAD，没有第二内核矩阵 | `dsh-cad-harness/scripts/accept-*` |

**STL 边界是干净的**：测量、物理、装配、流体都只吃 `model.stl`，这部分确实与内核无关。绑定发生在 **STL 之前**：模型写什么源码、怎么编译、怎么渲染、怎么声明 datum。

### 4.2 为什么"现场下载"不解决这个问题

下载只是把二进制放进机器。真正决定"能不能用"的是适配器契约：

1. **源码语言不同**：OpenSCAD 是 `.scad` 声明式；CadQuery/Build123d 是 Python；FreeCAD 是 Python API + 文档对象。`create_part` 不能只把 `scadCode` 改名就完事——prompt、skill、示例、错误修复策略都要换一套。
2. **执行方式不同**：OpenSCAD 是单进程 CLI；CadQuery 要 Python 环境 + OCCT；FreeCAD 要 GUI/headless + 文档生命周期。超时、退出码、临时文件、并发模型都不一样。
3. **datum 声明不同**：`datum()` 是 SCAD 函数。换内核要么定义一套与语言无关的 datum 清单（在源码外声明），要么每个内核实现自己的 datum 注入。
4. **渲染路径不同**：OpenSCAD 直接出 PNG；其他内核要么自己渲染，要么统一"编译成 STL → 用 three.js 出图"。后者可行，但要改视觉循环的证据链。
5. **安装面不同**：OpenSCAD 是一个可执行文件；CadQuery 是 Python 包 + OCCT；FreeCAD 是数百 MB 的应用。三平台、代理、离线、版本钉住、许可证，都是持续成本。
6. **测试矩阵**：每个内核 × 平台 × 核心操作都要有 E2E；否则"能装"会被误读成"能用"。

一句话：**选择器是 1–2 天，适配器是 1–2 周，第二个内核是 2–3 周。** 不是下载难，是"让模型写对这门语言、让工具链正确消费它"难。

### 4.3 预览版的契约

产品层只暴露 `kernel`：

```json
{
  "kernel": "openscad",
  "options": { "compileBackend": "auto" }
}
```

`options` 是内核私有配置，不进主流程；OpenSCAD 的 `manifold`/`cgal` 只是这里的一个选项。

适配器接口：

```ts
interface CadBackend {
  id: string;                 // openscad
  label: string;
  sourceLanguage: 'scad' | 'py';
  fileExtension: string;
  capabilities: { exactCsg: boolean; manifold: boolean; twoD: boolean };
  detect(): Promise<{ ok: boolean; version?: string; reason?: string }>;
  installHint(): string;
  compile(req: CompileRequest): Promise<CompileResult>;
  render(req: RenderRequest): Promise<RenderResult>;
}
```

预览版只注册 `openscad`。`cadquery` / `freecad` 以 `planned` 条目出现在目录里，`select` 返回 `backend_not_available`，不静默回退。

### 4.4 安装时与运行时

- `dsh-cad-backend`：列出真能工作的内核（预览只有 OpenSCAD）；写 `$DSH_HOME/cad/backend.json`；`--show` 查看。
- `set_backend` 工具/面板：校验、写项目 pin、警告"旧版本保留旧后端"。
- `doctor`：打印 `kernel / binary / version / capabilities`；OpenSCAD 适配器额外打印 compileBackend。

### 4.5 版本记录

`versions/<id>/manifest.json` 增加：

```json
"backend": { "kernel": "openscad", "version": "2025.06", "options": { "compileBackend": "manifold" } }
```

旧版本不重写；切换只影响新版本。装配允许混合内核（几何以 STL 进入装配），但测量/运行记录必须带 backend。

---

## 5. A2 详细设计：安装时生成预设

- 生成逻辑在 `scripts/preset-lib.mjs`，`sync-cad-preset.mjs` 与 `setup.mjs` 共用，避免两套文本变换。
- `prepack`：构建 `lib/`，然后 `sync-cad-preset --without-skills`（tarball 里没有打包机路径）；
  `postpack` 恢复 checkout 的开发用 preset。
- `dsh-cad-setup`：
  1. 从 `import.meta.url` 解析包根；
  2. 从已安装的 `standard.patch.yml` 生成完整 preset，写入包根 `skills/` 的绝对路径；
  3. 原子写入 `presets/cad/preset.patch.yml`；包目录只读时明确报错；
  4. `doctor` 验证 5 个 `SKILL.md` 存在、preset 指向当前 `skills/`。
- 回退：未跑 setup 时，CAD 工具可用但 skill 缺失；doctor 明确说 `preset-skill-path: fail`，
  fix 是 `npx dsh-cad-setup`。

---

## 6. 排期

**发布形态**：首发 GitHub Release tarball（内置 `lib/`），`private` 暂时保持 `true`，不同时上 npm。

| 时间 | 线 A | 线 B |
|---|---|---|
| D1–D2 | A1 发布物、A5 版本矩阵 | B1 doctor 骨架 |
| D3–D5 | A2 setup/预设、C2 verify 随包 | C1 弹窗 + manifest + 审计 |
| D5–D8 | A3 backend 配置/切换、A4 Python 首启 | E1 CI、E2 文档 |
| D9–D10 | 干净 VM 演练（Linux + macOS） | 修演练问题 |
| D11 | 打 `v0.1.0-preview.1` | release notes |

2 人约 2.5–3 周；1 人约 4–5 周。若必须 2 周，先砍 A3 到"只支持 OpenSCAD + manifold/cgal 切换"，把 kernel registry 放 preview.2。

---

## 6.5 已知边界（0.1.0-preview）

- **UI 双语是部分覆盖**：标签页、环境提示、导出弹窗、主要空状态已中英切换；深层面板仍中文。
- **英文文档**：英文用户文档全套 + `docs/en/llm` + `HARNESS.en.md`；`docs/dev` 仍中文。
- **英文 UI**：客户端可见文案全量英文化，`accept:ui-i18n` 扫描字符串字面量；host 的模型侧工具输出/诊断仍中文（不是 UI 文案）。
- **后台 job 只覆盖 OpenSCAD 编译**：submit/status/cancel/timeout/重启恢复/孤儿清理已验收；渲染与仿真仍同步。
- **GitHub Actions 未实际运行**：workflow 已写并在本地 `rehearse:preview` 通过；推送/tag 待网络。
- **A4 的真实断网/磁盘满注入未跑**：分类器与 state 落盘已测；真实网络故障仍靠现场。
- **OpenSCAD 2021.01 可用但 degraded**：2025.06+ 推荐（Manifold）。这不是安装失败。
- **没有第二个几何内核**：CadQuery/FreeCAD 是 planned，不可选、不静默回退。
- **没有自动迁移器**：schema 不匹配时 doctor 拒绝并给备份说明；迁移需人工。
- **导出是风险标注，不是放行**：`_UNVERIFIED` 是提示，不是安全边界。

## 7. 明确不做（scope freeze）

- 不加新几何能力、不加新工具；
- 不追 228 op catalog；
- 不做 Blender/GUI 实时回路；
- 不做 L0-first 证据分级、参考图量测；
- 不做多用户/云/移动端；
- 不换内核、不重写 Python 供给；
- 不在 preview 里带第二个几何内核（除非重排期）。

---

## 8. 风险

1. **A2 静默失败**：路径错了不报错，只丢 skill；必须第一个修。
2. **A3 范围蔓延**：backend 抽象容易变成"重写编译器"；预览只做配置 + OpenSCAD 适配 + 切换 UI。
3. **C1 被当成放行**：文件名/manifest 是提示，不是合格证；release notes 必须写清"导出不等于通过"。
4. **CI 缺位**：没有干净安装 smoke，P0 全是手动验证，发布不可重复。

---

## 9. 已落决策

- [x] C1 的“风险标注导出”已写进 `DECISION-LOG`（2026-11-12）。
- [x] A3 预览只交付 OpenSCAD；其他内核 `planned`，不静默回退。
- [x] 发布形态：GitHub Release tarball；不上 npm。
- [x] OpenSCAD：2021.01 可跑但 degraded；推荐 2025.06+。
