# 0.1.1-preview.1 发布说明

> **状态**：`0.1.1-preview.1` 发布说明；版本号已由用户 2026-11-20 确认。
> 功能、证据、安装/升级、已知问题与发布步骤见下文；标准件目录的现状见 §8 与
> `docs/llm/library.md`。
> **基线**：`v0.1.0-preview.5` → 本版。
> **目标/范围/验收**：[RELEASE-0.1.1.md](RELEASE-0.1.1.md)；**状态**：已发布（2026-11-20，npm `latest`，
> gitHead `f62124b`）；L1.8 已收口，见 [TODO.md](TODO.md) §7.1。

---

## 1. 升级须知：升级 dsh 之后必须重跑 `dsh-cad-setup`

预设 `presets/cad/preset.patch.yml` 不是引用 dsh 的 `standard.patch.yml`，而是**逐字复制**
（`scripts/preset-lib.mjs`）。dsh 会在版本之间删改内部行，而预设是**整块挂载**的：

- 一行插件起不来 → 整个预设失败 → **「营造模式」直接不出现**，没有报错弹窗；
- 表现上像“插件消失了”，实际是预设没挂上，CAD 工具与面板随之不可用。

所以每次升级 dsh 之后：

```bash
npx dsh-cad-setup    # 按当前 dsh 重新生成预设
# 重启 dsh
```

`npx dsh-cad-doctor` 现在会检查这条同步关系：不一致时报 `preset-standard-drift`，
并给出上面这条修复命令。

---

## 2. 已知问题：0.1.0-preview.2 – .5 在 dsh 0.2.2-rc.1 上没有「营造模式」

dsh **0.2.2-rc.1 移除了** `@deepseek-ai/dsh-tool-subagent-control/list-agents` 子路径
（`list_agents` 并入主插件）。这四个已发布版本打包于 11-17 / 11-18，当时本机装的还是 0.2.1 系，
所以 tarball 里的预设带着这一行，在 0.2.2-rc.1 上：

| 版本 | tarball 内预设含 `list-agents` | `modelSelectionSettings` | 未跑 `dsh-cad-setup` 时 |
|---|---|---|---|
| 0.1.0-preview.2 | 是（2 处） | 有 | 预设整块失败，无「营造模式」 |
| 0.1.0-preview.3 | 是（2 处） | 有 | 同上 |
| 0.1.0-preview.4 | 是（2 处） | 有 | 同上 |
| 0.1.0-preview.5 | 是（2 处） | 有 | 同上 |

启动时的可观察证据（`~/.dsh/logs/startup-*.log`）：

```text
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './list-agents' is not defined by
"exports" in .../@deepseek-ai/dsh-tool-subagent-control/package.json
warn  agent preset cad: tool-subagent-list-agents (.../list-agents): never started
```

**处置（任选其一）：**

1. 跑一次 `npx dsh-cad-setup` 再重启 dsh（按你机器上的 dsh 重新生成，最稳）；
2. 或升级到带新预设的修订版（本版发布后）。

这个失败只在**移除了该子路径的 dsh 版本**上出现（实测 0.2.2-rc.1）。0.2.1 系上这四个包能正常装载；
其他中间版本没有逐一验证。

---

## 3. 本版修了什么（L1.8）

| 项 | 内容 |
|---|---|
| 预设重生成 | 按 dsh 0.2.2-rc.1 的 `standard.patch.yml`：删 `list-agents` 行；`modelSelectionSettings` → `modelSelection` + `modelDiscovery`；补 `tool-fs.applyPatch`；`tool-plugin-manager` 门控对齐 |
| 预设记版本 | 生成文件头写 `# Source: … (dsh <version>)`，让陈旧预设能自报“我是哪版 dsh 生成的” |
| `doctor` | 新增 `preset-standard-drift`：用 `buildPreset()` 生成期望文本与磁盘比对；不一致 fail，并给 `npx dsh-cad-setup` + 重启的 fix |
| 发布前门禁 | `prepublishOnly` 跑 `check-release-preset`：用 packed（无本机路径）预设比对目标 dsh，CI/别的 checkout 也能通过；`setup --check` 仍是安装后自检 |
| 文档 | README（根 / npm 页 / 英文）写明“升级 dsh 后重跑 setup”；本文件记录 preview.2–.5 的已知问题 |

**不改变的东西：** 预设仍然复制生成（dsh 的预设机制没有继承/引用），所以这是“生成 + 检查”，
不是“一次生成、跨版本通用”。若 dsh 将来支持预设继承，再改为引用。

**发布机前提：** `prepublishOnly` 要求发布机上装着目标 dsh（找不到 `standard.patch.yml` 时按失败
处理）。另外，`npm publish` 若在 `prepack` 之后失败（网络/鉴权/缓存），仓库里的预设会停在没有
skill 行的中间态——下一次 `npm publish` 会被 `prepublishOnly` 直接拦下，跑一次
`npx dsh-cad-setup` 即恢复。

---

## 4. 发布前证据（本机，2026-11-19）

