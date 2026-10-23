# 实验报告：玩具天平第二版——新 skill 与工具编组的能力对照

日期：2026-10-20　｜　产物：`examples/toy-balance2/`

## 目标

同一份需求（`PROMPT.md`）在两种工具/技能条件下各做一次玩具托盘天平，回答两个问题：

1. 换上新的 skill 路由（`cad-toolbox` + 4 本深度 skill）与工具编组（交付/检测/仿真/仪器 + `preflight`）后，能力是否提升？
2. 会不会出现明显错误？错误出在模型、skill，还是工具？

## 假设

- 新 skill 的"先选组、再选工具"和交付纪律会让流程更完整（每个零件跑门、claims 进审计）。
- `preflight` 已把"六件事"收成一次调用，漏跑的概率下降。
- 工具编组会真的裁掉不需要的工具，减少误用。

## 方法

- **隔离**：子智能体（spawn，干净上下文）只允许读 `examples/toy-balance2/PROMPT.md` 与通过 `skill` 加载的手册；禁止读旧示例、任何 `cad-data/`、docs、experiments、HARNESS.md，禁止 git。
- **语料隔离**：运行前把根 `cad-data/`（旧版 36 版本 / 74 run）整体移到 `.tmp-tb2/root-cad-data`，根语料从空开始；新数据落在根 `cad-data/`。
- **独立复测**：评审者用 trimesh + manifold3d 直接量 STL（体积比、面积比、两盘 z、300 对布尔求交、质量、悬垂），并逐个复现工具报错；不采信子智能体的数字。
- **对照基线**：旧示例 `examples/toy-balance/README.md` 的实测数字（同一需求，2026-10-19）。

## 结果

| 指标 | 旧版 | 新版 |
|---|---|---|
| 装配契约 | 35/35（每条有 tolerance） | 25/25，但 **25 条没有一条声明 tolerance** → 空绿（I3 轴偏移 116 mm 也报 pass） |
| 干涉（排除自攻） | 0 | 0（2 处自攻过盈 13.52 / 37.64 mm³，声明） |
| 工作行程 | 14°，0 干涉 0 漂移 | 10.8°，0 干涉 0 漂移 |
| 砝码体积比 | 16:8:4:2:1 | 16.000:8.000:4.000:2.000:1.000（独立复测） |
| 最大砝码 / 托盘内底面积 | 0.500 | 0.50000 |
| printability verdict | 5 类全部拿到（2 ok / 2 check / 1 excluded） | 5 ok（仅砝码；8 件拿不到） |
| 底座悬垂 | 981.3 mm² | **8264.8 mm²**（无支撑不可打印；三种姿态 ≥3314 mm²） |
| 交付审计 | 0 blocked | 2 blocked（合并研究件） |
| 工具缺口 | 5 条（旧轮发现，多数已修） | 4 条新 bug + 3 条文档缺口 |

设计/装配硬伤（评审者复测）：

- **底座不可无支撑打印**：板底 z=15 离床 7 mm，朝下悬垂 8264.8 mm²；翻转/侧放 ≥3314 mm²。
- **调零滑块夹紧螺钉装反**：world z 92–102，夹爪 100–107，螺钉头埋在夹爪里、螺纹悬空；37.639 mm³"干涉"其实是 Ø5.5 头减 Ø2.5 孔。`coaxial` 接口只查轴线共线，25/25 全过也发现不了（缺一条头承面↔夹爪底面 distance=0）。
- **25/25 是空绿**：25 条接口全部没有 `tolerance`，旧规则 `in_range = tolerance ? ... : true` 把"没有判据"当"在范围内"。I3/I4 把左右叉孔与对侧吊架配对（轴偏移 116 mm），报告仍写 pass。

复现的工具 bug（评审者亲测）：

- `check_printability(mode=judge)` → `missing required property "value.attention"`（默认模式全挂）。
- `check_printability(mode=both)` 有悬垂区域 → `regions[0].triangles is not a declared property`；无悬垂但坐标为 `-0` → `value is not lossless JSON`。
- `preflight(...)` → `userExecute is not a function`（注册成 `run`，`defineTool` 只认 `execute`）。
- `openscad -D '$fn=64'` 覆盖文件级 `$fn=6`：螺母变圆柱（56.71 vs 43.7 mm³）。
- 空装配清单只回 `Cannot read properties of undefined (reading 'id')`。

## 分析

