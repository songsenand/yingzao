# 插件侧 issue 清单（2026-11-21，自行车后拨两次会话）

> 来源：`session-f1bf685f`（OpenSCAD，A）与 `session-f954cb61`（CadQuery，B）的过程对比。
> 范围：**插件能力**（dsh-cad-harness 的工具面、检查语义、证据/契约模型），不是两个设计的产物评审。
> 每条的“复现”都是可执行命令或一次明确的工具调用；“期望”是修复后必须观察到的行为。
> 纯逻辑项由 `scripts/accept-plugin-issues.mjs` 覆盖；需要 Python 运行时的项在命令里标了
> `DSH_CAD_PYTHON_ROOT=$HOME/.dsh/cad/runtime`。
> 复现脚本（`scripts/repro-*.mjs`）读 `examples/*/cad-data/`：该目录按 `.gitignore` 不入库，
> 所以 clone 后需本地已有对应示例语料（runs/versions）才能跑，命令注释里写了期望输出。

## 状态总表

| ID | 优先级 | 问题 | 状态 |
|---|---|---|---|
| P0-01 | P0 | run 没有退役/替代/只看当前的 API，历史失败卡死 audit | 已修 |
| P0-02 | P0 | 契约写入器丢 `manufacturing`/`claims`，大装配只能 CLI+手改 JSON | 已修 |
| P0-03 | P0 | printability 把实心锐边当薄壳，且没有豁免 | 已修 |
| P1-04 | P1 | turning 绕世界原点量回转半径，不是包围盒中心 | 已修 |
| P1-05 | P1 | `validate.pose` 只带 3×3、不带绕 datum 的平移 | 已修 |
| P1-06 | P1 | stress 无支撑/网格过大要跑 30–60s 才报错/OOM | 已修（预检 + 可读错误） |
| P1-07 | P1 | CQ 版本 source 是可变 loader；并行 generate 串味 | 已修（快照 + 串行锁） |
| P1-08 | P1 | motion 的 `travelMm` 丢弃 warm-up，不解释 5–8% 缺口 | 已修（fullTravel/warmUpLost） |
| P2-09 | P2 | CNC `maxSetups` 语义、项目 profile 不能按 id 加载、batch 不收 `profilesJson` | 已修 |
| P2-10 | P2 | 契约只查接口/干涉，不查“能不能装进去” | 部分修（封闭腔/大面积不可达=装配风险；全序列插入检查未做） |
| P2-11 | P2 | 52 条 undeclared 只能手写；基准也全手写 | 已修（suggest + 现有 datums） |
| P2-12 | P2 | 改了版本后不知道“该重跑哪些检查” | 已修（affected） |
| P2-13 | P2 | 工程内核不能原地切换；文档说 `code`/`scadCode` 二选一，表面只收一个 | 已修（set_project_kernel；两字段共存） |
| P2-14 | P2 | 弹簧库无 k/并圈高度；motion 无弹簧/接触/重力却不声明 | 已修（库元数据 + capabilities） |
| P3-15 | P3 | 少量参数/schema 与路径可见性小问题 | 部分修（-0.0 已修；`/tmp` 属 harness core） |

---

## P0-01 run 生命周期

**现象/证据**
- A：r006（v017 垫圈）与 r054/r055（turning 世界轴）让 `cad_deliver audit` 一直 blocked；工具没有删除/退役 API，最后只能手工把目录移进 `.retired/`。
- B：退役了 14 条（其中 r040–r046 只是 `maxSetups` 声明过紧），audit 仍报 85/104 历史 run 过期。

**复现**
```bash
cd dsh-cad-harness && node scripts/accept-plugin-issues.mjs --only I01-retire
```
真实语料：对一个含旧失败 run 的工程调用 `cad_deliver audit`，得到 `failing-<kind>` / `latest-<kind>-failing`。

