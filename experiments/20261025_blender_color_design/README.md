# 实验：Blender 颜色设计 → GLB → 渲染

## 目标

验证一件已经在讨论的事：**Blender 本身能做颜色设计**（多材质/按面分配），
而且颜色可以通过 `.blend` + GLB 保留到渲染阶段；不涉及切片、3MF 或打印颜色。

## 方法

1. 从 `examples/art-decor-panel/panel.scad` 编译 `panel.stl`（240×160×14 mm）。
2. `make_colored_panel.py` 在 Blender 里给面板分配三种材质：
   - 底面：`panel-base-ivory`
   - 侧壁/外圈顶面：`panel-rim-azure`
   - 内部格栅顶面：`panel-lattice-gold`
3. 保存 `panel-colors.blend`，导出 `panel-colors.glb`。
4. 用 `render_studio.py --keep-materials` 渲染 GLB；再用**不带**该标志的同一 GLB
   渲染一张对照图，确认旧行为是“清掉材质、统一蓝色”。

## 产物

| 文件 | 说明 |
|---|---|
| `make_colored_panel.py` | 建材质、按面分配、保存 `.blend`、导出 GLB |
| `inspect_glb.py` | 检查 GLB 的材质索引与面数 |
| `panel-colors.blend` | 颜色设计的权威源 |
| `panel-colors.glb` | 外观载体（3 个材质，2620 面） |
| `render/panel-colors-hero.png` | Cycles hero；`materials_preserved: true` |
| `render-wb/panel-colors-hero.png` | Workbench hero；三种材质颜色最清楚 |
| `render-flat/panel-colors-hero.png` | 同一 GLB，不加 `--keep-materials`；被抹成单色 |
| `render/metadata.json` | 记录 `materials_preserved` / `source_materials` |

## 结果

- GLB 材质索引与面数：`panel-base-ivory` 622 面、`panel-rim-azure` 1256 面、
  `panel-lattice-gold` 742 面。
- `--keep-materials` 渲染 metadata：

```json
{
  "material": "preserved",
  "materials_preserved": true,
  "source_materials": ["panel-base-ivory", "panel-rim-azure", "panel-lattice-gold"],
  "bbox_mm": {"x": 240.0, "y": 160.0, "z": 14.0},
  "bpy_version": "5.2.3 LTS",
  "elapsed_s": 4.1
}
```

- 对照：不加 `--keep-materials` 时 `material: "plastic"`、`materials_preserved: false`，
  同一 GLB 被统一成蓝色。
- 多对象也验证过：两个不同材质的 cube 导出 GLB 后，`--keep-materials` 能保留
  红/蓝两种材质（单个 object 的 join 不会丢 material slots）。

## 复现

```bash
# 1. 几何
openscad -o experiments/20261025_blender_color_design/panel.stl \
  examples/art-decor-panel/panel.scad

# 2. 颜色设计 + GLB
blender -b --factory-startup \
  -P experiments/20261025_blender_color_design/make_colored_panel.py -- \
  experiments/20261025_blender_color_design/panel.stl \
  experiments/20261025_blender_color_design/panel-colors.blend \
  experiments/20261025_blender_color_design/panel-colors.glb

# 3. 保留材质渲染
blender -b --factory-startup -noaudio \
  -P dsh-cad-harness/skills/cad-art/render_studio.py -- \
  experiments/20261025_blender_color_design/panel-colors.glb \
  --out experiments/20261025_blender_color_design/render-wb \
  --mode hero --engine workbench --size 768 --keep-materials \
  --json experiments/20261025_blender_color_design/render-wb/metadata.json --quiet

# 4. 对照：旧行为（清材质）
blender -b --factory-startup -noaudio \
  -P dsh-cad-harness/skills/cad-art/render_studio.py -- \
  experiments/20261025_blender_color_design/panel-colors.glb \
  --out experiments/20261025_blender_color_design/render-flat \
  --mode hero --engine workbench --size 768 \
  --json experiments/20261025_blender_color_design/render-flat/metadata.json --quiet
```

## 边界

- 这个实验本身走的是 raw `run_python` / Blender CLI；**A 之后**已有
  `attach_appearance` 把 GLB 挂到版本，`render_part({appearance:true})` 可渲染
  `appearance.glb`。`model.stl` 仍是几何真值。
- **CAD 面板仍是 `STLLoader`**，GLB 预览仍属 L4；appearance 侧车不改变面板预览。
- **不做切片**：颜色只作为设计/渲染数据；STL 仍然是无色的几何交付。
- `--keep-materials` 对 STL 是 no-op，会回退到 `--material`。
- Cycles 的象牙白/金色在强日光下会偏亮；Workbench 图更适合确认材质分区，
  Cycles 图用于材质/灯光观感。
