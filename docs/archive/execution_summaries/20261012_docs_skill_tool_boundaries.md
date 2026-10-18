# 执行摘要：校准 skill 的工具边界标注 + 修掉 skill/preset 的打包遗漏

## 动机
> 用户："请检查 skill 是否准确标注每个工具的边界"，随后追问"skill 为啥不用最新的 Python 版本的工具？继续使用 js/ts？"
> —— 前者要求逐条核对 SKILL.md 的边界声明；后者暴露了运行时边界那句话写得过于笼统。

## 影响范围
> - `dsh-cad-harness/skills/cad-toolbox/SKILL.md`：工具数、路由表、边界事实、运行时边界
> - `dsh-cad-harness/package.json`：`files` 数组补 `skills/`、`presets/`

## 具体操作步骤
> 1. **事实性错误**：`Fifteen tools` → 实际注册 **20 个**（`tools.ts` 18 + `python-tools.ts` 2）；
>    路由表补 4 行（`create_part`/`delivery_audit`/`run_python`/`python_runtime`）；
>    删掉与同文件另一处矛盾且已过时的 "`simulate_physics` takes no joints other than revolute"
>    （代码实为 `'revolute' | 'prismatic'`）。
> 2. **补齐 7 条边界**：`simulate_fluid` 的单一 realization 与 `dt` 离散化（0.674→0.758→0.797）、
>    `pass` 只是地板、必须读 `warnings`/`seedStats.solidFraction`；`simulate_physics` 的 `metrics.notes`
>    与 `settled`/`jointViolations` 语义；`check_printability` 的采样步长与"最近对面壁"修正；
>    `measure_part` 的 `genus` 只对单体有意义（多体为负）；`check_connectivity` 的共享边判据；
>    `// PARAMS` 调参约定；运行时边界。
> 3. **运行时边界写准**（用户追问后的修正）：按 `ensurePythonWorker()` 的全部调用点列出
>    **依赖运行时**的 12 个工具与**不依赖**的 6 个（`check_assembly`/`delivery_audit`/`create_part`/
>    `set_datums`/`render_part`/`recall_reference_image`）。初版写成"the geometric tools run on …"
>    是过度概括。
> 4. **打包遗漏**：`package.json.files` 只有 `lib/`、`python/`、`cordis.patch.yml`，
>    而 `dsh.bundle.patch` 引用了 `presets/cad/preset.patch.yml`、CAD preset 又引用 `skills/`
>    ⇒ 补 `skills/`、`presets/`。

## 预期风险与验证
> - **风险点**：skill 是模型可见的指令文本，改错会直接误导工具选择。所有新增事实都逐条对照代码或实测：
>   fluid.ts 的 pass 规则/warnings 阈值、physics.ts 的 notes 与 5mm/s、2mm 阈值、
>   tools.ts 的采样步长 `floor(triangles/samples)` 与 verdict 规则、measure_part 的 genus 实测值、
>   connectivity 的共享边判据、PARAMS 正则。
> - **自己写错又跑出来的一处**：初版写"`DSH_CAD_PYTHON=off` 时物理/运动仍走 TS"，实跑
>   `DSH_CAD_PYTHON=off node scripts/accept-sim-verdict.mjs` 得到 "runtime is not ready (state: disabled)
>   — run the python_runtime tool with action provision" ⇒ 已按事实改写（仅 darwin-x64 例外）。
> - **验证**：20 个注册工具名逐一在 SKILL.md 中查找 → 20/20 命中；路由表恰好 20 行。
> - **未改动的设计取舍（仅记录）**：CAD preset 的 `customSkillDirs` 是生成时写入的**绝对路径**
>   （`sync-cad-preset.mjs` 用 `resolve(ROOT,'skills')`），因为 `dsh-skill-filesystem` 对每个 root
>   做 `resolve()`——不展开 `~`。换机器/换目录必须重跑生成器（脚本带 `--check` 可检出漂移）。
