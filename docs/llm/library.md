[English](../en/llm/library.md) | 中文

# 标准件目录：`library/` 是什么，以及现在能做什么

> 长解释参考；短规则在 `skills/cad-toolbox/SKILL.md`。

先说结论：**99 个预生成标准件随包分发，但在 0.1.1-preview.1 还没有一等工具入口。**
不要把它和 BOSL2 或装配清单里的弹簧 `standardId` 混为一谈。

## 三个不同的东西

| 名字 | 是什么 | 在哪里 | 现在怎么用 |
|---|---|---|---|
| **标准件目录 v0** | 99 个规范件 / 14 个 family，预生成 STEP/STL；`fit` / `visual` 两档 LOD | `library/catalog.json`、`library/parts/<id>/` | 随包存在；**没有 `cad_part` 的 list/get/import 操作**（见下） |
| **BOSL2** | 可选 **仅 OpenSCAD** 建模库（螺纹、齿轮、螺丝、墙、轴承等） | 用户自行放到 `lib/BOSL2/`，不随包 | 只在 `scadCode` 里 `include <BOSL2/...>` |
| **弹簧 `standardId`** | 装配检查用的 1 条 seed（pen spring） | `src/host/standard-parts.ts` | `cad_assembly` (`action: "check"`) 的 `spring-behaviour` 填充字段 |

“标准件”在本项目里被这三者共用；写文档或回答用户时必须点名是哪一种。

## 目录内容

- `library/catalog.json`：99 specs、14 families、`package`（当前全在 `core`）、
  `frequency.source: "assumed"`、LOD 路径与 SHA-256、family 的 `fitRule` / `visualRule` / datums。
- `library/parts/<id>/part.json`：该 spec 的 datums、bbox、volume、generator、尺寸来源。
- `library/parts/<id>/fit/model.{step,stl}`：装配/契约表示。
- `library/parts/<id>/visual/model.{step,stl}`：只用于显示；55 个 spec 用 `alias-fit` 复用 fit 文件。
- ID 是稳定的，例如 `iso4762.M5x16`；**不要把 `core/` 包前缀写进 ID**。

`library/README.md` 有完整文件数、family 覆盖和生成/校验方法。`accept-library-catalog`
校验 99/14、ID、hash、alias、visual bbox 和文件数；它目前只在聚合 `npm run accept` 里，
不在 `accept:preview` / release gate 里。

## fit 与 visual

- **fit 是契约/装配表示**：名义尺寸，不建螺旋螺纹/滚珠/真实弹簧；visual 只用于显示。
- **visual 不是检查依据**：装配、碰撞、测量、交付都用 fit（或由 fit 导入的版本）。
- **visual 的 bbox 必须在 fit 包络内**；生成器会因此失败。
- `library/README.md` 说“LOD 由 agent 在使用时选择”，这是**设计目标，不是本版的工具能力**。

## 现在 agent 能做什么

当前生产调用面只有 9 个 surface / 39 个 op；`cad_part` 是：

```text
create · generate · import · merge · role · appearance
```

没有 `library` / `catalog` / `standardPart` action，也没有 `libRef` 字段或
`library.lock`。因此：

- **不要声称**可以“列出标准件目录”或“按 ID 选 fit/visual”——没有这个工具。
- 如果用户明确给出一个 `library/parts/.../fit/model.step` 路径，可以走
  `cad_part` (`action: "import"`) 导入为 `stock` 版本；这是普通导入，不是目录选择。
- 如果用户只说“用一个 M5 螺栓”，当前没有可发现的目录入口；应明确告诉用户
  0.1.1-preview.1 的目录尚未接入工具，或请用户给出 STEP/STL。
- 需要螺纹/齿轮几何时用 **BOSL2**，但那是 OpenSCAD 建模，不是 99 目录里的预生成件。

`assembly.json` 的 `stockRef` 是自由文本，不是目录解析器；`elastic.standardId` 只认
弹簧 seed，未知 ID 会被 schema/validator 拒绝。

## 未来接口（未实现，勿按此调用）

若接入，建议的最小契约是：

```text
cad_part({ action: "library", args: {
  op: "list" | "get" | "import",
  specId?: "iso4762.M5x16",
  lod?: "fit" | "visual",
  package?: "core" | "full"
}})
```

- `import` 返回 `versionId`，走既有版本/渲染/装配路径；
- 清单增加结构化 `libraryRef`（`specId` + `lod` + `catalogVersion`/hash），
  不再只靠自由文本；
- `visual` 不得进入契约/检查；
- `accept-library-catalog` 进入 preview/release gate，并加一条
  list → import fit → assembly datum → check 的端到端测试。

在这些落地前，本文档是**现状说明**，不是可调用 API。
