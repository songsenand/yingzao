# 实验报告：examples/bench 试卷沙箱实测（zai-coding-cn/glm-5.3-flash · low）

> 2026-10-14 · 目标：验证 `examples/bench/` 题库在沙箱（workspace-write 文件沙箱 +
> 每次调用隔离 /tmp 的 bash）里能不能跑起来、判据与素材是否完整。

## 目标
> 1. 题库机制完整性：runner（bench-run）→ headless dsh → CAD 工具 → 探针轮 →
>    机检打分（bench-score）整条链是否可用；
> 2. 判据与素材是否与当前 bundle（22 工具表）一致；
> 3. 用真实模型（zai-coding-cn/glm-5.3-flash，reasoning low）实跑两题验证。

## 假设
> 按 README §7/§12 的流程走，无需改动即可跑通。

## 方法
> - 仪器校准：`node examples/bench/graders/00-smoke/bench-smoke.mjs`（无模型调用）
> - 全题 `--dry-run` 预览（7 题：01 / 01b / 02 / 03 / 04 / 05 / 06）
> - 实跑：06-measure、01b-diagnosis 各 1 轮（repeat=1，非基准轮）
> - 模型：zai-coding-cn/glm-5.3-flash，reasoningEffort=low（bench-run 生成
>   model-overlay 钉死）；凭据经 `ZAI_CODING_CN_API_KEY` 环境变量传入
> - 沙箱约束的适配（关键）：
>   - 本会话 bash 每次调用是独立 namespace，**/tmp 不跨调用持久** → run root 一次
>     调用内跑完立即 `cp -r` 归档回 `workspace/.tmp-bench-runs/`；
>   - `~/.dsh` 在沙箱内只读 → 复制一份可写 `DSH_HOME`（profiles/headless 需修一条
>     相对 symlink）与一份 `DSH_CAD_PYTHON_ROOT`（约 420MB）。

## 结果

### 1. 仪器校准（00-smoke）：修复两处后全绿
- 首跑即暴露 **Python 运行时根目录问题**：校准脚本把 `DSH_HOME` 隔离到空临时目录，
  `prepareVenv` 热路径也**无条件写 `state.json`** → 指向共享 runtime 的只读挂载直接
  EROFS。处置：runtime 复制到可写位置 + `DSH_CAD_PYTHON_ROOT` 指过去（已写进
  README §7 注记）。
- 第二跑暴露**工具表漂移**：2026-10-10~12 测量批次把 `measure_closest` +
  `measure_distance` 合并进 `measure_gap`、`check_connectivity` 并入 `measure_part`
  的 bodies 半区，`bench-smoke.mjs` 第 5/6/7 步还在调旧名 → 第 5 步崩。处置：三处
  调用迁移到新 API（tools.ts:2560 迁移注释背书，判据 id 与期望值**未动**）。
- 修复后 **13/13 硬门 + 6/6 数值全绿**（31 次工具调用 / 43 图 / 墙钟 15.3s）。

### 2. 题库完整性（dry-run + 素材检查）：全过
- 7 题全部通过 dry-run：多段题（03 两段）、变体选择、needs 检查、探针轮清单、
  考卷指纹核对全部正常。
- 素材全在：02 的 608.stl（已备料）、01b 的 dossier、06 的两枚 STL、03 的参考图、
  04/05 的 materialize prep 脚本。
- 注：runner 跑完打印的"bench-score.mjs 待实现"是**过时文案**——评分器已实现
  （1604 行），06 实测 13/13 条自动判定，01b 实测 11/14。

### 3. 实跑（模型真实做题）
| 题 | 结果 | 工具调用 | 墙钟 | 机检（自动条目） |
|---|---|---|---|---|
| 06-measure | exit 0，交付 measure.json | 19/40 | 2.9min/25 | 13/13 全判：8 PASS / **3 FAIL**；P=0，S=0.933 |
| 01b-diagnosis | exit 0，交付诊断报告 | 8/12 | 2.2min/15 | 11/14 判：8 PASS / 2 FAIL / 3 需人判；P=0 |

