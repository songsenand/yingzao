# 外观检查：作用域、规则分层与 `check_appearance` 接口草案（2026-10-30）

> **状态**：草案，未施工。规则清单与阈值未定稿，本文只定**作用域、分层和接口形状**。
> **证据等级**沿用 `docs/AUDIT-2026-10-23.md` §0：`[实测]` / `[静态]` / `[推断]` / `[未测]`。
> **基线语料**：`examples/toy-balance2`（v030 整机、v029 吊架、25 件装配）。

---

## 0. 一句话结论

**外观只在成套时判；零件生成时只继承默认值，不判。**
检查工具的入参是 **assembly manifest**，不是 `versionId`——判定的对象是零件之间的关系，
单个零件没有参照系，判不出"失调"。

---

## 1. 已定的三条

1. **判定作用域 = 成套**。外观是整体属性（比例、对齐、重复、对比），单件不可判。
2. **落实作用域 = 零件生成时**。生成时不做外观判定，但继承 `style.scad` 的圆角基本体；
   零判断、零迭代。否则等到成套才加圆角，就要重生成全部零件——最贵的一条路。
3. **输出分两层**：`judgement`（可门禁，excluded / not-excluded）/ `attention`（只看，不门禁）。
   注意力层永不判决，空列表 = 没有突出项，**不是安全**。

一句话规则：

> 零件生成时不判外观，但继承外观默认值；成套时才判，判完批量修。

---

## 2. 实测基线（toy-balance2，2026-10-30）

| 项 | 结果 | 证据 |
|---|---|---|
| 24 个 `model.scad` 里圆角/倒角/`offset`/`minkowski` | **0 处** | `[实测]` grep |
| v030 整机 >40° 锐边 | **7593 条，总长 10.0 m** | `[实测]` |
| 13 个打印件 >60° 凸边 | 4263 条 → **455 个 8 mm 簇** | `[实测]` |
| 16 视角可见性 | 82 完全不可见 / 271 ≥25% / **157 ≥50%** / 35 ≥75% | `[实测]` |
| 剪影（正视） | 腰 30 mm @z=70；峰 150 @z=17、178 @z=78；**顶/底 = 1.18**；对称 IoU 0.707 | `[实测]` |
| 吊架端部 | 三腿底面 **3 个平端面，共 27.4 mm²，全在 z=−33**，端前 1 mm 无收分 | `[实测]` |

**结论**：可见性过滤把 455 个锐边簇砍到 157 个（−65%），其中 82 个从任何视角都看不见。
这正是"零件级判定一半是无效的"的量化版本。

---

## 3. 规则模型：四个字段

每条规则必须声明四件事，缺一条就是不可执行的建议：

| 字段 | 取值 | 含义 |
|---|---|---|
| `layer` | `verdict` / `attention` | 可门禁 / 只给线索 |
| `scope` | `part` / `relation` / `assembly` | 单件自身 / 跨件关系 / 整机 |
| `cost` | `local` / `regional` / `global` | 改一条边 / 重做一段形体 / 改体量 |
| `owner` | `appearance` / `printability` / `human` | 谁判它；不是外观的写 `applies:false` + `reason` |

外加 `severity: hard | soft`，以及 `decidable: geometry | declared | not-decidable`。

**hard 的判据是性价比，不是重要性**：能用默认值一轮内满足的才是 hard；
需要超过一轮的，是重设计，进 `attention` 或人工评审。

`cost` 决定分诊：`local` 全修，`regional` 挑着修，`global` 进评审队列。

---

## 4. 可见性

**算法**：从 N 个视角向每个违规簇的质心发射线，若射线在到达质心前被场景挡住，则该视角不可见。
得分 = 可见视角数 / 总视角数。

**默认参数**（声明值，不是标定值）：8 方位 × 2 仰角（12°、55°），半径 320 mm，
视角中心取整机包围盒中心。桌面产品不看下方，所以不设负仰角。

**分级**：

