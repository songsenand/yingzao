# 木作家具 rule pack（示例，不是核心）

这份 guide 是**八仙桌/木作家具专用**的接触组清单：

- 腿 ↔ 边框
- 腿 ↔ 牙板
- 边框 ↔ 牙板
- 边框 ↔ 面板/穿带
- 面板拼缝
- 管脚枨/木楔

它属于 **rule pack / example**，不属于核心 `pearls/fit`；由项目显式选择 `rulepack/v1` 后才生效。

核心 `pearls/fit/INTERFACE-GUIDE.md` 只讲通用做法：列 datum、声明接口、更新版本、跑 check/validate；
具体“哪些组必须覆盖、阈值是多少、undeclared 怎么处理”由项目/rule pack 声明。

> 教训：把家具的“腿/边框/牙板”写进核心 fit，会让减速器、四连杆也收到家具模板。
> 核心只放机制，领域规则放这里。
