# 安装与首次准备

## 需要什么

| 需要 | 说明 |
|---|---|
| **dsh**（含 Web GUI） | 插件挂在 dsh 上；目前以**本地路径**安装 |
| **Node ≥ 20 + pnpm** | 用于安装与构建插件（本项目在 Node 26 上开发） |
| **OpenSCAD** | 优先使用插件自带快照；也可通过 `CAD_OPENSCAD_BIN` 指向自行安装的可执行文件 |
| **BOSL2** | 标准件库（齿轮/螺纹/螺丝/壁）。需从上游自行下载并放到 `lib/BOSL2/`（仓库不包含） |
| **Python** | **无需自行准备**——插件内置，首次使用时自动下载 |

## 安装

```bash
# 当前以本地路径安装（分发方式待定，暂无 npm 包名）
dsh plugin --profile <你的 profile> add -w /path/to/dsh-cad-harness

# 修改插件源码后需重新构建并重启 dsh（宿主部分不热重载）
cd /path/to/dsh-cad-harness && pnpm run build

# 预设里的 skill 目录是“生成时这台机器”的绝对路径：
# 换机器/换克隆位置后跑一次，否则 CAD 会话有工具但没有 skill
cd /path/to/dsh-cad-harness && node scripts/sync-cad-preset.mjs
```

> 具体命令以所用 dsh 版本的 `dsh plugin --help` 为准。

## 开启

新建会话时选预设 **「造物模式」**（也可以在设置里把它设为默认）。

**为什么必须选它？** CAD 工具**仅对「造物模式」会话可见**：普通编程会话不应为一个未使用的插件承担工具表开销。在标准模式会话中打开面板时，会明确提示“此会话没有 CAD 工具”，而不是呈现一个空列表。

## 首次准备（约 400MB，数分钟）

首次用到计算功能时，插件会下载并安装一个**自带的 Python 运行时**，放在 `$DSH_HOME/cad/runtime/`，之后所有项目共用。

- **原因**：几何分析、精确测量、物理与机构仿真、流体趋势依赖成熟的科学计算库，而无法假定目标机器上存在干净可用的 Python。
- **提前准备**：让 Agent 执行运行时的 `provision`（带进度日志），或设置 `DSH_CAD_PYTHON=eager` 在启动时后台预热。
- **改用系统解释器**：`DSH_CAD_PYTHON=system` 使用机器上已有的 CPython（当前要求 **3.13**；依赖仍按锁定版本安装）。
- **代价**：约 380–400MB 磁盘；本机实测 3–11 分钟（取决于网络），可更换镜像/索引源。

## BOSL2

`include <BOSL2/std.scad>` 报 “Can't open include file” 时，`OPENSCADPATH` 必须指向**包含 `BOSL2/` 的父目录**（即 `lib/`），而不是 `lib/BOSL2` 本身。可用 `dsh-cad-harness/scripts/accept-bosl2.mjs` 确认接线。

## 验证安装

新建一个「造物模式」会话，说：

> 做一个 20mm 的立方体。

看到一个新版本和四张视图，就说明安装成功。没有的话看 [故障排查](troubleshooting.md)。