| 得分 | 处理 |
|---|---|
| ≥ 0.50 | 计入 `judgement`（hard） |
| 0.25 – 0.50 | 计入 `judgement`（soft） |
| 0 – 0.25 | 只计数，不列条目 |
| = 0 | 排除，但必须报"排除 N 条"——不许静默丢弃 |

被排除的数量进 `visibility.excludedFromJudgement`，和 stress 工具的 `excludedCells` 一个规矩：
排除是声明，不是遗忘。

---

## 5. `check_appearance` 接口

### 5.1 签名

```ts
check_appearance({
  manifestPath: "assembly/assembly.json",   // 必填；不接受 versionId
  profileIds: ["appearance-base"],          // 声明式规则集
  styleId: "toys-round",                    // 可选；只在 base 带内取窄
  viewpoints: 16,                           // 可选，默认 16
  visibilityThreshold: 0.25,                // 可选，默认 0.25
  mode: "judge" | "scan" | "both",          // 同 check_printability
  baselineRunId: "r104"                     // 可选；给了就出 delta
})
```

### 5.2 拒答条件

- manifest 只有 1 个零件 → 拒绝：`"单个零件不判外观；请提供成套 manifest"`。
- 零件缺 `role` 字段 → 按 `printed` 处理，并在报告里标注 `roleAssumed`。
- 引用的版本不存在 → 拒绝并列出缺失的版本 id。

### 5.3 输出

```json
{
  "schemaVersion": 1,
  "tool": "check_appearance",
  "scope": "assembly",
  "manifest": "assembly/assembly.json",
  "assembly": "toy-pan-balance 玩具托盘天平",
  "profile": { "id": "appearance-base", "version": 1, "style": "toys-round@1" },
  "visibility": {
    "viewpoints": 16, "radiusMm": 320, "elevationsDeg": [12, 55],
    "clusters": 455, "neverVisible": 82,
    "visibleAt25": 271, "visibleAt50": 157,
    "excludedFromJudgement": 82
  },
  "judgement": {
    "verdict": "excluded",
    "findings": [
      {
        "ruleId": "sharp-edge-max",
        "layer": "verdict", "severity": "hard", "cost": "local",
        "part": "base", "versionId": "v001",
        "location": [-75, -40, 20],
        "bbox": [[-78, -43, 18], [-72, -37, 20]],
        "measured": 47, "required": 0,
        "visibility": 0.62,
        "witness": "底座外露竖棱 47 条 >60° 凸边，最长 12.4 mm",
        "fixHint": "R3 圆角（style.scad round_box）"
      }
    ],
    "summary": { "hard": 6, "soft": 11, "ignoredHidden": 82 }
  },
  "attention": {
    "peaks": [
      {
        "kind": "termination",
        "part": "stirrupL", "versionId": "v029",
        "at": [31.5, 0, -33],
        "detail": "三腿底面平切，共 27.4 mm²，端前 1 mm 无收分",
        "next": "render_part v029 front；腿端改 R1 圆头或 C0.8 后重跑"
      },
      {
        "kind": "silhouette",
        "detail": "腰 30 mm @z=70；峰 150 @z=17、178 @z=78；顶/底=1.18；对称 IoU 0.707",
        "next": "对比参考图：底座宽度应 ≥ 顶部宽度"
      }
    ],
    "note": "空列表 = 没有突出项，不是安全"
  },
  "unevaluable": [
    { "ruleId": "silhouette-legibility", "reason": "需要参考图或人评审；描述子不能代替" }
  ]
}
```

### 5.4 每条 finding 必须带

`part` + `versionId` + `location`：**报告挂在成套，修复回到零件**。
没有这三样，报告就变成"知道有问题但不知道改哪"。

---

## 6. 与现有工具的关系

| 工具 | 关系 |
|---|---|
| `check_printability` | 不重复判。悬垂/壁厚/桥接归它；外观规则写 `owner: "printability"` + `applies:false` + run 号 |
| `validate_assembly` | 不合并。它判干涉/间隙，外观判形式；但复用同一份 manifest 加载与位姿代码 |
| `delivery_audit` | `appearance` claim 要求一次**成套** run，引用 manifest + 所有件版本 id + profile 版本 |
| `request_review` | 不可判的（可读性）走人工队列，不阻塞 |

