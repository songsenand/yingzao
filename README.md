# ToyMarker · dsh-cad-harness

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](#一安装)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey.svg)](#七平台差异)
[![Status](https://img.shields.io/badge/status-0.1.0%20%E5%AE%9E%E9%AA%8C%E6%80%A7-orange.svg)](#六现在做不到的)

> **用日常语言描述一个零件，得到一个被验证过的、能打印的模型。**

这不是又一个建模界面。生成几何早就不难了，难的是**知道结果对不对**——能生成但不能验证的系统，
产出的是"看起来对"。本插件把「生成 → 验证 → 迭代 → 交付」做成闭环，其中需要判断的地方留给人。

- 你说需求，它写代码、编译、渲染，并**先自己看图**再交给你
- 引擎给**数字**：尺寸、体积、壁厚、间隙、干涉、运动行程、流体趋势
- 每一版都是一个**不可变版本**，可以浏览、钉住、对比
- 别人的件（STL / STEP / DXF）也能进同一套检查，参与装配

---

## 目录

- [一、安装](#一安装)
- [二、怎么用：一次真实流程](#二怎么用一次真实流程)
- [三、配置（用户会碰的开关）](#三配置用户会碰的开关)
- [四、第一次使用：一次性准备](#四第一次使用一次性准备约-400mb几分钟)
- [五、它能验证什么](#五它能验证什么)
- [六、现在做不到的](#六现在做不到的)
- [七、平台差异](#七平台差异)
- [八、出问题先看这几条](#八出问题先看这几条)
- [九、想更深入](#九想更深入)
- [十、参与贡献](#十参与贡献)
- [十一、许可证](#十一许可证)

---

## 一、安装

| 需要 | 说明 |
|---|---|
| **dsh**（含 Web GUI） | 插件挂在 dsh 上；目前以**本地路径**安装 |
| **Node ≥ 20 + pnpm** | 用于安装与构建插件（本项目在 Node 26 上开发） |
| **OpenSCAD** | 优先用插件自带的快照；也可用 `CAD_OPENSCAD_BIN` 指向你自己装的 |
| **BOSL2** | 标准件库（齿轮/螺纹/螺丝/壁）。**由你自行从上游下载**并放在 `lib/BOSL2/`（仓库不含它）；放好后用 `dsh-cad-harness/scripts/accept-bosl2.mjs` **校验接线** |
| **Python** | **不需要你准备**——插件自带，首次使用时自动下载（见 §四） |

```bash
# 以本地路径安装（对外分发方式待定，故暂无 npm 包名）
dsh plugin --profile <你的 profile> add -w /path/to/dsh-cad-harness

# 改过插件源码后需要重建，然后重启 dsh（宿主部分不热重载）
cd /path/to/dsh-cad-harness && pnpm run build
```

**开启**：新建会话时选预设 **「造物模式」**（也可以在设置里把它设为默认）。

> **为什么必须选它？** CAD 工具**只对「造物模式」的会话可见**——这是刻意的：普通编程会话不该
> 为一个用不到的插件付出工具表开销。如果你在标准模式会话里打开面板，它会明确告诉你"这个会话
> 没有 CAD 工具"，而不是让你对着空列表猜。

> 命令细节以你的 dsh 版本 `dsh plugin --help` 为准。

## 二、怎么用：一次真实流程

1. 新建**造物模式**会话，直接说需求。例如：
   > 做一个 60×40×8 的安装板，四角 M3 沉头孔，中心一个 20mm 通孔
2. Agent 生成 OpenSCAD、编译、渲染四视图，**自己先判读**；不对就自己改。
3. 你在右栏**面板**里看模型：量两点距离、标红框指出问题、在回放里暂停指认。
4. 要改就继续说（"孔改成 22，保持同心"）。每次改动产生一个新**版本**，可以对比。
5. 需要验证就让它验证：装配间隙与干涉、机构运动到不到位、流体能不能流过去、能不能打印。
6. **交付**：导出 STL / 3MF / OBJ / OFF / WRL。导入的件同样能参与装配与验证。

## 三、配置（用户会碰的开关）

| 变量 | 作用 | 默认 |
|---|---|---|
| `CAD_OPENSCAD_BIN` | 指定你自己装的 OpenSCAD 可执行文件 | 用插件自带的快照 |
| `DSH_CAD_PYTHON` | `auto` / `eager` / `system`——内置 Python 运行时的供给策略 | `auto` |
| `DSH_CAD_IMAGE_WINDOW` | 上下文里保留的图片窗口（长会话被上游拒绝时调小） | 24；headless 会话建议 `1` |

全部环境变量与诊断开关（含内部调试用）在 [DESIGN.md §32](DESIGN.md) 里，README 只列你真会用的这三个。

## 四、第一次使用：一次性准备（约 400MB、几分钟）

首次用到计算功能时，插件会下载并安装一个**自带的 Python 运行时**，放在 `$DSH_HOME/cad/runtime/`，
之后所有项目共用。

- **为什么要它**：几何分析、精确测量、物理与机构仿真、流体趋势，这些能力依赖成熟的科学计算库，
  而"你机器上正好有一个干净可用的 Python"这件事不能假定（发行版版本不一、系统还常常禁止装包）。
- **想提前装好**：让 Agent 调用 `python_runtime` 的 `provision`（有进度日志），或设
  `DSH_CAD_PYTHON=eager` 在启动时后台预热。
- **不想下载解释器**：`DSH_CAD_PYTHON=system` 可以用你机器上的 CPython（目前实际需要 **3.13**；
  依赖仍按锁定版本安装）。
- **代价**：约 380–400MB 磁盘、本机实测 3–11 分钟（取决于网络）；慢的话可以换镜像/索引源。

## 五、它能验证什么

| 层 | 回答的问题 | 你会看到 |
|---|---|---|
| 几何 | 尺寸对不对、壁厚够不够、有没有干涉、是不是一个连通实体 | 数值 + 报告卡片 |
| 装配 | 谁和谁配合、间隙多少、有没有**漏声明**的相邻件 | 接口清单逐条核对结果 |
| 刚体 / 机构 | 会不会倒、运动过程中会不会撞、行程够不够 | 轨迹与时间线回放 |
| 流体 | 流得通吗、有没有死区 | 粒子回放 + 趋势数字 |
| 工艺 | 按**你声明的工艺**（FDM/SLA/SLS/…），这个件做不做得出来 | 被排除的工艺 + 反例；不给推荐 |

一条原则贯穿全部：**工具报真值，判断留给你**——"0.75mm 的间隙是配合意图还是缺陷"，只有你知道。

## 六、现在做不到的

边界，不是 bug：

- 不做精确 FEA / 应力分析；流体给的是**趋势判断**，不是工业级 CFD 保证
- 不做工业级公差、工程图、成品 BOM 输出
- 不修复坏网格：坏几何会被**拒收**并告诉你坏在哪，而不是给你一个自信的错误数字
- **版本审批与一键回滚尚未实现**：面板可以浏览、钉住、对比版本，但没有 approve/rollback 动作
- 导入格式：**STL / STEP / DXF 可用；IGES 不支持**（会被明确拒绝并给出转换建议）
- 不做多用户 / 权限 / 云部署 / 移动端

## 七、平台差异

预期行为，不是故障：

| 平台 | 差异 |
|---|---|
| Linux x64、macOS arm64、Windows x64 | 全部能力 |
| macOS Intel（darwin-x64） | 物理与机构仿真继续用内置引擎（结果可用）；该平台不装 Python 物理库 |
| musl（Alpine 等） | **STEP 导入**与**通用 CFD（LBM）**不可用；其余能力正常 |

## 八、出问题先看这几条

| 现象 | 怎么办 |
|---|---|
| 会话里没有 CAD 工具 | 这个会话不是「造物模式」。新建时选它，或在设置里设为默认 |
| 提示"运行时未就绪" | 首次使用还没供给。让它 `provision`，或设 `DSH_CAD_PYTHON=eager` |
| 第一次用特别慢、像卡住 | 正在下载约 400MB 的运行时；可换镜像/索引源（见 [DESIGN.md](DESIGN.md)） |
| 长会话被上游拒绝（图片太多） | 已有 24 张图片保留窗口；headless 会话加 `DSH_CAD_IMAGE_WINDOW=1` |
| 某能力报"不可用（缺包）" | 该平台没有对应的预编译包，属预期；状态里会写明原因 |
| `include <BOSL2/std.scad>` 报 "Can't open include file" | `OPENSCADPATH` 必须指向**包含 `BOSL2/` 的父目录**（即 `lib/`），而不是 `lib/BOSL2` 本身。跑 `scripts/accept-bosl2.mjs` 可确认接线 |

## 九、想更深入

| 文档 | 讲什么 |
|---|---|
| [HARNESS.md](HARNESS.md) | 它是什么、不是什么、边界在哪、按什么原则取舍 |
| [DESIGN.md](DESIGN.md) | 当前设计：架构、模块、接口、**环境变量与诊断开关全集** |
| [docs/DECISION-LOG.md](docs/DECISION-LOG.md) | 取舍历史：当初为什么这么选（append-only） |
| [AGENTS.md](AGENTS.md) | 本项目的编码纪律（提交信息要写 Why / Verified / Risk） |
| [docs/THIRD-PARTY-AUDIT.md](docs/THIRD-PARTY-AUDIT.md) | 第三方依赖与素材的许可审计 |
| [examples/](examples/) | 完整样例与题库（显微镜、螺旋桨、长凳…） |
| `dsh-cad-harness/skills/` | 给 Agent 的地图：场地里有什么、该走哪条路 |

## 十、参与贡献

- **完整规则见 [CONTRIBUTING.md](CONTRIBUTING.md)**：每次提交都要 `git commit -s` **签名**（DCO 1.1）。
  注意 DCO **不是** CLA——它不授权本项目更换许可（限制与理由写在 CONTRIBUTING 里）。
- **提交信息**按 [AGENTS.md](AGENTS.md) 的规范写四行：`Why` / `Verified` / `Risk`（有方向取舍时加
  `Decision`）。其中 `Verified` 是硬要求：任何"已验证/已完成"的说法都必须能指名一个**可证伪的观察**。
- **方向性决策**写进 [docs/DECISION-LOG.md](docs/DECISION-LOG.md)（append-only，不回改历史条目）。
- 事前检索优先用 git：`git log --follow -- <path>`、`git log --grep="Verified:"`。
- 题库里的第三方素材一律**物化使用、不入库**（见 [examples/bench/ATTRIBUTION.md](examples/bench/ATTRIBUTION.md)）。

## 十一、许可证

本项目以 **Apache License 2.0** 发布 —— 全文见 [LICENSE](LICENSE)，第三方声明见 [NOTICE](NOTICE)，
审计明细见 [docs/THIRD-PARTY-AUDIT.md](docs/THIRD-PARTY-AUDIT.md)。

你可以自由商用、修改、闭源再分发与售卖，只需保留版权与许可声明；Apache-2.0 另含**显式专利授权**
与专利报复条款。

| 组件 | 许可 | 是否随仓库分发 |
|---|---|---|
| 本项目（dsh-cad-harness / ToyMarker） | Apache-2.0 | 是 |
| [BOSL2](https://github.com/BelfrySCAD/BOSL2) | BSD-2-Clause | **否**——你自行下载，本地放 `lib/BOSL2/`（已 gitignore） |
| OpenSCAD | GPL-2.0 | 否——以**独立程序**调用（非链接），或用插件自带快照 |
| Python 运行时与科学计算包 | 各自许可 | 否——`python_runtime` 在你的机器上下载 |
| 题库第三方素材（Pixabay 等） | Pixabay Content License 等 | 否——**物化使用、不入库** |

> 本项目自身不含任何 GPL/AGPL/LGPL 代码；18 个直接依赖全部为 MIT 或 Apache-2.0。
> 第三方**素材与库一律不入库**（`lib/` `bin/` `cad-data/` 均在 .gitignore 中）。
