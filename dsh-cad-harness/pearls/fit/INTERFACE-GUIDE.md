# fit / 通用装配接口指南

> 核心只讲**机制**，不讲某个行业的接触组。
> 任务专用的接触组、阈值、required groups 放在 `examples/pearls/...` 或项目 rule pack。
> datum/接口修复属于 contract/model 步骤，不计入 `fit` 的 4 tools / 30 calls / 600 s 预算。

## 1. 先看现状

```text
set_datums({versionId:"..."})        # 列出现有 datum
check_assembly({manifestPath:"..."})
```

看 `summary`：

- `interfaces = 0` → 还没开始，不是通过；
- `undeclared` 是当前接触但未声明的 pair 数；
- `hardViolations = 0` 只说明“已声明的接口没冲突”，不说明“接口齐全”。

## 2. 给配合面加 datum

`set_datums` 会生成一个新版本（几何逐字节不变），返回 `versionId`：

```json
{
  "versionId": "<old-version>",
  "datums": [
    { "name": "mating_face_a", "kind": "plane", "point": [0, 0, 0], "normal": [0, 0, 1] }
  ]
}
```

- 平面用 `plane`，点/圆心用 `point`，轴用 `axis`，孔用 `cylinder`；
- 坐标是**该版本自己的局部/最终坐标**；
- 新版本必须写回 assembly manifest 对应 child 的 `version`；
- 不要用“原点/随便一个点”冒充配合面。

## 3. 加接口

`root.interfaces` 里一条：

```json
{
  "id": "I1",
  "a": "<childA>.<datumA>",
  "b": "<childB>.<datumB>",
  "type": "贴合",
  "severity": "hard",
  "check": "distance",
  "expected": 0,
  "tolerance": { "min": -0.2, "max": 0.2 }
}
```

- `a`/`b` 必须是 `<directChildId>.<datumName>`；
- 贴合面用 `distance`，expected 是实测贴合值；
- tolerance 只包住真实配合，不要用 ±1000 掩盖错误；
- 每条接口只连同一父节点下的**直接 child**。

## 4. 覆盖什么、阈值多少

这些**不在核心里写死**，由项目/rule pack 声明：

- 哪些接触组是结构主链（required groups）；
- `clearanceThreshold`、`interferenceEpsilonMm3`、`adjacencyThresholdMm`；
- `undeclared` 是 block、warn，还是逐条解释；
- 哪些接触是非结构性的，可以豁免。

木作家具的完整示例见：
`examples/pearls/fit/wood-furniture/INTERFACE-GUIDE.md`。

## 5. 常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| `datum ... not found` | 没先 `set_datums` 或名字拼错 | 先 list，再写接口 |
| `0 interfaces` | 只写了 BOM，没写 `root.interfaces` | 按第 3 步加 |
| `hard violation` | 平面方向/坐标不对，或 tolerance 太紧 | 先测 `measure_gap`，再改 datum |
| `undeclared` 仍很多 | 只做了部分接触组 | 按项目 rule pack 补组 |
| `stale` | 接口用了旧版本 | 更新 child 的 `version` 后重跑 |

## 6. 完成判据

- `interfaces > 0`；
- `hardViolations = 0`；
- `undeclared` 按项目策略处理（0、required groups、或逐条解释）；
- `validate_assembly` 0 干涉/0 过紧（阈值按设计声明）；
- 新版本 STL 与父版本 SHA-256 一致。
