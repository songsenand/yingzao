# 执行摘要：recall_reference_image 参考图召回工具

## 动机
> 现货 dsh 的图片裁剪是全场最老优先、无用户图豁免（DESGIGN §15.1），用户参考图
> 必然第一个被裁出上下文。插件侧的可靠兜底：让模型能把已裁剪的参考图按需召回，
> 召回后的图是当前请求里最新的，天然免疫后续裁剪。

## 影响范围
> - `dsh-cad-harness/src/host/tools.ts`：新增 `recall_reference_image` 工具
> - `dsh-cad-harness/skills/cad-toolbox/SKILL.md`：路由表 + Traps 教养
> - `dsh-cad-harness/scripts/accept-recall.mjs`：新验收脚本

## 具体操作步骤
> 1. tools.ts 注册 `recall_reference_image`：入参 `path`（占位符里的路径，首选）
>    或 `attachmentId`（sha256 持久引用）。path 模式限 20MiB + PNG/JPEG/WebP 魔数校验；
>    attachmentId 模式走 `ctx.attachments.readImage`。字节经 `saveImages` 重入
>    内容寻址仓库（同字节去重，不产生副本），图片块挂在工具结果上 → 成为最新图。
> 2. execute 返回 `recallToken`，finalizeContent 按 token 精确取回本次的图
>    （并发多召回不错位），token 在 render 时剥离，不进模型可见文本。
> 3. SKILL.md：路由表加一行；Traps 加"最老优先 → 参考图最先被裁 → 看到占位符
>    且任务依赖该图时先召回；交付'与参考图一致'的结论前必须让参考图在场"。

## 预期风险与验证
> - 风险点：依赖模型主动调用（skill 教养缓解）；finalize 若 dsh 改契约需适配
>   （accept-recall 会抓到）。
> - 测试方式：`node scripts/accept-recall.mjs` → 13 PASS / 0 FAIL（真实工具代码
>   + 桩附件库，含双召回不错位、token 不泄漏、错误路径）；视觉确认：召回输出图
>   与构造原图一致（verification/shots/recall-visual-check.png，120×90 RGB 200/60/30）；
>   `accept-image-budget.mjs` 全量回归 OK；tsc 干净。
