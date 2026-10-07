# 00-smoke · 工具链冒烟自检

> ⚠️ **这不是发给 Agent 的题面。** 这一级没有 LLM——它的目的是**校准仪器**：
> 确认插件本身还能不能跑。`rubric.json` 是给脚本读的期望行为表。
>
> **这一级没有考生、没有考卷，也没有考场。** 所以 `subjects/` 下**没有**
> `00-smoke/` 目录——那里只放有考生的题。本级的配方与判据都留在评分方侧，
> 由 `bench-smoke.mjs` 在临时目录里直接驱动工具对象（与 `accept-*.mjs` 同法），
> 不需要会话、不需要预设、不需要 cwd。

## 为什么必须有这一级

没有它，一次失败的评测无法区分两种完全不同的原因：

- **插件退化了**（某个工具坏了、路径写错、schema 变了）；
- **模型变笨了**（不会用工具、不守纪律、乱下结论）。

两者都会表现为"分数掉了"，但处置完全相反。2026-10-05 就抓到一次活标本：
`compile.ts` 把 `OPENSCADPATH` 指到了 `lib/BOSL2` 而不是它的父目录，**所有
`include <BOSL2/...>` 静默失败**（OpenSCAD 只给 WARNING、顶层对象为空、编译仍报
成功）。microscope5 因此把"BOSL2 在编译环境不可用"写成了一条设计偏差，然后手搓
渐开线齿轮和螺纹——**一次插件接线 bug 被记成了模型的短板**。这一级跑一次，
三十秒就能抓到它。

## 配方（`driver: "script"`）

每步都是固定调用，期望行为写在 `rubric.json` 里。带 ✅ 的条目已由既有验收脚本
覆盖，冒烟脚本只需引用其结果，不必重造。

| # | 工具 | 固定调用 | 期望行为 | 已有覆盖 |
|---|---|---|---|---|
| 1 | `generate_part` | 100×60×8 平板 + Ø12 通孔，声明 `datum` 与 `datum_cyl` | `watertight=true`；4 张渲染；结果文本带 bbox | |
| 2 | `generate_part` | 只改孔径，`views:["iso"]` | 只出 1 张图（图片预算生效） | |
| 3 | `set_datums` | 给已有版本加一个锚点 | **不产生新版本** | |
| 4 | `measure_part` | 量 #1 的版本 | `size` = 100×60×8；体积与解析值差 < 1% | |
| 5 | `measure_distance` | 孔壁 → 板边 | 与解析值一致 | |
| 6 | `measure_closest` | 两块板的最近点对 | 返回最近点对与间距（不用给坐标） | |
| 7 | `check_connectivity` | #1 | `single-body` | |
| 8 | `check_printability` | #1（8mm 厚） | `verdict` ∈ {ok, check}，`minWallMm` 合理 | |
| 9 | `check_printability` | 故意做 0.5mm 薄壁的件 | `verdict` ∈ {check, unprintable} 且报出薄点位置 | |
| 10 | `render_part` | 对 #1 出剖切图 | 出图 | |
| 11 | `validate_assembly` | 两件故意干涉 0.5mm | `interference > 0` | |
| 12 | `check_assembly` | 4 条接口：`distance` / `diameter-match` / `coaxial` / `motion-clearance`（引用一个通过的 motion run） | 4 pass / 0 hard | ✅ coaxial 见 `accept-assembly`、`motion-clearance` 见 `accept-p2` |
| 13 | `check_assembly` | 把孔改小 0.5 后重跑 | **必须** hard-violation（阴性对照） | |
| 14 | `simulate_motion` | 齿条用 `pitchRadiusMm` 严格比驱动 | `travel = r·ω·T` ±5% | ✅ `accept-p2` |
| 15 | `simulate_motion` | 零件建模在离原点 120mm 处 | `pivots` 报关节锚点；run 内 STL 被平移到该点 | ✅ `accept-motion-pivot` |
| 16 | `simulate_physics` | `tiltDeg: 5` + prismatic 关节给 `staticFriction` | 报 `holds`/`slides` 与倾倒判定 | ✅ `accept-p3` |
| 17 | `simulate_fluid` | Ø8 直管，入口速度 100mm/s | 到达率 > 0.6；无穿透；质量守恒误差合理 | |
| 18 | `merge_parts` | 两个相接件 | `shells = 1`；两件分离时 `shells = 2` | |
| 19 | `delivery_audit` | 一个引用了已被取代版本的语料 | 报 `stale` / `superseded`，`blocked` 判定符合预期 | ✅ `accept-delivery-audit` |
| 20 | BOSL2 | `spur_gear` / `screw` 各一次 | 出几何、无 include 警告 | ✅ `accept-bosl2` |

## 冻结的渲染相机

外观类判据要求同一取景。冒烟这一级就把相机定死并记录下来，供 `03-microscope` 复用：

```
视角：azimuth ≈ 35°，elevation ≈ 15°，背景纯白，正交投影
出图：front / side 两张，同一 zoom，主体占画面高度约 80%
```

首次跑基线时用"渲染 → 与 `03-microscope/参考图.png` 比剖面 → 微调角度"的方式
把这两个角度定死，然后把最终值回填到本文件与 `03-microscope/rubric.json`。

## 预算

| 项 | 上限 |
|---|---|
| 墙钟 | 30 分钟（流体那一步占大头，必要时可单独跳过并在结果里标注） |
| 工具调用 | 60 次 |
| 图片 | 24 张 |

## 通过标准

`rubric.json` 的 `gates` 全过。**任何一条不过，就不是模型的锅**——先修插件，
再跑真正的评测题。
