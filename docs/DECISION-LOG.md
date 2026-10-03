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
