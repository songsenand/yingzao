# 0.2.0-preview.1 发布候选报告（生成）

> 本文件由 `node scripts/release-report.mjs --write` 生成，内容取自**当时的仓库**；
> 手改会被下一次生成覆盖。门禁表读自发布说明，不重新打字。

- 版本：`dsh-cad-harness@0.2.0-preview.1`
- 提交：`d60f7c0`（2026-11-27 22:14:40 +0800）
- 自 `v0.1.2-preview.1` 起：**45** 个提交；未提交的已跟踪改动：**45** 个
- 构建产物：`lib/index.js` 1833 KB
- 固定前缀基线（2026-11-26）：**5930 chars**（9 面 schema 4065，预算 6144；skill 目录 1865；对照 45 旧工具 104675）

## 门禁（11 收口 / 2 待签收，共 13）

| 项 | 状态 | 证据（来自发布说明） |
|---|---|---|
| Q2 工具面 v1 冻结 | ✅ 收口 | `TOOL-SURFACE-V1.json`（9 面 × 45 action）+ `accept-tool-surface` + `accept-cad-all-surfaces`（元数据派生，非字面量） |
| Q1 token 预算 | 🟡 partial | `accept-token-budget`（固定前缀 5,930 chars ≈ 1,483 tok）+ `experiments/20261127_0.2.0_token.md`；**缺 3 任务 A/B**（需真会话） |
| U20 剖切（沿视角 + 深度）+ 封盖 | ✅ 收口 | 模式＝轴切 / **沿视角**（点「剖切」时按当前屏幕取面，剖切中旋转切面固定，关掉再开按新视角重取；默认切掉近侧一半，剖面正对用户；角度滑块已删）；`accept:section-cap-area`（独立面积判据 + 立方体自测 + **质心**）对探针 2 件 + 语料 4 件 × 4 法向 × 9 深度**全 0.00%**；封盖平移缺陷已修（镜筒 33mm 偏移，新增质心/包围盒判据）；`accept-ui section-free`（24 项）；**缺你的目视签收** |
| U21 大网格进度 + WebGL 恢复 | 🟡 partial | `accept-stream-progress`（17 项）+ `accept-ui webgl-recover` + **百万面实测**：999,698 tri / 47.7 MB，传输 188 ms、解析 82 ms、首帧 74 ms、稳态 63.9 ms/帧（`accept-ui big-mesh`）；**缺真机切标签页** |
| U12 装配逐件显隐/隔离/高亮 | ✅ 收口 | `accept-ui assembly-hide`（11 项） |
| U11 视口导航 | ✅ 收口 | `accept-ui views`（13 项）+ `accept-viewport-orbit`（视图数学 +14） |
| U19 面板审计视图 | ✅ 收口 | `accept-audit-gaps`（19 项）+ `accept-ui audit-view`（8 项） |
| U15 测量四族 + 历史 | ✅ 收口 | `accept-measure-families`（33 项）+ `accept-ui measure-families`（8 项） |
| F1 流体域闭合 | ✅ 收口 | `accept-fluid-wall-policy`（19）+ `accept-fluid-convergence`（9，结论：到达率**不跨 dx 收敛**）+ `accept-fluid-constraint`（11：Ø34@dx1 穿透 7,098→0、到达率 0.031→0.385、`escaped+active=count0` 精确、关掉约束复现 7,098）+ **两引擎 parity 已跑**（py 0.3989 vs ts 0.3852，py 穿透 0） |
| F2 流轴与短粗件 | ✅ 收口 | `accept-fluid-axis`（15 项，含旧规则反证） |
| N15 流体进度/取消 | ✅ 收口 | `accept-fluid-jobs`（22 项，真子进程 kill 后 0 ms settle、无孤儿）+ `accept-ui fluid-job`（7 项） |
| U14 检查一键重跑 | ✅ 收口 | `run.json` 记 `request`；`check-rerun` 三态 direct/replay/needs-args；`accept-check-rerun`（37）+ `accept-ui rerun-check`（11）+ **`accept-stress` 37/37**（提取后的 `runStressJob` 真跑） |
| U22 BOM CSV | ✅ 收口 | `accept-bom-csv`（22 项）+ `accept-ui bom-csv`（8 项，下载字节被截获校验） |

## 还差什么

- **Q1** token 预算 — 🟡 partial
- **U21** 大网格进度 + WebGL 恢复 — 🟡 partial

签收步骤见 `docs/dev/CHECKLIST-preview.1-signoff.md`；三项都是"人眼/真机/真会话"，
机器侧证据已在上面每一行里。

## 发版命令（需要批准）

```bash
cd dsh-cad-harness
npm run release:preflight        # 版本同步 / 预设 / 构建 / accept:release / UI / 文档链接
git tag -s v0.2.0-preview.1 -m "0.2.0-preview.1"
git push origin v0.2.0-preview.1
npm stage publish                # 手机 npmjs.com → Staged Packages 批准
```
