[English](../en/user/install.md) | 中文

# 安装与首次准备

## 需要什么

| 需要 | 说明 |
|---|---|
| **dsh**（含 Web GUI） | 插件挂在 dsh 上；预览版以 tarball 或本地路径安装 |
| **Node ≥ 20 + pnpm** | 安装/运行插件；tarball 用户不需要 build，DSH 内部仍会用 pnpm |
| **OpenSCAD** | `setup --openscad=auto` 自动准备；已有 2025.06+ 系统版本则直接用。官方快照优先，官方不可达/持续低于 256 KB/s 才切 OSS。也可用 `CAD_OPENSCAD_BIN` 指定现有二进制 |
| **BOSL2** | 可选 **OpenSCAD 建模库**（齿轮/螺纹/螺丝/壁），不是 99 标准件目录。从上游自行下载到 `lib/BOSL2/`，包内不包含 |
| **标准件目录 v0** | 随包分发 99 个预生成规范件（fit/visual，STEP/STL），无需安装；**0.1.1-preview.1 还没有 `cad_part` 的目录选择/导入操作**。见 [标准件目录](../llm/library.md) |
| **Python** | **不随包分发**；首次分析/仿真时下载约 400MB 到 `$DSH_HOME/cad/runtime/` |

**标准件目录随包**；OpenSCAD、BOSL2 和 Python runtime 不随包。

## 安装

### 方式 A：tarball（预览版首发，不需要 build）

```bash
tar -xzf dsh-cad-harness-0.1.1-preview.1.tgz
dsh plugin --profile <你的 profile> add -w "$PWD/package"
cd package
npx dsh-cad-setup --openscad=auto   # 非交互默认 openscad；TTY 会询问内核
npx dsh-cad-doctor
npx dsh-cad-backend --show
```

### 方式 B：源码 checkout（开发）

```bash
dsh plugin --profile <你的 profile> add -w /path/to/dsh-cad-harness
cd /path/to/dsh-cad-harness && pnpm install && pnpm run build
node scripts/setup.mjs --openscad=auto   # 或显式 --kernel cadquery
npx dsh-cad-doctor
```

改动 Host 代码后需重新 `pnpm run build` 并重启 dsh（宿主 bundle 不热重载）。tarball 用户不需要这一步。

`npx dsh-cad-setup --openscad=auto`（源码目录里的 `node scripts/setup.mjs --openscad=auto` 等价）会重新生成
`presets/cad/preset.patch.yml`，写入当前机器的 `skills/` 路径，并准备 OpenSCAD。
`--kernel openscad|cadquery` 选择作者内核； OpenSCAD 解析按**版本最高者**选择；系统旧版本不会覆盖插件内已安装的高版本快照。TTY 且未给 flag 时会询问，默认 OpenSCAD。非交互且未给 flag 时不覆盖现有 `backend.json`。
选择写入 `$DSH_HOME/cad/backend.json`，已配置的 `compileBackend`/`binaryPath` 会保留。
`--openscad=off` 只写预设、不下载；`--openscad=official` / `mirror` 可强制单源。
`--no-interactive` 禁止询问（适合 CI）；`--check` 只检查预设，不改 `backend.json`。
**CadQuery 的 pack 约 1.6 GiB，setup 只写选择、不自动下载**；OpenSCAD 仍是渲染/导出的常驻依赖。
`npm run setup:check` 只检查不写，路径过期或缺 skill 时退出 1。改完需重启 dsh。

> **升级 dsh 之后要重跑一次 `npx dsh-cad-setup` 再重启。** 预设是照着你装的 dsh 的
> `standard.patch.yml` 逐字复制生成的，dsh 在新版本里会删改内部行；预设是整块挂载的，
> 一行对不上，整个「营造模式」就不出现——不报错，只是没有这个模式。`npx dsh-cad-doctor`
> 会报 `preset-standard-drift` 并给出这行修复命令。

再跑一次环境自检：

```bash
npx dsh-cad-doctor          # kind=ok，或有解释的 degraded（例如 OpenSCAD 2021）
npx dsh-cad-backend --show  # kernel=openscad, compileBackend=auto
```

`dsh-cad-backend` 是内核/编译后端的选择入口。0.1.1 提供 **OpenSCAD** 与 **CadQuery**；
`freecad` 仍是 planned，不可选。CadQuery 需要另行显式安装 pack（约 1.6 GiB），安装后再选；
OpenSCAD 始终保留用于四视图渲染和网格导出。

> 具体命令以所用 dsh 版本的 `dsh plugin --help` 为准。

## 开启

新建会话时选预设 **「营造模式」**（也可以在设置里把它设为默认）。

**为什么必须选它？** CAD 工具**仅对「营造模式」会话可见**：普通编程会话不应为一个未使用的插件承担工具表开销。在标准模式会话中打开面板时，会明确提示“此会话没有 CAD 工具”，而不是呈现一个空列表。

## 首次准备（约 400MB，数分钟）

首次用到计算功能时（包括 OpenSCAD 的 datum 解析），插件会下载并安装一个**自带的 Python 运行时**，放在 `$DSH_HOME/cad/runtime/`，之后所有项目共用。

- **原因**：几何分析、精确测量、物理与机构仿真、流体趋势依赖成熟的科学计算库，而无法假定目标机器上存在干净可用的 Python。
- **提前准备**：让 Agent 准备运行时（带进度日志），或设置 `DSH_CAD_PYTHON=eager` 在启动时后台预热。
- **改用系统解释器**：`DSH_CAD_PYTHON=system` 使用机器上已有的 CPython（当前要求 **3.13**；依赖仍按锁定版本安装）。
- **代价**：约 380–400MB 磁盘；本机实测 3–11 分钟（取决于网络），可更换镜像/索引源。

## BOSL2

`include <BOSL2/std.scad>` 报 “Can't open include file” 时，`OPENSCADPATH` 必须指向**包含 `BOSL2/` 的父目录**（即 `lib/`），而不是 `lib/BOSL2` 本身。可用 `dsh-cad-harness/scripts/accept-bosl2.mjs` 确认接线。

## 验证安装

新建一个「营造模式」会话，说：

> 做一个 20mm 的立方体。

看到一个新版本和四张视图，就说明安装成功。没有的话看 [故障排查](troubleshooting.md)。
