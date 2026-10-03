# 装配清单 Schema 提案（BOM + 可执行 ICD 合并工件）

**状态**：✅ **v1 已实现（2026-09-28，accept-assembly.mjs 14/14）**——§2-§7 已落地（datum 三类扩展、manifest 读写校验、L0 算子 distance/diameter-match、双通道违反、邻接发现、工具+路由）；§8 v1 范围完成，v2（层级/L1）v3（spring/L2/可视化）待续。实现记录见 DESIGN.md v2.7
**上游决策**：HARNESS.md §8（代码库类比、树状同构节点、双通道违反语义、物理事实分层级）
**本文档性质**：表达层的字段级定义。裁决通过后实现细节归 DESIGN.md，本文件废弃或转为 schema 规范。

---

## 1. 设计原则（全部来自已定案讨论，不新增）

1. **一个工件两用**：零件清单（BOM 的字段）+ 接口契约（ICD 的字段）在同一个文件
2. **契约必须可执行**：每条接口指标映射到一个引擎检查算子；不可核对的字段不许进 schema
3. **违反分两级**：`hard`（几何可判定，引擎报错）/ `intent`（意图类，标记给人）——已裁决
4. **节点同构可递归**：part 与 assembly 同一 schema，assembly 多一个 `children`；6 件套天然平面，缸盖总成天然层级——同一 schema，无需预先拍板
5. **引用走地址不走下标**：接口双方用可解析路径（`子节点id.datum名`），平面→层级的迁移才是机械重构
6. **父级视图 = 端口**：assembly 节点对外的接口就是它的父级清单里的普通条目；内部接口留在该节点自己的清单里
7. **字段最小化**：不上 GD&T 全集；每个字段要么被引擎消费，要么被人/LLM 消费，二者都不沾的不收
8. **真相文件语言无关（2026-09-28 裁决）**：清单为 JSON——harness 的真相存储不绑定任何语言生态（TS 绝对不行）；操作走库脚本、面板/引擎直接消费，未来任何语言/内核都可实现同一 schema（协议先行的直接推论）

## 2. 顶层结构

```jsonc
{
  "schemaVersion": 1,
  "name": "monocular-microscope",       // 项目名
  "unit": "mm", "up": "z",              // 全局约定（沿用插件既定约定，写死进 schema 防漂移）
  "root": { "…assemblyNode…" }          // 树根，永远是 assembly 节点
}
```

## 3. 节点（part 与 assembly 同构）

```jsonc
{
  "id": "focus-mechanism",        // 稳定 ID：kebab-case，创建后不可复用/改写（版本图引用靠它）
  "name": "调焦机构",              // 人读名，可中文
  "kind": "part",                 // "part" | "assembly"
  "version": "v012",              // part 必填：指向版本库 vNNN；assembly 无此字段
  "source": "generated",          // "generated"（本插件产）| "imported"（外部文件导入，有版本）| "stock"（既有件但无几何——显微镜的镜头从这里进）
  "material": "PLA",              // BOM 字段
  "qty": 1,                       // BOM 字段（同型多实例时 >1，如紧固件）
  "stockRef": "Ø28 消色差透镜 f=45",  // 仅 source=stock：外购件的识别信息 + 实测尺寸记录在哪
  "datums": [                     // 本节点声明的锚点（见 §5，含待扩三类）
    { "name": "导轨面", "kind": "plane" }
  ],
  "children": [ "…递归节点…" ],   // 仅 assembly；6 件套的 root 直接装 parts，无中间层 = 平面
  "interfaces": [ "…§4…" ]        // 本节点**直接子件之间**的接口 = 内部契约；对外接口写进父级的 interfaces
}
```

要点：
- **接口按节点挂**：`root.interfaces` 只描述 root 的直接子件之间的关系；每个 assembly 子节点自带自己的内部清单。树的每一层各自是一张平面表——LLM 每次只读一层（§8 上下文裁剪）
- **端口不是新字段**：某节点的对外接口 = 它出现在父节点 interfaces 里的那些条目，无重复存储
- **既有件**（source=stock）没有版本库条目，`stockRef` + 人工实测记录代替；设计"绕着它做"正是显微镜项目要验证的缺口
- **`imported` 与 `stock` 必须分开**：导入件（2026-10-01 起由 `import_part` 落地）**有**版本库条目和实测网格，因此它是**完整的接口端点**——`distance` / `diameter-match` 照常在它身上跑，邻接发现也看得见它。只有"没有几何、只有一个型号"的 `stock` 才被跳过（`assembly-check.ts` 只对 `stock` 发 skip 警告）。把导入件塞进 `stock` 会白白丢掉它的可检查性。

## 4. 接口条目（可执行 ICD 的核心）

