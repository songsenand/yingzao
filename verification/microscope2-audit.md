# microscope2 复盘：整机渲染图为什么不存在，以及插件还差什么

> 数据来源
> - 会话：`~/.dsh/sessions/--home-songsenand-Project-ToyMarker-examples-microscope2--/session-084d0be4-…/session.v3.jsonl.zstd`
>   （1 turn / 101 step / 154 次工具调用 / 43.2 min / 工具结果里 189 张图 / 输入 1.28M tokens、cacheRead 29.6M、输出 356k）
> - 语料：`~/.dsh/cad/microscope2-6ec10de3/`（38 版本 / 17 零件 / 36 条 run / 207 张 PNG）
> - 代码：`dsh-cad-harness/src/{host/tools.ts,host/products.ts,client/panel.ts,client/playback.ts,host/image-budget.ts}`
> - 遥测：`~/.dsh/cad/telemetry/usage.jsonl`（该时段 166 次请求，单请求最多 22 张图）

---

## 0. 一句话结论

**整机渲染图在这套插件里根本不是一个产物。** 没有任何工具会渲染"多零件装配体"的静态图片：
`validate_assembly` 只写 `parts/*.stl` + `report.json`，`frames/` 永远为空，也从不 attach 图片。

装配 run **确实**在"跨零件场景"桶里 —— 36 条 run 有 34 条都落在那儿。
面板里选中它**能**看到整机，但那是**交互式 Three.js 视口**（StaticPartsView），不是渲染图，而且藏在 `⚙ 跨零件场景` 下拉后面。

所以准确说法是：**没有静态整机图；只有"面板里可交互的 3D"和"仿真关键帧里的整机"（还是被合并成单实体的那种）。**

---

## 1. 三层证据

### 1.1 磁盘上：不存在整机 PNG

```
~/.dsh/cad/microscope2-6ec10de3/ 共 207 张 PNG：
  versions/vNNN/render_{top,front,side,iso}.png   ← 全部是单零件四视图
  runs/rNNN/frames/*.png                          ← 只有 motion / physics 有
  measure/closest_1790844190682.png               ← 唯一一张跨零件图（最近点标注）
workspace(examples/microscope2/) 里 0 张 PNG。
```

按 kind 统计 `frames/` 数量：

| kind | 条数 | frames | parts(STL) |
|---|---|---|---|
| `assembly-check`（check_assembly） | 18 | **0** | 0（无几何） |
| `assembly`（validate_assembly） | 8 | **0** | 5 / 10 / 15 / 16 |
| `motion` | 5 | 10–12 | 4 |
| `physics` | 5 | 12 | 2–4 |

`validate_assembly` 的 execute 只做三件事：`run.part()` 落 STL、`run.json('report.json')`、`run.commit()`（`src/host/tools.ts:797-812`）。
它**从不调用** `ctx.attachments.saveImages()` —— 全仓库调用 `saveImages` 的只有 `generate_part / import_part / render_part / simulate_motion / simulate_physics / simulate_fluid / measure_closest` 七个。
`assembly-check`（check_assembly）更彻底：`hasGeometry: false`，返回纯数值。

### 1.2 桶里：全都在"跨零件场景"

`src/host/products.ts:52-66`：run 的 `sourceVersionIds` 映射到零件，`owners.length !== 1` 就进 `scene` 桶；`owners.length > 1` 时**同时**挂到它用到的每个零件下。

- `validate_assembly` run：16 个版本 → 16 个 owner → 进 scene ✅
- `check_assembly` run：`sourceVersionIds` 是**清单里所有版本**（r033 列了 16 个）→ 也进 scene
- `simulate_motion` run：4 个零件 → 也进 scene；`simulate_physics` 里只有 r028（源 v036 单一零件）和 r026 落在零件桶

实际统计（按 `parts/manifest.json` 的 partId 归属重算）：**36 条 run 里 34 条进"跨零件场景"**
（18 清单检查 + 8 装配间隙 + 5 运动 + 3 物理），其中 18 条是没有任何几何的清单检查记录。
面板里那个 `⚙ 跨零件场景 · N`（`panel.ts:1752`）因此完全失去筛选价值 —— 用户点进去看到的是 18 张 📋 文本卡片 + 8 条装配间隙，要找"整机长什么样"得自己一条条点。

