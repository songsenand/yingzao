# 实验报告：保形四面体（gmsh + scikit-fem）能不能给出停得住的表面 Kt

> 前一份报告（`experiments/20261019_fillet_kt_voxel_fem_probe.md`）查明：体素车道的
> "最大单元应力"对特征完全不敏感、线性外推跨分辨率偏 +17%，稳定的只有"固定物理距离读数"。
> 于是问题变成：**换一条保形边界的车道，能不能直接报出表面 Kt？**
> 本报告就是这条第三方库路线的探针。

## 目标

1. 用 gmsh（划体网格）+ scikit-fem（求解）对同一个带圆角台阶件做线弹性分析，
   **表面最大 von Mises / σ_nom** 是否随网格加密停住？
2. 与体素车道在**同一口径**（固定物理距离读数）下是否互证？
3. 引入这条车道的真实代价是什么（依赖、网格、几何、坑）？

## 假设

- H1：保形网格上表面应力有限且收敛（这正是体素阶梯做不到的）。
- H2：P1 四面体就够（对比：体素 hex8 在悬臂梁上 δ 差 0.2%，看起来"线性单元够用"）。

## 方法

- **试件与工况与体素车道逐字一致**（可比性的前提）：复用 `scripts/probe-fillet-kt.py` 的
  `fillet_profile`/`make_specimen`；r=0.8mm；D/d=2；E=3500MPa、ν=0.35；
  x=min 面全约束，x=max 面均匀面力 F=38.4N；σ_nom = F/(t·d) = 10MPa。
- **网格**：gmsh 4.15.2。两档网格（h 与 h/1.6），圆角附近加密。
- **单元阶次**：P1 与 P2 都跑（H2 的检验）。
- **独立对照**：同一剖面做 2D 平面应力 P2（同工况）。
- **链路自检**：矩形悬臂梁 30×2×2、末端 0.05N，与 `FL³/3EI`（及 Timoshenko）对比。
- 脚本：`dsh-cad-harness/scripts/probe-fillet-tet-kt.py`；
  输出 `dsh-cad-harness/.tmp-stress/probe-fillet-tet-kt.json`。

## 结果

**① 表面 Kt 停住了（P2）**

| 网格 | 四面体 | 自由度 | 求解 | Kt_表面 |
|---|---|---|---|---|
| h | 10 917 | 55 269 | 7.8 s | **1.8168** |
| h/1.6 | 39 975 | 187 449 | 151.5 s | **1.8157** |

跨分辨率 **−0.06%** ⇒ 收敛值 ≈ **1.816**。热点在 `(0.58, ±1.63, z≈0)`：
圆角与窄端相切处、板厚中面——物理正确（不是加载端，也不是网格伪影）。

**② H2 被推翻：P1 还在动**

| 单元 | Kt (h) | Kt (h/1.6) | 变化 |
|---|---|---|---|
| P1 | 1.7351 | 1.7997 | **+3.7%** |
| P2 | 1.8168 | 1.8157 | −0.06% |

"表面 Kt 停住"靠的是**二次场**，不是单纯加密。四次求解的载荷/反力都是 38.40/38.40 N。

**③ 独立对照与手册自洽**

- 2D 平面应力 P2（同一剖面）：1.7372 → 1.7393（+0.12%）。
- 3D 比平面应力高 **4.4%**——薄板中面接近平面应变的已知效应，方向与量级都对。
- 与手册量级自洽（台阶扁板受拉 D/d=2、r/d≈0.25 约 1.7）。**注意：该手册值由探针执行者
  转述，本项目尚未取到可引用的表页**，与前面"绝对精度未验证"是同一条待办。

**④ 与体素车道互证（同一 STL）**

| 口径 | 体素 (dx=0.1, 61 728 格) | 保形 P2 | 差 |
|---|---|---|---|
| **d_c=0.2mm 读数** | 1.1772 | 1.1559 | **1.8%** |
| 边界/表面最大值 | 2.2196（发散量，不可用） | 1.816（收敛） | — |

两条**方法完全独立**的车道在"固定物理距离读数"上差 1.8% ⇒ 该口径可信；
而体素车道的边界最大值比真值高 22%，再次确认它不可用。

**⑤ 链路自检**：悬臂梁 δ_FEM 0.096089 / 0.096130 vs 梁理论 0.096429
（−0.35% / −0.31%；对 Timoshenko −0.71% / −0.67%）⇒ gmsh+scikit-fem 链路本身没搭错。

## 分析

1. **保形四面体是唯一能报出"停住的表面 Kt"的路线**（1.816，跨分辨率 −0.06%）。
   它同时消掉了阶梯伪影**和**整套外推估计子问题——因为表面应力本身就是有限且收敛的。
2. **但它不是体素车道的替代品**：要 P2 才停得住（自由度 5.5 万 → 18.7 万，151 s），
   而 2D 平面应力只要 1.07 万自由度就给到 1.739——**最快的入口其实是 2D**（适用于等厚板状件）。
