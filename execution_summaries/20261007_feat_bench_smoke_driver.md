# 执行摘要：落地 00-smoke 仪器校准（重建 bundle + bench-smoke.mjs）

## 动机

用户要求"检查是否符合开展评测的前置条件，如果已达到条件请进行 00-smoke 测试"。
核查结论是**未满足**，两条硬阻塞：

- **B1**：`00-smoke` 的 driver `bench-smoke.mjs` 不存在（根 `README.md` §7 标为
  "待实现"，`graders/README.md` §九 标为 ⏳）。没有 driver 就没有可执行的东西。
- **B2**：SUT 实际加载的产物 `dsh-cad-harness/lib/index.js`（构建于 2026-10-05 13:31）
  **早于** `src/host/compile.ts` 的 BOSL2 修复（2026-10-05 21:28）。bundle 里仍是旧逻辑
  `OPENSCADPATH = <repo>/lib/BOSL2`（指向 BOSL2 目录**自身**），而 `include <BOSL2/std.scad>`
  需要其**父目录**。实测 `lib/BOSL2/std.scad` 存在、`lib/BOSL2/BOSL2/std.scad` 不存在
  ⇒ `g-openSCADPATH` 与 `g-bosl2-gears` 两条硬门必挂。修复只在源码侧被
  `accept-bosl2.mjs` 验证过（直接 import `.ts`），**发货的 bundle 从未重建**。

这正是 00-smoke 存在的理由：一次插件接线 bug 会被记成模型的短板。

用户拍板：**重建 bundle + 实现 bench-smoke.mjs + 跑 00-smoke**；
driver **留在题库侧** `examples/bench/graders/00-smoke/`（§九 待办 2）。

## 影响范围

- `dsh-cad-harness/lib/index.js`（重建产物，未入库；`package.json` 的 `main`/`exports` 指向它）
- `examples/bench/graders/00-smoke/bench-smoke.mjs`（新增）
- `examples/bench/graders/00-smoke/rubric.json`（§九 待办 1：中性化 `g-delivery-audit.evidence`）
- `examples/bench/README.md` §7、`examples/bench/graders/README.md` §九（命令路径与状态）
- `docs/DECISION-LOG.md`（归属决策，第 22 条）

## 具体操作步骤

1. 新增 `execution_summaries/20261007_feat_bench_smoke_driver.md`（本文件）。
2. `docs/DECISION-LOG.md` 追加第 22 条：`bench-smoke.mjs` 归属题库侧。
3. `node esbuild.mjs` 重建 `lib/`；断言 `lib/index.js` 含 `bosl2Roots` 双深度逻辑
   且不再出现 `bosl2Dir`。
4. 新增 `examples/bench/graders/00-smoke/bench-smoke.mjs`：
   - 读同级 `rubric.json` 作为期望行为表（唯一权威副本，不复制判据）；
   - 构造最小 mock `ctx`（`tools.register` / `attachments.saveImages` / `reflect.get`
     / `effect` / `on` / `logger`），直接 `registerCadTools` 取回 18 个工具定义，
     以 `exec = { agent: { session: { header: { cwd: <temp> } } }, signal }` 驱动；
   - 逐步执行 rubric 的 13 硬门 + 6 数值，逐条打印 `PASS/FAIL` 与实测值；
   - 任一硬门不过 → 退出码 1，并打印"先修插件，再跑评测题"。
5. 跑 `node examples/bench/graders/00-smoke/bench-smoke.mjs`，迭代到全绿或定位真实缺陷。
6. §九 待办 1：改 `g-delivery-audit.evidence` 为工具层面因果（按 §四 写法约定）。
7. §九 待办 3：逐条确认 19 条的 `evidence` → `accept-*.mjs` 映射。
8. 文档同步：根 `README.md` §7 命令路径、`graders/README.md` §九 状态表。

## 预期风险与验证

- **风险点 1：重建 bundle 改变 SUT。** `lib/` 未入库（`git ls-files` 0 个），属常规
  构建步骤，不动 §2 冻结的 commit / `SKILL.md` sha256 / 考卷指纹。
  **验证：重建后重跑 `sha256sum`，`SKILL.md` 仍为 `8e2717f9…`、6 份 `TASK*.md`
  仍与 §2 逐条一致。✅ 已实测通过。**
