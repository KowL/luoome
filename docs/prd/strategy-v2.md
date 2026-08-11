# 策略工作台（Strategy Workspace）PRD

> 2026-08-11 可靠性修订：运行终态、数据质量与发布决定分离；目标契约见
> [Strategy 日运行与历史评估可靠性详细设计](../ddd/strategy-daily-cycle-and-replay-detailed-design.md)。
> 当前代码仍按本文件旧版 `complete/partial` 可用规则运行，修订项按独立开发计划分阶段实施。

> 状态：草案 v0.2
> 日期：2026-08-01
> 上位约束：[CONTEXT.md](../../CONTEXT.md)、[架构说明](../ARCHITECTURE.md)、[安全说明](../SECURITY.md)
> 关联文档：[AI 投资决策闭环产品总纲](./ai-investment-decision-loop.md)、[Strategy DSL PRD](./strategy-dsl.md)、[Strategy 与统一 Watchlist 详细设计](../ddd/strategy-watchlist-unification-detailed-design.md)
> 实现设计：[策略工作台详细设计](../ddd/strategy-workspace-detailed-design.md)
> 当前实现：`packages/core/src/entity/strategy.ts`、`packages/core/src/strategy/`、`packages/tools/src/tools/run-strategy.ts`、`packages/tools/src/tools/strategy-query.ts`、`apps/web/public/js/target-pages.js`

## 1. 文档结论

策略模块不是数据库对象管理页，而是用户持续使用的**策略工作台**：

```text
定义方法
  → 校验并发布不可变版本
  → 确定性运行
  → 查看股票池、候选池和变化
  → 观察真实信号表现
  → 生成改进草案
  → 用户确认后发布新版本
```

核心事实保持不变：

```text
Strategy
  └── StrategyVersion       不可变定义
        └── StrategyRun     一次运行事实
              ├── StrategyResult   逐股规则结果
              └── StrategySignal   可供观察的信号事实
```

股票池、候选池、运行 Diff 和健康度都是上述事实的派生视图，不新增 `StockPool`、
`CandidatePool`、`StrategyEvaluation` 或持久化 `PoolStatus`。

V2 的交付顺序：

1. 规则失败解释；
2. 执行记录与运行 Diff；
3. 股票池和候选池；
4. 调度与真实信号表现；
5. AI 洞察与版本改进草案。

严格回测、收益指标、仓位参数和自动交易不在 V2 范围。

## 2. 产品定位

### 2.1 一句话定位

> 让用户知道一个策略现在选中了什么、哪些股票接近入选、为什么发生变化，以及下一版规则应该如何改进。

### 2.2 目标用户

- 希望把个人选股方法持续运行和复盘的投资者；
- 需要检查每条规则如何影响入选结果的高级用户；
- 希望由 AI 解释变化、但不允许 AI 擅自发布策略或交易的用户；
- 通过 MCP 或 Agent 查询 Strategy 事实的外部客户端。

### 2.3 核心价值

- **可解释**：入选、未入选、数据不完整都有明确规则事实；
- **可比较**：相邻运行和不同版本的变化可区分；
- **可审计**：每次运行绑定版本、数据时间、覆盖范围和来源状态；
- **可迭代**：AI 只能提出新版本草案，历史定义和运行事实不被覆盖；
- **不越界**：StrategySignal 不等于 Advice，更不等于交易。

## 3. 目标与非目标

### 3.1 V2 目标

1. 提供围绕单个 Strategy 的稳定工作台；
2. 从已持久化 StrategyRun/StrategyResult 派生股票池、候选池和 Diff；
3. 保存足够的未命中解释，让 UI 和 Agent 不需要重新猜测规则原因；
4. 区分执行完成/失败、数据完整/部分可用/不可用和 complete-but-empty；
5. 通过 SignalObservation 展示真实信号后续表现及样本质量；
6. 允许 Agent 生成 StrategyVersion 草案，但发布必须由用户确认。

### 3.2 V2 非目标

- 新建股票池或候选池实体、表或 repository；
- 回测收益、年化、最大回撤、Sharpe、Alpha、Beta 或策略评级；
- 组合、仓位、调仓和订单执行参数；
- 策略市场或跨用户订阅；
- LLM 参与逐股规则求值；
- StrategyRun 自动触发 Advice 或真实交易；
- 默认把策略命中自动写入 Watchlist。

## 4. 领域事实与派生视图

### 4.1 事实来源

