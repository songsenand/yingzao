# ToyMarker · dsh-cad-harness

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](#一安装)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey.svg)](#七平台差异)
[![Status](https://img.shields.io/badge/status-0.1.0%20%E5%AE%9E%E9%AA%8C%E6%80%A7-orange.svg)](#六当前不支持的能力边界)

> **用自然语言描述零件，得到经过验证、可直接打印的模型。**

本插件不是建模界面。几何生成已不是瓶颈，瓶颈在于**确认结果是否正确**：能生成但无法验证的系统
只能产出"看起来对"的结果。本插件把「生成 → 验证 → 迭代 → 交付」做成闭环，需要判断的环节保留给人。

- 描述需求后，由 Agent 编写代码、编译、渲染，并**先自行判读图像**再提交结果
- 引擎提供**数值**：尺寸、体积、壁厚、间隙、干涉、运动行程、流体趋势
- 每一版均为**不可变版本**，可浏览、钉住、对比
- 第三方件（STL / STEP / 3MF / DXF）可进入同一套检查并参与装配

---

## 目录

- [一、安装](#一安装)
- [二、使用流程](#二使用流程)
- [三、配置（用户可调项）](#三配置用户可调项)
- [四、首次使用的准备（约 400MB，数分钟）](#四首次使用的准备约-400mb数分钟)
- [五、验证能力](#五验证能力)
- [六、当前不支持的能力（边界）](#六当前不支持的能力边界)
- [七、平台差异](#七平台差异)
- [八、故障排查](#八故障排查)
- [九、延伸阅读](#九延伸阅读)
- [十、参与贡献](#十参与贡献)
- [十一、许可证](#十一许可证)

---

## 一、安装

| 需要 | 说明 |
|---|---|
| **dsh**（含 Web GUI） | 插件挂在 dsh 上；目前以**本地路径**安装 |
| **Node ≥ 20 + pnpm** | 用于安装与构建插件（本项目在 Node 26 上开发） |
| **OpenSCAD** | 优先使用插件自带快照；也可通过 `CAD_OPENSCAD_BIN` 指向自行安装的可执行文件 |
| **BOSL2** | 标准件库（齿轮/螺纹/螺丝/壁）。需从上游自行下载并放置于 `lib/BOSL2/`（仓库不包含）；放置后用 `dsh-cad-harness/scripts/accept-bosl2.mjs` **校验接线** |
| **Python** | **无需自行准备**——插件内置，首次使用时自动下载（见 §四） |

```bash
# 当前以本地路径安装（分发方式待定，暂无 npm 包名）
dsh plugin --profile <你的 profile> add -w /path/to/dsh-cad-harness

# 修改插件源码后需重新构建并重启 dsh（宿主部分不热重载）
cd /path/to/dsh-cad-harness && pnpm run build

# 预设里的 skill 目录是“生成时这台机器”的绝对路径：
# 换机器/换克隆位置后跑一次，否则 CAD 会话有工具但没有 skill（宿主启动会告警提示这条命令）
cd /path/to/dsh-cad-harness && node scripts/sync-cad-preset.mjs
```

**开启**：新建会话时选预设 **「造物模式」**（也可以在设置里把它设为默认）。

> **为什么必须选择它？** CAD 工具**仅对「造物模式」会话可见**：普通编程会话不应为一个未使用的
> 插件承担工具表开销。在标准模式会话中打开面板时，会明确提示"此会话没有 CAD 工具"，而不是
> 呈现一个空列表。

> 具体命令以所用 dsh 版本的 `dsh plugin --help` 为准。

## 二、使用流程

1. 新建**造物模式**会话，直接描述需求，例如：
   > 做一个 60×40×8 的安装板，四角 M3 沉头孔，中心一个 20mm 通孔
2. Agent 生成 OpenSCAD、编译并渲染四视图，**先自行判读**；不满足则自行修正。
3. 在右栏**面板**中查看模型：测量两点距离、用红框标注问题、在回放中暂停并指认。
   大项目下多个组件（`components/*/`）或多套示例语料并存时，用面板顶部的**工作目录**
   下拉切换查看对象——只读浏览，Agent 的写入始终留在会话所在目录。
4. 需要修改时继续说明（例如"孔径改为 22，保持同心"）；每次改动生成一个新**版本**，可对比。
5. 需要验证时发起验证：装配间隙与干涉、机构运动、流体通过性、可打印性。
6. **交付**：导出 STL / 3MF / OBJ / OFF / WRL；导入件同样可参与装配与验证。
7. **手边有现成的文件**：面板顶部的 **📂**（或种类下拉里的 **未登记**）列出工作区里
   **没有版本的几何文件**（STL / STEP / 3MF / DXF，与 `delivery_audit` 是同一份扫描）。
   选中即在主视口里预览——不弹窗、不登记、不可测量/装配/热力图、不进 Agent 上下文；
   满意后在同一张详情里填**零件名与单位**，点「导入为版本」把它变成可测量、可装配、
   可交付的版本（写入会话所在目录）。文件不在工作区时用「📂 按路径导入…」。
   3MF 必须只含一个对象；DXF 需要填挤出深度。
8. **想多用 Python 库**：直接说就行（或自己跑）——`python_runtime` 的 `action=install` 会把包装进
   **用户 overlay**（`$DSH_HOME/cad/runtime/user-site/`）。那是你的机器、你的线：装的东西
   **不会被运行时升级冲掉**，`run_python` 与 worker 工具都能用，而且每次验证会把它记进
   run 的 provenance。
   **默认：加装不覆盖**——锁里已有的包仍以锁定版本为准（避免悄悄分叉 numpy）。
   **要强制换掉锁定的依赖**：`action=install` 加 `override: true` 与 `reason: "…"`，包会进一个
   单独目录并排在 `sys.path` 最前（真的替换，不是只报告）；理由会写进安装记录、status 与
   每次验证的 provenance。
9. **外观/颜色数据（GLB 侧车）**：如果你有自包含的 GLB，可以用 `attach_appearance`
   把它挂到版本（`appearance.glb` + `appearance.json`）；`model.stl` 仍是几何真值，
   面板仍只预览 STL。Blender/bpy 渲染 lane 已移除（见 DECISION-LOG 2026-10-25）；
   GLB 可在外部查看器打开，面板内 viewer 尚未实现。

## 三、配置（用户可调项）

| 变量 | 作用 | 默认 |
|---|---|---|
| `CAD_OPENSCAD_BIN` | 指定你自己装的 OpenSCAD 可执行文件 | 用插件自带的快照 |
| `DSH_CAD_PYTHON` | `auto` / `eager` / `system`——内置 Python 运行时的供给策略 | `auto` |
| `DSH_CAD_IMAGE_WINDOW` | 上下文里保留的图片窗口（长会话被上游拒绝时调小） | 24；headless 会话建议 `1` |

全部环境变量与诊断开关（含内部调试项）见 [DESIGN.md §32](DESIGN.md)；README 仅列出常用项。

## 四、首次使用的准备（约 400MB，数分钟）

首次用到计算功能时，插件会下载并安装一个**自带的 Python 运行时**，放在 `$DSH_HOME/cad/runtime/`，
之后所有项目共用。

- **原因**：几何分析、精确测量、物理与机构仿真、流体趋势依赖成熟的科学计算库，而无法假定目标
  机器上存在干净可用的 Python（发行版版本不一致，且系统通常禁止安装第三方包）。
- **提前准备**：调用 `python_runtime` 的 `provision`（带进度日志），或设置 `DSH_CAD_PYTHON=eager`
  在启动时后台预热。
- **改用系统解释器**：`DSH_CAD_PYTHON=system` 使用机器上已有的 CPython（当前要求 **3.13**；依赖
  仍按锁定版本安装）。
- **代价**：约 380–400MB 磁盘空间；本机实测 3–11 分钟（取决于网络），可更换镜像/索引源。

## 五、验证能力

| 层 | 回答的问题 | 你会看到 |
|---|---|---|
| 几何 | 尺寸对不对、壁厚够不够、有没有干涉、是不是一个连通实体 | 数值 + 报告卡片 |
| 装配 | 谁和谁配合、间隙多少、有没有**漏声明**的相邻件 | 接口清单逐条核对结果 |
| 刚体 / 机构 | 会不会倒、运动过程中会不会撞、行程够不够 | 轨迹与时间线回放 |
| 流体 | 流得通吗、有没有死区 | 粒子回放 + 趋势数字 |
| 工艺 | 按**你声明的工艺**（FDM/SLA/SLS/…），这个件做不做得出来 | 被排除的工艺 + 反例；不给推荐 |

贯穿全部能力的原则：**工具提供真值，判断保留给人**——"0.75mm 的间隙属于配合意图还是缺陷"，
取决于设计意图。

## 六、当前不支持的能力（边界）

以下为既知边界，非缺陷：

- 不做精确 FEA / 应力分析；流体给的是**趋势判断**，不是工业级 CFD 保证
- 不做工业级公差、工程图、成品 BOM 输出
- 不修复坏网格：坏几何会被**拒收**并告诉你坏在哪，而不是给你一个自信的错误数字
- **版本审批与一键回滚尚未实现**：面板可以浏览、钉住、对比版本，但没有 approve/rollback 动作
- 导入格式：**STL / STEP / 3MF / DXF 可用；IGES 与 OBJ/OFF 不支持**（会被明确拒绝并给出转换建议）
- **外观/颜色**：GLB 只能作为侧车保存；面板不预览 GLB；Blender/bpy lane 已移除
  （2026-10-25）
- 3MF 必须**只含一个对象**：切片软件导出的"一盘多件"会被拒收并说明体数，请导出单个对象
- 本地预览只读 **STL**（浏览器端解析）；STEP/3MF 请走「导入为版本」，由服务器转换
- 不做多用户 / 权限 / 云部署 / 移动端

## 七、平台差异

预期行为，不是故障：

| 平台 | 差异 |
|---|---|
| Linux x64、macOS arm64、Windows x64 | 全部能力 |
| macOS Intel（darwin-x64） | 物理与机构仿真继续用内置引擎（结果可用）；该平台不装 Python 物理库 |
| musl（Alpine 等） | **STEP 导入**与**通用 CFD（LBM）**不可用；其余能力正常 |

## 八、故障排查

| 现象 | 怎么办 |
|---|---|
| 会话中没有 CAD 工具 | 该会话不是「造物模式」；新建时选择该预设，或在设置中将其设为默认 |
| 提示"运行时未就绪" | 首次使用尚未完成供给；触发 `provision`，或设置 `DSH_CAD_PYTHON=eager` |
| 首次使用耗时较长 | 正在下载约 400MB 运行时；可更换镜像/索引源（见 [DESIGN.md](DESIGN.md)） |
| 长会话因图片过多被上游拒绝 | 默认保留 24 张图片窗口；headless 会话设置 `DSH_CAD_IMAGE_WINDOW=1` |
| 某能力报"不可用（缺包）" | 该平台缺少对应的预编译包，属预期行为；状态中会说明原因 |
| `include <BOSL2/std.scad>` 报 "Can't open include file" | `OPENSCADPATH` 必须指向**包含 `BOSL2/` 的父目录**（即 `lib/`），而不是 `lib/BOSL2` 本身。可用 `scripts/accept-bosl2.mjs` 确认接线 |

## 九、延伸阅读

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
  注意 DCO **并非** CLA：它不授权本项目变更许可（限制与理由见 [CONTRIBUTING.md](CONTRIBUTING.md)）。
- **提交信息**按 [AGENTS.md](AGENTS.md) 的规范写四行：`Why` / `Verified` / `Risk`（有方向取舍时加
  `Decision`）。其中 `Verified` 是硬要求：任何"已验证/已完成"的说法都必须能指名一个**可证伪的观察**。
- **方向性决策**写进 [docs/DECISION-LOG.md](docs/DECISION-LOG.md)（append-only，不回改历史条目）。
- 事前检索优先用 git：`git log --follow -- <path>`、`git log --grep="Verified:"`。
- 题库里的第三方素材一律**物化使用、不入库**（见 [examples/bench/ATTRIBUTION.md](examples/bench/ATTRIBUTION.md)）。

## 十一、许可证

本项目以 **Apache License 2.0** 发布 —— 全文见 [LICENSE](LICENSE)，第三方声明见 [NOTICE](NOTICE)，
审计明细见 [docs/THIRD-PARTY-AUDIT.md](docs/THIRD-PARTY-AUDIT.md)。

允许商业使用、修改、闭源再分发与售卖，只需保留版权与许可声明；Apache-2.0 另含**显式专利授权**
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