### 1.3 对话里：整机图像只有两种，都不是 16 件装配

| 来源 | 内容 | 问题 |
|---|---|---|
| `simulate_physics` r026–r030 | agent 自己用 OpenSCAD 把 16 件 union 成一个 `asm.stl`，`import_part` 成假零件 v036「整机刚体」 | **单色单实体**、430k 三角面、83MB；不是 16 件彩色装配 |
| `simulate_motion` r015–r023 | 4 个零件（弯臂 + 滑座 + 齿轮轴 + 轴承座） | 只是调焦机构的局部 |
| `measure_closest` | 1 张最近点标注图 | 两个零件，不是整机 |

**agent 从头到尾没有"看过"整机。** 全程 `read_image` 调用 = **0**（37 次 `generate_part` 的图是工具自动附带的）。
它在终稿里写"外形参考图片"，但这句话没有任何一次视觉核对支撑 —— 而且参考图本身在第 5~6 轮 `generate_part` 之后就被图预算 offload 掉了（见 §3.11）。

---

## 2. 面板里到底能不能看到整机？能，但有一个真 bug

`panel.ts:1853-1857`：

```ts
run && run.kind === 'assembly' && run.hasGeometry &&
  React.createElement(StaticPartsView, {
    key: run.id, runId: run.id, parts: run.parts,     // ← 没有 placements
    onScreenshot: ...,
  }),
```

`StaticPartsView`（`playback.ts:577-647`）会按颜色把 8~16 个零件拼到一个场景里，可转、可截图进会话 —— 功能是有的。

**但它需要的 `placements` 没被传进去。** 这条链路两端都是通的、中间断了：

- `runs.ts:136-180` 把每个零件的 `translate/rotate` 写进 run manifest；
- `types.ts:46` 在 `RunProduct` 上声明了 `placements?`；
- `playback.ts:614-624` 读取 `props.placements?.[name]` 并施加变换；
- `panel.ts` 调用处**没传**。

microscope2 恰好所有零件都建在世界坐标下（`translate/rotate` 全是 `undefined`），所以侥幸没暴露。
换一个"零件各自在原点建模、靠 translate 摆位"的装配体，面板会把所有零件画在原点重叠 —— 而 `validate_assembly` 的数值检查是对的，人眼看到的却是错的。

---

## 3. 会话实录：插件做得不够好的地方（按影响排序）

### P0-1 数据根在 workspace 之外，逼整个会话出沙箱

`check_assembly` 的 `manifestPath` 相对**插件数据根**，而数据根是 `$DSH_HOME/cad/<slug>-<hash>`，在会话工作区外。

会话实录：
1. agent 先 `mkdir ~/.dsh/cad/microscope2-probe` 探测 → `只读文件系统`；
2. 只能去读源码，用 node 自己重算 `createHash` + slug，反推出 `microscope2-6ec10de3`；
3. 三次 `approval/asked`，理由一模一样：
   > "escalate sandbox to danger-full-access: check_assembly resolves the manifest path relative to the plugin data root ($DSH_HOME/cad/microscope2-6ec10de3/), which lies outside the session workspace"
4. 用户最后直接把整个会话切成 `danger-full-access` + `approval: never`。

**一个 CAD 工具的必需输入文件放在工作区外，等于每做一次装配检查就要放弃沙箱。** 这不是 agent 的操作问题，是工具契约问题。

修法（任一）：`check_assembly` 接受内联 manifest / 接受 workspace 相对路径；或加 `get_project_info` 工具直接返回数据根；或把数据根搬进 workspace。

### P0-2 仿真工具把自己的数字丢了

`simulate_motion` 的 output schema 声明了 `followers / interferenceCount / interferenceEvents / maxJointDriftMm / stepsRun / durationSec`（`tools.ts:1182-1191`），
`simulate_physics` 同理。但两者的 `finalizeContent`（`tools.ts:1204-1217`、`tools.ts:975-983`）把 content blocks **换成一句话 + 4 张图**。

实测该会话的 tool/result 内容：

```
simulate_motion →  [text: "Motion simulation check. Attached milestone keyframes in order: t0s crank0, …"]
                   [image][image][image][image]
```

**JSON 一个字段都没进对话。** 后果在会话里肉眼可见：