`role` 字段（`printed` / `purchased` / `reference`）**已加入 manifest schema**（2026-10-30）：
外购件不可修改，只作遮挡体参与可见性，不产生 finding。省略时按 `source=stock → purchased`、
其余 `printed` 推导，并标 `roleAssumed`。

---

## 7. 未定问题

1. **视角集是否按产品类型固定**：桌面件（不看下方）、手持件（看六面）、挂墙件（不看背面）应当不同。
2. **可见性阈值是否随 style 调**：玩具可以放宽，仪器件应当收紧。
3. **注意力层是否要基线**：剪影描述子建议存进 run，重跑时出 delta（腰位置、顶/底比、对称 IoU）。
4. **`style.scad` 注入方式**：`generate_part` 预置，还是零件模板自带；这决定"默认值"这一层能否落地。
   **2026-10-30 已验证一半，见 §9：注入可行，但必须带功能面豁免。**

---

## 8. 建议施工顺序

1. ~~只读版 `check_appearance`（无修复建议，只出 judgement + attention），跑 3 台天平 + 3 台显微镜。~~
   **2026-10-30 已完成原型**：`dsh-cad-harness/scripts/appearance_probe.py`，跑通 3 台天平，
   见 `experiments/20261030_appearance_probe.md`。结论：机制可用；外购件识别需要 `role`，
   平端面会误报功能性开口，需要功能面豁免。
2. ~~用人工判定的"丑 / 修好"样本对做校准：规则必须能把两者分开，否则重写判据。~~
   **2026-10-30 已完成三对**（锐边 / 平端面 / 剪影），全部能分开，见
   `experiments/20261030_appearance_probe.md` 的"校准补齐"一节。
3. `style.scad` 默认值层（这一层决定批量修复的成本）。
   **2026-10-30 已验证**：见 §9。
4. 接入 `preflight` / `delivery_audit` 的 appearance claim。

---

## 9. 默认值层验证（2026-10-30，toy-balance2 v001 底座立柱）

**做法**：15 行 `style` 前导（`rr` / `rr_slab` / `r_plate` / `r_boss`），把 `cube`、`cylinder`
换成圆角基本体，**尺寸一个没改**；重新生成一版，与原件逐项比对。
新版本在 `cad-data/versions/v001`（工作区临时语料），不写进 `examples/`。

**结果（全部 `[实测]`）**：

| 项 | 原 v001 | 圆角版 | 结论 |
|---|---|---|---|
| 包围盒 | 150×80×96，z 8–104 | 完全一致 | ✅ 外形包络不变 |
| V 刀口座（x±3 y±6 z>100.9） | — | 差集 **0.00 mm³** | ✅ 功能面未动 |
| 三个脚孔（r<3.5，z 7.9–15.1） | — | 差集 **0.00 mm³** | ✅ 功能面未动 |
| 刻度托板（y>8.5） | — | 差集 **0.00 mm³** | ✅ 未动 |
| 体积 | 76186.6 | 74940.7（−1.64%） | 对称差 1404 mm³ = 1.84% |
| 凸锐边总长（>40°） | 2447 mm | **1004 mm（−59%）** | 圆角生效 |
| 凸锐边计数（>60°） | 732 | 836（+14%） | ⚠ 计数不可用，见下 |
| 打印（fdm-pla-0.4） | 0.7 mm 刻线 / 8059 mm² 悬垂 | 同 | 未变差；0.7 mm 是原件既有问题 |

**两个"默认值咬到功能"的发现**（这才是验证的价值）：

1. **台面 z=20 的外圈被顶棱 R1.5 收掉了 1.5 mm**（差集 90 mm³）。平面还在，但面变小了；
   将来若有零件压在这圈上就会出问题。