06 的三条 FAIL 值得读（机检输出：
`graders/06-measure/scores/zai-coding-cn-glm-5.3-flash-low-sandbox-check.txt`）：
- `g-delta-correct` FAIL：part-b 壁厚变化答成 −2（真值 +1，3→4）——**真实模型错误**；
- `g-tools-not-bypassed` FAIL：没调用 `measure_thickness`（题面五件套要求）；
- `g-no-invented-numbers` FAIL：3 个数缺工具原始返回背书——其中剖面面积一项的根因
  是 **`measure_section` 工具自身坏了**（见下），考生只能解析推导并在 notMeasurable
  里如实声明，评分器不认声明、如实扣分。

### 4. 试卷抓到的 SUT 缺陷（2 个，均已定位并修复）
1. **`measure_section` 输出 schema 漏声明 `voidRegions`**：实现返回该字段（worker.py
   两条路径 2170/2308 行），但 `output.schema` 是 `additionalProperties: false` 且
   未列 → DSH 输出校验器拒收整个结果。考生连试 3 次（不同参数）全部同样失败。
   死在**第②关**（schema 校验，lossless 已过）。
2. **`run_python` 任何调用都报 `value is not lossless JSON`**：连 `print("hello")`
   都失败。根因（子代理全程定位）：框架 `createSuccessResult` 在 schema 校验
   **之前**做 lossless-JSON 检查，**任何值为 `undefined` 的属性都算有损**；而
   `python-tools.ts` 里 `exitCode ?? undefined` 的写法让**每种结局都至少产出一个
   undefined 键**（成功运行时 signal=null、traceback=null）→ run_python 与
   python_runtime **每次调用必挂**。函数注释写的"omitted, not null"意图正确，
   实现写法错误。死在**第①关**（lossless，schema 未及检查）。
   修复：可空字段先从返回对象解构剔除、再按值存在条件展开；statusFields 的 7 处
   `?? undefined` 同改；schema 补 `voidRegions` 声明。重建 bundle 后 00-smoke 仍
   13/13+6/6 全绿。

### 4b. 修复后的复测（06-measure 第二轮）：工具链恢复，硬门 3 FAIL → 1 FAIL
| 硬门 | 修复前 | 修复后 |
|---|---|---|
| g-tools-not-bypassed | FAIL（缺 measure_thickness） | PASS（五件套全用上）|
| g-no-invented-numbers | FAIL（3 个数无背书） | PASS（35 个数字全有工具背书）|
| g-delta-correct | FAIL（报 −2，真值 +1） | FAIL（**两轮一致**，真实模型能力缺口）|

`c-section-area` 这次 PASS 且测得 3796.124 与真值完全一致——`measure_section`
修复后考生直接量出了精确值。工具调用 19→14、墙钟 2.9→1.8 分钟。

### 5. run-record / 事件流质量
- 每轮 `run-record.json` 记录退出码、耗时、usage、sessionId、指纹核对、原始命令；
- NDJSON 事件流含 session/status/tool_call（带完整参数，g-grader-access 即扫此）/
  tool_result/text/final；
- 探针轮：两题的 rubric 均无 `ask` 探针（06/01b 设计如此），机制待 01/02 题验证。

## 分析
> - **题库机制完整可用**：runner/评分器/事件流/指纹/探针/素材六环节全部真实工作；
>   两处过期（00-smoke 的工具名、runner 的"评分器待实现"文案）已修或已澄清。
> - **S0 可观测**：两题会话都加载了 cad-toolbox（skill 工具调用可见）。
> - 两题 P=0 是真实信号（模型错误 + SUT 缺陷连锁），不是评分器故障；
>   `c-stale-visual` 一条 FAIL 是词表代理判定，粗糙但按设计工作（需人判复核）。

## 遇到的问题
> 1. 沙箱 /tmp 不跨调用 → 归档策略（见 §方法）；
> 2. 只读 `~/.dsh` → 可写副本 + 环境变量重定向（README §7 已补注记）；
> 3. profile 副本里 `dsh-cad-harness` 的相对 symlink 断链 → 改绝对链接；
> 4. ~~未解决：`run_python` lossless JSON 的根因~~ → 已定位（undefined 值键 +
>    schema 漏声明）并修复，复测通过（见 §4/§4b）。

