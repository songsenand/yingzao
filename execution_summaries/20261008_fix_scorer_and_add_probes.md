# 执行摘要：打分器补完到 18/18，并修 kind / 语料路径 / 探针轮

## 动机
> 首轮基线（01）跑通后，打分器还有 2 条未实现、探针从未被问过；接着跑 `01b`
> 时又暴露了 3 个我自己的判据实现错误。这些都必须修掉，否则后续每一轮的分数
> 都不可信。

## 影响范围
> - `examples/bench/tools/bench-run.mjs`（**新增探针轮**；dry-run 列出探针）
> - `examples/bench/tools/bench-score.mjs`（补完求值器；修 3 处实现错误）
> - `examples/bench/graders/01-mortise-bench/rubric.json`（探针答案写成机读）
> - `experiments/20261008_01_first_baseline_run.md`（追加 01b 一节）

## 具体操作步骤
> 1. **runner 加探针轮**：各段跑完后，用**同一个会话**逐个发 rubric 里的 `ask`，
>    事件流落 `probe-<id>.events.jsonl`，答案记进 `run-record.probes`。
>    长程记忆探针不问就永远测不到。`--no-probes` 可关；`when` 的适用性由打分器判，
>    runner 只负责问。dry-run 也会列出探针。
> 2. **探针答案写成机读**：`01` 的 `p-version-recall` 加
>    `answerValues: [30]` 与 `answerNote`（腿第 2 版 = v004，透榫 30×30；
>    **30.5 是阴性对照 v005**，答成 30.5 说明记错版本）。取值读自
>    `cad-data/versions/*/model.scad` 的 `TEN`——**是读出来的事实，不是编的**。
> 3. **补 `c-measured-vs-datum`**：只在能**按面名配上**契约条目时才比对；配不上记
>    UNKNOWN。**不做"近似命中任意数字"的松散匹配**——那会随机通过。
> 4. **补 `p-version-recall`**：判 `when` 适用性（`renderRounds >= N`）→ 取探针答案
>    → 与 `answerValues` 比对；没问过记 UNKNOWN（不冒充）。
> 5. **修 `kind` 用错**：整机验证是 `kind: 'assembly'`（`validate_assembly`，`parts`
>    是覆盖件数），`assembly-check` 是**契约逐条检查**（`parts` 恒为 0）。
>    原先按 `assembly-check` 过滤 ⇒ 01b 的整机类条目全判错。
>    **03 的 rubric 里本就写着 `kind === 'assembly'`**，是没照它写。
> 6. **修语料路径**：`<run>/cad-data/`（01/02/03）与 `<run>/dossier/`（01b，证据目录）
>    两种布局都要认。
> 7. **修 `c-post-subset-sizes` 的窗口**：取**最后一次**整机运行之后的，不是第一次
>    （r046 与 r048 都是 16 件，用 `findIndex` 会把 r048 算进去）。
> 8. **补 01b 的 6 条回答驱动判据**（关键词/引用计数做代理，并把命中证据打出来）。

## 预期风险与验证
> - **风险点 1：关键词代理会把"列了数据"当成"下了结论"。** 实测正是这个分歧点：
>   01b 的回答**列出了 check 类型分布**（distance 15 / diameter-match 6 / coaxial 4 /
>   spring-preload 1 = 26，隐含 `motion-clearance` 为 0），但**没把推论说出来**。
>   处置：判 FAIL（判据要求的是结论），但把"回答里列的清单"写进 `detail`，
>   让人能分辨"列了没下结论"与"压根没看"。
> - **风险点 2：探针轮会多花模型调用。** 每条探针 = 一次额外调用（本轮 01 补问花了
>   一次）。可 `--no-probes` 关掉；判据侧记 UNKNOWN，不会静默算过。
> - **风险点 3：打分器自造判据。** 已把"补写的三条 expect"的取值依据写进 rubric 的
>   `desc`；探针的答案来自版本库；未实现的条目一律 UNKNOWN 并打印 `via`。
>   输出强制带"自动判定 N/M"。
> - **验证**：01 → **18/18 自动判定**，探针 PASS（模型答 30.0mm 并回到版本文件取证）；
>   01b → 11/14（余 3 条需语义判断，如实标 UNKNOWN）。
