# 统一 Watchlist（投资观察中心）PRD

> 状态：目标模型草案；需要从现有 StockGroup 渐进迁移
> 日期：2026-07-29
> 上位文档：[AI 投资决策闭环产品总纲](./ai-investment-decision-loop.md)
> 关联文档：[Strategy DSL](./strategy-dsl.md)、[AI 投资决策闭环](./ai-investment-decision-loop.md)

## 1. 文档结论

luoome 应使用统一的 `Watchlist` 作为“投资机会持续观察”的正式领域对象，而不是长期让
`StockGroup`、策略股票池、AI 发现池、自选股和持仓观察分别存在。

统一不等于把所有数据塞进一张表。目标模型：

```text
Stock                       唯一股票身份
  │
  ▼
Watchlist                   观察容器
  │
  ▼
WatchlistMember             股票与 Watchlist 的当前关系、优先级
  │
  ├── WatchlistMemberSource 手工、Strategy、AI、Portfolio 等多来源
  └── MembershipSnapshot    每次自动刷新时的可审计快照

Watchlist ──► AlertPlan ──► WatchTrigger
```

`StockGroup` 应迁移为 Watchlist 的兼容实现；`GroupMemberSnapshot` 迁移为成员来源快照；
当前 `StockPool / WatchPlan` 在目标语言中改为 `AlertPlan`，避免“Watchlist”和“WatchPlan”
同时都被中文称为“盯盘”。

## 2. 为什么需要统一 Watchlist

### 2.1 当前分裂

原始 PRD 中分别存在：

- 用户自选；
- Strategy Watchlist；
- AI Discovery；
- Portfolio Watch；
- 当前实现中的 manual/holdings/formula/llm StockGroup。

它们本质都在表达：

> 某只股票因为一个或多个来源，进入了用户需要持续观察的集合。

如果分别建模，会产生：

- 同一股票在多个列表中重复保存；
- 关注原因和来源事实无法统一；
- 策略退出时不知道是否应该删除用户手工关注；
- 持仓、AI 和策略来源互相覆盖；
- Agent 需要理解多套 CRUD 和状态语义。

### 2.2 统一后的收益

- 一个股票在一个 Watchlist 内只有一个当前成员关系。
- 一个成员可以同时拥有多个来源。
- 来源退出不会误删其它来源。
- 用户优先级、提醒和研究档案有统一入口。
- Strategy、Agent 和 Portfolio 都通过相同契约向 Watchlist 提供来源。
- 跨 Watchlist 仍可通过“全部观察”视图去重聚合。

## 3. 产品定位

### 3.1 一句话定位

> 统一管理投资机会的持续观察关系，并保留它为什么进入、发生过什么以及当前是否仍值得关注。

### 3.2 目标用户

- 用多个主题和策略管理候选股的个人投资者。
- 希望把自选、策略发现、AI 发现和持仓观察放到一个体系的用户。
- 希望持续沉淀关注理由和研究进度，而不是只收藏代码的用户。

### 3.3 非目标

- Watchlist 不替代规范 `Stock`。
- Watchlist 不复制 Holding、Trade、Advice 或 StockEvent。
- Watchlist 成员不等于推荐或买入建议。
- Watchlist 阶段变化不自动触发交易。
- 首期不做跨用户分享、公开榜单或跟单。

## 4. 领域模型

### 4.1 Watchlist

```text
Watchlist
- id
- name
- description?
- kind: personal | strategy | portfolio | system
- membershipPolicy: manual | synced | mixed
- enabled
- defaultAlertPlanId?
- createdAt
- updatedAt
```

说明：

- `kind` 用于默认交互和系统约束，不限制成员只能有哪一种来源。
- personal 通常允许 mixed；strategy 通常由一个主 Strategy 同步；portfolio 由账户持仓同步。
- 用户可以创建多个 Watchlist，例如“长期价值”“短线观察”“候选股票”。
- 系统提供“全部观察”聚合视图，但它可以是读模型，不必成为可写 Watchlist。

### 4.2 WatchlistMember

```text
WatchlistMember
- id
- watchlistId
- stockId
- priority: normal | important | urgent
- firstAddedAt
- lastActivityAt
```

同一 `(watchlistId, stockId)` 只有一条当前成员关系。

成员记录只表示当前有效关系；删除成员关系不影响 `holding`、来源结束记录或同步快照。
`holding` 是独立事实，股票可以同时在 Portfolio Watchlist 中持有。

### 4.3 WatchlistMemberSource

```text
WatchlistMemberSource
- id
- memberId
- kind: manual | strategy | ai | portfolio | import
- sourceId?
- sourceVersionId?
- reason
- score?
- rank?
- validFrom
- validUntil?
- status: active | stale | ended
- evidence[]
```

来源规则：

- manual：用户明确添加，只有用户移除才结束。
- strategy：指向 Strategy 和 StrategyVersion，可由 StrategyRun 刷新。
- ai：指向 Agent run 或研究产物，必须经用户确认后成为 active。
- portfolio：指向 Account/Holding，由持仓同步维护。
- import：保留导入批次和来源。