| 产品问题 | 事实来源 |
|---|---|
| 策略当前定义是什么？ | Strategy + current StrategyVersion |
| 某次运行发生了什么？ | StrategyRun |
| 某只股票为何入选或未入选？ | StrategyResult.ruleEvaluations |
| 产生了什么方向性事实？ | StrategySignal |
| 后续真实表现如何？ | SignalObservation |
| 当前股票池是什么？ | 最近一次有效 run 的 StrategyResult 派生 |
| 当前候选池是什么？ | 同一 run 的规则/排名近失结果派生 |
| 相比上次发生了什么？ | 两次 run 的 StrategyResult 集合差 |

所有派生视图必须能从事实源确定性重算，不单独持久化。

### 4.2 当前有效运行

目标状态下，股票池、候选池和概览使用该 Strategy 最近一次 `publication=published` 且已持久化
的 operational 完成运行。

- 新运行的 `status` 只表达执行生命周期：`running / complete / failed`；
- `complete` 只表示执行结束且结果包已原子提交，不直接决定是否成为当前视图；
- Summary V3 以 `dataHealth=complete / partial / unavailable` 和计数表达数据覆盖质量；
- Summary V4 的 acceptance 以版本化阈值判断覆盖质量；StrategyRun publication 再表达
  `published / withheld / non-publishing`；
- 只有全市场 operational、执行完成且通过 acceptance 的运行可以 published；
- replay/backtest、显式子集 scan 一律 non-publishing；
- 存量 `status=partial` 记录按幂等 migration 的 publication 结果读取，并标记 legacy warning；
- `failed` 不覆盖上一版有效视图；
- `published` 且零入选是合法空结果，必须显示“本次运行已完成，零入选”；
- `persist=false` 的样本试算不进入历史列表，也不替换当前视图；
- 当前没有 published 运行时，工作台显示“尚无可用运行”，不得展示空股票池造成误解。

### 4.3 股票池

股票池是当前有效运行中 `selected=true` 的 StrategyResult 集。

默认列：

- 股票；
- score 与 rank（存在 scoring 时）；
- 相对上次运行的变化；
- 规则命中摘要；
- dataAsOf 与数据状态；
- 是否已持仓、是否已在 Watchlist（只读关联）。

筛选：

- 全部；
- 新增；
- 排名上升；
- 评分下降；
- 已持仓；
- 已关注。

### 4.4 候选池

候选池回答“哪些股票最接近进入当前股票池”，但不使用收益概率或主观相似度。

V2 支持两类确定性候选：

| 类型 | 定义 | 距离表达 |
|---|---|---|
| rule-near-miss | `selection.logic=all`，恰好一个 selection rule 为 `not-matched`，其余均为 `matched`，且没有 `unknown/error` | 唯一阻断规则及其解释 |
| ranking-near-miss | selection 已通过并产生 score/rank，但因 `scoring.top` 截断而 `selected=false` | 当前 rank 与 top 的差 |

不进入候选池：

- 含 `unknown/error` 的结果：归入“数据不完整”；
- `logic=all` 且两个及以上规则未命中：归入“未入选”；
- `logic=any` 且没有规则命中：V2 不声明规则距离；
- 没有可证明距离的结果。

`logic=any` 只支持 ranking-near-miss，不支持 rule-near-miss。未来若引入结构化阈值，
必须另行定义距离口径；不得从 score 推断“接近入选”。

候选不等于 StrategySignal，不自动生成 Advice，也不自动加入 Watchlist。

### 4.5 规则解释契约

每条 selection/signal rule 的求值结果必须保留：

- ruleId；
- `matched / not-matched / unknown / error`；
- 求值涉及的实际输入或可审计快照；
- 命中或未命中的解释；
- 数据缺失或求值错误原因；
- dataAsOf。

产品不得依赖 UI 或 LLM 重新解析表达式来生成失败原因。AI 可以改写已有事实以便阅读，但不能补造
缺失值、阈值或因果解释。

现有实现仅在部分命中路径保留 evidence。规则失败解释是股票池、候选池、Diff 和 AI 洞察上线前的
共同前置条件。

### 4.6 运行 Diff

Diff 默认比较同一 Strategy 最近两次 published operational run，输出：

- entered：本次进入股票池；
- exited：本次退出股票池；
- stayed：连续入选；
- candidate-promoted：候选转入选；
- selected-demoted：入选转候选或未入选；
- rankChanged；
- scoreChanged；
- blockingRuleChanged。
- data-unavailable：任一侧缺少该股票的可靠结果，不能判断进出。

