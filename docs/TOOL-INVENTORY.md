# Tool 库存（按域分组）

> 本文件是 **能力面的人类可读清单**，不是权威定义。
> 权威来源是 `packages/tools/src/registry.ts` 的 `toolRegistry`；实际数量与逐条 schema 用 `bun run tools:list --json` 取。
> 新增/删除/改名 tool 时必须同步本文件的分组表与统计（`bun run check:docs` 校验的是 PRD 附录 A 的数字，不校验本文件，所以这里靠改动时自觉）。

## 统计（asOf 2026-11-04，registry 234 项）

| sideEffect | 数量 | 含义 | 默认暴露给插件面 |
|---|---:|---|---|
| `read` | 113 | 只读本地事实，零回源 | ✅ 默认（白名单内） |
| `write` | 85 | 写本地状态 | ⚠️ 需 operation policy |
| `external` | 30 | 调用第三方网络 | ⚠️ 需 market allowlist opt-in |
| `queue` | 5 | 消费分析队列并写回 | ⚠️ 需 queue policy |
| `trade` | 1 | 登记系统外已完成的资金动作 | ❌ 永不暴露 |

能力门控看 `requiredCapabilities`（跨边界能力），暴露判定看 `packages/tools/src/exposure/judge.ts`，规则见 `docs/ARCHITECTURE.md` §9。

域归属是「读者找得到」的归类，不是代码目录结构：同一个 tool 在 `packages/tools/src/tools/` 下可能按实现位置分文件。

## 账户与账本（16）

| tool | sideEffect | 用途（取自 tool description，截断） |
|---|---|---|
| `create_account` | `write` | 创建一个真实投资账户；空数据库首次使用时先调用此工具 |
| `list_accounts` | `read` | 列出所有账户 |
| `get_account` | `read` | 按 id 查询单个账户详情（缺省查默认账户） |
| `update_account` | `write` | 修改投资账户名称；不改变开户本金、币种或现金账本，缺省修改默认账户 |
| `get_account_facts` | `read` | 按当前持仓与行情计算账户事实（现金字段 + 持仓市值 + 指纹） |
| `reconcile_account_cash` | `read` | 对账账户现金余额与账本口径，输出差额与账本缺口 |
| `list_holdings` | `read` | 列出指定账户下的当前持仓（含现价与 PnL 汇总） |
| `get_holding` | `read` | 按 id 查询单条持仓详情（含现价与浮动盈亏） |
| `add_holding` | `write` | 直接录入一笔持仓（无交易记录场景）；同账户同股票不可重复 |
| `update_holding` | `write` | 修正持仓的数量 / 可卖数量 / 成本价（录入错误纠错用） |
| `close_holding` | `write` | 把一笔持仓标记为已平仓（软关闭，保留历史） |
| `list_trades` | `read` | 查询账户交易记录（可按股票/方向/成交时间过滤，按成交时间倒序） |
| `add_trade` | `write` | 录入一笔买入/卖出交易，自动联动持仓（加权成本 / 可卖数量 / 清仓） |
| `record_decision_trade` | `trade` | 登记已在系统外完成、尚未入账的成交，并原子关联明确选择的当时依据 |
| `create_portfolio_cash_flow` | `write` | 记录账户入金、出金、分红和费用现金流，金额为正数并保留明确类型 |
| `create_portfolio_corporate_action` | `write` | 记录账户范围内的拆股、送转或分红公司行动，供估值和归因重算 |

## 组合风险与绩效（8）

| tool | sideEffect | 用途（取自 tool description，截断） |
|---|---|---|
| `get_portfolio_risk` | `read` | 读取本地持仓、已落库报价、已落库绩效快照与 active TradingPlan，输出组合风险：HHI / 前 N 大持仓占比 / 历史 95% V… |
| `get_account_performance` | `external` | 使用真实交易、现金流、公司行动和日线计算账户估值、TWR、基准 TWR、超额、回撤与持仓贡献；覆盖不足只返回状态与缺失日期，样本不足只给 insuf… |
| `list_account_performance_snapshots` | `read` | 查询账户绩效快照摘要（TWR / 基准 TWR / 超额 / 覆盖缺口与缺失日期 / 归因 fact id），不重新请求行情或重算绩效 |
| `audit_account_performance_snapshots` | `read` | 审计账户绩效快照区间覆盖、缺失交易日和 partial 原因，不重新请求行情或重算绩效 |
| `get_investment_workspace` | `read` | 读取当前账户方向研究、共识版本、近期意愿和独立跟踪状态；跨日恢复不依赖聊天记录 |
| `get_investment_candidates` | `read` | 按已确认方向读取真实最新逐股结果，合并同股多方向证据；只输出候选与证据引用，不生成建议 |
| `save_investment_consensus` | `write` | 确认或修订方向、约束与近期意愿；遗漏字段保留旧值，版本冲突须刷新重确认；修订暂停本功能旧候选同步，已有持仓风险跟踪不变 |
| `set_investment_tracking` | `write` | 独立确认开启/暂停方向专用 Watchlist 与 Strategy 订阅；不自动开启付费研究、策略调度或通知，不修改已有持仓风险计划 |

