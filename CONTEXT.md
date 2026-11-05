# Luoome 领域语言

本文件定义当前产品的业务概念、对象关系与关键不变量。算法、存储、兼容和运行细节分别由
[架构说明](./docs/ARCHITECTURE.md)及对应详细设计承载；有设计或代码不等于默认入口已接通。

## 当前形态

Luoome 是通过 DSH 插件使用的单机个人投资研究工具，覆盖沪深 A 股。DSH 承担对话、模型、
任务调度与宿主身份；插件提供业务工具和面板，Node SQLite 的 `luoome.db` 是唯一事实库。
`Account` 表示投资账户，不承担登录或租户语义；本地多账户仍分别维护账本与复盘。

个人版按用户明确意图执行写入，保留账户绑定、能力控制、冻结输入、幂等和操作回执，
不要求额外人工审批。持续运行还需 DSH 任务与精确任务授权；批处理、自动执行默认关闭。
当前入口与配置以[插件说明](./packages/dsh-luoome/README.md)为准。

## 1. 市场事实

### 股票目录（StockUniverse）

回答“明确覆盖范围内有哪些可被系统识别的股票”。目录保存股票身份，不是行情快照。
完整快照校验后原子提交；失败、空结果或分页不完整时保留上一版，缺失不物理删除身份。
历史查询使用当时成员及属性，缺历史属性保持 unknown，不用当前目录回填。

