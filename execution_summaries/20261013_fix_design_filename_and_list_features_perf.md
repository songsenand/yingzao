# 执行摘要：`DESGIGN.md` 更正为 `DESIGN.md`；`list_features` 大网格首调 24–43s 的根因修复

## 动机
> 用户提出两件事：① 设计文档文件名拼错（`DESGIGN.md`），"太草台班子了"，要求更正；
> ② 追查 `list_features` 在 11–21MB 网格上单次 24–43s 的瓶颈。第 ② 件是 2026-10-11
> 执行摘要里明确留下未修的开放风险（"缓存只解决重复调用，首次调用仍昂贵"）。

## 影响范围
- 更名：`DESGIGN.md` → `DESIGN.md`（项目根）。
- 引用更新（活文档与代码，39 个文件）：`AGENTS.md`、`HARNESS.md`、`M4-PREP.md`、
  `M4-M5-REVIEW.md`、`ASSEMBLY-SCHEMA-PROPOSAL.md`、`DESIGN.md` 自身；
  `dsh-cad-harness/` 下 `src/host/**`、`src/client/**`、`src/shared/types.ts`、
  `scripts/accept-*.mjs`、`scripts/migrate-to-project-dir.mjs`、`cordis.patch.yml`、
  `sandbox/preview/{README.md,entry.tsx}`；`examples/*/PROJECT.md`、
  `examples/bench/graders/README.md`。
- 性能修复：`dsh-cad-harness/python/cad_worker/worker.py`（`_watertight_bad_edges`、
  新增 `_mesh_watertight`、`_ray_spans`、`op_list_features`、`op_measure_thickness`）。
- 新增：`experiments/scripts/probe_list_features_perf.py`、
  `experiments/20261013_list_features_watertight_cost.md`、
  `execution_summaries/20261013_fix_design_filename_and_list_features_perf.md`。
- 追加：`docs/DECISION-LOG.md`（2 条）。

## 具体操作步骤
1. **更名**：`git mv DESGIGN.md DESIGN.md`；`DESIGN.md` 文件头加一条映射说明
   （历史记录里的 `DESGIGN.md` 一律指本文件，**不回改**）。
2. **引用更新**：对"活文档 + 代码"清单内的 39 个文件做 `DESGIGN` → `DESIGN` 全量替换。
   **记录类文档保持原样**：`docs/DECISION-LOG.md` 既有条目、`execution_summaries/`、
   `experiments/*.md`、`verification/`（含 `microscope-transcript.md` 里 `ls` 的真实输出）、
   `examples/microscope/M1-RETROSPECTIVE.md`、`examples/*/execution_summaries/`。
   构建产物（`lib/**`、`sandbox/preview/dist/**`，均在 `.gitignore`）不手改。
3. **顺带修正**：`AGENTS.md` §3 的 `docs/DESIGN.md` → 项目根 `DESIGN.md`（前者从来不存在）。
4. **性能定位**：新增探针 `experiments/scripts/probe_list_features_perf.py`，
   直接调 `worker.op_list_features`（绕开 host IPC），支持 `--no-profile`（cold/warm 计时）
   与 `--legacy`（把修复前的两条代码路径装回去做同脚本对照）。`cProfile` 定位到
   `_watertight_bad_edges` 在 56.45s 里占 50.86s。
5. **修复一（根因）**：新增 `_mesh_watertight(mesh)` —— 严格水密测试**每个 mesh 对象算一次**
   并挂在该对象上；`_ray_spans`（原 `worker.py:1212` 每孔重算一次）、`op_list_features`、
   `op_measure_thickness` 改走它。**不做模块级 `id()` 键**：worker 长驻，地址复用会喂过期答案。
6. **修复二（原语）**：`_watertight_bad_edges` 改为**排序 + `searchsorted`**，
   替掉 `np.unique`（不带 `return_counts`）与 `np.isin` 的哈希路径。
7. **正确性对照**：新旧实现在 17 个用例上逐值比对（闭合/缺面/翻面/重复三角形/圆柱/
   icosphere/单三角形/退化/空面集/两面共边/6 组随机/真实 11.6MB 网格 v015），**0 处不一致**。
8. **回归**：`accept-list-features` 21/21、`accept-connectivity` 12/12、
   `accept-connectivity-parity` 21/21、`accept-measure-thickness` 22/22，
   另跑 `accept-p3`、`accept-printability-parity`、`accept-measure`（见"验证"）。

## 预期风险与验证
- **风险点**：
  1. 更名后历史记录里的 `DESGIGN.md` 成为"找不到的路径"——由 `DESIGN.md` 文件头的映射说明兜底，
     且 `git log --follow DESIGN.md` 保留完整历史。
  2. 水密性缓存若被绝对化（模块级 `id()` 键）会在长驻 worker 里返回过期答案——已刻意避开，
     缓存生命周期 = mesh 对象生命周期。
  3. `_watertight_bad_edges` 重写可能改变边界语义——已用旧实现逐值对照（含真值已知的
     翻面/缺面用例），并跑 `accept-connectivity-parity` 的判别性用例
     （"winding-flipped cube is NOT watertight"，明确验证 trimesh 的宽松判定会漏掉它）。
- **验证（实测）**：
  - 同脚本 legacy↔new 首次调用对照：v036 21.50MB/39 孔 **66.68s → 4.54s（14.7×）**；
    v023 11.10MB/50 孔 **36.29s → 3.03s（12.0×）**；v029 17.49MB/2 孔 5.81s → 3.17s；
    v015 11.61MB/2 孔 4.05s → 2.34s。**成本与孔数成正比、与三角形数无关**。
  - `grep -rl DESGIGN` 在活文档/代码内为 0 命中；记录类目录按清单保留。
- **未做**：剩余 ~4.5s 由 trimesh 的 `facets_boundary`（0.96s）与 975 条探针射线（1.5s）构成，
  属另一个量级；`README.md` 无需更新（纯内部实现优化 + 文件更名，不影响对外行为与启动流程）。
