# 执行摘要：补齐 03-microscope 的判据求值器（7/26 → 26/26）与两个探针

## 动机
> 用户："先做 1 和 2"——① 补 03 的求值器（提高机检覆盖），② 补两个探针的期望值/求值器。
> 背景：03 的机检覆盖只有 7/26，`p-version-recall` 的 `answerValues` 为空、`p-reference-recall` 无求值器。

## 影响范围
> - `examples/bench/tools/bench-score.mjs`：新增 03 段求值器（约 330 行）+ STL 包围盒 helper
> - `examples/bench/graders/03-microscope/rubric.json`：`p-version-recall.answerNote` 记录推导规则
> - `examples/bench/graders/RESULTS.md`：03 一节按新判据重生成

## 具体操作步骤
> 1. **先读证据结构再写判据**（顺序很重要）：`dossier`/语料里的 run 与 report 字段、
>    工具调用与结果（`delivery_audit`/`measure_distance`/`check_printability`/`render_part`/`validate_assembly`/`read_image`）、
>    考生产出的 `optics.json`/`printability.json`/`assembly.json`、SCAD 源码、`key.md` 与 `landmarks.json`。
> 2. **按"能被结构化证据判定才自动判"的原则补 19 条**：
>    阴性对照三连（M1 止口直径 −0.5 / M2 齿轮相位 / M3 光阑面 +1，各要求"命中 + 改回"）、
>    `g-visual-evidence-current`（最后一次整机渲染/验证的**版本多重集** == 交付集）、
>    `g-delivery-audit-clean`（最后一次 delivery_audit 不得 BLOCKED）、
>    `g-printability-no-unprintable`（只看**交付版本**的 unprintable，且必须在 `printability.json` 里逐条回应）、
>    `g-no-turret`（只认**零件名**，零件内部提及只作人判线索）、
>    `g-optics-self-consistent`（声明的像距/物距 vs `measure_distance` 实测 ±0.3mm ＋ M=v/f−1 自洽）、
>    `c-motion-clean`（最后一次 motion 0 干涉/0 关节违规；陈旧性只跟**该 run 用到的零件**比）、
>    `c-coaxial`/`c-undeclared-found`/`c-printability-json`/`c-measured-vs-datum`（名义值配对 <0.05mm）/`c-stdlib-used`（BOSL2 include + 模块调用）。
>    **语义项**（焦深方案、稳定性两问、外观对照）只在客观部分成立时判 PASS，否则记 UNKNOWN 并摘证据（照 graders/README §七）。
> 3. **两个探针**：`p-reference-recall` 分档判定（headless：第二阶段对 `参考图.png` 的 `read_image`；GUI：`recall_reference_image`）；
>    `p-version-recall` 的期望值**从版本库推导**（交付 children 里"载物台"零件的第 3 版 → SCAD `datum_plane("槽底")` 的 z 与 STL bbox 顶面的差），
>    因为槽深是模型自己的设计选择，写死数字会误判。其它 level 仍走原来的 `answerValues` 口径。
> 4. **顺手修两个与本卷 rubric 不符的旧求值器**：`c-stroke`（03 是"调校滑座行程 ≥25mm"，旧实现按 40±0.5 且只看最后一次 run ⇒ 误判 0mm）、
>    `c-joint-drift`（阈值改为从 rubric 的 expect 解析，03 是 ≤0.05 而非 0.5）。

## 预期风险与验证
> - **风险 1：把判据写成"让这一轮变绿"**。防线：每条都要求结构化证据，且用**残缺轮次做反向对照**——
>   同一条被 400 拒图打断的首轮，用同一批评据打分 ⇒ `g-negative-*`/`g-whole-machine-verified`/`g-delivery-audit-clean`/
>   `c-printability-json`/`c-measured-vs-datum` 等 FAIL，P=0，说明求值器不会把残缺轮次判绿。
> - **风险 2：修错导致别的 level 回归**。回归扫描：01 r01/r02（16/18、17/18）、01b 两臂（11/14）、02（19/19、P=0.895）**全部不变**；
>   `p-version-recall` 已按 level 分派，非 03 仍走 `answerValues`。
> - **结果**：03 覆盖 **7/26 → 26/26**，该轮 **P=1.0、S=1.0**、两个探针 PASS；12 条硬门全过（其中 3 条此前是我的求值器误判：
>   拿整块 JSON 匹配"法兰/光阑"、把中间版本的 unprintable 算成交付件、把零件内部的镜片当成"还原了聚光镜"）。
> - **仍需人判**：rubric 的 7 条外观 `features`（脚本不计入 26 条）——证据指针（渲染目标 + 参考图九段剖面）已自动摘出；
>   剖面 L1 阈值按 `key.md` §八 待基线回填。
