# 名字：营造（Yingzao）

> **品牌层可以改，契约层不能混。**
> 本文是“哪个名字能改、哪个不能”的唯一索引；改名前先看这里。

## 四层名字

| 层 | 当前值 | 谁在用 | 能不能改 |
|---|---|---|---|
| 品牌 / 项目名 | **营造（Yingzao）** | README、文档、Release、GitHub 仓库 | 可以；对外统一用这个 |
| npm 包名 | `dsh-cad-harness` | `dsh plugin add`、profile 依赖、tarball | 发布后很贵；preview 内先冻结 |
| DSH 插件 id | `cad-harness-host` | `cordis.patch.yml`、profile 配置 | 基本不改；改了等于换插件 |
| preset id | `cad` | 会话、工具过滤、预设行 | 不改；显示名可以改 |
| preset 显示名 | `营造模式` | 人看到的 UI / 文档 | 可以改；只影响显示 |
| CLI | `dsh-cad-setup/doctor/backend/verify/clean` | 脚本、文档、用户肌肉记忆 | 发布后加别名，不硬切 |
| 数据目录 | `cad-data/`、`$DSH_HOME/cad/` | 已有项目、配置、审计 | 不静默改；要迁移就带备份 |
| HTTP 路径 | `/api/cad/*` | 面板、脚本 | 发布后不改；内部实现可换 |

## 英文写法

- 专名用拼音：**Yingzao**，不要翻译成 `Construction` / `Build`。
- 第一次出现写全：**营造（Yingzao）**。
- 一句话定位：**营造 — 从零件到装配的可验证 CAD 工作台**。
- 不要写 `Yingzao Construction`：会把范围窄化成建筑，和机械零件/装配冲突。

## GitHub 仓库名

GitHub 仓库名**不需要**和包名或插件 id 一致：

```text
GitHub:      yingzao-cad
npm package: dsh-cad-harness
plugin id:   cad-harness-host
```

`dsh plugin add -w /path/to/dsh-cad-harness` 看的是本地路径和 `package.json`，不是仓库名。
GitHub 改名后旧 URL 会重定向，但 release 资产、CI badge、文档硬编码链接要一起更新。

## 历史名

`ToyMarker` 是项目出身名，保留在：

- Git 历史；
- `docs/DECISION-LOG.md` 的历史条目；
- `docs/archive/`、`experiments/`、历史评测分数；
- `HARNESS.md` 的“前身 ToyMarker”一句。

**不回改历史记录。** 当前用户文档、README、preset 显示名统一用“营造”。

## 改名的顺序

1. 品牌层：README / docs / Release / GitHub 仓库名；
2. 预设显示名：`presets/cad/preset.yml` → `preset.patch.yml`；
3. 回归：`npm run accept:preview` + `npm run rehearse:preview`；
4. 包名/插件 id 要改，另开一次决策，先做迁移与别名，不在品牌改名里顺手做。
