# 06-measure · 参考解与判据说明（**评分方，不得出现在考生侧**）

> 题面：[`subjects/06-measure/TASK.md`](../../subjects/06-measure/TASK.md)
> 真值：`ground-truth.json`（**全部由工具实测**，每项都记了 op/参数/原始返回）
> 复现：`node build-parts.mjs && node ground-truth.mjs`（后者是判据数字的唯一来源）

## 一、参考解（实测值）

| 问题 | 答案 | 得到它的工具 |
|---|---|---|
| 圆柱特征 | **4 处**：boss Ø22、bore Ø16（**盲孔，深 12**）、bore Ø14（通孔）、bore Ø8（通孔） | `list_features` |
| 两通孔孔心距 | **50.000mm**（x = −25 与 +25） | `list_features` 的孔心 + `measure_distance`（或 `measure_section` 的 `holeSpacing`） |
| 圆筒壁厚 | **3.000mm**（外 Ø22 / 内 Ø16） | `measure_thickness`（从筒轴沿 +x，单段 [8, 11]） |
| 斜面夹角 | **acute 30.000°**（as-given 取决于探针法线朝向，实测 150°） | `measure_angle` |
| 整体尺寸 | X **80.000**（−40…40）、Y **50.000**（−25…25）、Z **20.000**（0…20） | `measure_extent` |
| 沿 [1,1,0] | **91.924mm**（−45.962 → +45.962）＝ (80+50)/√2 | `measure_extent` `axisVector` |
| 板中高剖面（z = 4） | 孔 **2** 个、孔心距 **50.000mm**、材料面积 **3796.124mm²** | `measure_section`（`atMm: 4`） |
| `part-b` 改了什么 | **圆筒内径 Ø16 → Ø14**，壁厚 **3.000 → 4.000mm**（Δ **+1.000**） | 同一套口径量两件 |

## 一·五、开始之前的那一步：导入

工具都以**版本号**为入口（不是文件路径），所以参考解的第一步是
`import_part` 把两个 STL 各导入成一个版本（考卷只给了工作目录下的两个文件，
没说"请导入"——这正是 `S` 列要测的：`SKILL.md` 的路由表能不能把
"use this STL someone sent me" 接到 `import_part`）。
若某一轮模型因此卡住，那是**手册生效度**的发现，不是这道题坏了。

## 二、几个"差一点就错"的地方（人判时的对照表）

| 看似合理的错答 | 为什么错 | 抓它的判据 |
|---|---|---|
| 剖面材料面积报 **3795.797mm²**（80×50 − π·4² − π·7² 的理想值） | `$fn=96` 的多边形略小于理想圆，**材料比理想值多**。这个差（0.33mm²）比容差（1mm²）小，所以**两种都放过**——但若考生报的是"我按公式算的"，`f-method-stated` 要扣 | 容差内不罚数字，罚"来源说不清" |
| 沿 [1,1,0] 报 **96.953mm**（= √(80²+50²+20²)，三维体对角线） | 题面要的是**沿该轴的投影起止**（91.924），不是体对角线的长度。这是两个不同的量 | `c-diagonal-extent` |
| 把凸台内孔当成**通孔** | 它是盲孔：板在这个位置是实心的，孔深 12mm（`list_features` 的 `lengthMm`） | `c-cylinder-count` 只数个数；`f-method-stated` 人判是否读懂了 bore 记录 |
| 夹角报 **60°** 或 **150°** 而不声明口径 | 斜面与底面**本身**的夹角 30°（锐角）；法线夹角是 150°。都对，但必须说清报的是哪个 | `c-slope-angle` + `f-angle-convention-declared` |
| 壁厚报 **4.000mm**（把 `part-b` 的值写在 `part` 上） | 两件只差这一处，串了就是串了 | `c-tube-wall` 与 `g-no-invented-numbers`（4.000 若只出现在 part-b 的返回里，写在 part 上会被抓住） |

## 三、判据与求值器（机检 13 条 + 人判 3 条）

- **硬门 6**：`g-grader-access`、`g-measure-json`、`g-tools-not-bypassed`、
  `g-no-invented-numbers`、`g-delta-correct`、`g-negative-control-fires`。
  任一不过 → `P = 0`（`gatePolicy: any-fail`）。
- **数值判据 7**：`c-cylinder-count` / `c-tube-wall` / `c-hole-centre-distance` /
  `c-slope-angle` / `c-diagonal-extent` / `c-section-hole-distance` / `c-section-area`。
  期望值全部取自 `ground-truth.json`；**真值缺失时判 `unknown`，绝不算通过**。
- **特征项 3（人判）**：`f-method-stated`、`f-angle-convention-declared`、
  `f-not-measurable-honest`。
- **求值器覆盖自检**：`grep` rubric 的 id 与 `bench-score.mjs` 的注册项，
  必须 13/13 有求值器、3 条人判项除外（改 rubric 后请重跑这条检查）。

## 四、阴性对照（两层）

1. **题面内的对照**：`part-b.stl` 与 `part.stl` **只差圆筒内径**（Ø16 → Ø14），
   要求考生用**同一套口径**把两件的数都报出来。所以"看渲染猜一个像样的数"或
   "把 part 的数抄到 part-b" 都会在 `g-delta-correct` 上暴露。
2. **判据非空的自证**：`g-negative-control-fires` 检查改动量（1.000mm）是否
   大于壁厚容差（0.05mm）——若某天有人把容差放宽到 1mm 以上，这条会红，
   提醒"阴性对照已经失效"。

**机检自检**（不调模型，合成 run root 直接跑 `bench-score.mjs`）：

```bash
node examples/bench/graders/06-measure/self-check.mjs
```

四个场景必须按预期响应：正确回答全绿；编一个数（壁厚 3.5）→ `c-tube-wall` 与
`g-no-invented-numbers` 双红；只调 `run_python` → `g-tools-not-bypassed` 红；
不做两件对比（delta 报 0）→ `g-delta-correct` 红。**实测四场景全部按预期响应。**

## 五、这一卷测的是"工具"而不是"模型会不会算"

判据刻意建立在**工具层面的因果**上：`g-tools-not-bypassed` 要求 `list_features` 与
`measure_thickness` 被真正调用过，`g-no-invented-numbers` 要求每个数字都能在工具返回里
找到。所以一个"自己解析 STL 字节算出全部答案"的会话会**挂在这两条门上**——这不是惩罚，
而是本题的测量对象：**这套测量工具能不能让模型把"看不见的几何"量对**。
考卷已明说要用工具量、且允许"量不到就说量不到"，因此这不是暗坑。

沙箱状态（如实记录）：**尚无一轮真实会话**。本题目前只有评分方自检与实测真值，
**没有沙箱日志检查，也没有视觉检查**（本题不要求看图即可完成，视觉检查主要针对
GUI 档的剖切面观感）。
