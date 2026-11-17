# 实验报告：安装时生成 STEP/STL 的可行性

## 目标

验证“标准件库不在安装包里预置 STEP/STL，而是在安装时用 CadQuery 生成”是否可行：

1. 单件生成/导出 STEP + STL 要多久；
2. 300 / 600 件安装时生成要多久；
3. 生成出来的 STEP+STL 压缩包有多大；
4. 相比预生成分发包，安装时生成是否真的减轻分发压力。

## 假设

- 生成时间可能是主要障碍，尤其是螺纹、轴承、弹簧；
- 安装时生成可以省掉 STEP/STL 的下载体积；
- 如果生成足够快，可以只分发参数表 + 生成脚本。

## 方法

- 机器：AMD Ryzen 7 8845HS，16 线程；单线程跑；
- Python 3.13.16；CadQuery 2.8.0；OCP 7.9.3.1.1；
- CadQuery 通过阿里云 PyPI 镜像安装到临时目录（清华源没有 `cadquery`，USTC 的 OCP 大包 403）；
- 单件基准：9 个代表件，先 warm-up，再重复 3 次取中位数；
- 批量基准：300 个合成件，覆盖 5 个家族（螺栓/螺母/垫圈、轴承、O 圈、弹簧、键/销）；两档：
  - `fit_300`：全部简化 LOD；
  - `mixed_300`：轴承和弹簧全部 visual LOD（最坏情况，非真实混合比例）；
- STEP 和 STL 从同一个 B-rep 导出；STL 公差 `0.05 mm` / `0.3 rad`；
- 压缩包用 ZIP deflate level 6，包含 STEP+STL；
- 计时包含 build + export + zip，不含 Python import；import 单独计时。

## 结果

### 冷启动

| 项 | 数值 |
|---|---|
| `import cadquery` | 1.41 s |
| 300 件 fit 冷启动总时长（import + 生成 + 导出 + zip） | ≈ 4.0 s |
| 300 件 mixed 冷启动总时长 | ≈ 35.7 s |
| 峰值 RSS（单件基准） | 639 MB |
| 峰值 RSS（300 件 mixed） | 678 MB |

### 单件（中位数）

| 零件 | build ms | STEP ms | STL ms | STEP KB | STL KB |
|---|---:|---:|---:|---:|---:|
| M16×60 六角螺栓 fit | 7.1 | 1.5 | 0.9 | 27.6 | 9.5 |
| M16 六角螺母 fit | 6.1 | 1.4 | 0.9 | 27.4 | 9.7 |
| M16 平垫圈 fit | 2.2 | 0.9 | 1.1 | 9.6 | 16.9 |
| 14×9×70 平键 fit | 0.9 | 0.9 | 0.4 | 15.5 | 0.7 |
| Ø10×40 圆柱销 fit | 3.1 | 0.7 | 0.8 | 8.3 | 12.5 |
| 6005 轴承 fit | 9.0 | 1.3 | 1.3 | 20.9 | 33.7 |
| 6005 轴承 visual | 291.8 | 12.5 | 6.4 | 524 | 376 |
| O 圈 50×3 fit | 0.4 | 0.6 | 15.5 | 4.1 | 176 |
| 压缩弹簧 2×20×50 visual | 30.0 | 3.0 | 476.4 | 124 | 1899 |

螺纹螺栓的 helical proxy 在 STL 导出阶段失败（几何自交/导出器不写文件），**未计入**；真实螺纹只会更重，这支持“默认不建螺纹”的 LOD 策略。

### 300 件批量

| 场景 | wall s | build s | STEP s | STL s | 原始 MB | ZIP MB | ZIP 比 | RSS MB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| fit_300 | 2.63 | 1.11 | 0.30 | 1.22 | 17.8 | **3.7** | 0.207 | 595 |
| mixed_300（轴承/弹簧 visual） | 34.32 | 9.27 | 0.68 | 24.37 | 140.8 | **56.1** | 0.399 | 678 |

按线性外推：

| 场景 | 600 件生成时间 | 600 件 ZIP |
|---|---:|---:|
| fit | ≈ 5.3 s + 1.4 s import | ≈ 7.4 MB |
| mixed | ≈ 68.6 s + 1.4 s import | ≈ 112 MB |

### 安装体积

| 项 | 体积 |
|---|---:|
| 完整 CadQuery 2.8.0 + 依赖（临时 target） | **1.7 GB** |
| 其中 OCP | 163 MB + 101 MB libs |
| 其中 vtkmodules | 638 MB |
| 其中 casadi | 275 MB |
| 其中 llvmlite | 172 MB |
| 其中 scipy | 81 MB |
| 300 件 fit STEP+STL ZIP | **3.7 MB** |
| 300 件 mixed STEP+STL ZIP | **56.1 MB** |

