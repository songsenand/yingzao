# 执行摘要：bench 04 补全零件（语料与设计定案，题面在下一轮）

## 动机

按 06 → 04 → 05 的顺序，第二题是**补全零件**：给一个第三方 OpenSCAD 小装配体的
若干零件，去掉 1–3 件，要求模型补上。语料路径已由 2026-10-12 决策定案：
**MIT（暂行）+ 物化脚本 + 钉 commit 不入库**。

## 语料：`jazwa/rackstack`（MIT）

- **钉 commit**：`8e296e935aad89a6d1a5023da79becc634c10c2d`（`git ls-remote` 实取）。
- **为什么选它**：它是**真正的多零件装配**（78 个模块：导轨/横杆/侧壁/托盘/接头/
  磁铁模块/底脚…），而且零件都是**参数化驱动、互相咬合**的——这正是"补一件"的前提：
  缺的那件由其余件的接口决定，不是凭空设计。
- **本地 `yingzao3/data/real_parts/rackstack` 不可用**：那是另一种用途的抽样
  （78 个模块、44 个错误、`include` 依赖没抽出来），不能当装配用。所以现场取。

### 取语料的两条实测坑（都写进脚本注释）

1. **`raw.githubusercontent.com` 在这台机器上不可达**（curl exit 35 / node
   `UND_ERR_CONNECT_TIMEOUT`），而 `codeload.github.com` 与 `api.github.com` 可达。
   所以不能按文件 raw 下载。
2. **codeload 的整包 tarball 太慢/太大**（120s 只下到 7.9MB，仓库里应该有大文件）。
   改用 **git 稀疏取**：`git init` + `core.sparseCheckout`（`*.scad`）+
   `git fetch --depth 1 --filter=blob:none origin <sha>` + `checkout FETCH_HEAD`
   → **100 个 `.scad`、740K、秒级完成**，且 `rev-parse HEAD` 可核对就是钉死的 commit。

二进制 STL 用 `openscad --export-format binstl`（默认是 ASCII，工具链要二进制）。

## 设计：补哪一件

已编译并实测了几个候选（`connectivity` / `measure_part` / `list_features`）：

| 件 | 三角形 | 尺寸 mm | 说明 |
|---|---|---|---|
| `stackConnectorBottom_P` | 444 | 9.8 × 9.8 × 12.0 | 9.8mm 方轨的**堆叠底接头**（最小、最受约束） |
| `rackJoiner_P` | 876 | 9.8 × 9.8 × 20.5 | 同族：导轨对接件（**作样例给出**） |
| `mainRail_P` | 5856 | 9.8 方轨，长件 | 导轨本体（**作给定件**） |
| `magnetModuleLeft/Right_P` | 2412 | 7 × 20 × 13 | 严格镜像对（太容易：镜像即答案，不测测量） |
| `xyPlate_P` | — | 跨框板 | 尺寸由框架参数决定，但引出整框装配 → 归 05 |

**选择**：给定 `mainRail_P` + `rackJoiner_P`（同族的另一个接头，示范"接头如何咬 9.8
方轨"），要求补出**堆叠底接头**。判据按**功能**而不是"抄原件的形状"：

- 能套上/滑入 9.8 方轨（接合剖面的截面尺寸在容差内）；
- 长度足以跨过对接缝（区间判定，不是等于 12.0）；
- 有与导轨螺孔对得上的固定孔（孔位/孔径与实测导轨特征比对）；
- 与导轨装配**不干涉**（`validate_assembly`），且是单体、可打印；
- 外观（人判）：像一件能用的接头。

这样多种合法设计都能过，而**错的会过不了**（阴性对照：截面尺寸错 2mm、或孔位对不上）。

## 预期风险与验证

- **风险：把"补全"考成"复刻"**。处置：判据用功能区间 + 干涉 + 孔位，不用"与原件逐点一致"。
- **风险：语料取不到**（网络）。处置：物化脚本要能离线复用已取到的缓存；
  取不到时题面侧要能明确报错，而不是让模型在空目录里找零件。
- **验证方式（下一轮）**：`accept-...` 风格的评分方自检（合成 run root 跑
  `bench-score.mjs`，证明判据会响）+ 真值由工具实测记录。

## 已顺手修掉的真缺陷（本轮的额外收获）

取语料时发现**我自己的 `list_features` 在真实第三方几何上崩溃**（未初始化内存进
连通图）。已修并加门控回归，详见
[`20261012_feat_bench_06_measure.md`](20261012_feat_bench_06_measure.md) 的附录与
commit `59de531`。**这是"题面只能靠真实语料验证"的一个具体例证**。

## 下一步

1. 把取语料 + 编译写成 `examples/bench/graders/04-.../materialize.mjs`（钉 commit、
   文件清单、每个 `.scad` 的 git blob sha 校验、可选离线缓存）。
2. 写 `subjects/04-.../TASK.md`、`graders/04-.../{prompt.md,rubric.json,key.md}`、
   真值（用工具实测原件的接口尺寸）、`bench-score.mjs` 求值器、评分方自检。
3. `bench-run.mjs` 注册 04（含 `prep` 物化步骤）。
