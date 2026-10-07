# 实验报告：00-smoke 仪器校准（评测前置条件核查 + 首次全绿）

> 日期：2026-10-07　|　触发：用户要求"检查是否符合开展评测的前置条件，如果已达到
> 条件请进行 00-smoke 测试"
> 结论：**前置条件原本不满足**（两条硬阻塞）；修复后 00-smoke **13/13 硬门 +
> 6/6 数值全绿**，仪器可用。但"开展评测"整体仍有 3 项待办（见末节）。

---

## 目标

1. 逐条核查"能不能开始跑评测"——按 `examples/bench/README.md` §2 的 SUT 基准、
   §3 的备料、§7 的校准顺序，以及 `graders/README.md` §九 的待办清单。
2. 条件满足则执行 `00-smoke`（仪器校准），确认插件本身还能跑。

## 假设

**跑之前的预期**：题库骨架、SUT 基准、参考图、dossier 都已落地（§九 大多为 ✅），
缺的应该只是那两块 ⏳——`bench-smoke.mjs` 与 `608.stl`。即"仪器是好的，只缺一个
把它跑起来的脚本"。

**这个假设被推翻了。** 仪器本身就是坏的：源码已修，发货产物没重建。

## 方法

### 一、前置条件核查（只读，不改动）

按 §2 的权威基准逐字比对指纹；按 §九 逐项查文件是否存在；对
`g-openSCADPATH` 这条硬门做了**静态 + 实测**两级验证（比对 `src/host/compile.ts`
与 `lib/index.js` 的 OPENSCADPATH 赋值，再实测 `BOSL2/std.scad` 的解析路径）。

### 二、修复

1. `cd dsh-cad-harness && node esbuild.mjs` 重建 `lib/`（`lib/` 未入库，
   `git ls-files dsh-cad-harness/lib` = 0，属常规构建，不动 §2 冻结的三组指纹）。
2. 新增 `examples/bench/graders/00-smoke/bench-smoke.mjs`：加载**发货产物**
   `lib/index.js`，用 mock `ctx` 取回 18 个工具定义，以
   `exec = {agent:{session:{header:{cwd:<temp>}}}}` 逐个驱动，执行同级
   `rubric.json` 的 13 硬门 + 6 数值。

### 三、实跑

```bash
cd /home/songsenand/Project/ToyMarker/dsh-cad-harness && node esbuild.mjs
cd /home/songsenand/Project/ToyMarker
node examples/bench/graders/00-smoke/bench-smoke.mjs            # 全量（含 MPM 流体）
node examples/bench/graders/00-smoke/bench-smoke.mjs --skip-fluid  # 快速迭代
```

## 结果

### 1. 前置条件核查表

| 前置条件 | 基准 / 要求 | 实测 | 结论 |
|---|---|---|---|
| SUT git commit | `76b6661f` | `76b6661f` | ✅ |
| `SKILL.md` sha256 | `8e2717f9…`（313 行） | 一致，313 行 | ✅ |
| 6 份 `TASK*.md` 指纹 | §2 表 | **6/6 逐字一致** | ✅ |
| `graders/` 骨架 | 五题 rubric + prompt | 齐（01/01b/02/03 另有 `key.md`） | ✅ |
| `subjects/` 考生侧 | 只放有考生的题 | 4 题，**无 `00-smoke/`**（符合设计） | ✅ |
| `01b` dossier | 69 个 run | 69 run / 1.8M | ✅ |
| `03` 参考图 | 530×887、水印已去 + `landmarks.json` | 530×887 RGB + landmarks | ✅ |
| headless profile / `accept-*.mjs` | 已实测 | profile 已链，25 个脚本齐 | ✅ |
| OpenSCAD | — | 2021.01 在 PATH | ✅ |
| **`bench-smoke.mjs`** | 00-smoke 的 driver | **不存在**（全仓 grep 只命中文档） | ❌ **B1** |
| **发货产物含 BOSL2 修复** | `src/host/compile.ts` 10-05 21:28 | `lib/index.js` 构建于 10-05 13:31，仍是旧逻辑 | ❌ **B2** |
| `subjects/02-steam-engine/assets/608.stl` | §3.1 运行前生成 | 目录下只有 `.gitkeep` | ❌ 阻 02，不阻 00-smoke |
| `examples/bench/tools/bench-score.mjs` | §九 | 不存在 | ❌ 阻 LLM 题记分 |
| 基线 commit 完整性 | §2 "本变更集提交后的 commit 才是完整基准" | `examples/bench/` **0 files tracked**；`compile.ts` 未提交 | ⚠️ |
| `g-delivery-audit.evidence` 中性化 | §九 待办 1 | 仍是 `01b` 结论的转述 | ⚠️ |