## 分析

1. **时间不是主要障碍。** 在这台机器上，300 件 fit 冷启动约 4 秒；600 件 fit 约 7 秒。即使最坏情况把轴承/弹簧都做成 visual，300 件也只要 36 秒。安装时生成在时间上是可行的。
2. **分发体积才是障碍。** 为了生成，需要把 CadQuery/OCP 装到用户机器上：完整安装 1.7 GB，即使只算 OCP 也约 264 MB。相比之下，300 件 fit 的 STEP+STL 压缩包只有 **3.7 MB**。安装时生成不是“减轻分发”，而是把 3.7 MB 的包换成 264 MB–1.7 GB 的 CAD 内核。
3. **visual LOD 才是体积/时间大头。** 轴承 visual 单件 STEP 524 KB、STL 376 KB、build 292 ms；弹簧 visual STL 1.9 MB、导出 476 ms。fit 包 3.7 MB，mixed 包 56.1 MB，差 15 倍。
4. **内存也不能忽略。** 单进程峰值约 0.6–0.7 GB；低内存安装环境/容器需要额外考虑。16 核并行会更快，但 OCP 每进程 600 MB，不能简单开满。
5. **如果 OCP 已经在运行时里**，安装时补齐缺失尺寸是合理的：fit 300 约 4 秒，成本很低；但这属于“按需生成/缓存”，不是“安装时生成全部”。

## 建议

**默认：发布时预生成，安装时只解压。**

- 分发一个 content-addressed 的 fit 包（300 件约 3.7 MB，600 件约 7.4 MB），包含 STEP+STL+`part.json`+hash；
- 可选 visual 包（300 件约 56 MB），只在需要渲染/打印时下载；
- 安装只校验 hash、解压、写 `library.lock`，不装 CAD 内核。

**例外：OCP 已存在时，按需生成缺失尺寸。**

- 不放在安装主流程；
- 只生成 fit LOD；
- 后台任务、进度、缓存、失败回退到“未安装该尺寸”；
- 不在安装时生成 visual/螺纹。

**不推荐：为了省 3.7 MB 安装 1.7 GB CadQuery。** 除非插件本来就因为其他功能需要 OCP，否则安装时生成会让分发包显著变大，还会引入平台 wheel、许可证、确定性、几何失败等风险。

## 遇到的问题

- 清华源没有 `cadquery`（`versions: none`）；USTC 的 `cadquery-ocp` 大包被重定向到清华的 403；最终用阿里云源 + `uv` 安装。
- 完整 CadQuery 安装 1.7 GB，远大于预生成包；这是本次实验最重要的发现。
- 螺纹代理导出失败，说明“默认建螺纹”不仅慢，而且脆弱。
- 批量为合成尺寸、简化几何；不是 30 个家族的完整标准件，也不是尺寸合规性验证。
- 单线程测量；未测多进程并行（内存代价高）。

## 产物列表

**脚本：**

- `experiments/scripts/20261117_bench_cadquery_parts.py` — 9 个代表件单件基准
- `experiments/scripts/20261117_bench_cadquery_batch.py` — 300 件 fit/mixed 批量基准

**数据：**

- `experiments/artifacts/20261117_install_time_bench/results_parts.json` — 单件原始结果
- `experiments/artifacts/20261117_install_time_bench/results_batch.log` — 300 件批量结果

**运行命令：**

```bash
# 安装（阿里云源；临时目录，不进仓库）
uv pip install --target .tmp-cadquery \
  --index-url https://mirrors.aliyun.com/pypi/simple cadquery

PYTHONPATH=$PWD/.tmp-cadquery \
  /home/songsenand/.dsh/cad/runtime/venv/bin/python \
  experiments/scripts/20261117_bench_cadquery_parts.py

PYTHONPATH=$PWD/.tmp-cadquery \
  /home/songsenand/.dsh/cad/runtime/venv/bin/python \
  experiments/scripts/20261117_bench_cadquery_batch.py
```

**环境依赖：**

- Python 3.13.16
- CadQuery 2.8.0 / OCP 7.9.3.1.1
- 16 线程 CPU；单线程测量
- 约 1.7 GB 临时安装空间，峰值内存约 0.7 GB

## 结论与下一步

安装时生成在**时间**上可行，但在**分发体积**上不划算：fit 预生成包只有 3.7 MB/300 件，而生成器需要 264 MB–1.7 GB。建议先做预生成 fit 包；只有确认运行时已经带 OCP 时，才把“按需生成缺失尺寸”作为后台能力。

下一步如果要继续，应先做 **P0 的 3 个家族 + 预生成 fit 包**，而不是先做安装时生成器。