| 门禁 | 结果 |
|---|---|
| `accept:doctor` | **20/20 PASS**（新增 4 项：setup 可为另一 root 生成预设、同版预设 pass、`list-agents` 旧预设 fail、fail 时给 `dsh-cad-setup` fix） |
| `accept:setup` | **11/11 PASS**（含 `--without-skills` 省略 skill 行） |
| `accept:bundle-load` | **4/4 PASS**（临时 profile 组合出 host/preset/skill provider） |
| `npm publish --dry-run`（旧预设） | **exit 1**，停在 `prepublishOnly`：`preset.patch.yml is stale or missing. run: npx dsh-cad-setup` |
| `npm publish --dry-run --tag preview`（当前预设） | **exit 0**：`prepublishOnly` → `prepack`（build）→ `postpack` 全跑通；tarball **480 files / 11.1 MB packed / 37.1 MB unpacked**；包内预设有 `modelSelection`、无 `list-agents`、无 skill 行，文件头写 `dsh 0.2.2-rc.1` |
| `accept:preview` | 未跑（本沙箱对 `~/.dsh`、pnpm store 只读，`accept:plugin-add`/`provision` 会因环境失败；需在可写环境复跑） |

> 预发布版本发布时必须带 `--tag`（如 `npm publish --tag preview`）；不带会被 npm 直接拒绝
> （`You must specify a tag using --tag when publishing a prerelease version`）。

---

## 5. 发布步骤（tag 之后补）


---

## 6. 本版新增（0.1.1-preview.1）

- **CadQuery 成为一等作者内核**：`compile(...,{kernel:"cadquery"})`、`generate_part({code})`、`model.py` + `backend.kernel` 版本 pin；OpenSCAD 仍是渲染/导出的常驻依赖。
- **安装时内核选择**：`dsh-cad-setup --kernel openscad|cadquery`；TTY 未给 flag 时询问，默认 OpenSCAD；写入 `backend.json`，不自动下载 pack。
- **会话内核上下文**：每个 CAD 会话的 prompt 直接写 `CAD authoring kernel: …`，模型写第一行代码前就知道用 `code` 还是 `scadCode`。
- **统一验证**：STL→Manifold；STEP→`import_mesh` + OCP BRepCheck；`datums.json` schema；`step_hash_mismatch` / `datums_invalid` 等 code。
- **STEP 能力**：`generate_part({code, step:true})` 写 `model.step`，版本记录 `stepSha256`/`brep`；`/api/cad/export?format=step` 只读并校验 hash。
- **作者层**：`code`/`scadCode` 二选一；CQ 渲染走共享 STL→OpenSCAD；CQ GUIDE + bracket 示例。
- **发布门**：`accept:release` 要求 CadQuery pack，不允许把 SKIP 当绿。

## 7. 安装 / 升级

```bash
npx dsh-cad-setup --openscad=auto --kernel openscad   # 或 cadquery
npx dsh-cad-doctor
```

- CadQuery 需要单独安装约 1.6 GiB pack（`DSH_CAD_CQ_PACK` 或 `$DSH_HOME/cad/packs/cadquery`），setup 不会自动下载；OpenSCAD 必须保留。
- 升级 dsh 后重跑 `npx dsh-cad-setup` 再重启。
- `npx dsh-cad-backend --show` 确认 `kernel`；`cad_session info` 也会报告。

## 8. 已知问题（本版不阻塞 preview）

- **99 个标准件目录随包分发，但 0.1.1-preview.1 没有 `cad_part` 的 list/get/import-by-catalog 操作**；`fit`/`visual` 目前不能通过工具选择，`assembly.json` 也没有结构化 `libraryRef`。见 `docs/llm/library.md`。这不影响非标准件建模。
- Windows 是 smoke + 内核测试，macOS 是完整 preview；两者已在 GitHub CI 通过，但没有本地真机手工 smoke。CadQuery 真机只在 Ubuntu CI 跑。
- 项目 ZIP 逐件带 STL，存在 `model.step` 时也带 STEP；STEP 往返/完整审计留 0.1.2。
- CadQuery pack 的 VTK 不能作为 headless 渲染器；四视图仍走 OpenSCAD。
- TTY 内核选择由 Linux PTY 手工验证，不在 Windows CI；CI 覆盖 `--kernel` 参数路径。

## 9. 发布步骤

```bash
npm run build
DSH_CAD_REQUIRE_CQ=1 DSH_CAD_CQ_PACK=/path/to/cadquery npm run accept:release
npm pack --pack-destination /tmp
npm publish --tag preview
```

预发布版本必须带 `--tag preview`；不带 tag 会被 npm 拒绝。

## 10. 同 prompt 内核质量实验（L1.11）

同一 `60×40×6` 板 brief 经真实 `generate_part` 分别跑 OpenSCAD 与 CadQuery：bbox、水密、genus 一致；体积差 0.00066%，面积差 0.0019%；CQ 提供原生 STEP。实验发现 CadQuery `.box` 默认 z 居中与 datum 不一致时原验证不报错，已新增 `datum_outside_bbox` warn。完整报告：`experiments/20261120_L1.11_kernel_quality.md`。

## 11. OpenSCAD 版本选择修正（2026-11-20）

编译、`dsh-cad-provision` 与 `doctor` 现在都按**版本号最高者**选择 OpenSCAD，而不是第一个命中的路径。
系统 PATH / `CAD_OPENSCAD_BIN` / `backend.json` 里的旧版本不会覆盖插件内的高版本快照；`setup --openscad=auto`
验证：系统 2021.01 + 插件 2026.09.23 → `backend.json.binaryPath` 指向插件快照。`accept:backend` 24/24。
