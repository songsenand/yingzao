# 执行摘要：SCAD 文本协议迁移到 Python（批次 2 收尾）

## 动机
> 判据「能迁就迁 Python」，批次 2 剩 `generate_part`(row 1) 与 `render_part`(row 13)。
> 逐段拆开后发现：这两个工具的**领域内容**其实只有一件事——**SCAD 文本协议**
> （datum 预置的写方、OpenSCAD echo 的读方、`// PARAMS` 约定），其余是 OpenSCAD 进程与
> 图片附件（① 平台）。

## 影响范围
> - `dsh-cad-harness/python/cad_worker/worker.py`：新增 `scad_prelude` /
>   `scad_parse_output` / `scad_parse_params` 三个 op（附 datum 预置常量与四个 echo 正则）
> - `dsh-cad-harness/src/host/compile.ts`：删除 `DATUM_PRELUDE`、`parseDatums`、
>   `parseDatumFeatures`、`makeDatumSet` 与同步版 `parseMessages`；改为 worker 支撑的
>   `datumPrelude()`（带缓存）、`scadParseOutput()`、异步 `parseMessages()`、异步 `parseParams()`
> - `dsh-cad-harness/src/host/tools.ts`：`/api/cad/params` 与 `/api/cad/preview` 两个路由
>   `await parseParams(scad)`
> - `dsh-cad-harness/scripts/accept-scad-protocol-parity.mjs`（新增验收）
> - 文档：矩阵 row 1、row 13（判定为 ① 平台系留）与批次 2（完成）

## 具体操作步骤
> 1. **写方**：datum 预置放进 worker（`DATUM_PRELUDE` 常量），TS 通过 `scad_prelude` 取一次并
>    缓存（实测一次往返、之后零成本）。这样"格式只有一个家"——预置改了、解析必然跟着改。
> 2. **读方**：`scad_parse_output` 一次调用返回 errors/warnings/datumSet。错误规则照搬 TS：
>    `ERROR:`/`WARNING:` 去前缀，`Trace:`/`In file` 计入 errors（OpenSCAD 失败的有用部分在那里）；
>    四种 datum echo 的正则逐字照搬（含 `[^"=]+` 名字与 `-?[\d.eE+-]+` 数值）。
> 3. **`// PARAMS`**：`scad_parse_params` 照搬 TS 的约定正则（顶层数字赋值 + `// PARAMS 描述`）。
> 4. **留在 TS 的**：OpenSCAD 二进制发现（含内置 squashfs 快照与 xvfb 显示）、spawn/超时/
>    临时目录、四条视图渲染、`ctx.attachments`、版本落盘。**理由不是"省事"，而是这些是
>    "这台机器的工具链与平台服务"**，与"领域逻辑用 Python"这条判据无关（①）。
> 5. `render_part`(row 13) **判定为 ① 平台系留**：领域内容只剩 4 行相机常量 + OpenSCAD 调用，
>    搬过去只多一次往返（实测 0.25 ms）而无领域收益。判断写进矩阵 row 13，不单列迁移项。

## 预期风险与验证
> - **风险点 1：datum 协议格式两边漂移。** 这正是本步要消除的——写方与读方现在同一个文件。
>   验证：合成输出逐字段精确比对（含负号与指数）、预置文本含四个模块与四个 echo 标记。
> - **风险点 2：真实编译里 datum 丢值或串味。** 验证：真实 OpenSCAD 编译四种 datum 全部
>   原值返回（点/轴/面/圆柱），且 `datums` 与 `datumSet.points` 一致。
> - **风险点 3：报错信息被"解析没了"。** 验证：故意写坏 SCAD（缺右括号）→ 编译失败且
>   errors 非空（实测 "Parser error: syntax error in file model.scad, line 15"）。
> - **风险点 4：`parseParams` 变异步后漏 await。** 验证：`tsc --noEmit` 抓出两个路由的
>   `for (const p of parseParams(scad))`；已改为 await。
> - **验证方式：**
>   ```bash
>   cd dsh-cad-harness
>   export DSH_CAD_PYTHON_ROOT=$PWD/../.tmp-measure-runtime
>   node scripts/accept-scad-protocol-parity.mjs --runtime $DSH_CAD_PYTHON_ROOT   # 全过
>   # 受 compile.ts 影响的既有验收（本轮全跑）
>   for s in accept-p1 accept-m2 accept-m3 accept-m36 accept-import accept-connectivity \
>            accept-measure accept-tool-scope accept-bosl2; do node scripts/$s.mjs; done
>   node_modules/.bin/tsc --noEmit && node esbuild.mjs
>   ```