规则：

- 默认优先比较相同 StrategyVersion；
- 若两次运行版本不同，页面必须标记“定义已变化”，同时展示 from/to version；
- 跨版本 Diff 可以展示事实变化，但不得把变化单独归因于市场；
- `failed/running/withheld/non-publishing` 不参与当前视图的默认相邻比较；存量运行按 migration 后
  publication 参与；
- 任一侧结果缺失或为 unknown/error 时，只输出 `data-unavailable`，不得推断 entered/exited；
- `REMOVED` 是 Diff 输出，不是 StrategyResult 的持久化状态。

### 4.7 StrategyRun 审计事实

V2 将 `StrategyRun.summary` 和 `inputSnapshot` 从自由 record 收口为稳定、可展示的事实；
Summary V3 进一步把执行状态与数据完整度分离。

摘要至少包含：

- universe/candidate 数；
- evaluated 数；
- selected 数；
- signal 数；
- dataHealth；
- incomplete 数；
- failed 数。

输入审计至少能够还原：

- StrategyVersion 与 definitionHash；
- 实际运行股票集合；
- coverage；
- dataAsOf；
- StockUniverse 同步检查点（具备后写入）；
- 行情/日线 provider 状态；
- 数据缺失与不支持维度。

V2 先保证可审计，不宣称完整可重放。历史 StockUniverse、行情版本和运行引擎版本能够恢复后，
再引入正式 DataSnapshot identity。

## 5. 信息架构

```text
策略
├── 我的策略
│     ├── 概览
│     ├── 股票池
│     ├── 候选池
│     ├── 执行记录
│     ├── AI 洞察
│     └── 设置
├── 创建策略
└── 模板中心
```

“股票池”和“候选池”是产品标签，不恢复旧 StockPool 领域模型。

## 6. 页面详设

### 6.1 股票标识与行情入口

策略工作台内所有展示股票的地方，包括股票池、候选池、运行结果、StrategySignal、运行 Diff、
AI 洞察的事实引用和设置页的关联标的，都必须使用与首页看板一致的两行股票标识：

```text
比亚迪
002594.SZ
```

- 第一行展示股票名称，第二行展示带交易所后缀的完整代码；
- 名称和代码作为同一个可点击区域，点击任一行都进入既有行情页；
- 行情深链接固定为 `#market?stockId={stockId}&range=3m`；
- 使用真实 `<a href>`，支持键盘、复制链接、浏览器返回和在新标签页打开；
- 股票名称由本地股票目录解析，前端不得从代码猜名称；
- 历史标的无法解析名称时显示“名称暂缺”并保留代码与行情入口；
- 表格存在展开、加入 Watchlist 等行内操作时，只让股票标识区域跳转，避免整行点击与操作冲突；
- 不得只显示代码，也不得把名称和代码挤在同一行。

### 6.2 我的策略

使用卡片而非裸表格。每张卡片展示：

- 名称和状态；
- 当前有效版本；
- 当前股票数；
- 最近一次可用运行时间；
- 相比上次的新增/退出数量；
- 最近失败或数据不完整提示；
- AI 一句话摘要（Phase B，有事实才展示）。

状态优先级：运行失败/数据不完整 > 最近变化 > 无变化。没有有效运行时不显示伪造的零值。

### 6.3 概览

每天第一眼看到：

- 当前 Strategy 状态和版本；
- 最近一次有效运行的数据时间；
- 股票池数量；
- rule-near-miss / ranking-near-miss 数量；
- 新增、退出及最大排名变化；
- provider/data completeness；
- 进入执行记录、候选池和异常详情的入口。

不展示收益、回撤、评级或“胜率预测”。

### 6.4 股票池

展示 §4.3 的当前结果。股票名称和代码遵守 §6.1，点击进入既有行情页，不默认跳转研究档案或
AI 对话；研究档案作为独立行内操作保留。

用户动作：

- 查看逐规则解释；
- 查看该股票的历史入选/退出；
- 手动加入个人 Watchlist；
- 基于当前事实主动生成 Advice。

“加入 Watchlist”产生 manual source，不修改 StrategyResult。

### 6.5 候选池

默认分为：

1. 规则近失；
2. 排名近失；
3. 数据不完整（独立区块，不计入候选数量）。

每条必须回答：

- 为什么尚未进入；
- 距离口径是什么；
- 哪条规则或排名构成阻断；
- 数据截止时间；
- 是否存在 unavailable/unknown。