- agent 第 58 步自己写下："The keyframes came back but not the metrics — reading the run report from the corpus"；
- 之后 5 次 motion + 6 次 physics，每次都要 `bash` + `python` 去读 `runs/rNNN/report.json`；
- 读错过一次：`r021 status pass travel None`（该 run 没有 metrics 字段），只能再读 r022。

`finalizeContent` 拥有最终内容（dsh-tools README：`… → definition-owned finalizeContent → tools/result`），所以这是插件自己把数据删了。
修法：`finalizeContent` 的 text 里拼上 metrics 摘要；JSON 与图并存。

### P0-3 `validate_assembly` 不产图

见 §1.1。这是"整机渲染图"缺席的直接原因。
host 侧已经有 Manifold，把 8~16 个 solid 合成一个场景再渲染一张 combo（或四视图 + 干涉对高亮）成本极低。
顺带：`runs/*/frames/` 现在对 `assembly` 来说永远是个空目录，语义上是半个产物。

### P1-4 零件名 ASCII-only，且报错不解释，还留下孤儿 run

- `validate_assembly` 要求 `safeName`，传中文零件名直接：
  `Error: unsafe part name: 底座`（`runs.ts:153`）
- 而 `generate_part` **接受**中文零件名（语料里 17 个零件叫 `底座/立柱/弯臂/…`），面板也按中文显示。
  于是 agent 被迫改用 `base/column/arm`，**run 里一套英文名、面板里一套中文名**，对不上号。
- 更糟：这个 throw 发生在 `beginRun()` **之后**的 `run.part()` 循环里，所以第一次失败的调用**留下了一个孤儿目录 r004**
  （`runs/r004/` 存在、`frames/`+`parts/` 空、`run.json` 不存在、`runs/manifest.json` 里没有它），run id 也被烧掉。

修法：先校验全部 name 再 `beginRun`；报错写明可用的字符集；或者干脆支持非 ASCII（用 hash/序号做目录名）。

### P1-5 没有"合并刚体 / 装配体"原语

要做整机倾倒测试，只能自己写 OpenSCAD 把 16 个 STL union：

- 第一次跑出 `Current top level object is empty.`，**没有任何诊断**，agent 花了 4~5 次 bash 去试 `import()` 路径；
- 成功那次 `Total rendering time: 0:02:27`，产出 **83MB / 415,683 facets / 430,064 三角面** 的 STL；
- 再 `import_part` 成一个假零件 `v036「整机刚体」`，污染零件列表。

host 已经有 Manifold boolean，`validate_assembly` 也已经在一帧里放了 16 个 solid —— 缺的只是 `merge into one solid`。

### P1-6 装配清单只能手写 + 手工 cp

`assembly.json`（16 零件 / 32 接口）全程手写；此后每次改版本号都是：

```bash
python3 - <<'EOF' ... json.load ... json.dump ... EOF
D=~/.dsh/cad/…/assembly; W=…/examples/microscope2/assembly; cp $W/assembly.json $D/
```

—— 会话里这种 `bash + python 打补丁 + cp` 至少出现 **8 次**。
中途还有一次 `write` 报 `file changed since it was read — re-read the file, then retry`（因为之前用 python 改过同一文件）。

缺 `assembly_add_interface` / `assembly_set_child_version` / `assembly_list_datums` 这类工具。
更根本的是：**工作区里的 `assembly/assembly.json` 和的数据根里的那份是两份拷贝**，靠 cp 同步，必然漂移。

### P1-7 补一个 datum 必须新出一个"几何不变"版本

会话里至少 3 个版本纯粹为了加锚点而生成：

| 版本 | intent |
|---|---|
| v006 | 弯臂 v2：补 前立面 / 前立面轴承 两个锚点，**几何不变** |
| v007 | 载物台 v2：补 台底点 锚点，**几何不变** |
| v037 | 压片簧 v2：补 簧根沿 锚点，几何不变 |

38 个版本里混着这些"零设计变更"的条目，版本历史失去了"哪个是当前设计"的可读性，还多花了 3 轮渲染 + 3×4 张图。
修法：datum 可以和几何版本解耦（sidecar / `datums(v003) = {...}`），或在版本上打 `geometryUnchanged: true`。

### P1-8 run 记录没有生命周期

