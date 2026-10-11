# 04-rack-connector · 参考解与判据说明（**评分方，不得出现在考生侧**）

> 题面：[`subjects/04-rack-connector/TASK.md`](../../subjects/04-rack-connector/TASK.md)
> 真值：`ground-truth.json`（全部工具实测，每项记 op/参数/原始返回）
> 复现：`materialize.mjs --with-reference` → `measure-04.mjs` → `self-check.mjs`

## 一、参考解（原件实测，评分方一侧）

原设计里这一件叫 `stackConnectorBottom`。实测：

| 量 | 值 |
|---|---|
| 外形 | **9.800 × 9.800 × 12.001 mm** |
| 通孔 | **Ø3.25 × 2**（M3 过孔），成对锁孔间距 **2.45mm** |
| 侧向特征 | Ø3.316 深 5.912 各一（配合面上的定位/沉头） |
| 实体 | 单一体、watertight |

同族的 `rackJoiner`（**作为给定件**）外形 9.800 × 9.800 × 20.502，通孔 Ø3.25 × 4，
成对间距同样 2.45 —— 家族的设计语言由此可读：**9.8 方截面 + Ø3.25 成对锁孔**。

## 二、接受带与理由（判据不要求复刻）

| 判据 | 接受带 | 为什么是这个带 |
|---|---|---|
| 配合截面 | 中间两个尺寸 ∈ **9.4–9.9** | 要插进/套上导轨的 9.8 方口：<9.4 会晃、>9.9 插不进。参考件 9.8 |
| 长度 | 最长边 ∈ **10–18** | 跨得过对接缝、又不顶到同族 `rackJoiner`（20.502）。参考件 12.0 |
| 通孔 | Ø**3.0–3.6**，≥1 个 | M3 过孔；导轨锁孔实测 Ø4.25/6.111，家族用 Ø3.25 |
| 可打印性 | verdict ∈ {ok, check} | 参考件按原设计就不需要支撑 |
| 装配 | 每对 status = ok | 干涉与否由 `validate_assembly` 判，不由眼看 |

**换一种合理设计完全可以**：只要截面咬得住、长度跨得过、有 M3 锁孔、单体可打印。

## 三、"差一点就错"对照表（人判时用）

| 看似合理的做法 | 为什么不行 | 抓它的判据 |
|---|---|---|
| 直接 `import_part` 导轨、改名当交付 | 截面 27×12、长度 136，全部落在带外 | `c-cross-section` / `c-length` / `c-not-a-copy` |
| 照抄同族 `rackJoiner` | 长度 20.5 > 18（会顶到它自己） | `c-length`（`c-not-a-copy` 也会响） |
| 截面按"大概 10mm"画 | 10 > 9.9 就插不进去；而 9.0 会晃 | `c-cross-section` |
| 孔画成 Ø5（"螺丝能过就行"） | 家族用 Ø3.25；Ø5 的过孔会让接头在导轨上晃动 | `c-through-holes` |
| 只做形状、不跑装配验证 | "装得上"从未被证明 | `g-assembly-run` |
| 只在回答里描述形状，不建版本 | 没有可量的交付件 | `g-new-part-version` |

## 四、机检自检（不调模型）

```bash
node examples/bench/graders/04-rack-connector/self-check.mjs
```

四个合成场景必须按预期响应（**实测全部按预期**）：
A 正确交付 → 硬门 6 + 数值 6/6 全过；B 复制导轨改名 → `c-cross-section` /
`c-length` / `c-not-a-copy` 三红；C 没跑装配验证 → `g-assembly-run` 红；
D 只导入没建版本 → `g-new-part-version` 与 `g-tools-used` 红，尺寸类记 `unknown`。

## 五、沙箱状态（如实记录）

**尚无一轮真实会话**。本题目前只有：评分方自检 + 工具实测真值 + dry-run 通过
（`bench-run --level 04-rack-connector --dry-run`）。**没有沙箱日志检查，也没有视觉检查**。

视觉检查要看的点（真跑之后人判）：方截面是否与导轨配合面同族、端头有没有导入倒角、
锁孔是否开在配合面上而不是随手开在侧面。这些写在 `features` 里（`f-family-idiom`）。