### 6.6 执行记录

按 StrategyRun 倒序展示：

- 时间、mode、version；
- 执行状态 complete/failed（历史记录可能为 partial）；
- dataHealth complete/partial/unavailable；
- universe/evaluated/selected/signal/incomplete/failed 计数；
- provider 状态；
- persisted 与试算语义；
- 查看 results、signals 和 Diff 的入口。

Diff 可以选择任意两次持久化运行，但默认选择最近两次 published operational run；跨 scope
比较必须显式确认并标记非生产事实。

### 6.7 AI 洞察

AI 洞察是基于事实的解释区，不是独立聊天入口。

内容：

- 最近 30 天进入/退出和候选转正变化；
- 行业分布与平均分变化；
- 规则阻断频次；
- StrategySignal 的 T+1/T+3/T+5/T+20 真实表现；
- 版本变化前后的事实差异；
- 可生成新 StrategyVersion 草案的改进建议。

真实表现必须：

- 来自 SignalObservation；
- 展示样本数、缺失率、观察窗口和 benchmarkStatus；
- 样本不足或数据不可用时显示 unavailable；
- 不表述为组合收益、回测收益或未来概率。

当前 SignalObservation 仅完成 watch-trigger 路径，StrategySignal 直接观察仍需扩展 source kind 和
生成流程；该依赖完成前不展示策略真实表现。

### 6.8 设置

展示和管理：

- Strategy 基本信息；
- 不可变版本历史；
- 校验错误和字段依赖；
- 发布、暂停、恢复；
- AlertPlan 中引用该 StrategySignal 的规则；
- 调度状态（Phase B）。

当前 DSL v1 尚无可用的 schedule 字段，调度器也未交付。在调度配置归属确定并实现前，页面不提供
无法生效的运行时间设置。

### 6.9 AI 实验室（Phase C）

AI 可以：

- 根据自然语言生成 StrategyVersion 草案；
- 根据 Diff、规则阻断和 SignalObservation 提出修改；
- 解释修改影响和缺失数据；
- 发起样本试算。

AI 不可以：

- 原地修改已发布版本；
- 未经确认校验、发布或激活版本；
- 使用未注册字段；
- 把 score 或真实信号表现包装成收益承诺；
- 调用真实交易。

改进路径固定为：

```text
事实复盘
  → AI 生成新版本草案
  → 用户查看 definition diff
  → 静态校验
  → 用户确认发布
  → 新 StrategyRun
```

V2 复用 `parentVersionId + changeSummary + agent_run` 保存迭代上下文，不新增
`StrategyImprovementProposal` 聚合。

## 7. 与 Watchlist、AlertPlan 和 Advice 的关系

### 7.1 Watchlist

StrategyResult 是策略命中的唯一事实；策略工作台的股票池不依赖 Watchlist。

V2 默认行为：

- StrategyRun 不自动创建或同步 Watchlist；
- 用户可以把结果手动加入个人 Watchlist，产生 manual source；
- 不删除现有 `WatchlistMemberSource(strategy)` 领域能力；
- 未来若交付“订阅策略到 Watchlist”，它只能是显式 opt-in 的可重建投影；
- 投影只有 complete sync 才能结束缺失 strategy source，partial/failed 必须保留上一版并标 stale；
- 结束 strategy source 不得删除仍有 manual/ai/portfolio/import 来源的成员。

因此，本 PRD 只 supersede “每次 StrategyRun 默认原子更新 Watchlist”的产品行为，不 supersede
统一 Watchlist 的多来源领域模型。

### 7.2 AlertPlan

AlertPlan 继续消费持久化 StrategySignal：

- 盘中 strategy-signal 规则不临时运行全市场 Strategy；
- 规则、冷却、每日上限和送达状态仍属于 AlertPlan/WatchTrigger；
- Strategy 设置页只展示关联关系，不复制提醒配置。

### 7.3 Advice

- StrategyResult、StrategySignal、Diff 和 SignalObservation 可以成为 Advice 证据；
- Strategy 工作台不会自动生成 Advice；
- 用户主动生成 Advice 时仍需包含反证、风险、免责声明和有效期；
- StrategySignal 和候选状态不得直接翻译成 buy/sell。

## 8. 副作用与权限