36 条 run：18 清单检查 + 8 装配间隙 + 5 运动 + 5 物理（另有 1 条孤儿）。全部堆在 scene 桶里，没有 supersede / 归档 / "只保留最终一条"。
用户要判断"哪条才是最终的整机检查"，只能看时间戳和 title 里的版本号列表。

### P2-9 几何/运动算子缺口（agent 自己在 DESIGN.md 里标注的）

- `check_assembly` 缺 `motion-clearance`、`spring-preload` 两个算子 → 32 条接口里 2 条只能 `skipped`（不是漏检，是引擎没有）。
- `simulate_motion` **没有齿条-齿轮约束**：滑座只能给 `oscillator` 正弦，齿轮轴独立匀速，硬对上齿面互啃 → agent 只能把齿条从运动仿真里删掉，啮合另行几何核对。
- `simulate_physics` **只有 revolute**，没有 prismatic（`tools.ts:945` 只声明 hinge）。

### P2-10 阈值语义靠猜

未声明邻接固定 0.75mm；agent 自己发现：`arm↔stage` 的 1.0mm 让位间隙在默认阈值下"不存在"，只有手动把 `validate_assembly` 的 `clearanceThreshold` 提到 1.2 才抓到。
工具不会说"这条缝落在你声明的公差之外/之内"，只能靠人肉试阈值。

### P2-11 用户的参考图被图预算最先丢掉

`image-budget.ts:29` `DEEPSEEK_KEEP_IMAGES = 24`，注释明确"replaces the OLDEST image occurrences"。
用户第一张参考照片是**最老的**一张，每次 `generate_part` 又加 4 张 → 大约 5~6 轮之后参考图就被 offload 了。
遥测证实图预算在工作：该时段 166 次请求，单请求最多 22 张图，从没超过 24。

但 agent 全程 `read_image` = 0，所以它的后半程（弯臂、调焦、光学链、稳定性）是在**没有参考图**的情况下"参考图片"的。
（占位符里带着本地路径，模型理论上能 `read_image` 拉回来 —— 但没有任何东西提示它这么做。）

修法：`source.kind === 'user'` 的附件不参与 offload；或在 offload 占位文案里点名"这是用户给的参考图"。

### P2-12 `validate_assembly` 把 120 对原始 JSON 全量返回

16 件 → 120 对，每对 5 个字段。会话里那次结果文本长到被截断。模型需要的是 `overallStatus + 非 ok 的对 + 摘要`。

### P2-13 `generate_part` 的四视图没有尺度信息

没有坐标轴、没有尺寸标注、没有网格。agent 无法目视核对关键尺寸（相机的 u=13.0 / v=156.0 只能靠 `measure_*`）。
配合 §2 的"整机看不到"，等于**视觉通道在这套工作流里基本没有被用来验证**。

---

## 4. 如果只做三件事

1. **`validate_assembly` 出一张整机图**（combo 或四视图 + 干涉对高亮），attach 进对话，`frames/` 不再为空。直接解决用户这次的问题。
2. **`check_assembly` 不再依赖工作区外的数据根**（内联 manifest 或 workspace 相对路径）。把用户从 danger-full-access 里放出来。
3. **`simulate_motion` / `simulate_physics` 的 `finalizeContent` 里带上 metrics**。省掉每次仿真之后的一轮 bash 读盘。

其次：面板把 `run.placements` 传给 `StaticPartsView`（一行）；`validate_assembly` 先校验名字再建 run 目录（消掉孤儿 r004）；图预算保护用户附件。

---

# 附：P0 修复记录（2026-10-01）

三件都改在插件里，并用 `scripts/accept-p0.mjs` 端到端验收（走真实 tool 对象：
`registerCadTools` → `execute` → `finalizeContent`，不是只测底层模块）。

## P0-1 `check_assembly` 不再要求把清单放到工作区外

`src/host/manifest.ts` 新增 `resolveAssemblyManifestPath()`：相对路径**先按会话工作区解析**，
再回落到插件数据根；绝对路径照用。工具 + `POST /api/cad/assembly/run` +
`GET /api/cad/assembly/{manifest,check}` 四个入口共用同一个解析器。报错会同时列出
两个候选路径，不再让人去反推那个 hash 目录名。`check_assembly` 的返回值新增
`manifestPath`，说明这次到底审的是哪一份文件。

