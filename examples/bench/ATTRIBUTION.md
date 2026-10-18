# 题库素材来源与许可清单

> 一题一行。**规则**：第三方几何一律**不入库**——仓库只放"物化脚本 + 钉死的 upstream
> commit + 校验和"，运行时取到仓库外。本清单是题库素材来源的**唯一权威副本**；
> 各 `materialize.mjs` 里的 `license` 字段是它的运行时副本。
>
> **不得把网络检索到的图片、模型、音频入库**——无论是否经过 AI 修改（AI 修改不改变权利归属）。

| 题 | 素材 | 来源 | 许可 | 入库？ | 取得方式 |
|---|---|---|---|---|---|
| 00-smoke | 无外部素材 | — | — | — | — |
| 01b-diagnosis | `dossier/`（JSON 证据子集） | 本项目 microscope5 语料 | 本项目 | ✅ | `tools/materialize-01b.mjs`（本地语料） |
| 01-mortise-bench | 无外部素材 | — | — | — | — |
| 02-steam-engine | `assets/608.stl` | 本项目自产 | 本项目 | ❌ 生成物 | `graders/02-steam-engine/assets/make-608.scad` 生成一次 |
| 03-microscope | `参考图.png` | **Pixabay 开放版权插画（经本项目编辑）** | Clker-Free-Vector-Images / Pixabay | ⛔ 物化不入库 | 见下方"03 参考图来源与编辑" |
| 04-rack-connector | `mainRail.stl`、`rackJoiner.stl` | `jazwa/rackstack` @ `8e296e935aad89a6d1a5023da79becc634c10c2d` | MIT | ❌ | `graders/04-rack-connector/materialize.mjs`（git 稀疏取，仓库外缓存） |
| 05-rack-assembly | 同 04 | 同 04 | MIT | ❌ | `graders/05-rack-assembly/materialize.mjs` |
| 06-measure | `part.stl`、`part-b.stl` | 本项目自产 | 本项目 | ✅ 刻意入库 | 评分方 `build-parts.mjs` + `ground-truth.mjs` |

## 纪律

1. **新增第三方素材**：先定"入库还是物化"，**物化优先**；定完在本清单加一行。
2. **网络检索物一律不入库**，包括"经 AI 修改"的版本——AI 修改不产生新的权利来源。
3. 物化脚本必须钉死 upstream commit，并对全部取用文件算树摘要（04/05 已如此）。
4. 本清单**不代替许可结论**：本仓根目录的 LICENSE 仍在定夺中；定下后本清单只补"与本仓许可的关系"。

## 历史清理（2026-10-16）

- **03 的参考图原为"网络检索照片 + AI 去水印"**，属来源不明的第三方素材，已替换为本项目自绘
  的 SVG 技术插图；原始文件只保留在本地，**不入库、不再分发**（`.gitignore` 有对应规则），
  本地副本供对照用、发布前不得复制回仓库。

### 03 参考图来源与使用（2026-10-16）

**素材**：Pixabay content id **34792**，作者 **Clker-Free-Vector-Images**，
**Pixabay Content License**（可商用、可修改、不强制署名；本项目仍署名）。

署名文本（展示该图时原样带上）：

```html
该图片由<a href="https://pixabay.com/zh/users/clker-free-vector-images-3736/?utm_source=link-attribution&utm_medium=referral&utm_campaign=image&utm_content=34792">Clker-Free-Vector-Images</a>在<a href="https://pixabay.com/zh//?utm_source=link-attribution&utm_medium=referral&utm_campaign=image&utm_content=34792">Pixabay</a>上发布
```

**存放规则**：与题库其它第三方素材一致——**物化使用、不入库**。授权原件与归一化后的成品放在仓库外
（本地 `.local-archive/03-clker/`，已 gitignore），仓库里只留这条登记与 `landmarks.json` 里的数字。

**本项目对画面内容做的修改：无。** 只做了技术性归一化：合成白底 → 按黑色描边定裁剪框 →
缩放到画布 88% 高 → 居中放在 1024² 白底上。

**图中台下反光镜的处理**：**不删**。题面把它定义为**外购件**（不建模镜体），
C 臂下端 / 台下支架只需给一个 **M3 接口**。这样参考图可以原样使用，
接口本身由 `c-accessory-interface` 机检。

**备选素材（未采用）**：Pixabay content id **7445204**（Dimuth Amarasiri）——更精致、有马蹄底座与
两个同轴旋钮，但带物镜转换器；若日后要用，需在其矢量原件里删组。
