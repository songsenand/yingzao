# bpy 成本探针：可复现产物

对应报告：[`experiments/20261024_blender_bpy_integration_cost.md`](../20261024_blender_bpy_integration_cost.md)

## 环境

- Linux x64，16 核 / 30 GB；Arch Linux
- 插件运行时 CPython **3.13.16**（`$DSH_HOME/cad/runtime`）
- bpy **5.2.3**（`cp313-cp313-manylinux_2_28_x86_64.whl`，402,843,256 B）
- 对照：系统 Blender **5.2.3 LTS**（`/usr/bin/blender`）

## 一键复现

```bash
# 1) 独立 venv（不要装进 $DSH_HOME/cad/runtime/venv，那是用户运行时）
#    bpy 5.2.3 要求 CPython ==3.13.*；本机系统 python3 是 3.14，直接用会装不上。
PY=${DSH_HOME:-$HOME/.dsh}/cad/runtime/venv/bin/python
"$PY" -m venv .tmp-bpy/venv
. .tmp-bpy/venv/bin/activate

# 2) 装 bpy。阿里云镜像实测 13.3 MB/s（12.7 MiB/s）；PyPI 直连在本机曾停滞。
pip install --index-url https://mirrors.aliyun.com/pypi/simple bpy==5.2.3

# 3) 量 import 成本
python experiments/20261024_blender_bpy_cost/measure.py \
  python experiments/20261024_blender_bpy_cost/import_bpy.py

# 4) bpy 形态：4 视图 Workbench / 4 视图 Cycles / 1 张材质 hero
S=examples/microscope4/cad-data/runs/r024/parts/整机.stl
A=experiments/20261024_blender_bpy_cost
python $A/measure.py python $A/render_views.py -- $S $A/out/bpy-wb BLENDER_WORKBENCH 1024 32 views
python $A/measure.py python $A/render_views.py -- $S $A/out/bpy-cy CYCLES 512 32 views
python $A/measure.py python $A/render_views.py -- $S $A/out/bpy-art CYCLES 1024 64 art

# 5) CLI 形态：同一脚本、同一参数
python $A/measure.py blender -b --factory-startup -noaudio -P $A/render_views.py -- \
  $S $A/out/cli-wb BLENDER_WORKBENCH 1024 32 views
python $A/measure.py blender -b --factory-startup -noaudio -P $A/render_views.py -- \
  $S $A/out/cli-art CYCLES 1024 64 art

# 6) 常驻 worker 的基线内存（Linux /proc）
python $A/worker_rss.py
```

`measure.py` 报的是子进程 **峰值 RSS**（`resource.getrusage(RUSAGE_CHILDREN)`），不是均值；Wall 含解释器/Blender 启动。

## 文件

| 文件 | 作用 |
|---|---|
| `render_views.py` | 同一份渲染脚本，`python render_views.py -- …` 与 `blender -b -P render_views.py -- …` 都能跑；`views` 出四视图，`art` 出材质 hero |
| `measure.py` | 跑命令并报 wall + 子进程峰值 RSS（Linux） |
| `import_bpy.py` | 只测 `import bpy` |
| `worker_rss.py` | 测 `python/cad_worker/worker.py` 的 hello/ ping 前后 RSS |
| `bpy-stdout-sample.txt` / `bpy-stderr-sample.txt` | bpy 渲染时 stdout / stderr 分流证据（stdout 有 `Saved:`/`Timer`，stderr 有 headless MESA 报错） |
| `results.json` | 本报告引用的数字 |
| `images/workbench-1024-iso.png` | bpy Workbench 1024 轴测 |
| `images/cycles-512-iso.png` | bpy Cycles 512/32 轴测 |
| `images/art-1024-iso.png` | bpy Cycles 1024/64 材质 hero |
| `images/cli-art-1024-iso.png` | CLI 同场景对照（与 bpy 版肉眼无差） |

## 注意事项

- STL 没有单位。项目按 mm 建模，Blender 把数值当 m；`art` 模式因此把物体缩到 0.001 并按米制布光。不缩放会把灯功率算到兆瓦级（第一版实测过曝）。
- `blender -b -P script.py -- args` 的 `sys.argv` 含 Blender 自己的参数；脚本必须取 `--` 之后的部分。模块形态 `python script.py -- args` 同理。
- headless EEVEE 在本机走软件 GL：512px 单帧 11.7s（user 71s），不适合 CI；Workbench 与 Cycles CPU 正常。
- 不要在常驻 worker 里 `import bpy`：它把 `Saved:`/`Timer` 写到 stdout，而 worker 的 stdout 是 JSON-lines 协议；且 +400 MB RSS。
