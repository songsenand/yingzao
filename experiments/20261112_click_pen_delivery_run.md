# 实验报告：按动笔交付实跑（真实项目，不是探针）

## 目标

不再往核心里加字段，而是拿一个真实项目往交付方向跑一遍，记录它到底卡在哪。
样本：`examples/two-color-click-pen` 的副本（`.tmp/pen-run`），用 harness 自己的工具跑，
不改原项目。

## 假设

- H1：`verify` 给的第一条建议可以直接执行。
- H2：能在一个工作时段内把 `delivery` 从 blocked 推到 pass。

## 方法

1. 复制项目到 `.tmp/pen-run`（147 MB），工具 cwd 指向副本。
2. 用真实工具对象（`registerCadTools`）依次调用，不手改 JSON：
   - `write_assembly` 把 rotor 节点从 v085 移到最新版 v088；
   - `check_printability` 在 v088 上复现 make 的判定；
   - `check_assembly` 重新核对契约；
   - `set_datums` 修复 v088 丢失的锚点，再 `write_assembly`、`check_assembly`；
   - 最后 `verify` 看整体状态。
3. 失败步骤不绕过，记录原始报错。

驱动脚本：`dsh-cad-harness/scripts/experiment-pen-run-1.mjs`、`-2.mjs`（从 `dsh-cad-harness/` 运行）。

## 结果

| # | 步骤 | 结果 |
|---|---|---|
| 1 | `write_assembly` rotor v085 → v088 | **拒绝**：I3/I4/I9/I13 的 `axis`/`seat` 在 v088 里不存在（v088 不声明任何 datum） |
| 2 | `check_printability` v088（fdm-pla-0.4） | **excluded**：最薄 0.36mm（阈值 1.2），悬垂 217.8mm²，水密 |
| 3 | `check_assembly`（清单仍指 v085） | **fail**：17 接口 / 15 pass / 1 hard / 1 intent / 16 未声明；I3 硬冲突 = 引用的 r050 **已陈旧**（它验的是 v085，v088 已取代） |
| 4 | `set_datums` v088 | **成功**：生成 **v089**，网格与 v088 逐字节相同（同一 sha256），恢复 `axis/top/seat` |
| 5 | `write_assembly` rotor → v089 | **成功**：14 children / 17 interfaces |
| 6 | `check_assembly`（r059） | **仍 fail**：15 pass / 1 hard / 1 intent；I3 仍因“r050 验的是 v085”硬冲突 |
| 7 | `verify` | blocked：fit blocked、make fail、review 缺 1（v089）、delivery 缺 1（claim check） |

## 分析

### 1. “最新版”不等于“可用端点”

`contract-stale-nodes` 说“立柱/转子 v085→v088”，照做会失败：v088 是 v086/v087 两次实验后的
**回滚版本**（userIntent 写明“恢复已验证的 v085 几何”），保存时没有带上 datum。
证据层只比较版本号，分不清“更新且更好”和“更新但不可用”。

**这是真项目才有的坑**：合成探针里版本总是干净的。

### 2. 修一个锚点，代价是一个新版本

`set_datums` 按设计生成 v089（锚点是接口解析的对象，不能在原地改）。代价立刻出现：
v088 的视觉审查不再覆盖 v089 → `review` 从 pass 变成缺 1。
一行锚点修复，连带作废了该零件的审查、运动、打印证据。这个税是版本化设计的必然，
但当前没有任何地方提示“修锚点会作废哪些证据”。

### 3. 运动证据不可复现

I3 要重新引用一次 motion run，但 run store 只存了结果（`metrics/keyframes/trajectory`），
**没有存输入**（关节、驱动、采样数）。r050 的 `run.json` 只有 parts 和 sourceVersionIds。
所以“在新版本上重跑运动”不是重跑，而是重建机构规格。

`runs are immutable, self-describing` 这句在 motion 上不成立：它自描述的是**结果**，不是**做法**。

### 4. make 用的是另一把尺

项目声明 `injection-pp`，但 `check_printability` 只有 `fdm-pla-0.4` 这类已发布 profile。
0.36mm 壁厚对注塑 PP 未必是缺陷；217.8mm² 悬垂对注塑根本不是判据。
目录里 `injection-pp` 标的是 `support: partial`，inputs 要“polymer profile + min draft angle”，
但 shipped profile 里没有它。所以 `make fail` 目前不是设计结论，是**工艺判据缺位**。

