# 零件设计 Harness 设计文档

> **文件名**：本文件原名 `DESGIGN.md`（拼写错误），2026-10-13 更正为 `DESIGN.md`。
> 历史记录——`docs/archive/execution_summaries/`、`experiments/`、`verification/`、
> `examples/*/execution_summaries/`、以及 `docs/DECISION-LOG.md` 的**既有条目**——
> 是按发生时的事实留档的，其中出现的 `DESGIGN.md` 一律指本文件，**不回改**。
> 活文档与代码里的引用已全部更新。

**版本**：v2.0
**目标读者**：编码 Agent
**场景**：开放的 CAD harness（2026-09-27 起，原为小团队内部工具）；定位与哲学见 HARNESS.md
**底座**：dsh 插件

---

## 1. 项目概述

一个基于 dsh 的零件设计辅助插件。用户用自然语言描述想要的零件，插件驱动 Agent 完成：生成 OpenSCAD 代码、编译、渲染、视觉评审、迭代修改，并对零件做装配验证、刚体物理验证和流体仿真验证。

**核心循环**：

```
用户描述 → 生成/修改 SCAD → 编译 → 渲染多视角 → 多模态评审
   ↑                                                  ↓
   └────────────── 反馈 + 新代码 ←────────────────────┘
```

**验证层**（视觉循环之外，按需触发）：
- 装配间隙验证（几何布尔）
- 轻量刚体物理（rapier）
- MPM 流体仿真（CPU 离线内核已交付；M4R 起场景代码归 LLM，结果可视化为一等公民）
- MPM 分析（v2.4 重定义：插件供数据与渲染，解读归 LLM）

---

## 2. 范围界定

### 2.1 做

| 模块 | 状态 |
|---|---|
| OpenSCAD 代码生成与迭代 | 完整实现 |
| Manifold 后端编译 | 完整实现 |
| Three.js 多视角渲染 | 完整实现 |
| 多模态 LLM 视觉评审循环 | 完整实现 |
| 装配间隙数值验证 | 完整实现 |
| 轻量刚体物理仿真（rapier） | 完整实现 |
| MPM 流体仿真 | CPU 离线内核已交付（M4）；M4R：库化开放给 LLM（自有 shell + 真实模块，无专用场景 API） |
| LBM 通用 CFD（阶段 A：通道模板） | 引擎落地（2026-10-15）：XLB 进 hash 锁 + worker `lbm_channel` + `simulate_lbm` 工具面；三处上游规避带验收探测器（§29） |
| MPM 结果可视化 | M4R 主线：面板粒子回放 + 渲染参数化进库 + 帧数据落盘（可视化一等公民） |
| MPM 结果 → 修改建议 | ~~规则引擎~~ 取消（v2.4）：插件供数据与渲染，解读归 LLM |
| 版本管理 | 完整实现 |

### 2.2 不做

- MPM 结果驱动自动代码修改闭环
- 精确 FEA / 应力分析
- 工业级 CFD / 精确流场数值保证（MPM 产出是趋势判断；v2.4 起场景表达开放给 LLM 脚本。2026-10-15 起 `simulate_lbm` 提供真实 NS 方程的通道级模板（§29），仍非工业级保证——无湍流模型、无嵌固件、网格即盒子）
- 工业级公差、工程图、BOM
- 多用户、权限、云部署
- 移动端适配
- 网格修复（依赖 Manifold 保证水密）
- 公开发布到 npm / 社区插件市场

---

## 3. 为什么基于 dsh 做插件

不 fork dsh，不改 dsh 源码。所有零件设计能力封装为一个 dsh 插件包。

**原因**：

- dsh 的核心设计是「一切皆插件」，模型适配器、工具、会话、主循环都是可替换插件。扩展不需要碰核心。
- 插件机制天然支持 Host/Client 半边架构，正好对应本项目的需求：Node 侧跑编译和验证，浏览器侧跑渲染和仿真。
- dsh 已提供 Agent 循环、工具调用、会话管理、LLM 接入、Web UI。这些通用基础设施不需要重写。
- 官方更新时，插件通常无需改动或仅需微小适配。Fork 则需要每次手动合并，维护成本极高。

---

## 4. 架构

### 4.1 整体结构

```
┌─────────────────────────────────────────────────────────┐
│  dsh 运行时（已有，不重写）                              │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Agent 循环、工具调用、会话、LLM 接入、Web UI     │  │
│  └──────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────┐  │
│  │  零件设计插件 (dsh-cad-harness)                   │  │
│  │                                                   │  │
│  │  ┌─── Host 半 (Node.js) ──────────────────────┐  │  │
│  │  │  generate_part 工具                        │  │  │
│  │  │    ├─ SCAD 生成（调 LLM）                  │  │  │
│  │  │    ├─ OpenSCAD CLI 编译 (Manifold)         │  │  │
│  │  │    └─ 版本写入                              │  │  │
│  │  │  validate_assembly 工具                    │  │  │
│  │  │    └─ 布尔交集 + 最小距离                   │  │  │
│  │  │  postprocess_mpm 工具                      │  │  │
│  │  │    └─ 统计量 + 规则引擎建议                 │  │  │
│  │  └────────────────────────────────────────────┘  │  │
│  │                                                   │  │
│  │  ┌─── Client 半 (浏览器) ─────────────────────┐  │  │
│  │  │  3D 预览面板 (Three.js)                    │  │  │
│  │  │  多视角渲染 + 拼图截图                      │  │  │
│  │  │  刚体物理面板 (rapier)                     │  │  │
│  │  │  MPM 仿真面板 (WebGPU)                     │  │  │
│  │  │  产物浏览器（版本 + 运行）                    │  │  │
│  │  └────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 4.2 Host / Client 分工

> **v2.9 更正**：下表为 M1 期规划。实作中**多视角渲染/拼图、刚体物理、机构运动、MPM 流体全部在 Host 侧 headless 完成**（§13.2/§13.4/§13.6/§13.7）；Client 侧保留了交互面板、参数/预览面板与产物浏览器（版本几何 + 运行回放，v2.13 起不再有模式 Tab）。

| 能力 | Host (Node) | Client (浏览器) |
|---|---|---|
| SCAD 生成 | ✅ 调 LLM | |
| OpenSCAD 编译 | ✅ 调 CLI | |
| 多视角渲染 + 拼图 | ✅ OpenSCAD CLI（v2.9 更正） | |
| 视觉评审 | ✅ 调多模态 LLM | |
| 装配间隙验证 | ✅ 布尔运算 | |
| 刚体物理仿真 | ✅ rapier headless（v2.9 更正） | |
| 机构运动仿真（M3.6） | ✅ rapier 约束 + Manifold 干涉时间线（v2.9 补） | |
| MPM 流体仿真 | ✅ CPU MLS-MPM（v2.9 更正；WebGPU 移交后续交互面板） | |
| MPM 后处理统计 | ~~取消~~（v2.4：规则引擎与固定统计归 LLM 脚本） | |
| 面板预览 / 回放 | | ✅ three.js（产物驱动：版本→几何，运行→回放/静置，无模式 Tab） |
| 版本管理 | ✅ 文件系统 | |
| UI | | ✅ dsh Web UI |

### 4.3 关键决策

> **v2.12 更正（2026-09-28）**：本节原有 8 条，其中 4 条已被后续里程碑推翻（渲染/物理位置、评审模型、RPC 接线、面板挂载点）。以下按当前实作重写，保留原决策的理由以备追溯。

- **几何编译在 Host，且是两轨**（原决策成立，细节补充）：**SCAD 求值与 STL/PNG 走 OpenSCAD snapshot CLI**（OpenSCAD 自身的 Manifold WASM 构建不稳定，本地 CLI 更可靠）；**几何布尔/体积/水密走 `manifold-3d` WASM 进程内**（M2 决策，§13.3——无子进程开销、无 X 依赖、比 CGAL 快 1-18×）
- **渲染与全部物理仿真都在 Host headless**（⚠️ 推翻原文「渲染和物理在 Client」）：四视角渲染走 OpenSCAD CLI；rapier 刚体、机构约束、MPM 流体全在 Node 跑。理由：headless profile 可直接验收、无浏览器往返、CPU 浮点确定性使断言可重复；Client 侧只保留交互预览与按运行寻址的回放（v2.13）
- **无插件侧 LLM 调用**（⚠️ 推翻原文「LLM 调用在 Host + 评审模型 DeepSeek v4.1 flash」）：M1 起视觉评审原生化——生成工具直接返回渲染图，**会话模型自己看**（§13.2）。API key 由 dsh 管理；图片经 `ctx.attachments` 走附件机制（**只能落 `user` role**，这是适配器约束）。插件对具体模型无绑定（沙箱实测跑过 glm-5.3-flash 与 deepseek 系适配器）
- **Client 半走静态客户端插件**（成立，细节更正）：`dsh.client.platform = 'web'`，**无 `entry` 字段**（宿主按 `./client` 导出取 `lib/client.js`）；`external` 仅声明 `@deepseek-ai/dsh-api-session-controller/client`（React 由 ModuleLoader 平台模块表提供，无需声明）；three / rapier / three-mesh-bvh 打进插件 bundle，manifold-3d 在 Host 侧为 external
- **Host↔Client 通信：业务不用 RPC**（⚠️ 推翻原文「Remote RPC」）：浏览器能力全部经 `connection.fetch.register` 精确路由（GET 二进制/报告，POST 运行与预览）；只剩 M0 遗留的 `cad/echo` RPC 探针。`connection` 用 `ctx.reflect.get` 轮询获取而非 inject——headless profile 无该服务，路由整段跳过
- **UI 面板挂在右栏 Tab**（⚠️ 更正原文「layout `main` slot」）：`sidebarRightTabs.register` 声明 tab 类型 + `slots.register('sidebar.right.pane.tab')` 注册主体 + `sidebarRight.openTab` 自动打开（含 dock 挂载重试与会话切换重开）；会话保持中栏
- **不引入 Vite**（成立）：Client 半用自带 esbuild 构建；dsh 不提供插件构建服务，`lib/client.js` 必须由插件仓库自己产出

---

## 5. 插件结构

> **v2.11 回填（2026-09-28）**：本节原为 M1 期规划（含 `llm.ts`、`mpm-postprocess.ts`、`config.ts`、`client/{viewer,render,physics,mpm}.ts`、`panels/*.tsx` 等**实作中不存在的文件**）。以下按当前代码树回填。

### 5.1 目录结构

```
dsh-cad-harness/
  package.json           # dsh.bundle.patch + dsh.client 声明（platform: 'web'）
  cordis.patch.yml       # 宿主插件补丁层（package.json 的 dsh.bundle.patch 指向它）
  esbuild.mjs            # 构建：Host → lib/index.js（ESM bundle）；Client → lib/client.js（ModuleLoader 工厂 CJS）
  tsconfig.json
  src/
    shared/types.ts      # Host/Client 共享类型
    host/
      index.ts           # 插件入口：inject ['tools','attachments']；注册工具 +（web profile 时）cad/echo RPC 探针
      tools.ts           # 10 个工具的注册 + 全部 /api/cad/* 精确路由（路由集中于此）
      compile.ts         # OpenSCAD CLI 封装、datum 前置区、参数解析、多格式导出、PNG 渲染
      version.ts         # 版本库（vNNN 不可变 + manifest.json 索引 + datums.json）
      manifest.ts        # 装配清单 assembly.json：读写/结构校验/遍历（节点同构、地址引用）
      assembly.ts        # 装配间隙验证：Manifold 布尔干涉 + BVH 最小间隙 + 水密
      assembly-check.ts  # 装配清单 L0 检查：distance / diameter-match / 邻接发现 / 报告
      physics.ts         # M3 刚体动力学（rapier headless、事件关键帧、轨迹时间线）
      motion.ts          # M3.6 机构运动（纯约束求解 + Manifold 干涉时间线 + 驱动）
      mpm.ts             # MLS-MPM 内核（纯计算，无 I/O）
      sdf.ts             # STL → 窄带 SDF（固体掩膜/法向/trilinear）
      fluid.ts           # 流体场景组装：粒子/驱动/守恒审计/分段速度/预设推导
      fluid-render.ts    # 零依赖 PNG 点云渲染器（node:zlib 手写）
      measure.ts         # 测量引擎：表面吸附、最近点对、球探针解析分支
      inspect.ts         # measure_part / render_part 的版本级实现
      mesh.ts            # STL 解析、水密判定、体积、包围盒
      usage.ts           # llm/stream 计量 → data/usage/usage.jsonl
      runs.ts            # 运行库：data/runs/rNNN 的写入/索引/寻址（产物浏览的基础，v2.13）
    client/
      index.ts           # 右栏 Tab 注册 + 自动打开（sidebarRight / sidebarRightTabs / slots）
      panel.ts           # 单一面板：产物选择器 + 方形视口（按产物种类渲染）+ 参数/导出/报告折叠区
      playback.ts        # 运行回放视图：MotionPlaybackView / FluidPlaybackView / StaticPartsView
  lib/
    index.js             # Host 产物（宿主加载）
    client.js            # Client 产物（宿主经 /plugins 路由提供）
  scripts/               # accept-*.mjs / smoke-*.mjs / bench-mpm-scaling.mjs / regen-playback-data.mjs / migrate-runs.mjs
  sandbox/preview/       # 面板 UI 沙箱（v2.13）：真实 panel.ts + mock /api/cad/* + 无头 Firefox 出图，见其 README
  data/                  # versions/ + assembly|physics|motion|fluid|usage|bench 各域产物（不进 files 发布列表）
```

实作与原文的差异要点：**没有独立 LLM 模块**（评审走会话原生 + 附件，§6.3）；**没有 MPM 后处理模块**（v2.4 取消，§6.7）；**没有 config.ts**（参数是工具入参，见 §7.3）；**Client 只有 3 个文件**（无 per-panel 拆分、无 viewer/render/physics/mpm 客户端实现——那些都在 Host）。

### 5.2 package.json（当前实作）

```jsonc
{
  "name": "dsh-cad-harness",
  "private": true,                       // 仍不发布公共 npm（开放化未定，见 HARNESS.md §10）
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": {...}, "./client": { "default": "./lib/client.js" } },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "external": ["@deepseek-ai/dsh-api-session-controller/client"] }
  },
  "files": ["lib/", "cordis.patch.yml"],
  "scripts": { "build": "node esbuild.mjs", "watch": "node esbuild.mjs --watch" },
  "dependencies": {
    "@deepseek-ai/dsh-api-session-controller": "0.1.5-rc.3",
    "@deepseek-ai/dsh-attachment": "0.1.5-rc.3",
    "@deepseek-ai/dsh-tools": "0.1.5-rc.3",
    "@dimforge/rapier3d-compat": "^0.20.0",
    "manifold-3d": "^3.5.3",
    "three": "^0.170.0",
    "three-mesh-bvh": "^0.9.15"
  },
  "devDependencies": { "esbuild": "^0.24.0", "typescript": "^5.6.0", "react": "^18.2.0", "@types/react": "~18.3.1", "@types/three": "^0.186.0", "@types/node": "^26.6.2", "@deepseek-ai/cordis": "4.0.2", "@deepseek-ai/dsh-client-connection": "0.1.5-rc.3" }
}
```

更正原文三点：① `dsh.client` **无 `entry` 字段**（宿主按约定取 `./client` 导出），`external` 是 `@deepseek-ai/dsh-api-session-controller/client`（会话控制器基座），React 由 ModuleLoader 平台表提供、不必声明；② `dsh.bundle.patch` → `cordis.patch.yml` 是宿主补丁层入口；③ three / rapier / manifold-3d / three-mesh-bvh **都打进插件自身 bundle**（manifold-3d 在 Host 侧为 external）。

### 5.3 Host/Client 接线（当前实作）

- **工具**：`ctx.tools.register(defineTool({...}))` ×10 —— `generate_part`、`validate_assembly`、`check_assembly`、`simulate_physics`、`simulate_motion`、`simulate_fluid`、`render_part`、`measure_part`、`measure_distance`、`measure_closest`
- **精确路由**：`connection.fetch.register({ path: '/api/cad/...', methods: [...] })`（STL/PNG/帧二进制、报告 JSON、参数预览、导出、人工发起 POST run）。`connection` 经 **`ctx.reflect.get('connection')` 轮询获取**（不声明 inject）——headless profile 没有该服务，路由整段跳过
- **RPC**：仅存 M0 遗留的 `cad/echo` intercept 探针（`index.ts`），业务不用 RPC（大载荷走精确 GET）
- **UI 面板**：Client 半注册到 **右栏 Tab**（`sidebarRightTabs.register` + `slots.register('sidebar.right.pane.tab', {key})` + `sidebarRight.openTab`），不是 layout main slot；会话保持中栏
- **附件**：`ctx.attachments.saveImages` → 工具结果 image block → 会话（图片只能落 user role）
- **构建**：`pnpm run build` 一次产出 `lib/index.js` + `lib/client.js`；`lib/client.js` 缺失时宿主激活会大声失败。**不引入 Vite**（Client 用自带 esbuild）

---

## 6. 模块详细设计

### 6.1 几何编译（Host）

> **v2.10 回填（2026-09-28）**：原文的 `CompileRequest/CompileResponse` 抽象接口为 M1 期规划，实作为下列具体函数签名。**几何布尔/体积/水密不在本模块**——那些走 `manifold-3d` WASM（进程内，见 §6.4 与 §13.3）。

**职责**：接收 SCAD 代码 → 解析 datum → 编译 STL（`compileAndRender` 另出四视角 PNG）→ 交版本库；另提供参数解析、导出格式转换、按视角渲染。

**实作接口**（`compile.ts`）：

```typescript
compileAndRender(scadCode): Promise<CompileResult>   // STL + 四视角 PNG + datums
compileStlOnly(scadCode): Promise<CompileResult>     // 仅 STL（装配/仿真批量编译用）
renderScadPng(scadPath, pngPath, PngRenderOptions)   // 任意视角/缩放/剖切渲染
exportScad(scadPath, outPath, format): Promise<Uint8Array>  // stl|3mf|obj|off|wrl
parseParams(scad): ScadParam[]                       // `name = value; // PARAMS 描述`
parseDatums / parseDatumFeatures / makeDatumSet      // 点 / 轴 / 面 / 圆柱
parseMessages(raw): { errors, warnings }
// CompileResult = { success, stl?, renders?, errors, warnings, datums, datumSet?, durationMs }
```

**实现要点**：
- **二进制解析链**：`CAD_OPENSCAD_BIN` → `bin/squashfs-root/usr/bin/openscad`（2026.09.23 snapshot）→ 系统 `openscad`；版本 ≥ 2025 显式加 `--backend=Manifold`；snapshot 自动补 `LD_LIBRARY_PATH`
- **BOSL2**：`OPENSCADPATH` 指向内置 `lib/BOSL2`，所有调用生效（螺纹/齿轮/圆角/结构件不手搓）
- **共享 Xvfb**：`-displayfd` 自选显示号 + GL 预热 + `unref`，只在 PNG 渲染路径需要（渲染管线 15.7s → ~1.0s）
- 临时目录 `mkdtemp`（非固定路径）；超时 30s；STL 一律 `--export-format binstl -D $fn=64`
- **datum 前置区**：编译前 prepend `DATUM_PRELUDE`（`datum` / `datum_axis` / `datum_plane` / `datum_cyl` 四个模块，echo 行解析），错误行号偏移由注释声明接受
- 参数面板：`parseParams` 解析顶层 `// PARAMS` 数值；`POST /api/cad/preview` 按覆盖值替换源码后重渲染（防抖预览）
- 导出：版本目录内 STL 直出，其他格式转换一次并缓存

**验收**：语法错误返回 `success:false` 与可读错误；合法 SCAD 30s 内出 STL；输出水密（由 §6.4 的水密检查确认）。性能矩阵见 v2.1。

### 6.2 多视角渲染（Host；Client 负责交互预览与回放）

> **v2.10 回填**：原文「Client 侧 Three.js 渲染并拼 2×2 图」为 M1 期规划。实作改为 **Host 侧 OpenSCAD CLI 出四张独立 PNG**（避免浏览器往返、headless profile 也能跑完整循环，§13.2）；**没有拼图**——四张图直接进会话附件。Client 侧的 three.js 只做交互预览（STL 经精确 GET 路由加载）与运行回放。

**职责**：把 STL 渲染成 LLM/人可判读的图。

**实现要点**：
- 视角表（z-up，已修正 front/top 曾标反的问题）：`top [0,0,0]`、`front [90,0,0]`、`side [0,90,0]`、`iso [65,0,25]`
- 命令：`--camera=0,0,0,<rot>,0 --imgsize=512,512 --viewall --autocenter --projection=p --colorscheme=Tomorrow`
- `renderScadPng` 支持 `rotate / zoom / target + modelDiagonal / imgSize / colorscheme`，并可按剖切渲染（`render_part` 工具的面板/模型双向入口）
- 产物：`data/versions/vNNN/render_{front,side,top,iso}.png`；`render_part` 的一次性帧走 `data/` 临时目录
- MPM/流体快照**不走本路径**（`union(sphere)` 会超时）——用零依赖点云渲染器（§6.6）

**验收**：任意 STL 秒级出四视角 PNG，形状特征可判读（模型判读 + 人复核）。


### 6.3 视觉评审循环（Host，dsh 原生化）

> **v2.10 回填**：原文的「独立评审 LLM 调用 + ReviewRequest/Response + 固定 5 轮 + prompt 模板」为 M1 期规划，**实作已弃用**：会话模型本身多模态，独立评审是冗余的（§13.2）。实作口径如下。

**职责**：让生成循环自带眼睛——`generate_part` 工具把渲染图作为工具结果返回，会话 Agent 自己看、自己描述、自己决定是否迭代。

**实作口径**：
- 图片通道：`ctx.attachments.saveImages` → 工具结果 image block → 适配器转 `user` 消息（**图片只能出现在 user role**，这是适配器约束，不是我们的选择）
- **无独立评审调用、无固定轮数**——轮数由会话自然控制，用户可随时打断；验收标准从「N 轮内」变为「会话内收敛」
- 迭代载体：`generate_part` 的 `parentVersion` 串起版本链；`// PARAMS` 区约定保证参数面板可用
- 人审通道（v2.1 补齐）：面板「截图到会话」+「标注问题区域」+「📏 测量两点」，真值随截图流转（人指 WHAT、引擎算 WHERE）
- 已知代价：多轮循环历史图片累积（实测 9 次调用携 60 图 ≈ 60k token）→ **已实现图片修剪（旧轮换文本占位），见 §13.10**

**验收**：给定「一个带四个安装孔的法兰盘」，会话一轮通过（实测，标准 3 轮）；Agent 对渲染图做像素级比例分析后判定 OK。


### 6.4 装配间隙验证（Host）

> **v2.10 回填**：原文的「临时 SCAD `intersection()` 编译求体积 / 包围盒+采样求距离 / 水密=边数公式」为 M1 期规划。实作改为 **manifold-3d WASM 进程内精确布尔 + MeshBVH 顶点采样距离**（§13.3），水密判定用有向边计数 + `Manifold.status()`。工具仍名 `validate_assembly`（内联 `scadCode`）。

**职责**：多零件装配体的水密性、两两干涉体积、最小间隙（静态几何，L0）。

**实作接口**（`assembly.ts` / `tools.ts`）：

```typescript
interface AssemblyPartInput { name: string; stl: Uint8Array; transform?: PartTransform }
validateAssembly(parts, thresholdMm = 0.75): Promise<AssemblyReport>
// AssemblyReport = {
//   parts: [{ name, watertight, volume, boundingBox, triangles }],
//   pairs: [{ partA, partB, intersectionVolume, minDistance, status: 'ok'|'interference'|'too_tight' }],
//   overallStatus: 'pass'|'fail', thresholdMm }
// 工具入参：parts[{ name, scadCode, translate?, rotate? }]（服务器侧编译）
```

**实现要点**：
- 每件单独编译 STL → `Manifold.Mesh.merge()` → `Manifold` solid；变换在 solid 上做（`rotate` 再 `translate`）
- **所有下游消费者统一使用变换后网格**（BVH、距离采样、bbox 同一坐标系——修坐标系错位 bug 时确立的原则）
- 干涉体积：`A.intersect(B).volume()`（精确布尔；实测 2258.3mm³ vs 解析 π·36·20≈2262，差 0.2% 为 $fn=64 多边形拟合）
- 最小间隙：双向顶点采样（≤1200）对另一件 MeshBVH 最近三角形查询取 min（Manifold 无距离查询）
- 水密：有向边计数（每条有向边恰出现一次且反向存在）+ `solid.status() === 'NoError'`
- 阈值判定：`intersectionVolume > 0` → `interference`；`minDistance < threshold` → `too_tight`；否则 `ok`
- 报告落 `data/runs/rNNN/report.json`（v2.13 起；旧路径 `data/assembly/assembly-report.json` 与 `GET /api/cad/assembly` 已废弃，仅留「最近一次」别名），面板经 `GET /api/cad/products` + `GET /api/cad/run/report?id=` 消费

**验收**：干涉体积与解析解差 <0.5%；1mm 间隙精确测得 1.000；阈值判定（0.75 ok / 1.5 too_tight）正确。

#### 6.4.1 装配清单检查（v1，2026-09-28 新增）

**职责**：BOM + 可执行 ICD —— 把「谁和谁配合、什么类型、名义值、容差」写成 `assembly.json`，由引擎逐条核对，并反向发现未声明的邻近零件对。设计见 `docs/archive/ASSEMBLY-SCHEMA-PROPOSAL.md`，交付记录见 v2.7。

- 实作：`manifest.ts`（清单读写/校验/遍历）+ `assembly-check.ts`（L0 算子 `distance` / `diameter-match`、hard/intent 双通道、邻接发现）
- 工具 `check_assembly`；路由 `GET /api/cad/assembly/manifest`、`POST /api/cad/assembly/run`（人工发起②）、`GET /api/cad/assembly/check`
- 报告落 **`data/assembly/assembly-check-report.json`**（工具契约的落盘位置，`GET /api/cad/assembly/check` 读它）+ 同时登记为一条 `assembly-check` 运行（`data/runs/rNNN/report.json`，v2.13）——面板浏览运行，脚本继续读文件
- datum 三类扩展（axis/plane/cylinder）落在 `compile.ts` 的 `DATUM_PRELUDE`，datums.json 存 `{points, axes, planes, cylinders}`（兼容旧点数组）
- 验收：`accept-assembly.mjs` 14/14（豚鼠=显微镜第一级：正样本 3 接口精确命中、负样本硬违反 Ø-0.8、邻接发现 deliberate 未声明的 0.1mm 配合）


### 6.5 轻量刚体物理（Host，原规划为 Client）

> **v2.9 更正（2026-09-28）**：本节标题与「Client/Three.js」相关要点是 M1 期规划原文。M3 实作改为 **Host 侧 headless**（rapier3d-compat 在 Node 跑，整个物理验证闭环 host 侧完成，headless profile 可验收），渲染走 `renderKeyframes`（OpenSCAD 场景），Client 侧只保留面板回放。实作决策见 §13.4，回放见 v2.5。

**职责**：rapier 仿真零件的运动和碰撞，渲染关键帧给 LLM 看（host headless）。

**接口**：

```typescript
interface PhysicsScenario {
  parts: {
    name: string;
    stlUrl: string;
    bodyType: 'dynamic' | 'fixed' | 'kinematic';
    mass?: number;
    initialPosition: [number, number, number];
    initialRotation?: [number, number, number, number];
  }[];
  joints?: {
    type: 'revolute' | 'prismatic' | 'fixed';
    bodyA: string;
    bodyB: string;
    anchor: [number, number, number];
    axis: [number, number, number];
  }[];
  gravity: [number, number, number];
  duration: number;
  timestep: number;
}

interface PhysicsResult {
  frames: string[];
  metrics: {
    maxPenetration: number;
    finalPositions: Record<string, [number,number,number]>;
    fellOver: boolean;
    jointViolations: number;
  };
}
```

**实现要点**：
- `await RAPIER.init()`（host 侧 headless）
- 碰撞体：静态/运动学用 `ColliderDesc.trimesh`；动态件先经 Manifold 凸性检测（体积差 <1% 走凸包，非凸才 trimesh），全开 CCD（毫米尺度隧穿）
- 关节：`RAPIER.JointData.revolute(anchor1, anchor2, axis)`
- 仿真循环：`world.step()`
- **关键帧选择（v2.9 更正，取代原文「每 10 步渲染一次」）**：**事件驱动 + 预算内均匀补位**——事件帧 = 碰撞开始（`接触:A↔B`）、倾倒转折（up 倾角首破 30°）、最大穿透步、`final`（不可裁）；预算 `keyframeCount` 默认 6，事件帧按 `minGap` 去重后仍不足则按 `keyframeEvery = steps/keyframeCount` 均匀补 `context` 帧；被选步的位姿取邻近轨迹帧（网格间距 ≈0.6%，标签保留真实步号）。**另有一条与关键帧分离的轨迹时间线**（`trajEvery = ceil(steps/160)`，循环内均匀采样 ≈160 帧，含 `events`），供面板回放与轨迹数据消费（v2.5）
- 穿透检测：遍历接触对读 `contact.dist` 取最小值，**瞬态最大**与**稳态**（末 10% 步）双指标分开
- 倒地检测：up 向量与重力方向夹角 > 60°

**验收**：盒子在平面上静止不穿透；铰链门绕轴旋转不飞出；高重心零件倒地；关键帧能展示接触/倾倒事件过程（模型判读 + 人复核）。

### 6.6 MPM 流体仿真（Host；原规划为 Client/WebGPU）

> **v2.10 回填**：原文的「WebGPU 跑 MLS-MPM、Three.js 粒子渲染、实时 >30FPS」为 M1 期规划。实作改为 **Host 侧 CPU MLS-MPM**（纯 TS typed arrays，离线跑几十万粒子），WebGPU 移交后续交互面板；分析解读按 v2.4 交还 LLM（§6.7）。

**职责**：连续介质（流体/颗粒）的趋势级仿真——流得过不过、流量与死区、注液排液、灌装。

**实作模块**：

> **2026-10-14 内核引擎更新**：生产内核在 Python worker（2026-10-12 起 Python canonical），
> 现为**双引擎**——`python/cad_worker/mpm_numba.py`（numba JIT：对 numpy 内核 5.1–8.7×、
> 对 TS 1.3–2.0×，`experiments/20261014_numba_mpm_probe.md`）经 `worker._mpm_engine`
> 自动选择（`CAD_MPM_ENGINE` 可强制；musl/darwin-x64 无 wheel 自动回落 numpy 内核），
> 下表的 `mpm.ts` 保留为 TS oracle + darwin-x64 fallback 角色。两引擎共用同一套网格边界
> 与驱动/审计规则实现（尾部逐行同构），算法不变。

| 文件 | 职责 |
|---|---|
| `mpm.ts` | MLS-MPM 内核（P2G×2 + grid + G2P APIC，弱可压 EOS，cell 单位运行，restDensity 自动标定，NaN 三重加固）——TS oracle；生产引擎见上注 |
| `sdf.ts` | STL → 水密 → BVH 距离 + 三射线奇偶符号 → 逐格 SDF（solidMask/solidNormal/trilinear） |
| `fluid.ts` | 场景组装：粒子初始化、入口驱动、出口 escape 守恒审计、分段平均速度、发散检测、`deriveFluidPreset` 自动推导 |
| `fluid-render.ts` | 零依赖 PNG 点云渲染（`node:zlib` 手写 PNG，双视角 + 速度着色 + 壁面参照 + z-buffer） |

**实现要点**：
- 单位制：毫米/s，重力 `[0,0,-9810]`；**dt 固定 4ms 不可调**（config 不暴露）
- 粒子数：按 4-8 粒/格 × 流体域体积自动计算（典型 5 万-30 万），显式覆盖上限 1,000,000；**精度旋钮是 dx 不是粒子数**（基准见 docs/archive/M4-PREP.md 附录 A）
- 边界：粒子-壁面 = SDF 投影回推（近壁掩膜 O(1) 预筛）；自由滑移 = G2P 排除固体格 + 流体权重重归一化（阈值 0.5）
- 出口：escape 移除 + 守恒审计（到达率 = escaped/count0 可断言）；recycle 环绕续流为另一模式
- 快照与数据：8 帧 PNG 进会话 + `frames.json` + 每帧 `.bin`（Float32 pos[3N]+speed[N]，16B/粒子）+ `wall.stl`；路由 `GET /api/cad/fluid[/manifest|/frame?i=|/wall]`
- 面板：`FluidPlaybackView`（three.js Points 速度着色 + 透明管壁 + 时间轴 scrub/播放）——**面板与 LLM 消费同一批帧数据**（场地原则第一次落地）
- M4R 场地化：`simulate_fluid` 降级为示例脚本形态，src 模块作为**真实库**开放给会话 agent 的 shell/Node；插件只保留不可替代的服务（图进会话、版本库、面板数据、人工守卫运行器）
- 未做（诚实边界）：流固耦合不支持（固体边界全程固定）；精确 CFD 不做（趋势判断）；弹性本构为长期候选

**验收**：`accept-m4.mjs` 24/24 五案例（直管 11.9k 到达 0.72 / 38.7k 到达 0.845、穿透 0、守恒 0；静水沉降稳定；90° 弯管转向 0.63；渲染帧可判读）。

### 6.7 MPM 后处理（Host）

> **v2.4 重定义**：规则引擎与固定统计接口**取消**。插件只提供帧数据落盘/访问 + 参数化渲染 + 面板回放（见 docs/archive/M4-PREP.md §9）；死区/流量/守恒分析由 LLM 写脚本消费帧数据完成。以下为历史设计，保留备查。

**职责**：从 MPM 结果提取统计量，规则引擎生成修改建议。

**接口**：

```typescript
interface PostProcessRequest {
  result: MPMResult;
  pipeAxis: 'x' | 'y' | 'z';
  inletPlane: number;
  outletPlane: number;
  crossSectionArea: number;
  particleMass: number;
}

interface PostProcessResponse {
  flowRateIn: number;
  flowRateOut: number;
  massConservationError: number;
  avgVelocityAtSections: { position: number; velocity: number }[];
  deadZones: { center: [number,number,number]; volume: number; avgVelocity: number }[];
  maxVelocity: number;
  suggestions: string[];
}
```

**后处理算法**：

1. 截面流速：管道轴向分 20 段，统计每段粒子平均速度
2. 流量：截面粒子数 × 粒子质量 / 时间步长
3. 质量守恒：`|flowRateIn - flowRateOut| / flowRateIn`
4. 死区：速度 < 入口速度 10% 的粒子做网格聚类，体积超阈值则记录
5. 规则引擎：
   - `massConservationError > 0.1` → 「仿真参数可能不稳，建议减小时间步长或增加粒子数（非设计问题）」
   - `deadZones.length > 0` → 「检测到死区，建议增大拐弯半径或减小管径突变」
   - `maxVelocity > 3 × avgVelocity` → 「局部流速过高，可能产生湍流，建议平滑过渡」
   - `flowRateOut < 0.5 × flowRateIn` → 「出口流量异常，检查是否有堵塞或泄漏」

**验收**：直管 `massConservationError < 0.05` 无死区；90° 弯管检测到死区；突缩管 `maxVelocity` 明显高于平均。

### 6.8 版本管理（Host）

> **v2.10 回填**：原文目录结构中的 `render_composite.png`、`review.json`、`validation.json`、`physics.json`、`mpm.json` 均**不存在于实作**（无 2×2 拼图；评审是会话原生行为不落盘；各类验证报告按域落在同一 store 目录，不按版本分目录）。实作口径如下。
>
> **v2.13s 更正**：下面的根**不再是插件的 `data/`**，而是**每个项目一个目录** `<DSH_HOME>/cad/<basename>-<sha1(cwd)[0:8]>/`（项目 = 会话 cwd；见 §13.13）。`usage/` 是唯一例外，它留在 profile 层 `<DSH_HOME>/cad/telemetry/`。

**职责**：每轮迭代存代码、STL、四视角渲染图与 datum 全集，并以 manifest 索引。

**实作目录结构**（`version.ts`；根 = 项目目录）：

```
<DSH_HOME>/cad/<project>/
  project.json             # { schemaVersion, cwd, key, title, createdAt } —— 哈希目录名的权威解释
  versions/
    v001/
      model.scad
      model.stl
      render_{front,side,top,iso}.png
      datums.json          # {points, axes, planes, cylinders}；兼容旧的裸点数组
    v002/
  manifest.json            # { versions: [{ id, timestamp, userIntent, parentVersion, status }] }
  assembly/                # assembly.json（输入清单）/ assembly-check-report.json（check_assembly 的落盘契约）
  runs/
    manifest.json          # { runs: [{id,kind,timestamp,title,status,summary,sourceVersionIds,hasGeometry,parts,placements?}] }
    r007/
      run.json             # 自描述副本（索引丢失也能恢复）
      report.json          # 该 kind 的完整报告
      trajectory.json      # motion / physics
      fluid-manifest.json  # fluid（面板 scrub 的帧索引）
      parts/<name>.stl     # 这次运行算的几何（装配还带 placements）
      frames/<file>        # 关键帧 PNG / 流体 .bin
```

profile 层（不属于任何项目）：

```
<DSH_HOME>/cad/telemetry/usage.jsonl   # llm/stream 计量（调用次数/图片数/token）
<pluginRoot>/data/bench/mpm-scaling.json  # 研究基准存档，不是设计产物
```

**实现要点**：
- 版本号 `vNNN` 自增；`parentVersion` 串迭代链；`status` 字段目前恒为 `'draft'`（**审批/回滚尚未实现**，见下）
- 版本**不可变**：重复迭代产生新目录，不覆写历史
- `saveVersion` 接收编译产物（STL/渲染图/datum 全集），失败轮次也入库（保留错误现场）
- 面板：版本下拉（v2.13，取代 chips 网格）+ 多格式导出（STL/3MF/OFF/OBJ/WRL，转换一次缓存）+ 参数滑块防抖预览；布局见 §6.9

**验收**：每轮自动创建新版本；manifest 与实际文件一致；导出格式可用；任意历史版本可加载预览。
**未实现（诚实标注）**：❌ 回滚到历史版本的一键操作；❌ 版本审批流转（`approved/rejected` 仅存在于类型定义，无路由/无 UI）。二者随人审通道（§4 权威编辑）一并待办。

---

### 6.8b 视口光照：相机相对的三点光 + 胶片式高光收束（v2.13v）

> **来源**：实机反馈「视口里展示的模型，似乎是光源的问题，细节一点的东西就看不清」。

**旧的光照是两行**：`AmbientLight(0.6)` + 一盏**世界固定**的 `DirectionalLight(1.2) @ (30,50,20)`。两件事同时发生，而且都正好打在"看细节"上：

1. **主光是世界固定的**——转到零件背面去看，可见的那一面正好在阴影里，只剩环境光；**你想看的那一面，就是没被打光的那一面**。
2. **环境光占了三成**（0.6 / 1.8）。小特征（一条肋、一个圆角、孔的内壁）靠的是**明暗变化**，而一个大常数项会把这点信号压平——所有东西朝同一个色调收拢。

**改法**（`src/client/lighting.ts`，模型视口与回放视口共用一套）：

- **三点光挂在相机上**（key 左上偏前 / fill 对侧 / rim 后方），光和 target 都在 rig 里 → 方向是**视空间固定**的，转到哪一面亮到哪一面，而且**不依赖模型在世界里的位置**（视口是围绕零件自身的包围盒取景的）；
- key 2.4 / fill 0.5 / rim 0.85，**环境项降到 0.24 且换成半球光**（天空亮、地面暗）——环境占比 33% → **8%**，正对 key 与背对 key 的对比 3.0× → **11×**；
- **胶片式 tone mapping**（`ACESFilmicToneMapping`）：主光这么强时，正打的面会直接削平成白，而削平的面**一点明暗都不剩**；收束高光之后亮面保住渐变。背景是 clear color，不参与 tone mapping，于是零件相对背景反而更分得开。

**实测（沙箱真图，不是估算）**：同一零件、同一机位，用颜色掩膜只取模型像素（视口里只有零件是蓝色主导，控件/标尺/坐标轴都是中性色）：

| | 圆角滑座 sd | 滚花旋钮 sd | p2..p98 动态范围 |
|---|---|---|---|
| 旧光照 | 18.5 | 19.5 | 90.6 / 102.0 |
| 三点光（无 tone mapping） | 30.3 | 32.9 | 107.3 / 103.6 |
| **三点光 + 胶片式** | **42.2** | **45.8** | **125.5 / 121.9** |

零件的色调方差**翻了一倍以上**，动态范围从 ~95 拉到 ~125，而两端**没有像素被压死或削平**（crushed/hot 均为 0）。证据图：`sandbox/shots/lighting-{before,after}-{slide,knob}.png`。

**顺带修好了沙箱出图这件事本身**：本机 `firefox --headless` **根本建不出 WebGL 上下文**（探针页直接报 `WEBGL UNAVAILABLE`，且没有 `/dev/dri`；强制软件 Mesa 也没用），面板只会渲染"此环境无法创建 WebGL 上下文"的卡片——也就是说**这个环境里"看图"这一步是断的，而之前没人发现**。真正的解法是给它一个 X 显示：`sandbox/preview/shot-gl.mjs` 起一个临时 Xvfb，Firefox 走 GLX + Mesa `swrast`/llvmpipe 软件光栅，WebGL 2.0 正常。以后所有视觉改动都用它出图。

**底色可选**（v2.13w，同日追加）：四个预设（纸白 `#f2f3f5` / 暖灰 `#e6e0d6` / 石墨 `#39424d` / 深蓝 `#1c2733`），选择记进 `localStorage['cad.viewportBg']`，控件是**视口右上角「复原」正下方的一个胶囊**（显示当前底色名，点开弹四色）——**不加第六个工具 chip**（`S.viewTools` 是视口左上角的一**列**，多一个就多盖一块模型）。位置当日返工过一次：第一版挂在**面板层**却用视口内坐标定位，胶囊盖到了「零件/记录」选择器上——**绝对定位元素必须挂在它坐标所相对的那个容器里**，最终改走 overlay 的 `chrome` 槽与「复原」同坐标系；并且**挂完用沙箱的 DOM 探针报 x/y/w/h 验证，不要在截图里肉眼找色块**（浅底上的浅色块根本找不到）。四条约束：①覆盖层随底反色（标尺/读数是 DOM，写死的 `#26303a` 在暗底上会消失，故 `overlayInk()` 按预设给深浅两套墨色，WCAG 对比度实测 9.0~13.4:1）；②切换只写 `scene.background`，**不重建场景**（重建要付一个 WebGL 上下文、还会重新取景），异步建场景用 `bgRef` 取最新值以防竞态；③`backgroundById/loadBackgroundId` 对未知 id 与不可用的 localStorage **一律回落默认**（不许抛）；④回放三视图（motion/fluid/static）共用同一个 `useGround()`——同一份产物不该因为呈现方式不同而换个底色。

**实测（沙箱真图，颜色掩膜只取模型像素）**：

| 预设 | 底色亮度 | 零件均值 | 零件 p98 | p98 − 底色 | 结论 |
|---|---|---|---|---|---|
| 纸白 | 243 | 104.6 | 183.0 | **−60** | 零件整体暗于底：轮廓最清楚，形体偏闷 |
| 暖灰 | 225 | 102.9 | 168.0 | −57 | 暖底衬冷件，报告截图好看 |
| 石墨 | 65 | 82.1 | 168.5 | **+104** | 亮面跳出，形体最立得住 |
| 深蓝 | 38 | 62.9 | 164.4 | **+127** | 分离最大，暗部与底融合 |

四种都保留了（亮底看轮廓、暗底看形体），默认仍是纸白——与面板浅色外壳、以及 Agent 看到的 OpenSCAD 渲染一致。

**验收**：`scripts/accept-lighting.mjs`（43 条，不需要 GPU——它是**场景图的**性质而不是像素的性质）：rig 挂在相机上、key 在视空间是"左上偏前"、**转动相机时 key 的世界方向跟着转**（Δ=1.19）、环境占比 <20%、正/背面比 ≥3×、两端代码都换成新光照且没有残留的旧写法。像素面则靠上面的沙箱实测。

### 6.9 面板：产物优先，不选模式（Client 右栏 Tab，v2.13）

> **来源**：2026-09-28 实机反馈两轮。第一轮：「版本历史太占地方、放在最前面不合适」「预览空间太小，至少是一个正方形」。第二轮（更根本）：「模型、动作、流体居然需要由人来选择，难道不是浏览什么产物，就自动按它是什么来展示？先选是什么东西、再选产物，这个逻辑不对。」

#### v2.13a 版式：预览优先

**改版前的病灶**（`sandbox/shots/baseline-380x900.png`，380×900 右栏）：标题 + 33 个版本 chips（9 行，≈306px）+ 导出 + 参数 + 意图 + 模式 Tab 之后，预览只剩 **335×300** 且底部溢出面板。**版本历史占用了第一屏，模型反而最不起眼**。

**改版后（自上而下）**：

| 位置 | 内容 | 尺寸纪律 |
|---|---|---|
| 1 | **一行搞定浏览轴**（v2.14）：`[零件 · 5版 ▾] ∗ [v030 · 最新 · 09-28 16:08 ▾] ●`——零件、记录、跟随最新挤在同一行，原先的「零件/记录」文字标签与零件详情行折进 tooltip | 单行 ≈26px（比 v2.13 少两行） |
| 2 | **视口**（v2.14b 起**不再是方框**）：`aspect-ratio: 1/1` 只作 flex 下限，`flex: 1 1 auto` 吃掉全部余量 | 永不小于正方形（380 栏 → 宽 355），有富余就长高（380×900 → 355×568） |
| 3 | 标注工具条（仅零件版本）：`📸截图 / □标注 / 📏测量 / ◐剖切` | 单行；运行产物改为一行说明（回放视图自带截图） |
| 4 | 上下文行（测量值 / 模式提示 / 剪贴板提示） | 按需出现 |
| 5 | 详情区（`Disclosure`）：按**产物种类**渲染不同内容 | 默认一行，标题带 ✅/❌/⚠️；`max-height: 42%` + `overflow:auto`，**空间不够时先滚它** |
| 6 | **底部状态带**（v2.14b）：结论词 + `记录id · 类型 · 第 i/N 版 · 时间 — 摘要` + 出处 | 单行 11px、贴底、可省略号截断——**在视图之下，不许喧宾夺主** |

#### v2.13b 交互：产物即主体（本节的核心）

**病灶（这是 bug，不是口味）**：旧版三个 Tab 里，「模型」绑选中版本，而「动作 / 流体」绑的是**"最近一次运行"**——`playback.ts` 两个视图的 `useEffect` 依赖是 `[]`，路由 `/api/cad/{physics,motion,fluid}` 也没有 `v=` 参数。**停在动作/流体 Tab 时，版本下拉是死控件**：切换什么都不变。所以那个 Tab 不是"视图"，而是"换主体"——这正是"先选是什么东西、再选产物"的根源。

**根因：运行没有身份，也没有出处**。旧实现把结果写到固定文件名（`data/physics/physics-report.json`、`data/fluid/frames.json` …），**后跑覆盖前跑**，且报告里不记录"我关于哪个版本"。物理/机构更彻底：零件是内联 `scadCode`，连"零件来自哪个版本"都没有。

**现行模型**：

- **产物 = 零件版本 | 验证运行**，由 `GET /api/cad/products` 一次返回、按时间倒序。人只选产物；**展示方式由产物自己的 `type`/`kind` 决定**：
  - `version` → 单件几何视口（旋转/测量/标注/剖切）+「相关验证」
  - `run` + motion/physics → 该运行的几何 + 时间轴回放
  - `run` + fluid → 该运行的管壁 + 粒子回放 + 时间轴
  - `run` + assembly → 静置装配视图（零件带各自 placement）
  - `run` + assembly-check → 无几何，报告卡片（**诚实显示"这次运行没有几何体"**，而不是假装有）
- **运行是一等产物**，有自己的 id（`rNNN`）、时间戳、kind、状态、`sourceVersionIds`，以及独立产物目录 `data/runs/rNNN/`（report / trajectory / fluid-manifest / parts/*.stl / frames/*）。取数路由全部按运行寻址：`/api/cad/run{,/report,/trajectory,/fluid-manifest,/stl,/frame,/image}?id=`。旧的"最近一次"路由保留为别名，面板不再使用。
- **provenance 由 Host 记录**：`simulate_fluid` 用 `versionId`；`simulate_physics` / `simulate_motion` / `validate_assembly` 的零件新增可选 `versionId`（有则直接取该版本 STL 并记入来源，无则内联 SCAD 编译、来源为空）；`check_assembly` 从清单节点的 `version` 字段收集。**来源为空是合法状态**，面板如实写"内联 SCAD 场景 — 这次运行不基于任何已存版本"，不硬塞给某个版本。
- **默认跟随最新产物**：新版本或新运行出现即接管视口；手动选过之后变为「已钉住」，一键恢复跟随。
- **相关验证**：版本详情里列出 `sourceVersionIds` 含该版本的运行，点击即切到那个产物——产物之间的桥由 provenance 生成，不靠人记。

**理由**：

- **视觉第一公民 = 版式第一公民 + 交互第一公民**：预览占据首屏不算完，**选什么就看什么**才算。模式选择器把"呈现方式"暴露给人，是引擎内部差异泄漏到界面上。
- **视口吃余量，正方形是下限**（v2.14b 修正）：`aspect-ratio` 让预览随右栏拖宽自动变大（无需 JS 测量），而 `flex:1 1 auto` 让它同时吃掉竖向余量。**"变高"不等于"变大"**——取景是包围球内切于较窄的那条视场，模型尺寸由视口**短边**决定，所以比正方形高是白得的留白，比正方形矮则立刻缩水。
- **折叠而非删减**：报告、参数、导出一个都没少，只是收进层级。

**验证方式（沙箱纪律）**：`sandbox/preview/` 用真实面板组件 + 真实 `data/`（含 `data/runs/`）起 mock API，无头 Firefox 出图；四类产物的对照图与跑法见 `sandbox/preview/README.md`。宿主 bundle 改动仍需 `pnpm run build` + 刷新页面。

**已知缺口（诚实标注）**：运行只保留"跑过什么"，没有删除/重命名/对比；运行产物的截图走各回放视图自带的按钮（标注框只烘焙在零件版本视口）。

#### v2.13c 视口角标：坐标系、标尺、复原（2026-09-28 三轮反馈）

> **来源**：「视图没有标尺和坐标系，以及复原这些功能；其中坐标系和标尺一个放在左下角一个放在右下角。」

| 角标 | 位置 | 内容 |
|---|---|---|
| **坐标系三轴** | 左下 | X 红 / Y 绿 / Z 蓝，**随相机姿态实时旋转**；轴向长度按投影自然缩短（指向观察者的轴收成短桩），指向背面的轴淡化 |
| **比例尺条** | 右下 | 「一段带端刻度的横线 + 数字」，按相机在**轨道焦点深度**的像素/毫米自动换档（1/2/5×10ⁿ mm），窄到 96px 以内 |
| **复原视图** | 右上 | 一键回到该产物**初次取景**（相机位姿与 target 双复位） |

**实现选择（关键）**：三者都是**普通 DOM**，由每帧读取活相机驱动，**不是 WebGL 几何**。理由：① 不被模型裁切、不参与深度、缩放时保持清晰；② 换产物/换视图（几何视口、三条回放、装配静置）只需 `createScene` 暴露 `camera/controls.target/refit`，一套实现四处复用；③ **可验收**——无头 Firefox 不把 WebGL canvas 合成进 `--screenshot`，DOM 角标能直接出图，本次的缩放换档与复位断言就是靠它做的。

**验收证据**（`sandbox/shots/`，同一次会话内实测）：

| 断言 | 证据 |
|---|---|
| 比例尺随缩放换档 | `ppm=6.234 → bar=62px / 10 mm`；滚轮放大后 `ppm=8.056 → bar=81px / 10 mm`；再放大 `ppm=12.783 → bar=64px / 5 mm` |
| 坐标系随姿态旋转 | 默认视角 X→右、Y→上、Z→右上且淡化（`_triad` 对照） |
| 复原回到初始取景 | 模型像素包围盒 `302×279`（初）→ `352×352`（放大）→ `302×279`（点复原，**逐像素等同初态**） |
| 四种产物都有角标 | `final-version` / `final-run-physics` / `final-run-fluid` / `final-wide` |

**已知缺口**：角标不显示单位制切换（全站 mm）；比例尺按轨道焦点深度换算，模型沿视线方向很厚时远端会有偏差；坐标系只画世界轴，不显示装配体的局部基准。

#### v2.13d 测量：探针像素恒定、壁厚一点测、截图有回声（2026-09-30）

> **来源**：「测量的功能还不够完善，当我放大后，测量的探针的点特别大，对于薄壁没有办法，截图点击后似乎也无效，请检查。」

三条反馈各自查出一个根因，另有两个连带 bug 是查的时候撞出来的。**全部结论都对着真实 `v034` STL 用 three.js 在 node 里算过**（本次会话起不了 WebGL，见 §6.9b 的说明）。

| 反馈 | 根因 | 修法 |
|---|---|---|
| 放大后探针点特别大 | 探针是**世界坐标**半径 `max(0.4, R×0.02)` 的球：法兰 R=64.6 → r=1.29mm，屏幕上 1× 时 6.1px，**16× 时 101px**，把整个被测特征吞掉 | 改成**屏幕像素恒定**：每帧按相机距离缩放（`scaleScreenDots()`，直径 7px），并关掉深度测试（`depthTest:false`）——点落在壁面上不再半埋进去 |
| 薄壁没有办法 | ① 上面那个球本来就比 0.5mm 壁厚大；② **更致命**：`Raycaster` 尊重 `material.side`，而显示材质是 `FrontSide` → 射线**只报朝向相机的那一面**，"壁的另一面"根本拾取不到，任何壁厚都无从量起；③ ◐剖切是**空操作**（切面放在 `box.max.z`、法向 (0,0,-1) → 保留 `z ≤ maxZ` = 全保留），且拾取不看剖面，会点到已被切掉、看不见的几何 | ① 见上；② 拾取改用**双面孪生 mesh**（同 geometry、`DoubleSide`、不进场景）→ 真实 STL 实测：Ø36/Ø35 轴套壁 **0.500mm**、法兰盘 **16.000mm**、密封面+盘 **18.000mm**，而 FrontSide 下这三例**都只有 1 个命中**；③ 切面改到 bbox 分数的**可拖位置**（保留 `z ≤ 切面`），并把被切掉一侧的命中过滤掉 |
| 截图点击后无效 | 截图**成功**了，但回执藏在详情区最底部的「上下文插入列表」里——详情区只有 ~165px 高且**会滚动**，新条目落在折叠线以下，看起来什么都没发生 | 三条回声：工具栏按钮显示张数 `📸截图 (1)`、工具栏下方立刻出一行「已加入…第 1 张 — 点 📋图 复制，再回输入框 Ctrl+V」、新条目 `scrollIntoView` 自动滚进视野，底部状态带再加一枚 `📸 1 张待插入` |

**连带修掉的两个 bug（不会自己暴露，是查上面时撞上的）**：

- **测量/壁厚模式的说明文字从来没显示过**：反馈行的条件写的是 `(measure || annotateMode || hint)`——**漏了 `measureMode`**，于是"点击零件表面第一个点"这句只在已经点出第一个点之后才可能出现。现在模式本身进条件，进入模式即给指令。
- **切剖切会重建整个场景**：`section` 在主 effect 依赖里，每切一次就重建 renderer/mesh、**耗掉一个 WebGL 上下文**（与 `forceContextLoss` 修的是同一类泄漏）。现在 `localClippingEnabled` 常开、clippingPlanes 就地更新（只在**面数**变化时 `needsUpdate`），切剖切不再重建。

**验收证据**（`sandbox/shots/meas-*.png` + node 数值）：

| 断言 | 证据 |
|---|---|
| 探针不随缩放变大 | 355×568 视口、法兰 R=64.6mm：旧 1×=6.1px / 4×=24.5px / 16×=101.0px → 新恒为 6.2px |
| 薄壁量得出来 | 双面拾取：Ø36/Ø35 轴套壁 0.500mm、盘 16.000mm、密封面+盘 18.000mm（FrontSide 时三例均只有 1 个命中） |
| 剖切真的切 | 旧平面（`box.max.z`）实测 bbox 两端都"保留"= 没切；新平面 f=0.5 时保留 `z≤-6`，两端一留一去 |
| 剖切下拾取不再点到看不见的面 | 同一射线：过滤前最近命中 z=18.00（已被切掉的盘顶面），过滤后只剩可见面 |
| 模式说明可见 | `meas-thick.png` / `meas-points.png`：进入模式立刻出现指令行（h=17） |
| 截图有回声 | `meas-shot-tray.png`：按钮 `📸截图 (1)`、指令行、托盘自动滚入、状态带 `📸 1 张待插入` |
| 5 个 chip 仍是一行 | 380 与 320 两种栏宽实测均 h=26、不换行 |

**诚实标注**：本次会话 `/dev/shm` 只读、无 Mesa DRI、无 Chrome，**3D 像素依旧出不了图**（`fakerenderer=1` 那几张里的画布是沙箱替身，像素不是 3D）。因此"探针多大多小"是靠**投影计算**给出的像素数，不是目视；"壁厚对不对"是靠**射线数值**（0.500/16.000/18.000mm），不是看渲染。**壁厚＝沿视线的材料厚度**（斜看平板时读数大于真实壁厚），标注里写明了"沿视线"。

#### v2.13e 版式稳定性：除视口外，所有区域的长宽都不随交互改变（2026-09-30）

> **来源**：「除了视图，其他区域的高度在页面没有刷新和缩放的时候高度和宽度都应该固定，否则我们现在就遇到了点击测量之后，视图和视图里面的图像的位置发生变化的情况。」

**病灶**：点一下 📏测量/▤壁厚，反馈行**从无到有**（+34px）→ 视口少 34px → `ResizeObserver` 触发 `onResize` → `camera.aspect` 变了 → `applyFit()` 重新取景 → **模型在视口里跳一下**。这不是"测量不准"，是**版式在交互中变了**。同类病灶另外三处：打开折叠区（详情区自然高变化）、出错行（顶部插一行把下面全推下去）、`scrollIntoView`（会把**祖先滚动容器**一起滚——真实 GUI 里就是右栏 tab 体，整块面板被带着走）。

**规则**：**只有视口是弹性的**；其余每个区域的长宽由布局给定，交互只改内容、不改盒子。

| 区域 | 改前 | 改后 |
|---|---|---|
| 工具条 | `flexWrap: wrap`（窄栏换行＝改高）；激活态**换字**（`▤壁厚`→`✕壁厚` 差 2px、`📏`→`✕` 差 5px）；激活边框 1px→1.5px（宽度也变） | 固定 26px + `nowrap` + `overflow:hidden`；**不再换字**（激活只靠边框/底色，tooltip 写"再点一次退出"）；边框恒为 1.5px；截图按钮固定 68px（角标只写数字：320 栏下 5 个 chip = 68/50/53/50/50 + 4×4 间距 = **287 ≤ 295** 仍是一行） |
| 反馈行 | 有测量/有提示才出现（0 ↔ 34px） | **常驻 38px 两行**：空闲时第一行是标准操作提示（`📏测量 两点距离 · ▤壁厚 一点读厚度 …`），激活时第一行放读数+剖切滑块、第二行放指令 |
| 详情区 | `flex-basis: auto`（自然高；开一个折叠区就变高） | `flex: 0 100 190px`：**固定 190px 滚动盒** + `scrollbar-gutter: stable`（滚动条出现/消失不改内容宽）；开折叠区只在盒内滚。极矮栏先压到 27px（保住一行标题，参数/导出仍可点），**再**才轮到视口让路 |
| 出错行 | 顶部插一行（把下面全推下去） | 改成**绝对定位浮层**（不占位）；顺带修掉"轮询失败的红条永不消失"（成功即清） |
| 截图后的定位 | `trayRef.scrollIntoView()` | 只滚详情盒自身（`detailsRef.scrollTop = scrollHeight`）——`scrollIntoView` 会连祖先滚动容器一起滚 |

**验收方式：这次是断言，不是看图。** 沙箱新增 `?assert=layout`：挂载后依次点击 测量 → 壁厚 → 剖切 → 参数 → 截图，每一步把面板**每个直接子元素**（以及工具条每个 chip）的 `w/h/y` 与基线比对，任何差异即 FAIL，结论直接渲染进截图（绝对定位的浮层按规则排除，因为它不占位）。

| dock | 基线视口 | 详情区 | 五步断言 |
|---|---|---|---|
| 380×900 | 355×497 | 190px | 全 PASS（`layout-stability-fake.png`）|
| 320×900 | 295×497 | 190px | 全 PASS（`layout-stability-320.png`）|
| 380×560 | 355×330 | 27px | 全 PASS（`layout-560.png`）|
| 380×1200 | 355×797 | 190px | 全 PASS（`layout-tall.png`）|

（截图那一步用 `fakerenderer=1` 替身；否则无 WebGL 时 `captureCanvas()` 返回 null，会弹出错浮层——浮层不占位，但会让子节点数变化。）

**代价（诚实标注）**：详情区由"自然高 ≈165"变为"固定 190 的滚动盒"，多出约 25px 常驻留白；反馈行常驻 38px（空闲时显示标准操作提示，不是空白）。矮到 560 时视口 355×330（略小于正方形）以保住一行标题可点——但**任何交互都不再改变这些数字**，这正是本次要买的东西。


#### v2.13f 详情区：一行目录 + 浮层阅读 + 参数两列（2026-09-30 追问）

> **来源**：「本版本上的验证、参数、导出等等全部在非常窄的空间里面，使用滚动条才能翻看，这个体验感太差，有没有别的方法？」（采纳 ②+①）。同轮三问：「壁厚和剖切两个按钮如何使用？用法还不太直观」「测量能不能两次选择后自动退出」「参数的使用场景很小」。

**病灶用数字说**（`sandbox/shots/details-scroll-params.png` 的探针）：详情盒 190px 里塞了 **497px** 内容 —— `client=190 scroll=497 (+307px hidden, 2.6x)`。更根本的是**目录比内容占地**：190px 里 ~120px 是意图说明 + 4 个折叠标题（4×26），真正给内容只剩 ~70px，所以连两个参数滑块都要滚。

**改法（②+①）**：

| 项 | 改前 | 改后 |
|---|---|---|
| 目录 | 4 个折叠标题行（≈104px） | **一行标签条**（26px）：`概览 验证 n 参数 n 导出 用法`（浮层则加 `报告/几何体`），节标题不再吃内容高度 |
| 内容高度 | 190−120 ≈ **70px** | **158px**（正文盒）并可通过「⤢」抬到浮层 |
| 参数 | 11 行 ×24px（标签+滑块+数字）= 264px，必滚 2.6 屏 | **两列网格 6 行 ×21px = 126px**，值全部可见；**滑块只属于正在编辑的那一行**（点 ▸ 或聚焦数字展开）→ 实测探针 `scroller` **消失**（+307px → 0） |
| 长内容（报告/导出/用法/预览） | 挤在 190px 里滚 | **「⤢ 放大」抬到浮层**：绝对定位、贴住视口区（`SHEET_BOTTOM_PX` 由下方 chrome 高度常量推出），可用高度 = 视口高度；**只覆盖视口，工具栏/指令行/标签条/状态带全部保持可见可点**（切标签、点测量都不用先关它），Esc 或 `✕ 收回` |
| 截图托盘 | 藏在滚动区底部（"点了没反应"的旧病灶） | 截图后**自动在浮层打开**；状态带的「📸 n 张待插入」变成一个**无边框无内边距**的按钮（多 1px 边框就会让状态带长高 2px、视口缩 2px——这条是断言抓出来的） |

**浮层为什么是绝对定位**：§6.9e 的规矩是"除视口外尺寸恒定"。浮层不占布局 → 放大/收回**不可能**改变任何盒子；断言把「⤢ 放大」「⤡ 收回」两步也纳入了比对（7 步全 PASS，380 与 320 两种栏宽）。

**同轮三个问题**：

- **壁厚 / 剖切怎么用**：新增「用法」节（可 ⤢ 放大）逐条写清操作步骤；指令行改成**以模式名开头**（`壁厚：点击零件任意处，读该处「沿视线」的材料厚度…`）；剖切增加**轴向选择**（原来只沿 z 横切，看中心孔这类内部结构必须能纵向切）——现在剖切行是 `剖切 [z▾] 50% [滑块]`。
- **测量两次后自动退出**：选完第二个点即退出测量模式（红点/连线/读数保留），视口立刻回到旋转/缩放，不用再点一次按钮。
- **参数的使用场景**：正文里直接写清楚——**参数只在版本用 `// PARAMS 描述` 注解标注了尺寸时才存在**（没有就如实说明怎么让它出现），用途是"改数字 → 自动预览 → 应用为新版本"，不必回会话叫 Agent；`概览`节另外固定显示**尺寸 bbox × 面数**（来自已加载网格），所以即使没有参数，概览也不是空的。

**验收证据**：`tabs-params.png`（11 个值一屏看全，无滚动）、`tabs-params-probe.png`（探针无 scroller）、`tabs-sheet-params.png` / `tabs-sheet-help.png`（浮层，工具链说明全文可见）、`tabs-tray-sheet.png`（截图自动浮层）、`tabs-overview.png`、`layout-stability-fake.png` / `layout-stability-320.png`（7 步全 PASS）。

**代价与剩余缺口（诚实标注）**：正文盒固定 158px，所以「用法」全文、带预览的参数编辑仍需 ⤢ 一次；浮层盖住模型（预览图在浮层内，编辑参数时看不到 3D 视口）；`SHEET_BOTTOM_PX` 是把下方固定 chrome 高度写成一个常量表达式——改那些高度时要同步改它（代码注释里记了这一条）。

#### v2.13g 把竖向余量还给详情区：视口留到「正方形 + 40」（2026-09-30 追问）

> **来源**：「思路对了，但是概览、验证、参数、导出、用法这个空间太小，只能再苦一苦视图了。」

**这次不用猜，用几何算**：取景由视口**短边**决定（§6.9 的 `fitDistance`），而面板是竖的 —— 所以**视口高过正方形之后，每多一个像素都只是留白，模型一点都不会变大**。反过来，视口一旦低于正方形，模型立刻按宽度缩小。于是最优切分是唯一的：

```
详情区高度 = 面板高 − 固定 chrome − (面板宽 + 40px)
```

即**视口正好"正方形 + 40px"**（40px 是给四角的坐标轴/比例尺留的余量），其余全部给详情区；再往下就不再让了，因为那才是真花掉模型尺寸的地方。

| 380×900 实测 | 改前 | 改后 |
|---|---|---|
| 详情区 | 158px | **260px**（+102，+65%） |
| 视口 | 355×495 | **355×393**（= 宽 355 + 38 余量） |
| 模型视觉尺寸 | 受宽度约束 | **完全不变**（多出来的 102px 原本只是上下留白） |

**并且给了手动档**：标签条上沿是一条**分隔条**（`role="separator"`，鼠标拖动 / 键盘 ↑↓、Shift 加速；双击或 Home 回到自动）。上限就卡在"视口正好正方形"——再往下模型就要缩小，tooltip 里写明了。手动值存 `localStorage`，自动档则随栏宽/窗高用 `ResizeObserver` 重算，不会过期。浮层锚点（`SHEET_BELOW_FIXED`）把详情区高度当变量加进去，所以浮层永远贴在"工具栏之上、视口之内"。

**验收**（`layout-stability-fake.png` / `layout-stability-320.png` 同一次运行）：

| 断言 | 结果 |
|---|---|
| 七步交互（测量/壁厚/剖切/参数/⤢放大/⤡收回/截图） | 全 PASS：**每个区域的盒子与每个 chip 的宽度都不变** |
| 分隔条 ↑↑ | `body +32, viewport −32, others unchanged` → 只动这两行，且增量精确 |
| Home | 恢复自动切分（与基线逐字段一致）|

**代价（诚实标注）**：视口的上下留白从 ~140px 压到 ~38px——模型本身大小不变，但视觉上更"满"；模型对角的轴标/比例尺离模型轮廓更近了（40px 就是为此留的，嫌挤可以拖动分隔条往回调）。分隔条的**鼠标拖动**无法在无头沙箱里验证（合成 pointer 事件过不了 `setPointerCapture`），实际验证走的是键盘路径与同一段 `setBodyH` 逻辑。

#### v2.13h 工具按钮进视口（2026-09-30 追问）

> **来源**：「截图、标注、测量、壁厚、剖切这一组按钮能不能放到视图里面去，就像是复原按钮那样？」

**做法**：这组按钮移到**视口左上角的竖排**（右上角仍是 `⤾ 复原`，左下坐标系，右下比例尺），视觉语言与复原那颗 chip 一致——半透明白底 + 细边框 + 轻阴影；激活态仍是彩色边框 + 底色（从不靠改字/改边框宽度表达状态，§6.9e）。竖排而不是横排：5 个带字 chip 横排 ≈287px，加复原 ≈355px，380 栏刚好贴上、320 栏必然溢出；竖排只占 66px 宽，且落在模型轮廓通常够不到的左上角。

**布局收益（这次是白拿的）**：工具行原本是流内一行 26px（+8px 间隔 = 34px）。移进视口后它是绝对定位、**不占布局**，自动切分（§6.9g）把这 34px 全给了详情区：

| 380×900 | 改前 | 改后 |
|---|---|---|
| 流内 chrome 行 | 5 行（浏览/工具/指令/标签/状态） | **4 行**（去掉工具行） |
| 详情区 | 260px | **294px**（相对最初 158px = **+86%**） |
| 视口 | 355×393 | 355×393（**不变**，仍是"正方形 + 40"） |
| 模型视觉尺寸 | 受宽度约束 | **不变** |

**验收**（`layout-stability-fake.png`，同一次运行）：七步交互（测量/壁厚/剖切/参数/⤢放大/⤡收回/截图）全 PASS、chip 宽度恒为 `66/66/66/66/66`、分隔条 `↑↑` 恰好 `body +32 / viewport −32`、`Home` 复原自动切分。工具条随视口一起缩放/滚动，因此 320 栏也不会溢出。`viewtools.png` 为实机（沙箱）截图。

**顺带修**：移走工具行后，自动切分的 `fixed`/`gaps` 常量忘了扣掉那一行（26+8），导致多出的 34px 先被视口吃掉、而不是给详情区——是断言里的 `VIEWPORT` 高度把它暴露出来的。这两个常量现在写着"流内 4 行 + 5 个间隔"。

#### v2.13i 角标合板 / 字母不越界 / 指令行压缩（2026-09-30 四问）

> **来源**：「比例尺和坐标系指示能不能放在同一个方块块里面？」「坐标系的字母有的时候会跑到方块块外边」「『视口左上角：…』这部分高度太高了，按钮既然已经移走了，就应该压缩他们的高度预算」「视图高度稍微压缩一点点，给功能区」。

| 问 | 做法 | 验收 |
|---|---|---|
| 1 合并角标 | 坐标系与比例尺合成**一块**板，放**左下角**（右上角仍是 `⤾ 复原`，左上角是工具组）：`display:flex; align-items:flex-end; gap:9`，比例尺不再是独立小牌 | 探针实测 `plate: 178×74 @ (827,854)`——**一块**板 |
| 2 字母越界 | 根因：字母画在 `arm+7 = 33` 处，而 SVG 是 66 宽、中心 33 —— **正好压在边界上**，10px 字再往外就溢出。改法：viewBox 加**内边距** `-6 -6 78 78`（画布内留 6 单位），臂长与字号不变；外加 `overflow:hidden` 兜底 | 新增 `?overlay=1` 沙箱：渲染真实 `ViewportOverlay` + 合成相机，逐个字母量到板边 —— `X +27.0px / Y +2.1px / Z +13.2px`，**全部在板内**（Y 的 2.1px 是 SVG `<text>` 行盒的保守值，可见字形更靠内） |
| 3 指令行太高 | 工具已经是视口里的按钮，那行"每个按钮干什么"的长句就多余了：反馈块 **38 → 20px（固定一行）**，常驻文案压成 `工具在视口左上角；「⤢」放大下面任一节`；测量/壁厚读数与模式指令挤进同一行（`flexWrap: nowrap`） | 断言 `chrome=355x20`，且七步交互下盒子不变 |
| 4 压视口 | `VIEWPORT_AIR_PX 40 → 16`（"稍微压一点点"），自动切分公式不变 | 视口 `355×369`（= 宽 355 + 14），详情区 `294 → 336px` |

**再压一档（用户澄清后，2026-09-30）**：所谓"压缩视口高度"就是**视口这个长方形在 y 上变矮**，省下的像素给功能区——机制上是 `功能区高度 = 面板高 − 固定 chrome − 视口高度`：视口是唯一弹性行，它不会"移动"，只是被压矮。于是 `VIEWPORT_AIR_PX` 直接取 **0**：自动档压到**视口正好正方形**为止（那之前模型一点不变小），并把分隔条上限放到"正方形再往下 80px"（`SLACK_BELOW_SQUARE_PX`——再往下就是在花模型尺寸了，tooltip 写明）。

**合计效果（380×900）**：功能区 **158 → 350px（+122%）**，视口 **355×495 → 355×355（正好正方形）**，模型视觉尺寸始终不变（受宽度约束）。断言：七步交互全 PASS、chip 恒 66px、分隔条 `↓↓` 恰好 `body −32 / viewport +32`、`Home` 复原自动切分。

**顺带**：分隔条的断言方向改成 `ArrowDown`——因为自动切分本来就贴着上限（视口 = 正方形 + AIR），只有往下才有余量；这条也是断言先报 FAIL 才被我发现的。`ViewportOverlay` 现在带 `data-corner` 调试钩子（同 `data-scale`/`data-ppm`），让探针能精确量这块板而不是猜 DOM。

#### v2.13j 解掉正方形地板：视口 4:3（默认）～16:9（2026-09-30 澄清）

> **来源**：「我不再坚持视口是正方形了，解放这个限制，视口长高比最大可以到 4:3 或者 16:9，另外零件选择和版本选择和视口之间的空隙太大，能不能压缩一点，省出来的空间给概览、验证、参数、导出、用法这部分功能区。」

**做法**：方形地板换成**比例带**——

- 视口基准改 `aspect-ratio: 16/9`（最扁允许值），**真实高度由功能区留下多少决定**：`视口高 = 可用高 − 功能区高`。基准取最扁值，是为了让基准永远不会反过来逼视口收缩。
- 自动档 = **4:3**（视口高 = 宽 × 3/4，380 栏 → 355×264）；分隔条最扁可到 **16:9**（× 9/16），再扁就纯亏模型。
- 空隙：面板 `gap 8 → 5`（"选择行与视口之间的空隙"就是这一条），工具组从竖排改成**横排纯图标**（66px 宽的竖排 5 个在 264px 高的扁视口里会吃掉一半高度），角标板里的三轴与比例尺同步缩小（66→56 / 60→52）。

| 380×900 | 最初 | 上一版 | **现在** |
|---|---|---|---|
| 视口 | 355×495（压缩前）→ 355×355（正方） | 355×369 | **355×264（4:3）** |
| 功能区 | 158px | 350px | **456px（+189%）** |
| 模型视觉尺寸 | 100% | 100% | **74%**（4:3 的代价；16:9 是 56%）|

**诚实的代价**：取景受**短边**约束，所以压扁就是**真的把模型显示小**（4:3 → 0.75×，16:9 → 0.5625×）。这是本次明确用"模型小一点"换"功能区大一截"——想两头都要时，拖动分隔条把视口拉回 1:1 或更高即可（超过 1:1 后模型不再变大，只是留白）。

**顺带修**：`S.details` 上还留着固定盒时代的 `maxHeight: 45%`，它把功能区**偷偷夹在 379px**（= 842 × 45%），使 4:3 的基准失效、视口反而留在 341px。是探针的逐子元素高度把它暴露出来的；现在这条 guard 已删除（切分由公式决定）。

**验收**（`flat-layout.png` / `layout-stability-fake.png`）：逐子元素探针 `VIEWPORT=355x264 / feedback=20 / strip=26 / body=456 / band=23`；七步交互全 PASS；chip 宽度恒定（图标同宽 34px）；分隔条 `↓↓` = `body −32 / viewport +32`；`Home` 复原自动档。

#### v2.13k 五问：工具竖排 / 去掉参数 / 截图自动复制 / 剖切修正（2026-09-30）

| 问 | 处理 |
|---|---|
| 1 按钮又变横排 | 改回**竖排带字**（`📸截图 / ▭标注 / 📏测量 / ▤壁厚 / ◐剖切`）。横排是上一版为扁视口做的，代价是把 `□` 与 `▤` 变成两个难以分辨的图标——正是第 5 问的来源。角标板改成**上下结构**：三轴在上、比例尺在下（74×91），比例尺**长度固定 52px**、只有**数值**变（`8.34 mm`，两位小数），`niceScale()` 删除 |
| 2 去掉参数 | 客户端**整块删除**：`params/overrides/preview` 状态、`loadParams/schedulePreview/applyParams`、参数标签页与两列网格、`/api/cad/{params,preview,apply-params}` 三个调用点。标签条现在是 `概览 / 验证 / 导出 / 用法`。**宿主侧那三条路由没有删**（已无引用，属死代码）——要清理我再动 host（需重启进程） |
| 3 截图自动进上下文 | 截图后**立刻自动写剪贴板**（趁点击的用户激活还在），提示改成「已复制到剪贴板（第 N 张）— 回会话输入框 Ctrl+V 即插入」，托盘不再自动弹出；写剪贴板失败才回退成"弹浮层 + 📋图 下载"。**未能验证成功分支**：本会话无头 Firefox 没有剪贴板权限，实测走的是回退分支（`five-items-shot.png`）；真机上一击即复制 |
| 4 剖切对不对 | 查了三件事：①**平面数学正确**——`Plane(-axis, cut)` 保留 `p≤cut`，探针实测保留/剔除两端正确；②**滑块不卡**——three 源码 `WebGLClipping.setState → projectPlanes` **每帧重传**平面数值，不存在"拖了不动"的缓存问题；③**真正错的是默认轴**：默认沿 z、取 bbox 中点，法兰的 z 跨度是 −30..18，切点落在 hub 里 → **整个法兰盘被切掉、只剩颈**，看起来就是"坏了"。现在默认轴 = **零件最长的那个方向**（法兰 → x，纵向剖开，能看见中心孔/密封面/颈部）；另外加了一层 **背面染色孪生网格**，让切口像切口而不是空壳。**已知缺口**：仍没有真正的"剖面盖"（stencil cap）——那是几十行我没法在无 WebGL 环境里验证的代码，不盲写 |
| 5 壁厚为何要先框选 | 是我上一版把按钮换成纯图标造成的误认：`□` 被当成"拉框测量壁厚"，而拉框其实是**标注**。现在两者都带字（`▭标注` / `▤壁厚`）。**壁厚是一点**：点一下按钮 → 点零件任意处即读出该处沿视线的材料厚度，全程不拉框、不需要第二个面 |

**验收**：`five-items.png`（竖排工具 + 四标签）、`overlay-corners.png`（上下结构角标板 74×91，X/Y/Z 内缩 14.5/3.6/13.0px 全在板内）、`five-items-shot.png`（截图回退分支与提示）。`tsc` 干净。

#### v2.13l 壁厚三问：拖动不乱框、单击即读、读数只走文字（2026-09-30）

> **来源**：「测壁厚…当我拖动时自动进行框选」「双击测壁厚之后自动退出…我也不想双击，能不能改成单击」「展示壁厚能不能用 tips + 文本（在视口下面一行字）」。

三个问题同源于一处**事件分层**设计，顺带暴露了第四个（用户没提）：

| 现象 | 根因 | 修法 |
|---|---|---|
| 壁厚模式下**一拖动就出现红框** | `overlayPointer()` 只对 `measureMode` 特判，**`thickMode` 掉进了标注的拉框分支**：pointerdown 建框、move 拉伸、up 提交成标注 | 拉框手势**只归 `annotateMode`**；其余模式在 pointerdown 只记录起点 |
| 壁厚要"双击"、读完不退出 | 拉框分支会 `setPointerCapture`，指针被那一层抓走；且读完没有退出逻辑 | 拾取改到 **canvas 所在的 mount** 上（overlay 在拾取模式下 `pointerEvents: none`），一次干净点击即读数；读完**自动退出**，与两点测量同形 |
| 壁厚读数展示 | — | 保持你要的"视口下面一行字"：`壁厚 0.50 mm（沿视线）` + 「清除壁厚」按钮；tooltip 里放近/远面点、版本、以及"斜看平板读数会偏大"的说明。3D 里的点/连线只作为截图标注 |
| **（附带发现）测量/壁厚模式下无法旋转和缩放** | overlay 盖在 canvas 上并吞掉 pointerdown → OrbitControls 收不到事件（滚轮同理） | 同上：拾取层的指针事件放到 mount 上，overlay 变透明 → 旋转/缩放恢复正常；拖动仍不会误触发测量（`pickRay` 的 4px 位移阈值），只有干净点击才拾取 |

**验收**（同一次断言运行，`thick-drag-assert.png`）：

```
PASS  七步交互（测量/壁厚/剖切/参数/⤢/⤡/截图）——每个区域与每个 chip 尺寸不变
PASS  drag in 壁厚 mode created no annotation (0 -> 0)      ← 用户报的那个 bug
PASS  the same drag in 标注 mode DID annotate  (0 -> 2)      ← 阳性对照，证明检查不是空过
PASS  splitter ArrowDown×2: body -32, viewport +32, others unchanged
PASS  Home restored the automatic split
```
（阳性对照第一次跑是 FAIL：我的合成事件打在了 mount 上，而标注的处理器在 overlay 上——是这条对照把"检查其实空过"暴露出来的。）

**未能验证**：**"单击即读数"本身**——沙箱无 WebGL 就没有 mesh，点击路径无法执行；它现在是一条普通的 canvas click，单双击行为由代码结构保证（拉框分支不再参与），但没有端到端的点击验证。

#### v2.13m 截图直接进会话输入框（2026-09-30，附：壁厚行高、复原清状态）

> **来源**：「我看了下 dsh-inapp-browser 这个插件似乎可以将图片直接插入上下文，请检查」「壁厚展示保留文本（高度放高 5px，否则清除壁厚按钮被遮住）但 tooltip 只要标注厚度」「复原按钮要能清除标注、壁厚等等状态」。

**1) 直接插入上下文的接口：找到了，但不是 `dsh-inapp-browser`**。本机（`~`、`examples/dsh-home`、`.dsh/profiles/{web,headless,cad-sandbox}`）**都没有这个包**——它不在已安装集合里。真正提供能力的是已安装且**带类型声明**的 `@deepseek-ai/dsh-client-ui-conversation`：

| 接口 | 位置（typings） | 作用 |
|---|---|---|
| `ctx.sessions.scope(id): AgentContext \| undefined` | `dsh-api-session-controller/lib/types/client/contract/sessions.d.ts:104` | 取一个 **Agent 作用域 ctx**（"use-and-discard"） |
| `ctx.conversation.createDrafts(sessionId, files: File[])` | `.../client/service.d.ts:117` | 图片 MIME 的 File → **图片草稿**（object URL 预览，字节随 prompt 发送） |
| `ctx.conversation.input.for(actx).addAttachments(ids)` | `.../contract/input.d.ts:176` | 把草稿 id 追加进**该会话的输入框**（忙碌阶段会拒绝） |
| `ctx.conversation.releaseDraftAttachments(drafts)` | `.../service.d.ts` | 被拒时释放，避免泄漏 |

于是截图流程改成三级：**① `insertImageIntoComposer()`**（File → createDrafts → input.for(actx).addAttachments）→ 成功即提示「已插入会话输入框（待发送）— 补一句话后直接发送即可」；② 剪贴板；③ 托盘浮层（最后兜底）。

**验证方式**：沙箱没有 conversation 服务，所以用 `?assert=insert` **桩掉这套文档 API**，验证我的胶水调用顺序与参数（`insert-glue.png`）：

```
1. sessions.scope(session-1)
2. input.for(actx ✓)
3. createDrafts(session-1, 1× cad-v034-截图.png image/png 263458B
4. addAttachments([draft-1])
hint shown: 已插入会话输入框（待发送）— 补一句话后直接发送即可
```
即：作用域取对、ctx 传对、File 是真 PNG（263KB）、顺序对、提示对。**真实 API 只能在你的 GUI 里跑**（`?assert=insert` 用的是桩），这一点必须说清。

**2) 壁厚行高与 tooltip**：反馈行 **20 → 25px**（20px 时「清除壁厚」按钮下缘被裁），tooltip 按要求只留 `壁厚 0.50 mm`（原来的近/远面点、版本、斜视说明全部移回正文与用法节）。视口仍是 **4:3（355×264）**，功能区相应 451px。

**3) 复原清状态**：`复原` 现在 = 相机回初始取景 **+ 清空标注 / 测量 / 壁厚 并退出这三个模式**，提示「视图已复原 — 测量 / 壁厚 / 标注已清除」。**剖切没有一起清**（它是显示模式、下面有可见的轴向+滑块控件）——要一并清我再改。

**回归**：`final-3items.png` 里七步交互全 PASS、壁厚拖动不产生标注 (0→0)、标注仍能拉框 (0→2)、分隔条 ±32、`Home` 复原自动切分。

#### v2.13n 视口里的 tooltip：画布上没有 DOM（2026-09-30）

> **来源**：「tooltip 没有拉起来哈，three.js 起 tooltip 的方法是不是和普通网页不一样？是不是要直接在画布上画一个？」

**先答问题**：WebGL 画布内部**没有 DOM**，所以"网页那种 hover 才弹的原生 tooltip"在模型上是拿不到的——你上次没看到，是因为我挂的是浏览器原生 `title`（而且它还在一个 `overflow:hidden` 的 25px 行里）。在画布上显示文字只有两条路：

| 办法 | 做法 | 取舍 |
|---|---|---|
| ① 画进画布 | canvas 贴图 / `Sprite` / 3D 文字网格 | 属于渲染结果（`toDataURL` 直接带走），但要处理贴图分辨率、屏幕恒定大小、朝向 |
| ② **DOM 按投影贴上去**（选了这条） | 每帧把世界坐标 `project(camera)`，用绝对定位的 DOM 元素跟位 | 文字清晰、样式随便改、**可被 DOM 断言**；截图时由已有的 2D 烘焙补上（测量/壁厚本来就烘了连线与标签） |

② 和坐标系、比例尺、工具按钮是同一套路（它们都是 DOM），保持一致最省事。

**实现**：`ViewportOverlay` 新增 `labels: {key,text,world,color}[]`。它已有的每帧 tick 里把这些世界点投影成屏幕坐标，写进 chip 的 `left/top`；`v.z > 1`（点在相机背后）或宿主尺寸为 0 时隐藏；chip 是 `pointerEvents:none`，所以不挡旋转、缩放和工具按钮。面板把两处读数接进去：

- 两点测量 → 中点上方 `12.34 mm`（红）
- 壁厚 → 中点上方 `壁厚 0.50 mm`（青）

视口下面那行文本**保留**（你要的"tips + 文本"，文本是文本、chip 是跟着模型的 tooltip）；原生 `title` 已删除（它既不可靠、又和 chip 重复）。

**验收**（`overlay-chips.png`，`?overlay=1` 用合成相机渲染真实 overlay）：

```
PASS  all 3 axis letters inside the plate (tightest inset 3.6px)
chip thick:  "壁厚 0.50 mm" at (190,432) in 380×900     ← 世界原点正好投影到视口中心，chip 落在其上方
chip behind: "不应出现"      at (190,51)                  ← 另一点仍在相机前方，正确地显示在它自己的位置
```
（chip 只存在于有相机的环境，所以这条走 `?overlay=1` 而不是面板沙箱——面板沙箱无 WebGL，没有相机也就没有 chip。）

#### v2.13o 截图真正进上下文：API 审计 + 改为「发送」而非「放输入框」（2026-10-01）

> **来源**：「我在别的地方看到有一些 api 可以将图片插入上下文，请检查」，并贴来一段据称来自 DSH 的示例：`await ctx.attachments.create({ data, mimeType, name })` → `return { content:[…], attachments:[attachment] }`，注释写「框架会自动将附件加入上下文」。

**1) 那段示例是编的：四处断言，三处错**。逐条对着已安装的 0.1.5-rc.3 类型声明与打包产物核：

| 示例的写法 | 真相 | 证据 |
|---|---|---|
| `ctx.attachments.create({…})` | ❌ **没有 `create`**。真名是 `saveImage(input)` → `Promise<ImageAttachmentRef>`，批量是 `saveImages(inputs[])`（保序、全成或全不写） | `dsh-attachment/lib/types/index.d.ts:42,72` |
| `mimeType: 'image/png'` | ❌ 字段叫 **`mediaType`**（`image/png｜jpeg｜webp｜gif`） | `dsh-attachment/lib/types/types.d.ts:115-121` |
| `data: screenshotBuffer` | ✅ 但要 `Uint8Array`（Buffer 是其子类，可用） | 同上 |
| `attachments: [attachment]`「框架自动加入」 | ❌ **工具结果没有 `attachments` 字段**。`ToolExecutionSuccess = { isError:false, value, content, meta?, additionalContexts?, concludesTurn? }`；多写的键会被声明式 output schema 判成 `ToolOutputError` | `dsh-tools/lib/types/index.d.ts:395-403,412` |

**对的部分**是它想表达的效果：图片确实有一条独立附件通道，**上下文里只留引用、不留字节**（`ImageBlock.attachment: ImageAttachmentRef`，`dsh-llm/lib/types/types.d.ts:54-58`）。但要**你自己**把 `{type:'image', attachment}` 放进 `content`：工具侧用 `output.render(args, value)` 或 `finalizeContent(exec, result)` 返回 `ContentBlock[]`，模型侧由 `contentHasImage()` 递归穿透 tool-result 内容识别。

**2) 我们自己的宿主半其实早就是这么写的**——`src/host/tools.ts` 的 `generate_part`：`ctx.attachments.saveImages([{ data: r.png, mediaType:'image/png', name }])` → `finalizeContent` 里 `blocks.push({ type:'image', attachment: r.ref })`。`render_part` / `simulate_*` / `measure_closest` 同款。所以**模型本来就看得到渲染图**，缺的从来不是这条通道。

**3) 缺的是面板那半：浏览器里截的图没有出口。** 上一版（v2.13m）止步于"塞进输入框，等你按发送"。真正"现在就把图交给模型"的客户端接口是：

| 接口 | 位置 | 作用 |
|---|---|---|
| `ctx.sessions.sessionOf(actx): SessionFace \| undefined` | `dsh-api-session-controller/client/contract/sessions.d.ts:117` | 从 Agent 作用域 ctx 取**会话本体**（feature 代码看不到具体 Session 类） |
| `ISession.prompt(content: PromptContentPart[], mode, signal?, requestId?)` | 同包 `contract/session.d.ts:104` | 底层：`PromptContentPart` 可直接是 `{type:'image', mediaType, data(base64), name}` |
| `ctx.conversation.sendSession(session, text, ids, mode)` | `dsh-client-ui-conversation/client/service.d.ts:111` | **高层封装**：注册本地回显 → base64 编码草稿 → `prompt()` → 等持久回显退役。选它 |

`sendSession` 的打包实现（`dsh-client-ui-conversation/lib/client.js:2899`）确认了整条链：`resolveDraftAttachments` → `beginSubmission`（对话里立刻出现这条消息）→ `encodeImage` → `session.prompt(content, mode, signal, requestId)` → 等 `onRetire` 的 `observed`；失败时**草稿不释放**，注释原文"remains registered so the composer can restore it"——所以抛错后接"塞进输入框"是官方语义，不会丢图。

**4) 改动**：`insertImageIntoComposer()` → `sendImageToSession()`，📸截图 现在**一发即达**，三级兜底：① `sendSession`；② `input.for(actx).addAttachments(ids)`（发送通道挂了才走）；③ 剪贴板 → ④ 托盘浮层。失败**不再静默**：`console.warn` + 提示行里写明原因（例：`发送失败（没有活动会话）— 第 1 张已存入浮层`），托盘每行状态从"发送中"落到 已发送/待发送/已复制/需手动发送。

**`mode` 恒为 `'queue'`**：截图的语义是"给你看这个"，绝不该打断正在跑的回合。为此放弃了 composer 的 `resolveSubmitMode(busyEnter, running, …)` 翻转逻辑（那属于"我按了 Enter"的手势语义，不适用于一个纯观察动作）。托盘每行因此多了一颗 **`↻发`**（重发，可附备注）——草稿重发是 `sendSession` 的天然用法。

提示文本带身份，图带几何：`CAD 视口截图 — 零件「带颈平焊法兰 DN25 PN16」· 版本 v034 · 截图` + 第二行 `包围盒 … mm · 两点测量 … · 壁厚 … · N 处标注框`（只写面板确知的量，不猜）。

**验收**（沙箱没有 conversation 服务，所以仍用桩，桩这次**连 `sessionOf` 一起桩**，并对 `?sendfail=1` 模拟抛错以验证兜底不泄漏）：

```
send-to-context glue (stubbed API, sendFails=false)        sendFails=true
  1. sessions.scope(session-1)                               1. sessions.scope(session-1)
  2. sessions.sessionOf(actx ✓)                              2. sessions.sessionOf(actx ✓)
  3. createDrafts(session-1, 1× cad-v034-截图.png …263458B    3. createDrafts(…)
  4. sendSession(face ✓, "CAD 视口截图 — 零件「…」· 版本 v034 · 截图", [draft-1], 'queue')   4. sendSession(face ✓, …)
band chip: 📸 1 张截图                                        5.   ↳ sendSession threw (simulated)
hint: 截图已发送到会话（排队）— Agent 下一回合就能看到这张图       6. input.for(actx ✓)
                                                            7. addAttachments([draft-1])
                                                            hint: 已插入会话输入框（simulated refusal）— 补一句话后发送
```

两条都**没有**出现 `releaseDraftAttachments (leak!)`（成功路径压根不走兜底、失败路径草稿被正确接管）。版式回归 `layout-after-send.png` 11/11 PASS：六个常驻盒子仍是 `26 / VIEWPORT 355×264 / 25 / 26 / 451 / 23`，chips 66×5 不变，壁厚拖动不产生标注 (0→0)、标注仍能拉框 (0→2)、分隔条 ±32、`Home` 复原自动切分。

图：`sandbox/shots/send-ctx-ok.png`、`send-ctx-fallback.png`、`layout-after-send.png`。

**遗留（必须说清）**：真机上 `sessions.sessionOf` / `sendSession` 是否存在、`list.get().current` 是不是 `SessionId`——**只有你的 GUI 能证**（沙箱是桩）。刷新页面点一次 📸截图：对话里应当立刻多出一条带图消息；若失败，提示行会写出原因、控制台有 `[cad-harness] 截图未能发送到会话:`，把那条发我即可。

### 6.10 零件：版本控制对象（v2.14）

> **来源**：2026-09-28 追问——「我们在决定如何渲染之前，这个插件新建了零件，这个零件是否需要版本控制？」本文回答的是**领域模型**，不是代码仓库的 git。

**结论**：不是"先做出零件、事后套一层版本"，而是——

> **零件 = 版本库本身。**

| git | 本插件 | 状态 |
|---|---|---|
| repository | 零件（`data/parts/manifest.json` 的 `PartEntry`） | ✅ v2.14 |
| commit | 版本 `vNNN`（不可变；`parentVersion` 限同零件并校验） | ✅ v2.14 |
| CI run | 验证运行 `rNNN`（挂版本上，可跨零件） | ✅ v2.13 |
| `git init`（空仓库） | 零件可先于第一个版本存在 | ✅ v2.14（`create_part`） |
| **HEAD** | 当前基线是哪一版 | ❌ **待办** |
| tag / revert | 审批、回滚 | ❌ 待办（`status` 恒 draft） |

**为什么这是病根（实测证据）**：v2.13 之前是"孤儿快照 + 事后贴标签"——33 个版本里 **32 个没有 `parentVersion`**，同一零件被造成 5 个互不相干的根（调焦轴 = v011/v016/v021/v026/v031），唯一那条 parent 链还指错了（v003 圆柱轴 ← v002 方形底座）。**没有零件实体，面板就不可能回答"这是哪个零件"**；这不是渲染层的问题。

**零件的诞生时机（v2.14 决定）**：
- **显式**：`create_part({name})` 建一个**空零件**（幂等，重名返回既有零件）。用于"先立主体、再填内容"（人说"我们做一个调焦轴"，几何还没谈拢）。
- **隐式**：`generate_part` 带 `part:"调焦轴"` 时自动建（`ensurePart`）；不给 `part` 且没有 `parentVersion` 时按 `userIntent` 推导名字并标记 `nameSource:'intent'`。
- **校验**：`parentVersion` 与声明的 `part` 不同零件 → **报错**（`resolvePartForGeneration`），并给出可执行的修复建议；跨零件的父子链不再可能悄悄写进去。

**面板随之改为两级**（§6.9b 的"产物"从此有了一级）：`零件(零件名·N版·M验证) → 记录(版本|该零件上的运行)`，另有 `⚙ 跨零件场景` 收纳 0 个或 ≥2 个来源零件的运行。**进入零件默认落在最新版本**；此后只有"新记录真的出现"才自动切过去（不按时间戳硬抢——迁移语料里 r003 只比 v030 新 227ms，硬抢会把你正在改的版本顶掉）。

**迁移**（`scripts/migrate-parts.mjs`）：只按 `userIntent` 原文分桶，**不用 `parentVersion`**（那条唯一的链是错的）；33 版 → 13 个零件，5 组各 ×5，其余 8 个单例。所有迁移零件标 `nameSource:'intent'`，面板如实显示"零件名由 userIntent 推导"。已知缺陷：**分不清"同零件不同参数"与"不同零件"**——「调焦轴 Ø8」与「负样本: 轴 Ø9.2」被拆成两个零件，尽管后者是前者的变体。这正是身份改为"显式声明"的原因。

**待办（诚实标注）**：HEAD / 回滚 / 审批标签未做——目前"当前版本"由时间戳推得，面板的「跟随最新 / 已钉住」只是**视图偏好**（关掉页面即失），不是模型状态；零件也还不能删除/重命名（`renamePart` 已备但无入口）。

**版式收口（同日追问：把零件、记录、跟随最新放一行）**：零件与记录的选择器合并成一行，去掉两个文字标签，跟随按钮缩成 `●`/`○` 图标（语义进 tooltip），零件选项只留 `名字 · N版`（验证次数与名字来源进 tooltip）。**两个下拉等宽**（`flex:1 1 0`）——零件与它的记录是同一层级的两种选择，不该由内容长度决定谁占宽；零件名短时空出的宽度归记录，320px 下两者各 ≈118px。理由：省下的竖向空间归视口（当时视口是 `aspect-ratio:1` 的方框、宽度定高，见下方 v2.14b 的修正——**"突出视图"靠减 chrome，不靠改方框**）。截断顺序也设计过：记录标签把可识别信息放前面（`v030 · 最新 · 09-28…`），窄到 320px 也只截掉描述，不会截成 `v030 · 版4` 这种歧义串。实测见 `sandbox/shots/row-{320,380,520}.png`。

**版式再收口（同日第四轮：视口不必是正方形 + 底部要有状态位，v2.14b）**：

> **来源**：「视图保持为正方形，我觉得不是个好选择，最下面还应该给一点空间展示状态，只要不能喧宾夺主、抢了视图的第一公民为止即可。」

- **正方形从上限改为下限**。旧版 `flex:none + aspect-ratio:1` 让视口恰好等于面板宽（380 栏 → 355×355），余下的全给详情区——而**折叠状态下的详情区就是一块空白盒子**：380×900 实测详情区 411px、内容只占 ≈80px；380×1200 更是 711px 空白。现在 `aspect-ratio:1` 只提供 **flex 基准**，`flex:1 1 auto` 让视口吃掉余量：380×900 → 355×568，380×1200 → 355×868，520×900 → 495×568；详情区回到**内容自然高**（165px）。
- **为什么"变高"不等于"变大"**：取景是"包围球内切于**较窄的那条视场**"（新增 `src/client/fit.ts` 的 `fitDistance()`）。模型视觉尺寸由视口**短边**决定——比正方形高 → 与正方形一样大（多出上下留白）；比正方形**矮**（横向）→ 立刻变小。所以"正方形是下限"不是口味，是几何结论：竖向余量给视口不亏，横向压缩必亏。
- **顺带修掉一个真实的裁切 bug**：旧取景是固定距离乘子（`r*1.6 / r*1.2 / r*1.6`），只对竖直角负责。4000 点球面投影实测：aspect=1 时球面已溢出到 max|NDC|=1.024（≈2%，一直靠"零件不满包围球"掩盖），aspect=0.58 时横向溢出到 **1.765**——**视口一变竖，模型两侧就会被切掉**。改成按当前 aspect 求距离后，aspect ∈ {1.0, 1.5, 0.58, 0.38} 实测 max|NDC| ≤ 1.000（内切）。`playback.ts` 的三条回放共用同一函数，`复原` 也改为按当前 aspect 重算，dock 变宽/变高后一点即修。
- **详情区让路，视口不让**：`details: flex: 0 100 auto`（收缩因子 100，视口 1）。空间不足时先滚详情区、视口保持 ≥ 正方形：380×560 实测视口 355×352、详情区压到 41px 并滚动；380×400（极端）视口 355×233、详情区 0、**面板仍不溢出**（旧版这里会溢出被 `overflow:hidden` 吃掉）。
- **底部状态带**（`S.status`，11px 单行、贴底、可省略）：`[✅/❌/⚠️ 结论词] 记录id · 类型 · 第 i/N 版 · 时间 — 摘要`，右侧冻结出处（`来源 4 版` / `本版无验证` / `内联 SCAD`）。**只写上面那行下拉写不下的东西**：零件名与记录 id 已经在下拉里，状态带补的是**结论词、版本序号、出处**；tooltip 里有全文（含来源版本号）。
  - **版本自己永远没有结论**（`status` 恒为 `draft`）：结论**由"关于它的运行"推导**——没有运行 = 未验证，有则取最严（fail > check > pass）。这是"诚实标注"落到像素上：没验过就写"未验证"，不冒充通过。
- **验收证据**（`sandbox/shots/`）：`band-380x900` / `band-380x560` / `band-380x400` / `band-380x1200` / `band-520x900`（各尺寸竖向预算，探针逐子元素给出 y/h）、`band-run-fail`（r003 清单检查 → `❌ 失败`，出处 `来源 4 版`）、`band-scene`（⚙ 跨零件场景 → `⚠️ 待复核` / `内联 SCAD`）、`band-empty`（0 版零件 → 状态带只写"该零件还没有记录"，不显示结论位）、`band-open-run-560`（展开运行报告时视口仍不小于正方形）。空零件用例用 `CAD_SANDBOX_DATA` 指向一次性数据副本跑，不写真实 `data/`。
- **本次没能验证的**：会话内 `/dev/shm` 只读 → WebGL 不可用，**3D 像素与取景观感无法出图**；取景只有数值验证（球面投影 max|NDC|≤1）。版式、状态带、各元素尺寸均为 DOM 实测。

**顺带修掉的真 bug**：WebGL 上下文创建失败时，整块面板会**崩成空白**（React 渲染抛错整树卸载）。现在面板与三条回放都降级为一张说明卡（"此环境无法创建 WebGL 上下文；版本、运行与报告仍可浏览"）。成因实测：Linux 上 `/dev/shm` 只读即触发（沙箱本次就撞上了）。同时补上 `renderer.forceContextLoss()`——`dispose()` 不释放上下文，之前每切一次版本泄漏一个，约 16 个后必然报 "Error creating WebGL context"。

---

## 7. 安装与共享

> **v2.11 回填**：本节原为「内部共享」计划（私有 git / 私有 registry 三阶段）。**当前实作**：本地工作区链接安装（虚拟 DSH 沙箱即此法），无 git/registry 分发；定位已于 2026-09-27 升级为**开放使用**（HARNESS.md §1/§10），但公开分发方式（公开 npm / 公开仓库）**尚未定**，`package.json` 仍 `private: true`。

### 7.1 安装方式（当前可用）

开发期用本地路径链接（`-w` 即 workspace/link），沙箱 profile 就是这么装的：

```
dsh plugin --profile <profile> add -w /path/to/dsh-cad-harness
# 隔离沙箱：dsh --profile cad-sandbox --port <port> --no-open
#   DSH_HOME 由 ~/.local/bin/dsh wrapper 强制为 <ToyMarker>/examples/dsh-home（v2.8）
```

改动 Host 代码后需 `pnpm run build` 重建 `lib/`，并**重启 dsh 进程**（宿主 bundle 不热重载）。

### 7.2 版本约定（当前）

- `package.json` version 仍为 `0.1.0`；**无 git tag 流程**（项目当前不是 git 仓库）
- 版本可追溯性目前靠**插件自身的版本库**（`data/versions/vNNN` + manifest）与 DESIGN.md 的版本记录（v2.1→v2.11），不是发布版本号
- 📌 开放化前置项：建立 git 仓库 + tag 流程 + 变更日志（HARNESS.md §10 顺序）

### 7.3 可调参数的暴露（v2.11 更正：无 config.ts / 无 dsh Config schema）

参数**不是**集中配置，而是工具入参（每次调用显式给，或由预设推导）：

| 参数 | 位置 | 默认 |
|---|---|---|
| 装配间隙阈值 `clearanceThreshold` | `validate_assembly` 工具入参 | 0.75mm |
| 邻接发现阈值 `adjacencyThresholdMm` | `runAssemblyCheck` 选项 | 0.75mm |
| 粒子数 `particleCount` | `simulate_fluid` 入参 | 按 4-8 粒/格自动（上限 1e6） |
| 网格步距 `dxMm` | `simulate_fluid` / `deriveFluidPreset` | 2mm（**精度旋钮**） |
| 关键帧预算 `keyframeCount` | `simulate_physics` 入参 | 6 |
| 仿真步数 `steps` | 各 simulate_* 入参 | 按场景推导 |

📌 若要让团队/用户共享一份集中配置，需要新增 dsh Config schema（目前不存在）——列为开放化待办。

### 7.4 运行时数据位置

`<plugin>/data/`（各域报告、版本库、帧数据、计量）。虚拟 DSH 沙箱的 **DSH_HOME** 在 `examples/dsh-home`，二者互不重叠：前者是插件产物，后者是会话/凭证/配置。

---

## 8. 里程碑

### M0：插件地基探针（2-3 天）

- 最小静态客户端插件：esbuild 产出 `lib/client.js`，`dsh.client` 声明
- 一个 React 面板挂到 layout `main` slot
- 面板经 Remote RPC 调 Host 半一个 echo endpoint；Host 精确 GET 路由服务一个测试 STL 并在面板中加载
- 附件图片经 dsh 附件机制发给 DeepSeek，确认多模态返回

**验收**：面板显示 Host 返回的数据；Three.js 场景里能看到测试 STL；DeepSeek 能描述传入的图片。

### M1：视觉循环（1-2 周）

- dsh 插件骨架（Host + Client）
- OpenSCAD CLI 调用器
- Three.js 多视角渲染 + 拼图
- LLM 评审接口
- 版本管理
- 3D 预览面板

**验收**：给定「一个带四个安装孔的法兰盘」，3 轮内生成可编译、外观合理的代码。

### M2：Manifold + 装配验证（1 周）

- OpenSCAD 切换到 Manifold 后端
- 水密性检查
- 装配间隙验证工具
- 多零件编辑器 + 验证报告面板

**验收**：两个干涉零件被正确检测；两个有间隙的零件距离计算准确。

### M3：刚体物理（1 周）

- rapier 集成
- 场景定义 UI
- 仿真循环 + 抽帧
- 穿透、倒地、关节违规检测
- 抽帧图给 LLM 评审

**验收**：铰链门能转动；高重心零件倒地；抽帧图能展示过程。

### M4：MPM 跑通（1 周）

- MLS-MPM solver 集成（Node 侧 CPU 内核——架构依据与粒子数基准见 docs/archive/M4-PREP.md §1；WebGPU 移交后续交互面板）
- 管道边界加载（STL → 窄带 SDF）
- 粒子初始化和入口速度
- 点云快照渲染（纯 JS PNG）+ 快照导出
- `simulate_fluid` 工具 + 人工发起路由（docs/archive/M4-PREP.md §4.6）

**验收**：直管离线跑通——粒子从入口流到出口、不穿透、粒子数守恒（默认 4-8 粒/格，典型 5 万-30 万粒子）。

### M3.6：机构运动仿真（必须交付，3-5 天）

- rapier 扩展：prismatic 关节、关节电机（velocity 模式）、kinematic 预设驱动（oscillate）
- 运动干涉时间线（采样位姿 × Manifold 精确布尔）
- 行程/周期/相位指标 + 堵转（jammed）检测
- `simulate_motion` 工具 + 人工发起路由

**验收**：单缸四冲程——曲轴匀速（周期误差 <5%）、活塞行程 ≈ 2r、全周期运动干涉 = 0、关键帧可见四个冲程；机构装错时报 jammed/干涉（负样本必须能发现问题）。设计：docs/archive/M3.6-MOTION-PREP.md。

### M4R：场地化 + MPM 可视化一等公民（3-4 天，v2.4 新增，同日修订为场地思路）

- **场地思路（核心修订）**：不发明场景 API——插件 src 模块（mpm/sdf/mesh/fluid-render）作为**真实库**开放给真实运行时：会话 agent 用自有 shell/Node 写普通 TS 脚本 import 之（对齐 DSH 原则：DSH 也不给 Python 加新函数）。狗食原则：插件能调的 LLM 就能调，一套代码两个消费者
- fluid.ts 封闭场景语义拆为库级原语（种子/驱动/度量分离）；渲染参数化（视角/剖切/着色通道）进库；`examples/` 场景脚本（`simulate_fluid` 降级为其中一份，等价回归基准）
- 帧 `.bin` 落盘 + manifest + GET 路由；MPM 面板 v2：three.js 粒子回放（时间轴/速度着色/剖切）
- 工具层只保留插件不可替代的服务：图进会话、版本库、面板数据、人工按钮守卫运行器

**验收**：LLM 全程用自有 shell + 库跑通一个表单表达不了的场景（计时阀门或双入口），无专用工具依赖；面板回放人工核判；LLM 消费帧数据写自己的死区分析；accept-m4 24 断言以示例脚本等价性回归通过。设计依据：docs/archive/M4-PREP.md §9。

### M5：MPM 分析（v2.4 重定义，1 周内）

- ~~截面流速统计 / 质量守恒检查 / 死区检测 / 规则引擎 + 建议生成~~（取消——解读不是插件的活）
- 插件只供：帧数据 + 参数化渲染 + 面板回放（M4R 交付即是 M5 的全部基础设施）
- LLM 写分析脚本消费帧数据（死区聚类、截面流量、守恒复核）+ 直接判读渲染图给出改进建议

**验收**：90° 弯管案例，LLM 基于帧数据/渲染图定位死区并给出改进建议，人工认可合理。

---

## 9. 已知风险与规避

| 风险 | 影响 | 规避 |
|---|---|---|
| OpenSCAD nightly + Manifold 安装复杂 | M1 阻塞 | 先用默认后端跑通，M2 再切换 |
| WebGPU 浏览器兼容性 | M4 阻塞 | 只用 Chrome/Edge |
| MPM 参数敏感，容易爆炸 | M4 返工 | 固定 dt、限制粒子数、提供预设场景 |
| rapier 动态刚体需要凸包，复杂零件分解难 | M3 受限 | 简单零件用解析形状，复杂零件只做静态边界 |
| LLM 生成代码质量不稳定 | 全流程 | 限制轮数、保留 PARAMS 区、人工审查 |
| `dsh.client` 声明格式与实际有出入 | M0 阻塞 | M0 探针先行，以 `dsh-package-manifest` 类型定义为准 |
| 图片仅限 user role 消息 | M1 评审循环 | 评审 prompt 固定为 user 消息，历史上下文只回传文本 |
| `lib/client.js` 忘构建导致宿主激活失败 | 开发期 | 构建挂进安装脚本，缺失时按 dsh 报错提示处理 |
| MPM 后处理统计意义不明 | M5 效果差 | 只做趋势判断，不做精确数值承诺 |
| dsh 插件 API 变更 | 全流程 | 关注 dsh 更新日志，插件保持薄封装 |

---

## 10. 给编码 Agent 的说明

> **v2.11 更正**：原第 1/4/7/10 条与实作不符，逐条按现状改写（其余条款仍然有效）。

1. **优先级**：M0 → M1 → M2 → M3 → M3.6 → M4 → M4R 已交付；当前主线为 **A0' 装配表示 + 装配视觉表达**（DESIGN.md §31.2），M5 已重定义为「解读归 LLM」
2. **代码风格**：TypeScript 严格模式，函数式优先，避免类继承
3. **错误处理**：所有外部调用（CLI、LLM、仿真）必须有超时和重试（编译 30s 超时 + 渲染失败重试；仿真由内核守卫与发散检测兜底）
4. **日志**：**无统一 logger、无 `./logs/`**（原文与实作不符）。现为：进程内少量 `console.*`；结构化结果一律落盘 JSON（`data/<域>/<域>-report.json`），计量落 `data/usage/usage.jsonl`
5. **测试**：每个模块至少一个验收脚本，放 `./scripts/`（`accept-*.mjs` 断言 + `smoke-*.mjs` 冒烟 + `bench-*.mjs` 基准）
6. **不引入**：数据库、消息队列、Docker、CI/CD、Vite
7. **配置**：**无 `config.ts`、无 dsh Config schema**——可调参数是工具入参（见 §7.3）；若要集中配置需新建 Config schema（开放化待办）
8. **文档**：每个模块顶部写 JSDoc，说明输入输出和边界条件（`mpm.ts`/`sdf.ts`/`manifest.ts` 等已成惯例）
9. **dsh 插件约定**：Host/Client 分离；工具经 `ctx.tools.register(defineTool)`；浏览器能力经 `connection.fetch.register` 精确路由；不声明 `connection` inject 而是 `ctx.reflect.get` 轮询（headless 无该服务）
10. **分发**：`package.json` 仍 `private: true`；定位已开放（HARNESS.md §1），但公开分发方式未定——**不要在未决策前改为 public 或改包名**
11. **新增纪律（v2.10/2.11 教训）**：改动实现后**同轮回填 §5/§6 对应章节**，或至少在 §13 实施实录写明差异——本轮发现多处「实现推进、设计章节停留在 M1 规划」，以及一处「验收写了但没做」（§6.8 回滚/审批）

---

## 11. 版本记录

### v2.1（2026-09-25）实现修订

- **OpenSCAD 升级**：改用 2026.09.23 snapshot（Manifold 后端），弃用 2021.01 CGAL。性能实测：简单件 1.2×、法兰 7×、螺纹件 STL 17.3× / 渲染 8.2×。二进制解析链：`CAD_OPENSCAD_BIN` → `bin/squashfs-root/usr/bin/openscad` → 系统 openscad；Manifold 后端显式启用；快照二进制自动补 `LD_LIBRARY_PATH`。
- **渲染管线提速**：`xvfb-run` 每调用 ~3s 的 X server 启动税是原瓶颈（5 次调用 ≈ 15s）。改为进程内共享一个 Xvfb（`-displayfd` 自选空闲显示号 + GL 预热 + 渲染重试），全管线 15.7s → ~1s（15.6×）。
- **BOSL2 标准件库内置**：`lib/BOSL2`，经 `OPENSCADPATH` 对所有 openscad 调用生效；generate_part 工具描述已声明可用（螺纹/齿轮/圆角/结构件用 BOSL2，不手搓）。
- **新工具**：`render_part`（模型主动按视角/旋转/缩放/剖切渲染，~300ms/帧）、`measure_part`（包围盒/体积/表面积/质心/genus/水密——数值真值核对）。
- **视角标签修正**：z-up 约定下 `front/top` 曾标反（`[0,0,0]` 是俯视），已修正。
- **参数面板（Customizer）**：SCAD 中 `name = value; // PARAMS 描述` 即为可调参数；`GET /api/cad/params` 解析、`POST /api/cad/preview` 按覆盖值渲染；面板滑块 + 防抖预览。
- **多格式导出（升级为必做）**：`GET /api/cad/export?v=&format=`，支持 STL/3MF/OFF/OBJ/WRL（AMF/PLY 该 snapshot 不支持），转换结果按版本缓存；面板收进「导出」折叠区（v2.13 前是常驻按钮行）。
- **截图与标注（人审通道）**：面板「截图到会话」+「标注问题区域」（拖红框合成进截图），经剪贴板粘贴进会话；草稿服务链路已通，composer chip 渲染为遗留调查项。
- **已知注意**：DeepSeek/GLM 图片仅限 user role 消息；compose 草稿栏对图片草稿的呈现依赖 ui-attachment 渲染路径。

### v2.2（2026-09-25）范围修订

- **新增 M3.6 机构运动仿真（必须交付）**：装配体运动过程模拟（曲轴-连杆-活塞-气门四冲程为验收基准），rapier 扩展（prismatic/关节电机/kinematic 预设驱动）+ 运动干涉时间线（采样位姿 × Manifold 精确布尔）+ 堵转检测；§8 里程碑新增，§12 必办。设计：docs/archive/M3.6-MOTION-PREP.md
- **M4 架构修订**：MLS-MPM 定为 Node 侧 CPU 内核（M3 headless 先例；粒子数扩展基准 ~0.34µs/粒子/步，8.8k→564k 实测——固定 dx 下精度由网格分辨率决定而非粒子数，M5 统计甜点 4-8 粒/格）；验收修订为「直管离线跑通」，粒子数 5 万-30 万不设 1 万上限；WebGPU 移交后续交互面板。依据：docs/archive/M4-PREP.md §1/§1.1/附录 A（内核已实现，`scripts/bench-mpm-scaling.mjs`）
- **验证边界确立**：三层判据（L0 静态几何 / L1 刚体 / L2 流体），主语物态为唯一判据；L1 拆 `simulate_physics`（动力学行为）与 `simulate_motion`（机构联动）两工具，描述互相交叉引用；能力≠工具范围（MPM 可做刚体与定性应力，选型依据是更准更便宜）；人工发起三路径（会话点名 / POST 运行路由 / 面板按钮）。见 docs/archive/M4-PREP.md §4.6
- **长期目标入库**：弹性本构扩展——mpm.ts 加变形梯度 F 与 fixed-corotated/neo-Hookean 预设，单体定性应力/变形验证，趋势判断非 FEA（§12 长期待办）
- **补 M2/M3 缺口**：`measure_distance` 两点测量 + datum 锚点约定；`measure_closest` 最近点对求解器（零坐标、标注渲染）——测量家族补齐：整体(measure_part)/两点(measure_distance)/求解(measure_closest)/零件对(validate_assembly)

### v2.3（2026-09-25/26）补缺补差与 M3.6/M4 交付汇总

> 本轮会话自 v2.2 范围修订起，完整交付 M3.6、M4，补齐 M2/M3 测量缺口与人工标注。明细见 §13.6-13.8，此处为索引。

**交付清单**

| 交付 | 内容 | 验收 |
|---|---|---|
| MPM 内核 + 性能基准 | mpm.ts CPU MLS-MPM（零重力塞流/沉降/弯管通用）；粒子数阶梯 8.8k→564k 实测 ~0.34µs/粒子/步；固定 dx 下精度由 dx 决定 | bench 全档稳定 + 附录 A |
| SDF 边界链路 | sdf.ts：STL→水密→BVH 距离+三射线奇偶符号→solidMask/solidNormal/trilinear | 直管 10/10 断言，6.9 万格 260ms |
| M4 流体仿真 | fluid.ts（投影回推/escape 守恒审计/时间平均分速）+ fluid-render.ts 零依赖 PNG + `simulate_fluid` + `/api/cad/fluid[/run]` + 面板按钮 | accept-m4.mjs 24/24 五案例 |
| M3.6 机构运动仿真 | motion.ts（rapier 纯约束 + Manifold 干涉时间线 + 双驱动）+ `simulate_motion` + `/api/cad/motion[/run]` | accept-m36.mjs 17/17 四冲程 |
| 测量家族 | measure.ts：`measure_distance`（datum/吸附/跨零件）+ `measure_closest`（最近点对求解 + 标注渲染） | accept-measure.mjs 12/12 |
| 人工 CAD 式标注 | 面板「📏 测量两点」（射线拾取+尺寸线）+ 截图烘焙 + 备注自动带精确数字 | 构建验证 + 与标注框链路同构 |
| 方案与调查产出 | docs/archive/M4-PREP.md（含插件库 12005 项扫描：M4 域零重叠、CAD 查看域 6-8 个参考）、docs/archive/M3.6-MOTION-PREP.md（含 MPM 耦合四档探讨）、验证边界三层判据（§13.7 前置 docs/archive/M4-PREP.md §4.6） | — |

**关键设计原则（本轮确立，后续沿用）**

1. **模型输出意图/引用，几何引擎解析真值**——datum 名字、特征引用、球探针，都优于让模型吐坐标
2. **物理验证闭环 host 侧 headless 完成**（M3 先例延续到 M3.6/M4），渲染图做模型判读通道
3. **人工与 LLM 共用同一几何引擎与真值格式**，仅入口不同（三路径：会话点名 / POST 直发 / 面板按钮）
4. **能力 ≠ 工具范围**：MPM 能做刚体与定性应力，但工具选型按「更准更便宜」划界（L0/L1/L2 三层判据）

### v2.4（2026-09-26）M4 设计反思修订（M4R）

- **原则回归**：插件核心 = **与人交互 + 给 LLM 合适的工具**；MPM 的重点是把结果**可视化**，不是约束怎么仿真；**仿真代码归 LLM**。M4 违反了 v2.3 原则 1 与 M1 先例（OpenSCAD 式：给语言 + 执行 + 渲染 + 测量，不约束怎么写）
- **约束归位**：约束从「场景语义」移回「内核数值完整性 + 资源守卫 + API 表面」；场景表达与结果解读交还 LLM
- **病灶证据**（代码）：`simulate_fluid` 表单冻结场景语义（单入口带/单出口面/盒形种子，扩场景须改源码）；面板结果一行字、快照 4 帧留 2、`void snapshots` 丢弃全量粒子数据；原 M5 规则引擎把解读也硬编码
- **M4R 两支柱**（同日二次修订：从「场景 API」纠正为「场地思路」）：A 库即 API——插件 src 模块原样开放给真实运行时（会话 agent 的 shell/Node），不发明场景 DSL（DSH 也不给 Python 加新函数；分界线：为控制 LLM 设计的窄接口是包工头，真实能力的开放是场地）；B 可视化一等公民（面板 three.js 粒子回放 + 渲染参数化进库 + 帧 `.bin` 落盘与访问）
- **M5 重定义**：取消规则引擎；插件供数据 + 渲染 + 面板，分析归 LLM
- **保留**：mpm.ts/sdf.ts、内核数值防护、三发起路径、验收硬指标哲学
- **诚实代价**：场地思路下第一义务变为**库卫生**——JSDoc、examples、fluid.ts 封闭语义拆原语（文档债就是代码债）；LLM 自跑路径由会话观察/审批兜底，人工按钮保留守卫运行器
- 明细与工作分解：docs/archive/M4-PREP.md §9

### v2.5（2026-09-26）可视化回放交付（M4R 支柱 B）

- **轨迹数据**：physics.ts 在循环内均匀采样（~160 帧）记录 `trajectory`（times / parts[].frames=[x,y,z,qx,qy,qz,qw] / events）；motion.ts 从既有 samplePoses 组装并补 t=0 装配位姿。**顺带修复 keyframe 终态 bug**——原实现循环结束后才采样位姿，所有关键帧都是终态同一帧；冒烟实证 box 首帧 z=30 / 末帧 z=9.9
- **流体帧落盘**：runFluidJob 写 `frames.json`（bounds/vmax/帧表）+ 每快照一个 `.bin`（Float32 pos[3N]++speed[N]，16B/粒子）+ `wall.stl`；快照数 4→8
- **新路由**：`/api/cad/{motion,physics}/trajectory`、`/api/cad/{motion,physics}/stl?part=`（部件名白名单防遍历）、`/api/cad/fluid/manifest`、`/api/cad/fluid/frame?i=`、`/api/cad/fluid/wall`
- **面板**：视口三 Tab（🧊 模型 / 🎬 动作回放 / 💧 流体回放）；`playback.ts` 两个视图——MotionPlaybackView（部件 STL 逐帧位姿动画 + 干涉/接触事件刻度 + 变速 + 📸截图进 tray；motion 缺数据自动回退 physics）、FluidPlaybackView（three.js Points 按速度蓝→红着色 + 透明管壁 + 帧缓存/预取 + 时间轴 scrub）
- **同一份产物两个消费者**：面板回放与 LLM 读的是同一批 trajectory.json / frames.json / .bin（场地原则的第一次落地）
- **验证**：tsc + esbuild 通过；`scripts/smoke-playback.mjs` 7/7；`scripts/regen-playback-data.mjs` 产出真实数据（physics 121 帧 / fluid 8 帧 × 17.9k 粒）；accept-m3 / m36 / m4 回归全部通过。面板 DOM 级人工复核待下一次真实使用

### v2.6（2026-09-27）定位升级：开放的 CAD harness（HARNESS.md 立库）

- **定位变更**：玩具 → 不成熟生产力工具 → **开放的 CAD harness**（不再限于内部工具，开放给更多人用）。定位与哲学全部落盘至 **HARNESS.md**（边界文档：是什么/不是什么/缺口/边界/竞争参照/下一步排序），本文档继续作为实现决策档案
- **核心命题**：CAD harness = 让 LLM 生成的几何**可验证、可迭代、可交付**的基础设施；产品是生成与真值之间的闭环，不是几何生成器；真正的资产是协议（v2.3 原则 1 的推广：内核无关的真值接口），不是插件。护城河 = 闭环，野心若以堆功能实现则沦为第 12006 个 CAD 插件
- **设计者三分**：LLM 可替代操作员（M1 本质）/ 可增强检验员（M2-M4 本质，验证时机从事后移到全程）/ 不可替代设计者（意图、裁决、品味、责任）；验收三层分工（脚本硬指标/模型判读/人复核）与该分类同构
- **能力开放三层原则（防矫枉过正）**：场地思路反对"收窄能力"（包工头），不反对"标注能力"（导览）——**库给能力，runtime 给执行，skill 给地图**；试金石：删掉 skill 后 LLM 读源码仍达同等效果 = 合格导览，删掉即失能力 = 伪 API
- **STEP 实测结论**：未实现且当前内核不可实现（EXPORT_FORMATS 仅 stl/3mf/obj/off/wrl；snapshot `--help` 输出类型无 step、无 import_step）——网格 vs B-rep 的内核类别缺口，归期 = 内核可插拔（中期，首选 Replicad TS/WASM 路线）；过渡期 3MF 够用。顺带发现 snapshot 实验特性含 `python-engine`，**已试探确认可用（2026-09-28，DECISION-LOG 2026-09-28（补记）：子对象在前 API、真 Python traceback 错误反馈、datum 经 stderr print 零成本移植、36ms 法兰盘 Genus=7 精确；风险：内省可致 segfault，需稳定性冒烟；集成 ~半天 compile.ts 分支）**
- **装配表示立场修订**：放弃"先定规模再定表示"（5/20/50 门控），采纳**代码库类比**——大型代码库 harness 能编辑，装配同理，关键在表达；判断标准改为"新会话能否只靠局部视图+查询正确修改 50 件装配中的一个零件"；A0' 装配导航实验取代原规模探针（HARNESS.md §8）
- **内核可插拔候选**（中期）：Replicad（TS+WASM+OCCT，Node 栈内）/ Build123d / FreeCAD headless（STEP 桥）；Blender bpy（玩具艺术面按需）；Zoo KCL 为竞品参照非依赖

### v2.7（2026-09-28）装配清单 v1 交付（BOM + 可执行 ICD，docs/archive/ASSEMBLY-SCHEMA-PROPOSAL.md）

- **datum 三类扩展**（compile.ts）：`datum_axis/datum_plane/datum_cyl` 模块 + `parseDatumFeatures` → `DatumSet{points,axes,planes,cylinders}`；datums.json 新格式（向后兼容旧点数组，`readVersionDatums` 双读）；generate_part 全量入库
- **manifest.ts**：assembly.json schema v0.1 读写/结构校验/遍历——节点同构可递归（part/assembly 同 schema）、接口挂装配节点（描述其直接子件间关系）、端点用 `<childId>.<datumName>` 地址引用；真相文件语言无关（JSON，裁决见提案 §9）
- **assembly-check.ts**：L0 算子 `distance`（点对点）+ `diameter-match`（datum_cyl 孔-轴直径间隙，负间隙自动升级 hard）；违反双通道（hard=报错 fail / intent=标记 check）；**邻接发现**（干涉或 <0.75mm 的未声明零件对 → undeclared 警告）；报告落 `data/runs/rNNN/report.json`（v2.13 起；旧 `GET /api/cad/assembly` 保留为「最近一次装配运行」别名）
- **接线**：`check_assembly` 工具（LLM 发起）+ GET `/api/cad/assembly/manifest` + POST `/api/cad/assembly/run`（人工发起②，同一 runAssemblyCheckJob）
- **验收 accept-assembly.mjs 14/14**（豚鼠=显微镜第一级：镜架/滑座/轴/垫圈）：正样本 3 接口全过（0.2/Ø0.4/2.0 精确命中）；负样本轴 r4.6 → 硬违反 Ø-0.8、status=fail；邻接发现 shaft↔washer（0.1mm 未声明）；node transform 旋转+平移下 datum 世界解析正确
- **回归**：accept-measure 18/18、accept-m3 ✓、accept-m36 17/17、accept-m4 ✓ 全过；tsc 干净

### v2.8（2026-09-28）隔离运行环境（虚拟 DSH）迁入 examples + 新 bundle 实测

- **DSH_HOME 迁移**：`~/.local/bin/dsh` wrapper 的 `FORCED_DSH_HOME` 由 `$HOME/.dsh-sandbox` 改为 **`$HOME/Project/ToyMarker/examples/dsh-home`**（沙箱 home 随项目走、随项目弃）。wrapper 仍对 `--profile cad-sandbox` 强制该 home——防多会话共享 home 导致的 flock 抢占（历史问题），此机制不变
- **迁移坑**：`cp -a` 后 profile 里 `node_modules/dsh-cad-harness` 是**相对**链接（`../../../../Project/...`），home 一移动即解析错位 → 改绝对路径 `ln -sfn /home/songsenand/Project/ToyMarker/dsh-cad-harness`
- **启动**：`dsh --profile cad-sandbox --port <port> --no-open`；profile 由 `dsh plugin --profile cad-sandbox add -w <plugin>` 挂工作区插件，`patchReload: live`（仅对 cordis 配置层生效，**宿主 bundle 改动仍需重启进程**）
- **新 bundle 实测（4296 实例）**：`GET /api/cad/assembly/manifest` 返回 v1 新增文案 "no assembly manifest yet"（旧 bundle 无此路由）；`POST /api/cad/assembly/run` 200，报告与 `accept-assembly.mjs` 一致（3 pass / 0 hard / 1 undeclared shaft↔washer）——**证明 check_assembly 与 run 路由同源的 job 路径在真实 dsh 进程内可用**（工具与路由同函数无条件注册，路由通即模块完整加载）
- **注意**：4196 上仍是 2026-09-27 启动的旧 bundle 实例（宿主代码不热重载）；**每次 bash 调用是独立沙箱**，`/tmp` 不共享（cookie jar 须落工作区）

### v2.9（2026-09-28）文档回填：关键帧策略与 Host/Client 分工（实现早已如此，文档停留在 M1 期规划）

- **触发**：复查 §6.5「抽帧：每 10 步渲染一次」是否为实现缺失。结论：**是实现早已改、文档未更新**（§13.4 已记录事件驱动关键帧）
- **§6.5 更正**：标题改 Host；「每 10 步渲染一次」替换为实作口径——**事件驱动关键帧（碰撞开始 / 倾倒转折 / 最大穿透 / final 不可裁）+ 预算内均匀补位**（`keyframeCount` 默认 6，`minGap` 去重，位姿取邻近轨迹帧）；并补记与关键帧**分离**的 ~160 帧均匀轨迹时间线（`trajEvery`，v2.5 回放数据源）；补 CCD / Manifold 凸性检测 / 穿透瞬态与稳态双指标
- **§4.2 更正**：分工表按实作回填——多视角渲染+拼图、刚体、机构、MPM 均在 **Host headless**；MPM 后处理统计按 v2.4 取消；Client 侧为面板预览与产物浏览器（v2.13）
- **证据（代码）**：`physics.ts` 事件 `noteStep` + `keyframeEvery` 补位（L237-338）、`trajEvery` 轨迹；`motion.ts` 里程碑帧（90°/180°/270°）+ 首个干涉帧 + final；全仓无「每 10 步」逻辑

### v2.10（2026-09-28）§6 模块设计全章回填（对照代码逐节核对）

> 承接 v2.9：§6 各节普遍停留在 M1 期规划，而实现已按 §13 各实施实录推进。本轮以代码为准逐节回填，每节加「v2.10 回填」注记说明原文何处失效。

| 节 | 原文（M1 规划） | 实作（回填后记载） |
|---|---|---|
| 6.1 几何编译 | `CompileRequest/Response` 抽象接口、固定 `/tmp` 路径 | 具体函数族（`compileAndRender`/`compileStlOnly`/`renderScadPng`/`exportScad`/`parseParams`/`parseDatum*`）、二进制解析链 + `--backend=Manifold`、共享 Xvfb、BOSL2、datum 前置区 |
| 6.2 多视角渲染 | Client 侧 Three.js 拼 2×2 图 | **Host 侧 OpenSCAD CLI 出 4 张独立 PNG（无拼图）**；Client three.js 只做交互预览与回放；补 `render_part` 参数化渲染 |
| 6.3 视觉评审循环 | 独立评审 LLM + ReviewRequest/Response + 固定 5 轮 + prompt 模板 | **dsh 原生化**：`generate_part` 返回渲染图、会话模型自审；无独立调用、无固定轮数；补人审通道与图片修剪代价 |
| 6.4 装配间隙验证 | 临时 SCAD `intersection()` 编译求体积、边数水密公式 | **manifold-3d WASM 精确布尔 + MeshBVH 顶点采样**、有向边水密 + `status()`、变换后网格统一坐标系；新增 **6.4.1 装配清单检查（v1）** |
| 6.5 刚体物理 | Client + 每 10 步抽帧 | v2.9 已回填（Host headless + 事件驱动关键帧） |
| 6.6 MPM 流体 | Client/WebGPU、实时 30FPS、每 50 步快照 | **Host CPU MLS-MPM** + SDF 边界 + 零依赖点云 PNG + 帧 `.bin` + 回放面板；dt 固定 4ms；粒子 4-8/格；M4R 场地化；诚实边界（无流固耦合/非精确 CFD） |
| 6.7 MPM 后处理 | 规则引擎 + 固定统计 | v2.4 已标注取消，保留备查（本轮核对无误） |
| 6.8 版本管理 | 含 composite/review/validation/physics/mpm 等**实作中不存在**的文件；"可回滚"验收 | 实作目录（scad/stl/4 渲染图/datums.json + 全局域目录）；**明确标注未实现项：回滚、审批流转（status 恒 draft）** |

- **顺带修复真 bug（本轮回填发现）**：v1 的 `check_assembly` 报告原与 `validate_assembly` **共用 `assembly-report.json`**，而两者 schema 不同且面板按后者解析 `pairs[].intersectionVolume` → 跑过 check 后面板会崩。已改为独立文件 `assembly-check-report.json` + 新增 `GET /api/cad/assembly/check`；`accept-assembly.mjs` 复跑 14/14，tsc 干净，bundle 已重建
- **仍待回填（本节之外）**：§5.1 目录结构（仍列 `src/host/llm.ts`、`mpm-postprocess.ts`、`src/client/{viewer,render,physics,mpm}.ts`、`panels/*` 等实作不存在的路径——实为 `src/host/*` 17 个模块 + `src/client/{index,panel,playback}.ts`）、§7/§10 的个别约定

### v2.11（2026-09-28）§5/§7/§10 回填（承接 v2.10，扫完文档主体章节）

- **§5 插件结构回填**：目录树按真实代码重写（19 个源文件：`src/host/` 17 + `src/client/{index,panel,playback}` 3 + `shared/types.ts`）；package.json 按实作更正三处——`dsh.client` **无 `entry` 字段**、`external` 是 `@deepseek-ai/dsh-api-session-controller/client`（非 react/cordis）、`dsh.bundle.patch → cordis.patch.yml`；接线章节改为实作口径：10 个工具、`connection.fetch.register` 精确路由、`ctx.reflect.get('connection')` 轮询（headless 跳过）、Client 注册到**右栏 Tab**（非 layout main）、RPC 只剩 M0 遗留 `cad/echo`
- **§7 重写为「安装与共享」**：删去私有 git/registry 三阶段计划（实作只有本地 `-w` 链接安装）；标注开放定位已定但公开分发方式未定、`private: true` 暂留；**§7.3 原「可调参数通过 dsh Config schema 暴露」为不实——无 `config.ts`、无 Config schema**，改为参数表（实为工具入参，含默认值）；新增 7.4 运行时数据位置（`<plugin>/data/` 与沙箱 `DSH_HOME=examples/dsh-home` 互不重叠）
- **§10 逐条更正**：优先级（M0-M4R 已交付、当前主线 A0'）、日志（**无统一 logger/`./logs/`**，实为少量 console + 结构化报告落盘）、配置（无 config.ts）、分发（private 暂留）、新增第 11 条**文档纪律**（改实现同轮回填设计章节，或以 §13 记差异）——本轮暴露的两类债都由缺此纪律产生
- **顺带修正 `package.json` description**：原为「M0 probe: minimal static client plugin…」，与现状严重不符，改为 CAD harness 定位描述
- **本轮核对无问题**：§2.1 做/不做表、§6.7（已标注历史态）、§8 里程碑（含 M3.6/M4R 增补）、§9 风险表、§12 TODO 列表
- **仍可再扫**：§4.3 关键决策（部分条目已由 v2.10 §4.2 注记覆盖）、§12 中「待办」项的时效性核查

### v2.12（2026-09-28）§4.3 与 §12 回填（文档主体章节扫完）

- **§4.3 关键决策重写**：8 条中 4 条已被里程碑推翻，逐条标注 ⚠️ 并保留原决策理由以备追溯——① 渲染/物理位置（原文 Client → 实为 **Host headless 全量**，仅预览与回放留 Client）；② LLM 调用（原文「Host 侧评审模型 DeepSeek v4.1 flash」→ 实为**无插件侧 LLM 调用**，评审已原生化，插件对模型无绑定）；③ Host↔Client 通信（原文 Remote RPC → 实为**精确 fetch 路由**，RPC 只剩 M0 探针）；④ 面板挂载（原文 layout `main` slot → 实为**右栏 Tab**）。另更正两条细节：几何编译是 **CLI + manifold-3d WASM 两轨**；`dsh.client` 无 `entry` 字段、external 为 session-controller/client
- **§12 TODO 重排为四组**：12.1 已完成（6 项，含本轮新增的装配清单 v1）；12.2 当前主线 A0'（6 项：层级+端口、L1 运动接口、介入分级、装配级版本图、邻接查询面、装配视觉表达）；12.3 待办（M4R 支柱 A 库化、人审 A 路径、图片修剪、**版本审批与回滚**（§6.8 未实现项正式入列）、权威编辑、skill 化、python-engine 集成后置）；12.4 长期/中期储备（list_features、pixel-unproject、弹性本构、内核可插拔/STEP 明确标注**优先级低于装配与视觉表达**）
- **接线一致性**：M4R 原为单一「待办」大项，现按支柱拆开（B 已交付 ✅ / A 仍待办），避免「已做一半」的项在清单里显示为未动
- **文档主体章节状态**：§1-§7、§10、§12 已回填；§8 里程碑（含 M3.6/M4R 增补）与 §9 风险表本轮核对无需改；§13 实施实录为增量档案，随里程碑追加

### v2.13（2026-09-28）运行时分工裁决：TS 接线层 + Python 领域运行时

- **一句话原则（创始人原话）**：**TS 收缩为"平台接线层"，Python 扩张为"领域运行时"——不是"减少 TS"，是"让 TS 只干接线"**。完整规范见 DESIGN.md §31.3
- **架构 A 裁决**：模型来源仍是 SCAD（LLM 写），Python 只做分析/仿真/装配检查，**不做几何生成**；**不使用 OpenSCAD 内嵌 python-engine**——实测 `ldd openscad` 链接 `libpython3.10.so.1.0`（ABI 绑死 3.10，换版本需自建 OpenSCAD），且内嵌解释器无 pip 环境、装不了目标生态。→ v2.7 试探结论转为存档备查，**python-engine 集成项取消**
- **Worker 规范**：Python **3.13**（`cadquery-ocp` 有 cp311-314 wheel）；常驻进程 + JSON-lines 协议（带 `protocolVersion`）+ 大载荷走文件路径 + venv 锁定/health check/自动重启；宿主侧唯一接线点 `src/host/python-worker.ts`（延续"引擎只在少数几处导入"的纪律）；错误返回完整 traceback
- **引擎默认策略（无脑选择）**：**能用 rapier 的都用 rapier**；只有用户明确强调或 LLM 明确要求时才走自实现 MPM 脚本。配套两条纪律：① 判据仍是 L0/L1/L2 主语物态（连续介质 → MPM），默认偏置不取消分层；② **防越界条款**——连续介质问题的答案必须来自 MPM，不允许 rapier 输出充当
- **软体归 rapier（新发现的二选一已裁决）**：rapier **Python 绑定**实有 `add_soft_body`/`add_soft_body_cluster`/`cut_soft_body`（**JS 绑定没有**）→ 软体默认走 rapier；MPM 弹性本构降级为"显式要求才做"。同时确立 **canonical 绑定纪律**：物理 canonical = TS 侧 `rapier3d-compat` 0.20（已验收），Python 绑定 0.36 只作 exploratory，同一问题域仅一个 canonical
- **B-rep/STEP 继续后置**：创始人实测 **`pythonocc-core` 效果不佳**（非 OCP；后者是 pybind11 + pip wheel，未被否定也未验证）。将来 STEP 评估顺序：FreeCAD headless → cadquery-ocp → Replicad。主循环不需要 OCCT（网格几何走 manifold3d/trimesh/numpy，OCCT 可 lazy/独立 worker）
- **pip 生态实测**：manifold3d / trimesh / numpy / scipy / mujoco / pybullet / cadquery-ocp / build123d / **rapier3d 0.36.0** 全部有 wheel；conda-only 仅 `pythonocc-core` 与 `PyChrono`（注：PyPI 的 `pychrono` 是抢名无关包）
- **已接受的代价**：两套依赖世界（venv 锁定 + wheel 平台矩阵，放弃"单产物零依赖"）；地图复杂度上升（→ 转化为 skill 义务）；验收搬家为一次性成本（契约不变、形态变）

### v2.14（2026-09-28）实机首用反馈：面板不再"加载即弹"

- **反馈**：插件装入主力 web profile 后，界面一出现就自动弹出模型预览 Tab——"如果我们是个代码仓库，每次都弹出这个比较尴尬"
- **根因**：`src/client/index.ts` 第二个 effect 是"启动 1.5s 后自动 openTab + 会话切换时重开"（M0 探针期的调试便利，一直没收回）
- **修改**：**删除启动自动打开与会话切换重开**，改为
  1. Tab 类型仍声明 → 用户可在右栏单击激活（即"给个按钮"）
  2. **CAD 活动触发**：轮询 `/api/cad/manifest`，新版本时间戳出现时 openTab（即"由 LLM 主动唤起"）；**首次轮询只记基线，故加载绝不弹出**
- **原则入档**：DESIGN.md §30 新增「**界面打扰原则**」——区分"加载即弹"（禁）与"相关事件即弹"（可），适用于所有面板
- **部署**：纯 client 侧改动，`esbuild` 重建 `lib/client.js` 即可，**无需重启宿主**（本次未改 host 代码），浏览器刷新生效
- **补充（同日实机确认）**：**只声明 tab 类型不会在右栏出现入口**（实测无按钮）——类型只在右栏 guide 选择器里列出。故增加**显式入口**：会话头部工具区 `conversation.session.header.utilities`（list 槽）注册一个「CAD」按钮 → `sidebarRight.openTab`。**注意不能用 `conversation.session.header.corner`**：该槽是 `single` 且已被官方 sidebar-right 展开按钮占用（注册会遮蔽官方 UI）。注册失败会打 `console.warn`，成功打 `console.info` 便于诊断

### v2.15（2026-10-01）外部几何导入：STL 成为一等版本（`import_part`）

- **需求来源**：创始人指出"从外部导入一个 STEP 或 STL 文件、当作零件用在项目里"这个能力不存在，**意味着靠多人协作 + 装配拼接的完整能力现在是断的**
- **归因修正**：原文档把「STEP 导入导出」与「导入既有 CAD」并成一行判为"内核类别缺口（网格 vs B-rep）"——对 STEP 成立，**对 STL 不成立**（STL 就是网格，真值引擎全部是网格的）。真正的缺口是**几何不是可以独立存在的对象**：`generate_part` 是进版本库的唯一入口，且只收 SCAD 源码。详见 DECISION-LOG 2026-10-01（补记）
- **交付**：新工具 `import_part`（第 12 个 CAD 工具）+ `src/host/import.ts` + `src/host/solidify.ts`；`mesh.ts` 增 ASCII 解析、格式探测、二进制写回、壳数统计；`version.ts` 的 `scadCode` 变可选并新增 `source` 来源字段 + `import.json`；`products.ts`/`types.ts`/`panel.ts` 显示来源
- **三条设计原则**：① **导入 = 验收不是搬运**（非实体默认拒收，`allowNonSolid` 才存且打标记）；② **导入 = 一个版本不是第二条通道**（11 个工具零改动生效）；③ **外部件必须能进契约**（`datums` 参数写进既有 `datums.json`）
- **验收**：`scripts/accept-import.mjs` **35/35**（含 ASCII/二进制同网格、非实体拒收与打标、导入件+生成件的干涉体积 326.2mm³ 与间隙 1.998mm、导入件作 `diameter-match` 端点通过/失败两侧、英寸 = 25.4³、重导入成修订、面板来源标签、STEP 边界话术）；回归 `accept-assembly` / `accept-m2` / `accept-m3` / `accept-m36` / `accept-m4` / `accept-measure` / `accept-inspect` / `accept-tool-scope` / `accept-project-scope` 全绿
- **STEP 未做**：按"先只做 STL"的裁决给出可行动的边界说明；已核实 `replicad` + `replicad-opencascadejs` 1.1.0 是最短路线（`importSTEP`/`exportSTEP`/`setOC`，~55MB wasm，无传递依赖），是否引入属内核可插拔线的决定
- **未做（明确的下一步）**：按版本号把已有件布尔合成新件（真正的"拼接"）——需要版本图记住来源版本（§12.2「装配级版本图」）

## 12. TODO 清单（v2.12 重排：已完成 / 当前主线 / 待办 / 长期）

### 12.1 已完成（保留脉络，不再排优先级）

| 项 | 结果 |
|---|---|
| measure_distance 两点测量 | ✅ 2026-09-25（datum 锚点免吸附 / 表面吸附 / 跨零件；accept-measure） |
| measure_closest 最近点对求解器 | ✅ 2026-09-25（零坐标；球探针解析分支 + 标注渲染） |
| M3.6 机构运动仿真 | ✅ 2026-09-25（纯约束 + Manifold 干涉时间线；四冲程 17/17） |
| M4 MPM 流体 | ✅ 2026-09-25（SDF/粒子/守恒/点云渲染；accept-m4 24/24） |
| M4R 支柱 B 可视化一等公民 | ✅ 2026-09-26（帧 `.bin` + 6 条路由 + 面板三 Tab 回放，v2.5） |
| 装配清单 v1（BOM + 可执行 ICD） | ✅ 2026-09-28（datum 四类 / assembly.json / L0 算子 / 邻接发现；accept-assembly 14/14，v2.7） |
| 外部几何导入（`import_part`） | ✅ 2026-10-01（STL 二进制/ASCII → 一等版本；非实体默认拒收；导入件可作接口端点；accept-import 35/35，v2.15） |

### 12.2 当前主线（A0' 装配表示 + 装配视觉表达，DESIGN.md §31.2）

| 项 | 说明 | 状态 |
|---|---|---|
| 装配清单 v2：层级递归 + 端口语义 | 节点同构已在 schema 预留（`children`），需补：跨层变换合成、端口条目在父级解析、按「整体装拆」判据分层 | 待办 |
| 装配清单 v2：L1 运动接口 | `转动副/滑动副` 走 `simulate_motion` 干涉时间线 + 行程核对；`spring` 类型参数（freeLength/stiffness/damping）→ **rapier 0.20 有原生 `JointData.spring(restLength, stiffness, damping, anchorA, anchorB)`**（v2.13 更正：早前"需自研每步施加 F=kΔx+cv 力模型"的说法有误），直接用原生关节 + 行为验收 | 待办 |
| 装配清单 v2：介入分级 | `review: auto\|human` 字段（零件内变更自动、接口/端口变更必审），接版本 manifest status | 待办 |
| 装配级版本图 | 装配 = 零件版本引用图（A@v3 + B@v7 → 装配 v12）；当前版本库仍是零件级。**拼接（按版本号布尔合成新件）依赖它** | 待办 |
| 邻接/空间查询面 | 「谁碰到这个面」类查询 + 未声明接口发现已有雏形（`validate_assembly` 对账），需可查询化 | 部分 |
| 装配视觉表达 | 部件显隐/高亮、剖切、爆炸视图、接口（datum）可视化标记；渲染图在复杂装配下判读退化，这是 LLM 与人共同的眼睛 | 待办 |

### 12.3 待办（非主线）

| 项 | 说明 | 状态 |
|---|---|---|
| M4R 支柱 A：库化拆分 + `examples/` | `fluid.ts` 场景语义拆库级原语（种子/驱动/度量分离）+ `examples/` 场景脚本（`simulate_fluid` 等价回归基准）；支柱 B 已交付 | 待办 |
| 人审反馈 A 路径（composer 草稿 chip） | 修复草稿 chip 不渲染（服务层已通）；修好后 tray「图+文」两步合并为「一键发送」。**当前替代**：剪贴板粘贴 + 标注链路可用 | 待办 |
| 图片修剪扩展 | 多轮历史图片累积；**已实现（v2.13p，§13.10）**：DeepSeek 走 `maxImagesPerRequest=24`+`imageOffloadCountQuantum=8`（cordis.patch.yml），pi-ai 走 `maxRequestImages=24` + `maxRequestImageBytes=2.5MiB`（v2.16 补计数预算，§14；image-budget.ts 启动时写入 settings）。旧轮图片由适配器换成带路径的文本占位，`read_image` 可随时取回；实测语料 88 图峰值 → 24，图片 token 36.0M → 18.6M | ✅ 完成 |
| 版本审批与回滚 | §6.8 标注的未实现项：`approved/rejected` 仅存在于类型定义，无路由无 UI；回滚无一键操作 | 待办 |
| 权威编辑通道 | 约束保持的精确编辑 + 可追溯（DESIGN.md §30 生产力缺口；Customizer 只改顶层标量） | 待办 |
| skill 化 | 三层判据选型、参数甜点、陷阱清单写成 skill（HARNESS.md §6；判据：删掉 skill 读源码仍可达成 = 合格导览） | 待办 |
| python-engine 集成 | ~~试探已完成并确认可用~~ **已取消（v2.13）**：架构 A 不用 OpenSCAD 内嵌 Python（ABI 绑死 3.10 + 无 pip 生态）；试探结论存档 DECISION-LOG 2026-09-28（补记） | ❌ 取消 |
| **Python 领域运行时落地** | **供给 v1 已交付（v2.30，2026-10-08，§26）**：插件自带独立 CPython（python-build-standalone，pin 3.13.16）+ 锁定 venv + `run_python` / `python_runtime`；时机是运行期（首次调用/`eager` 预热），不是 postinstall（pnpm 11 拦脚本）。**待做**：§12.3 的常驻 worker + JSON-lines 协议，第一步接 M4R 支柱 A 的 `examples/` 场景脚本。规范见 DESIGN.md §31.3 | 🚧 v1 完成 / worker 待办 |
| 草稿 chip 渲染调查 | 与 A 路径同源 | 与 A 合并 |

### 12.4 长期与中期储备

| 项 | 说明 | 状态 |
|---|---|---|
| 特征识别 list_features | 网格面分割（平面/圆柱/孔）→ 特征级测量，模型零坐标引用 | 长期 |
| 视觉指向 pixel-unproject | 渲染图像素 → 反投影射线 → 网格求交 → 3D 点；依赖渲染管线暴露相机参数 | 长期 |
| 弹性本构扩展 | mpm.ts 加变形梯度 F + fixed-corotated/neo-Hookean（`material: 'fluid'\|'elastic'`），回答单体**定性**应力/变形；趋势非 FEA；**已降级（v2.13）**：软体默认归 rapier（Python 绑定有 `add_soft_body`），MPM 弹性仅"显式要求才做" | 长期（降级） |
| 内核可插拔 / STEP | Replicad（TS+WASM+OCCT，留在 Node 栈）/ Build123d / FreeCAD headless；**STEP 导入已建（v2.32，2026-10-15）**：cascadio（OpenCASCADE→GLB）+ ezdxf 进锁、worker `import_mesh` 内嵌转换（DECISION-LOG 2026-10-01（补记））；本行**剩余范围** = STEP 导出与 B-rep 级精确 datum，评估顺序仍是 FreeCAD headless → cadquery-ocp → Replicad（v2.13：`pythonocc-core` 实测不佳） | 中期（范围收窄） |
| 文档回填纪律 | v2.11 §10.11：改实现同轮回填设计章节或以 §13 记差异 | 已立规矩 |

## 13. 实施实录（决策档案）

> 本节记录实际执行中的关键决策、决策原因、遇到的问题与修复方式，供后续里程碑参考。

### 13.1 M0 插件地基探针

**关键决策**

| 决策 | 原因 |
|---|---|
| Client 半走静态客户端插件，弃用动态 Cordis 包 | 动态包浏览器半是纯 JS 沙箱（无 import），Three.js/rapier 体量塞不进去 |
| 渲染管线共享一个 Xvfb 进程 | （实测后追加，见 M1）`xvfb-run` 每调用 ~3s 启动税 |
| 沙箱隔离：独立 `cad-sandbox` profile | 主 web profile 保持原状，实验不污染用户环境 |
| 无头验收体系：puppeteer 截图 + 模型判读 + 人复核 | 手动验收不可持续；截图直接喂多模态模型做第一道判读 |

**问题与修复**
- `assertFetchRoute` 要求路径带 `/api` 前缀（`/cad/test.stl` 被拒）→ `/api/cad/test.stl`
- cordis 禁止未声明的 ctx 属性访问 → 可选服务用 `ctx.reflect.get(name)`（官方提供的无 inject 读取口）+ 就绪轮询
- 客户端 bundle 必须是 `window.__ModuleLoader__.load({id, factory})` 形式 → esbuild banner/footer 生成，与第一方 bundle 逐字对齐
- `sessions` 服务读取当前会话：`selection.getSnapshot().current`（新会话未发消息时为 undefined，符合预期）

### 13.2 M1 视觉循环

**关键决策**

| 决策 | 原因 |
|---|---|
| 视觉循环 dsh 原生化：`generate_part` 工具返回渲染图，会话 Agent 自审 | 弃用文档原设计的「独立评审 LLM 调用」——会话模型本身多模态（glm-5.3-flash），独立评审是冗余的；dsh 工具结果原生支持 image block（经 `ctx.attachments.saveImages` → 适配器转 user 消息） |
| 四视角渲染在 Host 侧（OpenSCAD CLI PNG） | 避免浏览器渲染往返；headless profile 也能跑完整循环 |
| 版本不可变 + manifest 索引 | 版本目录 `vNNN/` 存 scad/stl/4 渲染图，manifest 记录意图/父版本/状态 |

**问题与修复**
- OpenSCAD 2021.01 PNG 导出需要 X server → `xvfb-run` 包裹；后续升级 snapshot 后保留共享 Xvfb
- `res.text()` 读二进制 STL 会损坏 → `arrayBuffer()`
- **STL 面绕序 bug**：手写立方体 3 个面顶点顺序反了，法线与绕序不一致导致背面剔除后实心体渲染成开口壳——无头截图验收抓到（手写冒烟测试只验二进制结构，验不出视觉正确性）。修复后重验通过
- 渲染结果 `$fn` 解析：CLI `-D '$fn=64'` 传参

**验收**：法兰盘需求**一轮通过**（标准 3 轮），Agent 对渲染图做了像素级比例分析（孔径比 70/350≈12/60 等）后判定 OK。

### 13.3 M2 Manifold + 装配验证

**关键决策**

| 决策 | 原因 |
|---|---|
| Manifold 内核走 `manifold-3d` npm（WASM 进程内），不走 nightly CLI | 无子进程开销、无 X 依赖、官方 npm 维护；几何布尔/体积/水密全够用（且实测比 CGAL 快 1-18×，复杂度越高差距越大） |
| 水密性检查：有向边计数（每条有向边恰出现一次且反向存在） | STL 是三角面片汤，顶点需按坐标量化去重后才能判定 |
| 干涉体积：Manifold `intersect().volume()`（精确布尔） | 比采样/体素化精确 |
| 最小间隙：A 顶点采样（≤1200）+ B 网格 BVH 最近三角形查询，双向取 min | manifold 无距离查询；BVH 对数复杂度 |
| **所有下游消费者统一使用变换后网格** | 修复坐标系错位 bug 时确立的原则：BVH、距离采样、bbox 必须同一坐标系 |

**问题与修复**
- **毫米尺度隧穿**：540mm/s 落地速度 × 1/60s = 每帧 9mm，大于 2mm 板厚 → 动态体全开 CCD
- **rapier CCD 对 trimesh 碰撞体不可靠**（实测穿透依旧）→ 固定件先经 Manifold 凸性检测（实体体积 vs 凸包体积差 <1%），凸体走凸包碰撞体，非凸才 trimesh
- **坐标系约定**：z-up（匹配 OpenSCAD 挤出方向），不是物理惯用的 y-up——「高塔」曾横躺
- 穿透指标拆分：**瞬态最大**（硬着陆冲击压缩，正常物理）与**稳态**（末 10% 步，验收用）分开
- 验收脚本自身 bug：`cube([200,200,2])` 默认 corner-origin，板材占 [0,200]²，掉落物从边缘滑落被误判为穿透——`center=true` 修正

**验收**：干涉体积 2258.3mm³（解析解 π·36·20≈2262，差 0.2% 为 $fn=64 多边形拟合）；1mm 间隙精确测得 1.000；阈值判定（0.75 ok / 1.5 too_tight）正确。
**E2E**：底座+轴装配，Agent 独立完成并解释最小间隙 2.0155mm = √(0.25²+2²)（径向配合间隙与垂直悬空的对角合成）。

### 13.4 M3 刚体物理

**关键决策**

| 决策 | 原因 |
|---|---|
| rapier3d-compat 在 Node 侧 headless 运行 | WASM 与浏览器无关；整个物理验证闭环 host 侧完成，headless profile 可验收 |
| **关键帧事件驱动**（碰撞开始/最大穿透/倾倒转折 + 均匀补位），每帧带原因标签 | 均匀采样大概率错过接触瞬间；事件帧是装配判断的核心证据；标签让模型可引用具体事件 |
| 毫米单位制贯穿（重力 -9810mm/s²） | 与模型几何单位一致，Agent 无需换算 |
| 穿透双指标（瞬态/稳态） | 见 13.3 |
| 关节先支持 revolute 一种 | 铰链门验收足够；prismatic/spherical 按需加 |

**问题与修复**
- `solverContactDistance` → 实际 API 名 `solverContactDist`
- 睡眠体接触流形消失 → 动态体 `setCanSleep(false)`
- 首帧 GL 渲染偶发失败（AMD GPU 初始化竞态）→ 渲染重试一次 + ensureDisplay 时 GL 预热
- Xvfb 孤儿占用显示号 → 改用 `-displayfd` 让 X 自选

**验收**：三场景全过（静止不穿透 0.073mm / 铰链门无违规漂移 0.56mm / 高重心塔倾倒）。
**E2E**：Agent 验证 8° 倾斜细柱时发现 12° 情况穿透异常，**自主分析原因**（尖棱线接触 + 薄板求解器退化）、调整初始间隙与角度后重试成功。

### 13.5 跨里程碑基础设施

| 设施 | 内容 |
|---|---|
| 共享 Xvfb | `-displayfd` 自选显示号 + GL 预热 + unref，渲染管线 15.7s → 1.0s（15.6×） |
| OpenSCAD 2026.09.23 | Manifold 后端（STL 1.2-18×，复杂度越高越大）；二进制解析链 env → snapshot → system |
| BOSL2 内置 | `lib/BOSL2` + OPENSCADPATH；generate_part 描述已声明 |
| 计量管线 | `llm/stream` 观察者 → `usage.jsonl`；实测 9 调用 60 图 ≈ 60k token，为图片修剪扩展提供触发线 |
| 无头验收 | `verify-m0/annotate/params.mjs`：DOM 状态 + 截图 + console 错误收集；截图由模型判读 + 人复核 |
| OpenSCAD 升级 | 2026.09.23 snapshot（Manifold 后端）——性能矩阵见版本记录 v2.1 |
| MPM 内核 + 基准 | mpm.ts：cell 单位 MLS-MPM，~0.34µs/粒子/步（8.8k→564k 实测线性）；`bench-mpm-scaling.mjs` 阶梯数据存档 |
| SDF 边界链路 | sdf.ts：STL→Manifold 水密→BVH 距离+三射线奇偶符号→solidMask/solidNormal/trilinear；6.9 万格 260ms |
| 测量家族 | measure.ts：表面吸附/datum 解析/最近点对求解/球探针解析分支；MeshBVH 复用（M2 依赖） |

### 13.6 M3.6 机构运动仿真（实施实录）

**关键决策**

| 决策 | 原因 |
|---|---|
| rapier 纯约束求解器（无碰撞体、无重力） | 机构验证 = 运动学 + 干涉，不是动力学；干涉由 Manifold 按采样位姿精确布尔给出（时间线），杜绝碰撞体把「卡死」顶开造成的假通过 |
| 驱动 = kinematicVelocityBased 曲轴 | ω 精确（-0.1%）、带载稳定；关节电机在 mm 单位制 factor 需 ~1e4 且带载饱和（ω 钳 3-4.6 与 factor 无关），留作力矩受限/堵转模式后置 |
| 动态体 setAdditionalMassProperties 补 AABB 估算惯量 | setAdditionalMass 只加平动质量，零转动惯量导致约束求解漂移 30mm（实测）；AABB 盒公式 I=m/12·边长² 修复后 0.0001mm |
| 干涉排除：revolute 相连对排除、prismatic 相连对保留 | 销孔轴承重叠合理应排除；活塞-缸壁/滑轨碰撞恰是 prismatic 对，是核心信号不能排 |
| 固定件网格按安放位姿烘焙进世界坐标 | 基座 body 在 (0,0,-30) 而网格在原点 → 假干涉 48 事件的根因 |

**验收（accept-m36.mjs，17/17）**：滑块-曲柄行程 39.97/40、周期 -2.7%、零干涉、漂移 0.0001mm；四冲程六件套零干涉、气门 ω/2 反相 Δt=0.624s（理论 0.628）、5 张里程碑关键帧渲染可辨机构（模型判读+人复核）；负样本（连杆 64）→ 活塞-缸体干涉 448mm³ 检出、status=check。

### 13.7 M4 流体仿真（实施实录）

**关键决策**

| 决策 | 原因 |
|---|---|
| 内核即基准内核 | mpm.ts（cell 单位、restDensity 自动标定、K/μ 按 ρ 缩放）在粒子数阶梯上验证过，直接复用 |
| 粒子-壁面 = SDF 投影回推（fluid.ts，近壁掩膜 O(1) 预筛） | 固体格零速只能减速不能挡位移；投影后「穿透」指标才语义正确（沉淀归零） |
| 自由滑移 = G2P 排除固体格 + 流体权重重归一化（阈值 0.5） | 否则贴壁粒子被固体格零速拖拽（等效壁面粘性），塞流推不动；阈值防深陷粒子噪声放大 |
| 出口 escape 移除 + 守恒审计 | 到达率 = escaped/count0 可断言；recycle（环绕续流）保留为另一模式 |
| 零依赖 PNG 点云渲染（iso+side、速度着色、壁面灰点） | 模型判读通道；不依赖 OpenSCAD/X；1 万粒子渲染 <100ms |
| 验收口径 = 零重力塞流 | 重力池化后入口推力对深池低效（物理正确但验收不聚焦）；重力保留为场景参数 |
| 工具/面板/路由共用 runFluidJob | 人工发起三路径产出天然一致（docs/archive/M4-PREP.md §4.6） |

**问题与修复**

- sdfAt 越界钳位双重减一 → 边界采样命中错误格（冒烟抓到）
- 驱动体建成 kinematicPositionBased → angvel 被忽略、曲轴不转（与 M3.6 同因，改 velocity-based）
- 无惯量动态体约束漂移 30mm → setAdditionalMassProperties 补 AABB 估算惯量（与 M3.6 同源）
- 流动停滞链：重力池化 + 固体格零速拖拽 → 自由滑移重归一化 + 验收改零重力塞流
- 「1.6 万穿透」= 池化底层沉淀（非漏流）→ 投影回推后归零
- 管件 SCAD 居中（x±100）与流场 0..200 布置错位 → 前峰卡在网格钳位 99mm；管件改 0..200
- Float64Array.map 返回值强转 number → 分段速度对象丢失（tsc 抓到）

**验收（accept-m4.mjs，24/24，五案例）**

| 案例 | 规模 | 结果 |
|---|---|---|
| c1 直管塞流 | 11.9k 粒子 2600 步 8.5s | 到达 0.72、穿透 0、守恒 0、20/20 分段有流量 |
| c2 渲染 | 4 帧 | 非空、流动可判读 |
| c1b 直管 5 万级 | 38.7k 粒子 1800 步 17s | 到达 0.845、穿透 0（对齐原设计 5 万口径） |
| c2b 静水沉降（封闭腔） | 2013 粒子 800 步 | 沉降稳定 meanV 6.1mm/s、穿透 0、pass |
| c3 90° 弯管 | 9.8k 粒子 2000 步 6.2s | 流过转角逃逸 63%、穿透 0、pass、渲染可见 L 形转向流动 |

注：到达率 ≠1.0 的残差为**无滑移壁面边界层爬行薄膜**（物理性，渐近收敛），断言定 0.7/0.75/0.5 并记档；弯管为 M5 死区检测备好输入（渲染中外侧/内侧速度差可见）。

**补记：C 仿射矩阵中毒反馈环（弯管案例抓到）**——拐角压缩尖峰 → 网格速度瞬时爆大 → B/C 巨大 → 下一轮 P2G 撒回 Inf−Inf → 全网格 NaN → 流动停滞。三重加固：格点速度预钳制（±vmax）、B 有限性守卫、NaN 时清零 C 并复位速度。修复后弯管到达 0.50→0.63 且无发散。

### 13.8 测量家族与人工标注（补缺补差实施实录）

> M2/M3 缺口：LLM 无法做「两点间距离」「壁厚」「孔间距」类局部测量，只能渲染目测。本轮补齐四件套 + 人工标注。

**关键决策**

| 决策 | 原因 |
|---|---|
| 表面吸附：粗略坐标 → MeshBVH 最近表面点 | LLM 不可能知道精确表面坐标；工具报告吸附距离（猜测质量）+ 内外标志（面法线符号），把猜测变成有反馈的测量 |
| datum 锚点约定：模型在 SCAD 写 `datum("hole1",[x,y,z])`，OpenSCAD echo 捕获存 datums.json | 模型声明意图、几何引擎解析真值（function-calling 同款哲学）；datum 解析点**免吸附**（是精确声明非猜测）；实测：echo 拿参数原值，调用处变换不生效 → v1 约定 = 顶层世界坐标 |
| measure_closest 最近点对求解器：零坐标，双向顶点全量采样 | 「奇怪形状 vs 球最近点」是几何求解问题，模型不可能预先声明坐标；球探针走解析分支（球心一次 BVH 投影 ± 半径，绝对精确） |
| **标注渲染**：解出的点对以红/蓝标记球+连线叠图返回 | 求解 → 返回坐标 → 渲染标注 → 模型视觉验证，闭环完整 |
| 面板人工标注：射线求交拾取 + 尺寸线烘焙进截图 + 备注自动携带精确数字 | 与 LLM 同一原则的人工入口：人指 WHAT、引擎算 WHERE、真值随截图流转；HTML 覆盖层不进 canvas → 截图时按当前相机重投影用 canvas 2D 烘焙 |

**问题与修复**

- 测试场景方向错误 ×2：管轴沿 x 时 (21,0,0) 在轴线上不在壁内；立方体中心六面等距吸附有歧义——工具行为正确，测试期望要先对着几何想清楚
- esbuild 把非 ASCII 转成大写 `\uXXXX` 转义存 bundle → grep 中文/小写转义都搜不到，误判「代码没进包」；验收检查用 node `includes` 或搜转义形式
- OpenSCAD 模块必须先定义后使用 → datum 模块前置（行号偏移 6 行，接受）
- 两探针点不镜像时「真距离 ≠ 面间隙」（10.198 vs 10）→ 工具如实报真距离，描述提示「间隙测量两点大致相对」

**验收（accept-measure.mjs，12/12）**：纯数学 5.000000；立方体面吸附 30mm；管壁厚 3.998mm（$fn=64 矢高内）；跨零件间隙 10.000mm；内外标志；datum 解析 + 锚点间距离 √2250 精确；球探针 vs 带膛管件最近点对 11mm（解析解命中，点定位 (30,24,0)/(30,35,0)）；mesh-vs-mesh 5.85mm。

### 13.8b 测量家族扩展：把「点打不准」变成不存在的问题（2026-10-12）

> 起因：用户反馈「测距真的非常难用，三维空间中的点完全打不准——能否在剖切的平面上选两点？」
> 与「夹角没有工具」。决策与取舍见 `docs/DECISION-LOG.md` 2026-10-12 条。

**根因（不是精度问题，是信息问题）**：`measure_distance` 要求调用方给出 3D 坐标，
而渲染图不带坐标（工具描述自陈）；**调用方对"自己没画的几何"（导入件、既有语料）没有任何
坐标来源**。bench 归因记录的直接后果是 01 的 `c-protrusion` / `c-measured-vs-datum` 因
**零 `measure_distance` 调用**而失败。

**四件新增，按"调用方要提供什么"分层**：

| 工具 | 调用方提供 | 容差 | 回答什么 |
|---|---|---|---|
| `list_features` | 版本号 | **零瞄准** | 平面面（法线/平面上一点/面积/质心）、**孔（心/直径/通孔或深度）**、圆柱（轴/直径/长度 + bore-vs-boss）。这是"非自己画的几何"的**坐标来源**，后续一切可按特征名书写 |
| `measure_thickness` | 一条线（起点 + 主轴/向量） | **= 特征自身宽度** | 该线上**所有**材料段落：每段厚度、两端坐标与法线、段间间隙（`same-part` 内腔 / `a→b` 跨件） |
| `measure_section` | 轴 + 位置 | **零瞄准** | 剖面**作为数据**：多边形（外环点集/段长/段角）、孔（心/直径/壁厚）、孔距；另给 `enclosingDiameterMm` |
| `measure_extent` | 版本号（+ 可选任意轴） | **零瞄准** | 沿任意轴的起止/中心/尺寸 + **两端极值顶点坐标** |

按特征取长度的能力**不重复提供**：`list_features` 已给圆柱 `lengthMm` 与孔 `depthMm`，
从特征本身取，避免两处数字打架。

**三条引擎约束（实测得出，必须记住）**：

1. **射线正好落在三角形接缝/顶点上会整个漏检**。`$fn=64` 圆管上，从 `[-20,0,0]` 沿 `+x`
   （正是圆柱的顶点线）实测**报 0 次穿越而实际有 4 次**——连外壁都没命中。处置：请求线
   + 两圈（1e-3 / 1e-2mm）各 12 个垂直偏移共 **25 探针**，取内外行走自洽者中得票最多者，
   并回报 `nudgedMm` / `probeAgreement`；贴切线一律**声明歧义**而不是给自信的数。
   反面对照：同距离聚类去重后，`net == 0` 的簇判为切点丢弃（`sdf.ts` 当年正是栽在重复计数）。
2. **多边形化需要精确共点**。同一表面点从共享一条边的两个三角形各算一次，末位有差，
   GEOS 于是看到"开口线"——圆管剖出 **256 条线段却得 0 个多边形**。处置：剖面 uv 吸附 1µm 网格。
   客户端（three.js）同理，`chainLoops` 用 1µm 量化键。
3. **闭环哪一侧是材料，必须问实体**；且**矩形四角共圆**，只靠圆拟合残差会把槽判成圆孔。
   处置：`representative_point`（**不是 centroid**——圆环的质心落在孔里）向实体提问；
   圆度用"拟合残差 **且** 环面积 ÷ 圆面积 ≥ 0.95"两条判据。

**GUI（剖切面）为什么必须改**：three.js 的裁剪面是**着色器效果，没有面**——剖口没有几何，
点进开口会穿到**深处内壁**，这正是"剖面里看着相邻的两点量出零件对角线"的成因。现在：
拾取点**约束到切面**、9px 内**吸附到最近顶点**（半径按像素给、用相机换算成毫米）、
画出**剖面轮廓**（橙色）与**封盖**（`capTriangles`：环链化 → 嵌套判定 → 三角化，
孔被减掉而不是填上）。几何部分放在纯模块 `src/client/section.ts`，
由 `accept-section-pick.mjs`（34 项）在 node 里验收——它们属于矩阵 §0 的 ① 类平台接线。

**工具表 20 → 24；worker op 28 个；依赖集 8 → 9（`shapely 2.2.0`）。**

### 13.8c 夹角（`measure_angle`）：一个夹角，三种命名，三个数一起给

夹角是最容易产生「你的数字和我的对不上」的测量：**30° 与 150° 描述的是同一对直线**，
两面夹角又是其法线夹角的补角。所以本工具的输出不选一个答案，而是把
`angleDeg`（按**输入给的方向**）、`acuteDeg`（0..90，通常所说的"两直线夹角"）、
`supplementDeg` 一起返回，并附 `convention` 文本随结果走。

一侧可以三种命名，对应调用方三种"知道"的方式：
① `aProbe [x,y,z]`——**点**，方向取该点最近的那个面的法线（容错形式，粗猜即可）；
② `aDatum "<名字>"`——轴/圆柱/平面 datum，**精确**解析；③ `aPoints` / `aDir`——两点连线或已知向量。

**数学只实现一次**：`_axis_line_metrics` 同时供给本工具与 `check_assembly` 的 `coaxial`
算子（后者目前在 TS，迁移时改为消费同一 op），TS 的 `axisLineDistance` 保留为 parity oracle。

两条必须记住的约定/陷阱：

1. **最近点对的符号约定**。解方程得到的 `s,t` 与真实最近点参数**反号**，因此最近点是
   `p1 − s·u1` / `p2 − t·u2`，分离向量是 `w + s·u1 − t·u2`。写反了会把**最远**的一对
   当成最近（实测 58.085mm vs 闭式 4.7245mm），而**轴对齐的对称用例恰好抵消这个错**——
   夹具必须含非对称斜交用例。
2. **`|u1 × u2| = sinθ` 这个因子不能忘**：闭式是 `|w·(u1×u2)| / |u1×u2|`。两条都水平的
   直线相距 7mm，答案就是 7，不是 7/√2。

只给方向不给点时，两条线都锚在原点，`coplanar` / `lineDistanceMm` 描述的是这个锚点而
不是零件——故输出带 `anchoredAtOrigin` 标志与相应警告，而不是给一个看着很确定的数。

### 13.8d 通道瓶颈（`passage_bottleneck`，2026-10-13）：一条**指名**通路的瓶颈

**回答什么**：一条通道（排粉/排液/刀具要走的那条路）最窄处有多宽。判据 = **横切截面的最大
内切圆，沿通路取最小**（不是取平均——平均会把最窄处抹掉）。

**为什么必须"指名"，三条依据（同一日三条决策，见 `docs/DECISION-LOG.md`）**：

1. **先拓扑**：壳的**亏格**就是独立隧道条数（`欧拉数 = 2 − 2g`，整数运算，无 pitch、无分辨率
   取舍）；壳数 = 有几个封闭内腔。**亏格 0 ⇒ 没有通路 ⇒ 不出数**；有封闭内腔转 S2-a 的
   负体积判据（通道尺寸 0）。
2. **必须锚定到一个开口**：同一张平面上可能有好几条通路，而一张平面只能给一个**可证**的数
   （取各分量的**最大**，否则"没有半径 r 的球能停在这张平面上"不成立），于是宽通路必然**盖住**
   窄的——实测 Ø6 与 Ø1 两条平行贯通孔，全零件盲扫读 **2.996**，而最窄那条是 **0.500**。
   所以输入是**一个开口**（`fromMm` + `fromAxis`），锚点直接取 `list_features` 报出的孔
   （`centerMm` + `axisMm`）。这与 2026-10-11 的"孔即开口即通道"是同一条线。
3. **只在横切上出数**：空隙截面必须是材料里的**内孔**。切出零件之外的尖角薄片、或顺着通路走
   的刀，读数不支撑任何结论（实测：不加这一条，30° 斜孔的近两端切片被读成 0.178mm，真值 4.000）。

**输入 / 输出**：`{path, fromMm, fromAxis, budget}` →
`{topology, reachable, throughAlongAxis, bottleneckRadiusMm, tightestAtMm, endConditions,
sectionsAccepted, cuts, sampledSpanMm, micToleranceMm, disclosure}`。
**拒绝时给 `refused` + 原因，绝不给数字**，并说清是哪一种：亏格 0（没有通路）／锚点归不上任何
通路（不是开口）／走查在**材料内部**断掉（死胡同 = 盲特征，或通路拐过了跳跃上限）。

**未接工具（有意）**：本 op 进 worker 的 op 表（**第 31 个**），但**不注册工具**——规则层
（`escapePassageMinMm`、`toolRadiusMm` 的非圆槽那一半）怎么消费它尚未定案，先让它在验收里活着。

**锚点的要求（验收里踩出来的）**：开口必须是**平面面内部的闭环**。一条通到面边缘的槽
（例如 1.5×40 的槽在 20mm 的块上）不是"开口"：`list_features` 报 0 个孔。另外锚点可以落在
**内部台阶面**上——此时只有一侧有通路，另一侧是实心；**那不是死胡同**（判据只统计真正有截面的
方向，见 `op_passage_bottleneck` 的 `endConditions`）。

**已接线（2026-10-13）**：`escapePassageMinMm` 对**非圆 + 贯通**的开口调用本 op（锚点 =
该开口的 `centerMm` + `axisMm`，`fromSizeMm = sqrt(areaMm2)`），只有
`reachable && throughAlongAxis` 才出 witness，且与圆孔同一条余量规则（噪声带 =
`max(micToleranceMm, 0.01)`）。此前非圆通道是**静默缺席**：孔表按"有没有直径"过滤，
而非圆孔按设计没有直径（实测 microscope4 v031：53 个孔里 32 个非圆，一个都没进规则）。

**已知边界（必须随结果披露，不许静默）**：① 走查步长可能跨过一段很短的颈——采样问题，
故输出必带 `sectionsAccepted`/`coveredMm`，"没找到更窄处"必须说清查得够不够全；
② **宽开口给粗步长**：步长按开口尺度取，7000mm² 的腔口得 13.9mm，一步跨过 4mm 深的腔
（实测 h6 因此拒绝出数）；要覆盖它得由调用方传更小的 `fromSizeMm`，或让 op 按第一刀截面自标定；
③ 锚点只认**平面面上的闭环开口**：曲面上的开口（`list_features` 报不出）、一个开口通向两条路、
多条隧道无法配对，一律**未判定**而不是猜；④ "未排除"≠"能排出"——工具只能证明"太窄"。

### 13.9 教训

1. **性能判断先基准后结论**：「express 预览档」方案没测就提，实际瓶颈是 xvfb-run 启动税，方案完全跑偏
2. **基准脚本自身要先验证正确性**：相机参数多拼一个 `,0` 导致整轮渲染数据是失败时间；`cube` 默认 corner-origin 让掉落测试测成了边缘滑落
3. **单位与坐标系约定要显式声明**：z-up、毫米，写进工具描述
4. **手写冒烟测试 ≠ 视觉正确性**：STL 结构合法但绕序错误只有渲染能暴露
5. **bash 会话间变量/后台进程不共享**：跨命令的基准脚本必须自包含（Xvfb 启动、变量定义）

### 13.10 图片上下文修枝（实施实录，v2.13p）

> **来源**：「还有一个问题，是我们之前在 DESIGN.md 中讨论过的，对图片类的上下文要进行修枝，太挤占上下文了，现在我们需要实现他了」——指的是 §12.3「图片修剪扩展」：*方案：旧轮图片换文本占位；触发线：单任务轮次 ≥4*。

**先把问题量化**（用本仓自己的遥测 `data/usage/usage.jsonl`，1094 次会话请求）：

| 指标 | 实测 |
|---|---|
| 单请求携带图片数 | 峰值 **88 张**，527 次请求超过 24 张 |
| 单请求图片 token | 峰值 **88k**（对同期文本 168k） |
| 语料图片 token 合计 | **36.0M**（文本 110M） |
| 每轮 `generate_part` 附图 | 4 张（前/侧/俯/轴测），所以 88 张 ≈ 22 轮 |

会话每步重发全史，图片是**单调累积**的：第 1 轮 4 张、第 22 轮 88 张。这就是"挤占"的来源——不是某一轮多，而是**每轮都在重付前 21 轮的钱**。

**修枝该放在哪一层：先排除两个错的地方，才轮到对的地方。**

| 候选 | 结论 |
|---|---|
| ❌ 在插件里拦请求改写 | `llm/stream` 是 waterfall，但文档写死：循环构造的请求**深冻结**（`markAgentLoopRequest`，改动即抛），因为「content 是会话日志的纯函数」。可读不可写——**这条路被架构封死** |
| ❌ 改写会话表面（durable replace） | `session.append(type, data, {surfaceOp:{op:'replace',…}})` + `compaction/prune` 影子定价确实能做到（`dsh-compaction-tool-result-pruner` 就是这么剪超长文本的），但表面是**所有人**的历史来源：剪掉 = 对话记录里旧渲染图真的消失。用户要修的是**上下文**，不是**记录** |
| ✅ 适配器的 offload 投影 | 已有的、被测过的、**非破坏性**机制 |

**它其实早就实现了这个方案，只是阈值是给提供商兜底用的**：`offloadRequestImagesWithPolicy()` 按请求顺序把**最旧的**图片按整数配额换成 `offloadedImageText(ref, access)` 文本占位——占位里带附件身份**和本地规范化路径**，所以模型真要细看时可以用 `read_image` 把它取回来。配套的定价函数 `deepSeekImageRequestPricing` 对已 offload 的图**按 0 视觉 token 计价**，于是压缩压力计费与提供商实收一致（这点很关键：否则"剪了却还按没剪算"，压缩会提前触发）。

默认值是 `maxImagesPerRequest: 600` / `imageOffloadCountQuantum: 20`——**提供商硬上限，不是上下文经济学**，CAD 会话永远碰不到。把这两个数改成保留窗口即可：

```yaml
# dsh-cad-harness/cordis.patch.yml
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    maxImagesPerRequest: 24      # 保留最新 24 张 = 6 轮渲染
    imageOffloadCountQuantum: 8  # 一次丢 8 张（2 轮），前缀稳定一段，provider 前缀缓存不被每步打断
```

**为什么 24/8**：24 张 = 6 轮（触发线是 ≥4 轮，留出比较余地）；量子 8 使窗口在 **17..24** 之间振荡，最坏情形仍 ≥4 轮。实测语料：图片 token **36.0M → 18.6M（-48%）**，峰值 **88k → 24k**，527 次超限请求全部落进 17..24。

**pi-ai（GLM）那半边只能另走一条路**，原因是三个事实叠加：① 那个适配器**只有字节预算**（`maxRequestImageBytes`，且 `byteQuantum` 硬编码为 1）；② 预算在**provider 档案**里，档案名由用户的 settings 文档定义；③ 静态 patch 里写死 provider 名会**凭空注册一条路由**（`resolveProfiles` 会因它不可服务而拒绝整段）。所以由宿主半在启动时按**解析后的档案列表**写入（`src/host/image-budget.ts`）：只写已存在的档案、只写 `maxRequestImageBytes` 一个字段（`settings.mutate` 的路径写 = 合并式）、只收紧不放宽（已有更小值就跳过 → 重复启动是幂等 no-op）、失败只记日志不阻断启动。校准用**最坏尺寸**而不是平均：本仓规范化渲染 p50=33KB / p90=112KB，字节预算按 base64（×4/3）计，**2.5 MiB 在 p90 下仍留 ~17 张**。

**遥测跟着改成"提供商实收多少"**：`usage.jsonl` 原来记的是历史里有多少张（现在是虚高的）。新增 `imagesBeforePrune`，`images` 改为**投影后**的张数（图片 token 也按它算）；预算生效前写下的历史行没有新字段，而那时默认阈值从不触发 → `imagesBeforePrune` 缺省等于 `images`，**新旧行天然可比**。`/api/cad/usage` 增加 `imagesPruned` 与当前预算值，面板/接口能直接看到修枝在生效。

**验收（`scripts/accept-image-budget.mjs`，39 项全 PASS）**——关键不是"我算了一遍"，而是**我报的数 == 适配器实际做的数**：

- 同一份合成史（22 轮 × 4 图 = 88 张）分别喂给 `measureUsage()`（本插件的预测）和 `offloadRequestImagesWithPolicy()`（harness 的裁决），**两条路由都必须逐张一致**：DeepSeek 24 == 24，pi-ai(112KB) 17 == 17
- 结构不变量：消息条数不变（45→45）、22 个 tool-result 全在、**最新一张未被触碰**、保留的恰好是"最新的 N 张"（最旧前缀 + 顺序保持）、64/71 个占位符**都带可取回的路径**
- 镜像函数 vs `offloadedImagePrefixCount()`：195 组（张数 × 字节 × 三套配额）逐一相等
- 真语料回放：36.0M → 18.6M 图片 token，窗口 17..24，且带**阳性对照**（527 次超限请求确实存在，否则测试是空的）
- **patch 真的落到组合后的配置树上**：临时 `DSH_HOME` 里跑 `dsh --profile web --dump-config`，断言 `llm-deepseek` 行带上了这组 config，且**没有任何 `patch: entry not found / name mismatch` 警告**（patch 匹配不上只会打警告然后静默跳过，不验等于没做）
- pi-ai 胶水用假 settings 验（沙箱没有 dsh 上下文，**验的是接线不是 harness**）：只写一条路径、不发明 provider、不放宽已有更紧的值、重入不成环、拒绝写入被包含并记日志、没有 settings 服务时静默

**遗留**：① 该 patch 与宿主半都要**重启 dsh 进程**才生效（bundle 层在启动时读）；② pi-ai 的写入会落到 `$DSH_HOME/settings.yaml`，原文形如 `llm-pi-ai.providers.<名>.maxRequestImageBytes: 2621440`，删掉该字段即回退；③ pi-ai 的 `byteQuantum` 硬编码为 1 → 过线后每步丢一张，前缀缓存不如 DeepSeek 那条友好（harness 侧的设计，不改）；④ 若用户在 Web Models 页重存某个 provider，可能把 schema 默认的 20 MiB 固化进用户层，届时我们的"只收紧"守则会跳过——需要显式改回。

### 13.11 插件分层：把 CAD 工具表从编程会话里摘出去（v2.13q）

> **状态**：✅ **已装上（2026-10-01）**。中间有一次回退再装上的往返，两段都记下来，因为**回退的理由比实现本身更重要**。
>
> **第一次上线 → 被否决**：实现跑通、验收 27/27，但规则一上线会让**所有已存在的会话**（含当时正在进行的那个）按设计失去 CAD 工具——因为 `agentPreset` 是**会话的创建事实**（写在 session header 里，只在会话还空白时可改）。要拿回工具只能**弃开当前会话**。用户原话：「这个成本不可接受，请先复原」，于是全量回退，只留一个只读量具。
>
> **重新装上（同日稍晚）**：用户看完几种规避方案后选定了「**新项目从第一天就用 CAD preset**」这条路——把时间点挪到项目开始之前，**迁移成本归零**（还没有任何 CAD 会话可以被误伤；已有的编程会话反而是自动变干净的收益方）。**结论：方案没问题，采纳时机有问题；这类"要求重开会话才生效"的改动，只能装在项目开始前。**
>
> **装上的同时确认的两条边界**（写在 `tool-scope.ts` 顶部，让下一个读代码的人先看到）：① 已存在的 CAD 会话会失去工具调用能力；② 面板/路由/遥测/导出全留全局，人那侧的通道一个不少。
> **来源**：「是不是安装了插件就一定会修改系统提示词？安装这个插件后如果我需要做一个编程任务怎么办？」

**先纠正一个前提**：本插件**不改系统提示词**——一个字都没加。系统提示词是会话表面上的 `system/message` 节点（harness 原话："the system prompt is a surface node"，由 `dsh-persona` 拥有）；宿主半只 `inject: ['tools','attachments']` 然后注册工具。

**但代价是真的，且在"工具表"上**。harness 把工具表算作**请求信封唯一计价字段**（`estimateToolsTokens(header) + surfaceTokens` = 单次请求总量）。真相来源是会话日志的 `request/header` 事件——**durable 记录每次发出去的工具表**：

| | 工具数 | 目录 token | 其中 CAD |
|---|---|---|---|
| 干净会话（27 工具） | 27 | **6,829** | 0 |
| 带 CAD 的会话 | 37~38 | **11,060~11,445** | 10~11 |
| **净增** | +10~11 | **+4,236 ~ +4,616** | |

即：**每一次请求、每一个会话（含纯编程）都多背 ~4.5k token 的工具表**，还有 10 个 CAD 工具参与注意力竞争。另外客户端半边也是全局的：一个 `CAD` 头部按钮 + 每 3 秒一次 `/api/cad/products`。

**根因是分层放错了**。DSH 是两层 composition：

| 层 | 装什么 | 谁看得见 |
|---|---|---|
| **profile**（host plane） | 注册表、沙箱、持久化、模型路由 | 进程级 |
| **preset**（agent plane） | **工具、prompt section、projection** | 只有选了该 preset 的会话 |

我们的 bundle 挂在 profile 的 bundles 列表里 → 工具进全局注册表 → 所有 preset 继承。harness 源码自己写了正确形状：*"Reading the exempt set as 'the global layer' … held only while every model-facing tool sat in the host composition. **Once presets moved them onto the agent plane** they became an ANCESTOR contribution."*

**为什么不能简单把行挪进 preset**：客户端半边（侧边栏 tab）是靠扫描 composed rows 里带 `dsh.client` 的包发现的（`dsh-client-modules`："composed rows in scan order"）。把行挪走 → tab 直接消失。

**做法：三件东西各就各位**

1. **`registerCadTools()` 收集并返回自己注册的工具名**（`registerTool()` 包一层，11 个注册点）。**不硬编码名字表**——否则下次加工具就悄悄泄漏进编程会话。验收断言 scope 模块里不含任何工具名字面量。
2. **`src/host/tool-scope.ts`**：`agent/created` 时读 `agent.session.header.agentPreset`（**纯数据，不需要 import 兄弟包**），命中的规则：
   - preset ∈ `presets`（默认 `['cad']`）→ 保留；
   - **没有 preset** → 保留（headless/不分 preset 的部署不能静默失去能力）；
   - **`delegationDepth > 0`** → 保留（子代理在替 CAD 会话干活，它自己的 header 未必记着 CAD preset）；
   - 其余**具名 preset** → `agent.ctx.tools.restrict({ deny: [...names] })`。
   必须在 **agent 自己的 ctx** 上调（registry 会拒绝 context-global 的限制："a context-global restriction would mask every agent"）；失败只记日志不阻断建 agent。
3. **`cordis.patch.yml`**：CAD 行加 `config: {toolScope: preset, presets: [cad]}`；**agent-presets 行加 `roots`** 指向本仓 `presets/`。

**CAD preset 从仓库里发**（`dsh-cad-harness/presets/cad/`）：preset 之间不能继承，所以它的 composition **等于 standard**——而这正是重点：CAD 工具本来是全局注册的，**只是不再对"选了 cad preset 的会话"隐藏**。为避免手抄的 fork 随 dsh 升级腐烂，composition 由 `scripts/sync-cad-preset.mjs` **从已安装的 standard 生成**（`preset.yml` 手写、不覆盖），升级 dsh 后跑一次即可，`--check` 可在 CI 里比对。

一个坑（**patch 替换整行 config，不是合并**）：`agent-presets` 行原本由 web bundle 声明 `default: standard`，我们覆盖时必须**把它一起重述**——否则 roster 在 mount 时 fail loud。`includeShippedRoot/includeUserRoot` 只是因为 schema 默认是 true 才幸存，也一并写出来，免得读的人还得知道这件事。

**验收（`scripts/accept-tool-scope.mjs`，27 项全 PASS）**

- 规则真值表 6 条（cad 留 / standard 摘 / minimal 摘 / 无 preset 留 / 字段缺失留 / 子代理留）
- 胶水（假 ctx）：**restrict 恰好传 11 个注册名**、CAD 会话不调、无 preset 会话不调、**reject 被包含且记日志**、同一 agent 只限一次
- 静态不变量：`registerCadTools` 有 11 个注册点且 `return registered`；scope 模块**不含任何工具名字面量**
- **用 harness 自己的 discovery 验我们的 preset 目录**（`scanRoot`）：找得到、`broken === undefined`、18 个顶层行、有 name/description、trust=user
- **patch 落到组合后的配置树上**（临时 `DSH_HOME` + `dsh --profile web --dump-config`）：root 路径为本仓、`default: standard` 已重述、`toolScope: preset` 到位、**无 patch 被跳过**
- `--catalogs` 模式：直接读会话日志的 `request/header`，**打印每个会话真实发出的工具表大小与可见 CAD 工具数**——这是唯一能证明"隔离真的减少了模型收到的东西"的证据

**迁移代价（必须说清）**：已有会话的 header 里记着 `agentPreset: "standard"`（**包括写这份文档时的那个会话**），重启后它们会**按设计**失去 CAD 工具。字段是创建事实、只在会话还是空白时可改，所以：

- CAD 工作请**新建会话**并选 `造物模式` preset；
- 面板在任何会话都能用（路由保持全局），看/量/标注/截图不受影响，只是 agent 不能再调 CAD 工具；
- 想回退：把 CAD 行的 `presets` 加上 `standard`（等于关掉这个特性），或删掉 `toolScope`。


**遗留**：① 需要重启 dsh；② 正在进行的 CAD 会话会失去工具调用能力（见上）；③ `roots` 用的是绝对路径——因为 `!!js` 表达式**不被 `--dump-config` 求值**，算出来的路径无法离线验证，而这个 profile 本来就用绝对 `link:` 钉住插件；④ 子代理的 preset 继承语义没实测（规则里选了"保留"，安全方向）。

**与 13.12 的关系**：preset 隔离只解决"**编程会话不该付 CAD 的钱**"，对 CAD 会话本身一分不省。CAD 会话的钱在 13.12 削（描述 → skill）。两者互补，且 skill 的发现根也挂在 CAD preset 上，所以**先有 13.11 才能让 skill 只对 CAD 会话可见**。

### 13.12 削描述 + CAD 专属 skill（v2.13r）

> **来源**：「方案 1 也不要丢，而且如果实现了方案 3，skill 的内容可以更加丰富一些」。

**先量化，再动笔。** 从真实会话的工具表逐字段拆开那 4,621 token：

| 组成 | 字符 | ≈token | 占比 |
|---|---|---|---|
| **工具级描述**（`description`） | 7,054 | 1,764 | 38% |
| **参数级描述** | 4,608 | 1,152 | 25% |
| **脚手架**（JSON 结构/字段名/类型/required） | 6,792 | 1,698 | 37% |

**做法**：工具级描述只留"**是什么 + 何时用 + 一个必知契约**"（11 段共 7,122 → 2,151 字符）；被删掉的那部分**不是废话，是知识**——它主要是**路由判据**（"这个问题该用哪个工具，而不是哪个"）+ **全局约定**（mm/z-up、datum 约定、BOSL2 可用）+ **反直觉事实**（`simulate_motion` 无重力、关节处网格重叠是预期、`check_assembly` 只有两个算子真在检、外购件不能当接口端点）。这些搬进 `skills/cad-toolbox/SKILL.md`。

**为什么 skill 是对的地方**（HARNESS §6 早就定了这三层：库给能力、runtime 给执行、skill 给地图）：skill 的目录项只有一行 description，**正文按需加载**——不做的任务一分不付，做的任务只在真正动手时付一次。而且**它的发现根挂在 CAD preset 上**（`cad-skill-filesystem` 行，`customSkillDirs` 指向本仓 `skills/`），所以**编程会话连 skill 的目录项都看不到**——这正是"实现了方案 3 之后 skill 可以更丰富"的机制基础。

**测量方式（不启动 dsh 也能量准）**：`scripts/measure-tool-cost.mjs` 取**日志里最近一次真实请求的工具表**，把 CAD 工具的描述换成当前源码里的，重新用 harness 自己的估价规则算——参数 schema 与脚手架是真实记录里的，所以差额**只**来自描述改动。

**实测**：

| | before | after |
|---|---|---|
| CAD 工具表 | 4,621 tok | **3,394 tok** |
| 整张工具表 | 11,449 tok | **10,222 tok** |
| **每次请求省** | | **1,227 tok（−27%）** |

（`simulate_motion` 从 3,765 → 3,191 字符仍最大：它剩下的 1,905 字符是**脚手架**——`parts[]/joints[]/drive/oscillators` 的嵌套 schema，不是文案。）

**还剩多少可削**（下次要动就从这里动手）：脚手架 1,698 + 参数级描述 1,152 ≈ **2,850 tok**。前者要靠**减少参数嵌套/合并工具**（`measure_*` 三合一、`check/validate_assembly` 合并），后者要逐字段判断哪些语义只能留在 schema 里。**这两块都比削工具级描述风险高**，所以先做了低风险的那一半。

**验收**：`scripts/accept-tool-scope.mjs` 增了两条——skill 根真的挂在 CAD preset 上（正则断言 `cad-skill-filesystem` + `customSkillDirs`）、preset 仍然可 mount；`scripts/measure-tool-cost.mjs` 出上面的数；`scripts/inspect-tool-catalog.mjs` 重启后读真实会话出对照。

**给用户的动作**：① 重启 dsh；② **CAD 工作新建会话、在空页面选 `造物模式`**；③ 老会话（含写这份文档时的那个）按设计失去 CAD 工具，但面板照常可用。

### 13.13 项目作用域：一个项目一份语料（v2.13s）

**触发它的不是"显示不对"，是实机反馈的一句追问**：新项目打开 CAD 面板，零件下拉里还是旧项目画的那批零件。

**根因（比表面严重）**：所有 store 都在插件 `apply` 时开一次，根是 `ctxRevisionRoot()`——**插件自己的安装目录**。于是：

1. 面板 `/api/cad/products` 无条件返回**全局唯一的语料**，新项目看到旧零件（用户看到的那一幕）；
2. 更糟的是**工具侧**：`ensurePart()` 是**按名字全局匹配**的，新项目里一个叫"底座"的零件会**直接认领**旧项目那个"底座"，两个项目的修订史被缝在一起——这是静默的数据损坏，不是显示问题；
3. 版本/运行 id 是**每语料自增**的（`v001`、`r001`），所以 `/api/cad/run?id=r001`、`export?v=v007` 在第二个项目出现的那一刻就是**歧义的**——平坦命名空间根本表达不了两个项目。

**裁决：项目的身份 = 会话的工作目录（cwd）**。理由：cwd 是**已经存在的创建事实**（会话日志本来就按 `<cwd 编码>` 分目录、`workspaceRegistry` 的成员判定也以它为准），而且是人对"项目"的直觉——**同一目录的多个会话共享零件，新建一个目录就是新项目**。存储位置取 `<DSH_HOME>/cad/<basename>-<sha1(cwd)[0:8]>/`（与 dsh 自己的会话/附件同层，不往用户仓库里写东西）；目录里放 `project.json` 记回绝对路径，所以哈希目录名永远是可解释的。

**落地分成两侧，缺一不可**：

| 侧 | 怎么拿到项目 | 关键改动 |
|---|---|---|
| 工具调用 | `exec.agent.session.header.cwd`（durable 创建事实） | 11 个工具体全部改为 `await allStores(exec)`，**没有**任何模块级 store；4 个共享 job 函数（motion / physics / fluid / assembly-check）收 `ProjectStores` 参数 |
| 浏览器请求 | `?project=<绝对目录>`（客户端传当前会话 cwd） | 17 条路由各自 `requestStores(request)`；**相对路径一律拒绝**并回落到服务端 cwd（`?project=../../x` 不能命名别的语料） |
| 客户端 | `sessions.list.byId[current].cwd` | 新增 `src/client/project.ts`：`withProject(url)` 是**唯一**的 URL 构造器；切换项目时清空并重新取数；`/api/cad/products` 回显 `project`，**迟到的那份回答不许重绘你已经离开的项目** |

**两处"反直觉但必须"的决定**：

1. **遥测反其道而行，留在 profile 层**。`registerUsageObserver` 一次观察**所有**会话的 `llm/stream`；它量的是**请求**（上下文里有几张图、付多少 token），不是**设计**。所以 usage 搬到 `<DSH_HOME>/cad/telemetry/`，与项目平级——把它按项目切开会让每个项目的数字都变成残缺的。
2. **读取不创建目录**。`projectStores()` 是纯路径运算，只有**写**（工具产出）才 `ensureProjectDir` 落 `project.json`。这正是"新项目打开面板是空的、而且不是报错"的实现方式——目录不存在 = 空语料，不是什么异常状态。

**迁移**：旧语料（34 版本 / 5 运行 / parts / assembly / manifest）整体搬到 `~/.dsh/cad/ToyMarker-3eab5108/`（键取自本仓所在工作区），`usage.jsonl` 按追加搬到 telemetry。`scripts/migrate-to-projects.mjs` 用**运行时同一个** `projectKey()`（不是抄一份哈希逻辑），并且**按条目合并**：目标里已存在的 id 一律拒绝覆盖并报出来（两边各有 `v001` 时不许猜），usage 按行去重追加——所以**迁移可以重跑**，这正好覆盖"旧 dsh 进程还没重启、又往老路径写了东西"的漂移窗口。

**验收**：`scripts/accept-project-scope.mjs`（56 条）不只是断言路径算法，它**拉起真的路由处理器**（假 connection + 真 `Request`）来证明隔离：在 A、B 两个项目里各造一个同名零件、各拿 `v001`，然后断言 `?project=A` 与 `?project=B` 返回**各自的几何**、`r001` 在 B 里是 404、全新项目返回空且不是错误；再加静态不变量（工具体无一漏收 `exec`、路由无一漏解析项目、客户端无一 URL 漏带项目）。

**次日补记（v2.13u）：面板读错了 store 的读法，于是"永远空"。** 上线后用户报"零件选择总是空"。host 侧完全正常——直接驱动真路由，`microscope2` 返回 5 零件 / 6 运行、`ToyMarker` 返回 14 / 4——所以问题在客户端。根因是**一行读法**：`src/client/project.ts` 用 `sessionsService?.list?.get?.() ?? sessionsService?.list?.value` 取会话列表，而真实的 `SnapshotStore` **只有 `getSnapshot()`**（本机出厂代码里 `sessions.list.getSnapshot()` 有 **21 处**、`.get()` **0 处**；出厂的 chat 插件正是用 `ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd` 读同一个字段）。于是 `state` 恒为 `undefined` → `cwd` 恒为 `''` → **每个请求都不带 `?project=`** → 宿主回落到自己的 `process.cwd()`（启动目录，不是任何 CAD 项目）→ **每个会话都是空的**。

同一个读法还被 `currentSessionPreset()` / `currentSessionBlank()` 用着，所以 §13.14 新加的琥珀色提示也**从来没出现过**（preset 恒为 null → 规则判定"未知就不要猜"→ 沉默）。**一个读法错，两个症状。**

修法：① `getSnapshot()` 优先（旧写法降级为 fallback，兼容别的 store 形状），截图路径 `liveSession()` 同一处一并修；② 空状态**点名项目**（`还没有零件（项目：microscope2）`，读不到目录时明说"未识别"）——"没有数据"和"读错了目录"长得一模一样，正是这次绕远路的原因；③ 回归测试用**只暴露 `getSnapshot` 的假 store** 复现这个 bug（真 store 就是这个形状）。

**教训（第三条，前两条在 §13.9/§13.11）**：**"插件级单例"是隐形的功能缺失**。`ctxRevisionRoot()` 那三行当初写下来是为了省事（插件自带的 data 目录），读起来人畜无害，实际含义是"这个插件在整个 profile 里只有一个设计"——而这个前提从没被写进任何文档、也从没被检查过。**判据**：任何 `join(pluginRoot, …)` 形式的持久化路径，都要当场回答"第二个项目/第二个用户来了会怎样"。

### 13.14 预设"选了没生效"，而且界面还确认了你的选择（v2.13t）

**症状**：试用显微镜时 Agent 报 `Error: skill "cad-toolbox" is unknown or no longer available`。

**取证**（`scripts/inspect-tool-catalog.mjs` 读会话日志的 `request/header`，即模型**真实收到**的工具表）：

```
session-5995a2ea  examples/microscope  preset=standard  27 tools  6833 tok  CAD —
session-eecbcf56  Project/ToyMarker    preset=standard  37 tools 11064 tok  CAD 10
```

第二行是**按 preset 收窄上线之前**录的（同样写着 standard，但工具表里有 CAD）——正好是这次改动的对照。第一行说明：**那个试用会话是「标准模式」**，CAD 工具 0 个。

**因果链**：会话以标准模式出生 → `decideToolScope` 判定收窄 → 工具表里没有 CAD 工具**且** `cad-skill-filesystem` 那一行也不在组合里 → 技能根没挂 → `skill "cad-toolbox"` 未知。Agent 的绕行方式很能说明问题：它**用 bash 读了 `skills/cad-toolbox/SKILL.md` 的源码**，然后才去调 skill 工具。

**根因不是"人忘了选"，而且是两个缺陷叠在一起。** 第一版结论把责任推给了操作，是错的：用户明确选了「造物模式」，选择**真的成功了**。日志给出一条完整的链：

| 时刻 | 事件 | 结果 |
|---|---|---|
| 06:36:59 | 用户在 `cdca475a`（ToyMarker 里一个空白会话）选中造物模式 | ✅ `agent-preset/selected {agentPreset:"cad"}` **写进日志**，切换成功 |
| 06:37:40 | 用户为显微镜新建会话 `5995a2ea` | ❌ 出生即 `standard`（默认预设），上一步的选择**留在上一个会话里** |
| 06:38:22 | 第一条消息 | ❌ 27 工具 / CAD 0 个 |

**缺陷 A（出厂客户端）**：选择只落在"当前那个空白会话"上，**不会继承给之后新建的会话**；而芯片把**暂存**值直接画成"已选中"（`stage(id)` 会顺手 `set({current:id})`），所以界面确认了、后面的会话却不认账。机制在 `dsh-client-ui-agent-preset/lib/client.js`：

- 选择先被**暂存**在浏览器内存里（`stage(id)` 会顺手把芯片画成你选的那个）——所以**界面看起来一切正常**；
- 暂存值要等"一个**空白**会话成为 current"时才真正提交；
- 会话日志的证据：header 事件从出生就写死 `agentPreset: "standard"`，全程**没有** `agent-preset/selected` 事件；会话创建于 06:37:40、首条消息 06:38:22，中间**空白了 42 秒**——所以既不是"选太晚"，也不是"选太早"；
- 而 `apply()` 的分支是：`if (!session.blank || presetOf(session) === staged) { this.staged = void 0; return; }`——**不空白就把暂存丢掉，不报错、不提示、不回落**。宿主那边也只有"已开始的会话"才拒绝（`agent-preset/locked`，`lastTurn > 0`），会显示在芯片上。
- 旁证：`apply()` 的两条分支都能静默丢：`session === void 0` 直接 return（等"当前会话"出现），`!session.blank` 则**丢掉暂存**。两条都不报错。

**缺陷 B（本插件，更隐蔽，也更该由我们负责）**：`cdca475a` 那条切换**成功了**，但它在 seq=18 记下的真实请求仍然是 **27 工具 / CAD 0 个**。原因是 `tool-scope.ts` 读的是**会话头** `session.header.agentPreset`——而会话头是**创建事实**，切换**永远不会改写它**。于是"出生 standard、后来切到 cad"的会话，被自己的规则判成非 CAD 会话，工具继续被藏。`dsh-agent-presets` 的模块文档把这条规则写得很直白：**"Reconstruction reads the `agentPreset` Session projection, never the header alone"**。

修法（`src/host/tool-scope.ts`）：
1. **判据改用 `agentPreset` 投影**（`ctx.sessionProjections.stateOf(session,'agentPreset')`），只在投影服务缺失时回落会话头；
2. **切换会即时生效**：`ctx.tools.restrict()` 返回的是"解除该限制的 disposer"，于是编排 `agent-preset/selected` 事件——新预设是 CAD 就把 disposer 调掉，离开 CAD 再挂上；否则创建时挂上的限制会与"会话实际运行的预设"长期矛盾。

**为什么人看不出来（这才是真问题）**：插件的**人的半边是全局的**（路由/面板/遥测），**模型的半边是按预设的**。于是"面板一切正常 + 零件列表空空如也"与"这个会话根本没有 CAD 能力"在人眼里长得一模一样。本仓的原则（§4 人的通道）要求面板**必须说出真相**，所以：

1. 宿主新增 `GET /api/cad/scope`（**免带 `project`** 的两条全局路由之一），如实报出 `{toolScope, presets}`；配置在 `apply(ctx, config)` 里本来就有，顺手传给 `registerCadTools`。
2. 客户端 `cadToolsVisible(scope, preset)`（`src/client/project.ts`）是 `decideToolScope` 的镜像，preset 从 `sessions.list.byId[id].projectionValues.agentPreset` 读（与出厂预设选择器同一个来源）；**preset 未知就不提示**，宁漏勿误。
3. 面板顶部出**琥珀色**一行，而且**按"还能不能救"分两种话术**（这是两条不同的物理路径，报错一条等于把人指向走不通的路）：
   - 会话**还空白**（`lastTurn = 0`，宿主仍接受切换）→「预设没生效：本会话是「标准模式」 · **会话还没开始，现在重新选一次「造物模式」还能生效**」；
   - 会话**已开始**（预设锁死）→「预设没生效：本会话以「标准模式」开始，已锁定 · **新建会话，或在设置里把「造物模式」设为默认预设**」。
   `blank` 从 `sessions.list.byId[id].blank` 读；**未知就不下断言**（不说"还能救"也不说"已锁死"）。预设名走 `GET /api/cad/scope` 的 `names`（宿主用 `ctx.reflect.get('agentPresets').list()` 把 id 翻成「造物模式」），不把 `cad` 这种 id 甩给人。

**量具自身的同类错误**：`scripts/inspect-tool-catalog.mjs` 原来也打印会话头里的预设，于是把一个**已经切到 cad** 的会话标成 `standard`——和上面的 bug 是同一个错误的两面（把创建事实当成当前状态）。已改为"**切换事件优先、会话头兜底**"，并显示成 `standard→cad`，这样"出生什么、现在跑什么"一眼可辨。

**验收**：`scripts/accept-project-scope.mjs` 增 10 条（scope 路由真返回值 + `names` 翻译 + `cadToolsVisible` 真值表 + 三种 `blank` 状态的话术断言：还空白必须说"重新选还来得及"、已开始必须给"新会话/设默认"、未知必须不下断言）；客户端静态检查同时把 `/api/cad/scope` 列为**唯一**允许不带 `project` 的路由（与宿主白名单对称）。

**教训（第四条，前三条在 §13.9/§13.11/§13.13）**：**"能力缺失"绝不能长得像"还没有内容"**。工程上它的成因是两条作用域不同的半边共用一个界面；判据是**界面必须能回答"我这边到底接通了没有"**，而且答案要来自权威方（宿主报、客户端不猜）。

**教训（第六条，也是最该记住的一条）**：**创建事实不是当前状态**。一个字段同时扮演两种角色时（`header.agentPreset` = 出生什么；projection = 现在跑什么），读错一个不会报错，只会静默地做错决定——而且**日志里还留着"切换成功"的证据，让人以为是别的地方坏了**。判据：读任何 durable 字段前先问一句"**这是记录当时，还是描述现在**"。同一条错误我在两个地方犯了：规则本身（`tool-scope.ts`）和量具（`inspect-tool-catalog.mjs`）。

**教训（第五条）**：**界面不许显示一个还没提交的状态**。这次最坏的一点不是"丢了选择"，而是**芯片把暂存值画成了既定事实**——人看到「造物模式」已选中，系统里却什么都没发生。判据：**任何"暂存/待提交"的 UI 状态，必须与"已生效"在视觉上可区分**，而且失败必须说出来（这次是静默 `return`）。顺带一条诊断纪律：第一版我把根因写成"人没选"，依据只是"日志里是 standard"——**日志能证明"没生效"，永远不能证明"没选"**。差别在于：前者是产品 bug，后者是在怪用户。

### 13.15 外部几何导入：把"别人给的件"接进闭环（v2.15，2026-10-01）

**触发**：创始人指出能力缺失——"从外部导入一个 STEP 或者 STL 文件，然后作为一个零件用在我们的项目里面，这个能力似乎还没有，意味着靠多人协作，然后靠装配和拼接的完整能力，现在是没有的"。

**第一步不是写代码，是查这条缺口为什么会被漏掉。** 查到的是一条**归因错误**：DECISION-LOG 2026-10-01（补记）里的缺口表把「STEP 导入导出」与「导入既有 CAD」并成同一行，一起判为"内核类别缺口（网格 vs B-rep）"并一起后置。对 STEP 成立；对 STL **完全不成立**——STL 就是网格，而真值引擎（Manifold 布尔 / BVH 最近距离 / rapier / MPM / measure 家族）**全部是网格的**，`mesh.ts::parseBinaryStl` 已经存在数月并在 5 个模块里使用，`renderVersionFrame` 与 `physics.ts` 早就在用 `import("...stl")`。**一个不需要内核的能力，被一个需要内核的问题扣住了。**

第二步是找**真正**缺的那一环。不是"读 STL"，而是**"几何进不了版本库"**：`generate_part`（`tools.ts`）是唯一入口且只收 SCAD 源码，`saveVersion`（`version.ts`）的 `scadCode` 曾是必填并无条件写 `model.scad`。于是**版本库事实上等于"SCAD 源码库"，几何不是可以独立存在的对象**——协作（他人给的几何无法入库）与拼装（无法把外部件当装配成员参与验证）由同一个根因断开。

**设计判据（先定判据再选实现）**：

1. **版本就是接口**。11 个工具全部以 `versionId` / `versions/vNNN/model.stl` 为输入。所以导入必须**落成一个版本**，下游零改动即生效；任何"外部模型引用"的旁路设计都会迫使每个消费者认识第二种几何——那是堆功能，不是闭环。**这条判据是可断言的**，于是验收里直接断言"导入件的 `measureVersion` 与同一几何走生成路径的参照件**逐字段相等**"。
2. **导入 = 验收，不是搬运**。本仓的核心命题是"生成与真值之间的闭环"；一个沉默信任文件字节的导入会直接违反它。于是导入跑同一个真值引擎，报出水密性、体积、包围盒、三角形数、亏格、**壳数**、退化三角形，并且**默认拒收非实体**——因为存下一个有洞的网格会让 `measure_part` / `validate_assembly` / `simulate_*` 对"不是一个实体"的东西给出自信的数字。`allowNonSolid` 只用于"我要看看这个坏文件"，并且**给版本打标记**，让几何工具明确拒绝它（验收 3c 断言 `validate_assembly` 抛错而不是给出假干涉体积）。
3. **单位是声明不是推断**。STL 无单位。`unit`（mm/cm/m/inch）与 `scale` 由调用方声明，在**任何测量之前**作用一次，并原样记入 `import.json`。25.4 倍是这类导入的经典失败模式，所以验收直接断言英寸导入的体积是毫米导入的 25.4³ 倍，且两条记录的 `unit` 如实不同。

**实现要点（值得记的不是文件清单，是几处判断）**：

- **格式探测必须精确而非启发式**。二进制 STL 的 80 字节头里**可以**写着 `solid`（历史导出器的遗留），所以唯一可靠的判据是长度恒等式 `84 + triCount*50 === length`；ASCII 判据放在其后。搞错的代价不是难看：ASCII 文件喂给二进制解析器会读出垃圾 `triCount` 并报 **"STL truncated"**——正是导入路径最不该产出的那种误导性错误。
- **二进制与 ASCII 必须归一到同一份网格**。把去重逻辑抽成共享的 `MeshBuilder`，验收断言两者**存下来的字节从第 80 字节起完全一致**（头 80 字节只记来源文件名）。
- **"字节 → 实体"只留一个入口**（`src/host/solidify.ts`）。原 `assembly.ts::buildSolid` 里内联着 parse→merge→Manifold 三行，导入路径如果自己再写一遍，就会出现"同一个网格对一个调用方是实体、对另一个不是"——正是本仓最忌讳的静默谎言。改动后立刻重跑 `accept-assembly` 与 `accept-m3` 作为守卫，断言数不变。
- **datum 是外部件进契约的唯一入口**。生成件的 datum 来自 SCAD 里的 `datum*/datum_cyl`；STL 不带。于是导入接受 `datums` 参数、写进**同一个** `datums.json`，被导入件由此成为 `check_assembly` 的合法端点。**这顺带推翻了一条旧限制**（"stock 件不能作接口端点"）：那条只对"没有版本的既有件"成立。因此 manifest 的 `source` 新增 `'imported'`，只有无版本的 `stock` 才被 `assembly-check.ts` 跳过（验收 5c 断言导入件**没有**被 skip 警告覆盖）。
- **渲染走 STL 而不是源码**：把 `renderVersionFrame` 拆成 `renderStlFramePng`（取景数学只留一份）+ 薄包装，导入件由此拿到与 `generate_part` 同形的四视图，并且**scratch 文件移出版本目录**（旧实现每次渲染往版本目录里丢一对 `inspect_*.scad/png`，只读的查看动作不该弄脏产物）。
- **导出要跟着修**：`/api/cad/export` 的非 STL 分支原来读 `model.scad`，导入件没有它——改成用 `import("<versionDir>/model.stl")` 包一层再导出，否则 3MF（打印交付那条链路）对导入件是坏的。
- **发起路径②**：`POST /api/cad/import` 与 LLM 工具共用同一个 `importPartJob`，延续本仓"一个实现两个门"的形态。

**STEP 的处置**：按裁决本轮只做 STL。`.step/.stp/.iges/.igs` 返回**可行动的边界说明**——事实（真值引擎是网格的、两个 OpenSCAD 版本都无 `import_step`）、计划路线（`replicad` + `replicad-opencascadejs` 1.1.0，已核实 `importSTEP`/`exportSTEP`/`setOC`，~55MB 纯 wasm 无传递依赖）、以及当下可做的（FreeCAD 导出 STL）。**"不支持"必须是可行动的**，否则它和人家的文件有 bug 长得一模一样。

**验收**：`scripts/accept-import.mjs` **35/35**。关键几条不是"跑通了"，而是"**它不说谎**"：非实体拒收的诊断里有真实坏边数；被强制存下的坏件让 `validate_assembly` 抛错；导入件 + 生成件的干涉体积是精确布尔值 326.2mm³（解析值 π(49−36)·8 ≈ 326.7）；导入件作 `diameter-match` 端点在容差两侧分别给出 `pass` 与 `hard-violation`。

**工具表成本（§13.12 的纪律照办）**：`import_part` 的描述第一版写成 3,166 字符（≈866 tok/请求），比 `simulate_motion` 还大——典型的"把选型理由写进工具描述"。选型判据与反直觉事实全部搬进 skill（`datums` 必需、非实体默认拒收、单位是声明、STEP 边界），工具描述只留调用时必需的信息，压到 **2,422 字符 ≈ 673 tok**。CAD 工具表由 11 个 ≈3,689 tok 变为 12 个 ≈4,362 tok（**+673/请求**，字符数/3.6 估算；`measure-tool-cost.mjs` 的精确值需要一次带完整 CAD 目录的真实请求，本会话的预设没有 CAD 工具，故只报估算）。

**教训（第七条）**：**"缺口的真伪由真实任务裁决"（§9 原话）——但缺口的归因也必须由证据裁决。** 这次的真实任务是协作与拼装，识别出的缺口是真的；**倒下的是归因**：把一个网格问题和一个 B-rep 问题合并成一行，代价是整条协作能力被无限期后置，而且因为写在"缺口表"里显得像是已经想清楚了。判据：**给缺口贴"内核/架构级"标签之前，先问一句"这条链路上到底哪一环需要那个内核"**——这里答案是"一环都不需要"。同类风险在下一个被合并的表格行里。

**未做的两件事（明确记下，避免被误当成已完成）**：① **真·拼接**——按版本号把已有件布尔合成新件，需要版本图记住来源版本（§12.2「装配级版本图」）；② **STEP 内核**——见上。

---

## 14. pi-ai 图片预算失效的量化、修复与验证（v2.16，2026-10-03）

### 14.1 量化的证据：`verification/microscope3-token-report.md`

microscope3 建模全程（331 个请求，按语料活动窗从 profile 级遥测过滤）：
**≈41.4M token 当量，图片占 54%**。两条路由在同一个下午跑同一个项目，表现差 10 倍：

| 路由 | 预算 | 带图请求的图片数（中位/最大） | 裁剪率 |
|---|---|---|---|
| DeepSeek（原生，计数 ≤24） | `maxImagesPerRequest=24` | 21 / 24 | **84%** |
| pi-ai（GLM，字节 2.5 MiB） | `maxRequestImageBytes` | **296 / 309** | **2%** |

根因：归一化后的图很小，**字节预算装得下 300 张**——`PI_AI_KEEP_BYTES` 的 p90 校准
（"~17 张"）在真实分布上完全不成立。带图请求平均扛 ~287 张图（≈287k 视觉 token 当量/请求）。

### 14.2 修复：给 pi-ai 补上计数预算

三个层面：

1. **dsh-llm-pi-ai（harness bundle，~/.local/lib/node_modules）**：适配器原本只认
   `maxRequestImageBytes`，offload 策略硬编码 byte-only。补 `maxRequestImages`
   （schema optional → parse 校验 → resolved 档案 → 传给两处
   `offloadRequestImagesWithPolicy`，`countQuantum: 8` 与 DeepSeek 侧对齐——
   8 = 两轮 4 视图渲染）。**两个预算并存，任一越线即裁**：计数管"张数太多"，
   字节管"个别附件巨大"，恰好互补。
2. **`src/host/image-budget.ts`**：`PI_AI_KEEP_IMAGES = 24`（镜像 DeepSeek），
   `applyOnce` 按键独立判收紧（bytes 收紧而 count 缺 → 只补 count），日志同步。
3. **`src/host/usage.ts` 的 `budgetFor`**：pi-ai 的遥测口径同样计入计数预算，
   否则下次报告的"图片出现次数"仍是字节口径的假象。

**改动落点说明**：dsh-llm-pi-ai 是运行时 bundle（`lib/index.js`），没有源码树可编译，
直接 patch bundle（6 处精确替换 + `node --check`），这是"插件修不了宿主"这一层的
合法例外——改动在 harness 自己的检出里，且每处替换都 assert 命中次数。

### 14.3 验证

- `scripts/accept-image-budget.mjs` 扩到 45 项全 PASS：既有 39 项不动全过（DeepSeek
  侧行为零变化）；pi-ai 侧新增三断言——**写两个键**（bytes + count=24）、
  **两键皆紧则零写入**、**单键紧只补缺键**；重放语料控制组不变。
- 全量回归：p0/p2/p3/tool-scope/inspect 全绿，tsc 干净，`lib/` 两个 bundle 已重建。
- **生效需重启 dsh 进程**（adapter bundle + 宿主半都在启动时加载）。

### 14.4 预期收益（按 microscope3 报告折算）

pi-ai 带图请求的图片出现次数 296 → ≤24（**−92%**）；全项目 token 当量
41.4M → 约 **27M（−35%）**；最大单请求从 391k 当量降到 ~130k。

**教训（第八条）**：**字节预算不是计数预算的近似**——两者度量的维度不同，而"历史里
有多少张图"这个成本驱动因素只被计数预算直接约束。校准一个代理参数（字节）时，要用
**分布的中位数**而不是最坏个案去回答"平均会留下多少"；本例 p90 校准的 17 张在真实
分布下变成 296 张。判据：**代理预算上线后，第一次真实会话就要用它自己的遥测复核一次**——
这次正是靠 usage.jsonl 里 `images=309` 这一行抓到的。

### 14.5 用户参考图被裁：诊断 + 修复（protectUserImages，v2.16b）

**现场（用户观感：成品与示例图差很远，问"图是不是没传进去"）**：遥测裁决——
首轮请求带 6 张图（含参考图，**传进去了**）；第 15 个请求（15:46:39，开工 4 分钟）
出现首次裁剪，最老优先 → **用户参考图第一个出局**，此后 3 小时模型都在"凭记忆"工作；
10-02 续作会话里参考图根本不在场。这正是 §13.10 遗留清单第 ⑤ 条
（"用户附件没有豁免"）的实锤。

**修复（dsh-llm offload 内核 + 两个适配器）**：offload 策略新增
`protectUserImages`——**user 消息顶层**的图片（用户拖进会话的参考图/截图）不进
预算算术、永不进裁剪前缀；tool-result 内的渲染图照常可裁（它们才是预算该管的大头）。
两个适配器（DeepSeek / pi-ai）都显式开启。行为验证（脚本 + 验收断言）：
41 个出现次数、预算 24 → 32 个最老渲染图被裁（quantum 8 取整）、
**两张用户图全程存活**；对照组（无豁免）用户参考图第一个被裁——旧行为复现确认。

**遥测同步**：`usage.ts::measureUsage` 的镜像口径改为"可裁集合"（user 顶层图排除在
字节账本外、但照常计入 `images`/`imagesBeforePrune`），否则报告会高估裁剪量。
accept-image-budget 新增断言：用户附件 41→25 的场景里裁剪恰为 16、用户图不可能被记为已裁。

**教训（第九条）**：**"最老优先"隐含了"最老 = 最不重要"，而用户附件恰好是全场最老
又最重要的东西。** 任何"按时间淘汰"的缓存都要先问：这个序列里有没有"天生最老"
却永远不该出局的一类？判据：淘汰策略的验收用例里必须包含"最老的元素"本身。

**生效**：重启 dsh 进程（dsh-llm 与两个适配器 bundle 均为启动加载）。

---

## 15. 交付纪律：任何插件改动必须在沙盒运行验证后才算交付（v2.17，2026-10-03）

### 15.0 严肃纪律（不可协商）

> **对插件（dsh-cad-harness 及一切宿主侧改动）的修改，必须在沙盒内实际运行并验证改动生效后才允许交付；涉及视觉/UI 的，还须通过视觉模型确认截图。没有运行证据的"完成"一律视为未完成。**

本条因一次真实事故而设立：一轮改动交付时只做了静态修改，没有在沙盒里运行；
随后的 dsh 升级又覆盖了直接打在 vendor bundle 上的宿主 patch，两层问题叠加，
§14 的三项核心修复在真实环境里全部静默失效。事后在沙盒里补跑验证，
当场抓出四处与现实的偏差（见 15.1）。

**适用范围（2026-10-03 用户更正，勿再扩大）**：纪律只约束**插件/宿主代码的
改动**。用插件干活的项目语料（`examples/microscope4/` 等）不走这套验证——
它们本来就是在沙箱里、由 dsh 实时跑着插件执行的，"在沙箱中运行"对项目语料
是内生事实，无需也不应另设验证关卡。反过来，这也是插件改动的天然验收场：
重启承载项目会话的 dsh 后，microscope4 这类在跑的会话就是插件改动的实战检验。

### 15.1 补跑沙盒验证的发现（全部是"交付时未运行"欠下的债）

1. **`cordis.patch.yml` 的 `llm-deepseek` patch 整个落空**：行名守卫抓到
   bundle 已改名 `@deepseek-ai/dsh-llm-deepseek` → `@deepseek-ai/dsh-llm-deepseek-api-key`，
   patch 静默 skip——DeepSeek 侧 24 张计数预算从未生效过。
2. **`agent-presets` patch 指向不存在的包**：当前 dsh 的 preset 是
   `@deepseek-ai/dsh-agent-preset` 声明行（见 web bundle 的 `standard.patch.yml`），
   旧的 `@deepseek-ai/dsh-agent-presets` + config roots 机制已删除。CAD preset
   从未以插件身份注册过。已改为 `presets/cad/preset.patch.yml`（由
   `scripts/sync-cad-preset.mjs` 从安装版 standard patch 文本级派生，保留
   `!!js` 表达式），经 `package.json` 的 `dsh.bundle.patch` 数组应用，
   `--dump-config` 确认 `preset-cad` 行落地。
3. **`maxRequestImages` 不存在于任何已安装版本**：§14.2 声称给 dsh-llm-pi-ai
   bundle 打的计数预算 patch，在当前安装树（0.2.0-rc.2，2026-10-03 22:01 升级）
   里 grep 为 0——要么未生效过，要么已被升级覆盖。插件侧已改为与现货适配器
   一致的机制：只写 `maxRequestImageBytes=256KiB`（按实测 base64 p50 ≈ 8.6KB/张
   校准 ≈ 24 张）；字节越线时适配器抛 `IMAGE_OFFLOAD_REQUIRED`，由 profile 已挂载的
   `dsh-compaction-image-offload` 最老优先裁剪并重试。
4. **`protectUserImages` 不存在于现货 offload 内核**：`dsh-compaction-image-offload`
   的 `offloadOldestImages` 对 user 消息与 tool-result 一视同仁、最老优先——
   §14.5 的"用户图永不裁"在现货 dsh 上不成立。遥测镜像已改为如实口径
   （user 图计入可裁账本），并在验收里钉死这一现实（显微镜3 场景中参考图确实
   第一个被裁）。若要恢复豁免，必须重新对宿主 bundle 打 patch 并纳入升级后复核。

### 15.2 验证基线（改后全绿）

- `node scripts/accept-image-budget.mjs`：**42 项全 PASS**，且交叉校验加载的是
  **已安装 dsh 树里的真实 `requiredImageOffload`/`projectOffloadedImages`**
  （此前校验的 API 在任何已安装版本中都不存在，SKIP 掩盖了这一点——现在
  加载失败会显式标注 UNAVAILABLE，而组合树检查不存在 SKIP 余地）。
- 组合树检查（临时 DSH_HOME + `dsh --profile web --dump-config`）：
  llm-deepseek 预算行、preset-cad 行、cad skill 根、registry default=standard、
  零 patch skip 警告，全部 PASS。
- `tsc --noEmit` 干净；`lib/` 双 bundle 已重建；`sync-cad-preset --check` 通过。

### 15.3 沙盒的边界（如实记录）

- 本沙盒每次命令是独立 bwrap（`--die-with-parent`，网络隔离）：**活体启动
  dsh web 进程并打 API 探针做不到**，进程随父 shell 退出。运行时验证的可达
  上限是：真实 CLI 的组合树 dump + 真实安装树 API 的行为交叉校验 + 遥测重放。
  "重启 dsh 后生效"的最后一步仍需在真实环境复核一次。
- `~/.dsh`、`~/.local` 对沙盒只读：宿主 bundle 被打 patch 后无法在沙盒内
  重放——所以本版不再依赖任何 vendor patch，全部机制收敛到插件自身。

### 15.4 由此固化的检查单（每次插件交付前）

1. `node esbuild.mjs`（改了 TS 必跑）+ `npx tsc --noEmit`；
2. `node scripts/accept-image-budget.mjs`（凡触图片预算/patch/usage 必跑，**dsh 升级后必跑**）；
3. 涉 preset/patch 落地的，看 `--dump-config` 组合树输出（验收脚本第 6 节已自动化）；
4. 涉 UI 的，`sandbox/preview` 起 shot 脚本出图并**用视觉模型确认**；
5. 交付说明里必须附上以上命令的实际输出摘要，没有输出摘要 = 未验证。

**文档结束。** 后续变更在此文档追加版本记录，不新建文档。

---

## 16. 用户图裁剪豁免：插件内受保护执行器（v2.18，2026-10-03）

### 16.1 方案 B 的落地

按 §15.1 第 4 条，现货 `dsh-compaction-image-offload` 最老优先、无豁免，参考图
必先出局。本版不打宿主文件，全部在插件内实现：

- `cordis.patch.yml` 将现货 `image-offload` 行 `disabled: true`（组合树已验证）；
- `src/host/image-offload.ts` 移植现货执行器全文，唯一行为差异：
  **`user/message` 事件顶层图片永不入选**；`tool/result` 照常可裁；
- 决策事件仍为 `image/offload`，投影校验与错误瀑布语义逐行保真
  （`agent/request-error` → retry；`compaction/summary-error` → true）；
  另加防御：投影层拒绝任何会命中用户图的决策（防篡改）；
- `scripts/accept-image-offload.mjs` 13 项全 PASS：选择逻辑（含与现货行为
  同夹具对照——现货确实选用户图第一）、投影校验、组合树 disable 落地。

### 16.2 兜底与边界

- 接缝为 `sessions.registerMessageProjection` + 两个错误事件，属内部形状：
  dsh 升级若改动，accept-image-offload 的组合树/行为断言会红，不会静默；
- 只剩用户图可裁时选择器返回 null，瀑布继续走错误路径（不会无限重试）；
- 非当前表面节点（历史压缩掉的事件）不在 `sourceEventSeqs`，天然不涉及；
- 召回工具（§15 之后的 `recall_reference_image`）仍是模型侧兜底，两者互补。

### 16.3 生效

重启 dsh 进程（宿主半 bundle 启动加载；cordis patch 在组合时应用）。

### 16.4 每会话图片窗口（方案 B′，v2.19，2026-10-03 同日）

用户裁定：全局图片预算对标准模式不公平（256KiB 对真实截图≈2-5 张就裁），且
方案 B（动态翻全局旋钮）在并发会话下互踩，否决。落地为：

- **路由旋钮降级为兜底**：pi-ai `PI_AI_KEEP_BYTES` 256KiB → **8MiB**（仅防
  病态大附件，普通聊天与 CAD 渲染风暴都碰不到）；deepseek 24 张对聊天无感，保留。
- **真窗口在执行器**：`llm/stream` 观察点拿 `options.sessionId` →
  `ctx.sessions.get()` → `session.header.agentPreset`；**造物模式（cad）**
  会话保留窗口 24 张（`CAD_IMAGE_WINDOW`，镜像 deepseek 计数预算），超窗即
  主动记 `image/offload` 决策，下一请求合规；**标准模式永不主动裁剪**。
- 并发安全：按 sessionId 去重 in-flight；辅助调用（session-title/compaction
  带 `purpose`）不驱动窗口。
- 已知代价：窗口收紧后的第一个请求仍按旧窗口发出（多付一次视觉 token），
  下一请求起合规；会话查不到（极端时序）按不适用处理（fail-open）。
- 验收：accept-image-offload 新增窗口 5 断言（超窗追加、 spared 用户图、
  窗内不动、标准模式 null、无服务 null）；accept-image-budget 的 pi-ai 期望
  改为兜底语义（显微镜3 场景 41 张不再被路由裁，窗口在执行器侧）。

---

## 17. 标准模式回归 dsh 出厂默认；一切图片干预仅限造物模式（v2.20，2026-10-03）

### 17.1 用户裁定（推翻 §16.4 的残留）

§16.4 仍保留了两个全局干预：deepseek 路由 24 张预算 patch、pi-ai 8MiB settings
写入。用户明确：**标准模式不应被修改，应保持 dsh 出厂默认**——"永不裁剪"不是
默认配置，默认配置是"根本不设预算"。据此全部撤除：

- `cordis.patch.yml`：删除 llm-deepseek 预算块（该行恢复出厂 600/20，组合树
  已验证无 `maxImagesPerRequest`）；不写任何 pi-ai 设置；
- `image-budget.ts`：删除 `applyPiAiImageBudget` 与全部 PI_AI_* 常量，只留
  造物窗口常量与遥测镜像；
- 执行器按 preset 分派：**cad** = 24 张窗口 + 用户图豁免；**其余 preset =
  与现货执行器逐字节一致的行为**（最老优先、无豁免——`accept-image-offload`
  用同夹具对照钉死两种行为）；投影不再拒绝用户图决策（非 cad 的现货决策
  必须能原样重放）。

### 17.2 造物模式的预算由谁承担

路由不再有限预算，造物会话的 24 张窗口完全由执行器在 `llm/stream` 主动执行
（§16.4 的机制不变）。代价与边界不变：超窗后的第一个请求仍按旧状态发出
（多付一次），下一请求合规；会话查不到时 fail-open；标准模式触发
`IMAGE_OFFLOAD_REQUIRED` 的唯一途径是用户自己配置路由预算——此时非 cad
会话得到与现货完全一致的处置。

### 17.3 验证

- `accept-image-offload.mjs` 21 项全 PASS：同夹具对照证明 cad 选择器 spare
  用户图、standard 选择器与现货逐字节一致（用户图第一个被选——原样保留）；
- `accept-image-budget.mjs` 重写为"路由零干预"期望：llm-deepseek 行
  UNPATCHED、现货行 disabled、preset-cad 落地、pi-ai 任何常规规模都不预测
  裁剪、镜像对照真实实现 195 例全对；
- `accept-recall.mjs` 回归 OK；tsc 干净；`lib/` 已重建。

---

## 18. 单一连通实体纪律（v2.21，2026-10-03）

零件必须是**单一连通实体**。`generate_part` 在 `shells > 1` 时追加 §18 纪律
警告；新工具 `check_connectivity(versionId)` 报告连通体数与**每个体的包围盒
和尺寸**（最大体优先），把"多出来的体是什么、在哪"说清楚。多体只有两条
正路：union 成一体（必须真实接触/重叠），或按多个零件分别建模。交付多体
版本会毒化所有下游数字——装配干涉、质量、打印排版都假设一体一零件。
验收：`scripts/accept-connectivity.mjs`（分离双立方=2 体、共面并集=1 体、
真实 temp 项目库端到端、生成端警告与 skill 纪律静态检查）。

## 19. 语料搬家：`<cwd>/cad-data/`（v2.22，2026-10-03）

### 19.1 用户裁定与理由

用户拍板：产物放进**项目文件夹**——删目录即删产物、原地重建同名项目即全新
语料。§13.13 当年的弊端（"不往用户仓库里写东西"）在今天已消失：用户有 git
可自行取舍（`cad-data/` 默认进 .gitignore，STL 是生成物）；CAD 会话只在
用户主动的目录里开。

### 19.2 落地

- `projectStores` root 改为 `<cwd>/cad-data/`；`projectKey` 保留（迁移定位
  旧目录用）；遥测**仍留在** `<DSH_HOME>/cad/telemetry/`（profile 级，量的是
  请求不是设计）；
- 迁移 `scripts/migrate-to-project-dir.mjs`：按 `project.json.cwd` 把
  `<DSH_HOME>/cad/<hash>/` 搬到 `<cwd>/cad-data/`；按 id 合并、拒绝覆盖；
  只读源降级为"复制+保留源"；悬空符号链接清扫。**幂等可重跑**。
- 已迁移 4 份语料（ToyMarker / microscope2 / microscope3 / microscope4），
  逐一 `diff -rq` 校验与源逐字节一致。

### 19.3 边界

- 活会话（重启前的旧代码）仍写旧路径：**重启 dsh 后重跑一次迁移**清扫
  漂移（这正是幂等设计的目的）；
- `~/.dsh/cad/songsenand-45ce0cbd` 是指向 microscope4 语料的悬空符号链接
  （2026-10-04 出现），迁移脚本会自动清掉；
- 沙盒对 `~/.dsh` 只读：源目录的删除需在真实环境完成（脚本会提示）。

---

## 20. 面板三栏浏览：种类 → 条目 → 版本（v2.23，2026-10-03）

### 20.1 用户定义的语义

第一栏**种类**：零件 / 组件（两个及以上零件的组装与验证）/ 整体及仿真（运动·
物理·流体运行）/ 装配契约（assembly manifest 与 ICD 检查报告，名字由用户从
候选中选定）。第二栏选具体条目；第三栏只有零件类有——**版本**，默认锁定
最新。各类内容互不混列：零件页签下只有版本史，运行按性质归入组件/仿真。

### 20.2 实现与验证

- `panel.ts`：`kind` 状态 + 三类 run 池（simRuns/assemblyRuns/contractRuns，
  从全部零件 runs + 跨零件场景拍平）；零件类 records 只含版本；旧版本选中时
  视口顶部橙色横幅「⚠ 正在查看旧版本 vX（最新为 vY）」+ 回到最新按钮。
- 沙盒视觉验证：`sandbox/shots/browse3-380x900.png`（三栏默认最新）、
  `browse3-stale-banner.png`（选中 v001 时横幅出现），存档
  `verification/shots/`。沙盒入口新增 `?kind=` 参数，select 索引更新为
  种类/条目/版本三段。
- 回归：accept-project-scope / accept-recall / accept-connectivity 全绿。

### 20.3 补充（同日）：装配契约表格 + 旧版本截图双确认

- **装配契约不用 three.js**：契约检查运行无几何，视口呈现 `reportOnlyCard`
  摘要卡；「报告」页签渲染 **HTML 表格**（接口 / 零件对 / 要求 / 实测 / 判定，
  pass 绿、hard-violation 红）——数据来自运行自带的 check 报告 JSON。
- **旧版本截图双确认**：截图草稿带琥珀警告行「此截图来自旧版本 vX（最新为
  vY）— 发送时会再次确认」；点「发送到会话」再弹一次原生确认，取消则草稿
  保留。截取时刻即记录 staleness（随图走，不因后续切换丢失）。
- 视觉存档：`verification/shots/browse3-contract-table.png`、
  `browse3-stale-shot.png`。

### 20.4 补充（2026-10-19）：工作目录选择器——看哪份语料，写哪份语料

**需求**：一个大项目下多个组件并行推进，或仓库里保留多套示例语料时，面板只看得见
会话 cwd 的那一份（`<cwd>/cad-data/`，§19）。其余语料必须另开会话才能看，找也不方便、
看也不方便。

**形状**（只读浏览，不动写路径）：

- 新端点 `GET /api/cad/projects?root=<绝对路径>` → `discoverWorkspaces(root)`
  （`src/host/workspaces.ts`）：在 root 及其下两层内找 `<dir>/cad-data`（有
  `manifest.json` 或 `versions/` 即算），返回 `{cwd, rel, name, parts, versions, latest}`。
  深度 ≤2、skip 列表挡掉 `node_modules`/`lib`/`out` 等重目录，总目录数 ≤400；
  **只读**，不建目录、不改 manifest；单份语料读不动只跳过该项，不拖垮整个列表。
- 面板 `S.bar` 最左侧「工作目录」下拉：默认「跟随会话 · <名>」，列出发现到的其余语料
  （`rel · N零件/M版`）。切换只改 `?project=`（`client/project.ts` 的
  `setProjectOverride`），读数即换语料；列表 ≤1 项或发现失败时不显示，行为与旧版一致。
- **写路径不变**：Agent 的工具仍写会话 cwd 的语料（`projectStoresFor`）。「看 A 写 B」
  在结构上不可能；下拉的 tooltip 明说"只读浏览"。

**边界**：会话切换（`refreshProjectScope` 返回 switched）自动清空 override，避免钉在
上一个会话的语料上；发现范围永远相对**会话** cwd，不受当前浏览目标影响；不引入
语料内"组件"分组——跨组件的联合装配检查仍要求所有零件在同一份语料里，那是另一件事。

**验证**：`discoverWorkspaces(仓库根)` 返回 7 份语料（根 + 5 套显微镜 + 多旋翼螺旋桨），
耗时 9ms；不存在的 root → `[]`；单语料 root（`examples/microscope5`）→ `[.] v83`。
host/client 两端 `esbuild` 构建通过，`tsc` 对本轮改动文件无报错。

---

## 21. 运动干涉 = 交付阻塞（v2.24，2026-10-03）

**用户观察**：机构"能跑"就被宣布成功，零件间碰撞/重叠无人关注。取证：插件
早有精确干涉检测（逐位姿 Manifold 布尔，干涉时间线含体积/时刻），判定也降
`check`——但黄牌 + 纯数字对模型没有牙齿，这是呈现层问题，不是 LLM 能力问题
也不是 skill 措辞问题（软约束会被跳过）。

**修正（判定与门禁变硬）**：

- `simulate_motion`：`interferenceCount > 0` → 运行状态直接 **`fail`（红）**；
  结果带 `blocking`（每对零件、体积、时刻）与 `deliverability`（两条出路：
  修几何留间隙，或在装配契约中声明为有意过盈/预压）；模型可见文本前置
  `❌ NOT DELIVERABLE`；
- **门禁自动连锁**：`check_assembly` 的 motion-clearance 本就要求引用的运行
  pass——运动运行变红后，引用它的接口自动 hard-violation，detail 带上
  "❌ 不可交付 · 干涉 N 次"。零新增门禁代码，验收已验证该链条；
- 验收：`scripts/accept-sim-verdict.mjs` 9 项全 PASS（干净机构 pass、
  穿越机构 fail+blocking+deliverability、运行落盘红色、门禁连锁 hard-violation）。

**边界**：有意过盈/预压的合法出口是装配契约的 intent 严重级——不是放宽
判定，而是把例外显式化。`simulate_physics` 的零件间瞬态穿透暂不进判定
（对地穿透有 solver 伪影问题，注释在 physics.ts），保持现状。

### 18.1 第二处症状：截图发送失败（同日）

`panel.ts::liveSession()` 还有一个独立的 `state?.current` 读法——会话解析失败
→ `sendImageToSession` 报「没有活动会话」→ **截图发送完全无效**（图片落进
浮层/托盘，模型永远看不到）。修法与 §18 相同：`currentSessionId()` 结构化
解析（导出复用）。沙盒 `assert=insert` 模式的假会话桩升级为新形状（无
current、binding + retainInfo），并补上缺失的 `setProjectServices` 接线——
E2E 截图证明全链路：scope → sessionOf ✓ → createDrafts → sendSession(face ✓)，
提示「截图已发送到会话（排队）」（`verification/shots/send-e2e-proof.png`）。

**教训（§13.13u 第五条加强版）**：升级删掉一个快照字段，散落各处的读法
各自失效。判据：修一处读法时必须 `grep state?.current` 全仓清零，并为每种
症状写 E2E。

---

## 22. 证据会随版本过期：整机产物必须随零件更新重跑（v2.25，2026-10-03）

**用户报告的坏习惯**：零件更新出新版本后，整机刚体（`merge_parts`）、
`simulate_physics` / `simulate_motion` / `validate_assembly` 的运行、
`check_assembly` 报告都**不会自动更新**——它们钉在具体版本号上
（run 的 `sourceVersionIds`、manifest 节点的 `version`、接口的 `params.runId`），
于是一份"绿色通过"的结果描述着已经不存在的几何，却看起来仍然有效。

### 22.1 交付纪律（已写入 skill 第 4 条）

零件版本更新后：重跑所有整机级产物（或在结果里显式声明它基于哪个版本、
为什么仍有效）；把 manifest 里指向旧版本的节点/接口更新到新版本并重跑
`check_assembly`；**绝不把旧运行当作当前版本的证据——证据的有效期等于它引用
的那个版本的有效期**。判据："说已通过之前，先问它验证的是哪个版本"。

### 22.2 插件侧：让过期可见（纪律的前提）

原来只有"同类同主题重跑"会标 `supersededBy`，零件出新版本不会让整机运行
过期——这就是它隐形的原因。现在 `buildProducts` 为每个运行计算
`staleVersionIds`（引用了**不再是该零件最新版**的版本），面板据此：

- 运行行加 `⚠ 基于旧版本 vNNN` 标记；
- 报告页签顶部琥珀色提示「此结果基于旧版本 vNNN — 零件已更新，需重跑后才能
  作为当前版本的证据」。

未知版本 id 不判定（不是我们该管的）；纯内联 SCAD 的场景运行不涉及版本，
自然不标记。验收 `scripts/accept-stale-evidence.mjs` 6 项全 PASS；视觉存档
`verification/shots/stale-evidence.png`。

### 20.4 三栏浏览的三个真 bug（microscope5 实测，v2.26）

用户报告"切类后下级列表更新慢""仿真/组件/装配契约内容经常为空"。用
microscope5 的 69 次运行实测，抓到三个**互相独立**的原因：

1. **重复条目**：`buildProducts` 设计上会把多零件运行**同时**放进 scene 桶和
   它引用的每个零件下；面板把两者拍平却未去重 → 契约 213 行（真实 22）、
   仿真 61 行（真实 28）。下拉列表因此又长又怪，切类时的"先不动/再混合"
   观感也来自这批重复项的增删。
2. **类别串味**：`组件` 曾定义为 assembly ∪ assembly-check，于是它打开的最新
   条目往往是一份**没有几何**的清单检查报告，视口只能显示"这次运行没有几何
   体"的空卡片——看起来就是"空的"。现在：`组件` = `validate_assembly` 的装配
   体（有几何）；`装配契约` = `assembly-check` 报告；二者不再相交。
3. **切类不落位**：自动选中逻辑只跟随"零件"的 `records`，另外三类的列表是
   扁平数组，切换类别后没有任何条目被选中 → 视口空白，直到手动再选一次。
   现在选中逻辑跟随当前类别的列表，切类即落在最新一条（新增 `kindRef`，
   `idsKey` 带上类别前缀）。

顺带修掉一个**沙盒保真度**问题：沙盒 server 用自写的 ASCII 名字白名单，
把中文零件名（`齿轮轴.stl`）全部拒掉，导致组件视图报"几何体读取失败"——
真实 host 路由用的是 `safeArtifactName`（只挡路径分隔符与控制字符）。沙盒已
改为复用同一个函数（它自己的 README 就禁止与真实路由漂移）。

分类与去重逻辑抽到 `src/client/browse.ts`（纯函数），由
`scripts/accept-browse-categories.mjs` 10 项断言保护：多属主运行只出现一次、
最新在前、三类不重叠、三类恰好划分全部运行、空语料四个空列表。
视觉存档：`verification/shots/m5-sim.png`（仿真·28，自动落位 r069）、
`m5-assembly.png`（组件·19，渲染真实 4 零件装配）、`m5-contract.png`（契约·22）。

---

## 23. 交付审计工具 + 窗口预设读取 bug（v2.27，2026-10-04）

### 23.1 microscope5 取证（用户要求"从 LLM 视角列问题"）

用其语料独立测得：**66/69 次运行引用了已被取代的版本**；全项目仅 3 条运行
"全新鲜"，其中 2 条是**失败**的 motion；最后两次 motion（r057/r059）干涉
3/9 次后 11 分钟即宣布交付；**19/19 次 validate_assembly 全部 fail**（重复
签名 x5/x3）；交付 manifest 26 接口里 **0 个 motion-clearance**（机构未入契约），
而交付文档却称"运动接口引 r029"；**83 版里 22 版从未被任何运行引用**；
10 组重复运行（同 kind+同几何+同结果）白花 15 次；交付文档的版本区间
（v001…v056）早于语料的 v083，且 6/15 个交付件版本已被取代。

### 23.2 新增 `delivery_audit` 工具

一次读三个 store + 装配清单，输出 verdict（blocked/attention/ok）与 findings：
最新同类运行是否红牌、最新版本是否有人验证、过期证据统计、从未被引用的版本、
契约是否缺 motion-clearance、manifest 节点是否指向旧版本、几何是否比契约检查
更新、重复运行组。验收 `scripts/accept-delivery-audit.mjs` **直接用 microscope5
真实语料**断言（复现上面每一个数字），并用一个"干净语料"防误报。

### 23.3 纪律（skill 5–7 条）

⑤ 整机结论必须有整机运行背书（microscope5 的"整体"证据含 7 次单件 physics，
16 件装配体从未通过）；⑥ 机构必须写进契约（否则"26 接口 0 冲突"对机构毫无
意义）；⑦ 任何交付声明前跑 `delivery_audit` 并回答其 findings。

### 23.4 顺带修掉的真 bug：窗口读了会话头

用户质疑"图片限制 24 应该已生效"。核对遥测：**deepseek 路由 41 次请求 max=24
（生效）**，而 **glm 212 次请求 128 次超过 24、峰值 221（未生效）**。原因不是
路由而是**预设判定**：会话日志显示 microscope5 会话头是 `standard`、但存在
`agent-preset/selected {cad}` 事件且随后调用 **228 次 CAD 工具**——用户确实切到
了造物模式，而 §16.4 的窗口代码读的是 `session.header.agentPreset`（创建事实，
冻结），于是把这个会话当标准模式放行。这正是 §13.14 记过的"用会话头判预设"
bug 的翻版。修法同 tool-scope.ts：以 `ctx.sessionProjections.stateOf(session,
'agentPreset')` 为准、header 仅作回退（`presetOfSession`），错误瀑布同样修正；
验收补 microscope5 形状的两条断言（同一会话：头读取=放行、投影读取=开窗）。

### 23.5 窗口遥测：让"窗口开没开"变成数据（v2.28）

microscope5 复盘时，"cad 图片窗口到底有没有跑"这个问题**无法从数据回答**，只能
靠解压会话日志翻 `agent-preset/selected` 事件反推。现在每次观察到请求都写一条
记录到 `<DSH_HOME>/cad/telemetry/image-window.jsonl`：

```json
{"ts":"…","sessionId":"…","outcome":"applied","preset":"cad","retained":28,
 "excess":4,"window":24,"pruned":4,"targets":[{"seq":1,"images":1}]}
```

- `outcome`：`applied`（裁剪了）/ `under-window` / **`preset-not-cad`**（就是
  microscope5 那种情形）/ `no-session` / `no-service` / `aux-purpose`（会话标题、
  压缩这类辅助调用）/ `in-flight`（同会话并发去重）/ `error`；
- 决策与执行拆开：`decideSessionWindow()` 只算不写（可测、可记录），
  `enforceSessionWindow()` 保留兼容形状。**hook 直接用决策函数做遥测与执行**——
  兼容包装的 `null` 无法区分 not-cad / no-session / no-service，这正是当初
  说不清的那个问题（写成 `no-service` 就是错的）。
- `/api/cad/usage` 增加 `imageWindow` 汇总（各 outcome 计数 + 最近 3 次 applied）；
  可用 `CAD_TELEMETRY_DISABLE=1` 关闭写入。
- 验收 `accept-image-offload.mjs` 覆盖 4b 段：真实 hook + 假 ctx 驱动五种情形，
  断言 jsonl 里出现 `applied`/`preset-not-cad`/`under-window`/`aux-purpose`/
  `no-session` 与 applied 记录的 window/pruned 字段。

## 24. 流体 SDF 的符号与种子掩码（v2.28，2026-10-08）

**背景。** `02-steam-engine` 首轮评测的 `c-fluid-arrival` 判 FAIL（到达率 0.3554，
判据 >0.6），而 `00-smoke` 早先也记过"厚壁件到达率从 0.93 掉到 0.097"。按
"gates 不绿时先怀疑仪器"的纪律做复现，结论是**插件缺陷**。

### 24.1 真因：射线出口落在三角剖分的共享棱上

`src/host/sdf.ts` 原先用**三条轴对齐射线**的奇偶投票定 `inside`。实测
（Ø60/Ø30 环面，壁厚 15mm）从壁内点 (0,22.5,0) 打 `+x`：

```
+x  命中 2 次  distances=[50.0, 50.0]   face 415 与 face 500 共有棱 (50,15,0)–(50,30,0)
+y  命中 2 次  distances=[7.5, 7.5]     出口点正落在共享棱上
+z  命中 1 次
→ 奇数次 1/3 ⇒ inside>=2 不成立 ⇒ 判成"外部"
```

**一次穿越被相邻两个三角形各记一次**，奇偶翻转。而网格是轴对齐的、盖面的径向
接缝恰好落在这些网格平面上 ⇒ **系统性失效，不是偶发**。后果：

| 采样点 | 缺陷时 | 应有 |
|---|---|---|
| Ø60 壁内（离表面 7.5mm） | sdf **+6.75** · solidMask **0**（当流体） | sdf<0 · mask=1 |
| Ø60 件外空气 | sdf 0.00 · solidMask **1**（当固体） | mask=0 |

薄壁（2mm < 一格 2mm）之所以"看起来对"，是 `solidMask = sign<0 || dist===0`
里的 **`dist===0` 意外救了它**——所以这个 bug **只在壁厚超过约一个网格时显形**。

### 24.2 修复：稳健符号 + 种子必须查掩码

1. **`sdf.ts` 的符号探测**：三条方向改为**互不平行且都避开坐标轴**
   （`SIGN_RAYS`），不再沿网格平面跑；命中的**同距离重复计数去重**（一次穿越算
   一次）；仍取"≥2 条为奇数次"的多数判定。
2. **`fluid.ts` 的 `seedPositions` 同时查 `solidMask`**（新增 `solidMaskAt()`，
   最近格吸附——0/1 掩码不能插值）。**距离场在壁的两侧都是正的**，单靠
   `sdfAt < WALL_CLEARANCE_MM` 区分不了"腔内离壁 0.75mm"与"壁内离表面 6.75mm"，
   所以两者**必须同时查**。
3. **让调用方看得见**：`metrics.seedStats = { accepted, rejectedWall,
   rejectedSolid, solidFraction }`。`solidFraction` 是**种子区域里金属的占比**，
   即"区域按包围盒推"的代价（Ø34 9.1% / Ø60 64.5% / Ø100 77.1%）。

### 24.3 效果

| | 修复前 | 修复后 |
|---|---|---|
| Ø60 / Ø100 壁内符号 | +6.75 / +16.75 · mask 0 | **−6.75 / −16.75 · mask 1** |
| 穿透（Ø60 / Ø100） | 970 / 1964 | **0 / 0** |
| 同内腔、只改外径的到达率跨度 | 0.443–0.7568（**0.32**） | 0.6739–0.7568（**0.08**） |

回归钉子 `scripts/accept-fluid-sign.mjs`（13/13）：三种壁厚下的腔心/壁内符号、
穿透为 0、种子记账、以及"同内腔不同壁厚到达率跨度 < 0.15"。全套 `accept-*`
26/26。**改动影响所有流体/物理仿真**，所以每次改 `sdf.ts` 都要重跑这一套。

### 24.4 仍未修（已可见，需独立验证）

**种子区域仍按包围盒推**（`deriveFluidPreset` 的 `half = spans[a]/2 - 1.5*dxMm`）。
修复后它不再产生错误答案，但代价是 Ø100 有 77% 的格点在金属里（纯浪费），
且到达率仍随外径漂 0.08（种子格点相位随区域尺寸变化）。改法是把区域与 mask
求交后再撒种，或干脆按腔体推——但那是**又一次改数值**，应当独立验证，
不宜混在 bug 修复里。

**对评测的含义。** 在本次修复前，`c-fluid-arrival > 0.6` **不是公平判据**：
一根普通直管仅因外面那层金属的厚度就能得 0.44–0.79。`02` 那条 FAIL 因此记
**仪器问题**；修复后到达率跨度收到 0.08，该判据才有意义。**修复前的 02 流体
结果已失效，需重跑。**

## 25. 仿真是"水电路"级基础设施；但不垄断，也绝不阻拦自建（v2.29，2026-10-08）

### 25.1 原则（两条同时成立，不可相互让步）

1. **仿真模拟是水电路级别的基础设施。** 我们负责把"通用、可复用、可复算"的部分
   做到位——稳定的接口、明确的语义、内置的验收、可信的默认值。
2. **但绝不阻拦 LLM 自己拉电网。** LLM 可以用脚本、bash、node/python 自行搭建
   求解器或分析流程。工具**不是唯一通道**，也不该试图成为唯一通道。

### 25.2 由此推出的硬推论：基础设施赢在"可验证性"，不是赢在垄断

既然允许自建，工具的价值主张就只能是**更省、更可信、可复算**，而**不能**是
"唯一许可"。这反过来强制出六条设计要求：

| # | 要求 | 为什么是这三条原则的必然结果 |
|---|---|---|
| 1 | **每个工具必须声明能力边界**：能算什么、不能算什么、单位与近似是什么 | 否则 LLM 会拿它去回答表达不了的问题，得出**语义不明的可信数字**——我们已在 `simulate_fluid` 上栽过一次（见 §24 与 `docs/archive/M4-M5-REVIEW.md`） |
| 2 | **报告必须回显"实际算的是什么"**：材料、工况、网格、数值近似（如人工声速）、无量纲数 | 自建与预制两条路要**可比**，就得都能说清自己算了什么 |
| 3 | **验收判据内置**：网格无关性、守恒、量纲、与解析解/手算对比 | LLM 不会主动做可信性判断（实测：`c-protrusion` 一次都没回去量被钉死的尺寸） |
| 4 | **自建通道是一等公民**：LLM 自建的仿真产物要能登记、能被验收、能进语料 | 否则自建产物无法评估，"两条路可比"落空 |
| 5 | **预制的是"工况模板"，不是"方法"** | 方法是求解器，工况才是可复用的"水电路图"（见 §25.3） |
| 6 | **不设读写障碍**：不阻止写脚本、装依赖、跑 node/python | 阻拦自建 = 违反原则 2。工程上需要一个**明确的自建工作区约定**（沙箱写权限目前限于工作区） |

### 25.3 通用仿真模板的形态：**诊断 + 处方 + 复验**

模板不是"再包一层求解器"，而是**一个高频决策闭环**。以"哪里容易断裂就加加强筋"为样板：

```
输入（少量）  约束位置、载荷量与方向、材料名
   ↓
诊断          静力分析 → 最大应力位置、安全系数
   ↓
处方          在指定位置加加强筋 / 加圆角 / 加厚（几何自动改写）
   ↓
复验          重跑 → 对比加筋前后（应力降幅、质量增量）
   ↓
输出          一个决策 + 两份可复算的报告
```

**判据（一个模板够不够"通用"）：**
- 输入只依赖**少数几何量 + 一个工况**，而不是任意物理设定；
- 输出是一个**决策**（要不要加筋 / 倒得出来吗 / 站得稳吗），不是一堆数字；
- 有**外部真值或可复算对照**（梁理论、静力平衡、Beverloo、解析解）；
- **自带改进动作**——这是"模板"区别于"求解器"的唯一标志。

### 25.4 候选模板（按通用度排序，待定）

| 模板 | 回答的决策 | 输入 | 内置对照 | 改进动作 | 现状 |
|---|---|---|---|---|---|
| **承力与加强** | 哪里会断？加筋够不够？ | 约束、载荷、材料 | 梁/板理论、网格无关性 | **加筋/圆角/加厚 → 复验** | ⚠️ 诊断半边已落地（`simulate_stress`，2026-10-19）；处方/复验的几何改写仍缺 |
| **容器与流体通断** | 装得下吗？倒得出来吗？有死区吗？ | 容器几何、液量、倾角/开口 | 静力平衡、质量守恒 | 改口径/加导流/改底形 | ⚠️ 内核有，物性缺（§24、`docs/archive/M4-M5-REVIEW.md`） |
| **机构能不能动** | 转得动吗？行程够吗？会卡吗？ | 驱动、行程、铰链 | 运动学包络 | 改连杆/加让位 | ✅ M3.6 |
| **稳定性** | 站得稳吗？多重才倒？ | 支撑面、重心、外载 | 静力倾覆平衡 | 加配重/加宽底面 | ⚠️ 部分 |
| **可制造与装配** | 打得出吗？装得上吗？ | 几何 | 壁厚/悬垂/干涉 | 改壁厚/加拔模 | ✅ M2 |
| **颗粒与堆积** | 卸得干净吗？会起拱吗？ | 料仓几何、粒径、摩擦 | **Beverloo 定律** | 改锥角/加流化 | ❌ 无 |
| **传热** | 会不会过热？要散热吗？ | 热源、材料、环境 | 热平衡、解析解 | 加散热片/开孔 | ❌ 无 |

**注意"通用度"与"我们现状"是两件事**：通用度最高的「承力与加强」曾长期是能力矩阵里
**完全没有**的一格。2026-10-19 起它的**诊断半边**有了载体：`simulate_stress`（体素 hex8
线弹性，2026-10-08 探针定的车道）——**但它只报它算得出的量**：积分量（反力/截面力与弯矩/
应变能）、热点区域（特征尺寸 ≥ 约 8 个单元时可信）、以及按声明深度采样并沿深度外推得到的
表面应力。"模型内最大单元应力"在曲边界上不收敛（1.002→1.184，①填充比加权实测不解决），
**因此不是结果**；安全系数同样不可报（各向同性模型看不见打印件的层间弱面）。**处方/复验的
几何自动改写**（加筋、圆角、加厚）仍未落地。详见 `docs/DECISION-LOG.md` 2026-10-19。

### 25.5 对接口形状的影响

若认同 §25.3，`simulate_*` 系列应从"给一堆参数"转为**"选模板 + 确认少数值"**：

```jsonc
simulate({ template: "reinforce-rib", geometry: {...},
           material: "steel-1045",            // 枚举，绝不让 LLM 填本构参数
           load: { endForceN: 500 },          // 只填量级，模板给默认与合理区间
           action: "add-rib" })
→ { whatWasSimulated: {...},                  // 回显：材料/工况/网格/无量纲数
    diagnosis: { resultants: {...}, hotSpots: [...], attention: { peaks, regions } },  // 没有 safetyFactor —— 见 §25.4 的边界
    validity: { gridConvergence, equilibrium, analyticComparison },
    afterAction: { maxStressMPa, massDeltaG },  // 处方复验
    warnings: [...] }
```

### 25.6 路线图修订：MPM 后置；自建工作区与 provenance 定为约定（2026-10-08）

**① MPM 的时机被判定为过早（用户明确承认是自己的判断失误）。**

用户原话："MPM 实际上对 LLM 并不友好，是早期的一个并不恰当的选择（不是不应该做，
而是放在大后期做），是我的错，必须承认。"

理由：MPM 的设定量最多（物性 + 声速/CFL + 网格无关性），而我们**连流体身份都没有**
（见 `docs/archive/M4-M5-REVIEW.md §7` 与 §24）。把它放在早期，导致在基础设施最薄弱的地方做
最难的事。**处置：MPM 降级为后期项**；已实现部分保留不删，但不再作为主线；
`§24` 的复核议程（工况表达、物性）随之排到后期。

**② 语料必须记 provenance（已定）。**

每条仿真结果都要标明它**是哪条路产生的**：预制工具 / LLM 自建脚本，以及用了什么
假设。没有它，就分不清一个坏结果是"我们的工具不行"还是"它自己的脚本不行"——
也就永远无法回答"基础设施有没有在挣它的钱"。

**③ `<cwd>/sim/` 为自建仿真工作区（已定）。**

工具与文档都承认它是 LLM 自建分析的**合法落点**。这条是 §25.2 要求 6
（不设读写障碍）的落地：沙箱写权限限于工作区，因此"拉电网"需要一个**明确的家**。
`<cwd>/sim/` 里的产物同样要按 ② 记 provenance。

**④ 首条模板线定为「承力与加强」，前置检查已完成。**

检查结论：**三个引擎一个都做不了静力应力**（Manifold 无物理 / rapier 刚体无内部应力 /
MPM 纯流体且无 F 路径）。但 `sdf.ts` 的**逐格体素化**（`solidMask` + `solidNormal` +
规则网格）恰好是 hex8 线弹性 FEM 所需的网格，绕开了体网格剖分与稀疏矩阵组装。
⇒ 走**小体素 FEM 车道**，第一条验证用**悬臂梁 vs 梁理论**。
详见 `docs/archive/M4-M5-REVIEW.md §7`。

---

### 25.7 注意力义务：检查/仿真工具**不许沉默**（承 HARNESS §11.14，2026-10-19）

HARNESS §11.14 已经把"注意力引导"定为**产出的义务**，判据是：把一条通过结论交给没见过这个
零件的人，他应当知道下一步去看哪里。对检查/仿真工具，这条推论出三条硬要求：

1. **每个 verdict/场都要带可疑位置**（坐标 + 为什么 + 一条可执行的观测命令）。只有整体结论
   等于把找缺陷的活退回给使用者。
2. **不许沉默**：工具算不出可信的量时，**不能返回空场**——空场读作"都没事"，那正是这条义务
   禁止的失败模式。此时必须交出它**已经知道的**几何嫌疑位置，并明确标注"这是几何，不是应力"。
   实测判例：`simulate_stress` 在玩具天平各件上必然认证不出热点（构件比体素薄），
   于是它回退调用 `scan_attention`，把再入角以 `geometry-suspects` 图层交出（v050 上给出
   4 处刀口根部，`severity: likely-defect`）——**这才是那 4 处 V 形缺口在注意力层面的解法**，
   与能不能算出 Kt 无关。
3. **图与 JSON 同源**：面板画的场与 LLM 读的摘要是同一个对象（§4 双通道；`attention` 契约）。

**检测 ≠ 交付（2026-10-19，用户提出，列为原则）。** 上面第 2 条要求"不许沉默"，但它**不能**
把检测信号混进交付判定。两者是两条通道，判据不同：

| | 通道 | 形态 | 允许的结论 |
|---|---|---|---|
| **检测** | `attention`（场 + 嫌疑位置 + 可执行观测） | 坐标、为什么可疑 | "去看这里" |
| **交付** | 判定 | **否决 / 困难 / 不排除可行** + 见证（规则、实测值、要求值、位置） | 只有三值，且**永不出现"ok / 安全"** |

- **否决**：有见证与要求矛盾（实测 vs 要求，带位置）。
- **困难**：上下界跨越要求线——余量落在**仪器的噪声**以内。对 `simulate_stress`，"噪声"就是
  跨分辨率差与声明距离的欠读；此时**必须报困难，不得放过**（承 DECISION-LOG 2026-10-11）。
- **不排除可行**：没有找到反例。**不是"通过"**。
- **无法判定**（`unevaluable`）：网格决定不了的数（例如构件比体素薄时给不出表面应力）。
  **缺一个数不等于"没有约束"。**

**因此**：几何嫌疑（再入角等）属于检测，**永不作为交付见证**——否则一个没有工况背书的尖角
就能"否决"一个零件；反过来，工具沉默是检测的失败，但"检测到了嫌疑"也不构成交付的失败。
`simulate_stress` 的 `delivery` 块由应力结果与声明材料生成，`stressDelivery()` 不接受任何
几何嫌疑作为输入（验收有一条源码断言守住这件事）。

**三类工具与两档交付触发（2026-10-19，用户拍板）。** 工具按**职责**分三类，按**交付触发**
分两档——两者是正交的，混在一起谈就会出现"哪些必须查"说不清的局面：

| 类别 | 职责 | 允许的结论 | 交付触发 |
|---|---|---|---|
| **交付工具** | gate | 否决 / 困难 / 不排除可行 + 见证 | **结果门**：必须跑且必须过（仅限**无需工况即可判定**的） |
| **风险工具** | 指向 | "去看这里" + 置信度 | **披露门**：必须跑过并**报出来**，**不要求干净** |
| **仪器工具** | 真值 | 数值 + 坐标 + 单位，既不 gate 也不指 | 不属交付（由 claim 决定是否被消费） |

**分档的判据只有一条：能否"无需工况"判定？** 能 → 可进结果门（机器强制）；不能（需声明工况，
或本身是启发式）→ 只能进披露门。**由此得到一个逆耳但必须承认的结论：FEM 永远不能当结果门**——
没有声明的工况就不存在，强行"交付时必跑"只会逼出假工况。它进披露门，且**是否必跑由交付主张
决定**（`strength` 主张需要一份引用最新版本的 stress run）。

**门只能断言它能见证的东西（三档）：**

| 门的见证能力 | 例 | 强制到哪 |
|---|---|---|
| **可判定** | 装配 hard 契约、打印 profile 的 excluded、`watertight`/单体 | **结果**：必须过 |
| **存在 + 新鲜** | 渲染图、运行记录、扫描记录 | 不许缺、不许旧（`evidence-predates-geometry` 已是实现）；**不判内容** |
| **判断类**（不可判定） | "看起来对不对""会不会先裂""审阅过了" | **只能登记主张**：必须指名产物与时点；缺席即缺口 |

因此 `delivery_audit` 接受**声明的 `claims`**（`strength` / `motion` / `assembly` /
`manufacturability` / `appearance` / `review`）：它不判断主张是否为真，只检查语料里有没有
该主张所需的、引用最新版本的**新鲜证据**，缺了就是 `claim-without-evidence`（blocked）。
不声明 claim 时它只审语料一致性，并显式报 `no-claims-declared`——**绿色语料不等于已交付**。

**判定词汇的单一来源（2026-10-20）。** 同一个三态在语料里曾有四个名字，管理因此无法用
一个键去问"有没有东西被否决"。现在权威定义在 `src/shared/judgement.ts`，各工具的 `verdict`
只作**展示**，**管理读 `judgement`**：

| 工具 | 旧值 | → 权威 |
|---|---|---|
| `delivery_audit` | `blocked` / `attention` / `ok` | `excluded` / `difficult` / `not-excluded`（**已改名**） |
| `check_printability` | `unprintable` / `check` / `ok` | 同上（**映射已就位，值待改名**） |
| `check_assembly` | `fail` / `check` / `ok` | 同上（**映射已就位，值待改名**） |
| `simulate_stress` | `overstressed` / `check` / `ok`（外加 `delivery` 已是权威值） | 同上 |

规则：**`info` 级发现不降级判定**（否则每个真实语料都变 `difficult`，信号就死了）；
未知的 legacy 词一律映射为 `difficult`——沉默不能被当成通过。
"值待改名"的两项属另一条线的面板与 README 文案，等它回来再动。

**风险图的归一化契约（2026-10-20，用户提出并拍板）。** 热点图**不是**把不同量纲融合成一个
数——是**提示风险**。观察到的规律是风险出现在**两端**，所以每一路检测器声明的变换是
**死区 + 双侧饱和**：

```
 u = -1              u = 0                      u = +1
<── 太薄 ──[ lo ──── 舒适区 ──── hi ]── 太厚 ──>
     scaleLo                        scaleHi
```

`u = −clamp((lo−v)/scaleLo)` / `0` / `+clamp((v−hi)/scaleHi)`，**单侧风险就是把区间开到
无穷**（应力 lo = −∞：低应力不是风险；钝角 hi = +∞：不尖不是风险）——这条正是防止
"把所有量都压进 [−1,1] 而误报良性低值"。之后 **|u| 无因次可比**，融合**不需要跨量纲权重**：

- 显示层：**max |u|**（最坏的检测器决定颜色）；
- 摘要：**count**（有几路 ≥0.5）——LLM 最需要的倾斜信号；
- **不做**加权总分、不做 `1−Π(1−|u|)`（无法提供依据 = 伪造置信度）；
- JSON 保留**带符号的 u** 与原始值（方向决定"加厚"还是"抽壳"），**图只画 |u|**——
  单层可切、不许覆盖单层的红。

壁厚是唯一默认**两侧**的一路（太薄强度、太厚缩痕/翘曲），上界由工艺声明；间隙/配合
同属两侧，但第一版不接（需要装配语境）。验收：`accept-analyze.mjs`（死区为 0、两侧与单侧、
饱和、融合=max+count、坏声明不静默给 0 分）。

**三个入口与两种读者（2026-10-20）。** 工具按组切开之后，日常只剩三个入口，原子工具留给深挖：

| 入口 | 回答 | 产出 | 会阻止吗 |
|---|---|---|---|
| `preflight` | 能不能交 | 逐步骤三值 + `unevaluable` + 未编排步骤的**原因**（worst-of-steps） | 可以（blocked） |
| `analyze` | 该往哪看 | `\|u\|` 风险图（壁厚/再入角/悬垂）+ 峰表 + `attention.json` 的 `fused` 层 | 永不 |
| `simulate_*` | 这种工况下会怎样 | 方向性读数 + 可靠性 + 证据（写 run，供 claim 检查） | 永不（由 `preflight` 判定） |

`analyze` **写 run（`kind:'analyze'`）并落 `attention.json`**，其 `samples.fused` 就是面板
`pickHeatLayer` 优先绘制的那一层——**同一次计算，两个读者**（LLM 读 `report.json` 的峰表，
人看 `ramp()` 的图）。`peaks` 与 `samples.fused` 共用同一批 bucket：两个投影，不是两次计算。

**交付纪律：不许静默等待（2026-10-21，用户提出）。** 出现过多次"跑一半停住、只能傻等"的情况，
这类工具不可交付。规则：① 每个外部步骤（worker op、装配检查、审计）都必须有**预算**；② 超预算
必须**报出来**（进入 `notRun` / `notMapped` / `unevaluable`，带原因），**不许吞**；③ 没人看着也要
能自己收场——脚本层加看门狗，超时打印最后一步并非零退出；④ 由此得到一条实际判据：**任何一步
超过 30 秒就按缺陷处理**，不要靠耐心。参考实现 `src/host/deadline.ts` 的 `withDeadline()`。
**并且**：`ensurePythonWorker()` 的子进程是 detached + 管道 stdio，**子进程句柄与管道会吊住父进程的
事件循环**——脚本干完活却不退出（实测：活 3 秒干完、进程静坐到外部 timeout 才被杀；「跑一半停了」
的真身就是这个）。修法：`child.unref()` + 三条 stdio `unref()` + `process.once('exit'/'SIGINT'/'SIGTERM')`
清理子进程组。**看门狗只能兜底，这类「干完了不退出」必须当成 bug 修，不能拿超时掩盖。**


**工具作用域与分组声明（2026-10-20）。** `tool-scope` 仍守一条不变量：**模块里不许出现工具名**
（花名册由注册推导，改名/新增不会静默漏掉）。分组表因此放在注册旁（`tool-groups.ts`），
由 `accept-tool-groups.mjs` 检查"每个注册工具都归了组"来防过期。声明有两个来源：
① `groups`（所有 CAD 会话）；② **`presetGroups`（preset id → 组，按会话）**——后者才是常用的，
因为它在切换 preset 时自动重算花名册（`agent-preset/selected` 本来就会重新 apply）。
**默认不声明 = 全量**：收窄必须显式，否则 skill 会变成"描述了一堆调不到的工具"的伪 API（§13.12）。

**现状（2026-10-19 实测）**：唯一的机器门是 `delivery_audit`；"必须看过装配渲染图、每个零件
都要跑 `check_printability`"过去只是 `generate_part` 输出里的一句散文义务。本次把
"每件都要有 printability"落成 `manufacturability` 主张的检查（缺件即 blocked）。

**由此得出的选型判据（写给未来的自己）**：评价一条力学车道的首要标准**不是**峰值精度，
而是**它能不能把注意力引到对的位置**。Kt 精度只在"已经指对了、现在要判够不够"时才是问题。
这解释了为什么体素车道（秒级、积分量准、能给 d_c 口径读数）配一次几何扫描，比追一条
高保真 FEM 车道更值。

---

## 26. 自带 Python 运行时：供给、工具与边界（v2.30，2026-10-08）

**一句话**：解释器与依赖是**插件供给的产物**，不是宿主机器的能力。决策与实测见
`docs/DECISION-LOG.md` 2026-10-08；规范与变量表见 `DESIGN.md §26 与 README.md`。

### 26.1 为什么不是"用系统的 Python"

目标机器上"有 Python"这件事不可靠：发行版 3.8~3.14 不等，PEP 668 禁止往系统解释器
装包，conda/pyenv 各有各的世界。而我们需要的是一套**确定的**解释器 + 依赖（含 abi3 的
rapier3d），否则同一个插件在不同机器上会跑出不同的数。所以：**把运行时当成版本化产物**，
用 python-build-standalone 的可重定位构建 + 带 hash 的依赖锁。

### 26.2 为什么供给发生在运行期

pnpm 11 默认拦下依赖构建脚本：postinstall 下载器会让 `dsh plugin install` 失败并把待批
脚本交给用户在插件页批准重试，取消还回滚 `package.json`。而**宿主代码不受工作区沙箱
限制、也不需要这道许可**。因此：

| `pythonRuntime` / `DSH_CAD_PYTHON` | 行为 |
|---|---|
| `auto`（默认） | 启动只做健康检查；首次 `run_python` 阻塞供给（带进度） |
| `eager` | 启动即后台预热（适合批量 Python 工作前的部署） |
| `off` | 完全不碰 Python（`run_python` 明确报错） |
| `system` | 用系统 CPython 3.10+（`DSH_CAD_PYTHON_BIN` 可指定），仍建自己的 venv |

### 26.3 链路与落点

```
python-lock.ts（生成物）          解释器归档名 + sha256（七平台）、依赖 wheel hash、索引表
  → 下载/校验 → 解包（纯 JS tar.gz）  $DSH_HOME/cad/runtime/cache、python/<版本>
  → python -m venv                   $DSH_HOME/cad/runtime/venv
  → pip install --require-hashes     $DSH_HOME/cad/runtime/requirements.lock（按目标裁剪）
  → 状态                              $DSH_HOME/cad/runtime/state.json
```

- **wheel 缓存在 runtime root 内**（`cache/pip`，`--cache-dir` 显式指定；v2.33 起取代
  `--no-cache-dir`）：重装/升级只重下锁里变化的包，缓存在 runtime root 内随其生死，
  不碰宿主 `~/.cache/pip`；`--require-hashes` 对缓存 wheel 逐个复验 hash，投毒过不了
  关。注意它**不加速单次冷装**（pip 无断点续传），救的是第二次以后。跨 HOME 共享缓存
  用 `DSH_CAD_PIP_CACHE_DIR`（验收脚本即指向仓库根被 ignore 的 `.tmp-pip-cache/`，
  只让第一轮付全价）。

- 生成器 `scripts/gen-python-lock.mjs` 从官方 `SHA256SUMS` 与 PyPI JSON 重算锁；`--check`
  供 CI 检漂移。**锁变了，venv marker 就对不上，自动重装**（`repair` 是显式入口）。
- **解包器自研**（`tar-extract.ts`）：不依赖系统 tar、不引 npm 依赖，拒绝绝对路径、
  `..` 越界与逃逸符号链接；实测 pbs 归档只含普通文件与符号链接两种成员，另带 9 个顶层
  LICENSE（**保留**，随解释器一起落盘——我们在再分发 CPython）。
- **平台矩阵**：linux gnu/musl × x64/arm64、darwin arm64/x64、win32-x64。Windows 用 pbs
  的 `install_only` 而不是官方 embeddable：后者没有 `venv`/`ensurepip`，要改 `._pth`，
  会把"一条代码路径"拆成两条。

### 26.4 工具面与用法

- **常驻 worker（batch 0，2026-10-08 落地）**：`python/cad_worker/worker.py` + 宿主侧
  `PythonWorker` / `ensurePythonWorker()`（单例、崩溃重启）。协议 `{id, op, params}` →
  `{id, ok, result|error+traceback}`，hello 带 `protocolVersion`；**大载荷走文件路径**
  （实测 1M float64 参数：inline 106 ms vs 文件 0.72 ms；100k×3 结果：JSON 98 ms /
  base64 16 ms / 文件 0.92 ms）。v1 ops：ping / versions / stl_stats / closest_points / crash。
  worker **单线程串行**（两个并发请求 = 串行和，实测 116 ms → 230 ms）——宿主必须把排队
  算进超时预算。验收 `scripts/accept-python-worker.mjs`：最近点结果与 TS 的 three-mesh-bvh
  **Δ=0**，kill 后能重启。
- **第一个迁移的工具：`measure_closest`（2026-10-08）。** 求解在 worker 的
  `closest_mesh_mesh` / `closest_mesh_sphere`；TS 侧只剩 schema、版本→路径、警告文案与
  标注渲染（渲染与附件是 ① 平台接线，不迁）。TS 的最近点实现保留为 **parity oracle**，
  由 `scripts/accept-measure-closest.mjs` 驱动：三组真实网格距离 **Δ=0**，解析真值
  （1 mm 间隙、4 mm 球间隙、吞面报 0）也命中。**耗时 0.89×/8.43×/0.98×**（剪枝前最坏 107×）。
  **行为上唯一的放松**：多个点并列取得最小值时返回其中任意一对（旧实现返回扫描序第一个）；
  最小值唯一时点对完全一致。`measure_closest` 因此需要一个可用的运行时——`DSH_CAD_PYTHON=off`
  会让它明确失败，而不是悄悄退回 TS。
- **第二个迁移的工具：`check_connectivity`（2026-10-08）。** worker 的 `connectivity` op：
  **按共享边**判连通（只共顶点算两块）、体序为 XY 包围盒面积降序（平局按首个三角形，与旧
  并查集顺序一致）、水密沿用 TS 的**严格**判据（每条有向边恰好一次且反向边存在）——
  没有换成 trimesh 宽松的 `is_watertight`；反证用例（绕向翻转的立方体）在
  `scripts/accept-connectivity-parity.mjs` 里显式断言了这个差异。耗时 0.68×–0.76×。
- **第三个迁移的工具：`validate_assembly`（2026-10-08）。** worker 的 `validate_assembly`
  op 逐行镜像 `solidify.ts`（1e-5 mm 取整焊接 → `Mesh.merge()` → Manifold；status 与
  体积是硬闸门，非实体/绕向反转一律拒绝）与 `validateAssembly`（交集定干涉、只有不接触的
  对才做 1200 三角形抽样距离）。parts 以**路径**进 worker，报告形状不变；
  `validateAssemblyInTs` 留作 parity oracle。**8 个用例全字段一致**（真实零件、rotate、
  matrix/pose、干涉、too_tight、非实体拒绝）。
- **worker 是子进程，生命周期归插件管**：`ctx.effect` 里注册 `resetPythonWorker()`，
  卸载即停。这不是理论担忧——迁移 `validate_assembly` 后 `accept-m2.mjs` 实测**挂住不退出**
  （worker 的 stdio 句柄让事件循环一直活着），验收脚本因此也要显式收尾。
- **第四个迁移的工具：`merge_parts`（2026-10-08）。** worker 的 `merge_solids` op 做 Manifold
  并集并**由 Python 写出合并后的 STL**（谁算谁交付），TS 侧只剩解析、provenance、渲染与存版。
  **两件并集与真实零件的 STL 逐字节相同**；三件带共面接触时仅三角形**顺序**不同（几何指纹与
  顶点集相同，已实测非我方代码所致）。踩坑记录：`np.unique` 返回排序后的唯一顶点，而 TS 按
  **首次出现**编号——顺序会传播到交付物，必须还原。
- **第五个迁移的工具：`measure_distance`（2026-10-08，批次 1 收尾）。** worker 的
  `measure_distance` op 做吸附（精确最近点 + 命中面法线定内外）、吸附距离与分量，并顺带回传
  **严格水密标志**（原先 TS 侧要为此单独解析一遍网格）。datum 解析与警告文案不变。
  **平局是平局**：立方体正中心到六面等距，两侧会取到不同的面——验收显式保留该用例并断言
  "吸附距离与内外判定一致、两点都在曲面上"，而不假装坐标必然相同。绝对耗时 0.6–3.0 ms
  （比值 5–8.7×，两边都亚毫秒，比值意义有限）。**批次 1 至此完成**。
- **批次 2 第一件：`import_part`（2026-10-08）。** worker 的 `import_mesh` op 承担解析
  （二进制/ASCII）、壳数、单位缩放、焊接、Manifold 实体判定与诊断，并**写出焊接缩放后的
  STL**（入版本库的东西）；TS 侧只剩路径/扩展名检查、sha256、unit 校验、datum 与存版。
  **这一件有意不留 TS oracle**：旧实现数了退化面却把计数丢掉（`degenerate: 0` 恒成立），
  留作 oracle 会把缺陷固化成契约；改用**解析真值**验收（20 mm 立方体 = 8000 mm³、
  1 inch = 25.4 且体积 ×25.4³、整机 710012.998 mm³ / 28830 面 / 26 壳）。
- **批次 2 收尾：SCAD 文本协议归 Python（2026-10-08）。** datum 预置（写方）、OpenSCAD
  输出的 ERROR/WARNING 与四种 datum echo（读方）、`// PARAMS` 约定都进了 worker
  （`scad_prelude` / `scad_parse_output` / `scad_parse_params`）。**留在 TS 的是 OpenSCAD
  进程与图片**（二进制发现、内置快照、xvfb、超时、附件、存版）——那是这台机器的工具链与
  平台服务（①），与"领域用 Python"无关。`render_part` 因此判定为 **① 平台系留**：领域内容
  只剩四行相机常量，搬过去只多一次往返而无领域收益。**批次 2 完成。**
- **批次 3 第一件：`simulate_physics`（2026-10-08，Q2=A）。** worker 的 `simulate_physics` op
  逐行镜像 `runPhysics`（世界/关节/接触采样/指标/关键帧/时间线），TS 侧只剩 schema、parts
  落盘与关键帧渲染。`runPhysicsInTs` 保留为 parity oracle，**也是 darwin-x64 的 canonical**
  （锁里没有该平台 wheel，必须明确走它而不是报错）。重新定基线按探针分层：解析量精确、
  定性判定一致、数值落带内、接触主导的只打印。**`accept-p2` / `accept-p3` /
  `accept-sim-verdict` 在 Python 侧重跑全过，未改阈值。**
  顺带发现一个真缺陷（未修）：TS 的碰撞事件从未开启 `ActiveEvents.COLLISION_EVENTS`，
  所以 `接触:` 关键帧标签是死代码；Python 侧照现状镜像，开启它属于行为变更。
- **批次 3 收尾：`simulate_motion`（2026-10-08）。** rapier 在机构仿真里只当**约束求解器**
  （无碰撞体、无重力），判定来自**精确 Manifold 干涉时间线**——两部分都进了 worker，
  TS 侧只剩 schema、parts 落盘与关键帧渲染。实测干涉计数逐位相同（0/0、25/25、49/49）、
  行程差 0.0000 mm、周期差 0.00000 s。**`accept-m36` 17/17 在 Python 侧重跑通过**（含负例）。
  **两个 API 陷阱记在这里以便后人**：Python 的 `RigidBodyBuilder.rotation()` 收的是
  **scaled-axis 向量**（不是四元数，也不是欧拉角），要走
  `Rotation3.from_quaternion(w,x,y,z).scaled_axis`（注意参数序 w,x,y,z）；
  `additional_mass_properties()` 只收**一个 `MassProperties` 对象**，而它只能用关键字构造。
  **批次 3 完成。**
- **`check_printability` 迁 Python，并修掉两个被暴露的真缺陷（2026-10-08）。** 悬垂面积是纯算术
  （逐位相同），壁厚是一次空间索引查询（实测 0.121 s/601 根，无②类负收益）。迁移过程中暴露：
  **① `buildMeshBvh` 会就地重排索引**，先建 BVH 再采样会让"每第 N 个面"随库的内部策略改变
  （真实件 647.6 vs 244.1 mm²）⇒ BVH 改用索引拷贝、采样固定解析序；
  **② `MeshBVH.raycast` 返回遍历序而非距离序**，原写法取"第一个 >0.075 的命中"会取到对面远壁，
  **低估薄壁**（真实件报 0.2mm，真值 0.026mm；薄壁 15 vs 34，暴力法确认）⇒ 两侧改为取最近命中。
  修完两侧逐位一致；修法只会更保守。
- **批次 4 第一半：MLS-MPM 流体内核迁 Python（2026-10-12）。** 按用户裁决接受慢
  （实测小世界 **4.7–6.3×**，此前基准 2.5–4×），原生上限比 TS 快 3.7–4.6× ⇒ 工具层接线时
  加"后续 Rust/C 加速"标记。worker 出 `mpm_create/step/state/destroy`，**状态按 id 留在 worker**
  （564k 粒子 = 15 MB，不搬 IPC）；调用方交一次种子、之后只问统计量。**parity**：标定密度
  Δrel 7.6e-8、总动量/位置和 Δrel 1e-8~1e-7、**40 步后逐粒子 max|Δpos| 4.9e-6 mm**
  （只差 float64 求和顺序）、逃逸/回收/入口计数一致且入口确实驱动流动。
  工具层（`fluid.ts` 的投影/回流守恒审计、时均分速、渲染帧）与 `accept-m4` 24/24 重跑待做。
- **`simulate_fluid` 运行环接线与一个未关闭的缺陷（2026-10-12）。** 运行环（驱动 + SDF 投影 +
  守恒审计 + 快照）已进 worker：SDF/种子/快照按**二进制文件**交换（564k 粒子时种子 13.5 MB、
  单张快照 6.8 MB）。结果：**内核忠实**（parity + 跨密度纯内核检查每位相同），**低密度场景对**
  （case 1 到达率 0.705 vs TS 0.72），但**高密度系统性输运不足**（38,394 粒子 0.098 vs TS 0.8643；
  90° 弯管 0.12 vs 0.63），而 TS 对种子密度 ±1% 完全不敏感 ⇒ 不是混沌抽样。运行环里唯一未被
  内核 parity 覆盖的是 **SDF 投影** ⇒ 下一步先禁用投影二分。**处置：不发布**——
  `DSH_CAD_FLUID_PYTHON=1` 才走 Python，默认仍是 TS canonical（`accept-m4` 全过）。
  **性能实测 7.2×**（超出批准的 2.5–4×；瓶颈是内核内存流量而非调用次数）⇒ 原生内核
  （比 TS 快 3.7–4.6×）成为该工具的实际必需项。
- **该缺陷已定位并修复（2026-10-12）：根因是 SDF 的 `solidMask/solidNormal` 从未装进 MPM 世界**，
  于是整场运行**没有任何壁面边界条件**（网格更新不归零壁面法向速度、G2P 不排除壁面格），
  流体漏进壁里 —— 低密度时投影还能兜住，高密度时彻底失控（50k 管流到达率 0.098 vs TS 0.8643）。
  修后 `accept-m4` 在**默认 Python 路径**下全过（case1 0.7968／case1b 0.8488／密封腔 2.2mm/s／
  弯管 0.7054）。**三条教训值得记住**：① 内核级 parity 未覆盖实体掩码，逐特性二分才是定位手段；
  ② **不变量是必要不充分**——"根本没有墙"时穿透/守恒/不分叉全都成立，只有**输运量断言**抓得住；
  ③ **JSON 管线没有 typed array**，`Uint8Array` 过管道变成 `{...}`，边界必须显式还原（`_ipc_uint8`）。
- **第二个差异仍未关闭（2026-10-12 第二轮）。** 掩码修好后 `accept-m4` 在 Python 路径**全过**，
  但 `accept-fluid-sign`（厚壁腔）在**硬不变量**上分歧：Python 末态有 **167(Ø60)/888(Ø100)** 个粒子
  在壁内 >0.3mm（TS 为 0），active 多 20%、平均速率高 2×，而两侧 `diverged=false`（不是 NaN 掩盖）。
  **穿透是硬不变量，不能用重定阈值绕过**。⇒ `runFluid` **默认仍走 TS canonical**
  （`DSH_CAD_FLUID_PYTHON=1` 才走 Python）。下一步：统计这些粒子的**穿透深度分布**，
  判断是投影后置条件问题（0.3–0.5mm 聚集在 0.15·dx 余量附近）还是从 ±5mm 近表面带之外进入。
  **诊断结果（2026-10-12 第三轮）**：穿透粒子深度 **-0.32~-1.00 mm**、**全部在 ±5mm 投影带内**
  （`outsideBand=0`）、**梯度非零**（|∇d|≈1/mm、`gradZero=0`）、投影**确实在场且大量生效**
  （600 次调用移动 278,692/676,630 个粒子次）⇒ 不是"带外进入"也不是"推不动"。
  只剩两种可能：**投影后置条件不成立**（推后仍在内）或**末态采样/活动集合不一致**。
  插桩点已定：只对**最后一次**投影记录 `inside` 数、推后深度、推后仍在内的个数。
  诊断开关全部环境变量门控、不进工具 schema。
  **根因（2026-10-12 第四轮，已修）**：不是后置条件也不是采样，而是**上一轮为防负下标加的投影箱体夹紧**——
  投影把粒子沿外法线推出壁面后部分越出箱体，夹紧把它们拉回**箱面**，而对"外表面贴近网格边界"的管件
  **箱面就在壁里** ⇒ 末态出现 ~0.9mm 的一层"壁内粒子"。删除该夹紧（越界交由 `_mpm_step_once` 的
  **模板基点夹紧**处理）后 Ø60/Ø100 穿透 **167/888 → 0/0**，`accept-fluid-sign` 14/16 → **15/16**、
  `accept-m4` **24/24**。**教训**：防御性夹紧要夹在**索引**上而不是**状态**上；诊断读数必须与指标读数
  **用同一校验和对照**，否则会把"读数时机不同"误判成"物理不同"。
  **唯一剩余**：`accept-fluid-sign` 的"不同壁厚到达率跨度 <0.15"（Python 0.1815 vs TS 0.0829）——
  统计型断言，改阈值需用户确认 ⇒ **工具默认仍走 TS canonical**（`DSH_CAD_FLUID_PYTHON=1` 走 Python）。
  **再定位（2026-10-12）**：① TS 对该场景**稳定**——种子密度 ±1.7% 扰动下 Ø100 到达率
  0.6739/0.6998/0.6939（跨度 0.026），而 Python 是 0.544 ⇒ **超出引擎自然散布，不是抽样噪声**；
  ② **关掉 SDF 投影后两侧一致**（0.3015/18805/19.6 vs 0.3093/18597/18.9）⇒ 内核、壁面 BC、
  入口/出口规则**已证明等价**，差异**只在投影效果**；③ 开投影时 Python 末态平均速率 63.7 vs TS 22.5
  ⇒ **Python 的投影少杀了法向速度**。下一步：给"投影每步移除的速度量"插桩与 TS 对拍。
  **不采用"重定阈值"**——那会掩盖一个真实差异。
  **根因找到并修复（2026-10-12 第五轮）：不是逻辑错误，是数值 dtype。** 两侧计数器在**步数 10/30 逐位相同**
  （入口 band/floored/injected、投影 inside/killed、avgV），约 100 步开始分叉，600 步差到 0.674 vs 0.544；
  **去掉入口后 600 步又一致**（0.5018 vs 0.5226）⇒ 放大器是"**投影 × 入口速度下限**"的正反馈，
  种子是**我的 float64 状态与 TS 的 `Float32Array` 每步 ~1e-6 的差**。改成 float32 后差异落到带内，
  **`accept-fluid-sign` 在 Python 路径 16/16 通过**。同一次重写还解决了内存与性能：**峰值 941 MB → 229 MB**
  （564k 粒子；状态只有 68 MB，其余全是不必要的临时数组）、**7.2× → 4.22×**，
  逐粒子漂移 9.8e-6 → **1.9e-6 格**。**simulate_fluid 现为 Python canonical**（`DSH_CAD_FLUID_PYTHON=0` 回 TS oracle）。
  做法：float32 状态 + 每世界复用 scratch + 按轴 (n,) 散射（不造 (n,3) 索引）+ 秩 1 累加（不造 (n,3,3)）。
  **"f64 是否更准确"的实测回答（2026-10-12）**：**否——更精确，但不是更准确**。三项测量（同一 Ø100 场景）：
  ① 同引擎细化 dt（0.004→0.002→0.001，步数同步加倍）：到达率 **0.674→0.758→0.797**、跨度 **0.123**
  且单调收敛 ⇒ **dt=0.004 下时间离散误差就有 ~0.12**，比 f32 舍入（~1e-7 相对）高 8 个数量级；
  ② 相干输入扰动（抖动幅度改到 2.5e-2 相对 ≈ 1e-3 mm 位置）：跨度仅 **0.017**；
  ③ 把算术改成 float64（存储仍 float32）：Ø100 到达 0.534、验收跨度 **0.190 → 失败**（阈值 0.15）。
  ⇒ 0.534/0.544/0.674 是**同一未收敛格式的三种实现**，真值（dt→0）约 0.80，三者都没到；
  系统对**非相干逐格舍入噪声**敏感（混沌 + 刚性 EOS + 投影×入口正反馈），**加位数不能消除**。
  因此 **dtype 是"保真"选择而非精度排名**（迁移契约=与现役行为一致）；要提高可信度应**细化 dt/dx**
  或**削掉放大器**，而不是换 dtype。诊断钩子：`CAD_MPM_JITTER_AMP`、`CAD_FLUID_DT`。
- `run_python`：`code`（内联）或 `script`（既有 .py 文件，相对项目目录），可选 `args` /
  `cwd` / `timeoutSec`（默认 120s，上限 600s）。返回 stdout/stderr 与**完整 traceback**，
  失败时把 `traceback` 单独给出——这正是 2026-09-28 试探 python-engine 时认定的核心收益。
  它与常驻 worker 是**同一接线点上的两种形态**：`run_python` 是"跑一段任意代码"的开放场地
  （一次性进程，无残留状态），worker 是迁移后的工具使用的常驻后端。
- `python_runtime`：`status`（是否就绪、路径、来源、占用、上次错误）/ `provision`（现在装）
  / `repair`（重建依赖环境）。冷启动看起来像"卡住"是最糟的体验，所以进度与状态都是一等输出。
- 两者与其余 CAD 工具同受预设可见性过滤（非 CAD 会话看不到），避免给纯编码会话增加 schema。

### 26.5 边界（明确不做的）

- **不是沙箱**：子进程以宿主用户身份运行，文件访问与 `bash` 同级。本插件的主张是**可复现**，
  不是隔离；把它说成沙箱才是真的撒谎。
- **§12.3 的常驻 worker 尚未实现**：v1 每次调用一个全新进程（无残留状态、超时可靠、
  traceback 干净）。领域 worker（几何/仿真库的常驻进程 + JSON-lines）后续挂在同一接线点旁。
- **rapier3d 无 darwin-x64 wheel → 该平台物理继续用 TS**（用户 2026-10-08 拍板）。
  锁里 `# cad-exclude: darwin-x64 | <原因>` 裁剪该块，**原因随包走**：写进
  `state.json.skipped`，由 `python_runtime` 明确报出（"没有 wheel，物理留在 TS canonical"）。
  这是**安装期确认**，不是静默缺包——静默缺包会让模型把"平台差异"读成"库坏了"。
- **离线/内网**：可用 `DSH_CAD_PYTHON_INDEX_URL` 指向内网索引；整仓离线镜像（wheelhouse）
  尚未做，需要时再加 `--find-links` 通道。

### 26.6 实测与验收

本机（Arch Linux）实测：归档 33.4MiB / 展开 105MB / 下载 3.5s；八个依赖全部命中预编译
wheel（`cp313-*-manylinux_2_27_x86_64`、`py3-none-any`、`cp39-abi3`），**不需要编译器**；
冷启动（下载归档 + 装约 230MB 依赖）**353–476 秒**，venv 就绪后总占用 **381–383 MiB**；
默认 PyPI 直连同一批依赖 **11m44s** → 索引默认带镜像兜底（同日实测：npmmirror 的 PyPI
路径 404、TUNA 403、阿里云索引可用）。

```bash
node dsh-cad-harness/scripts/accept-python.mjs          # 全量：锁 / 解包器 / 真实供给 / 执行 / 开关
node dsh-cad-harness/scripts/accept-python.mjs --quick  # 跳过网络段
```

## 27. 工艺档案与判定层：阈值是带出处的声明，判定只做否决（v2.31，2026-10-11）

**一句话**：制造可行性不再由工具里写死的阈值判定，而由**声明出来的工艺档案**判定；工具对每个档案
只能给 `excluded`（带反例）或 `not-excluded`，**永不排序、永不推荐**，并且**未排除不等于能做出**。
决策与依据见 `docs/DECISION-LOG.md` 2026-10-11 各条；实验数据见
`experiments/20261011_void_reachability_and_draft_cone.md`。

### 27.1 问题：一个没有作者的阈值会塑造设计

起因是 `examples/multirotor-propeller/`：叶片后缘被**加厚**，只为了满足工具里写死的
`wallMinMm = 1.2`。那条阈值来自 FDM/PLA 的一个具体机器与喷嘴，**却对一个手板件、一件 SLS 件、
一件注塑件施加了同样的约束**，而且没有人能指出它是谁定的、依据什么。一个查不到作者的阈值
**无法被质疑**，于是它静静地决定了零件形状。

### 27.2 档案是契约

`dsh-cad-harness/schemas/process-profile.schema.json`：一份档案声明工艺（`FDM | SLA | SLS | MJF |
injection | CNC-3axis/4axis/5axis | casting`）、材料，以及**每条规则**的四件事——
`applies`（这条规则管不管这个工艺，不管要写原因）、`decidable`（工具能不能从网格判定）、
`value`、`source`（出处：`measured > vendor-spec > standard > literature > rule-of-thumb > assumed`）。
工具用 `profileIds: ["fdm-pla-0.4"]` 或 `profilesJson` 接收；**非法档案当场拒绝并点名出错规则**
（不修补、不部分应用）。

**没声明档案时不静默套默认**：使用内建兜底档（其每个数都是 `assumed`），在 `profileSource` 与
findings 里**点名并附内容 hash**，且把 `ok` **降级为 `check`** —— `ok` 会声称"通过了调用者
从未指名的工艺"。**声明档案才是拿到通过的方式**；档案 id + 内容 hash 随判定返回。

### 27.3 四条不可协商（都在代码里执行，不是承诺）

1. **两值判定**：`excluded`（带反例：规则 + 位置 + 测量值 vs 要求值）或 `not-excluded`。
   **`not-excluded` 的含义是"没有找到几何反例"，不是"能做出来"。**
2. **永不推荐**：无排序、无打分、无 `recommended` 字段；schema 层面就拒绝这类字段。
   成本、良率、交期、可达公差不是几何事实。
3. **不适用要说出来**：粉末床与机加工没有悬垂约束、只有注塑有拔模。把 SLS 件的悬垂报成
   "需要支撑"不是保守，是**错的**。每条规则带 `applies` + 原因，报告列出。
4. **缺项不是"无约束"**：未声明的规则进 `unevaluable`；工具判不了的能力项（公差、表面粗糙度）
   同样进 `unevaluable`。

### 27.4 余量纪律

阈值类判定**必须报告余量**，不给裸标志。三条带，带宽来自**测量自身的分辨率**（不引入自编工艺常数）：

| 带 | 条件 | 判定 |
| --- | --- | --- |
| 1 | `测量值 < 要求 − 分辨率` | **排除**（反例） |
| 2 | `\|测量值 − 要求\| ≤ 分辨率` | **未排除 + 记为困难**（含两个数字） |
| 3 | `测量值 > 要求 + 分辨率` | 不报 |

分辨率按规则取：壁厚取抽样步长、圆孔取**圆度拟合残差**、拔模取**法线分桶宽度**。理由：在
±1 分辨率内**测量本身没有资格**断言"放得下"或"放不下"，记困难是唯一诚实的说法；排除只在
缺口超出噪声时才下（与"证明用于否决、估计用于放行"一致）。

### 27.5 已实现的规则，以及每条**能证明什么**

| 规则 | 可判部分 | 不可判部分（明说） |
| --- | --- | --- |
| `wallMinMm` / `overhangDeg` | 壁厚（抽样射线，`wallMeasured` 门禁：未测到永不返回 ok）；悬垂面积（全三角形精确） | 抽样漏掉的细特征 |
| `escapePassageMinMm` | **封闭内腔**（壳的带符号体积为负 ⇒ 通道尺寸 0，精确）；**圆孔且贯通**的通道（直径精确） | 盲特征（是否积住不是几何事实）、非圆截面通道 |
| `draftMinDeg` | **可行抽芯方向锥为空**（盖交的完备判定：2k 盖心 + O(k²) 边界圆交点） | 锥非空时的采样锥宽是估计（判定用枚举，报告用采样） |
| `toolRadiusMm` / `holeAspectMax` | 圆孔的直径与深径比（精确） | 非圆槽/窄凹腔（需体素可达性，未接线） |

**"先问哪一侧可证"**：壁厚/窄槽类**否决**可证；通道类若按路径判定则**放行**可证、否决不可证；
拔模的空锥可证。判断哪一侧便宜，就决定了工具能诚实主张什么（DECISION-LOG 同日条目）。

### 27.6 代码落点与验收

- 契约与判定推导：`src/host/process-profile.ts`（验证 / 内容 hash / `notApplicable`+`unevaluable`
  推导 / 内建兜底档）；schema 与示例：`schemas/process-profile.schema.json`、`schemas/examples/`。
- 工具接线：`src/host/tools.ts` 的 `check_printability`（`profileIds`/`profilesJson`、
  `profileSource`、`profiles[]` 两值判定、反例与披露）。
- 几何引擎：`python/cad_worker/worker.py` 的 `op_check_printability`（含 `draft` 块）、
  `op_connectivity`（`voids`）、`op_void_reach`（**已实现未接线**）。
- 验收：`accept-process-profiles` 27/27、`accept-p3` 89/89、`accept-printability-parity` 45/45、
  `accept-connectivity` 12/12 与 `accept-connectivity-parity` 21/21。
- 文档：`skills/cad-manufacturing/SKILL.md` 写清档案契约、四种规则与**如何撰写档案**
  （出处的信任阶梯、草稿是有名字的假设、用即验证、阶梯试件标定、每个反例都要解释）。

## 28. CAD 导入扩到 STEP/DXF：trimesh + cascadio + ezdxf（v2.32，2026-10-15）

> 用户拍板（对比 cadaclysm / ezdxf / trimesh 组合后指示"实现到我们的插件中去"）。
> 决策与依赖论证：`docs/DECISION-LOG.md` 2026-10-15；探针：
> `experiments/20261015_cad_import_probe.md`。本节只记**当前有效的设计**。

### 28.1 格式矩阵（当前有效）

| 格式 | 读取链路 | 单位政策 | 验收 |
|---|---|---|---|
| `.stl`（二进制/ASCII） | 原路不变：worker `_parse_stl_raw` → weld | 调用方声明（mm/cm/m/inch ×scale） | `accept-import.mjs` |
| `.step/.stp` | `cascadio.step_to_glb`（OpenCASCADE）→ trimesh 载 GLB → 三角形汤 | **文件自带**；GLB 中间格式声明米 → worker ×1000 落 mm；`unit` 参数仅接受 mm/缺省（违反拒收），`scale` 照常叠加 | `accept-import-cad.mjs` 1–3 |
| `.dxf` | ezdxf（recover 模式）：3D 网格实体原样；否则 2D 闭环轮廓 → manifold3d `CrossSection`(EvenOdd) `extrude(depthMm)` | `$INSUNITS` 优先（{1,2,3,4,5,6,7} 有映射）；无/未知 → 按调用方单位并告警；`depthMm` 以 mm 计 | `accept-import-cad.mjs` 4–7 |
| `.iges/.igs/.brep` | **无读取器**：cascadio 0.1.1 对 IGES 静默失败（不写输出，探针实测） | — | 边界消息 `accept-import.mjs` 9a |

三条新链路全部汇入既有尾流：**weld（1e-5 量化）→ scale 一次 → Manifold 判定 → 写
`model.stl`**。版本库与下游 11 个工具零改动——这是"导入=一个版本"原则（§7.3）的延续。

### 28.2 关键事实（都有数字）

- colored.step（FreeCAD 导出）→ 242.2 mm³、genus 0、43ms；multibody.step →
  **10 体 / 263544.1 mm³ / genus 12**；全部 Manifold NoError。
- `tol_linear` 公差扫描：默认 ≈0.01 → 3074 三角形；0.002 → 12254；体积收敛差
  <0.3%。`tolLinear/tolAngular` 经 `import_mesh` 参数透传。
- DXF 40×40 方 + r6 孔 + `depthMm=10` → 14870.5 mm³（理论 14869.3）、genus 1、6ms；
  `$INSUNITS=1`（英寸）文件读出 ×25.4 换算系数。
- **cascadio 对读不了的文件不抛异常**（IGES：stderr 一行 OCCT 错误、无输出文件）→
  worker 以"输出不存在"判失败，TS 层保留 IGES 边界消息。

### 28.3 代码落点

- `python/cad_worker/worker.py`：`_load_step_soup` / `_load_dxf_soup` /
  `_DXF_INSUNITS_TO_MM`；`op_import_mesh` 按扩展名分派；`op_versions` 增
  cascadio/ezdxf。`EZDXF_CONFIG_DIR` 指向 scratch（容器无 `~/.cache` 消音）。
- `src/host/import.ts`：`SUPPORTED_EXTENSIONS = [.stl, .step, .stp, .dxf]`；
  STEP 的 unit 拒收逻辑；`depthMm` 通道；worker warnings 并入。
- `src/host/tools.ts`：`import_part` 增 `depthMm` 参数；描述与 output.format 枚举。
- 锁：`cascadio==0.1.1`（**钉版**——上游会删 PyPI 旧版；exclude musl）+
  `ezdxf==1.4.4`（传递依赖全部已在锁内）。
- 验收样本：`scripts/fixtures/cad-import/`（来源与基线见其 README）。


## 29. 通用 CFD 车道：XLB LBM 引擎 + `simulate_lbm`（v2.33，2026-10-15）

**决策链**：SU2 预编译捆绑（同日晨）→ 实跑 probe 暴露"配置面考古成本 + v7 文档 vs v8
二进制漂移"，与"LLM 能力"维度冲突 → 用户审阅后改道**双轨 LBM**（DECISION-LOG
2026-10-15 两条：改道条目 + shim 定稿补记）。Lethe（无预编译发行，deal.II 源码 4-6h）
出局；Code_Saturne（无任何预编译渠道）与 OpenFOAM（GPL-3 + Arch 无包）降为
"系统自装 + 子进程"将来分支；FluidX3D（MIT，自由液面/多相）留作阶段 B。

**引擎车道**（对齐 numba 采纳模式）：
- 依赖：`xlb==0.3.1`（Apache-2.0，纯 py）+ `warp-lang==1.12.1`（**钉版**——1.18 移除
  `warp.utils.ScopedTimer` 炸 import）+ `jax/jaxlib==0.11.2` + 完整传递闭包共 43 包进
  hash 锁；musl×2 与 darwin-x64 按 wheel 实际覆盖 cad-exclude（jaxlib/warp 无
  musl/darwin-x64 wheel）。闭包解析用锁约束下 `pip install --dry-run --report`，
  首装曾暴露 `opt_einsum`/`attrs` 漏钉——闭包比对必须跑（`closure.txt` ↔ lock）。
- worker：`python/cad_worker/lbm_xlb.py`（引擎模块，显式路径加载对齐 `_load_mpm_numba`）
  + `worker.lbm_channel` op；门控 `CAD_LBM_ENGINE`（`off` 响亮拒绝；无回退引擎，
  不可用即响亮 ok:false）。
- **三处上游规避（全部有验收断言看护）**：
  1. warp 钉版（锁内，无需运行时代码）；
  2. `check_bc_overlaps` 的 `list += ndarray` 写法被 numpy 2.5 语义变化炸穿 →
     extend 版替换，打在 `xlb.helper` 与 stepper 模块两个绑定名；
  3. ZouHeBC `prescribed_values` 从未赋值（上游 main 已修：`prescribed_values =
     profile()`）→ wrapper 同语句镜像；**修复探测器**：引擎上报
     `upstreamZouheFixed`，验收断言其 `false`——上游修复发版之日断言变红，
     提示升级撤 shim。
- numpy 2.5 的 `list += ndarray` 语义变化是**插件级环境发现**：worker 89 处 `+=`
  全量排查无罪（experiments/20261015_xlb_lbm_probe.md），编码规范进评审关注项。

**工具面**：`simulate_lbm`（tools.ts，窄 schema 对齐 simulate_fluid 输出形态
`overallStatus + metrics`）：`cells / reynolds / latticeVelocity / steps` 四参，
`overallStatus` 按 Poiseuille 峰值发展比（developed ≥0.9 / developing ≥0.6 /
underdeveloped / diverged）；finalizeContent 报峰值 vs 理论 1.5U、镜像对称、入口。
Skill 两层同步：cad-toolbox 路由表 + Discipline 注意事项；cad-simulation 深度节
（lattice units 换算归 LLM 声明、发展长度随 Re、阶段 A 无嵌固件）。

**验收**：`scripts/accept-lbm-channel.mjs` 11/11——xlb 报告、冒烟稳定、确定性逐位一致、
Poiseuille 发展带（基线 0.753，阈值 [0.60,0.95]）、镜像对称 0.00%、入口生效、
修复探测器 false、`off` 门控响亮。性能 **2.06 ms/步 @ 48×24×24（CPU）**。

**边界与后续**：阶段 A 只做盒子通道（无嵌固件/热/多相）；**阶段 B（FluidX3D，自由液面/
多相）冻结——仅在必要场景出现时解冻**（2026-10-15 用户拍板）；SU2 留作高 Re RANS/
可压缩将来分支（probe 产物存 `experiments/artifacts/20261015_cfd_probe/`）。上游追踪：
xlb 发版（携 ZouHe 修复与 PR #168 warp 升级）→ 升级撤双 shim（验收探测器自动提醒）。

**镜像策略（用户拍板 2026-10-15）**：pip 索引**阿里云优先**（`PIP_INDEXES` 翻转，
pypi.org 降为兜底）——实测 pypi.org 的 files 通道对大闭包会拖 16 分钟以上甚至无限
停滞且不触发轮内失败转移，aliyun 同闭包数分钟完成；`DSH_CAD_PYTHON_INDEX_URL`
单源覆盖机制保留。解释器工件仍走 github + npmmirror（aliyun 无此镜像）。

---

## 30. 人的通道：面板与图像纪律（承 HARNESS §4，2026-10-16 迁入）

> 本节是**当前有效的设计纪律**。原在 `HARNESS.md` §4 的实机踩坑叙事（四条静默失败的
> 复盘）已迁入 `docs/DECISION-LOG.md` 2026-10-01 补记；此处只留结论与可验收的判据。

**30.1 总原则**：**人指 WHAT、引擎算 WHERE、真值随产物流转**。

**30.2 界面打扰**：面板**不因界面加载而自动弹出**——自动唤起只由**明确相关的事件**触发
（本插件 = 会话出现 CAD 工具活动，即新版本产生），其余时候靠右栏 Tab 单击激活。理由是插件
可能被装在通用工作区，启动即弹模型预览是噪声。区分"加载即弹"（禁）与"相关事件即弹"（可）。

**30.3 面板布局**：视觉是一等公民，**模型预览必须占据首屏与最大面积**——视口置顶、吃掉
所有余量（`aspect-ratio:1` 只作下限）；版本历史、参数、验证报告、导出折进一行式折叠区
（默认收起）；底部允许一条 11px 单行状态带（结论 + 版本序号 + 出处）。空间不够时让路顺序
是**先滚折叠区、再缩视口**。几何纪律：**视口变高不等于模型变大**（取景由短边决定），所以
"比正方形矮"必须避免，"比正方形高"是白得的。实测见 §6.9/§6.10（v2.14b）。

**30.4 零件从命名起就是版本控制对象**：不是"先做出零件、事后套版本"，而是**零件 = 版本
库**——零件是仓库（可空存在）、版本是不可变提交（父子限同零件并校验）、运行是 CI 结果
（挂版本上、可跨零件）。**身份靠显式声明而不是推断**（实测 33 个版本里 32 个无 parent、
同一零件被造成 5 个互不相干的根，任何文本/链式推断都会把"同零件换参数"与"不同零件"混为
一谈）。缺 HEAD/回滚/审批，所以面板上的「跟随最新/已钉住」只是视图偏好，别当模型状态。

**30.5 光照是"看"的一部分**：视口的职责是让人**看清形状**，形状靠明暗变化。两条硬判据：
① **主光必须跟着相机**（三点光挂在相机上）——世界固定的主光意味着转到背面就白转；
② **环境光不能吃掉明暗**——环境占比 33% → 8%（key 2.4 / fill 0.5 / rim 0.85 / 半球 0.24），
正对光与背对光的对比 3× → 11×，另加胶片式高光收束。判据可在**没有 GPU 的地方**验证为场景图
性质（`scripts/accept-lighting.mjs`）；像素面靠 `sandbox/preview/shot-gl.mjs`（Xvfb +
llvmpipe；本机 `firefox --headless` 建不出 WebGL 上下文）。

**30.6 背景也让人自己选**：**零件与底色的明度差**决定读不读得出形——亮底（纸白 243）轮廓
清楚、形体发闷；暗底（石墨 65 / 深蓝 38）亮面跳出来。两种都对，用途不同，所以给**四个预设
让人选**（纸白 / 暖灰 / 石墨 / 深蓝，选择记进 localStorage），不替人决定。配套两条工程约束：
① **覆盖层必须随底反色**（标尺与读数是 DOM；WCAG 对比度 ≥3:1，实测 9.0~13.4:1）；
② **切换只改一个属性，不重建场景**（`scene.background = …`）。控件位置定死在视口右上角
「复原」旁边的一个小色块，**不加第六个工具 chip**。

**30.7 控件坐标系由父级决定**：绝对定位元素必须挂在它坐标所相对的那个容器里；本插件最终走
overlay 的 `chrome` 槽，与「复原」同一坐标系。挂完**用 DOM 探针报坐标，不要在截图里找**。
搬 JSX 的大段 `React.createElement` 括号**先 `tsc` 再看逻辑**。

**30.8 同角落控件必须同款**：共用同一套底盘（白板 + `1px #d5d9dd` + `11px/16px`，与「复原」
逐字段一致），图标家族也一致（`⤾ 复原` / `🎨 背景`）；色块本身当图标在浅底上读作"没勾的
复选框"，弃用。

**30.9 视口必须自带度量与方位**：任何 3D 视口要能回答"这有多大"（标尺）与"这是哪个方向"
（三轴），并配**复原视图**。角标位置固定：**坐标系左下、标尺右下**。实现走 DOM 角标（每帧
读活相机），不画进 WebGL——不被模型裁切、四视图复用、且无头浏览器能直接截到。

**30.10 图像只有一条正路进上下文**：图像**不许**以 base64 或 data URI 写进文本，也**不许**
把"复制到剪贴板、请用户自己粘"当作唯一路径。两个方向，且**上下文里永远只有引用、字节走
附件通道**：

| 谁产图 | 走哪条 | 关键调用 |
|---|---|---|
| 宿主工具（渲染图、求解标注图） | 工具结果的 `content` 里带 `ImageBlock` | `ctx.attachments.saveImages([{ data, mediaType, name }])` → `output.render(args, value)` / `finalizeContent(exec, result)` |
| 浏览器面板（视口截图） | 直接发进会话 | `sessions.scope(id)` → `sessions.sessionOf(actx)` → `conversation.createDrafts(id, [file])` → `conversation.sendSession(face, text, ids, 'queue')` |

三个易被"某处看到的示例"带偏的幻觉（对着 0.1.5-rc.3 的类型声明与打包产物核过）：
`ctx.attachments.create({data, mimeType})` **不存在**（真名 `saveImage`/`saveImages`，字段是
`mediaType`）；工具结果**没有** `attachments:` 字段；图像**不会**被框架自动加入。
**交付任何图像功能前先问一句：模型下一回合真的能看到它吗？答不上来就是没做完。**

**30.11 图片会累积，所以必须修枝**：会话每步重发全史，而每轮 `generate_part` 带 4 张图 →
图片数单调累积（实测峰值 88 张/请求 ≈ 88k 图片 token）。规则五条：
1. **保留窗口写死，不做启发式**：最新 6 轮（24 张），一次丢 2 轮（量子 8）→ 在飞 17..24 张；
   量子存在的意义是**前缀稳定一段**，provider 前缀缓存不被每步打断。
2. **只投影请求，不改日志，也不改界面**：`llm/stream` 是深冻结的（请求 content 是会话日志
   的纯函数，架构上禁止改写）；durable 表面替换会连对话记录里的图一起抹掉。
3. **占位必须可回取**：`offloadedImageText(ref, access)` 带附件身份**和本地规范化路径**，
   模型真要看细节可以 `read_image` 取回；剪枝是省 token，不是删信息。
4. **计费必须与实收一致**：适配器对已 offload 的图按 0 视觉 token 计。
5. **遥测要报实收数**：`usage.jsonl` 的 `images` = 提供商实收张数，`imagesBeforePrune` =
   历史张数。实现见 §13.10（`src/host/image-budget.ts` + `scripts/accept-image-budget.mjs`）。

**30.12 模型可见的东西属于 agent plane**：DSH 是两层 composition——**profile（host plane）**
装注册表/沙箱/持久化/模型路由，**preset（agent plane）**装工具、prompt section、projection，
且只有选了该 preset 的会话看得见。
1. **凡是"模型看得见"的开销，一律问它挂在哪一层**。工具表随每次请求发出，且被 harness 算作
   请求信封的**唯一计价字段**（实测：不挂 CAD 27 工具 ≈ 6.8k token，挂 37~38 工具 ≈
   11.1~11.4k = **+4.5k/请求**）。插件挂 profile 层 = 每个会话（含纯编程）都在替它付费。
2. **系统提示词 ≠ 请求载荷**；插件"没改提示词"不等于"没有代价"。
3. **不要为了摘工具而把插件行挪进 preset**（浏览器半边的发现依赖 profile 的 composed rows）。
   正确做法是拆职责：路由/遥测/UI 留全局，**工具可见性按 preset 收窄**（`ctx.tools.restrict`，
   必须在 agent 自己的 ctx 上调）。
4. **"要求重开会话才生效"的改动只能装在项目开始前**：preset 是**会话的创建事实**，只在会话
   还空白时可改（曾经中途上线 → 被否决并全量回退）。
5. **验收要看"模型实际收到什么"**：会话日志的 `request/header` 是 durable 的工具表快照
   （`scripts/inspect-tool-catalog.mjs`；不启动 dsh 的 prospective 版本是
   `scripts/measure-tool-cost.mjs`）。
6. **削成本优先于分层**：工具表 4,621 tok 里工具级描述只占 1,764、脚手架 1,698、参数级 1,152；
   把"选型判据/全局约定/反直觉事实"搬进 **skill**（按需加载、发现根挂在 CAD preset 上）每次
   请求省 1,227 tok（−27%）且对任何会话零打扰。
7. **"零打扰"是硬门槛**：第一条不是"省多少"，而是"对正在进行的会话有没有影响"。

**30.13 一个项目一份语料**：项目身份 = **会话的工作目录（cwd）**。规则：
1. **两侧都必须带项目，缺一不可**：工具侧从 `exec.agent.session.header.cwd` 取（**没有模块级
   store**）；浏览器侧走 `?project=<绝对目录>`，客户端用 `withProject()` 这**唯一**的 URL
   构造器。只修面板等于只把症状盖住。
2. **读取不创建，写入才落盘**：目录不存在 = 空语料 = 新项目的正常状态。
3. **遥测反过来，留在 profile 层**：usage 量的是**请求**不是**设计**。
4. **迁移必须可重跑**：按条目合并、冲突 id 拒绝覆盖并报出、遥测按行去重追加。
5. **判据**：任何 `join(pluginRoot, …)` 形式的持久化路径，当场回答**"第二个项目来了会怎样"**。
   实现见 §13.13（`src/host/project.ts` + `scripts/accept-project-scope.mjs`）。

**30.14 两半作用域不一致时，面板必须说出来**：人的半边是全局的（路由、面板、遥测），模型的
半边是按预设的（工具表、skill 目录），于是会出现静默失败——标准模式会话里面板一切正常、
零件列表空空如也，而 Agent 一个 CAD 工具都没有（实测代价：Agent 自己读插件源码、用 bash 调
OpenSCAD 硬画，最后报 `skill "cad-toolbox" is unknown`）。规矩：
1. **"零打扰"不等于"零提示"**：能静默降级的是噪声（不自动弹面板），不能静默的是能力缺失。
2. **不要让客户端去猜服务端的决定**：宿主把 `toolScope` 与开放它的 preset 列表用
   `GET /api/cad/scope` 如实报出；客户端用 `cadToolsVisible(scope, preset)` 判定，**判据只有
   一份**（宿主规则是 `src/host/tool-scope.ts` 的 `decideToolScope`；preset 未知就不提示，
   宁可漏报不可误报）。
3. **创建事实不可改，所以提示要给动作，而且要给对**：会话还空白 → "现在重新选一次还来得及"；
   已经开始 → "新建会话，或在设置里把「造物模式」设为默认预设"。

**30.15 面板交互：产物即主体，不给模式开关**：人**只选产物**（零件版本 / 验证运行），**呈现
方式由产物自己是什么决定**——版本给几何视口，物理/机构运行给时间轴回放，流体运行给粒子
回放，清单检查给报告卡片。**禁止让人先选"看什么类型的东西"再选产物**：那是把引擎内部的呈现
差异泄漏成用户决策，而且必然会撒谎（旧版「动作/流体」Tab 取的是"最近一次运行"，与选中的
版本无关）。推论：**产物必须自带身份与出处**（运行有 id/时间戳/kind/`sourceVersionIds`）；
**"相关验证"由 provenance 生成**，不靠人记；默认跟随最新产物，可一键钉住。

**30.16 生产力阶段的缺口——权威编辑**：真实场景里人会下精确命令（"这个孔改 10mm 且保持
同心"）。不需要人回去拖鼠标建模，但需要**约束保持下的精确编辑 + 可追溯**。
PARAMS/Customizer 只改顶层标量，够不上。**待建**。

---

## 31. 装配表示、运行时分工与引擎默认策略（承 HARNESS §8/§11/§12，2026-10-16 迁入）

**31.1 装配表示：代码库类比**（立场 2026-09-27 修订）
**工件的名字**：**BOM + 可执行 ICD 合并成一份 `assembly.json`**（职责见 §5.3；schema 与
"接口条目 / 邻接兜底"的完整提案见 `docs/archive/ASSEMBLY-SCHEMA-PROPOSAL.md`）。
**原立场（已放弃）**："5/20/50 件对应完全不同的表示，先定规模再定表示"——把规模当门控。
**修订立场**：大型代码库 harness 能编辑（DSH 编辑几十万行），装配理论上同样可以。**关键不在
规模门控，在表达。** 代码库规模的解法从来不是"把代码库塞进上下文"，而是**让大代码库可导航
的表示与工具**。装配体与代码库结构同构：

| 代码库 | 装配体 | 已有 / 待建 |
|---|---|---|
| 文件 = 持久状态 | 零件文件 + 版本 | 版本系统（需扩展到装配级版本图） |
| import / API | 接口契约（谁配谁、间隙意图） | `datum()` 是种子，待推广 |
| grep | 邻接查询 / 空间查询（谁碰到这个面） | 待建（装配 manifest 的查询面） |
| LSP / go-to-def | datum / 接口名解析 | `datum()` 已有 |
| 类型系统 | 配合类型不匹配 = 编译错误 | 待建（轻量契约） |
| 测试 | L0/L1/L2 验证 | **已有** |
| CI（变更传播） | 接口变更 → 波及零件重验 | 待建（增量验证） |
| lint | 间隙 / 标准化检查 | `validate_assembly` 部分 |
| PR review | 接口级人审 | 人审通道部分 |
| 包管理（类型+实例） | 标准件复用（20 颗螺丝 = 1 类型 20 实例） | 待建 |

**判断标准随之改变**：从"多少件装得进上下文"改为——**一个新会话能否只靠局部视图 + 查询，
正确修改 50 件装配中的一个零件？**
**实验 A0'（取代原 A0 规模探针）**：按代码库方式建装配表示（零件文件化 + 接口契约 + 邻接
查询），在 50 件装配上测导航正确性：新会话（无历史上下文）能否在不读全部零件的前提下完成
一次指定零件修改并通过 L0 验证。**定位：这是必做的第一步，不是"做不做"的可选探针**——实验
只回答"表达方案是否正确"。此前识别的三个装配缺口不变：装配语义易失（joints 现场声明即丢）
→ 契约文件；版本模型零件级 → 版本图；上下文装不下 → 懒加载 + 查询，而非缩小装配。

**31.2 下一步排序**（2026-09-28 修订：装配与视觉表达优先，内核后置）
1. **找一个真实项目做压力测试**——缺口的真伪由它裁决。
2. **A0' 装配表示 + 装配视觉表达（主工作线，必做）**：代码面 v1 已交付 2026-09-28
   （datum 三类扩展 / `assembly.json` / L0 算子 distance + diameter-match / hard-intent
   双通道 / 邻接发现 / `check_assembly` 工具+路由 / `accept-assembly` 14/14；schema 见
   `docs/archive/ASSEMBLY-SCHEMA-PROPOSAL.md`）；**待续**：层级递归（v2）、L1 运动接口（v2）、
   spring/流道（v3）。视觉面：部件显隐/高亮、剖切、爆炸视图、接口（datum）可视化标记、装配
   回放（motion playback 已有底子）——**未开工**。依据：复杂装配下渲染图判读会退化
   （遮挡/细节小），"视觉管像不像、数值管对不对、**装配关系管接没接对**"。
3. **skill 化**——把三层判据选型、参数甜点、陷阱清单写成 skill（HARNESS §6）。
4. **权威编辑通道**——约束保持的精确编辑 + 可追溯（§30.16）。
5. ~~python-engine 集成~~ **取消（2026-09-28）**——架构 A 不用 OpenSCAD 内嵌 Python。
6. **Replicad/STEP 桥**（后置；内核可插拔是防御性储备，不是当前目标）。
7. **Python 领域运行时落地**：供给 v1 已落地 2026-10-08；常驻 worker 亦已于 2026-10-08
   落地（batch 0）。
8. 每季度：竞态追踪（HARNESS §9）。

**31.3 运行时分工**：**TS 是平台接线层，Python 是领域运行时**——不是"减少 TS"，而是让 TS
只干接线。
- **TS 不可动（平台规定）**：dsh 插件宿主面（`ctx.tools.register` / `connection.fetch.register`
  / `ctx.attachments` / cordis 生命周期）、浏览器面板与回放。
- **Python 扩张**：几何分析、仿真、装配检查、场景脚本。
- **架构 A**：模型来源仍是 SCAD（LLM 写）；Python **不决定几何意图、不替代 OpenSCAD 求解**。
  决策原文与边界漂移说明见 `docs/DECISION-LOG.md` 2026-09-28 补记。
- **worker 规范**（协议、大载荷走文件、单线程串行、venv 锁定、traceback、生命周期归插件管、
  "不是沙箱"）见 **§26**——那里是唯一权威副本，本节不重复。

**31.4 引擎默认策略：rapier 优先**（2026-09-28 裁决）
> **能用 rapier 的都用 rapier**（无脑默认）；只有用户明确强调或 LLM 明确要求时，才走自实现
> 的 MPM 脚本。

这是**默认偏置，不是取消分层判据**：判据仍是 L0/L1/L2 的**主语物态**——离散刚体/约束/接触/
可变形体 → rapier；连续介质流动/颗粒流 → rapier 无求解器 → MPM。**软体也归 rapier**
（rapier Python 绑定有 `add_soft_body` 系列，JS 绑定没有）→ MPM 弹性本构降级为"显式要求才
做"。**防越界条款**：连续介质问题（流量/死区/灌装/颗粒）的答案必须来自 MPM，不允许用 rapier
输出冒充；任一方向的越界使用都应说明理由供人审。
**canonical 现状（2026-10-16 校订）**：物理/运动的 canonical 在 **Python worker**（`physics.ts`
/`motion.ts` 内的注释 Q2=A），TS 侧 `runPhysicsInTs`/`runMotionInTs` 保留为 parity oracle，
且只在 **darwin-x64**（锁里没有 `rapier3d` wheel）继续当 canonical。决策谱系见 DECISION-LOG
2026-09-28 补记与 2026-10-08 各条。

**31.5 B-rep / STEP 边界**（2026-10-16 校订）
- 主循环**不需要 OCCT**：网格几何/装配检查/仿真用 manifold3d/trimesh/numpy。
- **导入**：STL（2026-10-01）、STEP/DXF（2026-10-15，`cascadio` + `ezdxf` 进锁，worker 内嵌
  转换）已交付；**IGES 与 `.brep` 是可行动边界**（cascadio 0.1.1 对 IGES 静默失败已实测）。
- **仍未做的**：STEP 导出、从 B-rep 抽取精确孔/轴 datum（网格细分只给网格级的）。评估顺序
  仍是 FreeCAD headless → cadquery-ocp → Replicad（~55MB wasm，留在 Node 栈）；引入与否仍未
  决定。

---

## 32. 环境变量与诊断开关（运维附录，承 HARNESS §12.7，2026-10-16 迁入）

> **性质**：本附录是**内部表面**。面向用户的只有 `CAD_OPENSCAD_BIN` 与
> `DSH_CAD_PYTHON` 两种用法（见 README §1/§4），其余为运维与定位用；
> **诊断类绝不可在生产设置**，它们只影响日志与对照路径，不改变工具 schema。
> 依赖与默认值的**唯一权威**是 `src/host/python-lock.ts`。

### 32.1 运行时供给

| 变量 | 作用 | 默认 |
|---|---|---|
| `DSH_CAD_PYTHON` | `auto` / `eager` / `off` / `system` | `auto`（启动只健康检查，首次调用才阻塞供给） |
| `DSH_CAD_PYTHON_BIN` | `system` 模式下的解释器绝对路径 | PATH 上的 `python3`。**注意**：代码检查 CPython ≥3.10，但依赖锁按 pin 的 3.13.16 生成、编译类包只列 cp313 wheel ⇒ **实际可行的是 3.13**（待实测确认后收敛） |
| `DSH_CAD_PYTHON_MIRROR` | 解释器归档的下载根 | `python-lock.ts` 内的镜像（npmmirror）；**当前没有 GitHub 回退** |
| `DSH_CAD_PYTHON_INDEX_URL` | pip 索引单源覆盖 | `PIP_INDEXES`：阿里云优先，`pypi.org` 兜底 |
| `DSH_CAD_PYTHON_ROOT` | 运行时落点覆盖（测试 / 多实例） | `$DSH_HOME/cad/runtime` |
| `DSH_CAD_PIP_CACHE_DIR` | pip wheel 缓存目录 | `<runtime root>/cache/pip` |

### 32.2 工具与遥测

| 变量 | 作用 |
|---|---|
| `CAD_OPENSCAD_BIN` | 指定 OpenSCAD 可执行文件（优先于自带快照与 PATH 上的 `openscad`） |
| `CAD_IMAGE_TOKEN_ESTIMATE` | 图片 token 估算值（默认 1000/图），用于遥测标定 |
| `CAD_TELEMETRY_DISABLE=1` | 关闭 usage 遥测 |
| `CAD_SKIP_CONTACTS` | 物理接触采样跳过（诊断用） |

### 32.3 Opt-in（默认关，标准会话行为不变）

| 变量 | 作用 |
|---|---|
| `DSH_CAD_IMAGE_WINDOW=1` | 让**没有预设名**的会话也套用造物模式的 24 张图像保留窗口。需要它的场景：headless（`dsh --profile headless`）不 compose 预设注册表，于是窗口不生效，多轮渲染会话会把请求堆到 64 张以上被上游拒绝。带真预设的会话不受影响 |

### 32.4 诊断开关（**只用于定位，绝不可在生产设置**）

| 变量 | 作用 |
|---|---|
| `DSH_CAD_FLUID_PYTHON=0` | 让 `simulate_fluid` 回退到 TS oracle |
| `CAD_FLUID_NO_PROJECT=1` | 跳过流场 SDF 投影（二分"投影 vs 内核"） |
| `CAD_FLUID_DEBUG_PENETRATION=1` | `fluid_run` 返回穿透深度分布、梯度、投影 / 入口计数器 |
| `CAD_FLUID_DEBUG_PROJECT=1` | TS 侧返回投影 / 入口计数器（与上一条对拍） |
| `CAD_FLUID_DT` | 覆盖流场时间步（量"离散化 vs 舍入"；步数需同步调整） |
| `CAD_MPM_JITTER_AMP` | 覆盖 MPM 初始抖动幅度（量结果对输入扰动的敏感度） |
| `CAD_MPM_ENGINE=numba\|numpy` | 强制 MPM 内核；不可用即**响亮失败**，不静默回落 |
| `CAD_LBM_ENGINE=off` | 关闭 LBM 车道（`off` 响亮拒绝，无回退引擎） |

### 32.5 平台裁剪与"就绪"的判据

- 平台缺 wheel 的包由锁里的 `cad-exclude` 注释逐包声明（`rapier3d` 缺 darwin-x64 → 物理
  留在 TS canonical；`numba` / `llvmlite` / `xlb` / `warp-lang` / `jax` 缺 musl 与 darwin-x64
  → MPM 回落 numpy 内核、LBM 车道不可用），安装期写进 `state.json.skipped` 并由
  `python_runtime` 状态如实披露——**缺包必须看起来像设计，而不是像坏包**。
- **"就绪"必须可被证伪**：除标记匹配外，venv 必须**真的 import 一遍锁定包**才算 current；
  `python_runtime` 报 `missingPackages`，非空即 `state: failed`。