**B2 的三级证据**（这是本次核查的核心发现）：

| 级 | 证据 |
|---|---|
| 静态 | `grep -c bosl2Roots lib/index.js` = **0**；`= bosl2Dir` = 1（旧逻辑：`OPENSCADPATH = join(pluginRoot,'..','lib','BOSL2')` 指向 BOSL2 目录**自身**） |
| 路径 | `lib/BOSL2/std.scad` **EXISTS**；`lib/BOSL2/BOSL2/std.scad` **MISSING** ⇒ `include <BOSL2/std.scad>` 静默失败（OpenSCAD 只 WARNING、顶层对象为空、编译仍报成功） |
| 重建后 | 同一进程实测 `OPENSCADPATH=/home/.../ToyMarker/lib:/home/.../ToyMarker/lib/BOSL2`（父目录 + 自带目录两级） |

**为什么 accept 套件没抓到它**：`accept-bosl2.mjs:34` 是
`import { compileStlOnly } from '../src/host/compile.ts'` —— 它测**源码**。
源码是好的，所以它 14/14 全绿；发货产物是坏的，而 SUT 加载的是发货产物。

### 2. 00-smoke 实跑结果（2026-10-07，首次全绿）

```
bundle  dsh-cad-harness/lib/index.js
        built 2026-10-07T14:51:02Z  sha256 d26ffd494c99…
注册工具 18 个
```

| # | 硬门 | 实测 |
|---|---|---|
| 1 | `g-grader-access` | PASS（只读本级 `rubric.json`；`subjects/` 树哈希未变） |
| 2 | `g-openSCADPATH` | PASS（1 个父目录含 `BOSL2/std.scad`；0 个误当父目录） |
| 3 | `g-watertight` | PASS（`watertight=true`） |
| 4 | `g-render-count` | PASS（默认 4 张；`views:['iso']` 1 张） |
| 5 | `g-set-datums-no-version` | PASS（版本目录 2 → 2；`mode=merged`） |
| 6 | `g-negative-control-fires` | PASS（孔径改小 0.5 → `diametral clearance Ø-0.1`，1 条 hard，`status=fail`） |
| 7 | `g-motion-ratio` | PASS（travel 30.415 vs 解析 31.416 → **3.19%** < 5%） |
| 8 | `g-pivot-rebased` | PASS（`pivots.bar=[120,0,0]`；`run r003/parts/bar.stl` 中心 `[0,0,0]`） |
| 9 | `g-static-friction` | PASS（`holdAnalysis` 1 条，`holds=false`、`mu=0.3`、摩擦上限 0.269N vs 轴向驱动 10.261N；文本明示 quasi-static） |
| 10 | `g-fluid-runs` | PASS（`status=pass`，`outletArrivalRatio=0.9333`） |
| 11 | `g-merge-shells` | PASS（相接 1；分离 2） |
| 12 | `g-delivery-audit` | PASS（命中 `stale-evidence` + `contract-stale-nodes`） |
| 13 | `g-bosl2-gears` | PASS（`spur_gear` 外径 21.99mm ∈ 22±0.5；`screw` 轴向 20.00mm；include 警告 0） |

| # | 数值判据 | 实测 |
|---|---|---|
| 1 | `c-measure-part` | PASS（`size=[100,60,8]`；体积 47096.7 vs 解析 47095.2 → **0.003%**） |
| 2 | `c-measure-close` | PASS（两板间隙 5mm，解析 5） |
| 3 | `c-connectivity` | PASS（正例 `single-body(1)`；反例 `multi-body(2)` 且列出两体中心） |
| 4 | `c-printability-thin` | PASS（0.5mm 盒：`minWall=0.5`、`thinSamples=16`、`verdict=check`） |
| 5 | `c-interference` | PASS（干涉 **240.00mm³** vs 解析 240mm³） |
| 6 | `c-fluid-arrival` | PASS（`arrival=0.9333` > 0.6；`penetration=0`） |