真机复核（真实 microscope2 语料，16 件 / 32 接口）：

```
manifestPath : .../examples/microscope2/assembly/assembly.json      ← 工作区里那份
status       : pass    32 接口 · 通过 30 · 硬冲突 0 · 未声明 0
```

**没有再往 `~/.dsh/cad/…` 拷任何东西，也没有任何 sandbox 升级。**

## P0-2 仿真工具的 metrics 不再被 finalizeContent 丢掉

`simulate_motion` / `simulate_physics` / `simulate_fluid` 三处 `finalizeContent`
现在从 `result.value` 里把数字拼进文本块。实测输出：

```
Motion pass. Ran 6283 steps / 3.142s.
Interference: 0 event(s)
Max joint drift: 0mm.
rod: travel 48.000mm on x, period 2.227s
Attached keyframes in order: t0s crank0, …
```

```
Physics pass. Settled penetration 0.07mm (max 0.07mm).
block: stayed upright
```

顺带把 `simulate_fluid` 一起修了（同一个 bug 类）；之前它的指标字段名也只在
报告里，现在写进文本的是真实字段（`massConservationError`、`timeToOutletSteps` 等）。

## P0-3 `validate_assembly` 现在出整机图

新模块 `src/host/assembly-render.ts`：把每个零件按声明的位姿（`translate(t) rotate(R)`，
与 `assembly.ts`/`assembly-check.ts`/面板同一套约定）拼成一个 SCAD 场景，逐件上色，
渲 `iso / front / side` 三视图到 `runs/<id>/frames/`，再 attach 进对话。数字照旧在
文本里（`Full report: {…}`），图是**追加**而不是替换。

真机效果（真实 microscope2 16 件，见 `verification/microscope2-assembly/`）：
整机第一次被画出来了 —— 底座 / 立柱 / 弯臂 / 载物台 / 左右调焦旋钮 / 精调环 /
镜筒 / 目镜筒 / 相机托板 都在，`0 干涉 / 18 过紧`。

**修复过程中渲染图当场抓出一个我自己写反的 bug**：OpenSCAD 是「最右边的变换先作用」，
所以 `world = t + R·local` 必须写成 `translate(t) rotate(R) import(...)`；我一开始写成
`rotate(R) translate(t)`，于是 manifest 里那个镜像摆放的左旋钮
（`rotate([0,180,0]) translate([0,0,530])`）被扔到了机器下方 795mm 处，整机缩成一小团。
`accept-p0.mjs` 里留了一条针对这个顺序的断言。

## 附带的（一行）

面板 `StaticPartsView` 现在拿到 `run.placements` —— 之前这条链路
（`runs.ts` 存 / `types.ts` 声明 / `playback.ts` 读）在 `panel.ts` 调用处断掉，
靠 "所有零件都建在世界坐标" 侥幸没暴露。

## 仍需注意

- 跑在 127.0.0.1:4096 的那个 DSH 进程是改动之前启动的，**host 半边要重启 profile 才生效**
  （client 半边刷新页面即可）。
- microscope2 数据根里那份 16:53 的 `assembly.json` 旧拷贝还在（工作区外，本次没动它）。
  现在工作区那份优先，它已经不会再生效，但建议手工删掉以免误导。
- 未修的 P1/P2 见正文；其中 `validate_assembly` 的孤儿 run 目录（名字校验在建目录之后）
  仍在。

---

# 附：P1 修复记录（2026-10-01）

验收脚本 `dsh-cad-harness/scripts/accept-p1.mjs`（25 条断言，全绿），同样走真实 tool 对象；
另有真机复核（真实 microscope2 语料，见下）。回归：`accept-p0` / `accept-assembly` /
`accept-tool-scope` / `accept-project-scope` / `accept-inspect` 全过，`tsc --noEmit` 干净。

## P1-4 零件名的规则改成"文件系统规则"，且建目录之前就检查

`safeArtifactName()`（`runs.ts`）：只拒绝分隔符、控制字符、Windows 保留字符、开头 `"."`、
以及首尾空白——**任何语言都可以**。原先 `/^[A-Za-z0-9._-]+$/` 让
`generate_part` 的「底座」和 `validate_assembly` 的 `base` 变成两套命名体系。
`runFilePath()` 的逐段校验、面板取 STL 的 `safePart()` 都改用同一条规则。