```jsonc
{
  "id": "if-003",                       // 稳定 ID
  "a": "镜筒.物镜座前端面",              // 地址：本节点内子件id + "." + datum名（§5）
  "b": "物镜.后缘",
  "type": "贴合",   // "贴合"|"间隙"|"紧固"|"转动副"|"滑动副"|"弹簧"|"流道"
  "nominal": { "quantity": "距离", "value": 45.0 },   // 名义值；quantity ∈ 距离|直径|同轴度|角度|预紧力
  "tolerance": { "min": 44.9, "max": 45.1 },          // 可接受范围（v1 只用 min/max，配合制代号后置）
  "severity": "hard",                   // "hard"（引擎报错）| "intent"（标记给人）——已裁决的双通道
  "layer": "L0",                        // 消费的验证层；由 type 默认推导，显式写防歧义
  "check": "coaxial",                   // 检查算子，见 §6 映射表；由 type 默认推导，可覆盖
  "params": {},                         // 类型附加参数：弹簧 {"freeLength","stiffness","damping"}；流道 {"inlet","outlet"}
  "note": "目镜光轴与物镜光轴共轴，偏心导致像面倾斜"   // 意图备注——人读，也是 LLM 改设计的上下文
}
```

默认推导（type → layer/check）：

| type | layer | 默认 check | 违反时 |
|---|---|---|---|
| 贴合 / 间隙 | L0 | `distance`（measure_closest） | hard=interval 外报错；intent=标记 |
| 紧固 | L0 | `diameter-match`（孔径 vs 轴径） | 恒 hard |
| 转动副 / 滑动副 | L1 | `motion-clearance`（simulate_motion 干涉时间线 + 行程） | hard=干涉>0 报错；intent=行程偏差标记 |
| 弹簧 | L1 | `spring-behaviour`（F=-kΔx-cv 力模型，待建） | intent（相位/预紧偏差给人裁决） |
| 流道 | L2 | `flow`（simulate_fluid 趋势） | 恒 intent |

## 5. 引用地址与 datum 扩展（前置依赖，最关键缺口）

- 地址格式：`<子件id>.<datum名>`，相对当前节点；跨层引用必须显式走端口条目，禁止隔层直引（保证封装可裁剪）
- **现有 `datum()` 只捕获点**。契约需要三类几何：

| kind | 载荷 | 用途 |
|---|---|---|
| point | [x,y,z] | 现有，不变 |
| axis | 点 + 方向向量 | 同轴度、轴线距离（显微镜光轴） |
| plane | 点 + 法向 | 贴合面、平行度 |

  需扩展 OpenSCAD/python 两侧的 echo 约定与 datums.json 格式——这是实现工作的第一块，也是 §7.2 光轴检查缺口的正解
- datum 声明仍在零件 SCAD/python 源内（模型声明意图、引擎解析真值——原则不变），清单只引用不复制坐标

## 6. 运行时输出（引擎核对报告，不属于清单文件）

```jsonc
{
  "interfaceId": "if-003",
  "verdict": "pass" | "hard-violation" | "intent-flag",
  "expected": { "quantity": "距离", "min": 44.9, "max": 45.1 },
  "measured": 44.2,                    // 来自 measure/仿真真值，非清单复述
  "tool": "measure_closest",           // 产生真值的工具调用，可追溯
  "undeclared": false                  // true = 邻接发现（§7）补报的未声明邻近对
}
```

## 7. 邻接发现（强制的另一半）

引擎在每次 L0 校验时顺手报告：**所有表面距离 < 阈值的零件对中，未出现在任何 interfaces 条目里的组合** → `undeclared: true` 警告。声明覆盖意图，发现兜住遗漏——这是传统 ICD 没有的通道，`validate_assembly` 已算最小距离，只差"与清单对账"这一步。

## 8. 分期实现（裁决后生效，此处仅划界）

- **v1（最小可用）**：root 平面清单 + point/axis/plane datum 扩展 + `distance`/`diameter-match` 两个 L0 算子 + 违反报告 + 邻接发现。6 件套或显微镜第 1 级（镜架+调焦）当第一头豚鼠
- **v2**：assembly 子节点递归（层级）+ 端口语义 + L1 接入（motion）
- **v3**：spring 接口类型 + L2（flow）+ 面板可视化（爆炸图/接口高亮）

## 9. 裁决记录（2026-09-28）

1. **id 语言**：✅ 已裁决——`id` 英文 kebab，`name`/`datum名` 中文；地址形如 `focus-mechanism.导轨面`
2. **文件格式**：✅ 已裁决——**JSON 为唯一真相，语言无关**（harness 不绑定 TS/Node 生态；sqlite/md 是候选但 JSON 在可读性与规范性上最合适）；LLM 用库脚本读写，操作走库不发明语法。已升格为设计原则 §1.8
3. **tolerance 语义**：按提案默认——v1 用 min/max 数值；配合制代号（H7/g6）后置为 v2 的 `fitClass` 字段
4. **qty>1 同型件**：按提案默认——v1 每实例一条节点（id 不同、内容同），v2 引入 `prototype` 引用
5. **介入分级**：按提案默认——`review: auto|human` 字段后置到 v2（v1 先靠人审通道惯例：接口/端口变更在会话里说，不设机制）

> 三条默认若无异议即按此生效；有异议改本节即可，不影响其余部分动工。
