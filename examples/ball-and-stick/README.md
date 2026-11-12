# 球棍模型（ball-and-stick）

每个分子一个子目录，**各自是一个独立的 CAD 项目**：会话 cwd 指向子目录，语料根就是该子目录下的 `cad-data/`。

```
examples/ball-and-stick/
├── README.md                 ← 本文件（只是容器，不放语料）
├── glucose-molecule/         ← β-D-吡喃葡萄糖（24 球 + 24 棍）
│   ├── cad-data/             ← 版本库与运行记录（被 .gitignore 忽略）
│   ├── assembly/             ← 装配清单
│   ├── spec/                 ← 分子几何、SCAD 生成、公差
│   ├── scripts/              ← 语料迁移等一次性脚本
│   ├── BUILD.md              ← 逐次工具与数字
│   └── README.md             ← 打印与装配说明
└── fructose-molecule/        ← 果糖（39 零件 / 41 版，2026-10-28）
```

## 怎么开一个分子

```bash
cd examples/ball-and-stick/glucose-molecule
# 新建「营造模式」会话，cwd 指向这个目录
```

面板的工作目录下拉是**只读浏览**：从 `examples/` 或 `examples/ball-and-stick/` 开会话时，它能列出深度 ≤2 的语料，`glucose-molecule` 和将来的 `fructose-molecule` 会并排出现。但**写入永远落在会话 cwd 的 `cad-data/`**——所以真正画分子时，会话 cwd 要指向具体的分子目录，不要停在容器目录。

## 为什么一个分子一个项目

- 每个分子有自己的版本号、运行记录、装配清单和接口；混在一个 `cad-data/` 里会互相污染（版本号、run 的 `sourceVersionIds`、manifest 的节点都按项目解析）。
- 独立项目可以直接把整个子目录拷走/归档，不影响别的分子。
- 父目录只做容器，**不要**在 `examples/ball-and-stick/` 下建 `cad-data/` 或 `assembly/`。

## 迁移记录

2026-10-28：`examples/glucose-molecule/` 整体移到 `examples/ball-and-stick/glucose-molecule/`。仓库根的 `cad-data` / `assembly` 临时符号链接已在收尾时清理；请用 cwd 指向具体分子目录（或 `?project=`）查看。`examples/ball-and-stick/glucose-molecule/BUILD.md`、`README.md`、`scripts/migrate_corpus.py` 以及非历史的计划文档已更新路径。

历史记录（`docs/DECISION-LOG.md` 的旧条目）仍写旧路径，这是 append-only 的历史，不回改；读到时按上面的新位置理解。迁移前的 run 记录里 `manifestPath` 也仍是旧绝对路径——那是历史证据，不回写；新会话的 run 会用新路径。
