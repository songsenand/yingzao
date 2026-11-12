# 项目 schema 与迁移

> **原则：先备份，再迁移；未知的新版本一律拒绝，不猜。**
> 当前没有自动迁移器；本文定义"什么时候必须停下来"和"备份什么"。

## 支持的 schemaVersion

| 文件 | 当前支持 | 缺 `schemaVersion` 时 |
|---|---|---|
| `cad-data/project.json` | 1 | 视为 legacy，可用 |
| `assembly/assembly.json` | 1 | 视为 legacy，可用 |
| `claims.json` | 1 | 视为 legacy，可用 |
| `evidence-policy.json` | 1 | 视为 legacy，可用 |

`doctor --project <dir>` 会逐项检查：

- 版本相同 → `pass`；
- 没有 `schemaVersion` → `pass`（legacy）；
- 版本更旧 → `warn`，提示先备份；
- 版本更新 → `fail`，提示升级插件；
- 非法 JSON / 非整数版本 → `fail`。

## 迁移前必须备份

至少复制这些内容（不要只备份 `manifest.json`）：

```bash
ts=$(date +%Y%m%d-%H%M%S)
mkdir -p "migrations/$ts"
cp -a cad-data assembly claims.json evidence-policy.json "migrations/$ts/" 2>/dev/null || true
```

项目导出 ZIP 是另一种可读备份，但它**不是**迁移器：ZIP 里的 STL 不能替代版本库的
`sourceVersionIds`、datums 与 run 证据。

## 迁移的判定

1. 先跑 `npx dsh-cad-doctor --project <dir> --json`，确认是哪一项版本不匹配；
2. 若插件比项目旧：**升级插件**，不要用旧插件打开新项目；
3. 若插件比项目新：先备份，再按发布说明执行迁移；
4. 迁移后重跑 `doctor`，再跑 `npx dsh-cad-verify <dir> --advisory`；
5. 任何一步失败：恢复备份，不要"先改一点试试"。

## 现在没有的东西

- 没有自动迁移器，也没有 `schemaVersion` 的写回；
- 没有跨机迁移/合并；
- 没有"新 schema 向后兼容"的承诺。未知的新版本必须显式拒绝，这是 `doctor` 的
  `project-schema` / `assembly-schema` / `claims-schema` / `policy-schema` 检查。