1. **流程 ↑，证据 ↓**。新 skill 确实让 agent 按"仪器→装配→仿真→交付"走，STALE 和 claims 都起了作用；但交付门本身坏了：默认 printability 不可用、preflight 崩溃。agent 用 `measure_thickness` 替代壁厚，**壁厚测不出悬垂**，于是把一块 8265 mm² 的悬空板判成"加 brim 即可"。
2. **编组没有真正生效**。profile 有 `toolScope: preset`，但没有 `presetGroups`，52 个工具全可见；本轮实际检验的是 skill 路由表，不是按组裁剪。`scan_attention` 一次未调用，检测组是空的。
3. **坏工具会污染语料**。失败的 `check_printability` 仍然提交 run（同一 v001 写了 5 次），摘要里有正确数字，但没有工具把它送回 agent；`delivery_audit` 只报 blocked/warn，不报"这个数字你漏了"。
4. **设计退步是工具退步的下游**。旧版底座可平放（981 mm²）；新版为了三点调平把底板架在 3 个凸台上，这个选择本身合理，但"5 mm 板 + 全板悬空"必须由打印门拦下。门坏了，错误就过了。
5. **接口计数不是证据**。25/25 全过，仍有一枚螺钉装反：`coaxial` 只查轴线共线，不约束轴向落座；manifest 里没有"头承面↔夹爪底面 distance=0"。这正是 cad-assembly skill 说的"两个好点不能证明同轴"的同类问题——这次是"一条好轴不能证明落座"。
6. **"缺失 = 通过"是贯穿这轮的工具病**：printability 缺 `attention` 字段 → 崩；check_assembly 缺 `tolerance` → 绿；manifest 缺 schema → 让模型猜 16 次。三个方向，同一个根：工具没有把"我不知道/没有判据"当成一种必须说出来的状态。

## 遇到的问题

- **隔离规则的混杂**：禁止读 `cad-data/` 是为了防旧语料泄露，但也遮住了本轮 run 报告，agent 无法从 r018 找回 8264.8 mm²。这不是主要成因（工具回复本身已被拒），但放大了后果。
- **`merge_parts` 研究件**：v026/v030 被审计当成可打印零件，产生 2 条无法消除的 blocked；工具没有"研究件"语义。
- **渲染透视误导**：`whole-front.png` 里两盘看着不等高，实际 z 完全相同；评审要用装配位姿数字，不能只看图。

## 产物列表

**代码/脚本：**
- 无新增脚本；复测全部走 `run_python`（trimesh/manifold3d）+ 工具调用。

**数据：**
- `examples/toy-balance2/cad-data/`：30 版本、54 run（含 r049–r054 评审复测）；根 `cad-data/` 为软链接。
- `examples/toy-balance2/assembly/assembly.json`：25 接口（根 `assembly/` 为软链接）。
- `.tmp-tb2/root-cad-data`：旧语料完整备份（未还原）。
- `examples/toy-balance2/BUILD.md`、`README.md`（评审）、`renders/*.png`。

**运行命令：**
```bash
# 评审复测
check_assembly(manifestPath="assembly/assembly.json", adjacencyThresholdMm=0.75)   # 25/25
check_printability(versionId="v008", mode="both", profileIds=["fdm-pla-0.4"])      # ok
check_printability(versionId="v001", mode="judge", profileIds=["fdm-pla-0.4"])     # 复现 bug
preflight(claims=[...])                                                             # 复现 bug
```

**环境：** DSH web profile，`opencode-go / deepseek-v4.1-flash`，CAD harness `lib/` 构建于 2026-10-20 14:44。

## 结论与下一步

- 新 skill/编组**提升了过程可审计性，但没有提升（反而降低了）本轮的交付证据强度**；明显错误是"底座不可无支撑打印"这一条，根因是 `check_printability` 与 `preflight` 双双失效。
- 已修（本轮，需**重启 DSH web 进程**生效）：
  1. manifest 校验器改为 path/expected/got/hint + 最小清单 + 端点语法 + schema 文件；空清单不再 TypeError（`accept-manifest-errors.mjs` ALL PASS）。
  2. `preflight`：`run` → `execute`，补 `project = await allStores(exec)`；声明 profileIds 时显式 unevaluable。
  3. check_assembly：**无 tolerance → skipped**，skipped 计入 overallStatus；Python 与 TS 双实现同步（parity OK）。
  4. `check_printability` 三种 mode 与 `simulate_stress` 三种 mode 的字段不再被静态 required 卡死；regions 放开证据字段；`-0` 归一（printability parity all checks passed）。
  5. `analyze`：未知版本带可用 id、角扫描失败写 notMapped、运行来源移到 commit。
  6. `versionNotFound()` 统一 8 处未知版本报错；mode/bodyType 加 enum；`CadToolGroup` 类型补齐；两本 skill 补"报错怎么读"。
- 下一步：
  1. `$fn` 注入改为在源码前拼 `$fn=64;`，不要用 `-D`。
  2. `merge_parts` 产物加 `research` 标记，`delivery_audit` 不要求其 printability。
  3. 重启后重跑本示例：确认底座悬垂降下来、printability 6/6 有 verdict、check_assembly 显示 0 pass / 25 skipped。
