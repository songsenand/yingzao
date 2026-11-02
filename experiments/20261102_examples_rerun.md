# 实验报告：examples 阶段 1 清理 + 三个示例的当前引擎复跑

## 目标

在不全量重跑 400+ run 的前提下，验证三件事：

1. `examples/` 的索引/归档标记/缓存清理不会破坏当前工具链；
2. `roberval-balance`、`windup-frog`、`toy-balance2` 的**当前主张**能用当前引擎重新生成 run；
3. “旧 run 没有入参”不是不可跨越的：对少数关键场景，从 README/报告/轨迹反推输入是可行的。

## 假设

- 只重跑被 README/assembly 引用的关键 run，足以刷新示例的当前证据；历史负结果（r001/r002）保持不动。
- 旧 run 的 `run.json`/`report.json` 没有 scenario，但轨迹里的初始位姿 + README 参数 + datum 可以重建大多数 motion 场景。
- 检查契约（`check_assembly`）是零几何重建成本的，应该全部重跑。

## 方法

### 阶段 1：索引 + 归档 + 缓存清理

- 新增 `examples/README.md`，把 16 个目录分为 current / archived / fixture / bench / sandbox。
- 给 `microscope2/3/4`、`toy-balance`、`attention-contact-corner` 加 `ARCHIVED.md`。
- 把 `bench/tools/__pycache__`、`fructose-molecule/.tmp`、`.mplconfig`、`microscope/.tmp` 移到
  `.local-archive/examples/phase1/`（约 77MB，可回退）；**未删除任何 `cad-data/`**。

### 复跑

用真实 `registerCadTools` + 项目语料，在当前源码/运行时上调用：

| 示例 | 工具 | 重建输入 |
|---|---|---|
| roberval-balance | `simulate_physics` / `simulate_motion` / `check_assembly` | 5 件 6 铰，`anchorWorld` + `axisWorld`，top 驱动 0.5 rad/s × 0.02 圈 |
| windup-frog | `simulate_motion`（r060 场景） | drum v043 fixed + cam v049 kinematic + slider v033 oscillator；drum↔cam revolute at `[4,0,4.6]`，cam 2π rad/s；slider ±2mm、1s、−90°；2 周期 |
| windup-frog | `check_assembly` | 当前 `assembly/assembly.json`，I14 引用新 motion run |
| toy-balance2 | `simulate_motion`（r102 场景） | base v001 fixed + beam v026 dynamic；revolute at `[0,0,101]`，beam 0.5 rad/s × 0.03 圈 |
| toy-balance2 | `check_assembly` | 当前 25 条接口；I2 引用新 motion run |

## 结果

### roberval-balance（沿用 2026-11-02 已生成的 run）

| run | 结果 |
|---|---|
| r038 physics | pass · 稳态穿透 0mm · 约束异常 0 · `fellOver` 全 false |
| r042 motion | pass · 漂移 0mm · 24/24 采样 · `closedLoop: true`（2 闭合边） |
| r043 assembly | pass · 26/26 · 0 hard/skipped/undeclared · `motion-clearance` 6 条引用 r042 |

### windup-frog

| run | 结果 |
|---|---|
| r066 motion | **pass** · 49 次检查 / 0 干涉 · 行程 4.000mm · 漂移 0 · 周期 0.979s · 98 pair-checks |
| r068 assembly | **pass** · 14/14 · 0 hard/skipped · 9 undeclared（功能接触） |
| I14 | 已从 r060 改指 r066；r068 detail 写明 “motion evidenced by r066” |

### toy-balance2

| run | 结果 |
|---|---|
| r118 motion | **pass** · 754 步 / 0.377s · 24/24 采样 · 0 干涉 · 0 漂移 |
| r120 assembly | **pass** · 25/25 · 0 hard/skipped · 11 undeclared |
| I2 | 已从 r102 改指 r118；r120 detail 写明 “motion evidenced by r118” |

### 未重跑

- windup-frog **r064**：整机 10 件演示，使用演示底板 v051（research，不是交付件），输入未持久化；当前契约证据用 r066 + r068。
- toy-balance2 **r101**：无转动副的诊断 run，保留作反例。
- roberval **r001/r002**：旧引擎负结果，保留作历史证据；r039 是合并体 motion，仍可读但不再作为当前装配契约证据（r042 才是当前版本）。

