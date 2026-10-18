# 执行摘要：把通道瓶颈接进 `escapePassageMinMm`（含步长修复）

## 动机
> `op_passage_bottleneck` 骨架已落地并验收（14 条）。本轮把它接进规则层，并修掉接线前发现的
> 两个真实缺陷：① 走查步长按**整个零件的量程**算（`span/20`），在真实件上**一步跨过 3mm 的壁**
> ⇒ 非圆贯通孔被误判成"死胡同"；② 规则层的 `holes` 用 `typeof h.diameterMm === 'number'` 过滤，
> 而**非圆孔按设计没有 `diameterMm`** ⇒ 非圆通道根本没进规则（规则里那个"非圆 ⇒ 未判定"的分支
> 是**死代码**，实际是**静默缺席**）。实测 microscope4 v031：53 个孔里 **32 个非圆**。

## 影响范围
- `dsh-cad-harness/python/cad_worker/worker.py`：`op_passage_bottleneck` 的步长改为**按开口自身
  尺度**取（新增可选 `fromSizeMm`），并回报覆盖率（`stepMm` / `coveredMm` / `endsAtSurface`）。
- `dsh-cad-harness/src/host/tools.ts`：`check_printability` 里让非圆孔进入规则；`escapePassageMinMm`
  对**非圆 + 贯通**的开口调用该 op，量到的半径参与判定并报余量；拒绝时保持"未判定"。
- **不动**：`tools.ts` 的工具注册表（op 仍然只给宿主内部调用）；`toolRadiusMm` 的非圆那一半
  （它的特征集是 `bores`（圆柱），非圆槽要进那条规则涉及"刀具必须够到哪些特征"的规则语义，
  属另一个决策，本轮不做，留记录）。
- 记录：本摘要 + 实验报告补一节 + 验收。
- **行为变化（必须显式声明）**：此前"非圆通道"既不判过也不判不过（静默缺席）；此后它会被**测量**，
  于是**可能新增排除**。方向是有意的（真窄的非圆通道本来就该排除），但这是行为变化，
  必须靠验收钉住"不许假排除"。

## 具体操作步骤
1. **步长按开口尺度**：`step = clamp(fromSizeMm / 6, span/400, span/20)`；`fromSizeMm` 缺省取
   `span/50`。调用方（宿主）有开口的面积（`list_features` 的 `areaMm2`），传 `sqrt(area)`。
   小件行为与现状一致（台架 9 件真值不变），大件不再跨过薄壁。
2. **覆盖率回报**：`stepMm`、`coveredMm`（两端已走到的范围）、`endsAtSurface`；`throughAlongAxis`
   只在**两端都走到表面**时为真。**只要有一个可用截面就能出"太窄"的证据**（下界性质），
   所以覆盖不全不会造成假排除，只会漏报 —— 但必须披露。
3. **宿主放行非圆孔**：过滤器改为"有 `centerMm` + `axisMm` 即可"，`diameterMm` 变为可选；
   `HoleInfo` 增加 `axisMm`、`areaMm2`。
4. **规则接线**（`escapePassageMinMm`）：非圆 + `through === true` ⇒
   `request('passage_bottleneck', {path, fromMm: centerMm, fromAxis: axisMm, fromSizeMm})`：
   - `reachable` ⇒ 量得半径 → 与要求半径比，**报余量**；低于"要求 − 噪声带"⇒ 出 witness
     （`measured` = 直径，与圆孔那条一致），落入噪声带 ⇒ 记"困难，不是通过"；
   - 拒绝 ⇒ 保持**未判定**，并把 op 的 `refused` 原因写进说明。
   噪声带取 `max(op.micToleranceMm, 0.01)`——沿用圆孔那条"不确定性来自测量本身而不是编造的容差"。
5. **验收**：`probe_passage_bottleneck.py`（14 条）重跑；真实件 microscope4 v031 的 h48/h49
   必须量出数而不是拒绝；`accept-p3` 的排液通道用例全绿；新增一条**非圆贯通槽**的用例，
   要求"窄于要求 ⇒ 出 witness、宽于要求 ⇒ 不出 witness 且不再是未判定"。

## 预期风险与验证

