# 执行摘要：整机产物过期纪律 + 过期可见标记

## 动机
> 用户报告：整机刚体在零件更新后不更新，要求写进交付纪律。根因是整机级产物
> 全部钉在版本号上，零件出新版本不会让它们过期——旧结果看起来仍有效。

## 影响范围
> - `skills/cad-toolbox/SKILL.md`：交付纪律第 4 条（重跑整机产物/更新 manifest/
>   证据有效期等于所引版本）
> - `src/shared/types.ts`：RunProduct 增加 staleVersionIds
> - `src/host/products.ts`：按"零件最新版本"计算过期引用
> - `src/client/panel.ts`：运行行 ⚠ 标记 + 报告页签琥珀提示
> - `scripts/accept-stale-evidence.mjs`：新验收；`verification/shots/stale-evidence.png`

## 具体操作步骤
> 1. buildProducts 建 newestOfPart 表，run 的 sourceVersionIds 里不是最新版的
>    记为 staleVersionIds（未知 id 不判、无版本的内联场景不判）。
> 2. 面板：recordLabel 加 ⚠ 标记；报告页签渲染琥珀提示行。
> 3. skill 纪律第 4 条写明三条动作与判据。

## 预期风险与验证
> - 风险点：只在面板可见，模型侧靠 skill 纪律（若要硬门禁，可在 check_assembly
>   引用过期运行时判 hard-violation——见 DESGIGN §22 遗留）。
> - 测试方式：accept-stale-evidence 6 PASS；七套验收全绿；tsc 干净；沙盒截图
>   视觉确认（行标记 + 报告提示）。