## 产物列表
**代码与脚本（本次改动）**
- `examples/bench/graders/00-smoke/bench-smoke.mjs` —— 第 5/6/7 步迁移到
  measure_gap / measure_part（判据语义不变）
- `examples/bench/graders/00-smoke/rubric.json` —— 两条 desc/via 文案同步
- `examples/bench/README.md` —— §7 补沙箱/隔离 HOME 的 DSH_CAD_PYTHON_ROOT 注记
- `execution_summaries/20261014_fix_bench_smoke_tool_drift.md` —— 执行摘要

**数据**
- run root 归档：`.tmp-bench-runs/06/`、`.tmp-bench-runs/01b/`
  （含 run-record.json、*.events.jsonl、cad-data/、考生交付物）
- 运行时副本：`.tmp-bench-runtime/`（420MB，`/.tmp-*/` 已 gitignore）
- 可写 DSH_HOME：`.tmp-bench-home/`

**输出**
- `graders/06-measure/scores/zai-coding-cn-glm-5.3-flash-low-sandbox-check.txt`
- 00-smoke 自检分数：`graders/00-smoke/scores/smoke-2026-10-14T*.json`

**复现命令**
```bash
# 0) 构建 + 沙箱适配（每次新开 shell 都要）
cd dsh-cad-harness && node esbuild.mjs && cd ..
cp -a ~/.dsh/cad/runtime .tmp-bench-runtime            # 可写 runtime 副本
cp -a ~/.dsh/profiles .tmp-bench-home/                  # 可写 DSH_HOME
ln -sfn $PWD/dsh-cad-harness .tmp-bench-home/profiles/headless/node_modules/dsh-cad-harness
export DSH_HOME=$PWD/.tmp-bench-home
export ZAI_CODING_CN_API_KEY=$(awk '/ZAI_CODING_CN_API_KEY/{print $2}' ~/.dsh/.credentials.yaml | tr -d '"')
export DSH_CAD_PYTHON_ROOT=$PWD/.tmp-bench-runtime

# 1) 仪器校准（全绿才能跑题）
node examples/bench/graders/00-smoke/bench-smoke.mjs

# 2) 跑题（+ 跑完归档，沙箱 /tmp 不跨命令存活）
node examples/bench/tools/bench-run.mjs --level 06-measure \
     --model zai-coding-cn/glm-5.3-flash --reasoning-effort low \
     --tag sandbox-check --root-dir /tmp/bench-runs/06
cp -r /tmp/bench-runs/06 .tmp-bench-runs/

# 3) 机检打分
node examples/bench/tools/bench-score.mjs --run .tmp-bench-runs/06
```

**环境依赖**
- node v26.11.1、OpenSCAD（/usr/bin/openscad）、Python 运行时（provision 过的副本）
- dsh 0.2.0-rc.2 + headless profile；zai-coding-cn 凭据（credentials.yaml 或 env）

## 结论与下一步
> - **结论：试卷能跑、判据可机检、素材完整**；三题真实模型轮（06 ×2 + 01b）证明
>   端到端出分链路工作，且能同时抓到模型错误与 SUT 回归——这正是这套题库的设计目的。
> - 下一步：
>   1. ~~修 SUT 两缺陷~~（本次已修，00-smoke 全绿 + 06 复测验证）；
>   2. 基准轮：每题 N≥3（本轮 repeat=1，是冒烟不是基准）；`g-delta-correct`
>      两轮一致 FAIL 提示 glm-5.3-flash(low) 在"壁厚变化方向"上有真实能力缺口，
>      值得在基准轮看它是否稳定复现；
>   3. 03/04/05 的 prep 链路已 dry-run 验证，未实跑（每个 45–150 分钟，按需开跑）；
>   4. 01b 的 3 条人判判据（g-no-green-claim / g-distinguish-notdone-vs-failed /
>      c-anchoring）按设计需要人工读卷/双臂对照，本次未做。
