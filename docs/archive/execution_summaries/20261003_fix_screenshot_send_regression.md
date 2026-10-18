# 执行摘要：修复截图发送无效（liveSession 会话解析回归）

## 动机
> 用户报告截图发送无效。根因与项目作用域回归同源：dsh 升级移除快照 current
> 字段，panel.ts::liveSession 的第二处读法返回 null → 发送报「没有活动会话」。

## 影响范围
> - `src/client/project.ts`：导出 currentSessionId
> - `src/client/panel.ts`：liveSession 改结构化解析
> - `sandbox/preview/entry.tsx`：假会话升级为新形状 + 补 setProjectServices 接线
> - `verification/shots/send-e2e-proof.png`：E2E 证明

## 预期风险与验证
> - 风险点：无（复用已验证的解析函数）。
> - 测试方式：沙盒 E2E 截图证明全链路（scope→sessionOf→createDrafts→
>   sendSession(face ✓)，绿字「截图已发送到会话」）；accept-project-scope
>   等五套回归全绿；tsc 干净。
