[English](../en/user/configuration.md) | 中文

# 配置（用户可调项）

| 变量 | 作用 | 默认 |
|---|---|---|
| `CAD_OPENSCAD_BIN` | 指定你自己装的 OpenSCAD 可执行文件 | 用插件自带的快照 |
| `DSH_CAD_PYTHON` | `auto` / `eager` / `system`——内置 Python 运行时的供给策略 | `auto` |
| `DSH_CAD_IMAGE_WINDOW` | 上下文里保留的图片窗口（长会话被上游拒绝时调小） | 24；headless 会话建议 `1` |

全部环境变量与诊断开关（含内部调试项）见 [DESIGN.md §32](../../DESIGN.md)；这里只列用户真正会用的三个。

## 常见组合

- **网络慢/首次启动想省时间**：`DSH_CAD_PYTHON=eager`，启动时后台预热运行时。
- **机器上已有 Python 3.13**：`DSH_CAD_PYTHON=system`，用系统解释器，但依赖仍按锁定版本安装。
- **长会话被上游以图片过多拒绝**：把 `DSH_CAD_IMAGE_WINDOW` 调小；headless 会话用 `1`。