## 分析

- 三个示例的关键主张都能在当前引擎上复现，且数字与旧结论一致（49/24 检查、4.000 行程、754 步、24/24 采样），说明 P0/P1 的改动没有回归这三个示例。
- `windup-frog` r060 的重建第一次失败（r065，25 次干涉）：漏了 drum↔cam 的 revolute，导致 cam 以几何中心而不是 `[4,0,4.6]` 为枢轴。补上关节后 r066 与 r060 的 0 干涉/4.000 行程一致。这是“旧 run 没有入参，重建靠轨迹+README”的典型代价。
- `toy-balance2` 的 manifest 在 2026-10-29 的 `9319e03` 已补 tolerance；README §4.2 的“25 条全 skipped”是 r104 及之前的历史状态。当前 r120 是 25/25 pass、11 undeclared，README 已加注。
- 两个 acceptance 的旧账也在本次清掉：`accept-p2` 的 `skipped[].measured=undefined`（工具输出不是 lossless JSON）和 `accept-p3` 的 stale report pointer / caption 文件迁移 / skill 标题漂移。现在 `accept-p2` 与 `accept-p3` 都 PASS。

## 遇到的问题

- 用 `json.dump(indent=2)` 改 `assembly.json` 会把原本 1 空格缩进的 manifest 整体重排（toy-balance2/windup-frog 各有 500–1600 行 diff）。已还原并用纯文本替换只改 `runId`。
- `check_assembly` 的 `skipped` 条目带 `undefined measured` 时，输出守卫会拒绝整个值；已在 `trim` 中省略该键，并加 P2 回归断言。
- `simulate_motion` 的 Python worker 结束后 Node 进程仍持有事件循环；脚本需要 `resetPythonWorker()` 或由后台 job 收集输出。

## 产物列表

**新增/修改：**

- `examples/README.md` —— 当前/历史/夹具/题库/沙箱索引
- `examples/{microscope2,microscope3,microscope4,toy-balance,attention-contact-corner}/ARCHIVED.md`
- `examples/windup-frog/README.md`、`examples/windup-frog/assembly/assembly.json`（I14 → r066）
- `examples/toy-balance2/README.md`、`examples/toy-balance2/assembly/assembly.json`（I2 → r118）
- `dsh-cad-harness/src/host/tools.ts` —— `trim` 省略 undefined `measured`
- `dsh-cad-harness/scripts/accept-p2.mjs`、`accept-p3.mjs` —— lossless / pointer / caption / skill 断言
- `dsh-cad-harness/skills/cad-modeling-measure/SKILL.md` —— `inv(α)` 单位陷阱

**run（本地 `cad-data`，gitignored）：**

- roberval：r038、r042、r043
- windup-frog：r066、r068（r065 是失败的重建尝试）
- toy-balance2：r118、r120

**运行命令（示意，均需 `bind_project` 到对应目录）：**

```js
// motion 输入示例（windup-frog r060 场景）
parts = [
  { name:'drum', versionId:'v043', bodyType:'fixed', position:[0,0,0] },
  { name:'cam', versionId:'v049', bodyType:'kinematic', position:[0,0,0] },
  { name:'slider', versionId:'v033', bodyType:'kinematic', position:[2,0,0] },
];
joints = [{ type:'revolute', bodyA:'drum', bodyB:'cam', anchorWorld:[4,0,4.6], axisWorld:[0,0,1] }];
drive = { body:'cam', axis:[0,0,1], omegaRadPerSec: 2*Math.PI };
oscillators = [{ body:'slider', axis:[1,0,0], amplitudeMm:2, periodSec:1, phaseRad:-Math.PI/2 }];
cycles = 2;
```

## 结论与下一步

- 阶段 1 完成，三个示例的当前证据已刷新；`accept-p2`/`accept-p3` 已转绿。
- 下一步：阶段 2——抽 `verification/fixtures/`（microscope4 r020/r024、microscope2 v010、toy-balance v069），再归档旧语料；不要先删 `cad-data/`，否则 20+ 个 acceptance 会断。
- 新 run 尚未持久化 `scenario.json`；这是“未来可一条命令重跑”的前置，建议下一阶段补。
