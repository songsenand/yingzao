# 执行摘要：修复过期仪器检查并落地评测夹具

## 动机
> 按评测题库 `examples/bench/` 的开测流程，执行第 1、2 步：生成 `02` 的导入夹具、
> 跑整套 `accept-*.mjs` 当**仪器校准**（`bench-smoke.mjs` 尚未写出，手工版就是这
> 一套）。校准结果 24/25，唯一的 FAIL 需要判定是"插件退化"还是"检查过期"——
> 这个判定本身就是校准的意义所在。

## 影响范围
> - `dsh-cad-harness/scripts/accept-tool-scope.mjs`（第 4、5 节 + 头注释）
> - `examples/bench/subjects/02-steam-engine/assets/608.stl`（生成物，已 gitignore）
> - `examples/bench/README.md`（§7 补手工校准流程）

## 具体操作步骤
> 1. **生成夹具**：`OPENSCADPATH=<repo>/lib openscad -o
>    examples/bench/subjects/02-steam-engine/assets/608.stl
>    examples/bench/graders/02-steam-engine/assets/make-608.scad`
> 2. **验证夹具**：直接调 `importGeometry`（`accept-import.mjs` 用的同一个入口）
>    验正例与反例——正例 bbox 精确 `[22, 22, 7]`、体积 2198.1 mm³；反例（把三角形
>    砍掉一半的网格）被守门员拒绝。临时反例用完即删。
> 3. **诊断 FAIL**：`accept-tool-scope.mjs` 的两个 FAIL 都指向
>    `@deepseek-ai/dsh-agent-presets`（复数，旧的预设名册包）。查证该包已被上游
>    移除、插件早已迁移到 `@deepseek-ai/dsh-agent-preset`（单数）**声明行**机制，
>    且 `dsh --profile web --dump-config` 里 `preset-cad` 行**正确组出**
>    （旧名册行数量为 0）→ 判定为**检查过期**，不是插件退化。
> 4. **改第 4 节**：原来 `import('@deepseek-ai/dsh-agent-presets')` 拿 `scanRoot`
>    做发现，包没了就 SKIP——**连带把"挂了 CAD-only 手册根"这条断言也一起跳过**，
>    一个发绿的套件悄悄少了覆盖。改为**静态读**本仓发布的
>    `presets/cad/preset.patch.yml`，断言：插入了 `@deepseek-ai/dsh-agent-preset`
>    声明行、名为 `cad`、有展示元数据、≥10 条 plugin 行、且
>    `cad-skill-filesystem` 指向本仓 `skills/`。
> 5. **改第 5 节**：把两条旧名册断言换成**组合后**的声明行断言——组合树里有
>    `preset-cad`、用的是当前包名、名为 `cad`、且挂的是本仓 skill 根。
> 6. **头注释**同步（第 3、4 条描述已不成立）。

## 预期风险与验证
> - **风险点**：把"过期检查"误判成"插件没问题"从而掩盖真实退化。
>   **处置**：判定前先拿到正向证据——`dsh --profile web --dump-config` 里
>   `preset-cad`（`id: cad` / `name: 造物模式`）确实组出、旧名册行为 0、
>   `customSkillDirs` 指向本仓 `skills/`。即**新机制在工作**，只是没人验它。
> - **风险点**：新断言绑死 YAML 缩进，上游改格式会再过期。
>   **处置**：断言只依赖"行 id + 包名 + 出现 skill 根路径"这类结构事实，
>   不解析整棵树。
> - **验证方式**：`node scripts/accept-tool-scope.mjs` → 全 PASS、exit 0；
>   随后重跑整套 25 个 `accept-*.mjs` 确认全绿。
> - **附带修正**：先前把 OpenSCAD 的 `Volumes: 2` 当成"不相连 = 夹具坏了"是**错的**
>   ——实测连不带槽的纯管件也报 2（外表面 + 内孔两个壳）。连通性的守门员是
>   `import_part` / `importGeometry`，不是那个计数。夹具头注释里写的正是这个正确
>   做法，已按它执行。