**预算**：工具调用 31/60 ✅；墙钟 63.2s / 30min ✅；**图片 43/48**（原声明 24，
已按实测回填 —— 见"遇到的问题"§4）。

### 3. §九 待办 3：`evidence` → `accept-*.mjs` 映射逐条实核

**粗筛（"关键字出现在某脚本里"）与实际断言的高度不一致**——这正是 §九 待办 3
警告过的那件事。逐条实核（25 个 accept 脚本）：

| 判据 | bench-smoke 步骤 | 声称的 accept 覆盖 | 逐条实核的结论 |
|---|---|---|---|
| `g-grader-access` | 全局 | 评测层，无 | ✅ 确无 accept 覆盖；脚本改为「只读本级 rubric + subjects 树哈希未变」 |
| `g-openSCADPATH` | 21 | `accept-bosl2` §1 | ⚠️ 有，但**测的是 src**。bundle 侧只有 bench-smoke 能测 |
| `g-watertight` | 1 | `accept-connectivity` 等 | ✅ 多脚本涉及，断言成立（`accept-import`/`accept-inspect`/`accept-m2`/`accept-p3` 亦命中） |
| `g-render-count` | 1,2 | 无明确声称 | ⚠️ **无脚本专门断言"默认 4 / 显式 1"**。`accept-p0` 只断言"三张装配视图"，`accept-image-offload` 只在注释里提 4 视图 → 实覆盖来自 bench-smoke |
| `g-set-datums-no-version` | 3 | `accept-p1` | ✅ 真覆盖：`accept-p1.mjs:154-157` 自己记 `versionsBefore/After` 并断言不新增版本 |
| `g-negative-control-fires` | 13 | 评测层 | ✅ 无 accept 覆盖；纯 bench-smoke 自建（阳性 4 pass/0 hard 为前置） |
| `g-motion-ratio` | 14 | `accept-p2` | ✅ 真覆盖：`accept-p2.mjs:150-152` 断言 `|travel − R·ω·T| / (R·ω·T) < 0.05` |
| `g-pivot-rebased` | 15 | `accept-motion-pivot` | ✅ 真覆盖：既断言 `pivots`，也读 `runs/<id>/parts/bar.stl` 的包围盒中心 |
| `g-static-friction` | 16 | `accept-p2`（原文如此） | ⚠️ **更正**：`staticFriction` 只出现在 **`accept-p3.mjs`**，`accept-p2` 无此关键字 |
| `g-fluid-runs` | 17 | `accept-m4` | ✅ 真覆盖（`accept-m4` 即 M4 流体验收） |
| `g-merge-shells` | 18 | 无明确声称 | ⚠️ `merge_parts` 关键字只出现在 `accept-p1.mjs`，未断言 shells 1/2 → 实覆盖来自 bench-smoke |
| `g-delivery-audit` | 19 | `accept-delivery-audit` | ✅ 真覆盖（主用例是 microscope5 真实语料的地面真值） |
| `g-bosl2-gears` | 20 | `accept-bosl2` | ⚠️ 断言成立，但同样**测 src** |
| `c-measure-part` | 4 | 无明确声称 | ⚠️ `measure_part` 关键字只出现在 `accept-tool-scope.mjs:42` —— **那是一份工具名清单，不是断言**。真覆盖来自 bench-smoke |
| `c-measure-close` | 6 | 无明确声称 | ⚠️ 关键字命中 `accept-p3`/`accept-tool-scope`，均非数量级断言 → 实覆盖来自 bench-smoke |
| `c-connectivity` | 7 | `accept-connectivity` | ✅ 真覆盖（正例 + 反例） |
| `c-printability-thin` | 9 | 无明确声称 | ⚠️ 关键字命中 `accept-p3`，未断言 0.5mm 反例 → 实覆盖来自 bench-smoke |
| `c-interference` | 11 | `accept-m2` | ✅ 真覆盖（`accept-m2` 首case 即 `intersectionVolume > 0`） |
| `c-fluid-arrival` | 17 | `accept-m4` | ✅ 真覆盖（直管、守恒、零穿透） |

