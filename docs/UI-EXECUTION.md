# UI 施工单（2026-10-24）

> **这份文件是施工顺序，不是设计说明。**
> 诊断与全景在 [`UI-PLAN.md`](UI-PLAN.md)；方向裁决在
> [`../docs/DECISION-LOG.md`](DECISION-LOG.md) 的 2026-10-23（注意力）与
> 2026-10-24（检索模型）两条。**两份计划冲突时，以本文件的顺序为准**；
> 每条落地后回填 `DESIGN.md`，不在本文件上追加新计划。

---

## 0. 执行纪律（不可协商）

| # | 规则 | 怎么做到 |
|---|---|---|
| 1 | **一个提交一件事** | `type(scope): …` + `Why` / `Verified` / `Risk`；`git commit -s`（DCO） |
| 2 | **Verified 必须可证伪** | 脚本名 + 数字/断言，或"未测，因为 X"。不接受"看起来对" |
| 3 | **UI 改动四件套** | `tsc --noEmit` → `node sandbox/preview/build.mjs` → `?assert=layout` 全绿 → 一张截图存 `sandbox/shots/` |
| 4 | **数据路径改动** | 现有 `accept-*.mjs` 全绿 + 为该条新增的 `accept-*.mjs`（数字写在提交信息里） |
| 5 | **先决策后代码** | 方向性改动先追加 DECISION-LOG 条目，再动实现 |
| 6 | **不跨车道** | 工作树里有另一条车道在改 `panel.ts` / `tools.ts` / `docs/TOOL-CONTRACTS.md`。每次 `git status` 后只 `git add` 本条路径；冲突文件先看 `git diff` 再动 |
| 7 | **沙箱先于交付** | DESIGN §15：任何面板改动必须在 `sandbox/preview` 跑过，截图留档 |
| 8 | **不留半成品** | 一条没做完就回到上一个绿点；不提交"先这样后面再改"的读路径 |

---

## 1. 总表（按批次，批次内按依赖）

### T0 语义修复与读路径（0.5–1 天，零接口变更）

**状态（2026-10-24）：T0.1–T0.4 全部完成。** 提交 `b2d7732`（运行标题用零件名）、
`830cdc8`（O(运行×版本) → O(运行+版本)）、`8fed362`（payload 去重 + 轮询合一）、
`fb1aa1b`（三份 manifest 加锁）。新增验收：`accept-run-title` / `bench-products` /
`accept-products-wire` / `accept-products-store` / `accept-manifest-lock`，均已挂进 `npm run accept`。
**遗留**：隐藏标签页停止轮询只在浏览器里成立，沙箱与 Node 都无真实 `document`，待真机 GUI 确认。

| ID | 做什么 | 怎么做 | 验收 | 依赖 |
|---|---|---|---|---|
| **T0.1** | 运行标题用人能读的名字 | `tools.ts` 的 `provenanceLabel(ids)` 改为按 `RunProduct.parts` 拼：`机构运动 · 弯臂 + 调焦滑座 + 齿轮轴`；版本号移到 summary/tooltip。motion/physics/assembly 三处 | microscope5 的 `r013` 标题含三个零件名；`accept-*` 全绿 | — |
| **T0.2** | `buildProducts` 从 O(运行×版本) 降到 O(运行+版本) | 把 `byId` / `newestVersionPerPart` 提到 run 循环外（`latest.ts` 加一个接受预建表的入口，或 `products.ts` 内联） | 新增 `scripts/bench-products.mjs`：合成 2 000 版/2 000 运行 < 50 ms（现 ~363 ms） | — |
| **T0.3** | 负载去重 + 轮询合一 | 服务端运行只发一份 + `runParts: Record<runId, partId[]>`；客户端按它分组。`index.ts` 与 `panel.ts` 的 3 s 轮询合成一个可见性感知的订阅 | microscope5 响应 < 80 KB（现 211 KB）；列出条数 = 存储条数；后台标签页不轮询 | T0.2 |
| **T0.4** | 写路径加锁 | `version.ts` / `runs.ts` / `parts.ts`：唯一 tmp 名（pid+rand）+ `O_EXCL` 锁文件 + **写前重读合并**（不用写前那份快照） | 新 `accept-manifest-lock.mjs`：并发 20 次写入不丢行（现会丢） | — |

