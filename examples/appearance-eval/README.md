# 外观评估夹具（P1–P4）

四个小项目，用来估 `check_appearance` 的能力**边界**：不是演示它能做什么，
而是找它**看不到什么**。每个项目故意埋一个缺陷，预期有些会被抓、有些不会。

运行（不在根目录跑，夹具自带 `cad-data`）：

```bash
DSH_CAD_PYTHON_ROOT=<runtime> node dsh-cad-harness/scripts/smoke-check-appearance.mjs \
  examples/appearance-eval/p1-stool assembly/assembly.json /tmp/p1.json assembly/budget.json
```

| 项目 | 零件 | 埋的缺陷 | 预期 |
|---|---|---|---|
| `p1-stool` | 5 | 三根方腿 + **一根圆腿** | 锐边会报；对称扫描在 135° 报失配 18000 mm² |
| `p2-shelf` | 3 | 右托架**比左托低 10 mm**（板子悬空） | 对称扫描在 60° 报失配 5500 mm² |
| `p3-lamp` | 3 | 总高 440 / 罩径 140，**远超包络 380** | **包络会报**（对照组） |
| `p4-stool-fixed` | 5 | 无（P1 的修好版：圆角 + 收分 + 四腿同形） | 锐边应显著下降 |

结果见 `experiments/20261101_appearance_eval.md`。
