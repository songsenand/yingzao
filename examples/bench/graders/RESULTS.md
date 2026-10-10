# 测评跑通结果 · 逐条判据表（2026-10-10）

来源：`bench-score.mjs` 对每个 run root 的机检输出（`scores/*.score.json`）。
✅ 过 · ❌ 不过 · ❓ 需人判（语义项，机检记 UNKNOWN）· — 未实现/不适用。

## 00-smoke（仪器校准，无会话，单次）

| 判据 | 结果 |
|---|---|
| `g-grader-access` | ✅ |
| `g-openSCADPATH` | ✅ |
| `g-watertight` | ✅ |
| `g-render-count` | ✅ |
| `g-set-datums-no-version` | ✅ |
| `g-negative-control-fires` | ✅ |
| `g-motion-ratio` | ✅ |
| `g-pivot-rebased` | ✅ |
| `g-static-friction` | ✅ |
| `g-fluid-runs` | ✅ |
| `g-merge-shells` | ✅ |
| `g-delivery-audit` | ✅ |
| `g-bosl2-gears` | ✅ |
| `c-measure-part` | ✅ |
| `c-measure-close` | ✅ |
| `c-connectivity` | ✅ |
| `c-printability-thin` | ✅ |
| `c-interference` | ✅ |
| `c-fluid-arrival` | ✅ |

> 13 硬门 + 6 数值全部通过（64.1s 墙钟）。

## 01-mortise-bench（headless · deepseek-official/deepseek-flash · 3 轮）

### 硬门与数值判据

| 判据 | r01 (作废) | r02 | r03 | 读法 |
|---|---|---|---|---|
| `g-grader-access` | ❌ | ✅ | ✅ | 2 过 / 1 不过 |
| `g-negative-control-fires` | ✅ | ✅ | ✅ | 全过 |
| `g-negative-reverted` | ✅ | ✅ | ✅ | 全过 |
| `g-hard-zero` | ✅ | ✅ | ✅ | 全过 |
| `g-undeclared-found` | ❌ | ❌ | ❌ | 全不过 |
| `g-one-version-per-repeated-part` | ✅ | ✅ | ✅ | 全过 |
| `g-coaxial-not-two-points` | ✅ | ✅ | ✅ | 全过 |
| `g-datums-declared` | ✅ | ✅ | ✅ | 全过 |
| `g-no-metal-fasteners` | ✅ | ✅ | ✅ | 全过 |
| `c-grain-axis-correct` | ✅ | ✅ | ✅ | 全过 |
| `c-across-grain-looser` | ✅ | ✅ | ✅ | 全过 |
| `c-gaps-in-range` | ✅ | ✅ | ✅ | 全过 |
| `c-shoulder-seats` | ✅ | ✅ | ✅ | 全过 |
| `c-blind-tenon-shorter` | ✅ | ✅ | ✅ | 全过 |
| `c-protrusion` | ✅ | ❌ | ❌ | 1 过 / 2 不过 |
| `c-interface-count` | ✅ | ✅ | ✅ | 全过 |
| `c-measured-vs-datum` | ❓ | ❌ | ❌ | 全不过 |

> r01 整轮作废：`g-grader-access` 命中（考生 `cat graders/01-mortise-bench/{rubric,key,prompt}`）。
> 两轮有效（r02/r03）共同短板：`g-undeclared-found` 全空（故意不声明的 0.4mm 让位间隙没被抓出）、**零 `measure_distance`**（出榫 5mm 未测、两条路径同数未演示）。

## 01b-diagnosis（headless · 两轮实验：手册 A/B）

### deepseek-official/deepseek-flash · 候选臂（380 行手册）

| 判据 | cand-r01 | cand-r02 | cand-r03 | 读法 |
|---|---|---|---|---|
| `g-grader-access` | ✅ | ✅ | ✅ | 全过 |
| `g-motion-never-checked` | ❌ | ❌ | ❌ | 全不过 |
| `g-whole-machine-failed` | ✅ | ✅ | ✅ | 全过 |
| `g-no-green-claim` | ❓ | ❓ | ❓ | 0 过 / 0 不过 |
| `g-evidence-cited` | ❌ | ❌ | ✅ | 1 过 / 2 不过 |
| `g-distinguish-notdone-vs-failed` | ❓ | ❓ | ❓ | 0 过 / 0 不过 |
| `c-interface-count` | ✅ | ✅ | ✅ | 全过 |
| `c-motion-typed-count` | ✅ | ✅ | ✅ | 全过 |
| `c-whole-machine-runs` | ✅ | ✅ | ✅ | 全过 |
| `c-post-subset-sizes` | ✅ | ✅ | ✅ | 全过 |
| `c-stale-visual` | ✅ | ✅ | ❌ | 2 过 / 1 不过 |
| `c-local-as-whole` | ✅ | ✅ | ✅ | 全过 |
| `c-evidence-depth` | ✅ | ✅ | ✅ | 全过 |
| `c-anchoring` | ❓ | ❓ | ❓ | 0 过 / 0 不过 |

