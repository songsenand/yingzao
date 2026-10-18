# 执行摘要：图片预算修复的沙盒复核与机制对齐

## 动机
> 用户指出严重纪律问题：上一轮插件改动交付时未在沙盒内运行验证。补跑验证后
> 发现四处改动在真实环境无效，需逐一对齐现货 dsh 并固化交付纪律。

## 影响范围
> - `dsh-cad-harness/cordis.patch.yml`：llm-deepseek 行名修正、移除失效 agent-presets 块
> - `dsh-cad-harness/package.json`：bundle patch 改为数组，追加 preset.patch.yml
> - `dsh-cad-harness/presets/cad/preset.patch.yml`：新生成（新 preset 机制）
> - `dsh-cad-harness/scripts/sync-cad-preset.mjs`：重写（文本级派生）
> - `dsh-cad-harness/scripts/accept-image-budget.mjs`：重写（对照真实 dsh-llm API）
> - `dsh-cad-harness/src/host/image-budget.ts`、`src/host/usage.ts`：对齐现货机制
> - `DESGIGN.md` §15、`verification/microscope3-token-report.md` §9：纪律与更正

## 具体操作步骤
> 1. 修正 cordis.patch.yml：`@deepseek-ai/dsh-llm-deepseek` → `@deepseek-ai/dsh-llm-deepseek-api-key`（组合树实测行名）。
> 2. 删除指向已不存在包的 agent-presets patch；sync-cad-preset.mjs 改为从安装版 standard.patch.yml 文本派生 `preset.patch.yml`（保留 `!!js` 表达式），package.json 以 patch 数组应用。
> 3. image-budget.ts：删除虚构的 `maxRequestImages` 写入，`PI_AI_KEEP_BYTES` 2.5MiB→256KiB（按实测 base64 p50≈8.6KB/张校准 ≈24 张）；机制改为"字节越线 → IMAGE_OFFLOAD_REQUIRED → 现货 offload 插件最老优先裁剪重试"。
> 4. usage.ts 遥测镜像对齐：pi-ai 仅字节口径；移除不存在的"用户图豁免"假设。
> 5. accept-image-budget.mjs：交叉校验改为加载已安装 dsh 树的真实 `requiredImageOffload`/`projectOffloadedImages`；新增组合树落地检查（llm-deepseek 预算行、preset-cad、零 patch skip）。

## 预期风险与验证
> - 风险点：256KiB 字节预算对大图会话裁剪更激进（占位符可 read_image 找回）；
>   preset-cad 由生成文件派生，dsh 升级后需重新 sync。
> - 测试方式：`node scripts/accept-image-budget.mjs` → 39 PASS / 0 FAIL
>   （含真实 CLI 组合树检查）；`npx tsc --noEmit` 干净；`sync-cad-preset --check` 通过。
> - 遗留：pi-ai 侧用户参考图无豁免是现货内核行为，插件侧只能缓解（召回工具 /
>   新会话），根治需重打宿主 patch 并纳入升级后复核。