**期望**
- `cad_deliver retire {runId, reason}` 把 run 标成 retired（索引 + run.json 都写），**不移动、不删除**任何 artifact；`retire:true` 可撤销。
- `delivery_audit` 不再把 retired run 计入 latest/failing/stale；`runs.retired` 仍列出原因。
- 一个失败 run 引用的版本**全部**已被替代时，即使没有后继 run，也不再算 current。

**修复**
`src/host/runs.ts`（`retireRun`/`unretireRun`）、`src/host/delivery-audit.ts`（过滤 + current 判定）、
`src/shared/types.ts`（`retiredAt/Reason/By`）、`src/host/tools.ts`（`cad_deliver.retire`）。

---

## P0-02 契约顶层字段与写入路径

**现象/证据**
- B 的 root 约 21k 字符，`cad_assembly write` 0 次；29 次 CLI write、40 条 bash 涉及 `assembly.json`、68 段内联 Python。
- 两个工程的最终 `assembly.json` 都没有 `manufacturing`；`deliver plan` 的 `M:policy` 一直 `unobserved`。
- `claims` 不在 manifest schema 里，audit 的 `no-claims-declared` 无法通过写入消除。

**复现**
```bash
cd dsh-cad-harness && node scripts/accept-plugin-issues.mjs --only I02-contract-top-level
# CLI（构建后）：
cd /tmp && mkdir -p cli/assembly && cd cli
node /path/to/dsh-cad-harness/scripts/contract.mjs write --reason t --expected-revision 0 --mode create --patch patch.json --json
```

**期望**
- `write_assembly` 接受 `manufacturing`、`claims`、`patch`、`rootPath`；root-only merge 保留顶层字段。
- `--patch` 是整份 manifest 的 merge patch，`--root` 只改 root；两者可单独使用。
- 未知/非法顶层字段被拒绝，而不是静默丢弃。
- `delivery_audit` 默认读取契约里持久化的 `claims`，不再要求每次调用重复传。

**修复**
`src/host/manifest.ts`（`ManifestClaim`/`claims`）、`src/host/write-assembly.ts`（top-level + patch + validate）、
`src/host/assembly-contract.ts`、`src/host/contract-cli.ts`、`src/host/tools.ts`（write 参数/`rootPath`）、
`src/host/delivery-audit.ts`（claims fallback）。

---

## P0-03 printability 锐边误报

**现象/证据**
- B：upper v083 `0.18mm / 0.68–0.95%`、lower v085 `0.16mm / 0.27%`，全部 difficult；R1 圆角反而 3.75% excluded；0.5/0.3 倒角都不收敛。
- A：底座批量读到 `0.073mm`，也是孔口/棱边采样。

**复现**
```bash
cd dsh-cad-harness
DSH_CAD_PYTHON_ROOT=$HOME/.dsh/cad/runtime node --experimental-strip-types scripts/repro-printability-edge.mjs
```
期望输出含 `edgeOnly=1`，finding 明确写“实心锐边，不是薄壳”。

**期望**
- 薄区面积 ≤ `edgeOnlyThinPct`（默认 1.0%）、薄区 ≤ 50mm²、样本 ≤ 60 时，判为实心锐边：
  - 不再是 wall witness；
  - 声明了 CNC profile（overhang 不适用）时，最终 verdict 可为 `not-excluded`；
  - finding 说“去毛刺/倒角即可；要否决设 edgeOnlyThinPct:0”。

**修复**
`src/host/inspect.ts`（TS/Python 两条路径都分类）、`src/host/tools.ts`（profile witness 抑制 + 参数/输出 schema）。

---

## P1-04 turning 世界轴

**现象/证据**
- B 顶盖 v062 的 20×20 方形法兰在 `(8,11)`，turning 报 `Ø55.3 > 棒料22`；按包围盒中心应是 `Ø28.28`。
- A 的 r054/r055 也受同一测量方式影响。

**复现**
```bash
cd dsh-cad-harness && node --experimental-strip-types scripts/repro-turning-offset.mjs
```
v062：`fixed Ø28.28 · old Ø55.32`；v063：`fixed Ø20.00 · old Ø20.00`。

