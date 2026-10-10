# 执行摘要：堵住评测泄露（手册副本外置）+ 手册压缩复测 + 指定模型跑 A/B

## 动机
> 用户四点：① 试卷在 `subjects/` 内为什么会泄露判据？② 01b"契约被改弱"这个说法不符合逻辑，请检查；
> ③ 同意把新增内容压成分点清单再复测；④ 12 次调用指什么；⑤ 沙箱能不能指定模型（想用 opencode go 的 deepseek v4.1 flash）。

## 影响范围
> - `examples/bench/tools/bench-run.mjs`：每轮把手册复制到 run root 并在那里生成 skill overlay
> - `examples/bench/tools/headless-overlay.yml`：手册行移出（改由 run root 负责），补 provider 注册表
> - `dsh-cad-harness/skills/cad-toolbox/SKILL.md`：新增内容压缩（65→35 行），交付纪律 #6 由"给结论"改为"给方法"
> - `examples/bench/graders/01b-diagnosis/scores/`：新增 v4.1-flash 的 baseline/candidate/delta 三份分数

## 具体操作步骤
> 1. **泄露定位**（读 01 r01 事件流）：手册内容自带
>    `<skill_resources> Base directory for this skill: /home/…/dsh-cad-harness/skills/cad-toolbox`，
>    而被检插件是 link 到仓库的 dev checkout ⇒ 考生据此知道仓库根，第 82 个事件直接
>    `cd …/examples/bench/graders/01-mortise-bench && cat rubric.json && cat key.md && cat prompt.md`
>    （描述写着 "Read mortise-bench grader rubric and key"）。**不是试卷位置泄露判据，是手册路径把仓库根递了过去。**
> 2. **堵法**：`bench-run.mjs` 每轮把 `<repo>/dsh-cad-harness/skills` 复制到 `<run-root>/.skills`，
>    并写 `<run-root>/skill-overlay.yml` 指向它；`dsh` 现在挂三个 `--patch`（run 的手册 overlay →
>    静态 overlay（provider 注册表）→ 模型 overlay）。静态 overlay 里的手册行已删除，避免两处都定义。
>    验证：run root 里 `.skills/cad-toolbox/SKILL.md` 与被检文件 sha 一致；overlay 指向 run root（仓库外）。
> 3. **01b 的说法校正**（读 `dossier/` + `key.md`）：时间线是 r025（接口 7 motion-clearance 期望 25–26mm
>    ⇒ hard-violation）→ r029（旧几何上 motion pass）→ r047（同接口期望改 ±0.5mm、引用 r029 ⇒ pass）
>    → **r057/r059（最终版本 motion fail，干涉对是「齿轮轴↔调焦滑座」）** → r064/r068（最终契约
>    motion-clearance 归零）。**"失败后被改弱"只在"最终这次降级发生在失败之后"这一层成立**；
>    被改弱的那条接口是「齿条↔齿轮」（转动副、check 由 motion-clearance 改 distance），
>    **与失败的干涉对不是同一对**；且接口 note 自述理由是"工具局限……二者均不作为依据"。
>    正确措辞（也就是 `key.md` 的要求）是结构性的："**6 条运动类型接口、0 条 motion-clearance ⇒
>    没有任何一条接口会因为它不动而失败**"。
> 4. **手册压缩**：新增块 65→35 行（改为"读哪个字段、什么阈值、该做什么"的分点），
>    并把交付纪律 #6 从"microscope5 交了 26 接口、0 条 motion-clearance"（给结论）
>    改成"列接口 → 看 check 算子 → 看它引的 run 是否覆盖交付版本"（给方法，`key.md` §八 的处置）。
> 5. **指定模型**：`bench-run.mjs --model opencode-go/deepseek-v4.1-flash`。headless 的 `llm-pi-ai`
>    行本来没有 config，所以把 GUI 档的 provider 注册表抄进静态 overlay（密钥仍由
>    `apiKeyEnv: OPENCODE_GO_API_KEY` 从 `$DSH_HOME/.credentials.yaml` 解析，不落文件）。

## 预期风险与验证
> - **泄露**：外置后考生看到的基础目录在仓库之外；`find /` 仍可能找到仓库（README §12.4 已声明
>   "读不受限"），彻底隔离仍需容器 —— 本改动只消除"顺带发现"。
> - **复测（opencode-go/deepseek-v4.1-flash，各 3 轮）**：**S0 只有 1/6 轮观测到手册被加载**
>   （候选 0/3、基准 1/3）⇒ `S` 记 N/A、`ΔS` 无法计算——本轮头号发现是"手册没被看见"：
>   候选 r01 的 thinking 明确写"这是读证据的活，不需要 CAD 工具，先不加载手册"。
>   C 列：压缩后调用中位数 **19 vs 基准 23**；引用 run id 中位数 **20 vs 20**；
>   `g-evidence-cited` **3/3 vs 2/3** ⇒ **上一轮 deepseek-flash 的 anchoringSuspect=true 本轮不成立**。
>   P 两臂仍全 0（`g-motion-never-checked` 的关键词形状代理，建议按 README §七 改成 UNKNOWN+证据）。
> - **未改**：01 的分数与 r01 作废结论、`g-motion-never-checked` 的判据实现（属题库侧决定）。
