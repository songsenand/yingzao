# 实验报告：DXF/STEP 导入链路探针（trimesh + cascadio + ezdxf）

## 目标
> 在把 trimesh + cascadio + ezdxf 组合接入 `op_import_mesh` 之前，用数字验证三条转换链路：
> STEP→GLB→numpy 的单位/多体/公差行为、IGES 在 cascadio 下的真实行为、DXF 的
> 2D 轮廓挤出与 3D 网格实体方案。

## 假设
> ① STEP 经 cascadio（内置 OCCT）→ GLB → trimesh 可得闭合实体网格，单位可预测；
> ② cascadio 按其 README 不支持 IGES（失败方式未知，需实测）；
> ③ DXF 2D 轮廓可用已在锁内的 manifold3d `CrossSection`(EvenOdd)+`extrude` 挤出成
>    实体，无需引入三角化新依赖（earcut/triangle）；DXF 3D 网格实体可走 STL 同款
>    "三角形汤→weld→Manifold" 尾流。

## 方法
> 探针 venv（python 3.14.8）：`trimesh 5.1.1 + cascadio 0.1.1 + ezdxf 1.4.4 +
> manifold3d 3.5.4 + shapely`。STEP/IGES 样本取自 cascadio 上游测试模型
>（GitHub API raw 抓取；raw.githubusercontent 直连被墙，走 api.github.com）。
> DXF 样本由 ezdxf 现场生成（LWPOLYLINE 方形 40×40 + CIRCLE 半径 6 内孔 +
> $INSUNITS=4/1 两个单位版本、POLYFACE 20mm 盒、二进制 DXF）。判定一律用
> manifold3d `Manifold(Mesh(...))`（项目的真值判定），不用 trimesh 的宽松
> `is_watertight`。

## 结果
> **A. STEP 链路（全部 Manifold NoError）**
>
> | 样本 | 体数 | 三角形 | 体积（×1000 后 mm³） | genus | 耗时 |
> |---|---|---|---|---|---|
> | colored.step（FreeCAD 导出，half_round_screw） | 1 | 3074 | 242.2 | 0 | 43ms |
> | material.stp | 1 | 12 | 107231.1 | 0 | 3ms |
> | featuretype.STEP | 1 | 8326 | — | — | 51ms |
> | multibody.step | **10** | 3940 | 263544.1 | 12 | 116ms |
>
> **单位**：GLB 声明 `meters`，原始数值是米（colored bbox 0.01×0.01×0.02 m =
> 10×10×20 mm）。**转 mm 必须乘 1000**。乘完 Manifold 体积/genus 全部成立。
> trimesh 自身 `volume=0.0`/`watertight=false` 是未焊接重复顶点 + 米制数值舍入
> 的显示假象，不影响焊接后的 Manifold 判定。
>
> **公差**：`tol_linear` 越小三角形越多：None(default)≈0.01 → 3074；0.002 →
> 12254；0.0005 → 49420；体积收敛 242.2→242.9（<0.3%）。默认公差体积误差已
> 在亚毫米量级。
>
> **B. IGES**：`cascadio.step_to_glb('microstrip.igs')` **不抛异常、不写输出
> 文件**，stderr 打 `ERR StepFile ... expecting STEP`。→ 必须以"输出文件不存在"
> 为失败判据，不能依赖异常。
>
> **C. DXF**：
> - 2D 轮廓挤出（CrossSection EvenOdd + extrude 10mm）：体积 **14870.5mm³** ≈
>   理论 14869.3mm³（差 = flattening 0.01 的离散），genus 1（内孔 ✓），
>   `status == Error.NoError` ✓，6ms。
> - `$INSUNITS`：`doc.units` 可读（4=mm、1=inch），几何数值不变 → 换算系数在
>   读取端按表应用（1in=25.4、2ft=304.8、4mm=1、5cm=10、6m=1000，其余按无单位
>   处理并告警）。
> - POLYFACE 盒：disassemble → n-gon 扇形三角化 → weld(8 顶点) → Manifold
>   体积 **8000.0mm³ 精确**、genus 0、NoError。
> - 二进制 DXF：`doc.write(stream, fmt='binary')`（**必须传流，不能传路径**），
>   ezdxf 自动识别回读 ✓（13.5KB，2 实体）。
> - ezdxf 会向 stderr 打 "Cannot create cache home directory"（容器无
>   `~/.cache`）——worker 侧设 `EZDXF_CONFIG_DIR` 到 scratch 消音。