2. **脚底接触面积 378.7 → 258.7 mm²（−32%）**。C1 底棱吃掉了接触环——这是真实的功能量变化，
   只能靠"功能面豁免"挡住。

**结论**：默认值层可用（一轮生成、无返工、功能面差集为 0），但**必须带功能面豁免清单**：
被 `datum()` 声明的配合面/基准面/热床接触面，其相邻棱跳过圆角。否则默认值会安静地吃掉功能面积。

**顺带修正一个指标**：锐边**计数**在加圆角后反而 +14%（圆角自身的分段制造了更多短边），
但**总长 −59%**。规则必须用"长度"或"可见长度"，不能用计数——否则加了圆角反而判"变差"。

---

## 10. 宿主工具落地（2026-10-30）

`check_appearance` 已按"几何在 Python、注册在宿主"的既有架构实现：

| 层 | 位置 | 内容 |
|---|---|---|
| 几何 | `python/cad_worker/worker.py` | `op_check_appearance` + `_app_*` 辅助（锐边、可见性、平端面、剪影、功能面豁免） |
| 注册 | `src/host/tools.ts` | manifest 解析 → role 解析 → 调 worker → 写 `appearance` run |
| 记录 | `src/shared/types.ts` / `labels.ts` | 新 run kind `appearance`（"外观检查"） |

**端到端验证（真实工具调用，非原型）**：

| 语料 | 可见锐边 | 密度 | 平端面 | 与原型 |
|---|---|---|---|---|
| toy-balance | 7160.5 mm | 47.73 | 1 | 一致 |
| toy-balance2 | 4882.0 mm | 68.92 | 12 | 一致 |
| roberval-balance | 8763.8 mm | 37.85 | 7 | 一致 |

**契约验收之外抓到的一个真 bug**：worker 输出的 `-0.0` 坐标在 `JSON.stringify` 下变成 `0`
（符号丢失），宿主的输出契约因此拒收整个值。修复：`_app_json_safe` 在返回前把 `-0.0` 归一为 `0.0`。
这个 bug 只有**真实调用**才能发现——契约验收只检查"每个工具都被包了守卫"，不检查工具的输出里有没有 `-0.0`。

**第二个真 bug**：`roleAssumed` 一直是 0。宿主总会把 role 填满，worker 的"未声明"分支永远走不到，
于是"13 个打印件里混着螺钉"这件事在报告里静默了。修复：宿主逐件传 `roleAssumed` 标志。
现在 toy-balance2 报 25 件（旧 manifest 全没写 role），roberval 报 0。

**重启后的现场验证（2026-10-30 22:25 之后，真实会话）**：

| 用例 | 结果 |
|---|---|
| `check_appearance({manifestPath, mode:"both"})` | ✅ 返回 208 mm / 116.49 / 2 条平端面；run `r002` 落库（kind `appearance`） |
| `mode:"scan"` | ✅ 只回 attention，无 judgement |
| 单件 manifest | ✅ 拒绝："a single part has no appearance to judge"，带 received/accepts |
| 引用缺失版本 | ✅ 拒绝并点名 `v999 (part b)` |
| `delivery_audit({claims:[appearance]})` | ✅ claim 由 `r002` 背书，`claim-without-evidence` 消失 |

**第二次重启后（2026-10-31 08:39）**：`mode:"scan"` 的抬头已改为"scan only · 注意力 N 条
（没有判决，这是规定）"；`delivery_audit` 的 `claim-without-evidence` 消失，外观 claim 由
`appearance` run 背书；把 4 个校准件声明为 `research` 后，`newest-version-unvalidated`
从 1 blocked 降为 0，并作为 `role-exempt-parts` info 可见。

**由此发现并修掉的第三处集成缺口**：`delivery_audit` 的 claim 映射里，`appearance` 只认
`assembly` run（"carrying the renders"），新加的 `appearance` run 不被承认。已改为
`['appearance','assembly']`。

---

## 11. 包络预算（2026-10-31）

