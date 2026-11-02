# 实验报告：在 examples/ 上跑 check_appearance（2026-11-01）

## 目标

拿真实语料试，找出工具在哪里会崩、哪些数不能读。**夹具只证明"能跑"，例子才能证明"跑得动"。**

## 结果

| 例子 | 零件 | 可见锐边 | 密度 | 平端面 | max/base | 判决 |
|---|---|---|---|---|---|---|
| multirotor-propeller | 4 | 1278 mm | 70.2 | 2 | 1.37 | check |
| windup-frog | 12 | 1117 mm | 58.8 | 3 | 1.00 | check |
| microscope2 | 17 | 7398 mm | 27.4 | 5 | 1.00 | check |
| microscope5 | 16 | 6005 mm | 29.8 | 5 | 1.00 | check |
| roberval（带 budget） | 13 | 8764 mm | 37.9 | 7 | 1.12 | **excluded** |
| toy-balance2 | 13 | 4882 mm | 68.9 | 12 | 1.18 | check |

## 撞墙与修复

**microscope2（17 件 / 686,730 三角面）第一跑超时被杀（120 s）。**

| 环节 | 修复前 | 修复后 |
|---|---|---|
| 剪影栅格化 | **30.2 s / 视角**（逐三角循环） | **0.49 s**（面积加权采样，60×） |
| 可见性射线 | 对合并场景（68.7 万面）投射 | 逐零件 + AABB 粗筛 |
| 射线总量 | 无上限 | 预算 6000，超出只测最长簇并把"少测几个"写进报告 |

microscope5：8.5 s。microscope2：正常完成。

## 三个观察

1. **没有预算的例子，判决永远是 `check`**。这是设计（没有声明阈值就不给结论），
   但意味着拿 examples 跑只能看数、不能看判决。只有 roberval 写了 `budget.json` 才判 `excluded`。
2. **`max/base` 在扁平物体上失真**：螺旋桨侧视 4.58。它薄，这个比值天然爆炸。
   "顶部不能比底座宽"这条规则必须排除近扁平的物体。
3. **零件多 ≠ 差**：microscope2 17 件密度 27.4（低），propeller 4 件密度 70.2（高）。
   大曲面稀释了单位表面的锐边，硬棱密集的小件反而高。

## 产物

- 六份报告：`.tmp/ex-{propeller,frog,m2,m5}.json`、`.tmp/app-rob-budget.json`、`.tmp/app-tb2.json`
- 修复：`python/cad_worker/worker.py`（`_app_mask_fast` / 逐零件可见性 / 射线预算）
