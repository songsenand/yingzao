# 执行摘要：标准模式回归 dsh 出厂默认（图片干预仅限造物模式）

## 动机
> 用户裁定：标准模式不应被修改——"永不裁剪"也不是默认配置，默认是"根本不设
> 预算"。撤销 §16.4 残留的两处全局干预，所有图片策略仅在造物模式生效。

## 影响范围
> - `dsh-cad-harness/cordis.patch.yml`：删除 llm-deepseek 预算块（恢复出厂）
> - `dsh-cad-harness/src/host/index.ts`：移除 applyPiAiImageBudget 调用
> - `dsh-cad-harness/src/host/image-budget.ts`：删除 pi-ai 写入与 PI_AI_* 常量
> - `dsh-cad-harness/src/host/image-offload.ts`：选择器按 preset 分派
>   （cad=保护+窗口；其余=现货原版行为）；投影不再拒绝用户图决策
> - `dsh-cad-harness/src/host/usage.ts`：pi-ai 镜像改"无路由预算"
> - 两个 accept 脚本期望重写；`DESGIGN.md` §17

## 具体操作步骤
> 1. cordis.patch.yml 移除 llm-deepseek 预算（出厂 600/20，组合树确认无
>    maxImagesPerRequest）。
> 2. selectOffloadTargets 增加 protectUserImages 参数；offloadOldestProtected
>    按 `session.header.agentPreset === 'cad'` 分派；投影层防御移除
>    （非 cad 的现货决策必须可原样重放）。
> 3. usage.ts pi-ai 分支 maxImages/maxBytes 均 undefined。

## 预期风险与验证
> - 风险点：造物会话预算完全靠主动窗口（超窗首个请求多付一次）；非 cad 会话
>   用户图恢复现货行为（最老优先被裁）——这正是"默认"的定义。
> - 测试方式：accept-image-offload 21 PASS（cad/standard 同夹具对照）；accept-
>   image-budget 全绿（UNPATCHED + disabled + preset-cad + 镜像 195 例）；
>   accept-recall 回归 OK；tsc 干净。