> T0 全部不改接口语义，除 T0.3 的响应形状（客户端同步改）。**先做这一批再谈别的**，
> 否则后面的搜索/悬停/虚影都会建在 200 KB 的轮询上。

### T1 读端口（3–5 天）

**状态（2026-10-24）：T1.1 ✅ / T1.2 ✅ / T1.3 ✅（`0cb979b`）。**
`src/host/store.ts` 按语料根键控，`snapshot()` 用三份 manifest 的 mtime+size 失效缓存，
`changes(since)` 给出进程内单调序号，`resolve()` 认 `vNNN / rNNN / pNNN / u:<rel>` 并回答
`isCurrent`。products 路由与 UI 沙箱都改为经过它，条件请求实测 **304 / 0 字节**。
**未按原计划做的两处**：① `query(filter)` 目前只返回整棵树（facets 留给客户端搜索，
T2.3 已经覆盖）；② `/api/cad/run/attention` 与 `/api/cad/assembly/check` 没有搬进端口——
它们读的不是这三份 manifest（前者按 run 目录取文件，后者读装配清单），搬进来只是增加间接层。

| ID | 做什么 | 怎么做 | 验收 | 依赖 |
|---|---|---|---|---|
| **T1.1** | `CadStore` 只读三件套 | 新 `src/host/store.ts`：按 cwd 键控的单例；`resolve(address)`（vNNN/rNNN/pNNN/u:path → 对象 + `isCurrent`）、`query(filter)`、`changes(sinceSeq)`；内部持有 manifest 的内存快照 + mtime 失效 | 新 `accept-store.mjs`：地址解析、`isCurrent` 判定、seq 单调 | T0 |
| **T1.2** | 路由切端口 + 条件请求 | `/api/cad/products?since=` → 未变返回 304；`/api/cad/run/attention`、`/assembly/check` 走 `view()` | `curl` 两次：第二次 304；面板无感 | T1.1 |
| **T1.3** | 沙箱改为消费端口 | `sandbox/preview/server.mjs` 改 import `query()`，不再直接 `buildProducts()`；路由形状由端口决定 | 沙箱截图与宿主逐像素一致（同一 URL） | T1.1 |

> 端口是**只读**的。写路径（`command.*`）要等 T0.4 的锁跑稳之后再做，避免一次改太多。

### T2 导航（7–8 天）

**状态（2026-10-24）**：T2.1 ✅（面包屑替换三个下拉）、T2.3 ✅（客户端搜索覆盖零件/版本/
运行/文件）、T2.2 ◐（浮层已有搜索 + 分区 + Esc；**尚无「最近」与「邻域」两块**）。
T2.4 ✅（零件页「证据」表：结果 · 名称 · 版本 · 摘要 · 时间 · 旧版/被取代徽标 + 分组筛选；
沙箱 `assert=evidence` 断言「15 条运动 = 15 个不同第二行」）。
T2.6 ◐（最近 ✅：导航浮层「最近」区 + 重开恢复到上次地址；**收藏未做**）。T2.5 机器对象 **未开始**。
顺带修掉三处真问题：① 显式选择跨类目的运行会被「落到最新」覆盖（点 r059 落到 r069）；
② `printability/stress/analyze` 原先没有任何平面入口（现在归入「检查」）；
③ 面包屑在 320 下会换行（flex 基准是 auto，换行判定发生在收缩之前）——改成 `1 1 0`。

