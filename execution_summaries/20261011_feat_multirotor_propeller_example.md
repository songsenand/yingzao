# 执行摘要：新增 examples/ 多旋翼螺旋桨示例（叶长 60mm，含电机连接章节）

## 动机

`AGENTS.md` 与 `HARNESS.md` §6 把 `examples/` 定为"LLM 动手前可看的、能跑的完整样子"。
现有示例全是显微镜系列（同一类机器、同一套接口形状），缺少一个**零件少、但接口要求硬**
的独立场景。用户要求：在 `examples/` 下新建一个文件夹，画一只**叶长 60mm 的多旋翼螺旋桨**，
供 3D 打印，并写一份 README——README 除了常规内容，**必须写清楚怎么和电机连接**。

两处口径由用户拍板（见 `docs/DECISION-LOG.md` 当日条目）：
①「叶长 60mm」= 叶根→叶尖的**径向长度**（桨径取 Ø144）；
② 电机接口用**通用型**：Ø5.2 中心轴孔 + M5 锁紧螺母压紧 + 3×M2 螺栓防转孔。

## 影响范围

- `examples/multirotor-propeller/`（新目录，全部内容）
  - `README.md`、`scad/prop-ccw.scad`、`scad/prop-cw.scad`
  - `assembly/assembly.json`（24 条接口）、`assembly/assembly-check-report.json`
  - `cad-data/`（v001–v004 版本、p001–p004 零件、r001–r005 运行、project.json）
  - `tools/check-pitch.py`、`tools/printability-report.py`、`tools/archive-to-example.py`
- `docs/DECISION-LOG.md`（追加当日两条决策）
- **未改动**：`dsh-cad-harness/` 的任何业务代码；本示例只消费既有工具

## 具体操作步骤

1. 新建 `examples/multirotor-propeller/`，写自包含 OpenSCAD：NACA 4 位翼型 +
   `linear_extrude(twist, scale)` 沿径向拉出叶片，`multmatrix` 把拉伸轴映射到径向；
   桨毂做 Ø5.2 轴孔 / M5 螺母沉台 / 3×M2 沉头孔；`HAND` 一个参数切换正反桨。
2. `generate_part` 出件并逐轮修正（4 轮）：扭转符号、钝前后缘、叶根端面埋入、桨距/弦长
   锚点精确化。桨毂 7mm、沉台 2mm（座面固定在 z=5）。
3. 建电机接口检具（示意，不打印）与 M5 螺母+垫圈（示意），把"和电机连接"变成可机检的 datum。
4. 用 `check_connectivity` / `check_printability` / `measure_part` / 自写 `check-pitch.py`
   逐项取证；`simulate_motion` 跑正反桨各一次 + **一次故意塞阻挡块的阴性对照**。
5. 写 `assembly/assembly.json`（双工位 × 12 条接口）→ `check_assembly` 24/24 pass；
   `validate_assembly` 6 件静态互查 → 0 干涉。
6. `tools/archive-to-example.py` 把会话语料归集成 v001…、p001…、r001… 的连续编号，
   并自检"无悬空引用"。
7. 写 `README.md`（规格 / **怎么和电机连接** / 打印 / 平衡与安全 / 验证 / 复跑 / 归档映射 / 局限）。

## 预期风险与验证

- **风险点 1：扭转方向做反**。`linear_extrude(twist=)` 与 2D `rotate()` 转向相反，
  渲染图上看不出。→ 已现场触发（第一版桨距 16.6°→24.2° 递增），
  判据固化为 `tools/check-pitch.py`（PCA 反测截面倾角，逐站比对，偏差 ≤0.45°）。
- **风险点 2：叶根拉伸端面露在桨毂外**。会在 Manifold 里产生退化三角面，
  让 `check_printability` 量出**假的 0.17mm 薄壁**并判 `unprintable`。
  → 端面埋入半径 9.5→6 后消失（三角面 26930→26122，最薄壁回到真实的 0.63mm）。
- **风险点 3：把"跑绿了"当成"能失败"**。运动一次 pass 不能说明运动真跑起来了。
  → 加阴性对照（桨盘内塞方块），12 次干涉、间隔恰为 1/3 转，证明时间线是活的。
- **风险点 4：抽样指标被当真值**。`check_printability` 悬垂面积抽样值 200mm²，
  全量实为 2022mm²（低估 10 倍）。→ `tools/printability-report.py` 全量复算，
  并在 README 里写明该字段应读作下界。
- **验证方式**：`check_assembly` 24/24 pass（hardViolations 0）；`validate_assembly`
  6 件 15 对 0 干涉；`check_printability` v001 = `check`；`check_connectivity`
  单实体水密；`measure_part` 体积 7.844cm³ / genus 4。
- **遗留**：毂顶面之上露 0.19mm 叶根端面（已记入 README §8，修法：`HUB_T`→7.5）；
  示例未做气动优化与台架实测，README 已显式声明边界。
