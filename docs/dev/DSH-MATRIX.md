# DSH 版本矩阵（本地）

最后完整运行：**2026-11-25** · Linux x64 · `node:22-bookworm` · kern 0.56.0 · 插件 `0.1.1-preview.1`

> **0.1.2-preview.1 的状态（2026-11-25）**：预设与 `doctor` 的 `preset-standard-drift` 已通过；
> **13 版全矩阵尚未用 0.1.2-preview.1 重跑**——当前开发沙箱无法启动 kern（无 systemd 用户总线），
> 需在普通终端重跑或等 tag CI。下表是 0.1.1-preview.1 的实测；引擎与预设机制未变，但
> **不要把它当作 0.1.2-preview.1 的证据**。重跑后把首行的插件版本与下表一起更新。

支持范围以 `dsh-cad-harness/package.json` 的 `engines.dsh` 为准：`>=0.2.1-rc.2 <0.3.0`。
DSH 的插件管理器用 `semver.satisfies(..., { includePrerelease: true })` 判定，因此 0.2.x 中满足该范围的共 **13 个版本**；本表覆盖全部 13 个。
最近一次完整运行：**12 PASS + 1 BLOCKED，整体 exit 0**（约 13 分钟，版本卷已预热）。

## 结果

| DSH 版本 | 结果 | 备注 |
|---|---|---|
| 0.2.1-rc.2 | PASS | 声明下界 |
| 0.2.1-rc.3 | PASS | |
| 0.2.1-rc.4 | PASS | |
| 0.2.1-rc.5 | PASS | |
| 0.2.2-rc.1 | PASS | 当前 checked-in preset 的来源版本 |
| 0.2.2-rc.2 | PASS | |
| 0.2.2-rc.3 | PASS | |
| 0.2.2-rc.4 | PASS | |
| 0.2.2-rc.5 | PASS | 当前最新 |
| 0.2.2-alpha.2 | PASS | |
| 0.2.2-alpha.3 | PASS | |
| 0.2.3-alpha.1 | **BLOCKED（上游）** | `dsh --version` 本身失败，见下 |
| 0.2.3-alpha.2 | PASS | |

PASS 表示以下 9 项全部通过：

```text
binary     dsh --version 等于目标版本
engines    目标版本满足 >=0.2.1-rc.2 <0.3.0（includePrerelease）
setup      用该版本自带的 standard.patch.yml 重跑 dsh-cad-setup
compose    dsh --profile matrix --dump-config 含 3 个插件标记
boot       headless 一轮完成，返回 mock 文本
tools      模型请求里出现 9 个 CAD 工具面
tool-call  mock 触发 cad_session{action:"info"}
tool-result 工具返回 completed 且带 kernel
tool-final 第二次模型请求返回 tool-ok
```

## 0.2.3-alpha.1 为什么不算插件失败

该版本安装后连 `dsh --version` 都起不来：

```text
SyntaxError: The requested module '@deepseek-ai/cordis-plugin-loader'
does not provide an export named 'EntryValidationError'
```

0.2.3-alpha.1 的 `dsh-app-boot` 需要 `EntryValidationError`，但它自己解析到的是
`@deepseek-ai/cordis-plugin-loader@1.1.0`；下一版 `0.2.3-alpha.2` 改用 `1.2.0-alpha.1`，
恢复正常。这是上游发布包的依赖范围问题，发生在插件加载之前，不能归因于插件。
矩阵保留该行并标为 BLOCKED，不做“已支持”的推断。`dsh-matrix.json` 的 `knownBlocked`
记录了这个版本和原因；runner 仍会跑它，但把这一行算作已知上游阻塞，不让整轮 exit 1。

## 未覆盖

- **T3 安装路径**：矩阵用 profile `link:` 加载插件，没有跑 `dsh plugin add` 从 tarball 安装。
- **T4 真实 CAD 验收**：没有跑 OpenSCAD/Python 的几何、装配、运动验收。
- **T5 Web 客户端**：headless 不加载 `lib/client.js`，Web UI 的 client 模块未验证。
- **范围外版本**：`0.2.0-rc.1/2`、`0.2.1-alpha.1–5`、`0.2.1-rc.1` 共 8 个，低于
  `engines.dsh` 下界，不测试，也不承诺。`0.3.0+` 同理。
- **Windows/macOS**：矩阵只覆盖 Linux x64；原生平台由 CI 负责。

## 复现

```bash
cd dsh-cad-harness
node scripts/accept-dsh-matrix.mjs --versions \
  0.2.1-rc.2,0.2.1-rc.3,0.2.1-rc.4,0.2.1-rc.5,\
0.2.2-rc.1,0.2.2-rc.2,0.2.2-rc.3,0.2.2-rc.4,0.2.2-rc.5,\
0.2.2-alpha.2,0.2.2-alpha.3,0.2.3-alpha.1,0.2.3-alpha.2
```

首次运行会把每个版本装进命名卷，单版约 1.2 GB；之后每版约 61–62 秒。完整 13 版约
11 GB。结果写到 `verification/dsh-matrix/`（已 gitignore）。

## 结论

- **rc 线 9/9 通过**：`0.2.1-rc.2` 到 `0.2.2-rc.5` 的每个 rc 都能安装、组合、激活、
  注册 9 个 CAD 工具面并执行一次工具调用。这是 README 支持承诺的主体。
- **alpha 3/4 通过**：alpha 属于预发布，不进入 support 承诺；`0.2.3-alpha.1` 的上游
  启动失败已单独记录。
- 兼容性结论只覆盖 T0–T2；安装路径、真实几何验收和 Web 客户端仍需 CI 或单独测试。
