# Strategy 严格回测详细设计

## 目标与边界

严格回测是独立于 operational（日运行）和 evaluation（历史评估/回放）的 `backtest` scope。它消费带历史时点的策略求值结果与市场事实，产生可复现的组合净值结果；不会写入当前股票池，不生成 Advice、Trade 或通知。现有“模拟回测（历史回放）”仍保持原语义，只统计规则求值与信号，不能改名充当严格回测。

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

门禁结果写入不可变审计。`complete` 才能进入执行；混合缺失为 `partial`，全部关键事实缺失为 `unavailable`。没有完整门禁时只返回审计和可用性，禁止输出净收益、回撤、Sharpe、胜率等伪指标。

## 首个执行模型

`next-open-full-rebalance-equal-weight-v1` 在 D 日使用 D-1 已冻结的 selected targets，于 D 日开盘按 lot size 全量再平衡。成交价由开盘价叠加固定买卖滑点；佣金和卖出印花税按 spec 计算。停牌或涨跌停导致不可卖时保留持仓并按收盘估值；不可买标的不建仓。公司行动在当日成交和估值前应用。benchmark 使用同一历史 cutoff 的复权日线，按首个执行日开盘到最后执行日收盘计算，与策略首日投入和末日估值口径一致。

## 存储与接口

- Core：`StrictBacktestSpec/Run/MarketFact` schema、门禁审计和纯执行引擎。
- Repository：`StrategyBacktestRepository` 提供 Drizzle 与 in-memory 双实现，并由 contract tests 验证身份不可变、生命周期和 cutoff 查询。
- Tool：创建、读取、列表为公开 read/write tools；后台执行 tool 只由 Web job 调用。Tool 负责组装历史事实和门禁，Workflow（如后续接入）只能通过 `ctx.tools.*` 编排。
- Web：`/api/strategies/:id/strict-backtests` 创建并异步执行；工作台“严格回测”入口展示运行身份、门禁审计和完整时才可用的指标。

当前仓库已提供确定性切片、fixtures 与契约，但真实停牌/涨跌停/退市、公司行动和 benchmark 历史事实尚未由生产数据同步器填充；因此真实运行在事实缺失时会诚实返回 `partial/unavailable`，不会用当前快照或推断数据补齐。
