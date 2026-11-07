# ToyMarker · dsh-cad-harness

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](docs/user/install.md)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey.svg)](docs/user/limits.md)
[![Status](https://img.shields.io/badge/status-0.1.0%20%E5%AE%9E%E9%AA%8C%E6%80%A7-orange.svg)](docs/user/limits.md)

> **用自然语言描述零件，得到经过验证、可直接打印的模型。**

本插件不是建模界面。几何生成已不是瓶颈，瓶颈在于**确认结果是否正确**：能生成但无法验证的系统只能产出“看起来对”的结果。本插件把「生成 → 验证 → 迭代 → 交付」做成闭环，需要判断的环节保留给人。

- 描述需求后，由 Agent 编写代码、编译、渲染，并**先自行判读图像**再提交结果
- 引擎提供**数值**：尺寸、体积、壁厚、间隙、干涉、运动行程、流体趋势
- 每一版均为**不可变版本**，可浏览、钉住、对比
- 第三方件（STL / STEP / 3MF / DXF）可进入同一套检查并参与装配

**文档分三类**：用户看 [docs/user/](docs/user/)，Agent 看 [docs/llm/](docs/llm/)，维护者看 [docs/dev/](docs/dev/)。

## 快速开始

```bash
# 1. 安装（本地路径；分发方式待定）
dsh plugin --profile <你的 profile> add -w /path/to/dsh-cad-harness
cd /path/to/dsh-cad-harness && pnpm run build
node scripts/sync-cad-preset.mjs
```

2. 新建会话时选预设 **「造物模式」**（普通会话看不到 CAD 工具，这是有意的）。
3. 直接描述需求：

> 做一个 60×40×8 的安装板，四角 M3 沉头孔，中心一个 20mm 通孔。

接下来：

- 完整流程与你要做的判断 → [从描述到交付](docs/user/workflow.md)
- 五层检查各回答什么、报告怎么读 → [验证能力](docs/user/verification.md)
- 它现在做不到什么 → [边界](docs/user/limits.md)
- 安装细节、首次准备、排错 → [安装](docs/user/install.md) / [故障排查](docs/user/troubleshooting.md)

## 证据验证（V1）

```bash
cd dsh-cad-harness
node scripts/verify.mjs /path/to/project --advisory
node scripts/verify.mjs /path/to/project --block --strict
```

`verify` 只读：检查 `requirements / model / fit / make / review / delivery` 六行，报告
缺失/过期的证据和 claim witness；不跑 CAD、不写 run、不判设计。

- 默认 advisory（exit 0）；`--block` 时 pass 0 / warn 1 / blocked|fail 2 / 用法错误 3；
  `--strict` 让 warn 也返回 2。
- claims：`<project>/claims.json` 或 `--claims <file>`；policy：
  `<project>/evidence-policy.json` 或 `--policy <file>`；没有 policy 就是 advisory。
- 项目特定判据可写成 `<project>/checks/<id>/`，先 `check-register` 注册，再用 `--checks`
  启用；负样本先过门，逐判据对账，写项目即作废；默认 `warn`，`--mount-checks` 可在画图前
  只验证检查本身。晚注册的检查只作旁证，不能当 claim witness。
- 详见 [docs/llm/verify.md](docs/llm/verify.md)。

## 文档

| 文档 | 讲什么 |
|---|---|
| [docs/README.md](docs/README.md) | 文档地图与“同一事实一个权威”的规则 |
| [docs/user/](docs/user/) | 用户指南：安装、流程、验证、边界、排错 |
| [docs/llm/](docs/llm/) | Agent 参考：引擎边界、陷阱、交付纪律 |
| [docs/dev/](docs/dev/) | 维护者入口：架构、设计、决策、计划、审计 |
| [examples/README.md](examples/README.md) | 样例索引：当前 / 历史 / 夹具 / 题库 / 沙箱 |
| [HARNESS.md](HARNESS.md) | 它是什么、不是什么、边界与取舍原则 |
| [DESIGN.md](DESIGN.md) | 当前设计：架构、模块、接口、环境变量全集 |

## 参与贡献

- 完整规则见 [CONTRIBUTING.md](CONTRIBUTING.md)：每次提交都要 `git commit -s` 签名（DCO 1.1）；DCO 不是 CLA。
- 提交信息按 [AGENTS.md](AGENTS.md) 写 `Why` / `Verified` / `Risk`（有方向取舍时加 `Decision`）。`Verified` 必须能指名一个可证伪的观察。
- 方向性决策写进 [docs/DECISION-LOG.md](docs/DECISION-LOG.md)（append-only）。
- 题库里的第三方素材一律物化使用、不入库（见 [examples/bench/ATTRIBUTION.md](examples/bench/ATTRIBUTION.md)）。

## 许可证

Apache License 2.0 —— 全文见 [LICENSE](LICENSE)，第三方声明见 [NOTICE](NOTICE)，审计明细见 [docs/THIRD-PARTY-AUDIT.md](docs/THIRD-PARTY-AUDIT.md)。

允许商业使用、修改、闭源再分发与售卖，只需保留版权与许可声明；另含显式专利授权与专利报复条款。

BOSL2（BSD-2-Clause）**不随仓库分发**：自行下载放到 `lib/BOSL2/`（已 gitignore）。
