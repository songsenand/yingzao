# 执行摘要：纪律补齐（实验记录 / 决策 / 文档同步）与两处性能修正

## 动机
> 本会话（工艺档案 S1、封闭内腔 S2-a、通道 S2-b、拔模 S3、刀具可达 S4、档案撰写规范 S5）
> 改动量大，但**交付纪律没做全**：探针是临时 heredoc 跑的（不可复现）、几条用户拍板的决策没进
> 决策记录、新架构没进设计文档、且引入了两处可避免的成本。用户指出上下文预算充足、纪律要执行。

## 影响范围
- 新增：`experiments/scripts/probe_void_reach.py`、`experiments/scripts/probe_draft_cone.py`、
  `experiments/20261011_void_reachability_and_draft_cone.md`
- 追加：`docs/DECISION-LOG.md`（4 条）、`DESGIGN.md`（§27）、
  `execution_summaries/20261011_feat_process_profile_elimination.md`
- 修改：`dsh-cad-harness/src/host/tools.ts`（描述瘦身 + 按版本缓存）、
  `dsh-cad-harness/scripts/accept-python.mjs`（过时断言改为按名字断言）

## 具体操作步骤
1. **实验记录**：把两个探针从 heredoc 落成可复现脚本，并把**错误/被撤回的实现**（BUG1 `dt<r`、
   BUG2 菱形膨胀、变体 A 26 方向搜索、变体 B 只查成对）写成脚本内的阴性对照；报告按
   AGENTS.md §4 结构（目标/假设/方法/结果/分析/问题/产物/结论），数字全部来自脚本实跑输出。
2. **决策记录**：补 4 条 —— ① S2-b 通道判定（A + 深度判据 + 通路条件，用户拍板）；
   ② "先问哪一侧可证"；③ S3 改为完备盖交枚举（成对矛盾充分但不完备，用户质疑触发）；
   ④ 工具描述与 skill 的分工 + 按版本缓存（数据支撑）。
3. **文档同步**：`DESGIGN.md` 追加 §27（工艺档案与判定层的架构、四条不可协商、余量纪律、
   各规则"能证明什么"、代码落点与验收）。`DESGIGN.md` **不改名**——它被 10+ 处引用
   （examples/HARNESS/experiments），改名风险大于收益；已记入交付说明。
4. **测试维护**：`accept-python.mjs` 的"eight dependencies are pinned"过时（`shapely` 加入后
   实为 9 个）⇒ 改为**按名字断言**期望集合，数量不再硬编码（数量分不出"漏一个"和"多一个"，
   且一加依赖就过时）。
5. **性能修正**：① `check_printability` 描述瘦身（解释已在 skill）；② `list_features` 与
   `connectivity` 按 `${store.root}::${versionId}` 缓存（依据：版本不可变）。

## 预期风险与验证
- **风险点**：描述瘦身可能删掉调用时必需的信息；缓存可能因"版本可变"而不安全。
- **验证**：
  - 无任何断言依赖被删的描述文字（先 grep 确认）；瘦身后 `accept-p3` 89/89、
    `accept-tool-scope` 34/34、`accept-process-profiles` 27/27、`accept-printability-parity` 45/45 全绿。
  - 缓存安全性来自语料不变式（已保存版本的 `model.stl` 永不改变）；实测收益：
    21.50MB 零件上 `list_features` 单次 **42.79s**、`connectivity` 1.61s ⇒ 重复调用省 **44.40s**。
  - `accept-python --quick`：**all checks passed**（含修好的依赖断言）。
  - 全套验收（50 个脚本）：除两个**测试脚手架进程挂住**（`accept-inspect`、`accept-m3` ——
    两者都打印了 PASSED 却不退出，且都不调用本轮改动的代码）之外全绿。
  - **交付审计**（`delivery_audit`）：**BLOCKED**，原因是**用户已明确推迟的旧零件清理**
    （14 个零件最新版本无 run 检查、38/46 版本从未被引用、4 个契约节点指向被替换版本），
    与本轮改动无关。
- **未修并记录**：`list_features` 在 11–21MB 网格上单次 24–43s；缓存只解决重复调用，
  首次调用仍昂贵。
