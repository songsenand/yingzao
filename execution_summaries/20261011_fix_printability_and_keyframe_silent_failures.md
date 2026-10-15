# 执行摘要：修 check_printability 的静默失效、keyframe 旋转丢失，以及两项偏置估计

## 动机

在给 `examples/multirotor-propeller/` 写 README 时，把"工具侧"观察记进了 README §8。
用户要求回插件源码复核这 5 条并提出修改建议；复核过程中又查出**第 6 条、也是最严重的一条**：
本机插件的 Python 运行时与**当前锁不一致**（标记 `requirementsSha=08b72cc0…`，当前锁 `a21baffa…`，说明这个 venv 不是按当前锁装的）且缺 `rtree`/`shapely`；就绪判据只看标记文件、从不验证 import，于是 `status` 报 `ready`，而 `check_printability` 的**壁厚半边整体失效、报告仍然干净**。
用户批复"开工"，本摘要即执行前的记录。

## 影响范围

- `dsh-cad-harness/python/cad_worker/worker.py`：`op_check_printability`（唯一的 printability 实现，
  `src/host/tools.ts:3290 → inspect.ts:175 → worker.request('check_printability')`）
- `dsh-cad-harness/src/host/inspect.ts`：`checkPrintabilityInTs`（parity oracle，必须同步）
- `dsh-cad-harness/src/host/physics.ts`：`renderKeyframes` / `renderPng`（simulate_physics 与
  simulate_motion 共用的关键帧渲染）
- `dsh-cad-harness/src/host/compile.ts`：`renderScadPng` 增加**可选的**诊断回传（5 个调用点里
  4 个不传，签名向后兼容）
- `dsh-cad-harness/src/host/tools.ts`：check_printability 的输出 schema（`additionalProperties:false`，
  新增字段必须同步声明）+ 两个 keyframe 调用点上报渲染警告
- `dsh-cad-harness/skills/cad-toolbox/SKILL.md`：补 `linear_extrude(twist=)` 转向陷阱
- `examples/multirotor-propeller/README.md` §8：把"工具侧"条目改成复核后的准确表述
- **运行时环境**：`~/.dsh/cad/runtime/venv` 补装 `rtree==1.4.1`、`shapely==2.2.0`（均为
  `scripts/gen-python-lock.mjs` 已声明的锁定包）

## 具体操作步骤

1. **运行时**（P0）：先 `pip install --only-binary=:all: rtree==1.4.1 shapely==2.2.0` 应急；
   根因修法是第 2c 条（就绪判据改成"锁定包真的 import 得动"）。
   自检从 `缺 rtree, shapely` 变为 `9/9 无缺`。
2. **worker.py `op_check_printability`**：
   a. 悬垂面积改为**全量三角面**计算（采样只保留给昂贵的射线半边）。
   b. 射线命中改用 `intersects_location` 已返回但被丢弃的 `index_tri`，只接受
      `dot(n_in, n_exit) < -0.5` 的**对面壁**命中。
   c. 统计 `wallMeasured` / `skippedSamples`；**未测到壁厚时不得给 `ok`**，并追加显式 finding。
   d. 新增 `thinAreaMm2` / `thinAreaPct`；`unprintable` 追加"薄区成片"条件（面积下限）。
   e. findings 文案区分**薄壳**与**实心收敛楔形**。
3. **inspect.ts `checkPrintabilityInTs`**：逐条镜像 2a–2e，保持 parity。
4. **tools.ts**：schema 增加 `wallMeasured` / `skippedSamples` / `thinAreaMm2` / `thinAreaPct`；
   工具描述补"未测到壁厚时不会给 ok"。
5. **physics.ts**：`rotate(m=[…])` → `multmatrix([…4×4…])`；删掉硬编码 `'openscad'` 的
   `renderPng`，改调 `resolveBinary()` 体系内的 `renderScadPng`；渲染期 WARNING/ERROR 回传给调用方。
6. **compile.ts**：`renderScadPng` 增加可选 `onDiagnostics` 回调。
7. **SKILL.md**：陷阱清单补一条 OpenSCAD 转向约定。
8. `node esbuild.mjs` 重建 `lib/index.js`（运行中的服务需重启才生效）。
9. 验收：`node scripts/accept-printability-parity.mjs`；另用当前 venv 冷跑 worker op，
   对 v044（桨）/ v034（法兰）/ v042（叶根端面外露）三个已知件比对修前修后。

## 预期风险与验证

- **风险 1：parity 破裂**。两份实现必须给出同一判定与同一类别 findings。
  → `scripts/accept-printability-parity.mjs` 是既有验收，修完必跑。
- **风险 2：对面壁过滤误杀真薄壁**。已用两个真件验证是**无操作**：
  v044 `0.604→0.604`、v034 `0.499→0.499`（薄面数与面积不变）；只有 v042 那类
  `dot=-0.084` 的共面针状面被剔除（其读数 0.17mm 是假的）。
- **风险 3：`unprintable` 的"成片"阈值是判断题**，两个真实样本（法兰 11.9% / 桨 5.3% 薄面占比）
  **不能**干净分开，因此阈值只用于挡住"单个退化面翻转判定"，不假装能区分薄壳与钝缘；
  依据与该局限一并写入 `docs/DECISION-LOG.md`。
