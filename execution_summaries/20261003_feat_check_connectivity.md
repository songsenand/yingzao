# 执行摘要：check_connectivity 连通体检测 + 单一实体纪律

## 动机
> 用户要求：零件必须是单一连通实体，多体要么 union 要么按多零件建模；需要
> 一个工具检测，并把纪律固化。薄壁检测（check_printability）只回答"打不打得
> 出来"，不回答"是不是一个零件"。

## 影响范围
> - `src/host/mesh.ts`：新增 `connectedBodies`（连通体计数 + 每体包围盒）
> - `src/host/tools.ts`：新增 `check_connectivity` 工具；generate_part 在
>   shells>1 时追加 §18 纪律警告
> - `skills/cad-toolbox/SKILL.md`：路由表 + Traps 纪律
> - `scripts/accept-connectivity.mjs`：新验收

## 具体操作步骤
> 1. mesh.ts：按边共享做三角形 union-find（与 shellCount 同源），每个连通体
>    独立 bbox，最大体优先排序。
> 2. 工具：入参 versionId；返回 verdict（single/multi-body）、bodies、
>    bodySizes（[dx,dy,dz] mm）、bodyCenters、watertight、triangles。
> 3. generate_part：parsed.shells>1 时 push 纪律警告（union 或拆分，指向
>    check_connectivity）。

## 预期风险与验证
> - 风险点：理论上"共享顶点即连通"——两个只在一条棱/一个点相触的体会被判
>   为一体；对打印语义（接触=一体）可接受，记录在案。
> - 测试方式：accept-connectivity 12 PASS（分离双立方=2体、共面并集=1体、
>   空网格=0、真实 temp 项目库端到端、生成端警告与 skill 纪律静态检查）；
>   其余四套验收回归全绿；tsc 干净。
