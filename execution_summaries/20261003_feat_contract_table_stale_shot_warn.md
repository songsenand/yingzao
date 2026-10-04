# 执行摘要：装配契约表格 + 旧版本截图双确认

## 动机
> 用户：装配契约不能 three.js 显示，要有表格；旧版本截图仅文本提示不够，要弹警告。

## 影响范围
> - `src/client/panel.ts`：runReportBody 加 assembly-check 表格分支；shotDraft
>   增加 stale 字段；草稿警告行 + 发送前 window.confirm
> - `sandbox/preview/entry.tsx`：selectRecord 自适应双/三下拉；?shot=1 参数
> - `verification/shots/`：contract 表格与 stale 截图警告存档

## 具体操作步骤
> 1. runReportBody：assembly-check 分支渲染 results 表格（verdict 颜色映射）。
> 2. openShotDraft 截取时刻记录 staleness 进草稿；草稿 UI 显示琥珀警告；
>    sendShotDraft 在 stale 时 window.confirm，取消保留草稿。

## 预期风险与验证
> - 风险点：报告 JSON 字段名若变（results/hardViolations）表格降级为空行——
>   有 rep.results ?? rep.hardViolations 双兜底。
> - 测试方式：沙盒截图三张视觉确认（contract 表格 / stale 截图警告 / 视口
>   横幅）；四套验收回归全绿；tsc 干净。
