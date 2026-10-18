# 执行摘要：运动干涉 = 交付阻塞（红牌 + 门禁连锁）

## 动机
> 用户观察：机构仿真"只看能不能跑"，零件间碰撞/重叠无人关注。取证：检测存在
> 且 status 会降 check，但黄牌+纯数字对模型无牙齿。

## 影响范围
> - `src/host/tools.ts`：simulate_motion 运行 status fail 化、blocking/
>   deliverability 字段、模型文本 ❌ 前缀；输出 schema 同步
> - `scripts/accept-sim-verdict.mjs`：9 项新验收

## 具体操作步骤
> 1. motion 执行处：interferenceCount>0 → motionStatus='fail'；commit summary
>    前缀"❌ 不可交付"；返回 blocking（配对+体积+时刻）与 deliverability
>    （两条出路：修几何 / 契约声明有意过盈）。
> 2. 门禁不加新代码：motion-clearance 本就要求引用运行 pass，红色自动连锁
>    hard-violation——验收用同夹具验证链条。
> 3. 模型文本前置 ❌ NOT DELIVERABLE（render 处类型收窄）。

## 预期风险与验证
> - 风险点：有意过盈会被红牌——出口是契约 intent 声明（skill 措辞待用户审）。
> - 测试方式：accept-sim-verdict 9 PASS（干净 pass / 穿越 fail+blocking /
>   门禁连锁 hard-violation / 文本 ❌）；五套验收回归全绿；tsc 干净。