**汇总**：13 硬门 + 6 数值共 19 条中，**真正的 accept 覆盖只有 8 条**
（`g-set-datums-no-version`、`g-motion-ratio`、`g-pivot-rebased`、`g-fluid-runs`、
`g-delivery-audit`、`c-connectivity`、`c-interference`、`c-fluid-arrival`），
另 4 条为"覆盖但测 src"（`g-openSCADPATH`、`g-bosl2-gears`、`g-watertight`、
`g-static-friction` 经由 `accept-p3`），**余下 7 条 accept 侧实为空或仅关键字命中**。

> 这纠正了原先"18/19 已被覆盖"的说法。差异来源就是 §九 待办 3 点出的那条：
> 关键字出现 ≠ 那个脚本断言的正是这一条。

## 分析

1. **00-smoke 立刻兑现了它的价值。** 它存在的理由是"一次失败的评测无法区分
   插件退化与模型变笨"，而本次核查在**还没跑任何 LLM 题**的情况下就抓到了一次
   真实接线故障（B2）。若跳过校准直接开测，`01/02/03` 里所有用 BOSL2 的题都会
   静默降级：模型看到的是"库不可用"，很可能重演 microscope5 手搓渐开线齿轮那条
   路，而分数下降会被记成模型能力问题。
2. **"验证源码"与"验证产物"是两件事。** `accept-*.mjs` 直接 import `.ts`，
   因此对"`lib/` 是否陈旧"这类故障**结构性失明**。这不是某个脚本的疏忽，是
   测试对象选错。DECISION-LOG 已定：00-smoke 校准发货产物。
3. **阴性对照真的报了错。** `g-negative-control-fires` 把孔径改小 0.5 后
   `check_assembly` 报 `diametral clearance Ø-0.1`、1 条 hard、`status=fail`，
   且阳性基准同时成立（4 pass / 0 hard）。这条机检不是空的。
4. **图片预算 24 是拍出来的，不是量出来的。** 配方含 3 次仿真（各自带关键帧）、
   1 次装配渲染（3 张）、1 次默认四视图，24 张根本装不下。已按实测回填 48。

## 遇到的问题

1. **B1：driver 不存在。** `bench-smoke.mjs` 全仓只有文档引用。→ 本次实现。
   归属经用户拍板留在题库侧（DECISION-LOG 第 22 条）。
2. **B2：bundle 落后于 src。** 见上"三级证据"。→ `node esbuild.mjs` 重建；
   并把"重建"写进 driver 头部与根 README §7 的必做第 1 步。
3. **`simulate_physics` 的返回是扁平的。** 我一开始按 `metrics.holdAnalysis` 取，
   实得 `undefined`，导致 `g-static-friction` 假失败。实测返回是**顶层**
   `{overallStatus, settledPenetrationMm, maxPenetrationMm, fellOver,
   jointViolations, holdAnalysis, notes, keyframes}`（嵌套 `{overallStatus,
   metrics, frames}` 的是 `simulate_fluid`）。→ 改取顶层。**这是脚本 bug，不是
   插件缺陷**——记录在此以免下次误判。
4. **`simulate_fluid` 的默认种子区只对薄壁管安全。** 工具的 `fluidRegionMm`
   默认"按管件包围盒内缩 3mm"推导，因此只有**壁薄于 3mm** 时种子才落在内孔里。
   实测同一套题面下：

   | 夹具 | 重力 | 到达率 |
   |---|---|---|
   | 20mm 见方实心块 + Ø8 通孔 | 默认 `[0,0,-98.1]` | **0.0971** |
   | 同上 | `[0,0,0]` | 0.1990 |
   | 管 ro6/ri4（2mm 壁） | `[0,0,0]` | 0.4286 |
   | **管 ro5/ri4（1mm 壁）** | `[0,0,0]` | **0.9333** |
   | 同上 + 显式 `fluidRegionMm` | `[0,0,0]` | 0.9720 |

   → 判据"Ø8 直管、到达率 > 0.6"对应的夹具是**薄壁直管 + 纯驱动流**
   （工具描述本身就说 `[0,0,0]` 用于纯驱动流）。**这是一条工具可用性发现**：
   厚壁管件下默认种子会把相当比例的粒子种进实体壁内，表现为"到达率异常低"，
   而报告里没有任何提示。建议下一步给 `simulate_fluid` 加一条
   "种子区与实体重叠"的警告，或在工具描述里写明"默认种子只适用于薄壁管"。
