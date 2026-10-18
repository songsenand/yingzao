# 执行摘要：首轮基线跑通——修 runner 会话语义、新建打分器、补 01 判据阈值

## 动机
> 用户拍板"开始"首轮基线。目标是**验证流程与仪器**而非出模型结论。
> 首轮暴露了 2 个我自己的工具 bug、1 个标签错误、3 条空判据。

## 影响范围
> - `examples/bench/tools/bench-run.mjs`（会话语义 + tier 标签）
> - `examples/bench/tools/bench-score.mjs`（**新建**）
> - `examples/bench/graders/01-mortise-bench/rubric.json`（补 3 条 `expect`）
> - `experiments/20261008_01_first_baseline_run.md`（**新建**）
> - 运行产物在仓库外：`/home/songsenand/bench-runs/01-base01/`；机读分在
>   `graders/01-mortise-bench/scores/`（已 gitignore）

## 具体操作步骤
> 1. `bench-run.mjs`：**第一段不再传 `--session-id`**。该 flag 是"认领一个已存在的
>    会话"，未知 id 直接报错（实测：首跑 60 秒失败）。改为第一段新建、从它的事件流
>    取回真 id、后续段继承；取不到 id 且还有后续段则中止。
> 2. `bench-run.mjs`：`tier` 原按**变体名**判断（01 的单变体叫 `default`，于是被标成
>    "GUI / 造物模式"）。改为按**运行方式**判断（本 runner 一律 headless），变体单列。
> 3. 新建 `bench-score.mjs`：读 `run-record.json` + `*.events.jsonl` + 语料
>    （`cad-data/manifest.json`、`cad-data/runs/*/{run,report}.json`、
>    `cad-data/versions/*/datums.json`、`assembly/assembly.json`、考生产出的
>    `joinery.json` 等），按 `rubric.json` 逐条求值，输出六列与覆盖度。
>    **原则**：只实现判据、不发明判据；无求值器的条目记 `UNKNOWN`，绝不冒充通过。
> 4. `01` 的 `rubric.json`：补写三条空 `expect` 的阈值（`c-across-grain-looser`、
>    `c-gaps-in-range`、`c-blind-tenon-shorter`）。**补写时优先沿用原 `desc` 已写下的
>    数字**：`c-blind-tenon-shorter` 的 desc 原文即"胶隙 1.5–3mm"，故取 `[1.5, 3.0]`；
>    初稿误写成 `[0.5, 3.0]`（把原有判据放松，恰好放过了本轮那个 1mm 余量），已在
>    提交前纠正——收紧后该条由 PASS 变 **FAIL**。另两条 desc 无数字，按木工依据补
>    并把依据写进 `desc`。
> 5. 跑 01 首轮 → 打分 → 归档分数与实验报告。

## 预期风险与验证
> - **风险点 1：打分器把"故意的阴性对照"判成失败。** 第一版正则中文 `summary`，
>   把 `r003`（对照命中，硬冲突 4）当成 `g-hard-zero` 失败，给一个实际过 8/9 门的
>   运行打了 P=0。**已修**：改读结构化 `report.json`，且 `g-hard-zero` 只看**最终态**。
>   验证：`r001` pass → `r003` fail(4) → `r004` pass(0)，三连判 PASS。
> - **风险点 2：补判据阈值会改动基准。** 改的是 `rubric.json` 的 `expect`，**不动
>   任何 `TASK*.md`**，所以考卷指纹不变、本轮运行不作废（只需重打分）。
>   验证：重跑 `sha256sum` 与 `taskFile.sha256` 比对 —— `TASK.md` 仍 OK。
> - **风险点 3：判据阈值是我定的，可能过松/过紧。** 依据写在 `desc` 里（胶线
>   0.05–0.2mm；横纹按 30mm 榫眼/280mm 宽板/约 6% 含水率波动估 ≈0.45mm 局部收缩，
>   下界取 0.30）。**属首轮基线该定下来的东西，但仍应在 `N≥3` 后复核**。
> - **风险点 4：脚本不能假装判完了。** 输出强制带 `自动判定 N/M`，未实现的条目
>   逐条打印它需要看哪份证据（`via`）。当前 16/18。
