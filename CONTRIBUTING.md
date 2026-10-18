# 参与贡献

- 编码与提交纪律见 [AGENTS.md](AGENTS.md)（提交信息必须写 `Why` / `Verified` / `Risk`）；
- 方向性取舍写进 [docs/DECISION-LOG.md](docs/DECISION-LOG.md)（append-only，不回改历史条目）；
- 提交贡献即表示你同意按本项目的许可（[Apache-2.0](LICENSE)）分发你的贡献，并需按下文**签名**。

---

## 一、签名（DCO）——每个提交都要

本项目采用 **Developer Certificate of Origin 1.1（DCO）**：不用签纸质协议，只需在每次提交时
**签名**（sign-off），声明你有权按本项目许可提交这份贡献。

```bash
git commit -s -m "fix(compile): ..."      # -s 会自动追加下面这一行
# Signed-off-by: 你的名字 <你的邮箱>
```

- 姓名与邮箱**必须真实可联系**（用 `git config user.name` / `user.email` 设好即可）；
- **忘了签名**：`git commit --amend -s --no-edit`（已推送则再跑一次 `git push --force-with-lease`）；
  一串提交都漏了可以用 `git rebase --signoff <base>` 补；
- 没签名的 PR 会被要求补上后再评审——这条不放宽。

### DCO 1.1 全文

```text
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

### ⚠️ DCO **不是** CLA——这条限制请先读

| | DCO（本项目采用） | CLA（本项目**未**采用） |
|---|---|---|
| 贡献者保留版权 | ✅ 保留 | 通常保留（或转让，视版本） |
| 本项目可分发该贡献 | ✅ 按 Apache-2.0 | ✅ |
| **本项目可换许可**（如日后改 AGPL） | ❌ **不行**——换许可需要每位贡献者另行同意 | ✅ 通常可以（CLA 里含"永久、不可撤销、可再许可"的授权） |
| **本项目可做商业双许可** | ❌ 不行 | ✅ 通常可以 |
| 贡献者参与成本 | 极低（一行 sign-off） | 较高（签协议） |

**结论：** 本项目选择 DCO 是为了**降低参与门槛**。代价是**对第三方贡献，本项目不能单方面更换
许可或做商业双许可**——那些贡献者的代码仍按 Apache-2.0 授权给所有人。

若维护者将来确实需要"可换许可 / 商业双许可"，必须先改为 **CLA**，而且**必须在外部贡献到来之前**
定下来（CLA 不能追溯约束已经提交的贡献，除非逐一取得同意）。这条已记进
[DECISION-LOG](docs/DECISION-LOG.md)。

---

## 二、报告问题 / 提需求

- 说清**现象、期望、复现步骤**，附上你运行的命令与完整报错；涉及几何问题时附上最小 `.scad` 片段。
- 本项目的可信度建立在"**可证伪**"上：请尽量给出**一个能推翻结论的观察**（哪个数字不对、哪个
  反例出现）。只说"结果不对"很难定位。

## 三、改进代码

```bash
# 开发与构建
pnpm install
pnpm run build          # 改过源码后必须重建；宿主部分不热重载，需重启 dsh

# 验收脚本（每个能力都有对应的 accept-*.mjs）
node dsh-cad-harness/scripts/accept-bosl2.mjs          # 校验 OPENSCADPATH ↔ BOSL2 接线
ls dsh-cad-harness/scripts/accept-*.mjs                # 其余同名脚本同理
```

提交前请确保：

1. `pnpm run build` 通过；
2. 你改动的能力对应的 `accept-*.mjs` 脚本通过（**跑不过就别提交，或在 `Risk:` 里说明为什么**）；
3. 提交信息按 [AGENTS.md](AGENTS.md) 写满 `Why` / `Verified` / `Risk`；
4. `git commit -s` 签名。

## 四、文档与决策

- `README.md` 面向用户，只装"用户看得见的变化"；内部开关与诊断项进 `DESIGN.md`；
- "当前设计"进 `DESIGN.md`，"为什么这么选"进 `docs/DECISION-LOG.md`（只追加）；
- 已归档的执行摘要（`docs/archive/execution_summaries/`）**不回改**。

## 五、第三方素材与依赖

- **素材一律物化使用、不入库**：图片、模型、语料等放在仓库外，仓库只留授权登记与测量数字
  （见 [examples/bench/ATTRIBUTION.md](examples/bench/ATTRIBUTION.md)）；
- 新增依赖前先确认许可：本项目为 Apache-2.0，**不接受把 GPL/AGPL/LGPL 代码链接进本仓库**；
  以独立程序调用的外部工具（如 OpenSCAD）不受此限，但要在
  [docs/THIRD-PARTY-AUDIT.md](docs/THIRD-PARTY-AUDIT.md) 里登记。

## 六、许可

贡献以 [Apache License 2.0](LICENSE) 进入本项目；版权归属见 [NOTICE](NOTICE) 与 [LICENSE](LICENSE)
附录。你保留自己贡献的版权。