5. **两处 rubric/driver 形状落空**（已修）：`check_assembly` 的返回只有
   `summary`（无逐条 `results`，逐条结果在 run 的 `report.json` 里）；
   `validate_assembly` 要求 ≥2 件。

## 产物列表

**代码与脚本：**
- `examples/bench/graders/00-smoke/bench-smoke.mjs` —— **本次新增**。仪器校准驱动：
  加载 `lib/index.js`，驱动 18 个工具执行 `rubric.json` 的 13 硬门 + 6 数值。
- `examples/bench/graders/00-smoke/rubric.json` —— 判据（唯一权威副本）。
  本次改动：`g-delivery-audit.evidence` 中性化、图片预算 24→48、
  `calibration` `uncertain`→`calibrated`。
- `dsh-cad-harness/lib/index.js` —— 发货产物，**本次重建**（构建于 2026-10-07 14:51Z）。
  未入库；`node esbuild.mjs` 产生。

**数据：**
- 结果 JSON：`examples/bench/graders/00-smoke/scores/smoke-2026-10-07T15-09-52-360Z.json`
  （全绿那一次；该目录已 gitignore）。含每一步实测值、19 条判定、预算用量与环境。
- 夹具全部在临时目录内**程序化生成**（`mkdtemp`，无随机种子依赖），跑完自删；
  `--keep` 可保留。

**运行命令：**
```bash
cd /home/songsenand/Project/ToyMarker/dsh-cad-harness && node esbuild.mjs
cd /home/songsenand/Project/ToyMarker
node examples/bench/graders/00-smoke/bench-smoke.mjs
```

**环境依赖：**
- Node v26.10.0（需 `.ts` 直载与 `import.meta.dirname`）
- OpenSCAD 2021.01（`/usr/bin/openscad`，在 PATH）
- BOSL2 位于 `<repo>/lib/BOSL2`
- `dsh-cad-harness/{lib,node_modules}` 就位；`DSH_HOME` 与 workspace 由脚本指向临时目录

## 结论与下一步

**结论**：00-smoke 全绿（13/13 + 6/6），**仪器可用**。前置条件中原先的两条硬阻塞
（B1 driver 缺失、B2 bundle 陈旧）已解除。

**但"开展评测"整体仍未就绪**，剩 3 项（与 00-smoke 无关）：

| 待办 | 卡住什么 |
|---|---|
| `subjects/02-steam-engine/assets/608.stl` 未生成（§3.1） | `02` 开不了跑 |
| `examples/bench/tools/bench-score.mjs` 不存在 | LLM 题的六列打分没有执行器 |
| 基线 commit 不完整（`examples/bench/` 0 files tracked；`compile.ts` 未提交） | §2 的"完整基准"无法从 commit 复现 |

**建议的下一步优先级：**

1. **提交这批变更集**（含 `examples/bench/` 与 `compile.ts`），让 §2 的基准 commit
   真正成立——否则任何一轮的"指纹一致"都只对得上工作区，对不上历史。
2. 生成 `608.stl` 并 `import_part` 验一次（§3.1）。
3. 写 `bench-score.mjs`（六列 + 扫描 `tool_call.input` 实现 `g-grader-access`）。
4. 然后跑首轮基线：定阈值、回填各 `key.md` 的实测列。
5. **工具侧**：给 `simulate_fluid` 加"种子区与实体重叠"警告（本报告 §遇到的问题 4）。
6. 可选：把 `accept-*.mjs` 里"测 src"的那几条（`accept-bosl2` 等）补一条针对
   `lib/` 产物的等价断言，让"产物陈旧"在插件侧回归里也能被抓到。