## 行情与市场事实（21）

| tool | sideEffect | 用途（取自 tool description，截断） |
|---|---|---|
| `fetch_quote` | `external` | 拉单股实时行情，写 quote_snapshot；stockId 支持 Stock.id 或纯代码 |
| `batch_quote` | `external` | 批量拉行情并写 quote_snapshot；解析失败的 stockId 列入 unresolved |
| `refresh_holdings_quotes` | `external` | 为账户持仓显式回源刷新行情并落库（访问外部行情源 + 写 price_snapshots）。逐股报告成功与失败原因；失败不静默降级、不返回伪成功。读… |
| `get_previous_closes` | `read` | 批量读取严格早于目标交易日的最近前复权收盘价 |
| `fetch_index_quotes` | `external` | 拉主要大盘指数实时行情；数据源不支持时返回 unsupported: true |
| `fetch_sector_quotes` | `external` | 拉取东方财富行业板块实时行情：板块代码/名称/最新点位/涨跌幅/成交额/上涨下跌家数/领涨股。sort 支持 changePct（涨跌幅，默认）与… |
| `fetch_intraday_minutes` | `external` | 拉当日分时分钟序列；数据源不支持时返回 supported: false |
| `get_stock_minute_bars` | `external+write` | 获取独立分钟 OHLCV；支持当前真实源与本地按需历史，缺口和不可用状态显式返回 |
| `get_stock_market_view` | `external` | 获取个股实时快照、日 K、指标和数据状态 |
| `get_market_data_status` | `read` | 行情数据健康读模型：各源新鲜度 + watch 运行健康 + stale Watchlist |
| `get_daily_volatility` | `read` | 读取本地日线计算 20 日已实现波动率（百分点）；样本不足、有效收益率不足或 σ 过低返回 unavailable，并给出日线滞后交易日数 |
| `compute_indicators` | `read` | 拉日线算技术指标快照（不落库）；stockId 支持纯代码 |
| `get_ashare_sentiment` | `external` | 获取指定沪深 A 股交易日的指数、市场宽度、封板/炸板/连板/封单与热点情绪证据；各维度独立标注完整性和溯源。 |
| `northbound_flow` | `read` | 拉取截止最近交易日的北向资金（沪股通+深股通合计）日级历史序列：每日成交总额（元），以及 2024-08-16 之前的每日净买入/买入/卖出额（之后… |
| `dragon_tiger_list` | `read` | 拉取指定交易日 A 股龙虎榜榜单（代码/名称/收盘价/涨跌幅/换手率/上榜原因/龙虎榜净买入/买入/卖出/成交额）。date 缺省时取当天（非交易日… |
| `limit_up_ladder` | `read` | 拉取指定交易日 A 股（默认主板+创业板，可选科创板/北交所/ST）的涨停梯队快照。返回不可变快照。空 levels + warnings=["no… |
| `limit_up_ladder_compare` | `read` | 对比两日 A 股涨停梯队快照（curr vs prev），返回 diff（maxLevelDelta / totalDelta / 顶级成员 add… |
| `sync_quotes` | `external` | 同步账户下所有活跃持仓的实时行情并写 quote_snapshot |
| `sync_daily_bars` | `external` | 为显式或相关股票同步规范前复权日线，逐股报告结果并保留成功项 |
| `persist_external_facts` | `write` | 把已抓取的外部市场事实（当前仅 news）幂等落库：同一条事实重抓命中同一 id，上游更正正文时 id 不变、事实更新并留 revisedAt；缺… |
| `fetch_news` | `external` | 分页拉取东方财富或同花顺财经要闻流：id/标题/摘要/分类/来源媒体/发布时间/原文链接，按发布时间倒序。可选 category（宏观/市场/行业/… |

## 股票目录、档案与公司事件（9）

| tool | sideEffect | 用途（取自 tool description，截断） |
|---|---|---|
| `search_stocks` | `read` | 按代码 / 名称搜 A 股（SH/SZ；新鲜本地股票目录优先，外部数据源补充，本地历史兜底）；limit 默认 20 |
| `get_stock_profile` | `external` | 拉取单只 A 股的个股档案：股东户数（统计截止日、户数、较上期变动、户均持股与户均市值）与所属板块清单（板块名、代码、是否精确归属、入选理由）。数据… |
| `get_stock_universe_status` | `read` | 查询本地股票目录覆盖范围、同步时间、active/missing 数量与新鲜度 |
| `sync_stock_universe` | `external` | 从外部数据源拉取完整股票目录快照，校验后原子写入本地数据库 |
| `list_stock_events` | `read` | 查询公司事件（财报 / 解禁 / 分红 / 手工…，按 occursAt 升序） |
| `add_stock_event` | `write` | 新增手工公司事件（返回疑似重复告警，由调用方决定是否继续） |
| `update_stock_event` | `write` | 更新公司事件（external 事件不可改 occursAt，只能改提醒设置） |
| `delete_stock_event` | `write` | 删除手工公司事件（external 事件请改 status=cancelled，不可删） |
| `sync_stock_events` | `external` | 从外部数据源同步公司事件（财报 / 解禁 / 分红 …），按 (provider, externalId) 幂等 upsert |

## 财务与基本面（4）

| tool | sideEffect | 用途（取自 tool description，截断） |
|---|---|---|
| `get_financial_facts` | `read` | 按显式 asOf 从本地 FinancialFactRepository 读取 strict PIT vintage；只读、不回源、不隐式填补缺失 |
| `sync_financial_facts` | `external+write` | 从显式注入的 mock 基本面 adapter 拉取并校验 PIT facts 后 append 到仓储；始终标记 gate=not-ready，不… |
| `get_fundamental_score` | `read` | 只读查询已持久化 FundamentalScoreRun、score version 与逐股逐因子解释；unavailable/failed 不伪造… |
| `run_fundamental_score` | `write` | 读取已发布 score version 与 strict PIT FinancialFact，执行确定性的基本面横截面评分；persist=fals… |

## Strategy 定义与生命周期（18）

| tool | sideEffect | 用途（取自 tool description，截断） |
|---|---|---|
| `create_strategy` | `write` | 创建用户 Strategy；内置 Strategy 只能通过 copyFromStrategyId 复制 |
| `create_strategy_version` | `write` | 为用户 Strategy 创建严格递增的 draft version |
| `validate_strategy_version` | `write` | 静态校验 StrategyVersion 的字段路径与数据需求并回写校验结果（不会运行交易） |
| `publish_strategy_version` | `write` | 发布 valid StrategyVersion 并原子切换 currentVersion；发布会把 paused 的 Strategy 置回 ac… |
| `pause_strategy` | `write` | 暂停用户 Strategy；不触发任何交易 |
| `resume_strategy` | `write` | 恢复 paused 的用户 Strategy 为 active；publish_strategy_version 发布新版本也会隐式置回 activ… |
| `archive_strategy` | `write` | 归档 paused 的用户 Strategy（终态，不可自动恢复；同时移除其调度配置）；不触发任何交易 |
| `delete_strategy` | `write` | 删除 Strategy 及其版本、调度、运行结果、信号和信号观察，并取消其 Watchlist 订阅；不删除内置模板 |
| `list_strategies` | `read` | 列出 Strategy，可按状态与 owner 过滤 |
| `get_strategy` | `read` | 查询 Strategy 及其不可变版本历史 |
| `get_strategy_dsl_catalog` | `read` | 读取 Strategy DSL 字段注册表与现有安全表达式运算符；只描述白名单，不执行表达式或修改策略 |
| `get_strategy_data_preflight` | `read` | 按不可变策略字段与指定区间检查本地真实日线修订、PIT 股票池/天梯及基准覆盖；披露试跑/历史评估/组合回测门禁各层限制，不访问即时行情或放宽门禁 |
| `export_strategy_manifest` | `read` | 导出不可变 StrategyVersion 的 canonical、versioned JSON 研究定义；包含字段/能力依赖、数据集、求值器、时间… |
| `import_strategy_manifest` | `read` | 安全导入并校验 portable Strategy research manifest；只返回校验后的内存 manifest，不写入 Strateg… |
| `validate_strategy_manifest` | `read` | 校验 portable Strategy research manifest 的 schema、definition hash、字段依赖和兼容能力… |
| `compare_strategy_definitions` | `read` | 比较同一 Strategy 的基线版本与草案定义，返回稳定的字段级 diff |
| `propose_strategy_version_draft` | `external` | 基于可审计事实校验并生成未持久化的 StrategyVersion 草案，不会发布或正式运行 |
| `evaluate_strategy_candidate_preflight` | `read` | 按已发布策略运行的入选结果逐股评估账户级预检（仓位、行业、冷却、信号冲突）；只读，不产生建议或计划。 |

## Strategy 运行、信号与调度（32）

| tool | sideEffect | 用途（取自 tool description，截断） |
|---|---|---|
| `run_strategy` | `external+write` | 运行 Strategy selection/scoring/signals；外部行情只用于权威 StockUniverse 内候选，不会自动交易 |
| `trial_strategy` | `external` | 对单个 Strategy version 执行非持久化样本试跑；强制 persist=false，不支持 scheduled，不产生正式 Strat… |
| `trial_strategy_version` | `external` | 用同一股票样本对比 Strategy 基线与草案；persist=false，不产生正式 StrategyRun |
| `list_strategy_runs` | `read` | 查询 StrategyRun 历史（按开始时间倒序，最多返回 limit 条） |
| `get_strategy_run` | `read` | 查询单次 StrategyRun 及逐股结果与信号 |
| `compare_strategy_runs` | `read` | 比较同一 Strategy 的两次持久化可用运行；数据缺失不会被推断为股票池进出 |
| `get_strategy_workspace` | `read` | 查询 Strategy 定义、工作台摘要与有界入选股票明细（含名称、规则事实）；仅 published operational run 进入 cur… |
| `list_strategy_result_views` | `external` | 查询 Strategy 当前或指定运行的股票池、候选池及数据不完整视图；默认基准为最近一次已完成且结果可用的运行；行情实时拉取，上游失败回退本地快照 |
| `get_strategy_decision_cycles` | `read` | 读取按 strategyId + runId + stockId 派生的策略候选决策周期，串联结果、信号、事实观察、Advice 和仅有显式 ID… |
| `get_strategy_reliability_summary` | `read` | 汇总 strategy-daily-cycle 的真实运行审计；样本目标独立于生产可靠性门禁 |
| `get_strategy_selection_diagnostics` | `read` | 只读指定运行的入选/规则临界/排名临界/未入选/缺失事实与评分分解，支持筛选分页；不刷新行情或改变已保存的事实 |
| `get_strategy_pit_universe` | `read` | 读取不晚于指定时点的成功 StockUniverse snapshot，供 PIT replay 固定股票池 |
| `get_strategy_insight_facts` | `read` | 汇总 Strategy 运行变化、规则阻断、真实表现与关联预警的确定性事实 |
| `get_strategy_ic` | `read` | 按 vintage 分组计算策略 IC / RankIC（评分与次日收益的横截面相关）；样本 <20 交易日返回 unavailable，缺失日不填… |
| `get_strategy_experiment_context` | `read` | 聚合 Strategy 基线/候选定义、历史 validation session、候选信号观察与确定性人工评审门禁；只读且不会执行 trial、发… |
| `prepare_strategy_data` | `external+write` | 按配置化并发、超时和重试预算准备 Strategy 日线数据并提交可复用 checkpoint |
| `create_strategy_observation_candidates` | `write` | 为已发布正式运行或显式关联的验证运行创建事实观察；不创建建议或交易 |
| `create_restated_strategy_observation_candidates` | `write` | 回溯轨：为已完成的 evaluation 运行写入 vintage=restated 的事实观察（只进统计层，不得用于历史命中/Advice 证据/… |
| `list_pending_strategy_observations` | `read` | 列出待补齐的 StrategySignal 真实表现观察 |
| `complete_strategy_observations` | `write` | 仅用本地规范 qfq 日线补齐 StrategySignal 的 T+1/T+3/T+5 事实观察 |
| `get_signal_observation_stats` | `read` | 按交易日和观察周期聚合 SignalObservation 的去重描述性统计；返回样本单位、缺失率、后续表现与限制，不输出因果结论或胜率承诺 |
| `strategy_signals_by_stock` | `read` | 按股票查询 StrategySignal 事实；signal 不等于 Advice 或交易 |
| `set_strategy_schedule` | `write` | 创建或更新 StrategySchedule；不修改不可变 StrategyVersion |
| `get_strategy_schedule` | `read` | 读取 Strategy 的独立自动运行配置 |
| `renew_strategy_schedule_claim` | `write` | 按 owner+fence 延长 StrategySchedule lease；失去 fencing 时返回 renewed=false |
| `list_strategy_autonomy_actions` | `read` | 列出 Strategy 自主管理动作（按 strategy/kind/status/时间过滤） |
| `confirm_strategy_autonomy_action` | `write` | 人工确认 blocked 的晋级动作并立即发布其候选版本；只改变策略生命周期，不触发任何交易 |
| `reject_strategy_autonomy_action` | `write` | 人工否决 blocked 的晋级动作，其候选版本不发布；不触发任何交易 |
| `subscribe_strategy_to_watchlist` | `write` | 显式创建 Strategy 到目标 Watchlist 的持久订阅；重复订阅幂等返回原契约 |
| `unsubscribe_strategy_from_watchlist` | `write` | 显式取消 Strategy 到 Watchlist 的订阅；保留取消记录供审计 |
| `list_strategy_watchlist_subscriptions` | `read` | 查询 Strategy 与 Watchlist 的持久订阅契约及取消历史 |
| `prune_strategy_runs` | `write` | 按策略清理过期的评估运行（运行、逐股结果与信号）；保留最近 N 次与最近天数内的运行，operational 发布运行永不删除；默认 dryRun… |

## 策略研究与严格回测（18）

| tool | sideEffect | 用途（取自 tool description，截断） |
|---|---|---|
| `get_strategy_research_state` | `read` | 恢复指定账户与 Strategy 的研究问题、固定版本、范围、结论与下一步；披露已发布版本漂移 |
| `save_strategy_research_state` | `write` | 按账户保存现有 Strategy 的研究问题、不可变版本、区间及人工结论；revision 检测冲突，requestId 支持相同请求重放 |
| `list_strategy_evaluation_sessions` | `read` | 发现同一 Strategy 已保存的历史评估，供跨日恢复，不改变会话状态 |
| `get_strategy_evaluation_session` | `read` | 读取历史评估 session 状态，供断点续跑与审计 |
| `start_strategy_evaluation_session` | `write+external` | 创建可续跑的 Strategy 历史评估 session；不发布 operational current |
| `resume_strategy_evaluation_session` | `write+external` | 将失败或部分完成的历史评估 session 重新置为 running，供失败日期重试与断点续跑 |
| `cancel_strategy_evaluation_session` | `write` | 取消正在运行的历史评估；已完成日期事实保留，session 以稳定错误码结束 |
| `finish_strategy_evaluation_session` | `write` | 结束历史评估 session 并保留状态与错误原因 |
| `record_strategy_evaluation_day` | `write` | 记录 range replay 单日运行与 checkpoint，支持断点续跑 |
| `list_strategy_evaluation_days` | `read` | 列出历史评估 session 的逐日状态，支持跳过已完成日期 |
| `get_strategy_evaluation_progress` | `read` | 读取历史逐日规则评估的真实进度、缺失计数与取消/续跑资格；不是组合收益回测 |
| `run_local_selector_research` | `read` | 使用 PIT StockUniverse 与批量 qfq DailyBar revision 做确定性横截面排序；score 仅用于研究排序，不是收… |
| `run_strategy_research_comparison` | `external` | 对最多 8 个已保存候选做共享事实快照对照，保留全部结果/失败；训练与验证必须隔离，不自动挑选最高收益参数 |
| `get_strategy_recommendation_preflight_history` | `read` | 读取 strategy-daily-cycle 已有预检快照并按 Strategy 聚合历史 |
| `create_strict_strategy_backtest` | `write` | 基于已完成 PIT 历史评估创建隔离的组合回测运行；门禁不全时只返回门禁审计，不输出任何收益指标 |
| `execute_strict_strategy_backtest` | `write` | 执行已通过全部事实门禁的组合回测运行（内部执行步）；不生成 Advice、Trade 或通知 |
| `get_strict_strategy_backtest` | `read` | 读取隔离的组合回测运行、逐项数据门禁和可用指标 |
| `list_strict_strategy_backtests` | `read` | 列出组合回测运行；与 StrategyRun operational/evaluation 事实隔离 |

## Watchlist 与 AlertPlan（35）

| tool | sideEffect | 用途（取自 tool description，截断） |
|---|---|---|
| `create_watchlist` | `write` | 创建 Watchlist；system 类型不开放给用户创建 |
| `update_watchlist` | `write` | 更新 Watchlist 基础字段、成员策略或启用状态 |
| `archive_watchlist` | `write` | 软归档 Watchlist；不会删除成员、来源或同步历史 |
| `get_watchlist` | `read` | 查询 Watchlist、成员及其当前来源 |
| `list_watchlists` | `read` | 列出 Watchlist、当前成员数和来源健康状态 |
| `add_watchlist_member` | `write` | 为可手工维护的 Watchlist 添加 manual source |
| `add_watchlist_members` | `write` | 一次为可手工维护的 Watchlist 批量添加成员；整批校验并原子写入 |
| `update_watchlist_member` | `write` | 更新 WatchlistMember 的研究阶段或优先级 |
| `archive_watchlist_member` | `write` | 结束成员的 manual source；无其它来源时归档成员 |
| `remove_personal_watchlist_members` | `write` | 结束本人 manual/import 来源；保留其它来源，只在没有有效来源时归档成员 |
| `list_watchlist_changes` | `read` | 查询 Watchlist 同步运行及 entered/unchanged/exited 快照 |
| `preview_watchlist_import` | `write` | 预览最多 100 行、1 MiB 自选文本或 CSV；保存身份映射、重复与歧义，不建立持仓 |
| `commit_watchlist_import` | `write` | 确认规范股票身份与明确排除项；原子提交 import 来源、批次与幂等回执 |
| `create_alert_plan` | `write` | 创建引用 Watchlist 的 AlertPlan |
| `update_alert_plan` | `write` | 更新 AlertPlan 基础字段、规则与启用状态 |
| `delete_alert_plan` | `write` | 删除 AlertPlan 配置；保留 WatchTrigger 历史 |
| `list_alert_plans` | `read` | 列出 AlertPlan，可按启用状态或 Watchlist 过滤 |
| `list_personal_alert_plans` | `read` | 读取个人价格条件与可用于编辑的修订身份，不读取持仓成本或策略规则 |
| `save_personal_alert_plan` | `write` | 保存或暂停用户价格条件；按租户原子检查启用规则额度，启用必须显式确认 |
| `pause_personal_alert_plan` | `write` | 按当前修订暂停本人条件，到期后仍允许停止自动服务 |
| `remove_personal_alert_plan` | `write` | 按修订与 requestId 删除个人价格条件；保留触发历史并取消待送达事实 |
| `preview_personal_alert_plan` | `external` | 直接读取行情试算用户价格条件；不写行情缓存、正式触发、边沿、回执或通知意图 |
| `prepare_personal_alert_request` | `read` | 供 worker 冻结当前启用的价格条件、有效自选与上海日期，不访问供应商或读取账户 |
| `get_personal_alert_evaluation` | `read` | 读取已保存的个人价格条件正式评估，不刷新行情或触发通知 |
| `list_personal_watch_feedback` | `read` | 读取无账户个人提醒反馈的不可变修订，不混入账户复盘统计 |
| `record_personal_watch_feedback` | `write` | 无账户个人提醒反馈；冻结触发事实，按 expectedRevision 追加修订与请求回执 |
| `get_watch_status` | `read` | 查询 watch 最近运行与健康状态（无触发时也有心跳） |
| `list_watch_triggers` | `read` | 查询最近 AlertPlan 触发（按计划/股票/规则/优先级/反馈/通知状态过滤，准确计数并分页，支持时间或优先级排序，可选 includeSum… |
| `resolve_watch_notification` | `read` | 按 triggerId 核对一条历史提醒：返回触发当时的记录，以及它的计划来源——watchlist 规则触发给出所属告警计划，交易计划触发给出所依… |
| `set_watch_trigger_feedback` | `write` | 设置盯盘触发反馈（handled / useful / useless / ignored） |
| `get_intraday_delivery_audit` | `read` | 按账户和上海自然日汇总全部盘中行动候选的渠道时效；超时、失败、抑制与不可核验分别计数，设备送达保持未验证 |
| `prepare_watchlist_facts_request` | `read` | 冻结事实报告的成员、规则和窗口输入；不访问供应商、不要求投资账户 |
| `get_watchlist_facts_report` | `read` | 读取当前个人自选范围内的已保存事实摘要，不刷新外部数据 |
| `list_watchlist_facts_reports` | `read` | 读取个人自选事实摘要历史，按 watchlist-facts kind 与范围限定，不产生供应商成本 |
| `send_notification` | `external` | 发送通知（feishu 卡片 / log）；feishu 未配置时自动降级为 log |

## TradingPlan 与批次审计（5）

| tool | sideEffect | 用途（取自 tool description，截断） |
|---|---|---|
| `save_trading_plan` | `write` | 保存不可变的逐股结构化交易计划版本；信号不会改变实际持仓 |
| `get_trading_plan` | `read` | 按确切版本读取结构化交易计划 |
| `list_trading_plans` | `read` | 查询结构化交易计划及当前有效版本，可附带监控资格与阻塞原因 |
| `evaluate_trading_plan_budget` | `read` | 按账户当前事实合并校验全部有效计划的总仓位与单股上限 |
| `get_closing_batch_audit` | `read` | 按交易日核对各账户计划批次、收盘主报告、补充版本和通知状态；显示 16:30/18:00 时间证据与缺口 |

## Advice 与决策复盘（18）

| tool | sideEffect | 用途（取自 tool description，截断） |
|---|---|---|
| `get_advice` | `read` | 查询本账户历史建议（按账户归属过滤，输出 scope 恒为 account；另按标的 / 决策 / 来源 / 时间窗过滤，默认不含已过期）。归属判定… |
| `list_advices` | `read` | 列出本账户既有建议（按账户归属过滤，输出 scope 恒为 account；含决策、有效期、反证、风险、免责与回填状态），默认不含已过期；用于盘前简… |
| `delete_advice` | `write` | 按 id 删除历史建议（可批量，ids 1-100 个）；其 outcome 记录一并删除，删除后不可恢复 |
| `get_advice_stats` | `read` | 聚合建议准确率统计（总条数 / 平均信心度 / outcome 比例 / 命中率 / 按决策分解）；复盘口径统计包含已过期 advice；默认只统计… |
| `get_advice_attribution` | `read` | 按 Advice 关联的成交给出单条贡献度（金额与占比），区分已成交 / 无成交事实 / 未回填三态，并与账户层绩效快照做三条等式对账（逐股 / 账… |
| `get_confidence_calibration` | `read` | 按生成方式、模型与技能版本分别校准历史建议；legacy-ai 不与新来源混桶。groups 提供数据时点与信心桶；少于 20 条已跟随且填报盈亏的… |
| `save_decision_review` | `write` | 在当前账户保存不可变的决策复盘修订和显式成交关联 |
| `list_decision_reviews` | `read` | 按账户及来源/记录时间分页读取决策复盘；游标固定筛选与修订水位 |
| `get_decision_review_context` | `read` | 读取当时依据快照、账户复盘记录及当前来源状态 |
| `get_decision_review_snapshot` | `read` | 固定账户报告窗口内本地复盘修订水位与成交事实身份 |
| `get_decision_loop_review` | `read` | 读取 Advice、Trade、SignalObservation 与研究假设版本的决策闭环复盘摘要；仅做账户隔离的描述性聚合，明确展示未知项与数据… |
| `get_decision_write_receipt` | `read` | 按请求 ID 查询已提交复盘回执 |
| `propose_review_revision` | `write` | 基于一次复盘产出策略修订提案（draft）。只提案、不发布，不改策略；发布需要用户另行确认。 |
| `confirm_review_draft` | `write` | 把盘后复盘草稿确认成 DecisionReview：草稿本身不写复盘，只有本工具会写，并记录来源草稿 id。 |
| `record_advice_outcome` | `write` | 回填 Advice 的实际结果（跟单/盈亏/复盘笔记），用于准确率统计 |
| `refresh_decision_review_report` | `write` | 仅以已落库账户复盘事实生成周报不可通知补充版；收盘复盘生成后保持原样 |
| `assess_adaptive_personality` | `read` | 检查参数版本、训练/验证隔离、PIT vintage 与真实观察门禁；证据不足返回 unavailable 且不输出自适应结论 |
| `get_data_diagnostics` | `read` | 数据诊断读模型：缺行情 / 迁移未完成 / 连接失败，逐条给出表名、字段与日期 |

## 报告（6）

| tool | sideEffect | 用途（取自 tool description，截断） |
|---|---|---|
| `get_report` | `read` | 按 id 或 kind/scope/periodEnd 查询已保存报告；找不到时不隐式生成 |
| `list_reports` | `read` | 按周期查询最新报告摘要，每个周期和范围只返回一份，不返回 sections/evidence 大字段 |
| `delete_report` | `write` | 按 id 删除已保存的结构化报告（历史账簿记录）；删除后不可恢复 |
| `publish_report` | `write` | 发布一份已保存的报告，记录发布时刻的内容哈希（快照）。只有发布过的报告才能被导出为交付物。 |
| `render_report` | `read` | 从已保存的结构化 block 渲染完整报告或适合通知的精简摘要，不查询外部数据 |
| `write_report_artifact` | `write` | 把已保存报告或给定 ReportDocument 渲染成可交付文件（Markdown + 内嵌 canonical JSON）写入 $LUOOME_… |

## 研究库（Research Vault）（21）

| tool | sideEffect | 用途（取自 tool description，截断） |
|---|---|---|
| `create_research_topic` | `write` | 在 managed Vault 中创建研究主题 Markdown |
| `get_research_topic` | `read` | 读取研究主题索引、关联资料和 Obsidian URI |
| `list_research_topics` | `read` | 查询研究主题；主题不要求关联股票 |
| `archive_research_topic` | `write` | 归档 managed ResearchTopic，不删除正文、关系或历史索引 |
| `create_research_document` | `write` | 在 managed Vault 中创建研究文档 |
| `get_research_document` | `read` | 读取研究资料元数据，正文按窗口读取 |
| `list_research_documents` | `read` | 查询研究资料索引 |
| `import_local_research_document` | `write` | 把用户明确提供的 Markdown/TXT 内容复制为 managed ResearchDocument |
| `import_remote_research_document` | `write+external` | 抓取经安全校验的 URL 研究资料，保存原件并创建 untrusted managed Document |
| `link_research_document` | `write` | 在 managed Topic/Document 之间建立研究资料关系（带乐观并发校验） |
| `search_research_documents` | `read` | 搜索研究资料；不可用时明确返回 capability |
| `search_research_documents_hybrid` | `external` | 显式调用外部 embedding 做混合检索；任何不可用或不完整状态都稳定降级到 FTS5/metadata 基线 |
| `evaluate_research_embeddings` | `external` | 在固定 research-retrieval-v1 判定集上比较已配置 embedding 模型的质量、实测延迟与估算成本 |
| `rebuild_research_embeddings` | `external+write` | 增量重建 Research chunk embedding 投影；会把私人正文发送给显式配置的外部模型 |
| `get_research_embedding_status` | `read` | 读取 Research embedding capability、模型 identity 与可重建投影覆盖率 |
| `create_research_hypothesis_version` | `write` | 基于 Topic 的 thesis ResearchDocument 创建不可变研究假设版本 |
| `list_research_hypothesis_versions` | `read` | 查询 Topic 级研究假设版本（按 version 倒序） |
| `build_research_brief` | `read` | 按研究范围聚合可审计事实并生成结构化 ResearchBrief；不写入研究资料 |
| `sync_research_vault` | `write` | 扫描本地 Obsidian Vault 并重建研究索引 |
| `get_research_vault_remote_sync_status` | `read` | 查看 Research Vault 可选远端同步是否已显式启用（不返回远端或凭证） |
| `get_stock_research_view` | `read` | 按显式 stock SubjectLink 聚合股票研究，不自动扩散产业研究 |

## 分析队列（queue 面）（11）

| tool | sideEffect | 用途（取自 tool description，截断） |
|---|---|---|
| `claim_analysis_jobs` | `queue` | 领取当前账户的分析任务及冻结事实；租约 token 是写回凭据。 |
| `complete_analysis_job` | `queue` | 持有有效租约的消费者原子写回分析结果并完成任务。 |
| `fail_analysis_job` | `queue` | 报告消费失败；可重试任务回队列，耗尽或永久失败进入死信。 |
| `record_advice` | `queue` | 校验事实引用和投资建议不变量后写回，标准免责声明与有效期由领域确定。 |
| `record_analysis_result` | `queue` | 校验事实与来源后写回研究、策略草案或指定审计动作的叙述；不发布策略。 |
| `list_analysis_jobs` | `read` | 读取当前账户分析队列状态。 |
| `get_analysis_job` | `read` | 读取分析任务及终态摘要。 |
| `get_analysis_metrics` | `read` | 读取积压、完成/失败率及尚未回收的过期租约；不改变任务状态。 |
| `get_analysis_context` | `read` | 装配并保存确定性分析事实，或按 ID 读取审计快照；不调用模型。 |
| `cancel_analysis_job` | `write` | 人工取消尚未完成的任务，立即关闭旧事实包的写回窗口。 |
| `requeue_analysis_job` | `write` | 人工重排死信任务；存在同键活动任务时拒绝。 |

## Chat 会话（不暴露）（6）

| tool | sideEffect | 用途（取自 tool description，截断） |
|---|---|---|
| `create_chat_session` | `write` | 为当前账户创建一个 AI 对话会话 |
| `get_chat_session` | `read` | 读取当前账户的 AI 对话会话及消息 |
| `list_chat_sessions` | `read` | 列出当前账户最近更新的 AI 对话会话 |
| `append_chat_message` | `write` | 向当前账户的 AI 对话会话追加一条 UI message |
| `rename_chat_session` | `write` | 重命名当前账户的 AI 对话会话 |
| `delete_chat_session` | `write` | 删除当前账户的 AI 对话会话及其全部消息 |

## 自动化与系统（3）

| tool | sideEffect | 用途（取自 tool description，截断） |
|---|---|---|
| `set_automation_tier` | `write` | 设置自动化档位（关闭 / 仅提醒 / 授权执行）。只写本地设置表，不改启动配置，不影响既有授权。 |
| `get_token_usage` | `read` | 查询 token 用量（只读）。当前宿主 usage 读取接口不可用，返回 usage=null 并说明原因；不做任何估算。 |
| `list_workflow_runs` | `read` | 查询 workflow 运行审计（含 intraday-watch，统一读模型，按时间倒序） |

## 数据导入导出与归档（3）

| tool | sideEffect | 用途（取自 tool description，截断） |
|---|---|---|
| `preview_data_import` | `read` | 只读预检 SQLite 业务快照：按表给出 source/current/expected 计数、校验级别与保护/遗漏说明。不创建 Operatio… |
| `restore_data_import` | `write` | 按已冻结的 uploadId + previewHash 提交业务快照恢复（仅作精确 Operation policy，不直接对 agent 暴露）… |
| `export_business_data` | `write` | 把业务事实导出为 luoome-data 归档文件（与 restore_data_import 同一套业务表集合）写入 $LUOOME_HOME/e… |

## 不在本清单的 tool 类别

- **workflow-only**：只在 workflow 内部可用、不注册进 `toolRegistry` 的提交型工具（如 `commit_watch_evaluation`），由 `packages/tools/src/workflow-only-tools.ts` 约束。
- **batch 编排**：`packages/batch` 的 6 个 `run_*`（`run_strategy_daily_cycle`、`run_closing_report_cutoff`、`run_portfolio_performance_snapshot`、`run_intraday_plan_batch`、`run_strategy_autonomy_weekly`、`run_strategy_evaluation`）不在领域 registry，由 DSH 定时任务触发。
- **插件操作**：`packages/dsh-luoome` 的 `luoome_confirmed_operation` prepare/confirm 协议不是领域 tool，由 operation policy 派生。

## 已知「不可达但不摘除」

按 `docs/ARCHITECTURE.md` §9 与 `retired-entries.guard.test.js`，下列 tool 留在 registry 但任何暴露面都到不了，维护时**不要**当废弃删掉：

- `record_decision_trade`（`trade`，只在人工专用入口，`LUOOME_EXPOSE_TRADE=true` 直接拒绝启动）
- `execute_strict_strategy_backtest`（内部执行步，由 `create_strict_strategy_backtest` policy 在后台触发）
- 分析队列 4 件套 `claim_analysis_jobs` / `complete_analysis_job` / `fail_analysis_job` / `requeue_analysis_job`（默认部署无消费者，只在手动/隔离 worker 验收）
- Chat 会话 6 个 tool（会话由 DSH 宿主承载，领域层无插件入口）