**期望**
- 回转半径绕“声明主轴 + 包围盒中心”；报告与实现一致。
- 对称性检查的“轴上点跳过”也用中心化后的坐标。

**修复**
`src/host/turning.ts`（`maxRadiusAboutCentre`）、`src/host/tools.ts`（turning 使用该函数、对称跳过用中心化坐标）。

---

## P1-05 validate.pose 绕原点

**现象/证据**
- B 的高档静位姿：`pose:{datum:"B_axis",angleDeg:-13.07}` 报 b/upper `61.03mm³`，与“绕原点旋转”的 `61.07` 吻合；本地绕 B 点旋转为 0。
- 代码在 `partWorldAffine` 里把 `poseA.m` 放进 matrix，却把 `poseA.t` 丢了。

**复现**
```bash
cd dsh-cad-harness && node scripts/accept-plugin-issues.mjs --only I04-validate-pose
```
盒体绕 `(10,0,0)` 转 90°，bbox 必须是 `x 9..10, y -10..-9`。

**期望**
- pose 是仿射：3×3 与绕 datum 的平移一起进入 mesh 变换。
- `validate` 的高档位姿不再出现“绕原点”的假干涉。

**修复**
`src/host/assembly-check.ts`（`matrixTranslate`）、`src/host/assembly.ts`、`src/host/solidify.ts`（`transformMesh` 带平移）。

---

## P1-06 stress 预检/OOM

**现象/证据**
- A 7 次应力 5 次失败（1 次 `no constrained node` 花 30s，4 次 SIGKILL）；B 2 次 SIGKILL；dx 0.7/0.5 都 OOM，0.9 是上限。
- 失败只报 `worker exited (SIGKILL)`，没有“网格多大/该用多少 dx”。

**复现**
```text
cad_simulate stress {versionId:"v083", loads:[...], supports:[]}
→ 修复后立即 argError，不再等 30s
cad_simulate stress {versionId:"v083", ..., dxMm:0.5}
→ 修复后返回 OOM 说明 + 建议 dx≥0.9，而不是裸 SIGKILL
```

**期望**
- 无支撑：求解前拒绝，消息给出三种 support 写法。
- bbox/dx 估算网格 > 12M cells：求解前拒绝并给建议 dx。
- 仍 OOM 时：错误里写明“环境上限，不是通过，也不是几何失败”，并给 dx/加厚/换 worker 三条路。

**修复**
`src/host/tools.ts`（`simulate_stress` 预检 + solve 的 catch 包装）。

---

## P1-07 CQ 版本快照与并行 generate

**现象/证据**
- B 的 v001/v064 `model.py` 都是 `exec(open(cq/b_knuckle.py))`；改 `cq/` 后旧版本含义跟着变。
- 并行 generate 让 v066/v067 几何互换（v066 实际是基座、v067 是 P-knuckle），r078/r079 只能退役。
- A 的 `model.scad` 是完整代码，可复现。

**复现**
```bash
cd dsh-cad-harness && node scripts/accept-plugin-issues.mjs --only I10-cq-snapshot
```
期望：`source-deps/part.py` 存在，stored `model.py` 指向快照而不是 workspace 绝对路径。

**期望**
- `saveVersion` 检测 `exec(open('...py'))`，把依赖复制进 `versions/vNNN/source-deps/`，改写 loader 指向副本；记录 `sourceDeps` + `sourceHash`。
- `generate_part` 的 compile+save 按工程串行（`.cad-generate.lock`），不再共享 worker 状态。

**修复**
`src/host/version.ts`（`snapshotLoaderDeps`）、`src/host/tools.ts`（`withFileLock` 包 compile）。

---

## P1-08 motion 行程口径

**现象/证据**
- B r117：设计 8.00mm，报告 `travelMm 7.577`；首个采样 `t=0.0495`，warm-up 丢掉起始位姿。
- A r036：设计 10.0mm，报告 knuckle `9.162`，同样没有解释。

