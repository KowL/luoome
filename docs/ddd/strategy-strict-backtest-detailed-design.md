# Strategy 组合回测详细设计

> 当前已有执行与审计实现，真实可用范围由下列逐项门槛决定；当前市场公司行动尚未接入同步链。
> 默认用户入口为 DSH 插件，下文 Web API 是历史 surface 设计，不作为当前接入入口。

## 目标与边界

组合回测是独立于 operational（日运行）和 evaluation（历史评估/回放）的 `backtest` scope。它消费带历史时点的策略求值结果与市场事实，产生可复现的组合净值结果；不会写入当前股票池，不生成 Advice、Trade 或通知。现有“历史评估（逐日重放）”仍保持原语义，只统计规则求值与信号，不能改名充当组合回测。

每次运行冻结 `strategyId/versionId/evaluationSessionId/区间/基准/执行模型/费用/滑点`，并保存 `specHash`、市场事实 `contentHash` 集合、输入 `inputFingerprint` 与 evaluator 版本及代码 SHA-256。相同身份和指纹只能得到同一个运行；运行进入 `running` 后身份不可变。

## 数据门禁

| 门禁 | 必须存在的事实 | 缺失时行为 |
|---|---|---|
| PIT universe | 完成的 evaluation session、每日 universe sync/run identity | 不输出指标 |
| DailyBar revision | 每个交易日的 vintage、checkpoint、revision cutoff | 不输出指标 |
| Fees | 版本化佣金、最低佣金、卖出印花税 | 不接受隐含零费用 |
| Slippage | 版本化成交价模型和买卖滑点 | 不接受隐含零滑点 |
| Tradability | 每个目标股票每日停牌、涨跌停、退市与买卖许可 | 缺失返回 partial/unavailable |
| Corporate actions | 分红、拆股等动作及完整性状态 | 缺失返回 partial/unavailable |
| Benchmark | 全区间同一历史 cutoff 的 benchmark facts | 缺失返回 unavailable |
| Evaluator code | 策略运行快照 schema、evaluator version/code identity | 不接受旧/未知求值器 |

门禁结果写入不可变审计。执行所需的阻塞门槛必须完整；混合缺失为 `partial`，全部关键事实缺失为
`unavailable`。当前公司行动是明确披露的范围限制，不阻断其它门槛通过后的执行；它仍逐项显示
unavailable，不将执行结果表述为完整复权回测。阻塞门槛缺失时只返回审计和可用性，不输出净收益、
回撤、Sharpe、胜率等指标。

PIT universe 门禁的 `reason` 同时披露**快照属性覆盖**：读取 evaluation day 所引用快照的 `source` 与「实际提供了哪些 PIT 属性」（`StockUniverseRepository.describeSnapshotAttributes`），把来源未提供的属性（默认 eastmoney/sina 只提供名称派生的 ST 状态，缺上市状态/行业/上市日期/退市日期）以及当前目录能力缺口写进同一条审计。属性缺口不改变 `pit-universe` 的身份判定语义，但不得静默成 `unknown`；真正被卡住的可交易性门禁 reason 同样带出来源与缺口。新增目录源须先证明相应属性覆盖，再进入生产路由。

### 当前市场事实同步与限制

同步任务按 evaluation day 的 `revisionCutoff` 读取 `daily_bar_revisions`，不读当前日线缓存。
`tradability-rule-v1` 用前收盘与板块幅度推导涨跌停价：主板非 ST 10%、主板 ST 5%、科创/创业 20%、
北交所 30%。这是计算规则覆盖，不扩大产品首期沪深 A 股范围。上市状态与 ST 状态来自 PIT 成员属性；
缺成员、状态未知、缺当日 revision 或昨收时跳过该日事实并披露具体原因，不猜测。

该同步链尚未消费市场公司行动仓储，写入 `corporateActionsStatus='unavailable'` 与空行动数组。
新增原始日线或公司行动导入能力不自动提升此门槛，也不证明已有事实覆盖完整的原始价与复权关系。
同步的幂等写入、事实 hash 和截止时间用于复现已披露范围内的结果。

## 首个执行模型

`next-open-full-rebalance-equal-weight-v1` 在 D 日使用 D-1 已冻结的 selected targets，于 D 日开盘按 lot size 全量再平衡。成交价由开盘价叠加固定买卖滑点；佣金和卖出印花税按 spec 计算。停牌或涨跌停导致不可卖时保留持仓并按收盘估值；不可买标的不建仓。公司行动在当日成交和估值前应用。benchmark 使用同一历史 cutoff 的复权日线，按首个执行日开盘到最后执行日收盘计算，与策略首日投入和末日估值口径一致。

## 存储与接口

- Core：`StrictBacktestSpec/Run/MarketFact` schema、门禁审计和纯执行引擎。
- Repository：`StrategyBacktestRepository` 提供 Drizzle 与 in-memory 双实现，并由 contract tests 验证身份不可变、生命周期和 cutoff 查询。
- Tool：创建、读取、列表为公开 read/write tools；后台执行 tool 只由 Web job 调用。Tool 负责组装历史事实和门禁，Workflow（如后续接入）只能通过 `ctx.tools.*` 编排。
- Web：`/api/strategies/:id/strict-backtests` 创建并异步执行；工作台“组合回测”入口展示运行身份、门禁审计和完整时才可用的指标。

当前仓库已提供确定性执行、历史事实同步与契约；能否运行仍取决于目标区间实际保留的 PIT 属性、
日线 revision 与 benchmark 覆盖。公司行动保持上述范围限制；其它必需事实缺失时返回
`partial/unavailable`，不以当前快照或 mock 补齐。插件通过 `create_strict_strategy_backtest` 的操作
policy 创建并启动宿主后台任务；`execute_strict_strategy_backtest` 是内部执行步，不另行暴露。