名字检查提到 `beginRun` **之前**（`assertPartNames`，顺带查重名），并且 `beginRun`
的目录改成**首次写入时才创建**——显微镜语料里那个孤儿 `runs/r004/`（空目录、不在
索引里、白烧一个 id）就是 `beginRun` 先建目录、随后 `run.part()` 才报名字非法造成的。

真机复核：把 17 个子件用中文名（`0-底座`、`1-立柱`…）连同位姿一起丢给 `validate_assembly`
→ `136 对 · 0 干涉`，`runs/<id>/parts/底座.stl` 真的落盘。

## P1-5 `merge_parts`：N 个零件按位姿并成一个刚体

新工具，host 侧直接用已经链进来的 Manifold（`buildSolid` → `add` → `getMesh` →
`writeBinaryStl`），不经过 OpenSCAD。provenance 落在版本目录的 `source.json`
（`{kind:'merged', from:[{name, versionId}…]}`），所以"这个刚体是用哪几版拼的"以后还查得到。

真机复核（真实 17 件显微镜，与我用 OpenSCAD + python 的手工路线对比）：

| | 会话里的手工路线 | `merge_parts` |
|---|---|---|
| 耗时 | 第一次 2.5 min + 一次空对象失败 | **17.4 s** |
| 外形 | 155.0 × 155.0 × 433.0 mm | **155.0 × 155.0 × 433.0 mm**（完全一致） |
| 三角面 | 430,064（只并了 10 件） | 686,562（17 件全并） |
| 体积/质量 | 902.5 g（python，自己的清单） | 864.2 cm³ / 907.5 g（`measure_part`） |
| 重心 | (0.7, 29.1, 197.9) | (0.5, 29.1, **198.2**) |

两条完全独立的路径（OpenSCAD union + python 质量特性 vs Manifold union + `measure_part`）
在质量上差 0.55%（口径不同：我并的是清单里全部 17 个子件，含左右两个旋钮和压片簧），
重心 z 差 0.3 mm。**它现场还答了一个新问题**：合并体是 **17 个不相接的壳**——
这 17 件在声明位姿下没有任何两件真正贴合（靠配合间隙和螺钉连），所以"整机刚体"是个
合理的刚体近似，但不是一个焊接体。`merge_parts` 会把 shell 数写在结果和警告里。

## P1-6 / P1-7 `set_datums`：锚点是元数据，不再换一个版本

新工具：`set_datums(versionId)` 列出该版本声明的锚点（名字 + 坐标 + 朝向 + 半径）——
这正是写接口时要照着填的东西；`set_datums(versionId, datums)` 原地增补或整体替换，
**不新建版本**。版本目录不在索引里但实际存在时也能用（会带一条警告）。

真机复核：`v001` 5 个锚点、`v027` 13 个、`v038` 5 个，全部列得出来。
验收里还做了一次闭环：给一个没有锚点的版本 `set_datums` 补一个 → 用这个锚点写一条
`distance` 接口 → `check_assembly` 报 `pass`，且版本数 `2 → 2` 没变。
会话里那三个"几何不变"版本（v006 / v007 / v037）以后不必再出现。

P1-6 的另一半是**认知问题**：agent 当初不知道清单该放哪。skill 里现在明确写着——
装配清单就是工作区里的普通文件（默认 `<workspace>/assembly/assembly.json`），
用 `write` / `edit` 改，不要 shell 出去打补丁，更不要拷贝到别处。

## P1-8 run 有了生命周期

每次 commit 可以带一个 `subject`（`validate_assembly` 用排好序的零件名集合，
`check_assembly` 用清单的相对路径）。同类、同 subject 的新 run 会把旧 run 标成
`supersededBy` —— **不删除、不改报告**，只加一个指针，旧 run 的 `run.json` 和索引里都写。
面板的记录行显示「已被 rNNN 取代」，tooltip 解释规则。

真机复核：同一组 17 件连跑两次 → `r001 supersededBy=r002`，`r002 supersedes=["r001"]`；
同一份清单连跑两次 → `r004 → r005`。**不同零件集合不会互相取代**（验收里专门有一条），
因为那是在问另一个问题——这正是会话里那 5 次物理仿真不能被自动清理的原因。

