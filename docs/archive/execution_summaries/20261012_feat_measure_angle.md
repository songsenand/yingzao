# 执行摘要：measure_angle（#2 前半）——夹角数学只实现一次

## 动机

用户反馈第 2 条：「夹角没有工具测量，一样先讨论再实现」。讨论后拍板的落点是
**worker 新 op**，并且**顺带把 `check_assembly` 的领域半区迁到 worker**——理由是
`coaxial` 算子已经在算"两轴夹角 + 轴线距离"，若新工具另写一份，两个数字迟早会打架。
本摘要覆盖 #2 的**前半**（新 op + 工具 + 验收）；后半（`check_assembly` 迁移）另记。

一个夹角最容易产生"你的数字和我的对不上"的来回：30° 与 150° 描述的是同一对直线，
而两面夹角是其法线夹角的补角。所以本工具的输出**把三个数一起给**，并写明约定。

## 影响范围

- `dsh-cad-harness/python/cad_worker/worker.py`：新增 `_axis_line_metrics`、`op_measure_angle`；
  `_snap_to_surface` 增加 `normal`/`faceId` 两个返回字段（探针形式需要"落到的那个面"的法线，
  取最近三角形**中心**在靠近棱边时会选到邻面）
- `dsh-cad-harness/src/host/tools.ts`：新增 `measure_angle` 工具（schema + datum 解析 + 转发）
  与 `MeasureAngleSolve` 接口
- `dsh-cad-harness/scripts/accept-measure-angle.mjs`（新，**27 项**）
- `dsh-cad-harness/scripts/accept-measure-angle-parity.mjs`（新，**3 项 / 39 用例**）
- `dsh-cad-harness/scripts/accept-p3.mjs`：新增 4 项走**真实工具对象**（probe / datum / 两种错误路径）
- `dsh-cad-harness/scripts/accept-tool-scope.mjs`：可见性夹具补四个新工具名
- `dsh-cad-harness/skills/cad-toolbox/SKILL.md`：路由表 + "Twenty-five tools"
- 文档：`docs/TOOL-RUNTIME-MATRIX.md`、`DESGIGN.md`、`HARNESS.md`、`experiments/` 无需新增，
  `examples/bench/README.md` 基准指纹重录

## 具体操作步骤

1. `worker.py`：`_axis_line_metrics(p1,d1,p2,d2)` 给出无向夹角、锐角、补角、线间距离、
   公垂线、交点；`op_measure_angle` 负责"三种命名一侧的方式"与约定文本。
2. `worker.py`：`OPS`/`HANDLERS`/docstring 登记 `measure_angle`（现 29 个 op）。
3. `tools.ts`：`measure_angle` 工具；datum 解析在 TS（store I/O），数学在 worker；
   `aSource`/`bSource` 由 TS 覆盖成 `datum axis "x" on vNNN`，因为"量的是哪块几何"是证据。
4. 验收：真值脚本（解析值 + 真实网格探针 + 错误路径）、parity 脚本（对 TS
   `axisLineDistance` oracle，39 用例含 30 组定种子伪随机斜交对）。

## 预期风险与验证

- **风险点 1：约定歧义**。已用"三个数一起给 + `convention` 字段随结果返回"消除；
  验收断言 `angleDeg + supplementDeg = 180` 且 `acuteDeg = min(...)` 恒成立。
- **风险点 2：探针落到错误的面**（点到开口里/贴着棱边）。已由 `_snap_to_surface` 的
  `faceId` 精确取面法线；验收里"同面不同点给同一角度"与"管壁 vs 端面 90°"各钉一条。
  实测踩过两次：夹具探针落在孔壁/端盖上，是夹具错、工具对。
- **风险点 3：`aDir` 只给方向不给点** → 两侧线都锚在原点，`coplanar`/`lineDistanceMm`
  描述的是锚点而非零件。已加 `anchoredAtOrigin` 标志 + 警告文本。
- **真缺陷（本批最重要的一条）**：`_axis_line_metrics` 的最近点符号约定写错，
  把**最远的一对**当成了最近的一对。证据：一个斜交用例实测报 `58.085mm`，而独立闭式
  `|w·(u1×u2)|/|u1×u2|` 与暴力扫描都给 `4.7245mm`；TS oracle 也是 4.7245 → **oracle 对、
  我的新代码错**。修正后 worker 与闭式一致到 1e-6。
  之所以此前没被发现：手工解析用例全是轴对齐的**对称**用例，符号错在对称下恰好抵消。
  已在真值脚本里补三条**非对称斜交**闭式用例（含一条我一度把期望值算错的：
  `|u1×u2| = sinθ` 这个因子不能忘，两条水平线相距 7mm 的答案就是 7，不是 7/√2）。
- **测试方式**：
  - `node scripts/accept-measure-angle.mjs`（**27 项全绿**）
  - `node scripts/accept-measure-angle-parity.mjs`（**39 用例**，worst Δdistance 4.9e-4mm /
    Δangle 4.9e-4°，落在 0.001 上报精度内）
  - `node scripts/accept-p3.mjs`（真实工具对象 4 项）
  - `node_modules/.bin/tsc --noEmit` 全清；`node esbuild.mjs` 双产物重建