### 5. 交付 claim 的检查不存在

唯一 claim 依赖 `pen-cam-timing`，而 `checks/pen-cam-timing/` 没有。`requirements` 却显示 pass
（它只检查 claim 可解析）。`delivery` 因此永远缺 1。

## 遇到的问题

- 本机没有注塑 profile，make 无法按声明工艺判；没有 motion 输入，I3 无法刷新。
- 副本的校验跑出了和原项目 r054 不同的数字（16 vs 15 未声明、I3 由 pass 变 hard），
  原因是 v088 的存在使 r050 陈旧——不是副本的问题，是“存在即取代”。
- `write_assembly` 的报错质量很好：直接列出 4 条解析不到的接口与版本，省掉一轮排查。

## 产物列表

- `.tmp/pen-run/` —— 项目副本（含 v089、r057–r059）
- `.tmp/pen-run-log.json`、`.tmp/pen-run2-log.json` —— 两次驱动的原始结果
- `dsh-cad-harness/scripts/experiment-pen-run-1.mjs` —— 步骤 1–3
- `dsh-cad-harness/scripts/experiment-pen-run-2.mjs` —— 步骤 4–6

复现：

```bash
cd dsh-cad-harness
cp -a ../examples/two-color-click-pen ../.tmp/pen-run
node scripts/experiment-pen-run-1.mjs
node scripts/experiment-pen-run-2.mjs
node scripts/verify.mjs ../.tmp/pen-run --advisory
```

## 结论与下一步

H1 被证伪：第一条建议不能直接执行。H2 未达成：4 个真实阻塞，都不是“核心缺字段”。

下一步按阻塞的所有者分：

1. ~~版本回滚丢锚点~~ **已定位并修**：`revertVersion` 本来就复制 datums；v088 是用
   “恢复 v085 几何”的源码重新 `generate_part` 出来的，源码里没有 `datum()` 调用。
   修法见下一节。
2. **修锚点的证据税**（产品缺口）→ `set_datums` 应回报“这次新版本会作废哪些 review/run”，
   而不是让 `verify` 事后发现。
3. ~~motion 输入不落盘~~ **已补**：每个 motion run 写 `motion-spec.json`，并提供
   `replay-motion.mjs`；旧 run 由 `motion-not-replayable` 标注（按动笔 8/8 属于旧 run）。
4. ~~注塑 profile 缺失~~ **已补**，~~draft 求解器在密网格上超时~~ **已修**：
   密网格改为采样估计（3.1s），小法线数仍做穷尽证明。复杂件现在判“困难（采样）”，不是“未判定”。
5. **cam-timing check 缺失**（项目工作）→ 写 `checks/pen-cam-timing/` 或从 claim 去掉 `checkId`。

## 修复（同日）

**A. 保存时丢锚点不再静默**（`version.ts` + `tools.ts`）

- 新增 `datumDriftForPart(store, partId, incoming)`：找同一零件最近一个“有锚点”的版本，比对即将写入的名称。
- `generate_part` 保存前调用；缺锚点时在 `warnings` 里写：
  `anchors missing: axis:axis, plane:seat — last declared on v085. Interfaces naming them will stop resolving; …`
- 保存仍然允许（重命名锚点必须可做），但不再是静默行为。

**C. 锚点修复会预告它作废了什么**（`tools.ts` 的 `set_datums`）

- 新版本产生后，回报里直接写：
  - `${n} run(s) cite v088; they describe the previous anchors, not v089 — re-run …`；
  - `v088 had a visual review; v089 has none — review the new version before delivery.`
- 这就是实跑第 4–7 步的“证据税”：一行锚点修复让审查从 pass 变缺 1，但原来要等 `verify` 才发现。

**D. 注塑尺子到位**（`schemas/examples/injection-pp.json` + `worker.py` + `tools.ts`）

- 新增 shipped profile `injection-pp`（11 条规则）：壁厚 0.8、特征 0.5、间隙 0.3、拔模 ≥1°、孔深径比 ≤4；
  **悬垂 / 桥接 / 排气 / 刀具半径显式不适用**（`applies:false` + 理由），不再是“设为 0”。