### deepseek-official/deepseek-flash · 基准臂（313 行手册 8e2717f9）

| 判据 | base-r01 | base-r02 | base-r03 | 读法 |
|---|---|---|---|---|
| `g-grader-access` | ✅ | ✅ | ✅ | 全过 |
| `g-motion-never-checked` | ❌ | ❌ | ❌ | 全不过 |
| `g-whole-machine-failed` | ✅ | ✅ | ✅ | 全过 |
| `g-no-green-claim` | ❓ | ❓ | ❓ | 0 过 / 0 不过 |
| `g-evidence-cited` | ✅ | ✅ | ✅ | 全过 |
| `g-distinguish-notdone-vs-failed` | ❓ | ❓ | ❓ | 0 过 / 0 不过 |
| `c-interface-count` | ✅ | ✅ | ✅ | 全过 |
| `c-motion-typed-count` | ✅ | ✅ | ✅ | 全过 |
| `c-whole-machine-runs` | ✅ | ✅ | ✅ | 全过 |
| `c-post-subset-sizes` | ✅ | ✅ | ✅ | 全过 |
| `c-stale-visual` | ✅ | ❌ | ✅ | 2 过 / 1 不过 |
| `c-local-as-whole` | ✅ | ✅ | ✅ | 全过 |
| `c-evidence-depth` | ✅ | ✅ | ✅ | 全过 |
| `c-anchoring` | ❓ | ❓ | ❓ | 0 过 / 0 不过 |

### opencode-go/deepseek-v4.1-flash · 候选臂（压缩后 361 行）

| 判据 | cand-r01 | cand-r02 | cand-r03 | 读法 |
|---|---|---|---|---|
| `g-grader-access` | ✅ | ✅ | ✅ | 全过 |
| `g-motion-never-checked` | ❌ | ❌ | ❌ | 全不过 |
| `g-whole-machine-failed` | ✅ | ✅ | ✅ | 全过 |
| `g-no-green-claim` | ❓ | ❓ | ❓ | 0 过 / 0 不过 |
| `g-evidence-cited` | ✅ | ✅ | ✅ | 全过 |
| `g-distinguish-notdone-vs-failed` | ❓ | ❓ | ❓ | 0 过 / 0 不过 |
| `c-interface-count` | ✅ | ✅ | ✅ | 全过 |
| `c-motion-typed-count` | ✅ | ✅ | ✅ | 全过 |
| `c-whole-machine-runs` | ✅ | ✅ | ✅ | 全过 |
| `c-post-subset-sizes` | ✅ | ✅ | ✅ | 全过 |
| `c-stale-visual` | ❌ | ❌ | ✅ | 1 过 / 2 不过 |
| `c-local-as-whole` | ✅ | ✅ | ✅ | 全过 |
| `c-evidence-depth` | ✅ | ✅ | ✅ | 全过 |
| `c-anchoring` | ❓ | ❓ | ❓ | 0 过 / 0 不过 |

### opencode-go/deepseek-v4.1-flash · 基准臂（313 行）

| 判据 | base-r01 | base-r02 | base-r03 | 读法 |
|---|---|---|---|---|
| `g-grader-access` | ✅ | ✅ | ✅ | 全过 |
| `g-motion-never-checked` | ❌ | ❌ | ❌ | 全不过 |
| `g-whole-machine-failed` | ✅ | ✅ | ✅ | 全过 |
| `g-no-green-claim` | ❓ | ❓ | ❓ | 0 过 / 0 不过 |
| `g-evidence-cited` | ❌ | ✅ | ✅ | 2 过 / 1 不过 |
| `g-distinguish-notdone-vs-failed` | ❓ | ❓ | ❓ | 0 过 / 0 不过 |
| `c-interface-count` | ✅ | ✅ | ✅ | 全过 |
| `c-motion-typed-count` | ✅ | ✅ | ✅ | 全过 |
| `c-whole-machine-runs` | ✅ | ✅ | ✅ | 全过 |
| `c-post-subset-sizes` | ✅ | ✅ | ✅ | 全过 |
| `c-stale-visual` | ✅ | ✅ | ✅ | 全过 |
| `c-local-as-whole` | ✅ | ✅ | ✅ | 全过 |
| `c-evidence-depth` | ✅ | ✅ | ✅ | 全过 |
| `c-anchoring` | ❓ | ❓ | ❓ | 0 过 / 0 不过 |

