[English](../en/user/preview.md) | 中文

# 0.1.1-preview.1 预览版说明

> **这是预览版，不是生产放行系统。** 它已经能装、能自检、能验证、能交付，但不承诺工业级
> 公差、认证精度或长期支持。请把它当"可用的实验仪器"，不是"合格证"。

## 这一版有什么

- 自然语言 → OpenSCAD 或 CadQuery 零件 → 编译、渲染、版本库；
- 模型调用面从 39 个工具收成 **9 个作业面**（`cad_session`/`cad_part`/`cad_assembly`/
  `cad_check`/`cad_simulate`/`cad_inspect`/`cad_see`/`cad_python`/`cad_deliver`），
  参数按 `action` 展开；
- 标准件目录 v0：99 个规范件，预生成 STEP/STL（fit / visual 两档），随包分发；**但本版还没有
  `cad_part` 的目录选择/导入操作**，详见 [标准件目录](../llm/library.md)；这与可选的 BOSL2 建模库不是一回事；
- 五层验证：几何 / 装配 / 刚体与机构 / 流体 / 工艺；
- 装配契约（BOM + ICD）、交付审计、证据 CLI；
- 回放导出：运动回放的工具栏有 **GIF** 和 **WebM** 两个按钮，按**当前视角**导出整段轨迹（浏览器内完成，不上传）；GIF 用自带的 256 色调色板编码器。
- 截图两种去处：**截图** 把当前帧（含标注框）发进会话；**存图** 把同一张图存成 PNG 下载。
- 风险标注导出：交付审计被 blocked 时仍可导出，但会弹窗确认、文件名带 `_UNVERIFIED`、
  并在项目 `exports/<id>/` 留下 manifest 与 findings；
- 环境自检：`dsh-cad-doctor` 一条命令区分"没装好 / 没配好 / 项目坏了 / 能力缺包"。

## 安装

见 [安装与首次准备](install.md)。预览版的最小路径：

```bash
tar -xzf dsh-cad-harness-0.1.1-preview.1.tgz
dsh plugin --profile <profile> add -w "$PWD/package"
cd package
npx dsh-cad-setup          # 写入本机 skill 路径
npx dsh-cad-backend --show # 查看当前内核/编译后端
npx dsh-cad-doctor         # kind=ok，或有解释的 degraded
npx dsh-cad-verify <project> --advisory  # 六行证据报告（只读）
# 重启 dsh
```

OpenSCAD 由 `setup --openscad=auto` 自动准备：已有 2025.06+ 系统版本就直接用；否则官方快照优先，
官方不可达或持续过慢才切 OSS 镜像。2021.01 可跑但 `doctor` 报 degraded。插件不随包分发 OpenSCAD，
也不要求它必须是唯一后端——本版提供 OpenSCAD 与 CadQuery；CadQuery 需要显式安装约 1.6 GiB pack（setup 不自动下载），
FreeCAD 仍显示为 planned、不可选。

## 已知边界

- **审批/回滚**：可以浏览、钉住、对比版本。Agent 可以提议回退，你在面板里批准后生成新版本；没有独立的“版本审批 / 签核”流程。
- **Python 运行时**：首次使用会下载约 400MB，可能需要几分钟；断网会失败并给出下一步。
- **BOSL2**：可选 OpenSCAD 建模库；使用它的螺纹/齿轮/螺丝模块时需要，缺失时报告会说明，不会静默产出空几何。
- **内核**：OpenSCAD + 可选 CadQuery；一个项目一个作者内核，旧版本按自身 pin 不变；OpenSCAD 仍是渲染/导出常驻依赖。
- **长任务**：后台编译 job 已有 submit/status/cancel/timeout/重启恢复；渲染、仿真仍同步，超时会被报告，不会被当成通过。
- **英文界面**：客户端可见文案已全部走 i18n（zh/en 同 key，`accept:ui-i18n` 校验字面量），
  深层面板也已英文化（preview.2 起）。host 的模型侧工具输出/诊断仍是中文。
- **英文文档**：英文用户文档已全套（README、install、preview、limits、workflow、verification、configuration、troubleshooting、advanced），HARNESS 也有英文版；`docs/llm` 也有英文版；`docs/dev` 暂时中文。
- **导出**：`_UNVERIFIED` 是提示，不是安全边界；改名不会改变 manifest 里的判定。`difficult` 导出会弹一次警告，但文件名不变。
- **schema/迁移**：旧项目可开；未知的新 schemaVersion 会被 `doctor` 拒绝；没有自动迁移器，迁移前必须备份。
- **CI**：GitHub Actions workflow 已写，但本机网络暂时无法实际跑；本地 `rehearse:preview` 是等价演练。

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

近期优先：渲染/仿真 job、Python 首启进度；示例语料重跑（windup 等）安排在 0.2。
中远期第一项：第二几何内核（CadQuery 优先）。完整顺序见
[`docs/dev/TODO.md`](../dev/TODO.md)。
