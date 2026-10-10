# 执行摘要：opt-in 图像窗口开关（`DSH_CAD_IMAGE_WINDOW`），修 03 评测段被上游拒图

## 动机
> 03-microscope 的 headless 链路验证：A 段 `exit 1`，B 段因此未跑。
> stderr 根因：`INVALID_REQUEST 400: Too many images in request: 70 > 64`（上游 provider 的图像条数上限）。

## 影响范围
> - `dsh-cad-harness/src/host/image-offload.ts`：新增 `forcedCadImageWindow()` + 收窄的 `presetOfSession`
> - `HARNESS.md`：新增 opt-in 开关表
> - 构建产物 `lib/index.js`（gitignored）需重建——被检插件走 `package.json` 的 `main`

## 具体操作步骤
> 1. **根因链**：headless 不 compose 预设注册表 ⇒ 会话无预设名 ⇒ `presetOfSession` 返回 null ⇒
>    图像执行器按"非 cad"分派（stock 行为，**不主动裁剪**）⇒ 渲染密集题的请求堆到 70 张 ⇒
>    上游上限 64 ⇒ 400 ⇒ `dsh` exit 1 ⇒ runner 按设计停止后续段。
> 2. **开关**：`DSH_CAD_IMAGE_WINDOW=1` 时，`presetOfSession` 对**解析结果为空**的会话返回 `cad`，
>    于是同一套 24 张窗口与用户图豁免生效；**带真预设的会话不受影响**（`standard` 仍是 `standard`）。
>    默认关 ⇒ 标准/日常会话保持 dsh 工厂行为（用户既定规则：插件不碰路由预算）。
> 3. 重建 bundle；回归 `accept-image-offload`、`accept-image-budget`、`accept-tool-scope`、`accept-project-scope`。

## 预期风险与验证
> - **风险**：开关若误开，会让非造物会话也裁图。缓解：只在"解析不到预设名"时生效，且默认关；
>   文档写明它服务于 headless/无预设环境的评测。
> - **验证（单元级）**：无 env / 无预设 → `null`；有 env / 无预设 → `cad`；有 env / `standard` → `standard`；
>   有 env / `cad` → `cad`；投影返回 `cad` → `cad`。`tsc` 干净；四条相关验收全过。
> - **验证（端到端）**：带 `DSH_CAD_IMAGE_WINDOW=1` 重跑 03-microscope headless（两段 + 探针），
>   观察 A 段是否 exit 0、B 段是否续接、评分是否跑完。