### 接线前先修掉的四个真实缺陷（都在真实件或验收上暴露）
1. **步长按整个零件的量程算**（`span/20`）：microscope4 v031 上约 10mm，**一步跨过 3mm 的壁**，
   两个真贯通孔（h48/h49）被误判成"死胡同"。改为按**开口自身尺度**取（`fromSizeMm`，宿主用
   `sqrt(areaMm2)` 传进来），span 只兜底上下限。
2. **"到头"判据被零件的角料骗**：原来用"这一刀还切不切到零件"，而斜孔出零件后平面还会切角
   （03-tilted-bore 实测约 2mm）。先改成"把中心往外推几档问实体"，又栽在"孔内不是实体"上
   （A′ 的盲孔因此被判成贯通）。最终改成**从最后一个在空隙里的点沿轴射线**：
   0 次相交 ⇒ 出到表面；≥1 次 ⇒ 材料内部断掉。
3. **射线撞在三角形顶点上会整个漏检**（盲孔底的圆心正是一圈扇形的顶点）：实测报 0 次相交。
   按 DESIGN §13.8b 既有处置，用**一簇微偏移探针取中位数**。另有两次自伤：回退逻辑把站位算回
   上一刀同一位置（死循环式蠕变，119 刀几乎原地）、射线方向忘了跟"这一趟的方向"。
4. **"那个方向本来就没有通路" ≠ 死胡同**：h48 的锚点在**内部台阶面**上，通路朝上 5 刀出到表面，
   朝下那侧根本是料（0 个截面）。判据改成**只统计真正有截面的方向**：一侧有截面并走到表面
   就算走完；有截面的方向在材料内部断掉才是死胡同（此时拒绝出数）。

### 规则层（`escapePassageMinMm`）
- **此前非圆通道是静默缺席**：`holes` 被 `typeof h.diameterMm === 'number'` 过滤，而非圆孔按设计
  没有直径，于是规则里那个"非圆 ⇒ 未判定"的分支是死代码。实测 microscope4 v031：53 个孔里
  **32 个非圆**，一个都没进规则。现在它们带着 `axisMm`/`areaMm2` 一起进来。
- **非圆 + 贯通** ⇒ 调用 `passage_bottleneck`（锚点 = 该开口的 `centerMm` + `axisMm`，
  `fromSizeMm = sqrt(areaMm2)`，`budget = 200`）：
  只有 `reachable && throughAlongAxis` 才用这个数出 witness（与圆孔同一条余量规则：
  噪声带 = `max(micToleranceMm, 0.01)`）；拒绝或没走完 ⇒ **未判定**并写明原因，绝不当通过。
- **锚点要求**：开口必须是**平面面内部的闭环**。验收时踩到：1.5×40 的槽在 20mm 的块上，
  开口一直通到面的边缘 ⇒ `list_features` 报 0 个孔（不是闭合环）。夹具改成 1.5×8 后正常。

### 验证（全部实跑）
- `experiments/scripts/probe_passage_bottleneck.py`：**14 条断言全过**（9 个已知件 + 复合 A/A′/B）。
- 真实件 microscope4 v031：h48/h49（面积 11.56mm² 的非圆贯通孔）**reachable=True、r=1.7、
  走完=True、约 0.5s/个**（此前 3 刀就拒绝）。h6（7000mm² 的宽腔口）仍拒绝——见"已知弱点"。
- `accept-p3` 新增 2 条：**非圆贯通槽窄于要求 ⇒ 出 witness（`measured 1.5`、带位置）**；
  宽槽 ⇒ 不排除。**P3 ACCEPTANCE PASSED**。
- 回归：`accept-printability-parity`、`accept-process-profiles`、`accept-list-features`、
  `accept-python-worker`、`accept-tool-scope`、`accept-measure-section` 全 exit 0。

### 已知弱点（已记录，不许静默）
- **宽开口给粗步长**：h6（7000mm² 的腔口）按开口尺度得步长 13.9mm，一步跨过 4mm 深的腔，
  于是拒绝出数。规则只对 `through` 孔调用它，所以不在当前关键路径上；要覆盖它得让调用方
  传更小的 `fromSizeMm`（例如按"要求宽度"给），或让 op 自己按第一刀截面重新标定。
- 走查步长可能跨过一段很短的颈（采样问题）：输出带 `sectionsAccepted`/`coveredMm`，
  且规则要求 `throughAlongAxis` 才出 witness，所以覆盖不全只会漏报、不会假排除。
- 曲面上的开口、一个开口通向两条路、多条隧道无法配对：一律未判定（不猜）。
