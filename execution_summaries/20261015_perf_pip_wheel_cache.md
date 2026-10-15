# 执行摘要：pip wheel 缓存关进 runtime root（取代 --no-cache-dir）

## 动机
> 冷供给整锁 ~600MB（vtk/jaxlib 单轮 ~90MB），`--no-cache-dir` 使每次 venv 重建
> 全额重下——本日三次冷供给两次因此撞超时。原标志无注释存档；评估结论：其正当
> 动机（不污染宿主全局缓存）可用"缓存放插件自己的 root"完整保留，而重装大头
> 收益此前为零。用户拍板采纳（对话记录，2026-10-15）。

## 影响范围
> - `dsh-cad-harness/src/host/python-runtime.ts`：`installDependencies` 一处
> - `dsh-cad-harness/scripts/accept-import.mjs` / `accept-import-cad.mjs`：供给
>   前导设 `DSH_CAD_PIP_CACHE_DIR` 指向仓库根 `.tmp-pip-cache/`（被 `/.tmp-*/`
>   ignore 规则覆盖）
> - `DESIGN.md` §26.3 链路图补缓存说明

## 具体操作步骤
> 1. `--no-cache-dir` → `--cache-dir`：默认 `<runtime root>/cache/pip`（与解释器
>    归档缓存同根、repair 时同生共死）；`DSH_CAD_PIP_CACHE_DIR` 可覆盖。
> 2. 显式 `mkdir` 缓存目录，权限问题在自家日志先暴露。
> 3. 代码注释与 DESIGN §26.3 记录理由与边界：安全不降（`--require-hashes` 对
>    缓存 wheel 逐个复验）；**不加速单次冷装**（pip 无断点续传），收益在第二次起。

## 预期风险与验证
> - 风险点：磁盘占用上限升至 ~600MB/缓存 + venv（同 root，可随运行时整体删除）；
>   缓存键随 index URL 变化，换源后命中率下降（预期内，不影响正确性）。
> - 验证：`tsc --noEmit` 干净；端到端缓存复用挂靠下一次冷供给——第一次填缓存
>   （全价），第二次 repair/reinstall 应只拉取缺失 wheel（观察 pip 输出从
>   "Collecting/Downloading" 变为 "Using cached ..."）。
