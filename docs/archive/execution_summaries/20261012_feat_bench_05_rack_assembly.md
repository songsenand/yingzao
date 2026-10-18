# 执行摘要：bench 05 装配给定零件（闭环）

## 动机

题库补全的第三题（06 → 04 → 05）。这一卷测**装配**：给两件已画好的零件，
要求把它们的相对位姿摆对。语料路径沿用 2026-10-12 决策：**MIT + 物化脚本 + 钉 commit 不入库**。

## 影响范围

- `examples/bench/graders/05-rack-assembly/{materialize,measure-05,self-check}.mjs`、
  `{rubric,ground-truth}.json`、`{key,prompt}.md`
- `examples/bench/subjects/05-rack-assembly/TASK.md`
- `examples/bench/tools/bench-score.mjs`（05 求值器 + **判据 id 消歧**）
- `examples/bench/tools/bench-run.mjs`（注册 05 + prep 钩子）
- `examples/bench/tools/check-rubric-ids.mjs`（**新增**：跨卷判据 id 检查器）
- 三卷的 rubric 与 self-check（id 改名）
- bench README（表 1–4 / §三 / §九 / §2 指纹）

## 具体操作步骤

1. 复用 04 的物化机制（同一钉死 commit `8e296e93` + 全树摘要 + 缓存），编两件给考生；
   **参考装配用语料自己的装配入口** `attachXBarWithYBar(at=0)` 编出（只进评分方缓存）。
   修掉一处实测坑：驱动 SCAD 必须写在 checkout **内部**，否则 `./common.scad`
   相对 include 直接 "Can't open input file"。
2. 真值实测：xBar 32 × 176.799 × 15（1 体/13020 三角）、yBar 29.995 × 183.988 × 25
   （1 体/17578 三角）、**参考装配包络 227.99 × 184 × 45**、参考件 12 体。
3. 判据落点：**包络 ±2mm**（合法位姿唯一；摆错一个面差几十毫米，判据仍敏感）
   + 干涉 0（摆对是贴合、摆错多半是插进去）+ 合并后 **1 个连通体**
   + 关键配合尺寸要有工具出处。
4. 机检自检：四场景（正确 / **两件留原点** / 没跑验证 / 声明 2 体）实测全部按预期。

## 预期风险与验证

- **风险：包络判据写成"三个轴都必须不同"**。实测发现 y 轴本来就相同
  （滑动横杆不改变该方向包络：参考 184 vs 原点 184.393）→ 阴性对照的自证会误判成"空的"。
  已改成"**至少一个轴**落在容差外"（偷懒状态会被拒即成立）。
- **真缺陷（本批最重要的一条，且是我自己引入的）**：`bench-score.mjs` 的求值器是
  **全局按判据 id 注册**的，而我三卷都用了 `g-negative-control-fires`（三个实现语义
  各不相同），04/05 又共用 `g-tools-used` → **后注册的覆盖先注册的**。
  症状极隐蔽：06 的自检其实在跑 05 的实现，而输出一切正常。
  **发现方式**：04 的自检里 `g-tools-used` 突然"该红没红"。
  处置：三卷各起独有 id（`g-negative-delta-fires` / `g-negative-copy-fires` /
  `g-negative-origin-fires`、`g-measure-and-model` / `g-tools-05-measure`），
  并在 EV 区顶部写明纪律。
- **新增防护**：`tools/check-rubric-ids.mjs` 扫描 8 卷 135 条判据，把跨卷同名分成三类
  ——白名单（语义完全相同）、按 `level` 分派（既有约定）、**与卷无关**（只读该轮自身数据，
  如"最终装配是否零硬冲突"）——只报第三类之外的危险：**同名却引用了某一卷专属的真值/地标常量**。
  这类正是我踩的。检查器还修掉两处自身误报：一个 id 可以先注册通用实现再包一层分派
  （要看**最后一次**注册）；`00-smoke` 是**脚本驱动**，其判据不进 EV 表。
  现状：**OK —— 没有危险的跨卷重名**。
- **测试方式**：三卷 self-check 全绿（06 4/4、04 4/4、05 4/4）；
  `check-rubric-ids.mjs` 通过；05 dry-run 通过（run root 在 /tmp，仓库外）。

## 三卷交付状态

| 题 | 件/真值 | TASK/rubric/key | 求值器覆盖 | 机检自检 | runner | 沙箱日志/视觉检查 |
|---|---|---|---|---|---|---|
| 06-measure | ✅ | ✅ | 16 条 / 0 unknown | ✅ 4/4 | ✅ | ⏳ 未做 |
| 04-rack-connector | ✅ | ✅ | 15 条 / 0 unknown | ✅ 4/4 | ✅（prep） | ⏳ 未做 |
| 05-rack-assembly | ✅ | ✅ | 14 条 / 0 unknown | ✅ 4/4 | ✅（prep） | ⏳ 未做 |

**沙箱状态如实记录**：三卷都**没有真实会话**，日志检查与视觉检查均未做；
各卷 `key.md` 末节与 bench README §九 都写明了这一点，并列出真跑后视觉检查要看什么。
