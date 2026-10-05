# 执行摘要：图片窗口遥测（降低 debug 负担）

## 动机
> microscope5 复盘中，"cad 图片窗口有没有生效"无法从数据回答，只能解压会话日志
> 反推 preset 事件。用户要求把窗口决策写入遥测。

## 影响范围
> - `src/host/usage.ts`：ImageWindowRecord / recordImageWindow / imageWindowReport；
>   `/api/cad/usage` 增加 imageWindow 汇总
> - `src/host/image-offload.ts`：decideSessionWindow（纯决策）+ enforceSessionWindow
>   （兼容形状）；hook 改为"决策→记录→执行"，记录每条分支原因
> - `scripts/accept-image-offload.mjs`：新增 4b 段 7 条断言（E2E 驱动真实 hook）

## 具体操作步骤
> 1. 记录落到 `<DSH_HOME>/cad/telemetry/image-window.jsonl`，字段含 outcome/
>    preset/retained/excess/window/pruned/targets；写失败静默（不阻塞请求）。
> 2. outcome 覆盖 applied / under-window / preset-not-cad / no-session /
>    no-service / aux-purpose / in-flight / error。
> 3. hook 用决策函数而非 null 语义的包装函数，避免把 not-cad 记成 no-service。

## 预期风险与验证
> - 风险点：每请求一行（几百行/天，可忽略）；CAD_TELEMETRY_DISABLE=1 可关。
> - 测试方式：accept-image-offload 4b 段 E2E（真实 hook + 假 ctx）断言五种
>   outcome 与 applied 字段；九套验收全绿；tsc 干净。
