# CAD 校准 / 流程测试语料（归档）

**归档日期：** 2026-11-01
**来源：** `ToyMarker/cad-data/` 的 `v001–v007`、`p001–p007`、`r001–r005`，以及根
`assembly/` 下的 `appearance-*.json` / `simple*.json`。
**为什么在这里：** 这些是校准件（圆角/平端/圆端/宽底座）、流程测试件（简易-底座/立柱/托盘）
和外观 smoke 用的装配，不是发条青蛙项目的一部分。根目录改为 **workspace 容器**（`cad-workspace.json`），
不再持有活跃 `cad-data/`；frog 的 44 个版本只保留在 `examples/windup-frog/cad-data/`。

## 内容

```text
manifest.json          v001–v007 的版本索引（过滤后）
parts/manifest.json    p001–p007 的零件索引
runs/manifest.json     r001–r005 的运行索引（过滤后）
versions/v001…v007     校准/简易件的版本目录
runs/r001…r005         对应运行目录（含历史 frames）
assembly/              根 assembly 下的外观/简易装配 JSON
```

## 恢复方式

这是一个**归档快照**，不是活跃项目。要恢复成可运行语料：

1. 新建目录 `<target>/cad-data/`；
2. 把本目录的 `manifest.json`、`parts/`、`runs/`、`versions/` 放进去；
3. 在 `<target>/cad-data/project.json` 写一个项目标记（key 由 `projectKey(<target>)` 生成）；
4. 用该目录作为会话 cwd 重新打开。

不要把本目录直接当成 `cad-data/` 使用——它没有 `project.json`，也不应被面板当成活跃项目。

## 已知边界

- `runs/r001…r005` 的历史 `frames/*.scad` 仍引用旧绝对路径（`ToyMarker/cad-data/...`）。
  这是历史证据，按仓库规则不回写；恢复后只用于阅读，不要据此重渲。
- 这些件没有 visual-review 记录（新规之前生成）；如果重新作为交付件，需要重新 `review_visual`。
