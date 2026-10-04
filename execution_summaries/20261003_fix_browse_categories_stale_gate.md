# 执行摘要：整机过期硬门禁 + 三栏浏览三处修复

## 动机
> 用户三项要求：① 把"引用过期运行"做成硬门禁；② 切类后下级列表更新慢/串味；
> ③ 仿真、组件、装配契约内容经常为空。

## 影响范围
> - `src/host/assembly-check.ts`：§22 硬门禁（引用的运动运行若基于被取代的
>   版本 → hard-violation），新增版本最新表 + staleCitations
> - `src/client/browse.ts`（新）：分类/去重纯函数
> - `src/client/panel.ts`：改用 browseCategories；切类自动落位最新；两个分支
>   select 加不同 key
> - `sandbox/preview/server.mjs`：名字白名单改用 safeArtifactName（中文零件名）
> - 验收：accept-browse-categories（10 项）、accept-sim-verdict 扩展 §22 门禁
>   2 项；截图存档 3 张

## 具体操作步骤
> 1. assembly-check 加载版本表算 newestOfPart，引用运行的 sourceVersionIds 中
>    非最新 → hard-violation，detail 说明 STALE 与具体版本。
> 2. 分类逻辑抽到 browse.ts：按 id 去重（scene 优先保留跨零件标签）、
>    组件=assembly、契约=assembly-check、最新在前。
> 3. 面板选中 effect 改为跟随当前类别列表 + kindRef，切类落到最新条目。

## 预期风险与验证
> - 风险点：§22 门禁依赖版本 partId 完整性（无 partId 的历史版本不判定）。
> - 测试方式：8 套验收全绿（含 microscope5 真实数据沙盒截图视觉确认：
>   仿真·28 自动落位、组件·19 渲染真实装配、契约·22 报告表格）。
