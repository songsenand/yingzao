# docs/images

文档里引用的图放这里，随仓库入库；渲染/截图**产物**默认不入库（`.gitignore`
覆盖 `cad-data/`、`.tmp/`、`sandbox/shots/`）。

| 目录 | 放什么 |
|---|---|
| `readme/` | README 与发布页用的图（模型预览、社交预览等） |
| `design/` | `DESIGN.md` / `docs/DECISION-LOG.md` 点名的视觉证据；从沙盒 `dsh-cad-harness/sandbox/shots/` 拷贝进来的那一份，改文档路径时两边一起改 |
| `social-preview.png` | 仓库社交预览图 |

判据：**被文档引用的图 = 资产，入库；只为当时检查、没人引用的渲染/截图 = 产物，
留在 `cad-data/`、`.tmp/`、`sandbox/shots/`。** 示例自己的 README 用图放在示例目录的
`renders/`（如 `examples/ice-castle-winder/renders/iso8.png`）。