## 还没做（P2 及以下，保持原样）

- 参考图被图预算最先 offload（`image-budget.ts` 的用户附件保护）；
- `validate_assembly` 一次返回 120 对原始 JSON 的摘要化；
- `generate_part` 四视图没有坐标轴/尺寸标注；
- `check_assembly` 缺 `motion-clearance` / `spring-preload` 算子，`simulate_motion` 无齿条-齿轮约束，
  `simulate_physics` 无 prismatic；
- 很"高"的零件（如 433mm 的整机刚体）四视图 framing 偏紧、顶端略有裁切——这是
  `renderStlFramePng` 的公有行为，`import_part` 也一样，不是本次引入的。

工具数从 12 变成 14（`merge_parts`、`set_datums`），`skills/cad-toolbox/SKILL.md`
的路由表、约定和陷阱已同步。

---

# 附：P2 修复记录（2026-10-01）

验收脚本 `dsh-cad-harness/scripts/accept-p2.mjs`（26 条断言，全绿）；回归
`accept-p0 / accept-p1 / accept-assembly / accept-tool-scope / accept-project-scope /
accept-inspect` 全过，`tsc --noEmit` 干净。真机复核（真实 microscope2，临时语料副本）另见下。

## P2-9a `simulate_physics` 支持 prismatic（滑动副）

`JointData.prismatic(anchor, anchor, axis)` + `setLimits`。**关节漂移按"垂直于轴"测量** ——
沿轴滑动正是滑动副在工作，用整段锚点距离量会把每一个正常工作的滑块都报成异常。
验收：限位 [-8,8] 时下滑 8.15mm 且垂直漂移 0.000mm；放宽到 ±400 后同一滑块走到 400mm。

## P2-9c `simulate_motion` 的齿条-齿轮耦合

oscillator 新增 `pitchRadiusMm`：位移 = r × (驱动角)，即真实齿条-齿轮强制的比例；
`s = r·(ωt + phaseRad)`，相位就是用来扫齿相位的。正弦模式保持原样（阀门）。
验收：r=5/ω=2 一圈行程 31.41mm（解析值 31.42），两圈精确翻倍。

顺带修了 `travelMm` 的一个长期少报：行程只在**干涉采样点**上取 max−min，单调斜坡会少
一个采样间隔（会话里把指令 25.0 报成 24.913 就是这个）。现在每一步都在跑 min/max。

### 做这件事时挖出一个更严重的 bug：`simulate_motion` 一直绕**世界原点**旋转

rapier 的刚体绕**自身原点**旋转，而本语料的零件都建在世界坐标、body 一律放在 (0,0,0)，
于是"被驱动的齿轮"不是绕自己的轴转，而是以 265mm 半径抡出去：

```
会话形状的那次运行（2 圈）：曲柄 90° 时齿轮 AABB  min=[-34, -275.9, 15.5] max=[34, -254.1, 37.3]
                            （齿轮实际在 y≈26.5, z≈265 —— 它已经被甩到 y≈-265, z≈26）
```

而这次运行报的是 **干涉 0、关节漂移 0.0325mm** —— 两个数字都是假象：

- 甩出去扫的是空场，没撞到东西，所以干涉为 0；
- `maxJointDriftMm` 只在**最终位姿**上量一次，而 2 整圈之后齿轮正好回到出发点，
  于是"最大漂移"变成了 0.03mm。名字叫 max，其实是一个末态采样。

修法（`runMotionJob` + `mesh.rebaseMesh`）：每个零件先按 pivot 重新基准化 ——
几何平移 −pivot、body 放到 position+pivot、引用该零件的关节锚点同样平移。任意点的世界位姿
不变（R(local−p) + (pos+p) = R·local + pos），但 body 原点落在转轴上了。pivot 默认取
**第一个引用该零件的关节锚点**（那就是它该绕的轴），没有关节才退回几何包围盒中心。
存的 STL 也是重基准化后的那份，所以面板回放和关键帧渲染跟轨迹自动一致。

修后：同一位置该齿轮 AABB = min=[-34, 15.5, 254.0] max=[34, 37.5, 276.0]，关节漂移 0mm，
2 圈与 0.4 圈给出同一个答案。

