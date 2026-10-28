# 子智能体构建任务（给执行者）

> 目标：在**本目录**注册 37 个交付件 + 2 个仿真导向件，建立装配契约，跑静态检查、插入仿真、
> 打印筛查，写 BUILD.md / VERIFICATION.md。不要读 `examples/ball-and-stick/glucose-molecule/`
> 或任何别的分子项目；本目录的 spec 是唯一输入。

## 0. 先确认写路径

1. `pwd` 必须是：
   `/home/songsenand/Project/ToyMarker/examples/ball-and-stick/fructose-molecule`
2. 第一次 `import_part` 后立刻 `ls cad-data/versions`：
   - 版本必须在**本目录**的 `cad-data/` 下。
   - 如果出现在仓库根 `cad-data/`（符号链接指向 glucose），**停止**并报告，不要继续写。
3. 不要生成/修改 `examples/ball-and-stick/glucose-molecule/` 下任何文件。

## 1. 读输入

按顺序读：

- [`SPEC.md`](SPEC.md)（几何/键表/坐标）
- [`INTERFACE.md`](INTERFACE.md)（接口/公差/依据）
- [`PRINT.md`](PRINT.md)（打印/装配/试配）
- [`spec/import_manifest.json`](spec/import_manifest.json)（39 个件的 STL + datum）
- [`spec/motion_setup.json`](spec/motion_setup.json)（两个仿真位姿）
- [`spec/process-profile.json`](spec/process-profile.json)（自定义 FDM profile）
- [`assembly/assembly_plan.json`](assembly/assembly_plan.json)（122 个接口的骨架）

不要在上下文里展开所有 SCAD；源文件在 `spec/scad/` 供人审阅即可。STL 已预编译在
`.tmp/all2/`（每个都水密、单实体）；如果缺失，用：

```bash
for f in spec/scad/*.scad; do
  b=$(basename "$f" .scad)
  grep -v '^datum' "$f" > ".tmp/all2/$b.scad"
  openscad -o ".tmp/all2/$b.stl" ".tmp/all2/$b.scad"
done
```

## 2. 注册零件（import_part）

用 `import_part`，**不要**用 `generate_part`（SCAD 已经在 spec 里，重复生成会浪费上下文）。

每个件：

```json
{
  "file": ".tmp/all2/Fru-C3.stl",
  "part": "Fru-C3",
  "unit": "mm",
  "render": false,
  "userIntent": "果糖 C3 原子球（C，4 个接口）",
  "datums": [ ...来自 spec/import_manifest.json 的 datums... ]
}
```

要求：

- `render:false`，不要每件都附四视图；代表件最后单独 `render_part`。
- 全部 39 件：C1–C6、O1–O6、H（1 件）、B01–B24、GUIDE-B03、GUIDE-B15。
- 把返回的 `versionId` 写进 `spec/version_map.json`，键是 part 名：
  `{"Fru-C1":"v...", ..., "Fru-H":"v...", "GUIDE-B03":"v...", "GUIDE-B15":"v..."}`。
- H 只注册一次；12 个 H 实例共用这个版本。
- 如果 `import_part` 拒绝某个 STL：不要用 `allowNonSolid` 蒙混；停下报告。
- 注册后跑 `check_parts` 分批（每批 ≤12，`checks:["measure"]`）确认 watertight / 单实体；
  记录任何 bodies>1 或 watertight=false。

## 3. 生成装配契约

```bash
python3 spec/emit_manifest.py
```

此时 `spec/runs.json` 还不存在，先生成 120 个静态接口的 `assembly/assembly.json`。
然后跑：

```text
check_assembly({ manifestPath:"assembly/assembly.json", adjacencyThresholdMm:0.5 })
```

期望：`judgement` 不是 excluded；`hardViolations` 为空；`skipped` 为空。
如果某个接口 hard-violation：

- 先看是 datum 名/变换错，还是几何错；
- **不要**为了通过而放宽容差；记录到 BUILD.md，必要时报告。

## 4. 静态装配干涉

跑 `validate_assembly`（代表性子装配即可，不必 48 件）：

```text
parts: C3, C4, H04, B03, B15（用 versionId；位姿取 molecule.json）
interferenceEpsilonMm3: 0.01
clearanceThreshold: 0.05
```