3. **体素车道的位置因此更清楚了**：它负责积分量、全局位移、以及 d_c 口径的读数（与保形
   车道差 1.8%），代价低到秒级；保形车道负责"表面 Kt"这一个量，代价是分钟级 + 真几何。

## 遇到的问题（复现时最值钱的一节）

1. **共享 pinned 运行时装不进 gmsh**：`.tmp-cad-runtime/venv` 是指向**只读**的
   `~/.dsh/cad/runtime/venv` 的符号链，`pip install gmsh` 直接 `Errno 30 (Read-only file system)`。
   本次用 `pip install --no-deps --target .tmp-stress/py-gmsh` + 脚本 `sys.path` 前置绕过；
   要真正发布，必须把 gmsh **烘进只读运行时镜像**。
2. **`--target` 不解 wheel 的 `.data`**：`libgmsh.so.4.15`（92.6 MB）不会被铺开，
   装完只有 17 MB、`import` 报 undefined symbol ⇒ 需手动解压 `.data/data/lib/`。
3. **网络**：pypi 直连 40 MB >10 min 未完成；阿里云镜像 13 MB/s（3.0 s）。
4. **STL 进 gmsh 的四个坑**（由探针执行者实测）：
   ① `merge(stl)` + `generate(3)` **静默返回 0 个四面体**（不报错）；
   ② 必须 `removeDuplicateNodes` → `classifySurfaces(40°, True, True, 180°)` → `createGeometry`
      再 `addSurfaceLoop`/`addVolume`；直接对 merge 出来的曲面 `addVolume` 报 Unknown surface loop；
   ③ 离散几何的弧面被冻结，只能全局尺寸 + 体积 Box 场；0.1mm 局部场配 STL 的 0.05mm 弧弦会生成
      minSICN 0.014 的片状单元（gmsh 警告 ill-shaped tet），Kt=1.8594 偏高 2.4%
      （STL 几何本身没问题：弧面节点半径误差中位数 0.0003mm）；
   ④ OCC 路线会留 2 个孤立节点，不删就是刚度矩阵零行 → `Matrix is exactly singular` + 全 NaN。
5. **归一化口径**：早先报告里"改成 0.3mm 后 Kt≈1.375"是拿**实测远端应力**（7.97MPa）当分母，
   与表里其它 Kt（一律用 σ_nom=10MPa）不同源。按 σ_nom 口径应为 **1.0966**（0.3mm）、
   **1.1772**（0.2mm）。已在前一份报告里更正。

## 产物列表

**代码与脚本：**
- `dsh-cad-harness/scripts/probe-fillet-tet-kt.py` —— 本探针（含 STL→gmsh 的正确调用序列）

**数据：**
- `dsh-cad-harness/.tmp-stress/probe-fillet-tet-kt.json` —— 网格统计/各求解的 Kt/自检结果
- 临时装的 gmsh：`dsh-cad-harness/.tmp-stress/py-gmsh`（gitignore 区，**不入库**）

**运行命令（含运行时限制的绕法）：**
```bash
cd dsh-cad-harness
P=.tmp-cad-runtime/venv/bin/python
# 共享运行时只读 ⇒ 只能装到临时目录（发布需烘进镜像）
$P -m pip install --no-deps --target .tmp-stress/py-gmsh gmsh -i https://mirrors.aliyun.com/pypi/simple/
# --target 不铺 .data ⇒ 手动解出 libgmsh.so
( cd .tmp-stress/py-gmsh && unzip -o gmsh-*.whl 'gmsh-*.data/data/lib/*' -d . )
PYTHONPATH=.tmp-stress/py-gmsh $P scripts/probe-fillet-tet-kt.py
```

**环境依赖：** gmsh 4.15.2（wheel 40.0 MB，实占 106 MB，metadata 无 Requires-Dist）；
scikit-fem 12.0.2 / scipy 1.18.1 / numpy 2.5.3 / trimesh 5.1.1 / shapely 2.2.0（均为既有 pin，
装 gmsh 前后版本逐项一致，未被替换）。

## 结论与下一步

**结论：** 保形四面体路线**能**给出停得住的表面 Kt（P2，1.816，跨分辨率 −0.06%），并与体素
车道在固定物理距离口径上互证到 1.8%。但它是**第二条（慢）车道**，不替代体素车道：
需要 P2（1.07 万 → 18.7 万自由度、151 s）、需要真几何（只有 STL 时弧面冻结、多付约 2.4%）、
且需要一个 **106 MB 的 pinned 依赖烘进只读运行时镜像**。

**下一步（待拍板）：**
1. **2D 平面应力子车道**（等厚板状件：1.07 万自由度、秒级给出 1.739）——成本最低、收益最直接；
2. **3D 保形 + 子模型**（热点邻域几毫米的盒子，Dirichlet 取自体素全局解）——避开整件分钟级代价；
3. **是否把 gmsh pin 进运行时**：这是方向性决策（+106 MB 镜像、平台 wheel 覆盖、供给成本），
   按规范须先立 DECISION-LOG。
