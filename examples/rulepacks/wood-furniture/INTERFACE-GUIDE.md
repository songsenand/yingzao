# fit / 装配接口降摩擦模板

> 目标：把“0 接口 / 0 hard”变成“接口覆盖 + 未声明可解释”。
> 本模板只补 datum 和接口，不改几何。

## 1. 先看现状

```text
set_datums({versionId:"v003"})        # 列出现有 datum
check_assembly({manifestPath:"assembly/assembly.json"})
```

看 `summary`：

- `interfaces = 0` → 还没开始，不是通过；
- `undeclared` 是当前接触但未声明的 pair 数；
- `hardViolations = 0` 只说明“已声明的接口没冲突”，不说明“接口齐全”。

## 2. 给配合面加 datum

`set_datums` 会生成一个新版本（几何逐字节不变），返回 `versionId`：

```json
{
  "versionId": "v003",
  "datums": [
    { "name": "shoulder_front", "kind": "plane", "point": [0, -40, 760], "normal": [0, 1, 0] },
    { "name": "shoulder_side",  "kind": "plane", "point": [40, 0, 760],  "normal": [1, 0, 0] }
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
  "a": "p05.shoulder_front",
  "b": "p01.bottom_face",
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

## 4. 覆盖顺序（从主链到次链）

先做结构主链，再做接触面：

1. 腿 ↔ 边框（4 腿 × 2 边框 = 8）；
2. 腿 ↔ 牙板；
3. 边框 ↔ 牙板；
4. 边框 ↔ 面板 / 穿带；
5. 面板拼缝、穿带 ↔ 面板；
6. 管脚枨 ↔ 腿、木楔 ↔ 枨（有则做）。

做完再跑：

```text
check_assembly({manifestPath:"assembly/assembly.json"})
validate_assembly({clearanceThreshold:0, interferenceEpsilonMm3:1, ...})
```

## 5. 常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| `datum ... not found` | 没先 `set_datums` 或名字拼错 | 先 list，再写接口 |
| `0 interfaces` | 只写了 BOM，没写 `root.interfaces` | 按第 3 步加 |
| `hard violation` | 平面方向/坐标不对，或 tolerance 太紧 | 先测 `measure_gap`，再改 datum |
| `undeclared` 仍很多 | 只做了腿—边框 | 按第 4 步补组 |
| `stale` | 接口用了旧版本 | 更新 child 的 `version` 后重跑 |

## 6. 完成判据

- `interfaces > 0`；
- `hardViolations = 0`；
- `undeclared` 要么为 0，要么每条都有“非结构接触”的解释；
- `validate_assembly` 0 干涉/0 过紧（阈值按设计声明）；
- 新版本 STL 与父版本 SHA-256 一致。
