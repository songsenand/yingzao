# 执行摘要：bench 06 纯测量问答（出题第一步）

## 动机

用户要求补全题库，顺序 **06 → 04 → 05**。06 是"纯测量问答"，不依赖第三方语料，
且它现在是**唯一能把本轮新增测量工具（`list_features` / `measure_thickness` /
`measure_section` / `measure_extent` / `measure_angle`）的可用性变成分数**的题——
这五个工具此前**从未进过沙箱**（见下"已核实的事实"）。

## 影响范围

- `examples/bench/subjects/06-measure/TASK.md`（新，考生题面）
- `examples/bench/graders/06-measure/prompt.md`（新，操作者说明）
- `examples/bench/tools/bench-score.mjs`（新增 06 的求值器 + 两处缺陷修正）
- `docs/DECISION-LOG.md`（语料授权路径定案，另一次提交）
- 待补：`graders/06-measure/{part.scad, build-parts.mjs, ground-truth.mjs,
  ground-truth.json, rubric.json, key.md}` + bench README 的表 1–4 与 §九

## 具体操作步骤

1. 题面：给**两个同件的 STL**（`part.stl` / `part-b.stl`，后者只改一处），
   没有图纸、没有源码、没有参数表；要求用 CAD 工具量出孔/孔径/孔心距/壁厚/夹角
   （**必须声明报的是锐角还是补角**）/按轴起止/对角线/剖面数字，并写机读
   `measure.json`。
2. **阴性对照内建在题面里**：`part-b` 与 `part` 的差值必须由同一套测量口径得出，
   所以"看渲染猜数"或"抄一个像样的值"会在第二件上暴露。
3. `bench-score.mjs`：新增 10 条求值器，**全部从 `graders/06-measure/ground-truth.json`
   取数**（判据、求值器、key.md 三处不各抄一份数字）：
   `g-measure-json` / `g-tools-not-bypassed` / `g-no-invented-numbers` /
   `g-delta-correct` / `g-negative-control-fires` +
   `c-cylinder-count` / `c-tube-wall` / `c-hole-centre-distance` / `c-slope-angle` /
   `c-diagonal-extent` / `c-section-hole-distance` / `c-section-area`。

## 预期风险与验证

- **真空机检风险（本题最大的风险）**：若真值来自推断而不是实测，判据就是空的。
  处置：`ground-truth.json` **只能由工具实测生成**（`ground-truth.mjs`），
  且求值器缺真值时判 `unknown`（**绝不把没实现的条目算成通过**，沿用 bench-score 立场）。
- **我自己在写求值器时引入的两个缺陷（已修）**：
  1. `g-no-invented-numbers` 里的过滤写成 `... || true`，等于空操作——会把
     `axis` / `atZMm` / `angleConvention` 这类**非测量字段**判成"编造的数字"。
  2. `c-diagonal-extent` 只认 `part.extentDiagonalMm.lengthMm`，而题面要考生报
     `min`/`max` → 永远 mismatch。已改为两条路都认（`lengthMm` 或 `max − min`）。
- **回归验证**：`bench-score.mjs` 改动后在**真实 run root**（`~/bench-runs/01b-base01`）
  上复跑，六列与覆盖缺口与改动前一致（**自动判定 11/14**），确认没有破坏既有题目评分。
- **尚未验证（明确记录）**：06 本体还没跑过沙箱；件与真值仍在造（见下）。

## 已核实的事实（用于回答"这些工具进过沙箱吗"）

- `~/bench-runs/` 下 4 个历史 run root（`01-base01` / `01b-base01` / `02-base01` /
  `02-fix1`）里，五个新工具名**命中 0 个文件**；同期 `measure_distance` 命中 3 个、
  `measure_part` 命中 11 个 → 新工具**从未在会话里被调用过**。
- `00-smoke` 的 6 条数值判据是 `c-measure-part` / `c-measure-close` /
  `c-connectivity` / `c-printability-thin` / `c-interference` / `c-fluid-arrival`，
  rubric 文本只提到 `measure_closest` / `measure_distance` / `measure_part`
  → **仪器自检也不覆盖新工具**。
- 因此：五个工具目前只有**验收级**证据（真值/parity + 工具层转发），
  **没有沙箱级证据**（日志检查、视觉检查都没有）。

## 下一步

1. 完成 06 的件与真值（进行中：子代理在测 `$fn=N` 圆柱顶点是否落在 +x 这类退化，
   正是 `measure_thickness` 多探针投票要处理的场景），然后写 `ground-truth.json`、
   `rubric.json`、`key.md`、bench README 表 1–4 与 §九。
2. **真跑一轮 06**（`tools/bench-run.mjs`，run root 在仓库外）——这才是这五个工具的
   第一次沙箱日志检查；视觉检查需要 GUI 档或人眼。
3. 之后按 04 → 05 出题；两者走"物化脚本 + 钉 commit 不入库"（决策已记）。
