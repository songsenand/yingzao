# attention-contact-corner

一个用于验证“接触面上的锐角能否被正确引导注意力”的测试夹具。

- `v-notch.scad` —— 80×40×40 方块，底面切出 37° V 形缺口；缺口根部在 `(40,20,30)`，两个底面脚接触地面。
- `l-bracket.scad` —— 80×40×10 base + 10×40×80 立墙；内凹直角在 `(10,20,10)`，底面接触地面。

`cad-data/` 是生成语料，已 gitignore；用 `generate_part` 从这两个 `.scad` 重新生成即可。

## 结果摘要（2026-10-29）

- **37° V 缺口**：`scan_attention` 默认阈值 100° 正确报出根部 `(40,20,30)`，二面角 143°、void 37°、`likely-defect`。
- **90° L 形角**：`scan_attention` 默认阈值 100° **不报**（只有 `concaveMinDeg:80` 才报 `(10,20,10)`，90°/void 90°/material 270°）。这是阈值设计，不是漏检；要覆盖直角就显式传 80。
- **自重 + 地面**：`simulate_stress` 跑通，`loadCase=gravity`；V 缺口件总重 1.403 N，应力峰值落在**接触/缺口开口边缘**，缺口根部只有 0.0002 MPa（开口约 0.0008 MPa）。根部不是自重下的应力热点；但应力工具仍用 `geometry-suspects` 层把根部交出来。
- **纯自重悬臂**：固定 x-min、**不加外载**，只开自重；应力峰值沿缺口根部 `(39,3..33,27..29)`，最高 0.019 MPa；`geometry-suspects` 同时在 `(40,20,30)`。**只靠重力就能指向 V 缺口根部。**
- **弯载**：固定 x-min、在 x-max 加 −10 N 下压后，应力峰值沿缺口根部，最高 0.462 MPa；`geometry-suspects` 同时在 `(40,20,30)`。这时应力与几何两个问题在根部**相互呼应**。
- **融合图**：`analyze` 在 V 缺口件上只有一个峰 `(40,20,30)`（risk 1，layer `reentrant-corner`），没有被壁厚/悬垂事实淹没。90° L 形因默认阈值 100° 不进 `analyze`；要覆盖直角需在 `scan_attention` 显式传 80。
- **融合 strength**：`analyze(stressRunId:"r010", cellMm:16)` 的顶部峰 `(40,20,30)` 变为 `risk 1 / count 2 / layers [reentrant-corner, strength-concentration]`；绝对 `strength` 层因 0.019 MPa 远低于 10 MPa warn 线而静默，相对集中层以 0.5 指路。

完整实验记录：`experiments/20261029_contact_corner_attention.md`。