**复现**
```bash
cd dsh-cad-harness && node scripts/accept-plugin-issues.mjs --only I09-motion-warmup
```
期望 followers 同时有 `travelMm/fullTravelMm/warmUpLostMm/warmUpOffsetMm`。

**期望**
- 保留 `travelMm`（settled range，原语义），新增 `fullTravelMm`（含 t=0）、`warmUpLostMm`、`warmUpOffsetMm`。
- 文本报告在 `warmUpLostMm > 0.05` 时明确提示“与设计行程比较 full range”。

**修复**
`src/host/motion.ts`（initial/settled 采样 + followers 字段）、`src/host/tools.ts`（文本）。

---

## P2-09 CNC setup / profile / batch

**现象/证据**
- B r040–r046 七条 `excluded`，只因 `maxSetups` 声明 2–4；滑块 100% 可达也被判红；改 6 重跑才绿。
- A 的 `profiles/cnc-3axis-alu.json` 按 id 被拒（“no shipped profile”），只能 `profilesJson` 逐件传。
- `check_parts` 只收 `profileIds`，B 因此跑了 24 次单件 printability。

**复现**
```text
cad_check cnc {versionId:"v073"}                 # 省略 maxSetups → 默认 6
cad_check printability {versionId:"v073", profileIds:["shop-cnc"]}  # 工程 profiles/shop-cnc.json 可解析
cad_check parts {versionIds:[...], profilesJson:"[...]"}            # batch 接受自定义 profile
```

**期望**
- `maxSetups` 可省略，默认 6；声明更少是“声明能力”，不是几何不可能。
- `profileIds` 先查工程 `profiles/` 与 `cad-data/profiles/`，再查 shipped。
- `check_parts` 接受 `profilesJson` 与 `edgeOnlyThinPct`。
- CNC 报告含 `sealedCavities`；不可达 ≥20% 时明确写“这是装配风险”。

**修复**
`src/host/tools.ts`（CNC 默认/输出、profile 解析、batch 参数、cavity 检测）、`src/host/inspect.ts`。

---

## P2-10 装配可行性

**现象/证据**
- B 基座弹簧腔：Ø12 推杆盘过不了 Ø6 孔、顶部封死；装配契约 62/62 通过，直到 CNC r040 报 28.3% 不可达才发现。修法是顶部开口 + POM 顶盖 v063（rev 18）。

**复现**
```text
cad_check cnc {versionId:"v073", maxSetups:6}
→ 修复后 findings 含封闭腔/不可达≥20% 的“装配风险”句；sealedCavities 字段存在。
```
（对 v059 这种“有 Ø6 颈、顶部封死”的腔，当前用“不可达面积”提示，而不是全序列插入证明。）

**期望**
- 至少把“封闭腔”和“大面积不可达”直接命名为装配/清理风险，而不是只当刀具警告。
- 全序列 insertion/extraction 检查是后续项：需要多步拆装规划，单步平移会误报（本轮试过，对衬套/销全红，已撤下）。

**修复**
`src/host/tools.ts`（CNC `sealedCavities` + `inaccessiblePct>=20` finding）。
**未完成**：多步拆装顺序求解。

---

## P2-11 undeclared / datum 手写

**现象/证据**
- B 首查 52 undeclared，补到 62 接口；`cad_assembly check` 24 次、`datums` 23 次。
- A 29 接口、1 次 datums。

**复现**
```text
cad_assembly suggest {manifestPath:"assembly/assembly.json", maxSuggestions:20}
→ 返回每对的 aDatum/bDatum/template（distance + measured gap ± tolerance）
```

**期望**
- 未声明近接触对自动生成可粘贴的接口模板（明确“需复核 datum”）。
- 不写契约、不新增 run。

**修复**
`src/host/tools.ts`（`suggest_interfaces`）。

---

## P2-12 增量复验

**现象/证据**
- B 15 次 audit、104 run；每次倒角后全量重跑；audit 只说 85/104 过期，不说“现在该跑哪几个”。

