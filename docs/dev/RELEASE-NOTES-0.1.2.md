# 0.1.2-preview.1 发布说明

> **状态**：**已发布**（2026-11-26 00:39 +08）。维护者在手机 npmjs.com 的 Staged Packages 批准后上线；`dist-tags.latest` = `0.1.2-preview.1`，gitHead `d229536`，shasum `dbe385ed…`。CI 全绿：[run 45645941780](https://github.com/songsenand/yingzao/actions/runs/45645941780)（commit `da2fc2d`）——Ubuntu/macOS 全量 + Windows smoke + CadQuery pack。
> **发布路径**：CLI `npm stage publish` 成功，但现有 token 只有 `package:write`，`stage approve`/`reject` 均 404、直发 E409；web 2FA 指纹设备损坏，最终由手机批准。**下次遇到 staged 阻塞，先提示“可以用手机 npmjs.com → Staged Packages 批准”**，不要先改版本号。
> **基线**：`v0.1.1-preview.1`（2026-11-20）→ 本版。
> **目标/范围/验收**：[TODO.md](TODO.md) §1 的 R1–R8；用户文档入口：[docs/user/preview.md](../user/preview.md)。

---

## 1. 升级须知：装完/升级 dsh 后必须重跑 `dsh-cad-setup`

预设 `presets/cad/preset.patch.yml` 不是引用 dsh 的 `standard.patch.yml`，而是**逐字复制**
（`scripts/preset-lib.mjs`）。dsh 版本之间会删改内部行，预设又是**整块挂载**的：

- 一行插件起不来 → 整个预设失败 →「营造模式」直接不出现，没有报错弹窗；
- 表现上像“插件消失了”，实际是预设没挂上。

所以每次升级 dsh 或本插件之后：

```bash
npx dsh-cad-setup      # 按当前 dsh 重新生成预置
# 重启 dsh
```

`npx dsh-cad-doctor` 会检查这条同步关系：不一致时报 `preset-standard-drift`，并给出上面这条修复命令。

本版预设仍按 **dsh 0.2.2-rc.1** 重生成（与 0.1.1-preview.1 相同）；兼容范围仍是
`>=0.2.1-rc.2 <0.3.0`。13 个 in-range 版本的实测见 [DSH-MATRIX.md](DSH-MATRIX.md)。

---

## 2. 本版做了什么

**不新增引擎、不改 engine seam。** 0.1.1 的「OpenSCAD + CadQuery 双内核」保持不变；
本版是 11-20 → 11-25 的 36 个提交收口（截至 2026-11-25 22:30，含发布文档；按 [TODO.md](TODO.md) §2 的 C1–C12）。

### 2.1 装配与运动的取证链（C1）

- **新增 `cad_check` action `sweep`（预运动扫掠筛查）**：给一个运动件、一组静态件和声明的关节行程
  （转动角度/滑动 mm），先用连续扫掠 AABB 包络排除不可能相碰的 pair，再粗采样最近距离，只对
  clearance < 2×minFeature 的区间自适应细化。结果 `collision` > `suspect` > `uncovered` > `clean`；
  预算耗尽报 `uncovered`，**永不报 clean**。它是“去跑 motion 之前”的嫌疑入口，不是交付判定。
- **运动关节可以声明配合包络**：转动副可带 `overlapEnvelope`（沿轴的配合胶囊）与 `fit`；
  `scanJointPairs: true` 把关节对放进干涉时间线，胶囊内重叠列为配合（`jointFitsUnresolved` 仍会 gate），
  胶囊外仍是干涉。工具面不再拒收 fit/包络参数。
- **motion 支持 `gear` 关节**：带符号 `ratio`（B 每转 A 的圈数），耦合是 prescribed（rapier 无齿轮约束），
  **不传扭矩**；`metrics.gears` 报声明值与实测圈数。
- 每个干涉事件带 `overlapBboxMm`（交叠的 min/max XYZ），不用重放就能定位冲突。

### 2.2 制造与打印（C2、C7）

- **悬垂改为“支撑成本”，默认不再直接判失败**：`check_printability` 默认只报 finding；
  只有工艺档案显式 `overhangDeg.hard: true`（不允许支撑/可见面/封闭腔）才把 >20mm² 的悬垂降为 `difficult`，
  且 finding 会指名该档案。已声明 FDM 档案的带支撑件不再被误判。
- **DIN 2098 六个规格补弹簧参数**：wire/OD/free length 之外新增刚度、圈数、并圈高度与
  `source=estimated`。数值按 `k = G·w⁴ / (8·(OD−w)³·n)`、`G=79 GPa` 估算，**不能用于承力设计**；
  真实弹簧按供应商实测替换（`part.json` 的 note 已写明）。

### 2.3 生成前门禁（C5）

- **`cad_part` `generate` 新增 `dryRun` / `preflight`**：
  - `dryRun: true`：编译 + 测量，**不落版本、不写图、不建零件行**；返回 watertight / bodies / bbox / min-wall。
  - `preflight: true`：只有网格闭合且**单实体**才写版本；薄壁 <1.2mm 只警告、不拒绝（合法的薄耳朵设计不被挡）。
  - 两者都不改变普通 `generate` 的默认行为；想保留“失败版本也进历史”的流程就不要加 `preflight`。
- `preflight` 的壁厚/悬垂屏幕走 Python `check_printability`（TS 实现已退役），每次多一次 worker 往返。

### 2.4 观测与面板（C3、C4、C9）

- **热力图可切换图层**：热力图开启时面板显示图层选择（融合风险 / 壁厚 / 悬垂 / von Mises），
  每层用自己的阈值、图例和来源 run；**一次只画一层，不相加成一个分数**。版本或 run 切换时清掉旧场，
  避免上一张图留在新网格上。
- **analyze 的融合峰带可执行下一跳**：每个峰现在有 `probe`（`measure` 的同一 Z 截面面积/孔/bbox）与
  `look`（`render_part` 的同一截面渲染）；峰仍是 detection，不是判定。
- **面板配色改为 CSS 变量，跟随宿主亮/暗主题**：`tokens.ts` 变成同键的 `LIGHT`/`DARK` 两张表，
  组件内联样式只写一次；`accept-tokens` 的“表外颜色字面量”预算降为 **0**，`accept-ui` 增加
  `theme-light` / `theme-dark` / `theme-dark-playback` 三个对比度场景。3D 场景色（零件蓝、标注色板、
  坐标轴、场地）不随主题翻转。

### 2.5 插件 issue 修复（C6）

2026-11-21 自行车后拨两次会话整理的 **P0-01–P3-15**，除两条外全部落地（详见
[PLUGIN-ISSUES-2026-11-21.md](../PLUGIN-ISSUES-2026-11-21.md)）：

| 用户可见 | 内容 |
|---|---|
| run 生命周期 | `cad_deliver` 新增 `retire` / `unretire`；audit 不再把已退役 run 计入 latest/failing/stale，失败 run 引用的版本全部被替代时不再算 current |
| 契约写入 | `cad_assembly write` 不再丢 `manufacturing` / `claims`，大装配不必退回 CLI + 手改 JSON |
| 打印性 | 实心锐边不再被当成薄壳；只有真实薄壁才报 |
| 车削 | 回转半径绕包围盒中心量，不再绕世界原点 |
| 装配位姿 | `validate.pose` 带绕 datum 的平移，不只是 3×3 |
| 应力 | 无支撑/网格过大在 30–60s 之前就报可读错误，不再 OOM 后才发现 |
| CadQuery | 版本 source 改为快照 + 串行锁，并行 generate 不再串味 |
| 运动行程 | `travelMm` 保留 warm-up 信息，`fullTravel` / `warmUpLost` 解释 5–8% 缺口 |
| CNC | `maxSetups` 语义修正；项目 profile 可按 id 加载；batch 收 `profilesJson` |
| 未声明邻接 | 新增 `suggest`，用现有 datums 给出可写条目，不再只能手写 52 条 |
| 改版后检查 | 新增 `affected`，回答“改了版本后该重跑哪些检查” |
| 内核切换 | 新增 `set_project_kernel`；文档说的 `code`/`scadCode` 二选一与工具面一致（两字段可共存） |
| 弹簧 | 库元数据补 k / 并圈高度；motion 对弹簧/接触/重力不声明时明确 capabilities |

**部分修：** P2-10 装配可装入性（已判封闭腔/大面积不可达，全序列插入检查未做）；
P3-15 参数/schema 小问题（`-0.0` 已修，`/tmp` 路径可见性属 harness core）。

### 2.6 示例（C8）

新增 4 个示例目录、2 个设计：

- **缝纫旋梭工作单元**（OpenSCAD + CadQuery 变体）：两轴布局、GT2 1:1、26mm 针杆行程；
- **三速后拨**（OpenSCAD + CadQuery 变体）：三档索引、CNC 自制 + 库内标准件。

证据（各 README 为准）：旋梭 check 36/36、motion 26.001mm / 0 干涉；CQ 旋梭 check 14/14、
motion 49 位姿 / 0 干涉；后拨 check 29/29、motion 24 位姿 / 0 干涉；CQ 后拨 check 62/62。

**展示策略（2026-11-25 用户）：进新退旧。** 新示例进入“当前示例”时，把等量或更老的示例移到
“历史 / 归档”表；**只改展示，不删除目录、语料或证据**。本版先移出
`ball-and-stick`、`multirotor-propeller`、`toy-balance2`；目录仍保留，需要时可直接打开。
`microscope5`（UI/交付测试依赖）、`roberval-balance` / `windup-frog`（关键证据）保留展示。

### 2.7 分发、CI 与 DSH 兼容（C10、C12）

- **CI 分档**：`push main` → fast + Ubuntu 全量；PR → 仅 fast；夜间 → Ubuntu+macOS 全量 + Windows smoke；
  tag `v0.*` → 全矩阵 + Windows smoke + CadQuery pack；外加 `concurrency` 取消与运行时缓存。
- **本地 DSH 矩阵**：13 个 in-range 0.2.x 已在 0.1.1-preview.1 那轮全量实测（12 PASS + 1 BLOCKED；
  0.2.3-alpha.1 上游 `dsh --version` 自身起不来，不算插件失败）。**0.1.2-preview.1 的全矩阵待重跑**，
  见 §5 与 [DSH-MATRIX.md](DSH-MATRIX.md)。
- **根 shim 版本同步**：仓库根 `package.json` 不再手写版本，由脚本从包同步，CI 每次 push 校验；
  `dsh plugin add github:songsenand/yingzao` 能解析到真实包。

### 2.8 维护性（C11）

- 退役 measure / assembly / motion / printability 的 TS parity 实现（约 2,000+ 行），
  生产路径统一走 Python；用 Python smoke、assembly golden、分支覆盖与 motion golden 兜住数值与分支。
- 报告语义修正：`check_assembly` 的“紧固”接口现在报 `diameter-match`，不再错报 `distance`——数字没错，
  但给人读的算子标签以前是错的。
- 双实现只剩必要兜底（fluid/MPM 的 env fallback、connectivity/SCAD 的 host/client 需要等）。

---

## 3. 已知问题（不阻塞 preview）

- **长任务**：后台 job 仍只覆盖 OpenSCAD 编译；渲染、仿真仍同步（N15）。
- **标准件目录**：99 specs / 14 families 随包分发，但**本版仍没有 `cad_part` 的 list/get/import-by-catalog**；
  `fit`/`visual` 不能通过工具选择，`assembly.json` 也没有结构化 `libraryRef`（L1.13）。
  需要某个目录件时，给出 `library/parts/.../fit/model.step` 路径走普通 `import`。
- **CadQuery**：pack 约 1.4–1.6 GiB，需显式安装（setup 不自动下载）；OpenSCAD 仍是渲染/导出的常驻依赖；
  pack 里的 VTK 不能当 headless 渲染器。
- **平台证据**：Linux 本机实跑；macOS/Windows 走 CI（tag 全矩阵；夜间也有 macOS 全量 + Windows smoke）。
  Windows 的 TTY 内核选择仍不在 CI，只覆盖 `--kernel` 参数路径。
- **DSH 版本**：0.2.3-alpha.1 上游 `dsh --version` 自身失败（`EntryValidationError` 缺导出），
  本版不承诺；其余 12 个 in-range 版本实测通过。
- **示例语料**：`examples/*/cad-data/` 仍被 gitignore；`windup-frog` 的 r064 整机演示未重跑，
  旋梭的钩尖—针眼时序脚本仍按旧 r024 布局（README §6）。
- **benchmark**：`examples/bench` 仍不是可比较基线（N=1、机检 0 通过、03 因 429 未完成）。
- **0.1.2 线剩余（不阻断本版）**：U01 视觉签收、U02 示例复现记录、L10 STEP 完整路径、N15 异步 render/sim、
  L1.13 目录工具入口、P2-10 全序列插入、L16 示例重跑；视口点选已延后（X14）。

---

## 4. 安装 / 升级

新装：

```bash
dsh plugin --profile <profile> add dsh-cad-harness
npx dsh-cad-setup --openscad=auto          # 交互式会询问内核；非交互默认 openscad
npx dsh-cad-doctor
```

从 0.1.1-preview.1 升级：

```bash
npx dsh-cad-setup      # 必须：按当前 dsh 重新生成预设
npx dsh-cad-doctor     # 期望 kind=ok；若报 preset-standard-drift，按提示重跑 setup
```

CadQuery 用户额外准备 pack（~1.6 GiB，不随包分发）：

```bash
DSH_CAD_CQ_PACK=/path/to/cadquery npx dsh-cad-backend --show
```

---

## 5. 发布前证据（2026-11-25）

| 门禁 | 结果（2026-11-25） |
|---|---|
| `accept:preview` 覆盖 | 44 个脚本（R5；本版 15 个验收全部接入）；`accept:release` = preview + `accept:step-validation` |
| Ubuntu `accept:preview` | **PASS** — [run 45645941780](https://github.com/songsenand/yingzao/actions/runs/45645941780)（含 `accept:plugin-add`、pack、解包 setup/doctor smoke） |
| macOS `accept:preview` | **PASS** — 同一 run / `macos-latest` |
| Windows install smoke | **PASS** — 同一 run / `windows-latest` |
| CadQuery job（`accept:cadquery` / `authoring` / `kernel-switch` / `step-validation`） | **PASS** — 同一 run |
| `accept:license` / `npm pack --dry-run` | `15/15`；651 files / **10.1 MB packed** / 34.1 MB unpacked（本机） |
| `npm publish --dry-run --tag preview` | exit 0（`prepublishOnly` + `prepack` + `postpack`） |
| DSH 13 版本矩阵 | **待普通终端重跑**（本沙箱无 systemd 用户总线，kern 起不来）；见 [DSH-MATRIX.md](DSH-MATRIX.md) |
| staged 批准 | 维护者手机 npmjs.com → Staged Packages → Approve（2026-11-26）；CLI token 只有 `package:write`，approve/reject 返回 404，直发 E409 |
| registry tarball 解包 smoke | **PASS**：下载 `0.1.2-preview.1` 的 shasum 与 npm 一致（`dbe385ed…`）；`setup --check` ok；`doctor` = `degraded`，唯一原因是本机 OpenSCAD 2021（warn，非 fail） |

> 发布时这一节不能留“待填”；任何一项没跑，发布说明必须写明原因，不允许用“本机绿”代替 tag 证据。

---

## 6. 发布步骤

```bash
cd dsh-cad-harness
npm run build
DSH_CAD_REQUIRE_CQ=1 DSH_CAD_CQ_PACK=/path/to/cadquery npm run accept:release
node scripts/sync-root-version.mjs --check
npm pack --dry-run
npm run rehearse:preview
npm publish --tag latest         # 预发布版本必须显式给 tag；本版要让 latest 指向 0.1.2-preview.1
```

> 预发布版本必须显式给 `--tag`；本版用 `latest`，与 0.1.1 的发布方式一致（`dsh plugin add
> dsh-cad-harness` 应装到本版）。如需 `preview` 别名，发布后执行
> `npm dist-tag add dsh-cad-harness@0.1.2-preview.1 preview`。
>
> 本机沙箱不能跑 `rehearse:preview` 的 pnpm 步骤；CI 的 Ubuntu job 已覆盖等价链路
> （build → `accept:preview` → pack → 解包 setup/doctor），见 §5。

发布后：

```bash
npm view dsh-cad-harness dist-tags
# latest 应为 0.1.2-preview.1；gitHead 与 tag v0.1.2-preview.1 相同
```

---

## 7. 与 0.1.1 的关系

- 引擎范围不变：OpenSCAD + CadQuery；0.1.1 的内核选择、会话内核对齐、统一 STL/STEP 验证全部保留。
- 0.1.1-preview.1 的“latest 是坏包”问题已经修复；本版**不是** 0.1.1 的修订版，而是下一个预览版。
- 0.1.1 明确不做的 U01/U02/L10/N15 等仍不做；本版只发已落地的改动，剩余项见 §3。

---

## 8. 发布记录与下次提示（2026-11-26）

- **已发布**：`0.1.2-preview.1`，`dist-tags.latest`；gitHead `d229536`（tag `v0.1.2-preview.1`），
  shasum `dbe385ed538c3ad3d332e345e920ca8af67e20d3`。
- **发布方式**：`npm stage publish` 把包放进 staging 后，由维护者在**手机** npmjs.com 的
  Staged Packages 里批准（2FA 指纹设备损坏，网页桌面 2FA 不可用）。
- **CLI 的限制**：现有 token 权限是 `package:write` + `bypass_2fa`；`npm stage approve` 与
  `npm stage reject` 都返回 404，直接 `npm publish` 因 staged 占用返回 E409。
- **中间插曲**：曾把版本提到 `0.1.2-preview.2` 并推送过 commit/tag，但 preview.2 未发布；
  确认 preview.1 已上线后，本地已回退到 preview.1（回退提交未推送远端；远端 `v0.1.2-preview.2`
  tag 仍存在，待允许推送时清理）。
- **下次提示**：发布前先问“能不能用手机 npmjs.com → Staged Packages 批准”。这比换 token、
  改版本号都快，也不会留下 staged 阻塞。
- **发布后验证**：`npm pack dsh-cad-harness@0.1.2-preview.1` 的 shasum 与 registry 一致；
  解包后 `setup --check` ok，`doctor` = degraded（仅本机 OpenSCAD 2021 的 warn）。
