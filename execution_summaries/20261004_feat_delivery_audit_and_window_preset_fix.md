# 执行摘要：交付审计工具 + 图片窗口预设读取修复

## 动机
> 用户要求：① 做交付审计工具；② 补两条纪律；③ 核查"图片限制 24 是否已生效"。

## 影响范围
> - `src/host/delivery-audit.ts`（新）：语料体检（红牌/过期/未验证/契约缺口/重复）
> - `src/host/tools.ts`：注册 `delivery_audit` 工具（模型可见文本带 verdict）
> - `src/host/image-offload.ts`：`presetOfSession`（投影优先、header 回退）；
>   窗口与错误瀑布改用它
> - `skills/cad-toolbox/SKILL.md`：交付纪律第 5/6/7 条
> - `scripts/accept-delivery-audit.mjs`（新，12 项，含 microscope5 真实语料断言）

## 具体操作步骤
> 1. auditDelivery(project)：listVersions/listParts/listRuns + 清单解析 →
>    findings（blocked/warn/info）+ verdict；工具包装成 delivery_audit。
> 2. 窗口预设改读 `ctx.sessionProjections.stateOf(session,'agentPreset')`，
>    header 仅回退；offloadOldestProtected 同步接收投影服务。
> 3. 纪律 5（整机需整机证据）、6（机构入契约）、7（交付前跑审计）。

## 预期风险与验证
> - 风险点：审计只读，不改语料；契约解析失败时其余结论仍成立。
> - 测试方式：accept-delivery-audit 12 PASS（microscope5 真实语料复现 66/69
>   过期、22/83 未引用、motion 红牌、契约无 motion 接口、文档版本区间早于
>   语料；干净语料不误报）；accept-image-offload 补 4 条预设读取断言；
>   九套验收全绿；tsc 干净。