**回头看会话**：agent 当初说"硬把两者对上会让齿面互啃，所以运动仿真里把齿条去掉" ——
它想绕轴转，工具却在绕原点抡。现在能对上以后，工具给出的真实结果是：
真实齿条 + 真实齿轮按 r=10 耦合、跑 25.13mm 行程（就是设计行程）——
`carriage↔pinion-shaft` **真的干涉**，最坏 433mm³；扫相位（半齿 = 1.57mm = 0.1571 rad）
能减到 85.8mm³ 但不为零。这是一个**设计问题**，不是工具问题了 —— 而它正是这次会话
标记为"缺缺口"、只能靠手算绕过去的那一个。

## P2-9b `check_assembly` 的两个"永远 skipped"算子

- **`motion-clearance`**：几何那一半本来就是 `distance`（会话里 if-10 就是这么写的），
  所以照常评估；运动那一半要求接口用 `params.runId` **引用证词**。引用的 run 不存在 /
  不是 motion 类 / 没通过 → hard-violation；通过则在 detail 里写明（并标注该 run 是否已被取代）。
  没引用就照常给几何结论，并在 detail 里写"运动那一半无证词"。
- **`spring-preload`**：力 = 刚度 × (自由长度 − **实测**安装长度)。需要
  `params.freeLengthMm` + `params.stiffnessNPerMm`，且 a/b 必须是弹簧自己的两端；
  缺参数时不再是一句"未实现"，而是把缺什么、为什么缺写清楚。

另外 check_assembly 的返回值现在带 `skipped` 明细（原来只有个数，所以 `overallStatus: pass`
读起来像"清单全查过了"，而会话里有两条接口从来没人评估过）。

真机：把 if-10 的 `params.runId` 指向会话自己跑过的 r023 →
`31 pass · 0 hard · 1 skipped`（会话当时是 `30 pass · 2 skipped`），detail:
`motion evidenced by r023 (干涉 0 次 · 行程 23.5mm)`。

## P2-10 阈值不再隐形

`check_assembly` 新增 `adjacencyThresholdMm`（默认 0.75），报告里落 `adjacencyThresholdMm`，
工具返回也带上；`validate_assembly` 的结论文本里写明"at a 0.75mm clearance threshold"并解释
interference / too tight / ok 三条线。验收：1.0mm 的让位间隙在默认阈值下不出现，提到 1.5 就出现。

## P2-12 `validate_assembly` 的报告不再是 120 对原始 JSON

按 worst-first 排序（干涉在前，其次间隙从大到小…即从紧到松），最多列 24 行，
其余用 `… and N more pair(s), all with a gap ≥ X mm` 收尾，并指向
`runs/<id>/report.json`。16 件 120 对的那种调用，文本从 ~15KB 降到 ~1KB 量级且不丢决策信息。

## P2-13 渲染图旁边给尺度

`generate_part` 的返回值新增 `sizeMm` / `bboxMin` / `bboxMax`，并写进给模型看的文本
（四视图本身没有坐标轴和尺寸标注，这一点也在文本里说清楚）。验收：88×30×12 的方块报得一致。

## P2-11 参考图被图预算最先丢 —— 只做到"让 agent 知道"

这一条**没有真正修好**：offload 是 DSH 自己的 `offloadRequestImagesWithPolicy()`
（最老的先丢，用户附件没有豁免概念），插件只能设 `maxImagesPerRequest` / quantum，
改不了"谁先被丢"。所以做的是：skill 里明确写"你收到的参考图大约五轮渲染之后就会从上下文里
消失，第一条用户消息里会留下带本地路径的占位符 —— 在声称外形相符之前、以及收尾之前，
用 `read_image` 把它读回来看"。要真正修，得在 harness 侧加"用户附件不参与 offload"。

## 仍然没做

- `simulate_fluid` 的算子/成本模型；`check_assembly` 的 `flow` 算子（L2 仍 skipped）；
- `measure_distance` 的吸附歧义提示；
- 很"高"零件四视图 framing 偏紧（`renderStlFramePng` 公有行为）；
- `simulate_motion` 的 pivot 只影响运动学，`simulate_physics` 走 rapier 的质心，两者对
  "零件该绕哪里转"的约定仍不完全统一（若某天要合并，需要一次坐标模型统一）。

工具数仍是 14（P2 没有新增工具，只扩了参数与算子）。
