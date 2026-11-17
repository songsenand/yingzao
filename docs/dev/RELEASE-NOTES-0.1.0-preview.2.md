# 0.1.0-preview.2 发布说明（2026-11-17）

> **基线**：`v0.1.0-preview.1` → 本版（55 个提交）。预览语义不变：**这不是生产放行系统**。
> **证据口径**：只认能指名观察的结论；发布门禁见 §4。
> **标签**：`v0.1.0-preview.2`（打 tag 即触发 `.github/workflows/preview.yml`）。

---

## 1. 这一版最重要的变化

### 1.1 模型面：39 个工具 → 9 个作业面（surface）

模型现在只看到 9 个入口，参数用 `action + args` 按需展开：

`cad_session` / `cad_part` / `cad_assembly` / `cad_check` / `cad_simulate` /
`cad_inspect` / `cad_see` / `cad_python` / `cad_deliver`，共 39 个 op。

- 顶层 schema 从约 87 KB 降到约 4 KB；`catalog` 列 op，`help` 给单个 op 的参数。
- 旧工具名（`measure_part`、`check_turning`、`render_part` …）仍是内部实现名；
  直接调用会报 `unknown tool`。
- `measure_*` 五个合并为 `measure(kind="part"|"gap"|"thickness"|"section"|"angle")`。

### 1.2 标准件库 v0

- 99 个规范件的核心目录，预生成 STEP/STL（fit / visual 两档 LOD），随包分发。
- CadQuery 生成环境不随包；安装时只解压/校验，不在用户机上装 CAD 内核
  （依据：`experiments/20261117_install_time_step_stl_benchmark.md`）。
- 代价：tarball 从 118 files / ~4.5 MB 增到 **521 files / ~12 MB**（visual STL 是大头）。

### 1.3 示例

- 新增 DN100 PN16 两片式球阀：装配契约、运动、流体、9/9 件工艺筛查与 PTFE 板件档案。

### 1.4 验证与证据

- 仿真证据按版本记录；新增 check-only 孔契约。
- 修复 `evidence.runId` 被静默丢弃：引用不存在的 run 现在是 **hard violation**，
  不再是 pass。
- `check_assembly` 的指针按 manifest 文件名作用域，换文件不再误用旧指针。

### 1.5 供给与界面

- OpenSCAD 供给可换源、可离线；镜像补齐 GPL 再分发义务。
- 客户端 UI 文案**完整双语**（`accept:ui-i18n` 扫描字面量，zh/en 同 key）；
  preview.1 里“深层面板仍以中文为主”的边界在本版关闭。

---

## 2. 安装与升级

新装（与 preview.1 相同）：

```bash
tar -xzf dsh-cad-harness-0.1.0.tgz
dsh plugin --profile <profile> add -w "$PWD/package"
cd package
npx dsh-cad-setup          # 写入本机 skill 路径
npx dsh-cad-backend --show # 内核/编译后端
npx dsh-cad-doctor         # kind=ok，或有解释的 degraded
# 重启 dsh
```

从 preview.1 升级：解压新 tarball、重新 `dsh plugin add`，然后**必须重跑
`npx dsh-cad-setup`**（preset 里的 skill 路径按机器生成），再重启 dsh。
项目语料 schemaVersion 1 不变，无需迁移。

---

## 3. 已知问题（preview.2 的范围）

| 项 | 状态 |
|---|---|
| **示例语料重跑** | 推迟到 **0.2**（用户 2026-11-17 指定）。`windup-frog` 的 verify 当前判 **blocked**（motion r028/r063 干涉、printability r042 最薄 0.028mm），其 README 仍写 difficult——以 verify 输出为准；`accept-verify` 对该示例的期望在 0.2 重跑后同步更新 |
| 第二几何内核 | 没有。CadQuery/FreeCAD 在目录里是 `planned`，不可选、不静默回退 |
| 后台 job | 只有 OpenSCAD 编译；渲染/仿真仍同步 |
| OpenSCAD 版本 | 2021.01 可跑但 `doctor` 报 degraded（Manifold 需要 2025.06+） |
| GitHub Actions | workflow 已写并在本地 `rehearse:preview` 等价通过，**尚未真实跑过**（首次打 tag 时验证） |
| 包体 | 12 MB 主要来自标准件 visual STL；fit/visual 分包是后续项 |
| `_UNVERIFIED` | 是提示，不是安全边界；改名不改变 manifest 判定 |
| 真实故障注入 | 断网/磁盘满的**分类与 state 落盘**已测；真实注入未跑 |

---

## 4. 发布前证据（本机，2026-11-17）

| 门禁 | 结果 |
|---|---|
| `npm run rehearse:preview` | **PASS**：build → accept:preview → pack → extract → setup → setup --check → doctor → 打包后的 verify-cli |
| tarball | 521 files / ~12 MB；含 LICENSE/NOTICE；无 `/home/` 路径、无 BOSL2/AppImage/node_modules/CadQuery 环境 |
| `doctor`（checkout） | `kind=degraded`，唯一非 pass 是 OpenSCAD 2021.01（已知边界），无 fail |
| 全量 accept | 172 脚本：171 绿 / 1 红（`accept-verify`），0 超时；7502 条 PASS。唯一的红随后按当前语料修正并**单独复跑通过**；提交后未再跑第二次全量 |
| 覆盖率 | `src/` 行 **89.0%**、函数 **83.0%**；工具边界 **39/39**（253 次调用） |
| 干净安装 smoke | rehearsal 内完成：解包 → setup → `--check` → doctor（非 fail）→ 打包后的 `dsh-cad-verify` 可跑 |

复跑：

```bash
cd dsh-cad-harness
npm run rehearse:preview
node scripts/coverage-tools.mjs --json coverage.json   # 需要 Python 运行时与 OpenSCAD
```

---

## 5. 下一版（0.2 / 0.1.1）

- **0.2**：示例语料重跑（windup 等）、第二个几何内核评估、渲染/仿真后台 job。
- **0.1.1**（如先发小版本）：面板视觉重做、更多端到端示例、`assembly.json` 修改门槛
  （见 `docs/dev/TODO.md` §1.3）。

---

## 6. 发布步骤（tag 之后）

1. `git tag -a v0.1.0-preview.2 -m "0.1.0-preview.2" && git push origin v0.1.0-preview.2`
   —— `v0.*` 触发 `.github/workflows/preview.yml`（ubuntu + macos，Node 22）：
   build → 核心 accept → `accept:preview` → pack → 干净解包 smoke → doctor → 上传 tarball。
2. 下载两个平台的 artifact，确认 `doctor` 非 fail、`verify-cli` 可跑；任一平台失败则不发。
3. GitHub Release 正文用本文件 §1–§3；资产为两个 tarball（当前未上 npm，`private: true`）。
4. tag 之后补两件只能现场做的事：GitHub Actions 实跑记录、真实断网/磁盘满注入。
