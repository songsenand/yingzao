# Examples

这个目录同时放了三类东西，**用途不同，不要一起清理**：

1. **当前示例（current）**——README 里的数字/证据仍应可复跑；本地 `cad-data/` 是语料（gitignored）。
2. **历史迭代 / 夹具（archived / fixture）**——保留 tracked 文档、SCAD、assembly 作历史；本地 `cad-data/` 不再维护。
3. **题库与沙箱**——`bench/` 是测评题库（见 [bench/ATTRIBUTION.md](bench/ATTRIBUTION.md)）；`dsh-home/` 是插件的 `DSH_HOME` 沙箱，**不是示例**。

> `examples/*/cad-data/` 被 `.gitignore` 排除；克隆仓库只得到文档与 tracked 资产。复跑前先看该示例 README 的“运行/证据”一节。

## 当前示例

| 示例 | 角色 | 最后活动 | 本地语料 | 当前证据 / 说明 |
|---|---|---:|---:|---|
| [roberval-balance](roberval-balance/README.md) | 准生产罗伯威尔天平；物理/运动闭环修复的主证据 | 2026-11-02 | 24MB | r038（physics）/ r042（当前版本 motion）/ r043（assembly 26/26）；r001/r002 为旧引擎负结果，已 superseded |
| [windup-frog](windup-frog/README.md) | 发条青蛙机芯 | 2026-11-02 | 41MB | r066（凸轮—滑块 motion）/ r068（assembly 14/14）/ r069（12 件 0 干涉）；r064 演示未重跑 |
| [toy-balance2](toy-balance2/README.md) | 玩具天平 v2（干净上下文复跑） | 2026-11-02 | 38MB | r118（motion）/ r120（assembly 25/25，11 undeclared） |
| [microscope5](microscope5/PROJECT.md) | 单目复式显微镜（当前版） | 2026-10-04 | 48MB | UI/交付测试依赖其 `cad-data`；不要当历史清理 |
| [ball-and-stick](ball-and-stick/README.md) | 葡萄糖/果糖球棍模型 | 2026-10-28 | 126MB | 每个分子独立项目；`.tmp` 已归档，语料按需裁剪 |
| [multirotor-propeller](multirotor-propeller/README.md) | 三叶多旋翼螺旋桨 | 2026-10-11 | 10MB | 见 README |
| [passage-bottleneck](passage-bottleneck/README.md) | 非圆通道最窄处测量台架 | — | 0 | 解析真值夹具，无 `cad-data` |
| [appearance-eval](appearance-eval/README.md) | `check_appearance` 边界夹具 | 2026-11-01 | 0.2MB | 四个小项目，故意埋缺陷 |

## 历史 / 归档

这些目录保留 tracked 文档与关键资产，**本地语料不再维护**；每个目录有 `ARCHIVED.md` 说明替代项。

| 示例 | 替代 | 最后活动 | 本地语料 |
|---|---|---:|---:|
| [microscope](microscope/README.md) | M1 历史报告，保留 | 2026-10-01 | 1.3MB |
| [microscope2](microscope2/PROJECT.md) | [microscope5](microscope5/PROJECT.md) | 2026-10-01 | 340MB（待阶段 3 归档） |
| [microscope3](microscope3/PROJECT.md) | [microscope5](microscope5/PROJECT.md) | 2026-10-02 | 54MB（待阶段 3） |
| [microscope4](microscope4/PROJECT.md) | [microscope5](microscope5/PROJECT.md) | 2026-10-03 | 37MB（测试夹具已抽取后归档） |
| [toy-balance](toy-balance/README.md) | [toy-balance2](toy-balance2/README.md) | 2026-10-28 | 11MB（待阶段 3） |
| [attention-contact-corner](attention-contact-corner/README.md) | 夹具，非示例 | 2026-10-29 | 31MB（待阶段 3） |

## 题库 / 沙箱

| 目录 | 说明 |
|---|---|
| [bench](bench/README.md) | 测评题库；第三方素材按 [ATTRIBUTION.md](bench/ATTRIBUTION.md) 物化，不入库 |
| `dsh-home/` | 插件沙箱 `DSH_HOME`（profiles/credentials/settings），**不是示例**；已被 `.gitignore` 排除，禁止提交 |

## 清理记录

- 2026-11-02：阶段 1——清 `bench/tools/__pycache__`、`fructose-molecule/.tmp`、`fructose-molecule/.mplconfig`、`microscope/.tmp`（约 77MB，移到 `.local-archive/examples/phase1/`）；加归档标记与索引。**未删除任何 `cad-data/`**。
- 2026-11-02：阶段 1b——重跑当前示例的关键证据：roberval r038/r042/r043、windup-frog r066/r068/r069、toy-balance2 r118/r120；`accept-p2`/`accept-p3` 转绿。详见 [experiments/20261102_examples_rerun.md](../experiments/20261102_examples_rerun.md)。
- 阶段 2（待做）：把 microscope4 r020/r024、microscope2 v010、toy-balance v069 抽到 `verification/fixtures/`，再归档旧语料。
- 阶段 3（待做）：归档 microscope2/3/4、toy-balance、attention 的本地 `cad-data`，更新 `PROJECT-SCOPE`。