- **风险 4：改 schema 会拒绝未声明的字段**。三处字段同步加，且 worker/oracle 两侧必须都产出。
- **风险 5：keyframe 改动影响 simulate_physics 的既有观感**——修好后旋转会出现（此前一直丢失），
  这是**修复**不是回归，但不能把它当成"新 bug"再排查一遍。
- **验证方式**：验收脚本 + 三个已知件的修前/修后对照 + 一个反向自检
  （确认 `rotate(m=)` 的 WARNING 现在会被上报为渲染警告，而不是静默出图）。

---

## 实际结果（收尾补记）

**四处偏离原计划，都记在这里：**

1. **病因写错了，已更正。** 原摘要写"运行时缺锁定包"（暗示半装）。实际取到的事实是
   **venv 与当前锁不一致**：标记 `requirementsSha=08b72cc0…` vs 当前锁 `a21baffa…`，
   venv 建于 `2026-10-10T23:56Z`（旧锁时期）。就绪判据只看标记文件的五个字段、
   从不验证 import —— 所以它一直报 `ready`。修法因此落在**判据**上，不是补装两个包。
   （应急装的 `rtree`/`shapely` 随后被插件自己的重建覆盖，属预期。）

2. **第 3 条的修法自己踩回了第 1 条。** 加"只认对面壁"（`dot(n_in,n_exit) < −0.5`）后，
   parity 验收 **11 项失败**：TS 侧薄壁计数从 33 掉到 0、每个零件都"测不到壁厚"。
   根因是 `MeshBVH` **就地重排**它拿到的索引数组（这正是 2026-10-08 记录的缺陷 A 的另一半）：
   `hit.faceIndex` 只对**被重排的那份索引**有效，而 `checkPrintabilityInTs` 为固定采样序
   传给 BVH 的是**拷贝**。实测：0.8mm 壁厚盒子的真实远壁，经 `mesh.triVerts` 解出 dot 0.000、
   经 `bvh.geometry` 解出 dot −1.000。改为对着 `bvh.geometry` 解 + 把命中循环移出
   `try{}catch{}`（第一版抛的异常被那个 catch 吞掉，又是一次"静默没测到"）。修后 **45/45**。
   顺带把 `measure.ts` 的 `snapToSurface` 也改成对 `bvh.geometry` 解（它今天靠"传的是同一个数组"
   侥幸正确，一旦有人传拷贝就静默错位；实测拷贝情形下 4 个外点有 2 个被判成"内部"）。

3. **改返回类型打破了既有验收。** `renderKeyframes` 从"返回数组"改成"返回 `{frames, warnings}`"，
   `scripts/accept-m36.mjs` 直接消费返回值 → `c2 rendered ≥ 4 keyframe PNGs` 报 `undefined frames`。
   这是验收脚本正常发挥作用。已适配，并**给它加了两条断言**：
   "渲染 0 条 OpenSCAD 警告" + "关键帧图必须两两不同"。后者是这次修复的**端到端判据**
   （修前 `rotate(m=)` 让纯旋转机构的帧图逐字节相同，正是它没被发现的原因）。

4. **顺带查出一条设计侧结论**（不在本次改动范围）：交付的 v044 在毂顶面有一道 **0.11mm** 薄唇
   （螺母沉台 Ø11.5 与 M2 沉头锥互相逼近；z=6.9 处 0.20mm、z≈7 处 0.11mm）。面积极小（≈3mm²）、
   不受力。**抽样检查测不到它**（`samples=2500` 报最薄壁 0.604mm），是定向射线查出来的。
   已写入示例 README §8 设计侧第 2 条；修法 `M2_HEAD_D 4.3→3.8` + `SEAT_D 11.5→11.0`，
   一改就要重新出件并作废本轮运行证据，故**先记录不改**。

**验证结果（全部实测）：**

| 验收 | 结果 |
| --- | --- |
| `scripts/accept-printability-parity.mjs` | **45/45 PASS**（整机.stl：TS/py 都 `unprintable`，薄壁 33 vs 33，最薄壁 0.026 vs 0.026mm） |
| `scripts/accept-p3.mjs` | 退出 0（厚立方 `ok`+`wallMeasured:true`；0.4mm 板 `unprintable`，薄区 1800mm²/97.4%） |
| `scripts/accept-p2.mjs` / `accept-sim-verdict.mjs` | 退出 0 |
| `scripts/accept-m36.mjs` | 退出 0 + 新断言 **5/5 帧图两两不同**、0 警告 |
| 关键帧方向（独立脚本） | 四姿态 → 四张互不相同、0 警告（修前 4 张同 sha256） |
| 交付件复核 | v044/v045 `check`、`wallMeasured=true`、最薄壁 0.604、薄区 337.8mm²/5.29%、悬垂 2022mm²（精确） |
| 对照件 v034（真薄壁） | `check`、最薄壁 0.499、薄区 4164mm²/11.86% |
| `python_runtime` | 重建后 9/9 包可 import；新增 `missingPackages` + "装完先验后写标记" |
| `lib/index.js` | 已重建（`node esbuild.mjs`）；**运行中的服务仍是旧 lib，需重启才生效** |

**未做（明确留白）：** 沙箱里旧法兰 v034 的修法（A 加厚 / B 改结构 / C 只记录）仍等用户拍板；
其余 13 个未验证的旧件是否批量跑 `check_printability` 也未定。
