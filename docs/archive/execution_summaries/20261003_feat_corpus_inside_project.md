# 执行摘要：语料迁入项目文件夹 cad-data/（DESGIGN §19）

## 动机
> 用户拍板：产物放进项目文件夹——删目录即删产物，原地重建同名项目即全新
> 语料（同时消灭"原地重建继承旧语料"的坑）。§13.13 的"不往用户仓库写东西"
> 弊端已因 git 的存在消失。

## 影响范围
> - `src/host/project.ts`：projectStores root 改 `<cwd>/cad-data/`，新增
>   `projectDataDir`；projectKey 保留供迁移定位
> - `scripts/migrate-to-project-dir.mjs`：新迁移脚本（幂等、合并拒绝覆盖、
>   只读源容错、悬空符号链接清扫）
> - `.gitignore`：cad-data/ 默认忽略
> - `scripts/accept-project-scope.mjs`：+3 项目内语义断言，路径断言改写
> - `DESGIGN.md` §18（连通体纪律补档）+ §19

## 具体操作步骤
> 1. projectStores root 改为 projectDataDir(cwd)；遥测留 DSH_HOME 不变。
> 2. 迁移脚本按 legacy project.json.cwd 定位目标，MOVED 五类条目按 id 合并
>    （冲突保留源并报告）；EXDEV 走复制+删除，EROFS（沙盒只读）只复制并提示。
> 3. 真实迁移 4 份语料，逐一 diff -rq 校验逐字节一致；ToyMarker 的
>    versions/v001–v034 与源完全相同（此前已有人拷贝，冲突逻辑正确拒绝二次覆盖）。

## 预期风险与验证
> - 风险点：活会话（旧代码）在重启前仍写旧路径——重启后重跑迁移脚本清扫
>   （幂等）；`~/.dsh/cad/songsenand-45ce0cbd` 悬空符号链接由脚本自动清。
> - 测试方式：accept-project-scope 全 PASS（新增：产物落项目内、删 cad-data
>   即空、原地重建不继承）；四套验收回归全绿；tsc 干净。
> - 真实环境：重启 dsh → 重跑 `node scripts/migrate-to-project-dir.mjs` 清扫
>   旧目录 → 面板确认各项目各自语料。
