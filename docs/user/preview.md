# 0.1.0 预览版说明

> **这是预览版，不是生产放行系统。** 它已经能装、能自检、能验证、能交付，但不承诺工业级
> 公差、认证精度或长期支持。请把它当"可用的实验仪器"，不是"合格证"。

## 这一版有什么

- 自然语言 → OpenSCAD 零件 → 编译、渲染、版本库；
- 五层验证：几何 / 装配 / 刚体与机构 / 流体 / 工艺；
- 装配契约（BOM + ICD）、交付审计、证据 CLI；
- 风险标注导出：交付审计被 blocked 时仍可导出，但会弹窗确认、文件名带 `_UNVERIFIED`、
  并在项目 `exports/<id>/` 留下 manifest 与 findings；
- 环境自检：`dsh-cad-doctor` 一条命令区分"没装好 / 没配好 / 项目坏了 / 能力缺包"。

## 安装

见 [安装与首次准备](install.md)。预览版的最小路径：

```bash
dsh plugin --profile <profile> add -w /path/to/dsh-cad-harness
npx dsh-cad-setup          # 写入本机 skill 路径
npx dsh-cad-backend --show # 查看当前内核/编译后端
npx dsh-cad-doctor         # kind=ok 才算装好
npx dsh-cad-verify <project> --advisory  # 六行证据报告（只读）
# 重启 dsh
```

OpenSCAD 由用户自行安装（>= 2025.06 才有 Manifold 后端）；插件不随包分发 OpenSCAD，
也不要求它必须是唯一后端——预览版只实现了 OpenSCAD 适配器，CadQuery/FreeCAD 在菜单里
显示为 `planned`，不可选、不静默替代。

## 已知边界

- **审批/回滚**：可以浏览、钉住、对比版本；没有 approve / 一键 rollback。
- **Python 运行时**：首次使用会下载约 400MB，可能需要几分钟；断网会失败并给出下一步。
- **BOSL2**：可选；标准件需要，缺失时报告会说明，不会静默产出空几何。
- **内核**：预览版只有 OpenSCAD。第二内核已列入中远期第一项，不是本版承诺。
- **长任务**：渲染/仿真目前没有独立的 job id / cancel 协议；超时会被报告，不会被当成通过。
- **导出**：`_UNVERIFIED` 是提示，不是安全边界；改名不会改变 manifest 里的判定。

## 怎么报告问题

请附上：

1. `npx dsh-cad-doctor --json` 的输出（或至少 `kind` 与失败项）；
2. 操作系统、dsh 版本、OpenSCAD 版本；
3. 复现步骤（哪句话、哪个按钮）；
4. 原始报错文本，不要只写"失败了"。

## 数据放在哪

- 项目语料：项目目录下 `cad-data/`（版本、运行、导出记录 `exports/`）；
- 运行时：`$DSH_HOME/cad/runtime/`；
- 内核/编译后端选择：`$DSH_HOME/cad/backend.json`；
- 卸载插件不会删除项目语料；删项目目录才会删语料，请先备份。

## 这一版之后

近期优先：异步作业/取消、错误分类、Python 首启进度、UI 剩余批次。
中远期第一项：第二几何内核（CadQuery 优先）。完整顺序见
[`docs/dev/TODO.md`](../dev/TODO.md)。
