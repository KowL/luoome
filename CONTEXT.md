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

StrategyRun 的 `status` 只表达执行生命周期：`running / complete / failed`。`complete` 表示执行已结束且
结果包已原子提交，不要求每只股票的数据都可用；数据覆盖质量由 Summary 的
`dataHealth=complete / partial / unavailable` 与失败计数表达。存量 `status=partial` 只作为旧记录读取，
语义等同“执行已完成、数据部分可用”。新的当前股票池只消费通过 acceptance 且
`publication=published` 的 operational run；evaluation、withheld 和 non-publishing 运行不会覆盖当前事实。
股票进入策略股票池后，其后续事实链仍归 Strategy：
StrategyResult（入选）→ StrategySignal（跟踪信号）→ SignalObservation（T+1/T+3/T+5/T+20
观察）→ Advice（建议快照）。关注列表不承载这条生命周期状态。

> 可靠性实现（2026-08-14）：`complete` 继续只表达执行终态；acceptance 与
> `publication=published/withheld/non-publishing` 独立表达发布资格。生产 daily cycle 使用
> heartbeat + fencing token、checkpoint、观察补全和 facts-only 降级；replay/backtest/显式子集不发布。
> 跨日性能样本与真实运行记录继续作为运营观测，不设置固定交易日数量的完成门禁。详细契约见
> [Strategy 日运行与历史评估详细设计](./docs/ddd/strategy-daily-cycle-and-replay-detailed-design.md)。

### StrategySchedule

回答“已发布策略何时自动运行”。它是独立于 StrategyVersion 的可变运行配置，使用标准 5 段
cron、IANA 时区、启停状态、nextRunAt 和可选 StrategyRecommendationPolicy；修改调度不改变
definitionHash。`luoome start` / Web 长期运行进程每分钟自动唤醒到期调度 workflow，实例间通过
调度租约和正式运行租约防重。非交易日与暂停策略不运行。启用推荐政策后，完成运行会按最低评分、
最高排名、每轮上限和冷却时间调用 AI 生成可追溯 Advice；配置的 T+n 观察完成时可再次生成阶段建议，
并可选择日志或飞书通知。推荐失败不回滚已提交的 StrategyRun，任何建议与通知都不会自动交易。

可靠性目标已落地为把调度、数据准备、正式运行、观察补全、洞察和可选推荐收进一个有 WorkflowRun
审计的 daily cycle；租约使用 heartbeat + fencing token。外部观察 cron 只保留为幂等补偿任务，
真实交易日的运行记录仍需持续积累，期间不扩大自动推荐或通知默认范围；样本数量不作为固定完成门禁。

### StrategyInsight

回答“策略最近实际发生了什么”。确定性事实层汇总运行变化、规则阻断、当前行业分布、关联
AlertPlan，以及 StrategySignal 的 T+1/T+3/T+5/T+20 事后观察。AI 只解释事实层并必须引用存在的
fact id；不得把观察称为回测，不得给出收益承诺、未来概率或买卖建议。事实截止时间、观察截止
时间、缺失率和小样本限制必须保留。

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

### LimitUpLadder 与历史 PIT 天梯

`LimitUpLadder` 是指定 `Asia/Shanghai` 交易日的真实涨停梯队事实，`ladderLevel` 只表示当日快照中
可审计的连板层级，不等于 Advice、收益概率或交易信号。交互式当前查询走真实 manager/cache；
正式 Strategy scan/scheduled 将返回写入 `LimitUpLadderSnapshotRepository`，历史 replay 只读取同一
交易日、同一来源的 PIT 快照。没有快照或历史字段缺失时必须返回 unknown/unavailable，不读取当前快照、
情绪接口或 mock 推断历史事实。

### ResearchTopic / ResearchDocument

研究以 `ResearchTopic` 为持续上下文，以 `ResearchDocument` 为资料索引；Topic 可不关联股票，也可通过显式 SubjectLink 关联多只股票、产业、事件、主题或宏观问题。正文权威来源是本地 Obsidian Vault，SQLite 只保存可重建的索引、关系、分块和同步审计。研究资料不自动生成 Advice 或交易动作。

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

旧 Tactic、StockGroup、StockPool 已彻底移除：tool、repository、entity、migration decoder
与旧表 DDL/schema 全部下线，存量库的旧物理表不再维护（不 DROP、不读取）。
不得作为新 surface、Agent 或写入口的领域模型。
