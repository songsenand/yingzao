# 执行摘要：插件内受保护图片裁剪执行器（用户图豁免）

## 动机
> 现货 dsh 裁剪最老优先、无豁免，用户参考图必然第一个出局（DESGIGN §15.1 #4）。
> 用户拍板方案 B（DECISION-LOG 2026-10-03）：不打宿主文件，插件内替换执行器。

## 影响范围
> - `dsh-cad-harness/src/host/image-offload.ts`：新增（现货执行器移植 + 用户图豁免）
> - `dsh-cad-harness/src/host/index.ts`：挂载执行器
> - `dsh-cad-harness/cordis.patch.yml`：现货 `image-offload` 行 `disabled: true`
> - `dsh-cad-harness/scripts/accept-image-offload.mjs`：新验收（13 项）
> - `dsh-cad-harness/scripts/accept-image-budget.mjs`：更新"用户图被裁"断言为新现实
> - `DESGIGN.md` §16、`verification/microscope3-token-report.md` §10

## 具体操作步骤
> 1. image-offload.ts：逐行移植现货选择器/投影/瀑布，唯一差异——`user/message`
>    顶层图片不入选；投影层加防御（命中用户图的决策拒绝重放）；不 import dsh-llm
>    （错误码常量 + code 鸭子类型）。
> 2. cordis.patch.yml 停用现货行；组合树验证 `disabled: true` 落地。
> 3. index.ts 挂载；sessions 服务未就绪时轮询（2s×60），headless 无害。

## 预期风险与验证
> - 风险点：`sessions.registerMessageProjection` + `image/offload` 事件形状是
>   内部接缝，dsh 大版本可能漂移——accept-image-offload 的组合树与行为断言会红，
>   不会静默失效；只剩用户图可裁时返回 null，瀑布照常（无死循环）。
> - 测试方式：`accept-image-offload.mjs` 13 PASS（选择逻辑含现货同夹具对照、
>   投影校验 6 例、组合树 disable + 旧 patch 回归）；`accept-image-budget.mjs`
>   与 `accept-recall.mjs` 全量回归 OK；tsc 干净。
> - 待真实环境复核：重启 dsh 后日志应出现
>   "cad-harness: protected image-offload executor mounted"。