> `g-motion-never-checked` 四组全不过：均命中「motion-clearance = 0」但未点出「运动类型接口 6 条」——代理项的形状要求，按 README §七 建议改为 UNKNOWN+证据。
> `skill S0`（手册是否被加载）记在 `scores/*.score.txt` 与分数文件里：deepseek-flash 3/6 轮加载；v4.1-flash 1/6 轮加载。

## 02-steam-engine（headless · opencode-go/deepseek-v4.1-flash · 1 轮 · 链路验证）

### 硬门与数值判据

| 判据 | run (42.1min/134 calls) | 读法 |
|---|---|---|
| `g-grader-access` | ✅ | 全过 |
| `g-motion-clean` | ✅ | 全过 |
| `g-negative-rod-fires` | ✅ | 全过 |
| `g-negative-printability-fires` | ✅ | 全过 |
| `g-motion-clearance-contract` | ✅ | 全过 |
| `g-import-not-generate` | ✅ | 全过 |
| `g-import-dimensions-sane` | ✅ | 全过 |
| `g-merge-shells-one` | ✅ | 全过 |
| `g-no-false-coupling` | ✅ | 全过 |
| `g-hard-zero` | ✅ | 全过 |
| `c-stroke` | ✅ | 全过 |
| `c-joint-drift` | ✅ | 全过 |
| `c-fluid-arrival` | ❌ | 全不过 |
| `c-topple-answered` | ✅ | 全过 |
| `c-counterweight` | ✅ | 全过 |
| `c-crosshead-hold` | ✅ | 全过 |
| `c-coaxial-used` | ✅ | 全过 |
| `c-interface-count` | ✅ | 全过 |

> P=0.895（10/10 硬门全过；仅 `c-fluid-arrival` 不过——该条按 graders/README §七 是"待定，不计入模型短板"）。
> S=1.0、S0=手册已加载；探针 `p-version-recall` PASS（问第 2 版活塞外径，答 Ø29.6mm ✓）。

## 03-microscope（headless 两段 · 链路验证 · 图像窗口修复后）

### 硬门与数值判据

| 判据 | run (A 244 调用 + B 56 调用，97.6min) | 读法 |
|---|---|---|
| `g-grader-access` | ✅ | 全过 |
| `g-negative-flange` | ✅ | 全过 |
| `g-negative-gear-phase` | ✅ | 全过 |
| `g-negative-chain` | ✅ | 全过 |
| `g-motion-clearance-contract` | ✅ | 全过 |
| `g-whole-machine-verified` | ✅ | 全过 |
| `g-visual-evidence-current` | ✅ | 全过 |
| `g-delivery-audit-clean` | ✅ | 全过 |
| `g-printability-no-unprintable` | ✅ | 全过 |
| `g-no-turret` | ✅ | 全过 |
| `g-optics-self-consistent` | ✅ | 全过 |
| `g-hard-zero` | ✅ | 全过 |
| `c-stroke` | ✅ | 全过 |
| `c-motion-clean` | ✅ | 全过 |
| `c-joint-drift` | ✅ | 全过 |
| `c-fine-focus-dof` | ✅ | 全过 |
| `c-coaxial` | ✅ | 全过 |
| `c-interface-count` | ✅ | 全过 |
| `c-undeclared-found` | ✅ | 全过 |
| `c-stability-answers` | ✅ | 全过 |
| `c-printability-json` | ✅ | 全过 |
| `c-measured-vs-datum` | ✅ | 全过 |
| `c-appearance-diff` | ✅ | 全过 |
| `c-stdlib-used` | ✅ | 全过 |

> 两段均 exit 0；同会话续接 ✓；参考图物化 ✓；两个探针都问了 ✓（S0=手册已加载）。
> **判据层已补齐（2026-10-10）**：26 条全部可自动判定（求值器见 bench-score.mjs 的 03 段）；P=1.0、S=1.0、两个探针全过。
> 唯一仍需人判的是外观形态（落在 rubric 的 7 条 `features`，脚本不计入 26 条），证据指针已自动摘出。
> 反向对照：同一条被 400 拒图打断的首轮，用同一批评据打分 → 多条 FAIL/UNKNOWN、P=0 ⇒ 求值器不会把残缺轮次判绿。

