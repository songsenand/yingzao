# 执行摘要：check_printability 迁入 Python，并修掉两个被暴露出来的真缺陷

## 动机
> 判据"能迁就迁"。矩阵 row 9 的负收益清单里，这个工具含一项**空间索引**查询（沿内法线的
> 光线投射），属于必须先量后写的类型。上一轮已量：Python 侧 trimesh `RayMeshIntersector`
> 在 28,830 面真实件上 601 根光线 **0.121 s**，相对该工具 120 s 超时不是瓶颈 ⇒ 迁移无负收益。
> 本轮落地，结果是**迁移过程本身暴露了两个现役 TS 实现里的真缺陷**。

## 影响范围
> - `dsh-cad-harness/python/cad_worker/worker.py`：新增 `check_printability` op
>   （+ `_js_round`、`_js_to_fixed`），并把 `_round3` 从 Python 银行家舍入改成 JS `Math.round` 语义
> - `dsh-cad-harness/src/host/inspect.ts`：内联在 `tools.ts` 里的实现**提取**为
>   `checkPrintabilityInTs`（oracle）+ 转发版 `checkPrintability`
> - `dsh-cad-harness/src/host/tools.ts`：工具体只剩 `allStores` + 转发
> - `dsh-cad-harness/scripts/accept-printability-parity.mjs`（新增验收，5 个件）
> - `.gitignore`：补 `__pycache__/`、`*.pyc`（worker 的字节码曾被误入库，已 `git rm --cached`）
> - 文档：矩阵 row 9、DESIGN §26.4

## 具体操作步骤
> 1. 把 `tools.ts` 里那段内联实现整体搬进 `inspect.ts`，工具体改为转发。
> 2. Python 侧镜像：采样三角面（步长 `floor(triCount/targetSamples)`）→ 悬垂面积（纯算术）→
>    壁厚（光线投射）→ findings/verdict。字符串里的数字用 `_js_to_fixed`（**JS `toFixed`
>    语义：平局取更大值**，Python 的 f-string 是银行家舍入，0.125 会打印成 `0.12` 而 JS 是 `0.13`）。
> 3. 验收：悬垂面积/采样数/z 区间要求**完全相等**，壁厚允许小带宽，判定与 findings 类别必须一致。

## 预期风险与验证（本轮的两个真缺陷）

### 缺陷 A：悬垂面积依赖空间索引的内部副作用
> `buildMeshBvh(mesh)` 把 `mesh.triVerts` **同一个数组**交给 three-mesh-bvh，而该库为了缓存
> 局部性会**就地重排这个索引**。原实现先建 BVH 再采样 ⇒ 采到的其实是"重排后的每第 48 个面"。
> 实测（同一个 整机.stl）：重排序 **647.6 mm²** vs 解析序 **244.1 mm²**；两次解析顺序相同。
> 修法：BVH 拿一份索引拷贝（`triVerts.slice()`），采样固定为**解析序**。
> 影响：真实件报告的悬垂面积从 647.6 变为 244.1 mm²（两侧现在都是 244.1，逐位相同），
> 观察到的用例里判定不变（都远超 20 mm² 的 finding 阈值）。

### 缺陷 B：壁厚取了**遍历序**而不是**最近**的命中（安全相关）
> 原写法是"取返回数组里第一个 distance > 0.075 的命中"，默认返回是距离排序的。**它不是**：
> `MeshBVH.raycast` 返回的是 **BVH 遍历序**。实测一根真实件光线：
> `[292.93, 289.92, 191.44, 197.93, 180.56, 0.05, 11.05, 3.06]` —— 原写法取到 **292.93**（对面远壁），
> 而最近的壁在 **3.06**。后果：**低估薄壁** —— 真实件上报告最小壁厚 **0.2 mm**，真值 **0.026 mm**；
> 薄壁采样 15 个，真值 34 个。
> **真值由暴力法确认**：对全部 28,830 个三角面做 Möller–Trumbore，ray 561 的真实命中是
> 3.06/11.05/180.56/191.44 ⇒ 最近壁 3.01 mm，与 Python 的 `min(...)` 结果一致。
> 修法：两侧都取"大于跳过距离的**最近**命中"。修完 `TS 0.026 · py 0.026 · Δ 0.0000 mm`、`34 vs 34`。
> 影响：修法只会**更保守**（只可能报出更薄的壁，不会漏报）；观察到的用例判定不变，
> 但一般情况下 verdict 可能从 `ok/check` 变成 `unprintable` —— 这是**修对了**的方向。

## 验证方式与结果
```bash
cd dsh-cad-harness
export DSH_CAD_PYTHON_ROOT=$PWD/../.tmp-measure-runtime
node scripts/accept-printability-parity.mjs --runtime $DSH_CAD_PYTHON_ROOT   # 全过
node scripts/accept-p3.mjs && node scripts/accept-tool-scope.mjs
```
- 5 个件（立方体/0.8mm 薄壁盒/球/三通/真实件）：悬垂面积与 z 区间**完全相等**、
  最小壁厚 Δ ≤ 0.0000 mm、薄壁计数一致、verdict 与 findings 类别一致
- `accept-p3` PASSED（它通过**真实工具对象**跑 check_printability）、`accept-tool-scope` OK
- `tsc` 干净