| ID | 做什么 | 怎么做 | 验收 | 依赖 |
|---|---|---|---|---|
| **T2.1** | 面包屑替换浏览行 | 顶部一条：`项目 · 对象 · 版本`（项目靠右，单项目时弱化）；点击开浮层。删除"类别/条目/记录"三个 `<select>` | 380/320 下不换行、不截断（`assert=layout`） | T1 |
| **T2.2** | 导航浮层 | 复用 `S.sheet` 机制（不占版式）：搜索框（聚焦即输）+ 最近 6 条 + 邻域 + `全部`（机器/零件/未登记，折叠）+ 键盘 ↑↓/Enter/Esc | 输入 3 字符命中；打开/关闭浮层所有盒子不变 | T2.1 |
| **T2.3** | 搜索索引 | 客户端从 `products` 建索引：零件名 / 版本标题 / 运行标题 / 参与零件名 / ID / 未登记路径；分组结果 | microscope5 搜"滑座"→ 命中零件 + 引用它的运行 | T2.2 |
| **T2.4** | 证据表 | 零件页/机器页的"证据"用表格：结果徽标 · 参与零件 · 时间 · 过期/被取代 · 操作。替换现在的 `div` 文本流 | 15 条运动一屏可辨（不点开就能说出差异） | T2.2 |
| **T2.5** | 机器对象 | 读 `/api/cad/assembly/manifest`，把"机器"作为顶层对象；运行按 `sourceVersionIds.length ≥ 2` 归到机器（清单未接入时的占位） | microscope5 顶层 = 1 机器 + 16 零件 + 未登记，一屏装下 | T1.1 |
| **T2.6** | 最近 / 收藏 | 最近 6 条（MRU）落 `panel/state.json`；收藏是人的层（可跨零件） | 重开面板回到最近；收藏跨会话保留 | T1 |

### T3 历史门槛 + 虚影（5 天）

| ID | 做什么 | 怎么做 | 验收 | 依赖 |
|---|---|---|---|---|
| **T3.1** | 历史视图模式 | `resolve().isCurrent === false` → 面板进入历史态：琥珀边框、`历史视图 · 不入证据`、禁用"重跑/批准"、截图与请求自动带旧版声明。分级：最近 5 版可直点，更早需展开 | 选旧版时三个动作被禁用且有原因；回到最新一键 | T2.4 |
| **T3.2** | **虚影对比**（点名要做） | 同场景加载最新版 STL，作为第二 mesh：线框或 60% 透明、`depthWrite:false`、不参与拾取；开关 + "对齐到当前"（不同版本原点可能不同） | 旧版 v029 + 最新 v030 虚影；开关不重建场景（只切 `visible`）；两版同帧可读 | T3.1 |
| **T3.3** | 深链落历史 | `?t=v029&view=iso` → 解析后按 `isCurrent` 决定进不进历史态；URL 与状态双向同步 | 分享旧版链接，打开即历史态 | T3.1 |
| **T3.4** | LLM 请求回退 | 待阅项支持两种：`view`（看旧版 + `compare=latest`）与 `proposal: revert`（人批准 → 新版本 `parentVersion=当前 head`，几何复制，标题"回退到 vXXX"） | 批准后出现新版本且历史不变；拒绝后队列项标 dismissed | T4.1 |

### T4 待阅队列（5 天）

| ID | 做什么 | 怎么做 | 验收 | 依赖 |
|---|---|---|---|---|
| **T4.1** | 工具 + 队列 + 闸门 | `request_review({items:[…]})` → `<data>/panel/queue.json`；单次 ≤3、10 分钟 ≤6 次、未读 ≤20、同目标 10 分钟合并、1 小时折叠；超限 `rate_limited + pending` | 连发 5 条进 3 条；第 7 次调用返回 `rate_limited` | T1.1 |
| **T4.2** | 徽标 + 审阅浮层 | 状态带 `待阅 N`；浮层逐条 `看 / 已阅 / 忽略`；视口上方细条 `2/3 …` | 点第 2 条才切视口；连发 5 条不弹 5 次 | T4.1 |
| **T4.3** | 视口历史栈 | 存 `{对象, 相机位姿, 剖切, 图层}`；`Alt+←/→` + `↩ 返回原图`；退出审阅 = 弹回入队前 | `Alt+←` 后三要素逐字段回到原值（断言，不看像素） | T4.2 |
| **T4.4** | 不再劫持 | Tab 标题未读数；**取消** CAD 活动自动弹；`followLatest` 默认关，新版只加徽标 | 新版本出现时面板不弹、选中不变、标题 `(1)` | T4.1 |

### T5 地基（可与 T2 并行，2–3 天）

