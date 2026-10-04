# 方向性决策记录（append-only）

## 2026-10-03：版本管理采用 git（本地仓库起步）

**要解决的问题：** 项目完全没有版本管理，导致（a）无法回答"哪次改动引入了问题"；
（b）上一轮交付未经沙盒验证的改动没有快照可比对；（c）dsh 升级覆盖宿主 patch 后
无法追溯当时改了什么。

**决策内容：** 在项目根目录 `git init`，本地仓库起步，暂不设远程。忽略规则见
根目录 `.gitignore`：依赖（node_modules）、构建产物（dsh-cad-harness/lib）、
第三方大文件（bin/OpenSCAD AppImage、lib/BOSL2）、生成工件
（examples/*/out、data/versions、沙盒截图）全部不入库；语料文本
（scad/datums/manifest/验收基线 shots）入库。

**理由：** 项目全部是文本（TS/MD/YAML/SCAD），git 的 diff/回滚正好覆盖本次
事故的核心需求——"每次交付有快照、每次验证有输出可对"。不需要远程即可获得
全部收益；后续需要备份/协作时再推私有远端，不影响现有结构。备选的
"目录快照脚本"无 diff 能力、"SVN"无本地分支优势，均放弃。

**依据：** 2026-10-03 沙盒复核事故（DESGIGN §15）：四处已交付改动与现实偏差，
逐一排查时没有任何基线可比。初始快照 289 文件 / 13MB，无大文件泄漏。

**影响：** 后续每次插件改动按 AGENTS.md 工作流提交（执行摘要 + commit）；
dsh 升级后跑 `accept-image-budget.mjs` 并以 commit 记录结果；宿主 patch
（若重新引入）必须在 DECISION-LOG 登记并配升级后重放钩子。

## 2026-10-03：用户图裁剪豁免采用插件内执行器方案（方案 B）

**触发条件：** 第 1 条（用户拍板："做B"）。

**要解决的问题：** 现货 dsh 的 `dsh-compaction-image-offload` 最老优先裁剪、无用户图
豁免，用户参考图必然第一个出局。方案 A（召回工具）已交付但依赖模型主动调用；
需要"被动侧"的保护。

**决策内容：** 不打宿主 vendor patch。用本插件的 bundle patch 将现货
`image-offload` 行 `disable: true`，由插件自身监听 `IMAGE_OFFLOAD_REQUIRED`
（`agent/request-error` / `compaction/summary-error`）并以同样的
`image/offload` 会话决策事件执行"跳过 user 消息顶层图片"的最老优先裁剪。

**理由：** 全部代码在本仓库，dsh 升级免疫且可沙盒验证；现货执行器实现可读，
移植保真度高。对比 vendor patch（升级即失效、沙盒只读无法重放）与召回工具
（被动侧无保护），这是唯一同时满足"升级安全 + 被动保护 + 可验证"的路径。

**依据：** 现货执行器全文已通读（dsh-compaction-image-offload lib/index.js，
0.2.0-rc.2）；其接缝为 `sessions.registerMessageProjection` +
`agent/request-error` / `compaction/summary-error` 事件；DESGIGN §15.1 第 4 条
实测记录。

**影响：** 插件承担 offload 职责，接缝形状随 dsh 演化需跟进（验收脚本盯住）；
现货行被 disable 后，非 CAD 路由也走本插件的执行器——行为差异仅"用户图豁免"。

## 2026-10-03：图片预算改为会话级窗口（方案 B′，用户拍板）

**触发条件：** 第 1 条（用户拍板："这个B′才是我想要的"）。

**要解决的问题：** 图片预算（deepseek 24 张 / pi-ai 256KiB）是路由级全局配置，
对标准模式不公平（256KiB 对真实截图≈2-5 张就开始裁）；而"仅造物模式限图"
无法在适配器接缝上直接表达。方案 B（动态翻全局旋钮）被否决：并发会话下
全局旋钮互踩，正确性只在单会话前提成立。

**决策内容：** 适配器预算放宽为兜底值（pi-ai 8MiB，仅防超大附件；deepseek
24 张对聊天无感，保留）。插件在 `llm/stream` 观察点（`options.sessionId` →
`ctx.sessions.get()` → `session.header.agentPreset`）对造物模式会话执行
**24 张保留窗口**：超窗即主动记 `image/offload` 决策，下一请求合规。
标准模式不主动限图。

**理由：** 每会话独立判断，无全局旋钮竞态；标准模式完全不限图；执行器与
选择函数已存在（方案 B），复用度高。代价：预算收紧后第一个请求仍超窗
（多付一次视觉 token），之后合规——验收和文档已注明。

**依据：** `llm/stream` options 携带 `sessionId`（dsh-llm types L524，
agent-loop buildRequest 盖章）；`session.header.agentPreset` 为创建事实
（dsh-session L1052/1708）；`ctx.sessions.get(sessionId)` 存在
（dsh-session L1628）。

**影响：** pi-ai 兜底预算变化需同步 accept-image-budget 期望；窗口逻辑依赖
`llm/stream` + sessions 查询接缝，dsh 升级漂移由验收脚本盯住。

## 2026-10-03：标准模式回归 dsh 出厂默认，图片干预仅限造物模式

**触发条件：** 第 1 条（用户拍板："标准模式不改变dsh的默认配置"）。

**要解决的问题：** §16.4 落地后仍有两处全局干预（deepseek 24 张 patch、pi-ai
8MiB settings 写入），标准模式被插件改了行为；且"永不裁剪"本身也不是 dsh 默认。

**决策内容：** 撤销全部路由级预算（llm-deepseek patch 删除、pi-ai settings 写入
删除）；offload 执行器按 preset 分派——cad 会话 = 24 张窗口 + 用户图豁免，
其余 preset = 与现货执行器逐字节一致（最老优先、无豁免）；投影层允许用户图
决策重放（非 cad 现货决策必须可回放）。

**理由：** 用户模式/非用户模式界限清晰：插件只在用户点名的造物模式里改变行为，
标准会话与裸 dsh 无差别。执行器已持有接缝，分派零边际成本。

**依据：** accept-image-offload 同夹具对照（standard 选择与现货逐字节一致）；
accept-image-budget 组合树确认 llm-deepseek UNPATCHED；三套验收全绿。

**影响：** 造物会话预算完全依赖主动窗口（超窗首请求多付一次）；非 cad 会话若
用户自行配置路由预算，得到现货处置（含用户图被裁——那是 dsh 默认）。

## 2026-10-04：版本库卫生纪律——临时/构建产物、凭据、语料快照不入库

**触发条件：** 第 1、4 条（用户拍板清理范围；作为后续语料与验证产物的版本管理前提）。

**要解决的问题：** .gitignore 审计发现九组中间产物被跟踪入库：临时探针目录
`.tmp-pyprobe/`、`.tmp-m4/`、一次性 `.scan.mjs`；验证截图 `verification/shots/`、
`dsh-cad-harness/verification/{shots,tmp}/`（原 `verification/tmp/` 规则含斜杠
只锚定仓库根）；7.2MB 的 esbuild 产物 `sandbox/preview/dist/bundle.js`（全仓
最大文件）；运行时 `data/usage/usage.jsonl` 与生成的
`assembly-check-report.json`；含凭据的 `examples/dsh-home/`；以及 52 个命中
§19 忽略规则的 `examples/microscope/cad-data/` 残留跟踪文件。

**决策内容：** .gitignore 追加 10 条规则；上述路径 `git rm -r --cached` 移出
索引（工作区文件全部保留）。examples 语料 cad-data 按 §19 既定裁定整体不入库
（比本轮问答中"仅 versions/"更宽，以已入库的 §19 为准）。

**理由：** 生成物可由 scad/构建再生，符合 .gitignore"由语料 + 脚本再生"原则；
凭据与本地运行实例禁止入库；消除"被跟踪却命中忽略规则"的永久矛盾状态
（`git ls-files -i -c` 由 52 归零）。

**依据：** 全量 `git ls-files` 审计 + `git check-ignore -v` 命中验证；§19.1
用户裁定（"cad-data/ 默认进 .gitignore，STL 是生成物"）；bundle.js 7.2MB 为
du 统计全仓最大跟踪文件。

**影响：** 新克隆环境需 `pnpm build` 再生 preview/dist、按语料流程再生 STL 与
dsh-home 实例；`.credentials.yaml` 在历史提交中仍存在，若仓库将外发需另行
filter-repo 清史；后续新增验证截图/临时目录自动被忽略，无需逐次登记。
