# 执行摘要：修复面板项目作用域回归（所有项目显示同一预览）

## 动机
> 用户报告：不同项目的 CAD 预览内容相同。根因是 2026-10-03 的 dsh 升级删除了
> sessions 列表快照的 `current` 字段，客户端无法解析"当前会话"，所有请求丢失
> `?project=`，host 一律回退到自己的 cwd——所有项目显示同一语料。

## 影响范围
> - `dsh-cad-harness/src/client/project.ts`：currentSessionId 结构化解析
> - `dsh-cad-harness/src/host/tools.ts`：recall 工具 execute 补 exec 形参
> - `dsh-cad-harness/scripts/accept-project-scope.mjs`：+12 客户端断言

## 具体操作步骤
> 1. project.ts 新增 currentSessionId()：镜像 shipped preset picker 的判定——
>    `sessions.binding(id)` 存活且 `retainInfo(id).retainedBy.mainView > 0`；
>    旧快照的 `state.current` 保留为兼容回退。currentSessionCwd/Preset/Blank
>    全部走同一解析。
> 2. tools.ts recall execute 补 `exec: unknown`（满足"每个工具都接执行上下文"
>    的既有不变量）。

## 预期风险与验证
> - 风险点：binding/retainInfo 是客户端接缝，dsh 再升级可能变——验收会红。
> - 测试方式：accept-project-scope 46 项全 PASS（新增 12 项：新形状解析/切换/
>   空绑定回退/旧形状兼容/switched 上报）；四套验收全绿；tsc 干净。
> - 真实环境：重启 dsh 后切换两个不同 cwd 的会话，CAD 面板应各自显示自己的
>   零件与版本。
