# 执行摘要：体素引擎 `tightestPassageRadiusMm` 的 1.600mm 平台真因定位

## 动机
> 2026-10-11 把一条开放风险留在记录里：`op_void_reach` 的 `tightestPassageRadiusMm` 对
> 3.0/4.0/6.0mm 贯槽全部返回 **1.600**，真因未定位（当时首要嫌疑是 `ceil(mid/pitch)` 取整台阶，
> 更早还归因于 padding）。用户要求查清。这是接线余量半边的唯一拦路石。

## 影响范围
- 修改：`dsh-cad-harness/python/cad_worker/worker.py`（`op_void_reach`：docstring、
  `centerMm`、`tightest` 拒绝上报、返回契约）。
- 新增：`experiments/scripts/probe_void_reach_tightest.py`、
  `experiments/20261013_void_reach_tightest_plateau.md`、
  `execution_summaries/20261013_fix_void_reach_tightest_plateau.md`。
- 追加：`docs/DECISION-LOG.md`（1 条）。
- **未动**：任何工具接线（引擎继续挂起）、规则层、其他 op。
- **不回改**：`experiments/20261011_void_reachability_and_draft_cone.md` 与同名执行摘要里的
  "真因未定位"属当时记录，由本轮报告与决策条目关闭。

## 具体操作步骤
1. **建探针**：`experiments/scripts/probe_void_reach_tightest.py`，六步——A 逐步谓词表、
   B 把结构元半径与门限**解耦**、C 把残余换算回 mesh 坐标定位、D 换 L∞ 结构元、E 换圆截面通道、
   F 在"恰好塞满"处扫描排除半边。旧实现 `tightest_with()` 保留在脚本里作为对照，所以 op 改成
   拒绝上报后仍能复现 1.600。
2. **定位真因**：谓词是"球的扫掠是否还留下 ≥2 体素残片"；对任何带角截面（含体素化曲面的阶梯）
   该残片在**任何半径下**都存在且随半径增厚 ⇒ 它测的是**角的锐利度**，不是通道宽度。翻转被
   `dt ≥ mid` 与 `ceil(mid/pitch)` 的 pitch 量化钉在 1.600 = 8 × 0.2，且因直角缺口只取决于半径
   而与通道宽度无关。
3. **推翻两个旧归因**：解耦实验显示 `mid=1.600` 时结构元加到 9 仍为 0、`mid=1.601` 时压回 8
   仍翻转 ⇒ 不是 `ceil` 台阶；padding 修好后值未变 ⇒ 不是 padding。源码注释一并更正。
4. **修 `centerMm`**：漏了 voxel grid 的 `origin`（= mesh AABB 最小值），本夹具 `(−10,−10,−5)`；
   0.8mm 槽的腔心此前报 `(10,0,5)`，现为 `(0,0,0)`。
5. **余量半边改为拒绝上报**：`tightestPassageRadiusMm: null` + `tightestUnavailable` 原因串
   （指向实验报告），删除 `tightestSearchCeilingMm`。规则层要余量时用每区域的
   `bottleneckRadiusMm`（按构造无角）。
6. **披露排除半边的可信包络**：op docstring 写明 2 体素噪声地板不随半径缩放，超出包络会产生
   小区域 + 小瓶颈的假排除（附实测数字）。
7. **记录**：实验报告 + DECISION-LOG 条目。

## 预期风险与验证
- **风险点**：
  1. 该 op **未被任何工具调用**（引擎挂起），改动无运行时影响；但输出契约变了
     （去掉 `tightestSearchCeilingMm`、新增 `tightestUnavailable`），将来接线时需按新契约取字段。
  2. 拒绝上报会让"余量半边"在下一次接线时**缺一个数**——这是有意的：缺一个数好过报一个错数。
     恢复它需要先定无角定义（三种候选已写入决策条目）。
  3. 排除半边未改行为，只加了披露；它的假排除包络是**已知未解**问题，不因本轮而消失。
- **验证**：
  - 语法与 worker 加载：`ast.parse` 通过；探针直接 import `cad_worker.worker` 并调用成功。
  - 已知答案回归（`experiments/scripts/probe_void_reach.py`，与 2026-10-11 同夹具同判据）：
    `0.8mm 槽 → 20.952mm³ / 1 区域 / 瓶颈 0.400mm`（排除）、`3.0mm → 0`（零间隙）、
    `4.0mm → 0`（不排除）；阴性对照 BUG1/BUG2 输出不变。
  - 平台复现：新探针 A/B/C/D/E 五节给出 1.600（球）vs 1.998/2.997（立方）vs 1.397/1.887/2.883
    （圆槽），残余 100% 在四角。
  - `centerMm` 修正：0.8mm 槽报 `(0,0,0)`，体积/瓶颈与 2026-10-11 记档一致。
  - 无验收脚本覆盖该 op（`grep -rn void_reach --include=*.mjs` 为空），故无需改验收。
- **未做（需决策）**：余量半边的无角定义（凸包内 `max dt` / dt 脊线 `min dt` / maximin）；
  排除半边的噪声地板是否随半径缩放；以及是否接线到 `toolRadiusMm` / `escapePassageMinMm`。