成员存在条件：至少一个 active/stale source。

所有来源结束且无其它来源时删除成员关系，但不物理删除来源结束记录和同步历史。

### 4.4 MembershipSnapshot

每次 Strategy、AI 或 Portfolio 同步形成快照：

```text
MembershipSnapshot
- id
- watchlistId
- sourceKind
- sourceId
- runId
- dataAsOf
- status: complete | partial | failed
- entered[]
- exited[]
- unchanged[]
- missingDimensions[]
- createdAt
```

失败或空结果必须与真实的零候选区分。失败不结束旧来源；旧来源标记 stale。

## 5. 一个股票、多个来源

示例：

```text
Watchlist: 重点研究
Stock: 600519.SH 贵州茅台

Member priority: important
Sources:
  - manual：用户 2026-07-01 加入，原因“白酒龙头”
  - strategy：价值成长 V3，score=92，rank=3
  - ai：行业研究 run_123，原因“现金流韧性”
  - portfolio：账户 account_main 当前持仓
```

如果价值成长 V3 下一次不再选中：

- 只结束对应 strategy source；
- manual、ai、portfolio 来源仍 active；
- WatchlistMember 继续存在；
- 时间线记录策略退出及原因；
- 不把“策略退出”自动解释为卖出建议。

## 6. Strategy 与 Watchlist

### 6.1 Strategy 输出

StrategyRun 输出结构化 StrategyResult：

- selected；
- score / rank；
- factorResults；
- matchedRules / rejectedRules；
- evidence；
- dataAsOf。

Watchlist 同步器根据结果更新 strategy source，不让 Strategy 直接改写成员的 priority 或笔记。

### 6.2 同步策略

用户配置：

```text
Strategy: 价值成长
Target Watchlist: 价值成长候选
Enter: selected=true 且 rank<=30
Exit: 连续 2 次 complete run 未入选
```

退出可配置确认窗口，避免一次数据抖动造成频繁进出。

### 6.3 多策略汇总

一个 Watchlist 可接收多个 Strategy 来源。页面可展示：

- 命中策略数；
- 共识方向；
- 每个策略版本、评分和证据；
- 新进、退出和排名变化。

共识是多个独立结果的聚合，不替代 Advice。

## 7. AI 与 Watchlist

Agent 可以：

- 根据用户意图创建 Watchlist 草案；
- 基于已注册 Strategy 或受控研究结果生成成员草案；
- 解释成员来源和变化；
- 帮用户解释成员来源并决定是否删除成员关系；
- 创建 ResearchNote 或 Advice 草案。

AI 来源的硬约束：

- 候选股票必须来自明确的 StockUniverse 或搜索结果。
- reason 和 evidence 必填。
- AI 只能生成草案，用户确认后才能 active。
- 模型失败或输出为空不结束旧成员。
- AI 不能跳过用户确认直接改变成员关系或 priority。

## 8. Portfolio 与 Watchlist

Portfolio Watchlist 是统一 Watchlist 的一种系统配置：

- source 指向 Account/Holding；
- 新开持仓增加 portfolio source；
- 平仓结束 portfolio source；
- 用户手工或策略来源仍在时成员继续存在；
- 平仓后可以提示用户是否删除成员关系或进入复盘阶段。

Portfolio 事实展示：

- 数量、成本、仓位、PnL；
- 关联 StrategyVersion、Advice、thesis；
- 集中风险和事件。

这些字段从 Holding/Trade/Advice 聚合，不复制到 WatchlistMember。

## 9. AlertPlan

统一 Watchlist 解决“看哪些机会”，AlertPlan 解决“发生什么时提醒”：

```text
Watchlist ──► AlertPlan ──► AlertRule ──► Watch Runner ──► WatchTrigger
```

AlertPlan 由当前 `StockPool / WatchPlan` 迁移而来：

```text
AlertPlan
- id
- watchlistId
- name
- logic: ANY | ALL
- rules[]
- triggerMode
- cooldown
- priority
- deliveryPreference
- enabled
```

Strategy signals 可作为 AlertRule 输入之一，但提醒状态机、冷却和通知仍由 AlertPlan 管理，不写入
Strategy DSL。

## 10. 页面设计

### 10.1 Watchlist 总览

展示：

- Watchlist 卡片和成员数；
- 今日 entered/exited；
- urgent/important 触发；
- stale/failed 来源；
- Watch Runner 健康状态。

支持视图：

- 按 Watchlist；
- 全部股票去重；
- 今日变化；
- 当前持仓。

### 10.2 Watchlist 详情

顶部：

- 名称、说明、kind、同步策略和状态；
- 来源健康度与最近 dataAsOf；
- 关联 Strategy 和 AlertPlan。

成员表：

- 股票和行情时间；
- priority 与删除操作；
- 来源徽标；
- 策略评分/排名变化；
- active thesis；
- 持仓摘要；
- 最近触发和事件。