| ID | 做什么 | 怎么做 | 验收 | 依赖 |
|---|---|---|---|---|
| **T5.1** | 新 UI 的令牌与三个原子 | `src/client/theme.ts`（色/字号/间距）+ Button / Chip / Callout；**只给新 UI 用**，旧面板不重构 | 新组件无裸 hex；同一组件四态一套样式 | — |
| **T5.2** | 场景矩阵 | `scripts/accept-panel-ui.mjs`：5 类目 × 4 页签 × 3 宽 × 3 高，断言关键元素存在/不重叠/无横向滚动；基线进 `verification/shots/ui/` | 加一个 chip 导致 320 溢出时脚本变红 | T5.1 |
| **T5.3** | 图标与字号（可选） | emoji → 单色 SVG；字号阶梯 11/12/14/16 | 三平台截图一致 | T5.1 |

---

## 2. 第一批：明天就能提交的三个提交

按这个顺序做，每个都是独立提交：

```
1) fix(cad): 运行标题用零件名 —— 标题是给人读的，不是给版本号读的
   files: src/host/tools.ts
   Verified: microscope5 r013 标题含「弯臂 + 调焦滑座 + 齿轮轴」；accept-* 全绿

2) perf(cad): products 从 O(运行×版本) 降到 O(运行+版本)
   files: src/host/products.ts, src/host/latest.ts, scripts/bench-products.mjs
   Verified: 合成 2000/2000 < 50ms（前 363ms）；microscope5 仍 1.1ms

3) fix(cad): manifest 写入加锁（唯一 tmp + O_EXCL + 写前重读合并）
   files: src/host/version.ts, src/host/runs.ts, src/host/parts.ts,
          scripts/accept-manifest-lock.mjs
   Verified: 并发 20 次写入不丢行；旧实现下同一脚本丢 N 行（作为对照写进提交信息）
```

T0.3（负载去重 + 轮询合一）动客户端与响应形状，单独一天，放在这三个之后。

---

## 3. LLM 请求回退的语义（T3.4 展开）

| 形态 | LLM 做什么 | 面板做什么 | 人做什么 | 是否改历史 |
|---|---|---|---|---|
| **请求回看** | 待阅项 `target=v027`, `compare=latest` | 打开 v027 并叠最新虚影 | 看、批注、忽略 | 否 |
| **提议回退** | 待阅项 `proposal=revert`, `to=v027`, `why=…` | 显示"建议回退到 v027（当前 v030）" | **批准 / 拒绝** | 批准后：新版本 `parentVersion=v030`，几何复制自 v027，标题"回退到 v027" |

原则：**回退是新提交，不是时间倒流。** 旧版本永不删除、父链永不改写；这样"回退"本身
也可被追溯，下一次迭代还能再回退回来。

---

## 4. 未决（动手前需要拍，但不阻塞 T0）

1. **近期 = 几版？** 建议 5（时间线默认），更早进「全部」。
2. **旧版上允许跑仿真吗？** 建议允许但需显式声明（`reproduce: true`），运行标题自动带
   `基于旧版 v029`。
3. **工具名**：`request_review`（建议）还是 `request_attention`。
4. **整页形态（A8）**：B5 对比与 E2 爆炸视图依赖它；需要先查宿主是否允许注册中心区 tab。

---

## 5. 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| 另一条车道同时在改 `panel.ts` / `tools.ts` | 冲突、互相覆盖 | 每次提交前 `git status`，只 stage 本条；大改前先看对方 `git diff` |
| 端口重构期两套读路径并存 | 沙箱与宿主静默漂移 | T1 限定 3 天内切完；沙箱改为消费端口后删旧入口 |
| 虚影坐标不一致 | 两版不同原点时虚影错位，读成"改了很多" | 默认按各自 bbox 对齐，提供"按原坐标系"开关；错位本身也是一种信息，但必须能被关掉 |
| T0.3 改响应形状 | 面板分组逻辑错 → 运行重复/丢失 | 断言"列出条数 = 存储条数"；先在沙箱跑显微镜5 |
| 历史门槛过重 | 人看旧版变麻烦 | 门槛只加在"动作"与"视觉"，不加在"进入"；最近 5 版仍是单击直达 |