详见[行情底座设计](./docs/ddd/market-data-and-stock-universe-detailed-design.md#41-股票目录stockuniverse)。

### 行情与规范日线（Quote / DailyBar）

Quote 是有来源和时间的市场观测；行情发生时间与抓取时间分开，刚抓取不等于可用于当前决策。
指标、Strategy 和 AlertPlan 统一使用前复权（`qfq`）DailyBar；缺复权因子或昨收时保留
unknown/unavailable，不用今开或伪造因子代替。日线、原始未复权数据和当前报价分别表达。

### 个股档案、财务快照与板块关系

`StockProfile` 提供最近披露的股东户数及来源板块事实；`FinancialSnapshot` 提供当前数据商
财务视图；`SectorMembership` 提供当前行业/概念关系。它们不推导交易信号，也不证明历史 PIT。
财报期间、披露日与获取时间分别保留，缺值不填零，当前关系不回填历史成分。

原始日线和市场公司行动可独立导入，但不进入规范 qfq 表，不自动修改账户现金或持仓，
也不自动使严格回测具备完整公司行动事实。详见[Fuyao 分域设计](./docs/ddd/fuyao-data-expansion-and-tushare-retirement-design.md)。

### 市场情绪与连板天梯（AShareSentimentSnapshot / LimitUpLadder）

回答“指定交易日观察到了什么市场事实”。各维度独立保留来源、时间与可用性，缺失不等于零。
`ladderLevel` 是当日可审计连板层级，不是 Advice、收益概率或交易信号。
历史重放只读同日、同来源 PIT 快照，不拿当前天梯、近期炸板池或 mock 推断历史。
炸板、断板等缺少合格历史证据的字段保持 unknown，不提前进入 Strategy 字段库。

详见[连板天梯设计](./docs/ddd/limit-up-ladder-detailed-design.md)。

## 2. 策略发现

### Strategy / StrategyVersion

回答“用什么方法发现、评分并解释研究机会”。Strategy 是稳定身份；StrategyVersion 是不可变定义，
先校验再发布。AI 可以提出草案，冻结后的规则匹配、评分和历史计算由确定性引擎执行。
首次发布前，draft Strategy 的 valid 版本可非持久化试跑；正式运行要求 active，
paused/archived 不接受试跑。创建、校验或试跑都不隐含发布意图。

### StrategyRun / StrategyResult / StrategySignal

StrategyRun 是一次执行，StrategyResult 是逐股入选及规则求值事实，StrategySignal 是跟踪事件。
运行的执行状态、数据质量和发布资格分别表达：执行 complete 不代表数据齐全；
只有通过 acceptance 且 `publication=published` 的 operational run 更新当前股票池。
历史评估、显式子集和试跑不覆盖正式当前事实。

entry 信号面向最终入选股；exit/risk 还覆盖同版本此前仍在跟踪的股票，退出后结束跟踪。
信号按首次或恢复命中的边沿与冷却产生，不等同每日规则命中。它们不等于 Advice 或成交，
也不由 WatchlistMember 的阶段代替。

### SignalObservation / StrategyInsight

SignalObservation 沿确切信号记录 T+1/T+3/T+5 的事后观察；T+20 只保留历史读取兼容。
StrategyInsight 汇总运行变化、规则阻断和信号观察，AI 只能解释并引用已有事实。
事后观察不等于组合回测、未来概率或买卖建议；缺失率、事实截止与小样本限制保留。
历史明细清理不改写运行当时的计数、建议快照或引用。

### StrategySchedule

回答“已发布策略何时到期”。调度是独立于版本的可变配置，修改不改变策略定义身份。
DSH 定时任务调用批处理才会实际执行；配置日程、取得授权、执行完成和通知送达是不同事实。
非交易日及暂停策略不运行；并发防重与执行审计由既有日循环承担。
当前插件不开放配置自动推荐政策，不把日循环的 facts-only 结果说成已生成 Advice。

内部运行视图、数据适配、快照兼容与审计见
[架构契约](./docs/ARCHITECTURE.md#strategy-内部运行视图与兼容契约)；日循环与历史评估见
[可靠性设计](./docs/ddd/strategy-daily-cycle-and-replay-detailed-design.md)。

## 3. 关注与提醒

### Watchlist

回答“当前持续研究哪些股票”。WatchlistMember 以 `watchlistId + stockId` 唯一，维护
`discovered → watching → researching → confirmed → archived` 阶段及优先级。
同一成员可有 manual、strategy、ai、portfolio、import 多个来源；一个来源结束不删除其它有效关注。
普通列表创建可省略 kind 与 membershipPolicy，工具统一默认 personal/mixed；显式分类与持仓列表约束仍校验。

Strategy 到 Watchlist 通过显式持久订阅连接；只有 published operational run 可以同步。
complete sync 才能结束缺失来源，partial/failed 只标 stale，不将数据缺口解释为股票退出。

### AlertPlan

回答“Watchlist 成员发生什么时提醒”。配置规则、组合逻辑、冷却、每日上限及启停状态，
引用列表但不拥有成员。停用列表不扫描，被方案引用的列表不直接删除。
盘中策略信号规则读取持久化 StrategySignal，不临时运行全市场选股。

### WatchTrigger

记录成员命中规则的事实、证据、数据时间与投递状态；删除 AlertPlan 不删除触发历史。
试跑不写正式触发、边沿或观察，不消耗正式去重与额度；运行审计仍可保留。
触发与投递分开保存；心跳正常、规则可求值、通知尝试和渠道送达分别表达。
飞书未配置时记 fallback-log，不宣称已送达；失败补偿受当日、有效范围、重试和额度约束。

来源同步与预警补偿的精确契约见[Strategy 与 Watchlist 设计](./docs/ddd/strategy-watchlist-unification-detailed-design.md)。

## 4. 建议与逐股计划

### Advice / AnalysisContext

Advice 回答“面对当时事实，如何判断”。它保存立场、依据、反证、风险、信心度、周期与有效期；
confidence 不表达未来成功概率，Advice 不等于交易。
AnalysisContext 是带事实时间、证据编号、哈希与写回期限的冻结事实包，AnalysisProvenance
记录生成器、模型、技能及上下文来源；历史 `legacy-ai` 不补造模型身份。

日常分析主线是 `AnalysisContext → DSH 推理 → record_* 校验写回`，不创建 AnalysisJob。
只接受可核对引用与有效事实，持久化即时外部事实后才能作为冻结依据；聊天中刷新不自动入证据。
市场判断只在上海当日有效；盘中行动与盘后研究分别按适用时效校验。过期内容可审计，
不沿用为当前判断。精确窗口见[分析事实包与写回时效](./docs/ARCHITECTURE.md#分析事实包与写回时效)。

### 逐股交易计划（TradingPlan）

回答“对这个账户的这只股票，什么条件下做什么、目标仓位多少、持有多久、何时失效”。
计划拥有稳定身份与不可变版本，把观察、建仓、加仓、持有、减仓、退出、回避与价格方向分开。
入场与目标仓位用区间表达，保留实际仓位落点与降级依据；生效计划至少有一条结构化失效条件。

计划锚定生成时的账户事实指纹；账本变化后，旧区间和条件同时失效，必须重新生成。
有效计划共用建议预算，同股多策略不重复占用；总仓位/单票上限默认 100%/30%，不设置行业合计上限。
超限持仓仍可减仓；尚未登记的卖出不释放实际现金。

复核时间与硬有效期分开；仍有效且行动前提未变时复用原版，修订草案不替代生效版或释放其预算。
草案保留未满足前提，不能当作当前可执行动作；观察计划在条件满足前不建仓。
盘中只按计划条件确定性求值，风险/退出命中阻止入场提醒，不调用 AI 改写计划。
`ready` 只表示具备监控资格，不代表后台已执行或通知已送达；实际持仓与可卖数量由账户事实决定。

区间选点、波动率样本、预算口径、期限与监控细则见
[账户事实与逐股计划实现契约](./docs/ddd/ai-investment-workspace-detailed-design.md#账户事实与逐股计划实现契约)。

## 5. 账户账本

### Account / Holding / Trade

分别表示投资账户、实际持仓和已发生的成交。成交由用户在系统外完成，再登记到本地；
建议、价格穿越、提醒或“已采纳”都不推断成交。账户资金流水与持仓纠错也保留明确来源。
市场公司行动数据不自动变成账户现金或持仓变更。

### 账户现金余额与账户事实（AccountFacts）

现金是 `Account.cashBalance`，由交易、持仓改动及资金流水在同一事务内增减；余额不为负。
AccountFacts 是仓位计算的唯一账户输入：现金余额加当前持仓按合格行情估值，
并用现金、持仓与本金形成指纹。账本不自洽、历史缺口或有数量持仓缺合格行情时标 unavailable，
不输出精确可执行仓位；缺价不以成本价替代。

账本修改校验旧值，重试遵守请求幂等；持仓调整保留数量与现金差额，对账按原始账本重放。
迁移不覆盖已有余额、不假定历史缺口已消失。原 AccountSnapshot 已退役，不作为当前分母。
存储、迁移和对账细节见[账户事实实现契约](./docs/ddd/ai-investment-workspace-detailed-design.md#账户事实与逐股计划实现契约)。

## 6. 复盘与报告

### 决策与复盘（DecisionReview）

回答“账户面对哪份当时依据，用户记录了什么，后来有哪些可核对事实”。一条记录锚定
Advice、确切 TradingPlan 版本、WatchTrigger 或账户级日复盘，以账户加来源身份唯一；
首次冻结来源，后续追加不可变修订。来源发生时间与用户记录时间分别查询，来源删除仍保留快照。
反馈、成交与事后市场观察分别表达，不按同股或相近时间拼接证据。

更新省略字段保留、显式 null 清空可空值；成交关联用空数组解除。用户填报盈亏缺失不等于零，
统计只消费当前账户明确反馈，填报盈利占比不代表账户收益率或未来概率。
登记未入账的外部成交时，成交、持仓、现金、复盘修订与请求回执同事务提交；
属于 trade 的专用人工路径，不通过插件或其它远端工具面开放，也不调用券商下单。

详见[决策复盘设计](./docs/ddd/mvp3-decision-review-detailed-design.md)。

### 个性化报告（Report）

回答“周期里发生了什么、哪些数据缺失、去哪里继续研究”。结构化事实是权威，Markdown 是派生展示；
报告不自动生成 Advice 或成交，生成与通知分别记录。
收盘复盘等待当日期望策略与账户计划批次完成后统一生成，同日同范围只保留一份；
当日 18:00 尚未完成仍等待，不提前发布缺口版，后到事实不追加或改写收盘正文。
跨日恢复可按既有契约补记逾期缺口，不拿当前数据重建当时未知的事实。
周报可对后补或更正的复盘生成不可变补充版，重试复用结果，复盘补充版始终不通知。

账户绩效按真实交易、资金流水与合格行情计算，缺数据保持缺口；口径见
[账户绩效设计](./docs/ddd/account-performance-detailed-design.md)，报告修订见[复盘设计](./docs/ddd/mvp3-decision-review-detailed-design.md)。

## 按需研究与实验能力

这些能力不作为理解日常主线的前提；是否可用以当前插件暴露面和事实门槛为准。

### ResearchTopic / ResearchDocument

研究主题是持续上下文，资料是显式关联的证据索引；主题可覆盖多只股票、产业、事件或宏观问题。
正文权威源为本地 Obsidian Vault，SQLite 保存可重建索引、关系、分块与同步审计。
股票研究档案只投影显式链接，分别展示支持、反证、未知与事实时间，不按行业猜研究结论。
资料、selector 与 adaptive personality 均不自动生成 Advice 或交易。
详见[研究库设计](./docs/ddd/research-vault-detailed-design.md)。

### 参与方向与共识（InvestmentWorkspace）

方向是有来源、覆盖范围和事实时间的研究提案，共识记录用户选择、系统反对、约束与复核期限。
方向共议是已确认需求；共识版本与跟踪能力已在 core/tools 实现，默认插件仅接部分读取，
保存共识、开启方向跟踪和候选查询的完整入口尚未接通，不表述为当前默认旅程。

策略方向引用真实已发布版本与运行；市场方向不编造策略身份，缺真实候选映射时不开展个股跟踪。
共识保存不等于已运行或已通知，也不自动创建策略；后续跟踪复用 Watchlist、Strategy 订阅及
Advice/TradingPlan，不另造仓位或退出规则。详细时效、版本和跟踪契约见
[方向研究与共识契约](./docs/ddd/ai-investment-workspace-detailed-design.md#方向研究与共识契约)。

### 目标研究长跑

GoalRun 已有插件入口，表示明确意图启动的有界研究进度；请求冻结目标、范围、模型路由及轮次/成本预算。
每轮引用持久化 AnalysisContext，结论通过结构和证据校验才算成果；预算耗尽不等于达成目标。
取消保留已有产出并阻止迟到提交，重启保留审计但不重放模型请求；它不自动写成 Advice、策略或成交。
用法见[目标式研究长跑](./packages/dsh-luoome/README.md#目标式研究长跑)。

### 分析任务与来源

AnalysisJob 是已实现的可选后台分析任务，具有租约、重试与原子结果写回，不是日常分析的必经步骤。
默认不开放模型可见入队入口，不运行常驻 worker；显式配置后台模型后可由受信任内部路径执行。
队列能力的保留不要求新增生产者；空队列不触发模型请求。详见
[可选后台模型](./packages/dsh-luoome/README.md#可选后台分析模型)和[分析架构](./docs/ARCHITECTURE.md#分析事实包与写回时效)。

### 严格回测（StrictBacktest）

使用历史可交易性事实，按 D+1 开盘、整手、费用与滑点模拟组合执行，区别于历史选股重放和 T+n 观察。
已有实现，但可用范围受 PIT 股票目录、日线、可交易性、公司行动和基准事实逐项限制；
当前市场公司行动尚未接入严格同步链，保持 unavailable，不宣称完整复权回测。
详见[组合回测设计](./docs/ddd/strategy-strict-backtest-detailed-design.md)。

### FinancialFact / FundamentalScore

这是已实现部分代码的实验能力：当前严格财务适配只支持显式 mock，真实门槛未通过，未接入 Strategy DSL。
FinancialFact 保存报告期间、公开/修订时间及本地记录时间；FundamentalScore 是确定性规则分，不是概率。
不以当前财报视图、抓取时间、当前行业或测试数据替代历史 PIT 证据，未通过真实验收前保持 not-ready。
因子、评分版本与横截面计算留在[基本面实验设计](./docs/ddd/fundamental-factor-scoring-phase3-detailed-design.md)。

## 跨领域约束与实现索引

- Advice、StrategySignal、计划与提醒均不自动下单；trade 不进入任何插件或远端工具面。
- write/external 由受信任部署显式开启；明确操作意图不自动启用批处理或定时任务授权。
- 操作执行中或结果未知时先核对原回执，不盲重试；业务事务与宿主操作回执分别维护。
- 个人分析限定指定账户持仓与允许的关注范围；跨账户事实与历史反馈不混入当前账户统计。
- 数据缺失、事实过期、样本不足、执行失败及投递未知分别披露，不用零值或旧值补造结论。
- 当前事实、历史观察、研究试跑与正式发布分别表达；旧版本读取兼容不恢复当前行动资格。

PluginOperation / PluginAutomationGrant 的冻结输入、账户绑定、任务指纹与授权版本是执行机制，见
[纯插件执行与授权内核](./docs/ARCHITECTURE.md#纯插件执行与授权内核)。SourceObservation 是进程内
运行观测，重启归零，不证明历史覆盖；精确分类与新鲜度见[数据源观测设计](./docs/ddd/source-pluggability-and-observation-design.md)。

托管、多租户、独立 CLI/TUI、stdio MCP 入口，以及旧 Tactic/StockGroup/StockPool 已退役，
不作为新功能的领域模型或实现前提。演进与阶段验收从[文档导航](./docs/README.md)进入，
不将历史方案作为当前运行契约。