### 10.3 成员详情

成员详情聚合：

- 当前和历史来源；
- entered/exited 原因；
- ResearchNote；
- StrategyResult / StrategySignal；
- WatchTrigger / StockEvent；
- Holding / Trade；
- Advice / Outcome。

### 10.4 成员生命周期

```text
Strategy/AI source active
  → 创建或更新 WatchlistMember
  → 成员关系保留 priority
```

成员删除操作或所有来源结束且无其它来源时删除当前成员关系；旧来源和同步历史仍保留。
后续再次出现 active source 时创建新的当前成员关系。研究内容独立写入 ResearchNote。

### 10.5 来源生命周期

```text
active → active    刷新分数、排名和证据
active → stale     同步失败，保留旧结果
stale  → active    后续成功恢复
active → ended     完整运行明确不再命中
ended  → active    后续再次进入
```

## 12. 数据一致性

- `Stock` 是股票身份唯一事实源。
- `WatchlistMember` 唯一键为 `(watchlistId, stockId)`。
- source 使用独立行，不把多个来源压成不可查询 JSON。
- 自动同步按 run 原子提交；部分失败不能制造错误退出。
- priority 与 source 解耦，策略同步不能覆盖人工优先级。
- 历史快照和来源结束记录不物理删除；成员关系删除后不展示归档状态。
- 删除被 AlertPlan 引用的 Watchlist 必须拒绝或先显式迁移引用。
- 停用 Watchlist 后不参与扫描，但历史仍可查看。

## 13. 当前实现迁移

### 13.1 名称映射

| 当前对象 | 目标对象 | 处理 |
|---|---|---|
| `StockGroup` | `Watchlist` | 字段迁移，保留兼容读写期 |
| `GroupMemberSnapshot` | `MembershipSnapshot` + `WatchlistMemberSource` | 拆分当前关系与历史批次 |
| manual resolver | manual source | 直接迁移 |
| holdings resolver | portfolio source | 关联账户 |
| formula resolver | strategy source | 引用迁移后的 Strategy |
| llm resolver | ai source | 增加确认状态与 agent run |
| `StockPool / WatchPlan` | `AlertPlan` | 改为 watchlistId 引用 |
| `WatchTrigger` | `WatchTrigger` | 保留，更新命名引用 |

### 13.2 兼容原则

- 先新增目标 schema 和 repository，再做双读/一次性迁移，不直接重命名 SQLite 表。
- 旧 tools 可在一个版本周期内映射到新 tools，并返回弃用信息。
- Web 先切换产品语言；CLI/MCP 通过 discovery 获取新名称。
- 迁移必须幂等，任何失败保留旧数据。
- 不同时维护两个可独立修改的成员事实源。

### 13.3 建议新 tools

```text
list_watchlists
get_watchlist
create_watchlist
update_watchlist
archive_watchlist（删除 Watchlist）
add_watchlist_member
update_watchlist_member
archive_watchlist_member（删除成员关系）
sync_watchlist_source
list_alert_plans
create_alert_plan
update_alert_plan
```

实际清单以 registry 和具体 DDD 为准。

## 14. 分期

### Phase 0：领域与迁移设计

- 确认 Watchlist/Member/Source/Snapshot schema。
- 确认 Strategy source 与 AI source 的确认语义。
- 设计 StockGroup 和 StockPool 的幂等迁移。
- 产品界面停止新增“分组/股票池/盯盘方案”混合称呼。

### Phase 1：统一 Watchlist

- Watchlist CRUD；
- manual 和 portfolio source；
- 当前 StockGroup 数据迁移；
- 全部观察去重视图；
- priority 和删除；
- AlertPlan 引用迁移。

### Phase 2：Strategy 同步

- StrategyRun 原子更新 strategy source；
- entered/exited/score/rank 变化；
- stale/partial/failed 状态；
- 多策略来源与共识展示。

### Phase 3：AI 与研究工作台

- AI 成员草案和确认；
- 成员关系与来源确认；
- ResearchNote、StockEvent、Advice 和 Portfolio 聚合；
- Agent 创建 Watchlist/AlertPlan 草案。

### Phase 4：复盘与降噪

- 成员来源留存与后续表现；
- AlertPlan 有用率和噪声统计；
- 平仓后的继续观察/删除流程；
- 基于真实样本提出调整草案。

## 15. 验收标准

- 产品只有一套 Watchlist 领域语言，不再新增平行股票池。
- 同一 Watchlist 中同一股票只有一个当前 Member，允许多个独立 Source。
- Strategy、AI、Portfolio 任一来源退出不会误删其它来源。
- 策略同步失败不会制造全量退出，旧来源明确标记 stale。
- 删除成员关系不覆盖 Holding 事实，也不自动等同于 Advice。
- 每次自动成员变化可追溯 run、版本、数据时间、reason 和 evidence。
- AlertPlan 与 Watchlist 成员解耦，提醒不会自动交易。
- 旧 StockGroup/StockPool 数据能够幂等迁移且不丢历史。