- 修了 `applies:false` 没有传到测量的漏洞：原来 profile 说悬垂不适用，工具仍用默认 45° 判，
  并照样输出“需要支撑”。现在 `overhangDeg: null` 一路传到 Python worker，悬垂面积记 0、不出 finding。
- 拔模求解器改为 45s 预算：超时记 **未判定**（并说明“这不是通过”），不再让整个检查失败。

实测（rotor v089，同一网格）：

| profile | 时间 | verdict | 关键 finding |
|---|---|---|---|
| fdm-pla-0.4 | ~40s | **excluded** | 悬垂 217.8mm²、壁厚 0.36（薄区 19.4%） |
| injection-pp | 47s | **difficult** | 壁厚 0.36（薄区 **4.0%**）；悬垂 0（不适用）；拔模未判定（45s 超时） |

判决从“悬垂导致不能做”变成“0.36mm 壁厚 + 拔模未知”——前者是尺子错，后者是真问题。

**E. draft 求解器：密网格不再超时**（`worker.py` + `tools.ts`）

原来一条路走到黑：枚举所有法线两两求交（O(k²)）。rotor 有 1529 个不同法线，
k²≈4.7M，45s 都跑不完。

改成三段：

1. **法线中心**（精确、便宜）：任何一条“沿面法线”的抽芯方向若能满足所有面，锥非空，
   一个反例就够；rotor 0.03s 判完“没有中心可行”。
2. **精确枚举**（仅当 k ≤ 400）：保留原来的“中心 + 两两圆交点”穷尽判定，
   cube/45° 这类空锥仍能被**证明**并排除。
3. **采样球面**（密网格）：8000 个方向 × 全部法线（12M 次），找不到可行方向就报
   “采样的抽芯方向里没有一条满足”，并标记 `proven:false` —— 估计，不是证明。

实测：rotor 47s（且超时）→ **3.1s**；cap 2.6s → **0.32s**。rotor 的结论从
“拔模未判定”变成“最好方向最差面拔模 0.49°，要求 1°，差 0.508°”，并给出收紧它的面坐标。

诚实的边界：密网格上没有“空锥证明”，只有“采样没找到”。要升级成证明，需要把
法线分箱做得更粗、或换 LP/半空间求交；当前选择的代价是复杂件判“困难”而不是“排除”。

**F. motion 输入落盘，可重放**（`tools.ts` + `scripts/replay-motion.mjs`）

- 每个 motion run 现在写 `runs/<id>/motion-spec.json`：parts（版本或内联代码）、放置、
  joints、drive、oscillators、cycles、sourceVersionIds。
- 新增 `scripts/replay-motion.mjs <project> <runId> --set part=vNNN`：读 spec、替换版本、
  走正常 `simulate_motion` 路径，产出新 run + 新 spec。
- `verify` 对没有 spec 的旧 motion run 报 `motion-not-replayable`（info，带 run id），
  不再让人以为“重跑”随时可行。按动笔语料：8/8 motion run 都是旧的，全部不可重放。

实跑验证：用 barrel_rear v062 + rotor v089 建了一个最小机构（r067），spec 落盘；
`replay-motion r067 --set rotor=v085` 生成 **r068**，`sourceVersionIds=[v062,v085]`，
status pass、干涉 0、采样满足。

**B. “移到最新版”不再指向死路**（`delivery-audit.ts`）

- `contract-stale-nodes` 现在会读最新版本的 datums；为 0 时直接标注：

```text
旋转凸轮 v085→v088 (newest declares no datums — declare anchors before moving the contract)
```

这正是实跑第 1 步撞上的墙：证据层原来只说“→v088”，现在会先说“v088 不是合法端点”。

**验证：**

- `accept-set-datums-versioned` 新增：丢锚点时报出 `versionId` 与缺失名；保留时不报。
- `accept-delivery-audit` 新增：按动笔语料上 stale node 的 `newestDatums === 0`，且 finding 文案包含
  “declares no datums”。
- `verify ../examples/two-color-click-pen` 实跑确认该文案出现。
- `accept-verify / fit-observer / interface-ledger / icd / write-assembly / project-standards /
  row-regressions` 全过；`tsc --noEmit` 0。