## 分析
> ① 假设全部成立：STEP 数值可预测（米→mm ×1000）、闭合性由 Manifold 背书；
> ② IGES 的失败方式是"静默不产出"，比抛异常更危险，必须在 op 里显式检查输出
>    文件并在 TS 侧保留格式边界消息；
> ③ manifold3d CrossSection 方案让 DXF 挤出**零新增依赖**（earcut/triangle 都
>    不需要），且产物直接是真值引擎自己的实心表示——与 STL 导入共用同一条
>    weld→scale→Manifold→写 STL 尾流，实现面最小。

## 遇到的问题
> - trimesh 未焊接网格的 `volume`/`is_watertight` 不可作为判据（0.0/false 假象），
>   一切判定走 Manifold——与项目现有纪律一致。
> - raw.githubusercontent.com 连接被重置（exit 35），改走 GitHub API raw accept。
> - pybind11 枚举不等于 int（`status() == 0` 恒 False），必须用 `Error.NoError`
>   比较——首轮探针的 status_ok:false 是检查方式错误，非数据问题。
> - cadquery 2.4 在 python 3.14 无 OCP 7.x 轮子，放弃其作为样本生成器，改用
>   cascadio 上游测试模型（更贴近真实第三方交付物）。
> - **实装后由 worker 驱动脚本补抓的三个坑**（probe 阶段未暴露）：
>   ① 单位换算的双重施加——loader 预×1000 后 op 又乘 native 系数（体积 ×1e9），
>   定稿为"loader 交原生单位汤、op 恰好乘一次"，且 native≠1 时**先换算再 weld**
>   （weld 量化网格按 mm 调，米制数值会粗化 1000 倍）；`appliedScale` 报告值与
>   变换值分离。② `ezdxf.recover` 是子模块且**读不了二进制 DXF**——按
>   "AutoCAD Binary DXF" 魔数分派 `ezdxf.readfile`。③ `depthMm` 语义定为
>   **存储系毫米，不随 $INSUNITS 缩放**（英寸图纸 + depthMm=10 = 真实尺寸轮廓
>   ×10mm 厚，比例恰为 25.4²）；fixture README 基线随之从 25.4³ 修正为 25.4²。

## 产物列表
> **脚本**
> - `experiments/20261015_cad_import_probe/probe.py` —— 三条链路首轮验证
> - `experiments/20261015_cad_import_probe/probe2.py` —— 五个遗留问题收口
>
> **数据**
> - `experiments/20261015_cad_import_probe/data/` —— colored.step / material.stp /
>   featuretype.STEP / multibody.step / microstrip.igs（cascadio 上游
>   `tests/models/`，MIT 仓库；下载 2026-10-15）+ profile-mm.dxf /
>   profile-inch.dxf / polyface-box.dxf / profile-bin.dxf（ezdxf 1.4.4 生成，
>   生成代码见 probe.py）
>
> **输出**
> - `experiments/20261015_cad_import_probe/result.json` / `result2.json` —— 原始数据
> - `experiments/20261015_cad_import_probe/probe.py` 内嵌各 DXF 样本的生成逻辑
>
> **运行命令**
> ```bash
> python3 -m venv .tmp-cadprobe/venv
> .tmp-cadprobe/venv/bin/pip install -i https://mirrors.aliyun.com/pypi/simple \
>   numpy trimesh cascadio ezdxf manifold3d==3.5.4 shapely
> cd experiments/20261015_cad_import_probe
> ../.tmp-cadprobe/venv/bin/python probe.py
> ../.tmp-cadprobe/venv/bin/python probe2.py
> ```
>
> **环境依赖**：python ≥3.13（探针机 3.14.8；插件 venv 为 3.13.16）、网络可达
> pypi.org 或 mirrors.aliyun.com、api.github.com（取样本时）。

## 结论与下一步
> 结论：trimesh + cascadio + ezdxf 组合按下列参数接入 `op_import_mesh`：
> STEP ×1000 归 mm（unit 参数仅接受 mm/缺省，scale 叠加）；DXF 按 $INSUNITS
> 换算、2D 必须 `depthMm`、走 CrossSection.extrude；IGES 保留边界消息；
> cascadio 输出不存在视为解析失败。
> 下一步：依赖进 requirements.lock（cascadio==0.1.1 exclude musl、ezdxf==1.4.4）、
> worker/TS 实装、验收脚本 `accept-import-cad.mjs` 用本目录样本。