**复现**
```bash
cd dsh-cad-harness && node scripts/accept-plugin-issues.mjs --only I08-affected
```
期望：新版本无 printability run → `next:[{tool:"check_printability",args:{versionId}}]`；补跑后 `next:[]`。

**期望**
- `cad_deliver affected {changed?}` 按 part 列出 fresh/stale kinds + 建议调用。

**修复**
`src/host/delivery-audit.ts`（`affectedChecks`）、`src/host/tools.ts`（`cad_deliver.affected`）。

---

## P2-13 内核切换 / schema

**现象/证据**
- A 的工程默认 OpenSCAD，`generate_part` 只收 `scadCode`；文档说 `code`/`scadCode` 二选一。想用 CQ 只能新建工程（B 正是这么做的）。

**复现**
```bash
cd dsh-cad-harness && node scripts/accept-plugin-issues.mjs --only I06-kernel-switch
```
期望：已有 marker 的 `defaultKernel` 从 openscad → cadquery，`previous` 保留。

**期望**
- `cad_session kernel {kernel}` 原地改项目 marker；旧版本保留自己的 backend pin。
- `generate_part` 同时声明 `code`/`scadCode`，按传入字段选内核；两者都给/都不给都报清晰错误。

**修复**
`src/host/project.ts`（`setProjectKernel`）、`src/host/tools.ts`（`set_project_kernel`；generate 已双字段）。

---

## P2-14 弹簧元数据 / 动力学边界

**现象/证据**
- 库 `din2098.*` 只有 wire/OD/free length；A 估 k=1.27/1.36/1.70，B 估 2.04。
- motion 引擎无弹簧/接触/重力，但报告不声明；核心“跳档”无法证明。

**复现**
```bash
cd dsh-cad-harness && node scripts/accept-plugin-issues.mjs --only I05-spring-metadata
```
期望：`din2098.1.2x12x30` 有 `stiffnessNPerMm≈2.03`、`solidHeightMm 9.6`、`source estimated`。

**期望**
- 六个 DIN2098 弹簧进入 `STANDARD_SPRINGS`，并写进 `library/parts/*/part.json` 的 `spring` 块；`spring-behaviour` 可用 `standardId` 自动填 k/并圈。
- motion 输出 `capabilities:{rigidBodies:true,joints:true,springs:false,contact:false,gravity:false}`，文本明确“index/detent claim 不能由本 run 证明”。

**修复**
`src/host/standard-parts.ts`、`library/parts/din2098.*/part.json`、`src/host/motion.ts`、`src/host/tools.ts`。
**未完成**：真正的弹簧/接触动力学求解器（超出本轮）。

---

## P3-15 小问题

- `cad_inspect measure` 的 `-0.0` 导致 `"value must be a lossless JSON object"`：已在 `python/cad_worker/worker.py` 的 `_lossless` + `measure_gap` 源头修。
- `read_image("/tmp/x.png")` 读不到：属 DSH harness 的沙箱路径，不是 dsh-cad-harness；渲染图已保存在版本目录，优先用 `cad_see`/版本图。
- `generate`/`set_part_role`/`write merge` 的必填参数：`argError` 已给示例；本轮补了 `rootPath`/`patch` 的提示。
- 压缩失败（B 03:31 `no text summary`）：属 DSH 会话压缩，不在本仓库。

---

## 验证

```bash
cd dsh-cad-harness
npm run build
node scripts/accept-plugin-issues.mjs
node scripts/accept-run-index.mjs
node scripts/accept-write-assembly.mjs
node scripts/accept-assembly-contract.mjs
node scripts/accept-kernel-switch.mjs
node scripts/accept-tool-output.mjs
```

真实语料复现：

```bash
DSH_CAD_PYTHON_ROOT=$HOME/.dsh/cad/runtime node --experimental-strip-types scripts/repro-printability-edge.mjs
node --experimental-strip-types scripts/repro-turning-offset.mjs
```