外观的第一条规则是"比例不失调"。**预算就是它的可检查形式**，所以并入 `check_appearance`，
不新开工具。

- 预算主体 = **功能区**；功能区是**零件的划分**（manifest `group`），一个零件最多一个组，小件可不分配。
- 组的包络 = 成员包围盒的**并集**（不是人画的盒子）；区间 x/y/z 三维，组间允许重叠。
- 文件：`assembly/budget.json`；检查：`check_appearance({manifestPath, budgetPath})`。
- 超包络 → `verdict: excluded`，逐组报 `z上+80` / `z下+40` 这样的方向量。

**roberval 第一跑（2026-10-31）**：整机 z 259 vs 190（+42%），六个组超界，x/y 全合规。
读数区暴露指针与刻度板在 z 上相差 58 mm 的功能性问题。

**尚未实现**：超预算的"必须写说明 + 审批后预算升版"流程（见 DECISION-LOG 同日条目）。

**超预算状态机（2026-10-31 落地）**：`budget.json` 增加 `overruns[]`，每项 `{group, axis, direction, reason, evidence, status, acceptedBy}`。

| 状态 | 条件 | 结果 |
|---|---|---|
| `unjustified` | 测量超界，但 `overruns` 里没有对应条目 | excluded（挡住） |
| `pending` | 有理由、`status:"proposed"` | excluded（挡住，待批准） |
| `accepted` | 有理由 + `status:"accepted"` + `acceptedBy` | not-excluded（放行） |

实测三态（roberval，2026-10-31）：未声明 9 项 → excluded；1 项 proposed → 该项"待批准"、其余未声明 →
仍 excluded；9 项全部 accepted → not-excluded。
**批准是人给的**：`acceptedBy` 必须由人填写或在人明确同意后写入——机器自己填等于自己批自己。

---

## 12. 视觉对称（2026-11-01）

"不一致"和"没对齐"进规则集的第一条：**视觉对称，不是几何对称**——只要求剪影对称，不要求内部实现对称。

- 声明：`budget.json` 的 `"symmetry": {"plane": "x"}`（不声明不检查）；
- 算法：绕 z 每 15° 取一个方位，把场景与它的镜像分别投影，逐像素异或，报**失配面积最大**的视角；
- 输出：`{kind:"symmetry", worst:{azimuthDeg, mismatchMm2, mismatchBboxMm}}`，进 attention 层；
- 实测：P1 凳 135°/18000 mm²、P2 搁板 60°/5500 mm²、P3 台灯 0（不误报）、P4 修好凳 0；
- 成本：300 mm 产品 +7 s（12 方位 × 2 次栅格化）。

**为什么必须扫方位**：P1 在 0°/45°/90° 三个方位上完美对称（圆腿被方腿挡住），只有 30°/60°/135° 暴露。
单视角的对称检查对这类缺陷是瞎的。

**仍然测不到**：对称的错位（两个托架一起低 10 mm，对称性完好）——那是"近共面"的活，尚未实现。

---

## 13. 近共面（对齐）与边视保护（2026-11-02）

**近共面**：两个**不同零件**的大平面，法向相对、间距 1–20 mm、投影重叠 > 50% → "该齐没齐"。

- 三条过滤缺一不可（都是在夹具上量出来的）：跨零件（同零件的两面是厚度）、
  真平面（圆柱的一个面旁边是 11° 的兄弟面，要排除）、投影重叠；
- 朴素做法（排序所有偏移量取近邻）不可用：P4 一个 R6 圆角就产生 12 个"平面"；
- 结果：P2 精确命中 `board / brkR · z 差 10 mm · 重叠 1.0`，P1/P3/P4 全 0；
- 成本：向量化配对后 **毫秒级**（未向量化时 microscope2 多花 100 s）。

**边视保护**：剪影比高>2.5（宽扁）时 `maxOverBase` 置空——螺旋桨侧视 4.58 说的是"一根横条"，
不是"比例失调"。前端渲染显示 `max/base 边视(不计)`。
