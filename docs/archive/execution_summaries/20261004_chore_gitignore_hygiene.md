# 执行摘要：补全 .gitignore 并清理已入库的中间产物

## 动机
> 审计发现大量临时产物、构建产物、验证截图甚至凭据文件被跟踪入库：
> `.tmp-pyprobe/`、`.tmp-m4/`、`.scan.mjs`、`verification/shots/`、
> `dsh-cad-harness/verification/{shots,tmp}/`（原规则 `verification/tmp/`
> 含斜杠被锚定仓库根，未命中子目录同名路径）、7.2MB 的
> `dsh-cad-harness/sandbox/preview/dist/bundle.js`、运行时
> `data/usage/usage.jsonl` 与生成的 `assembly-check-report.json`、
> 含凭据的 `examples/dsh-home/`，以及 52 个命中 §19 忽略规则的
> `examples/microscope/cad-data/` 残留跟踪文件（跟踪与忽略矛盾）。
> 语料范围以并行入库的 DESGIGN §19 裁定为准：整个 cad-data/ 不入库，
> 比本轮问答中"仅 versions/"更宽。

## 影响范围
> - `.gitignore`（追加规则）
> - git 索引（`git rm -r --cached`，工作区文件全部保留）
> - `docs/DECISION-LOG.md`（追加一条：语料版本快照与 dsh-home 不入库）

## 具体操作步骤
> 1. `.gitignore` 追加：`/.tmp-*/`、`/.scan.mjs`、`verification/shots/`、
>    `dsh-cad-harness/verification/shots/`、`dsh-cad-harness/verification/tmp/`、
>    `dsh-cad-harness/sandbox/preview/dist/`、`dsh-cad-harness/data/usage/`、
>    `dsh-cad-harness/data/assembly/assembly-check-report.json`、
>    `examples/dsh-home/`、`examples/*/cad-data/versions/`
> 2. 对上述已跟踪路径执行 `git rm -r --cached`（共 9 组，约 100 个文件）
> 3. 追加 DECISION-LOG 条目
> 4. 提交为一个 chore 提交

## 预期风险与验证
> - 风险点：克隆本仓库的新环境将不再自带 dsh-home 实例与语料 STL，
>   需按 README/语料说明重新生成；`dist/bundle.js` 移除后需 `pnpm build` 再生。
> - 测试方式：`git status` 无意外未跟踪爆发；`git check-ignore -v` 逐项
>   抽查新规则命中；`git ls-files` 确认目标路径已不在索引。