| 操作 | 副作用 | 确认要求 |
|---|---|---|
| 查看策略、运行、结果、Diff | read | 无 |
| 样本试算且需要外部行情 | external | 按 external 策略 |
| 持久化正式运行 | external + write 语义 | Agent 必须确认 |
| 创建版本草案 | write | 必须确认 |
| 校验并回写版本状态 | write | 必须确认 |
| 发布、暂停、恢复 | write | 必须确认 |
| 生成 AI 洞察 | advice 或受控 LLM 推理 | 不得触发 trade |

任何 Strategy 路径都不得调用真实交易 tool。

## 9. 产品指标

| 目标 | 指标 |
|---|---|
| 可用性 | 执行完成率、dataHealth 分布、incomplete/failed 原因分布 |
| 可解释 | selected/candidate 条目中具备完整规则解释的比例 |
| 发现价值 | 候选转入选数量、结果被加入 Watchlist 的比例 |
| 持续使用 | 每周查看执行记录或 Diff 的活跃 Strategy 数 |
| 复盘质量 | 有足够样本的 SignalObservation 比例、数据缺失披露率 |
| 迭代闭环 | 由事实复盘产生、经确认发布的新版本数量 |

不使用短期收益或模型自报信心度作为 V2 成功指标。

## 10. 分期

### Phase A0：解释与审计基础

- 未命中规则保存可审计解释；
- StrategyRun summary/inputSnapshot 结构化；
- 执行记录展示 results、signals、provider 状态；
- 执行 complete/failed、数据完整度和 empty 的页面语义收口。

### Phase A1：派生视图

- 股票池；
- rule-near-miss 与 ranking-near-miss；
- 数据不完整区块；
- 相邻可用运行 Diff；
- 概览今日变化。

不新增事实表。

### Phase B：自动运行与真实观察

- 调度配置归属决策与调度器；
- scheduled StrategyRun；
- StrategySignal → SignalObservation 接线；
- 健康度和真实表现；
- 基于事实的 AI 洞察；
- AlertPlan 关联展示。

### Phase C：AI 版本迭代

- AI 生成 StrategyVersion 草案；
- definition diff；
- 试算；
- 用户确认后校验、发布；
- AI 工作记录。

### Phase D：严格回测

仅在 [Strategy DSL PRD §9](./strategy-dsl.md#9-回测前置条件) 的 qfq、历史 universe、数据可获得时间、
退市/停牌/涨跌停、费用滑点、数据/代码版本和偏差控制全部满足后建设。

## 11. 验收标准

### 11.1 Phase A0

- 每条 selection rule 都能展示 matched/not-matched/unknown/error 和原因；
- UI 与 Agent 不需要重新解析表达式猜测失败原因；
- complete 空结果、执行失败与数据部分可用明确区分；
- StrategyRun 可追溯 version、definitionHash、dataAsOf、coverage 和 provider 状态；
- 执行记录能查看对应 StrategyResult 与 StrategySignal。

### 11.2 Phase A1

- 股票池来自最近一次持久化且 publication=published 的 operational run 中 `selected=true` 结果；
- 股票池、候选池、运行结果、signal 和 Diff 中的股票均以上方名称、下方完整代码展示，且股票标识区域可进入行情页；
- rule-near-miss 只适用于 `logic=all` 且恰好一个确定性阻断规则；
- ranking-near-miss 能解释 rank 与 top 的差；
- unknown/error 不计入候选池；
- Diff 可从两个 run 确定性重算，不持久化 REMOVED/PoolStatus；
- 跨版本 Diff 明示版本变化，不把变化单独归因于市场；
- 数据部分可用的完成运行只有通过 acceptance 才发布明确结果；failed/withheld/non-publishing run
  不覆盖上一版有效视图；

### 11.3 Phase B/C

- StrategySignal 真实表现展示样本数、窗口、缺失率和 benchmarkStatus；
- 数据或样本不足时显示 unavailable，不展示伪精度；
- 调度只触发 StrategyRun；
- Agent 只能生成版本草案，发布必须经用户确认；
- score 不表述为收益概率，signal 和候选不表述为 Advice；
- Strategy 的任何运行、洞察或迭代都不能触发真实交易。

## 12. 实施决策

1. 调度采用独立 scheduler 配置，不写入不可变 Strategy DSL；Phase B 另行细化 cron、时区、补跑和并发锁；
2. ranking-near-miss 默认展示 top 之后 20 条，调用方可在 1～100 内调整；
3. StrategySignal 直接创建 SignalObservation，WatchTrigger 的观察链保持独立；
4. V2 不交付自动 Strategy → Watchlist 同步；未来若提供，必须是显式 opt-in 且只允许 complete sync 结束缺失来源。