- **风险点 2：driver 可能把"工具报了什么"当成"应该报什么"。** 缓解：判据只从
  `rubric.json` 读，断言值硬编码在断言侧；run 结束打印每条的实测值，便于人工复核。
  **另加一道：rubric 里声明而脚本没实现的条目会被记 FAIL（判据覆盖有洞），
  反向自造判据（脚本用了 rubric 没有的 id）直接抛错。**
- **风险点 3：阴性对照必须真的报错。** ✅ 实测：孔径改小 0.5 → `check_assembly`
  报 `diametral clearance Ø-0.1`、1 条 hard、`status=fail`，同时阳性基准成立
  （4 pass / 0 hard）。机检不是空的。
- **风险点 4：流体步数受机器性能影响。** ✅ rubric 允许 `--skip-fluid` 记 skip 并
  标注。实测 600 步 / 8 帧，墙钟可忽略；`--fluid-steps` 可覆盖。

## 落地结果（回填）

**00-smoke 首次全绿：13/13 硬门 + 6/6 数值**（2026-10-07，墙钟 63.2s，工具调用
31/60）。逐条实测值与三级证据见实验报告
`experiments/20261007_00_smoke_instrument_calibration.md`；机读结果落在
`examples/bench/graders/00-smoke/scores/smoke-2026-10-07T15-09-52-360Z.json`。

落地过程中一并定的四件事：

1. **B2 修复**：`node esbuild.mjs` 重建；`lib/index.js` 现含 `bosl2Roots` 双深度
   逻辑（`bosl2Dir` 归零），实测 `OPENSCADPATH` 指向 BOSL2 **父目录**。
2. **§九 待办 1**：`g-delivery-audit.evidence` 已中性化为工具层面因果。
3. **§九 待办 3**：19 条逐条实核完成。**结论与原先"18/19 已被覆盖"不符**——真覆盖
   只有 8 条，另 4 条"覆盖但测 src"，余 7 条 accept 侧为空或仅关键字命中
   （典型：`measure_part` 只出现在 `accept-tool-scope.mjs` 的工具名清单里）。
   已记入实验报告，并把"accept 绿 ≠ 仪器可用"写进根 README §7。
4. **两项实测回填 rubric**：图片预算 24→**48**（原值配方装不下，实测 43）；
   `calibration` `uncertain`→`calibrated`（脚本驱动、无 LLM，阈值不受模型行为影响）。

**本轮新发现（不属于原计划，已记录待处置）**：`simulate_fluid` 的默认
`fluidRegionMm` 按包围盒内缩 3mm 推导，**只对壁薄于 3mm 的管件安全**——厚壁件下
种子大面积落进实体壁内，到达率从 0.93 掉到 0.097 且报告无任何提示。建议加
"种子区与实体重叠"警告。详见实验报告"遇到的问题"§4。

**仍未就绪（不阻 00-smoke，阻整体评测）**：`608.stl` 未生成（阻 02）、
`bench-score.mjs` 缺失（阻六列记分）、基线 commit 不完整
（`examples/bench/` 0 files tracked、`compile.ts` 未提交 → §2 的"完整基准"无法
从 commit 复现）。

## 文档同步

- **根 `README.md`**：§7 重写（命令路径改为题库侧、新增"先 `node esbuild.mjs`"
  的必做第 1 步、更正"每条都指向一个 `accept-*.mjs`"的说法为"判据只有 rubric
  那一份 + accept 只能当旁证"）；§4 预算表 `00-smoke` 图片 24→48。
  **（该文件本轮被外部改动过：新增了手工跑 `accept-*.mjs` 的回退小节。已与本次
  改动合并，保留了那段手工回退并补上"它测 src、不能代替校准"的边界。）**
- **`graders/README.md`**：§九 状态表（driver 行改 ✅、三项待办结项）、
  §三 表 3 预算与校准列。
- **`docs/DECISION-LOG.md`**：追加第 22 条（归属：留题库侧）、第 23 条
  （校准发货产物而非源码）。
- **`experiments/20261007_00_smoke_instrument_calibration.md`**：新增实验报告。
- `docs/DESIGN.md`：本次改动是评测侧脚手架 + 一次构建重建，**不影响插件架构设计**
  → 不需要更新（BOSL2 路径语义的登记仍随首轮基线一起补，见上一份执行摘要）。
