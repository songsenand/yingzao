# 执行摘要：每会话图片窗口（方案 B′——只有造物模式限图）

## 动机
> 用户指出全局图片预算对标准模式不公平（256KiB 对真实截图≈2-5 张就裁），
> 否决方案 B（动态翻全局旋钮，并发会话互踩），拍板 B′：预算下沉到会话层，
> 只有造物模式限图。

## 影响范围
> - `dsh-cad-harness/src/host/image-budget.ts`：`PI_AI_KEEP_BYTES` 256KiB → 8MiB（兜底）
> - `dsh-cad-harness/src/host/image-offload.ts`：新增 `CAD_IMAGE_WINDOW` /
>   `countRetainedImages` / `enforceSessionWindow` + `llm/stream` 挂钩
> - `dsh-cad-harness/scripts/accept-image-offload.mjs`：+5 窗口断言
> - `dsh-cad-harness/scripts/accept-image-budget.mjs`：pi-ai 期望改兜底语义
> - `DESGIGN.md` §16.4、`docs/DECISION-LOG.md`

## 具体操作步骤
> 1. `llm/stream` 观察点取 `options.sessionId`（辅助调用带 purpose 的跳过），
>    `ctx.sessions.get(sessionId)` 取会话，`header.agentPreset` 判 preset。
> 2. cad 会话保留图数（含 tool-result 递归计数）超过 `CAD_IMAGE_WINDOW=24`
>    → 用既有的 `offloadOldestProtected` 主动记 `image/offload`（跳过用户图
>    的选择器复用），下一请求合规；标准模式返回 null，永不主动裁。
> 3. 按 sessionId 做 in-flight 去重；处理异常仅 warn，不影响请求瀑布。

## 预期风险与验证
> - 风险点：预算收紧后第一个请求仍按旧窗口发出（多付一次）；sessions 服务
>   未就绪时 fail-open（不裁）——都是已知并记录的边界。
> - 测试方式：`accept-image-offload.mjs` 全绿（窗口 5 断言 + 原有 13 项）；
>   `accept-image-budget.mjs` 全绿（pi-ai 兜底语义：显微镜3 场景 41→41，
>   13MB 病态负载仍被兜底裁）；`accept-recall.mjs` 回归 OK；tsc 干净。
> - 真实环境复核：重启 dsh 后，造物会话超 24 图时应看到 image/offload 决策，
>   标准会话贴图不应触发任何裁剪。