期望：配对干涉 ≤0.01 mm³（多边形拟合残差）；记录最大值。
不要因为 mating 面 clearance=0 就判失败；这个工具在这里只看干涉量。

## 5. 插入仿真（两个 run）

按 `spec/motion_setup.json`。关键：

- `position` 用 **`guide_final_position`**（不是 expected_t0_position）；振荡器会在 t=0 加 +amplitude。
- 轴 = `axis`；amplitude/period/phase 按 JSON；`cycles:0.25`；`omega:6.283185307`。
- C3 fixed；GUIDE kinematic；再加一个远处的 dummy Crank（kinematic）+ Base（fixed）做 drive。
- `joints` 先试 `[]`；若工具要求非空，给 Crank–Base 一个 dummy revolute（轴 Z），不要让
  dummy 与模型接触。 
- 跑 B03、B15 各一次，记 run id；期望：插入 0→12 mm（轻 0→10 mm）无干涉，final pose 在
  0 位，`overallStatus` pass。
- 再跑一个 **B03 错相 15°** 的 run（`guide_wrong15_rotation`），期望出现干涉；这是负样本，
  不要写进装配契约的 motion 接口。
- 把两个正样本 run id 写进 `spec/runs.json`：

```json
{"motion_B03":"r...", "motion_B15":"r..."}
```

再跑一次 `python3 spec/emit_manifest.py`，现在契约会有两个 motion-clearance 接口。
再跑 `check_assembly`，确认 motion 半通过。

> 重要边界：GUIDE 件是**去卡扣**的导向件。它只证明刚性导入/落座路径；卡扣弹性不在
> 刚体仿真内。BUILD/VERIFICATION 必须原话写清，不能把 run 说成“卡扣保持力已验证”。

## 6. 打印筛查

1. 代表件用自定义 profile：

```text
check_printability({
  versionId:"<C3>",
  profilesJson: "<spec/process-profile.json 的内容，包成数组>",
  mode:"both"
})
```

至少跑 C3、O5、H、B03、B15 五个代表件（覆盖重/轻、球/棍、key/无 key）。
期望：wallMeasured=true；没有 hard 排除；悬垂 finding 记录为“需支撑”，不是失败。
2. 其余件用 `check_parts` 的 measure 半确认水密/单实体即可；如果时间允许，再抽查 B01/B24。
3. 如果自定义 profile 判 `excluded`：记录 witness（哪条规则、哪个位置、实测 vs 要求），
   不要改 profile 数值来“过”；如果确实是设计问题，报告。

## 7. 视图

只给最终代表件附少量图：

- `render_part` C3 iso、B03 iso、H iso、全装配（用 `validate_assembly` 的渲染或
  `render_part` 单件拼图不现实；至少 C3/B03 各一张）。
- 不要给 37 件每件附图。

## 8. 审计与文档

1. `delivery_audit`：

```text
claims: [
 {kind:"assembly", statement:"48 件最终位姿无干涉；120 个静态接口通过同轴/贴合/孔径检查。"},
 {kind:"motion", statement:"B03/B15 导向件 0–12/0–10 mm 插入路径无干涉；B03 错相 15° 干涉。"},
 {kind:"manufacturability", statement:"37 个唯一件水密单实体；5 个代表件通过自定义 FDM profile 筛查。"},
 {kind:"review", statement:"已查看 C3/B03/H 代表件与装配检查结果。"}
]
exempt: [{path:".tmp/all2", reason:"编译后的导入源 STL；字节已复制进版本库，保留用于复核"}]
```

2. 回答 findings；如果有 `blocked`，不要宣布交付，写进 VERIFICATION 的“未解决”。
3. 写 `BUILD.md`：按时间顺序记录工具、版本、run id、关键数字、失败与修正。
4. 写 `VERIFICATION.md`：实际数字、仿真边界、打印筛查、审计结论；引用 run id。
5. 更新 `README.md` 的“当前状态”一节（只改变状态，不重写设计）。

## 9. 禁止

- 不读/不改 glucose 项目。
- 不为了让检查通过而放宽容差、改 profile 阈值、或用 `allowNonSolid`。
- 不把 GUIDE 件写进交付 BOM。
- 不声称“卡扣力已仿真验证”；仿真只覆盖导向/落座。
- 不在导入后重新生成版本（会让 run 变 stale）；如果必须改几何，停下报告。
