# 执行摘要：import_part 接入 DXF/STEP 导入（trimesh + cascadio + ezdxf）

## 动机
> 插件导入侧此前只认 STL，`.step/.stp/.dxf` 落在"需 B-rep 内核"的边界消息里。
> 2026-10-15 用户拍板采用 trimesh + cascadio + ezdxf 组合（全 MIT；对比与探针
> 见 `docs/DECISION-LOG.md` 同日条目与 `experiments/20261015_cad_import_probe.md`），
> 把 DXF/STEP 变成一等导入格式，IGES 维持可行动边界。

## 影响范围
> - `dsh-cad-harness/python/cad_worker/worker.py`：`import_mesh` op 扩展格式分派
> - `dsh-cad-harness/src/host/import.ts`：格式策略、单位政策、depthMm 通道
> - `dsh-cad-harness/src/host/tools.ts`：`import_part` 参数/描述/schema
> - `dsh-cad-harness/scripts/gen-python-lock.mjs` + 生成的 `src/host/python-lock.ts`
> - `dsh-cad-harness/scripts/fixtures/cad-import/`（新）：验收样本
> - `dsh-cad-harness/scripts/accept-import.mjs`（第 9 项）+ `accept-import-cad.mjs`（新）

## 具体操作步骤
> 1. `gen-python-lock.mjs` PACKAGES 增补 `cascadio==0.1.1`（exclude musl，注明钉版
>    原因）与 `ezdxf==1.4.4`（纯 py，传递依赖全在锁内），重生成锁。
> 2. `worker.py`：`op_import_mesh` 按扩展名分派——`.stl` 原路不变；`.step/.stp` 经
>    `cascadio.step_to_glb`（输出文件**必须存在**，IGES 式静默失败在此显式报错）→
>    trimesh 载入 → ×1000 归 mm → 三角形汤进既有 weld→scale→Manifold→写 STL 尾流；
>    `.dxf` 经 ezdxf：有网格实体走扇形三角化+weld，否则取闭环轮廓（$INSUNITS
>    换算 ×1000 系数按表应用）经 `CrossSection(EvenOdd).extrude(depthMm)`；
>    `EZDXF_CONFIG_DIR` 指 scratch 消音。`op_versions` wanted 增 cascadio/ezdxf。
> 3. `import.ts`：SUPPORTED 扩为 `.stl/.step/.stp/.dxf`；BREP 缩为 `.iges/.igs/.brep`
>    并改写边界消息（IGES：cascadio 不支持 → FreeCAD 转 STEP/STL；STEP 已支持）；
>    STEP 的 unit 仅接受 mm/缺省（文件自带单位）；`depthMm` 通道；worker warnings
>    与 INSUNITS 系数并入 appliedScale/warnings。
> 4. `tools.ts`：`ImportPartArgs.depthMm`、描述、`format` schema 枚举更新。
> 5. 样本入库 + `accept-import-cad.mjs`（STEP 实体/多体、DXF 轮廓挤出/无 depth
>    拒收/英寸/网格实体/二进制、IGES 边界、导入件过既有 measure 工具）。

## 预期风险与验证
> - 风险点：cascadio 上游会删 PyPI 旧版（已钉 0.1.1）；musl 平台无 wheel（exclude
>    + status 披露）；GLB 单位声明若上游改为直出 mm，×1000 会翻倍——探针样本
>    与验收体积基线可即时暴露；DXF INSUNITS 冷门码位按无单位处理并告警。
> - 验证结果（2026-10-15）：
>   - `accept-import-cad.mjs` **21/21 全绿**（冷供给 45min pip 预算；cascadio
>     0.1.1 hash 校验装进 venv）：colored.step 242.209mm³/genus0；multibody
>     10 壳/263544.106mm³/genus12；scale 0.5 → 30.276 且 appliedScale=500；
>     STEP unit='inch' 拒收；DXF+depthMm=10 → 14870.529mm³/genus1；英寸
>     图纸比例 = 25.4²（depthMm 固定毫米语义）；无 depthMm 拒收；二进制=ASCII；
>     Polyface 8000.0；IGES 边界；工具门 v001 + measure_part parity 242.209。
>   - worker 驱动脚本（探针 venv）同批基线一致；实装期抓出并修掉三个 bug：
>     单位双重施加（×1e9）、`ezdxf.recover` 需显式子模块导入且不认二进制
>     DXF（按魔数分派）、appliedScale 报告值与变换值分离。
>   - `gen-python-lock.mjs --check` 一致；`tsc --noEmit` 干净。
>   - STL 回归：`accept-import.mjs` 在本沙盒**未能跑完**——两次冷供给均在
>     vtk/jaxlib 大轮子下载上撞 45 分钟 pip 超时（同日好网络窗口曾 25 分钟装完，
>     属环境波动）；已用两个替代实证补位：① 两个真实语料 STL 过 `op_import_mesh`
>     体积与 trimesh 参考逐位一致（7843.842 / 8793.867 mm³），STL 分支行为不变；
>     ② 9a/9b 断言的新文案经静态匹配验证。**待办：网络恢复后在常规环境重跑
>     `node scripts/accept-import.mjs`（脚本已能自供给）。**
