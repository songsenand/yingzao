# CadQuery 作者指南（L1.5）

> 短规则在 `skills/cad-modeling-measure/SKILL.md`。这里是写出可编译脚本的契约。

## 选内核

会话提示里会直接给出 `CAD authoring kernel: cadquery|openscad`（来自项目 marker 或全局 `backend.json`）；`cad_session` action `info` 可再次确认。不要靠猜。

- OpenSCAD：`cad_part({ action: "generate", args: { scadCode } })`。
- CadQuery：`cad_part({ action: "generate", args: { code } })`。
- 两者只能给一个；同时给或都不给都会被拒绝。
- 版本会记录 `sourceFile: model.py` 与 `backend: {kernel:"cadquery"}`；切内核不会重写旧版本。
- `cad_session` action `info` 报告当前 kernel：项目 `cad-data/project.json` 的 `defaultKernel` 优先，其次全局 `backend.json`。

## 原地切换内核（`cad_session` action `kernel`）

`cad_session({ action: "kernel", args: { kernel: "cadquery" } })` 改的是**项目默认作者内核**，不是新建项目：

- 旧版本保留自己的 `backend.kernel` 与 `sourceFile`；只有之后的 `cad_part generate` 走新内核。
- `dir` 省略时用会话已绑定的项目；返回 `previous` / `kernel` / `note`。
- 会话提示在下一回合更新。不要为了换引擎建第二个项目——设计、版本和证据会被拆成两份，之后再合并比切换更贵。

## 脚本契约

```python
import cadquery as cq

result = (
    cq.Workplane("XY").box(60, 40, 6)
    .edges("|Z").fillet(4)
    .faces(">Z").workplane()
    .rect(44, 26, forConstruction=True).vertices().hole(4.5)
)

datum("top", [0, 0, 6])
datum_plane("top_plane", [0, 0, 6], [0, 0, 1])
datum_axis("hole_axis", [22, 13, 0], [0, 0, 1])
datum_cyl("hole", [22, 13, 0], [0, 0, 1], 2.25)
```

- 必须留下 `result`（`Workplane` 或 `Shape`），或调用 `show_object(result)`。
- 不要自己 `exporters.export`；provider 负责 STL（以及可选 STEP）。
- 不要 `import trame/vtk/pyvista`；pack 里没有可视化闭包，渲染走共享的 STL→OpenSCAD。
- datum 参数顺序是 **point first**：`(name, point, dir)`；与 OpenSCAD 同一 schema，但 Python 是位置参数，写错会静默编译。
- **`box()` 以原点为中心**：要“底面在 z=0”，先 `box(...).translate((0,0,h/2))`。datum 不会自动校验这一点；`datum_outside_bbox` 只是 warn，不是阻断。
- 单位 mm、Z-up；`Assembly` 约束求解不在 L1.5 的契约里。

## 错误码

`cadquery_pack_missing` / `cadquery_pack_broken` / `cadquery_syntax` /
`cadquery_exception` / `cadquery_timeout` / `cadquery_no_result` /
`cadquery_export` / `cadquery_invalid_brep` / `cadquery_step_export`。

每条错误都带 `fix`。缺包时按提示显式安装 pack（`DSH_CAD_CQ_PACK` 或
`$DSH_HOME/cad/packs/cadquery`）；不会自动下载。

## 示例

`dsh-cad-harness/examples/cadquery/bracket.py`，端到端见同目录 README。
