# Luoome 领域语言

## 核心概念

### 股票目录（StockUniverse）

回答“市场里有哪些可被系统识别的股票”。目录按明确覆盖范围低频同步股票身份；失败、空结果
或分页不完整时保留上一版。目录不是行情快照。

### 规范日线（DailyBar）

指标、Strategy 和 AlertPlan 统一使用前复权（`qfq`）日线。缺少复权因子或上一交易日收盘价
时必须返回 unavailable/unknown，不得用当日开盘价或伪造因子替代。

### Strategy

回答“如何发现、评分并解释研究机会”。Strategy 是稳定身份，StrategyVersion 是不可变定义；
版本必须先校验再发布。StrategyRun 记录一次执行，StrategyResult 是逐股规则事实，
StrategySignal 是可供后续观察的信号。Signal 不等于 Advice，更不等于交易。

### Watchlist

回答“当前持续研究哪些股票”。WatchlistMember 以 `watchlistId + stockId` 唯一，维护
`discovered → watching → researching → confirmed → archived` 阶段与优先级。成员可同时具有
manual、strategy、ai、portfolio、import 多个来源；一个来源结束不应删除仍被其他来源关注的成员。

### AlertPlan

回答“Watchlist 成员发生什么时提醒”。AlertPlan 引用一个 Watchlist，并配置稳定 rule id、
组合逻辑、冷却、每日上限与启停状态。盘中 `strategy-signal` 规则只读取持久化
StrategySignal，不临时运行全市场 Strategy。

### WatchTrigger

某个 Watchlist 成员命中 AlertPlan 规则后产生的可审计事实，包含规则、方向、证据、数据时间和
送达状态。删除 AlertPlan 不删除 Trigger 历史。

### 个性化报告（Report）

回答“某个周期发生了什么、哪些数据不可用、应去哪里继续研究”。报告保存结构化事实、数据
截止时间、来源状态与缺失原因；Markdown 只是派生展示。报告不会自动生成 Advice 或触发交易。

### A 股市场情绪快照（AShareSentimentSnapshot）

指定沪深 A 股交易日的市场情绪事实集合。每个维度独立记录数据截止时间、来源与可用状态；
数据不可用不等于正常零值。

## 关键约束

- 首期全市场覆盖固定为沪深 A 股，不暗示港股、美股或北交所。
- 股票目录完整快照通过校验后才原子提交；缺失只标记，不物理删除股票身份。
- StrategyVersion 发布后不可修改；运行结果与信号必须引用确切版本和 dataAsOf。
- Watchlist 的 complete sync 才能结束缺失来源；partial/failed 不退出成员。
- disabled Watchlist 不进入 AlertPlan 扫描；AlertPlan 不拥有成员。
- 删除被 AlertPlan 引用的 Watchlist 必须拒绝。
- portfolio 来源只暴露当前账户范围，不在通知中泄漏敏感数量。
- Advice 与真实交易严格分离；Strategy、AlertPlan、WatchTrigger 都不会自动下单。
- write/external 必须显式 opt-in；Agent 的持久化、发布、正式运行和同步必须先确认。

旧 Tactic、StockGroup、StockPool 的 tool 与 repository 层已彻底下掉；只剩 SQLite 旧表
DDL/schema、migration decoder，以及 entity/tactic.ts（legacy-mapper 迁移映射用）。
不得作为新 surface、Agent 或写入口的领域模型。
