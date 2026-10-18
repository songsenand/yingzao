# 执行摘要：修 `list_features` 非凸开口的假"盲"

## 动机
> 用户追问"圆形通道能判贯通、为什么非圆判不了"。查下去发现**分界划错了**：不是圆与不圆，
> 而是**开口环是否简单（形心是否落在环内）**。实测 L 形贯通槽被 `list_features` 报成
> `through=false, depthMm=0.001` —— 假"盲"。用户裁定"① 必须修"。

## 影响范围
- 修改：`dsh-cad-harness/python/cad_worker/worker.py`
  （新增 `_interior_point_uv()`；`op_list_features` 的逐孔深度探针起点）。
- 修改：`dsh-cad-harness/scripts/accept-list-features.mjs`（新增 3 条断言 + 一个 L 形槽夹具）。
- 新增：`examples/passage-bottleneck/parts/09-l-slot.scad`（该缺陷的对照件，真值 3.750）。
- 记录：`docs/DECISION-LOG.md` 追加 2 条（更正 + 闭环）；实验报告补第 6 节。

## 具体操作步骤
1. **定位**：`hole_depth` 从**孔的拟合圆心**（`_fit_circle` 的 cx,cy）沿面法向投射线。
   拟合圆心只在开口环**准圆/凸**时才保证落在开口内部；L 形的拟合圆心落进**缺角处的材料**，
   射线立刻撞上 → `depthMm≈0.001` → 判成盲。
2. **修**：新增 `_interior_point_uv(ring)`（shapely `representative_point`，退化环返回 None），
   射线起点改用它；`centerMm` 保持原义（对**圆**孔它是对的），异常时回退到拟合圆心。
3. **验收**：`accept-list-features` 加 3 条 —— L 形槽的两个开口都要报出、都 `through=true`、
   都不给 `depthMm`。这三条正是修前的失败点（阴性对照）。
4. **记录**：DECISION-LOG 更正条目（分界划错了）+ 闭环条目（已修、验证、验收）。

## 预期风险与验证
- **风险点**：
  1. 改的是**判据字段** `through`，下游有规则在用（S2-b 把 `through=false` 读成"未判定"）。
     方向是**变严还是变松**？修的是"假盲"，所以只会让更多件从"未判定"变成"有宽度可量"——
     不会引入假排除（规则要求"圆孔且贯通"才给宽度，L 形仍是非圆 ⇒ 仍不量宽度）。
  2. `representative_point` 对自交环需要 `buffer(0)` 兜底；已包 try/except 并回退拟合圆心。
- **验证（实跑）**：
  - 修前/修后同夹具：命中材料 **25/25 → 0/25**，`through` **false → true**。
  - 回归不受影响：椭圆颈（凸，非圆）仍 `through=true`；Ø8/Ø12 圆孔、盲孔 depth 6.000、矩形槽
    的全部既有断言不变。
  - `accept-list-features` **24/24**（21 + 3）；`accept-p3`、`accept-printability-parity`、
    `accept-measure-section`、`accept-python-worker` 全绿。
- **未做（另记，不在本次范围）**：`op_measure_section` 对非圆环报出的 `centerUv/centerWorldMm`
  仍是拟合圆心，可能落在特征之外。这是**报告字段**的语义问题（判据不受影响），需要单独决定
  是"改成环内点"还是"另加一个字段"。
