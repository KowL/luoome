# ruo 能力迁移产品设计文档

> 状态：产品方案已确认；Phase 1 已实现（2026-07-25）
> 日期：2026-07-24
> 参考：旧项目 `ruo` 源码审计、[统一 Watchlist](./watchlist.md)、[ARCHITECTURE.md](../ARCHITECTURE.md)
> 产品边界：本地单用户、Web 为主入口、CLI/MCP 为高级入口；只提供研究、提醒、建议和复盘，不自动下单
> 研究模型更新：本文以 Stock/ResearchNote 为主体的研究档案部分已由[研究主题与 Obsidian Vault 详细设计](../ddd/research-vault-detailed-design.md)替代；公司事件、来源可信度、报告与复盘需求继续有效。文中 StockGroup/StockPool 等旧名称仅用于迁移追溯，当前代码以 Watchlist/AlertPlan 为准

## 1. 文档结论

ruo 中值得迁移的不是 Python、Celery、Redis 或大型页面，而是几条已经被验证有价值的产品闭环：

```text
建立研究上下文        持续罗取事实          主动提醒          人工决策          事后验证
研究档案         →    行情/事件/证据    →   预警与简报   →   按需 Advice   →   信号与账户复盘
```

迁移采用“吸收产品能力、复用 luoome 领域模型、重新实现”的方式；下文早期 StockGroup/StockPool
描述属于迁移快照，当前实现以 Strategy/Watchlist/AlertPlan 为准：

- 以现有 `Stock` 为研究主体，不迁移 ruo 的 `TrackingCard`。
- 以现有 `Watchlist`、`AlertPlan`、`WatchTrigger` 承接监控，不复制预警系统。
- 以现有 `Advice` 承接 AI 分析，不自动批量生成高频建议。
- 新增的公司事件、研究笔记和数据来源信息必须可追溯。
- 战法和预警效果使用真实行情观察，不迁移 ruo 的随机模拟胜率。
- 组合收益必须基于真实交易与现金流重算，不迁移 ruo 的简化收益曲线。

建议按三阶段实施：

| 阶段 | 产品主题 | 范围 |
|---|---|---|
| Phase 1 | 可信研究闭环 | 股票研究档案、公司事件日历、数据来源与新鲜度 |
| Phase 2 | 证据主动送达 | 来源型研究笔记、个性化简报、多维 Evidence Adapter |
| Phase 3 | 真实复盘与短线扩展 | 信号后续表现、账户净值归因、连板事件雷达 |

首个开发主题建议为：

> **股票研究档案 + 公司事件日历 + 数据来源新鲜度**

它们能以最少的新概念，把已有分组、预警、建议、持仓和报告织成一条可追溯链路。

## 2. 背景与源码审计

### 2.1 ruo 能力成熟度

| ruo 能力 | 实现成熟度 | 迁移判断 |
|---|---|---|
| 追踪卡片、事件、笔记、摘要 CRUD | UI、API、服务和测试闭环较完整 | 迁移产品语义，不迁 TrackingCard |
| 公司事件同步与提前提醒 | 已接调度和外部数据源，测试较弱 | 值得迁移，重新实现 provider 和幂等同步 |
| 个性化开盘、收盘、周度报告 | 已有生成、归档和调度 | 迁移调度、模板、历史入口 |
| 数据源状态与复盘页 | 已有可见性设计 | 提升为 luoome 通用数据来源语义 |
| 连板天梯与昨日梯队表现 | 页面和接口较完整，外部依赖重 | A 股短线方向明确时再做 |
| 收益曲线 | 有 API 和服务，UI 未形成闭环 | 只保留需求，基于现金流重写 |
| 新闻与多维数据采集 | 局部接通、字段脆弱、任务存在下线 | 迁移 Evidence Adapter 思路，不搬采集代码 |
| 战法胜率 | 使用随机数模拟次日收益 | 禁止迁移 |
| 概念库 | 运行时路由禁用，服务为占位 | 不作为已完成功能迁移 |
| 多 Agent 作战室 | 共识主要为关键词计数 | 不迁移 |

### 2.2 luoome 已有基础

当前系统已经具备：

- `Stock`、`Holding`、`Trade`、`Account` 等本地投资实体；
- `StockGroup` 动态分组和成员快照；
- `StockPool` 盯盘方案、`WatchTrigger` 触发事实和 `WatchRun` 心跳；
- `Advice`、`AdviceOutcome`、建议历史和统计；
- 行情 Eastmoney 主源、Tencent 备源的降级链；
- `daily-advice`、`daily-review`、`risk-report` 等 workflow；
- Web、CLI、MCP 多入口及副作用分级；
- advice 与 trade 的强制隔离。

当前缺口不是“再做一个信息中心”，而是：

1. 单只股票缺少统一、连续的研究上下文。
2. 财报、解禁、分红等低频事实没有标准化模型。
3. 数据来自哪里、截止何时、是否降级没有统一表达。
4. 已有报告缺少自动调度、持久化历史和消息入口。
5. 预警和信号发生后，缺少真实后续表现。
6. 组合收益缺少现金流、分红、费用和时间加权语义。

## 3. 产品目标

### 3.1 一句话定位

> 让每只关注股票都有一份可追溯的研究档案，让重要事实按时到达，让每个信号和决策最终都能被真实数据验证。

### 3.2 目标用户

- 同时跟踪持仓与候选股，需要集中管理判断依据的个人投资者。
- 没有时间持续刷新行情和公告，希望在关键事件前被提醒的用户。
- 希望复盘“当时为什么关注、后来发生了什么”的主动投资者。

### 3.3 用户价值

| 用户问题 | 产品回答 |
|---|---|
| 我为什么关注这只股票？ | 研究假设、笔记、来源和历史建议集中展示 |
| 近期有什么关键时间点？ | 财报、解禁、分红等公司事件日历 |
| 这条数据可靠吗？ | 展示 provider、数据时间、新鲜度和降级状态 |
| 今天哪些事值得看？ | 个性化开盘、收盘和周度简报 |
| 这个信号后来怎么样？ | 展示 T+1/T+5 等真实后续表现和样本数 |
| 我的账户长期表现如何？ | 正确处理现金流后的净值、回撤和归因 |

### 3.4 成功标准

- 用户能在一个页面理解某只股票的关注理由、近期事件、预警和建议。
- 关键公司事件能提前到达，不依赖用户手工重复查询。
- 任何重要行情、建议和报告都能说明数据截止时间及来源状态。
- 报告和信号复盘基于已有数据自动生成，但 AI 建议仍由用户按需触发。
- 系统不把模拟概率、缺失数据或降级数据包装成确定性结论。

## 4. 产品原则

### 4.1 研究档案是读模型，不是第二个股票实体

面向用户的“股票研究档案”由以下数据聚合形成：

- `Stock` 基础信息；
- 当前或历史 `Holding`；
- `StockGroup` 归属；
- `ResearchNote`；
- `StockEvent`；
- `WatchTrigger`；
- `Advice`；
- 后续的 `SignalObservation`。

不新增一个复制名称、代码、分组和持仓状态的 `TrackingCard`。

### 4.2 事实、观点、建议分层

- 事实：行情、财报日期、解禁、分红、触发记录。
- 观点：用户研究假设、手工笔记、来源摘要。
- 建议：结构化 `Advice`，带反证、风险、免责声明和有效期。

三者必须在界面和数据模型中区分，不能把资讯摘要直接显示为买卖建议。

### 4.3 数据来源是业务语义

数据来源不只记录在日志中。影响提醒或建议的数据应能回答：

- 来自哪个 provider；
- 数据实际对应什么时间；
- 何时抓取；
- 是否使用了 fallback；
- 当前是 fresh、stale、unknown 还是 unavailable；
- 失败是否导致功能降级。

### 4.4 自动化负责送达，不替用户决策

- 系统可以自动同步事件、生成不含买卖结论的简报、计算信号后续表现。
- 系统不因预警或事件自动生成 Advice。
- 用户在研究档案、预警或报告中点击“生成 AI 建议”后才调用 advice tool。
- Advice 永远不能触发交易。

### 4.5 真实观察优先于概率包装

- 信号表现展示未来固定窗口的真实涨跌、最大有利/不利波动和样本量。
- 不使用随机模拟数据。
- 不把观察性统计称为因果胜率。
- 样本不足时只展示明细，不输出稳定性结论。

### 4.6 先做本地单用户闭环

不为迁移功能引入多用户订阅、Redis Streams、Celery 集群或消息扇出表。定时任务复用 luoome CLI/workflow 运行方式和本地 SQLite。

## 5. 整体信息架构

### 5.1 Web 导航

保持当前导航结构，不新增多个信息孤岛：

- 仪表盘
  - 今日关键事件；
  - 最近重要预警；
  - 最新简报；
  - 数据健康状态。
- 股票/持仓详情
  - 新增“研究”页签，作为研究档案主入口。
- 分组详情
  - 保留成员和盯盘方案；
  - 展示该组近期事件与研究动态。
- 报告
  - 开盘简报、收盘复盘、周报历史。
- 设置/系统状态
  - 数据来源、workflow 运行记录和降级状态。

策略预警文档约定“不新增一级导航”，“报告”是例外：它是跨股票、跨功能的时间型产物，不属于任何单只股票或分组，挂到现有入口下只会造成更深的层级。

信号数据量形成规模后，再评估独立的“复盘”二级页面。

### 5.2 核心链路

```text
外部事件 Adapter ──┐
行情 Adapter ──────┼──► DataProvenance ──► StockEvent / WatchTrigger / Advice
用户笔记 ──────────┘               │
                                    ▼
Stock ──► 股票研究档案 ──► 按需 Advice ──► AdviceOutcome
  │             │
  │             ├──► 个性化简报
  │             └──► 事件提醒 / event-date 规则
  ▼
WatchTrigger ──► SignalObservation ──► 真实信号复盘
```

## 6. Phase 1：可信研究闭环

### 6.1 股票研究档案

#### 页面目标

用户打开任意持仓或股票时，不需要在分组、预警、建议和笔记之间来回寻找，即可回答：

1. 我当前对它的核心判断是什么？
2. 哪些事实支持或反对这个判断？
3. 近期有什么必须关注的日期？
4. 最近触发过什么信号？
5. 当时系统给过什么建议，是否仍有效？

#### 页面结构

顶部摘要：

- 股票代码、名称、市场；
- 当前价、行情时间及新鲜度；
- 持仓数量、成本、PnL（存在持仓时）；
- 所属分组；
- 当前有效的研究假设；
- “生成 AI 建议”按钮。

主体时间线：

- 手工笔记；
- 来源型笔记；
- 公司事件；
- WatchTrigger；
- Advice 创建、过期及 outcome；
- 交易记录。

侧栏：

- 未来 30/90 天事件；
- 当前盯盘方案；
- 研究标签；
- 数据来源状态。

#### 核心操作

- 新建、编辑、删除手工笔记；
- 设置一条当前研究假设；
- 添加手工事件；
- 查看自动同步事件及来源；
- 将预警、建议或交易关联到笔记；
- 主动生成一次 Advice；
- 按类型筛选时间线。

#### ResearchNote 建议模型

```text
ResearchNote
- id
- stockId
- kind: thesis | note | source-summary
- title?
- content
- stance?: bullish | bearish | neutral
- active: boolean            # thesis 专用：是否为当前生效假设；非 thesis 恒为 false
- supersedesId?              # thesis 专用：本版本取代的上一条笔记 id
- sourceUrl?
- sourceTitle?
- fetchedAt?
- citations?: Citation[]
- relatedHoldingId?
- relatedAdviceId?
- relatedWatchTriggerId?
- tags[]
- createdAt
- updatedAt
```

约束：

- `stockId` 必填，研究上下文不脱离股票存在。
- `thesis` 版本语义：编辑研究假设不是原地改，而是插入一条新 `thesis` 行——新行 `active = true`、`supersedesId` 指向旧行，旧行 `active` 置 `false`；同一股票任意时刻最多一条 active thesis，历史版本全部保留并进入时间线。非 thesis 笔记原地编辑，不做版本。
- `source-summary` 必须保留 URL、抓取时间和引用；无法验证来源时标记为 unverified。
- 删除笔记不删除关联的 Advice、WatchTrigger 或交易事实。
- `ResearchNote` 是早期 `list_notes` / `add_note` 需求的正式落地形态（`kind = note` 对应普通笔记），不再新增平行的 Note 实体；外部 Agent 通过 MCP discovery 获取当前 `list_research_notes` / `add_research_note` 等实际工具。

### 6.2 公司事件日历

#### 首期事件范围

| 事件类型 | 示例 | 默认重要性 |
|---|---|---|
| earnings | 年报、季报、业绩预告披露日 | 重要 |
| unlock | 限售股解禁 | 重要 |
| dividend | 股权登记、除权除息、派息 | 普通/重要 |
| shareholder-meeting | 股东大会 | 普通 |
| announcement | 用户标记的重要公告日期 | 重要 |
| manual | 用户自定义观察日 | 用户选择 |

并购、监管处罚、停复牌等实时事件在获得可靠 provider 后扩展，不在首期假装完整覆盖。

#### StockEvent 建议模型

```text
StockEvent
- id
- stockId
- kind
- title
- description?
- occursAt
- allDay
- importance: urgent | important | normal
- status: scheduled | occurred | cancelled
- source: manual | external
- provider?
- externalId?
- sourceUrl?
- observedAt?
- fetchedAt?
- remindBeforeDays[]
- createdAt
- updatedAt
```

关键约束：

- 外部事件以 `(provider, externalId)` 幂等更新。
- provider 返回空结果时不能批量删除旧事件；只有明确取消状态才变更为 cancelled。
- 同一股票允许多个相同日期、不同类型事件。
- 手工事件创建时按 `(stockId, kind, occursAt)` 检测疑似重复并提示用户确认，不强制拒绝。
- 时间未知但日期已知时使用 `allDay`，不伪造具体时刻。
- provider 失败时保留旧数据并标记 stale。

#### 事件提醒

事件进入两条产品链：

1. 简报：展示未来 7/30 天的重要事件。
2. 盯盘：新增低频 `event-date` 规则。

`event-date` 是 `WatchRule` 的一个新规则变体（`WatchRuleKind` 增加 `'event-date'`），与普通规则一样挂在 `StockPool.rules` 上、复用分组决定监控哪些股票；区别只在求值时机——它不进入 `intraday-watch` 每分钟行情热路径（watch 遇到该规则直接跳过），由每日事件 workflow 求值并产出 `WatchTrigger`（`poolId` 语义不变）。

提醒窗口语义：

- 规则级 `daysBefore` 是该方案的默认提醒窗口（如 `[7, 3, 1]`）；
- 事件级 `remindBeforeDays` 非空时覆盖规则默认值；
- 每个（事件, 提醒日）组合在同一方案下最多产生一条触发，去重携带事件身份（`WatchTrigger` 增加 `eventId`，cooldown/去重键对 event-date 扩展为 `(poolId, stockId, ruleId, eventId)`，避免同一股票的两个不同事件互相抑制）；
- 事件改期（`occursAt` 变更）视为新的事实：按新日期重新计算提醒窗口，已发提醒保留历史，不因改期撤回。

事件提醒遵循 AlertPlan 的优先级、送达状态和 handled/useful 反馈；`WatchTrigger` 的事件引用按统一迁移 runner 演进。

### 6.3 数据来源与新鲜度

#### DataProvenance 值对象

影响用户判断的数据对象应按需携带：

```text
DataProvenance
- provider
- observedAt
- fetchedAt
- freshness: fresh | stale | unknown | unavailable
- fallbackFrom?
- errorKind?
- errorMessage?
```

它是嵌入行情快照、事件、Advice evidence 和报告条目的值对象，不单独成为业务实体。

Phase 1 落地范围（避免存量实体大改拖期）：

- `DataProvenance` 公共 schema 在 Phase 1C 定义并冻结；
- `StockEvent` 新建即携带（provider / observedAt / fetchedAt / stale）；
- 行情新鲜度以**读模型**实现：由 `PriceSnapshot`、`WatchRun` 和 provider 降级记录现算 `get_market_data_status`，本期不改 `Quote` 实体、不做回填；
- Advice 的 `basedOn.dataAsOf` 沿用现有字段如实展示，evidence 级 provenance 与报告条目的 provenance 随 Phase 2B 的 `Report` 实体一并接入。

#### 新鲜度建议规则

不同数据类型使用不同阈值：

- 盘中实时行情：以 watch 扫描周期和交易状态判断；
- 日线：最近交易日数据可视为 fresh；
- 公司事件：以 provider 最近成功同步时间判断；
- 动态分组：沿用当前 daily refresh 和 stale 语义；
- 报告：显示报告使用的数据截止时间，不因生成时间较新就视为数据新。

具体阈值进入技术设计和配置，不硬编码在 Web。

#### 用户展示

- 正常：显示“数据截至 10:32，东方财富”。
- fallback：显示“已切换腾讯备用源”。
- stale：显示“数据可能过期，最后成功同步于……”。
- unavailable：禁止展示看似正常的零值；明确显示不可用。

Advice 使用降级或 stale 数据时：

- `basedOn.dataAsOf` 必须真实；
- evidence 中标记数据限制；
- 不能提高 confidence；
- 严重缺失时降级为纯数据输出或拒绝生成。

### 6.4 通用运行审计

保留 `WatchRun`，并为其他自动 workflow 引入一致的运行记录语义：

```text
WorkflowRun
- id
- workflowName
- mode: manual | scheduled | daemon
- status: running | succeeded | partial | failed
- startedAt
- finishedAt?
- inputSummary?
- outputSummary?
- providerStatuses[]
- error?
```

首期接入：

- 事件同步；
- `refresh-groups`；
- `sync-quotes`；
- 开盘、收盘和周度报告；
- 信号后续表现更新。

`WatchRun` 暂不强制迁表，可在统一状态页面适配为同一读模型，避免为架构整齐破坏稳定盯盘链。统一读模型的字段形状在 Phase 1C 随 `WorkflowRun` 一并冻结，避免两条记录路径各自演化。

### 6.5 Agent-first 工具面

Phase 1 建议新增或扩展：

| Tool | 副作用 | 用途 |
|---|---|---|
| `list_research_notes` | read | 按股票、类型、时间查询笔记 |
| `add_research_note` | write | 新增手工笔记或研究假设 |
| `update_research_note` | write | 更新内容、标签或 active 假设 |
| `delete_research_note` | write | 删除笔记 |
| `list_stock_events` | read | 查询未来或历史公司事件 |
| `add_stock_event` | write | 新增手工事件 |
| `update_stock_event` | write | 修改手工事件或提醒设置 |
| `delete_stock_event` | write | 删除手工事件 |
| `sync_stock_events` | external | 同步外部事件 |
| `get_market_data_status` | read | 查看数据源和新鲜度 |
| `list_workflow_runs` | read | 查看自动任务历史 |

事件同步 workflow 不通过 MCP 暴露；原子同步 tool 仍按 `external` 权限控制。

## 7. Phase 2：证据主动送达

### 7.1 来源型研究笔记

用户粘贴研报、公告或文章 URL 后：

1. 服务端校验 URL；
2. 抓取正文和页面元信息；
3. 保存原始来源信息；
4. 用户主动点击后调用 LLM 生成结构化摘要；
5. 用户确认后保存为 `source-summary`；
6. 摘要进入研究档案，但不自动变成 Advice。

摘要结构建议：

- 核心观点；
- 支持证据；
- 反方信息或缺失信息；
- 涉及的关键数字；
- 引用位置；
- 内容发布时间和抓取时间。

安全要求：

- 只允许 `http` / `https`；
- 阻止 localhost、私网、链路本地地址和 DNS rebinding；
- 每次重定向后重新校验目的地址；
- 限制响应体、超时、重定向次数和 MIME；
- 不执行页面脚本；
- 抓取失败不能伪造摘要；
- 页面内容视为不可信输入，防止提示注入进入 agent 指令层。

### 7.2 个性化简报

#### 开盘简报

- 今日及未来 7 天的重要公司事件；
- 持仓隔夜变化和数据异常；
- 启用中的重要盯盘方案；
- 动态分组 stale 或同步失败；
- 用户昨日标记待跟进的研究事项。

#### 收盘复盘

- 账户当日表现；
- 当日重要 WatchTrigger；
- 持仓与关注组的显著变化；
- 今日到期或失效的 Advice；
- 明日关键事件；
- 可选“对重要条目生成建议”，默认不自动调用。

#### 周报

- 账户周度表现和回撤；
- 预警处理率、有用率；
- 信号样本的真实后续表现；
- 新增研究笔记、研究假设变化；
- 下周公司事件。

#### 报告模型

```text
Report
- id
- kind: opening | closing | weekly
- periodStart
- periodEnd
- generatedAt
- dataAsOf
- status: complete | partial
- sections[]
- provenance[]
- deliveryStatus?
```

报告必须持久化，支持历史查看。生成失败或数据不全时保留 partial 状态和缺失原因。

### 7.3 Evidence Adapter

为 `analyze_stock` 和报告逐步增加多维证据，但每一维可以独立失败：

```text
EvidenceBundle
- technical
- fundamental
- capitalFlow
- companyEvents
- news
- provenance[]
- unavailableDimensions[]
```

建议接入顺序：

1. 公司事件；
2. 财务摘要；
3. 资金流；
4. 相关资讯。

不复制 ruo 中逐页面、逐接口的 Akshare 调用。Adapter 输出稳定 schema，原始字段变化被封装在适配层。

### 7.4 资讯产品边界

首期不建设独立新闻瀑布流。资讯只在以下位置按相关性出现：

- 股票研究档案；
- Advice 的 supporting/counter evidence；
- 开盘和收盘简报。

必须满足：

- 与股票的关联原因可解释；
- 标题、来源、发布时间、抓取时间齐全；
- 去重；
- 摘要与原文链接可追溯；
- 单个新闻源失败不影响其他证据维度。

## 8. Phase 3：真实复盘与短线扩展

### 8.1 信号后续表现

**归属约定**：`SignalObservation` 由本文档定义并拥有，是“信号/触发后续表现”的唯一实现。策略预警文档 Phase 2 的“触发后 1 日 / 5 日表现”不再单独建设，改为消费本节的观察结果（对应 `t1` / `t5` 窗口）。

对 `WatchTrigger` 和 `TacticSignal` 自动生成固定窗口的市场观察：

```text
SignalObservation
- id
- sourceKind: watch-trigger | tactic-signal
- sourceId
- stockId
- baselinePrice
- baselineAt
- horizon: t1 | t3 | t5（存量 t20 仅兼容读取）
- closePrice?
- returnPct?
- maxFavorableExcursionPct?
- maxAdverseExcursionPct?
- benchmarkReturnPct?
- status: pending | complete | unavailable
- provenance
- observedAt?
```

数据依赖（Phase 3A 立项前必须验证）：

- T+N 观察需要触发时点之后 N 个交易日的日线。当前 `dailyBar` 主要为持仓股昨收服务，任意候选股的历史覆盖与回填策略需要单独设计；
- `benchmarkReturnPct` 使用真实指数 qfq 日线数据集 `000300.SH:qfq:daily:v1`；生产日循环和补观察 workflow
  先显式同步该数据集，来源和失败原因进入审计。指数日线缺失时该字段标记 unavailable 而不是省略，周期保留
  partial，不使用替代报价或 0 值。

展示原则：

- 方向为 buy 时，收益为正不等于用户实际盈利。
- 方向为 sell 时应同时展示“卖出后股价变化”，避免统一套用买入收益。
- 展示样本数、时间范围和缺失率。
- 不把不同市场状态、不同持有周期的样本混成一个确定胜率。
- 用户 handled/useful 反馈与市场表现分别统计。

### 8.2 组合净值、回撤与归因

此功能产品价值高，但不能直接迁移 ruo 实现。技术设计前必须补齐：

- 入金、出金；
- 手续费、印花税等费用；
- 分红；
- 拆股、送转、复权语义；
- 每日现金与持仓估值；
- benchmark。

至少提供：

- 总资产与净值曲线；
- 日、周、月收益；
- 最大回撤；
- 持仓贡献；
- 已实现与未实现 PnL；
- 时间加权收益率 TWR；
- 数据缺口说明。

若现金流数据不完整，只展示“资产估值曲线”，不能标记为严格收益率。

### 8.3 A 股事件雷达

条件：产品明确服务 A 股短线用户，且获得稳定的涨停池、封板时间、封单额、开板等数据。

能力范围：

- 当日涨停梯队；
- 按连板数和题材分组；
- 昨日梯队今日表现；
- 历史日期切换；
- 将梯队结果作为动态 `StockGroup` resolver；
- 在研究档案和简报中提供只读 evidence。

它不单独发展为另一个股票收藏体系，也不直接产生买入建议。

## 9. 核心用户流程

### 9.1 建立研究假设

1. 用户从持仓或分组进入股票详情。
2. 打开“研究”页签。
3. 新建研究假设，填写观点、方向、证据和关注期限。
4. 系统展示相关持仓、有效 Advice、盯盘方案和未来事件。
5. 用户保存后，时间线记录版本。
6. 后续修改不会覆盖历史版本。

### 9.2 事件触发提醒

1. 每日事件同步 workflow 拉取关注股票相关事件。
2. 系统以 provider + externalId 幂等更新。
3. `event-date` 规则识别进入提醒窗口的事件。
4. 生成 `WatchTrigger`，普通事件仅记录，重要事件按策略推送。
5. 用户在预警卡片查看事件来源及研究档案。
6. 用户可标记已处理、有用/无用，或主动生成 Advice。

### 9.3 查看数据是否可信

1. 用户看到行情、事件、Advice 或报告。
2. 条目展示数据截止时间和来源状态。
3. 若使用 fallback，用户可展开查看切换原因。
4. 若数据 stale，操作按钮提示限制。
5. 若核心数据 unavailable，系统不生成误导性结论。

### 9.4 收盘复盘

1. 收盘后 workflow 汇总账户表现、重要预警、事件和数据状态。
2. 报告持久化为 complete 或 partial。
3. 系统按通知策略发送摘要。
4. 用户进入报告，对重要条目标记处理或跳转研究档案。
5. 需要判断时，用户主动生成 Advice。

## 10. 状态与异常语义

### 10.1 数据缺失不等于零

- 无行情不能显示价格 0。
- 无事件不能在 provider 失败时解释为“近期没有事件”。
- 无资金流不能解释为“资金流为中性”。
- 无信号观察不能进入胜率分母。

### 10.2 部分成功

外部数据和报告支持 `partial`：

- 已成功维度正常展示；
- 失败维度显示原因；
- provenance 保留每个维度状态；
- 重试只针对 recoverable 错误；
- 旧快照继续可用但标记 stale。

### 10.3 时间语义

- 市场和交易日判断统一使用 Asia/Shanghai。
- 数据存储使用可明确解析的时间戳。
- 全天事件显式保存 `allDay`，避免时区转换导致日期偏移。
- T+N 观察使用交易日，不使用自然日。

## 11. 非目标与明确不迁移

- 不迁移独立 `TrackingCard`、自选股、持仓或预警的重复模型。
- 不迁移随机模拟的战法胜率和概率推荐。
- 不迁移当前禁用的概念库和不完整新闻中心。
- 不迁移多 Agent 作战室、提示词广场或社区能力。
- 不迁移 WebSocket、Redis、Celery 多用户基础设施。
- 不在后台为全部股票自动生成 Advice。
- 不建设自动交易和跟单。
- 不在没有可靠数据源前承诺实时炸板、断板等能力。
- 不把来源摘要当成事实核验或投资建议。

## 12. 验收标准

### 12.1 Phase 1 功能

- 用户可从股票或持仓详情进入唯一的研究档案。
- 用户可新建、编辑、删除笔记，并维护一条当前研究假设。
- 研究时间线能聚合笔记、事件、WatchTrigger、Advice 和交易。
- 用户可手工创建公司事件并设置提前提醒。
- 外部事件支持幂等同步；失败时保留旧快照并显示 stale。
- 未来事件可进入简报和 `event-date` 预警。
- 事件和行情状态能显示数据截止时间与来源；Advice 的 `basedOn.dataAsOf` 如实展示。
- fallback、stale、unavailable 在 Web 上有不同状态。
- 用户可从研究档案或事件预警主动生成 Advice；后台不会自动生成。
- 自动事件同步和报告运行记录可查询。

### 12.2 Phase 1 可靠性

- 同一 provider 事件重复同步不会产生重复记录。
- provider 返回空列表不会误删已有事件。
- 事件取消、改期能保留变更历史或更新时间。
- 交易日和全天事件不因时区转换偏移。
- 数据源全失败时明确显示错误，不能生成正常零值。
- workflow 重启后能够判断上一轮是否完成。
- Repository 同时具备 Drizzle 和 in-memory 实现。
- 核心实体、不变量、tool、workflow 具备自动化测试。

### 12.3 安全

- 研究、事件、报告或预警不能调用 trade tool。
- 外部同步和来源抓取按 `external` 副作用控制。
- 来源抓取具备 SSRF、超时、体积和 MIME 防护。
- 外部内容不会进入系统提示词或改变 agent 权限。
- Advice 保留反证、风险、免责声明和有效期。

### 12.4 Phase 2/3 验收重点

- 开盘、收盘、周报可定时生成、持久化和回看。
- 报告部分失败时显示缺失维度。
- 来源摘要包含可点击原文和引用。
- 信号观察使用真实交易日行情，不使用模拟值。
- 样本不足时不输出稳定胜率结论。
- 组合净值正确处理入出金、费用和分红；数据不完整时明确降级。

## 13. 产品指标

### 13.1 可信度指标

| 指标 | 定义 | 目标 |
|---|---|---|
| 来源可解释率 | 重要行情、事件、Advice、报告具备 provenance | 100% |
| 新鲜度可判断率 | 用户可判断 fresh/stale/unavailable 的条目占比 | 100% |
| 事件重复率 | 同一外部事件产生重复记录的比例 | < 1% |
| 自动任务可审计率 | 计划内 workflow 有运行记录的比例 | 100% |

### 13.2 使用指标

| 指标 | 定义 | 说明 |
|---|---|---|
| 研究档案覆盖率 | 有笔记或假设的活跃持仓占比 | 观察指标 |
| 事件处理率 | 已处理的重要事件提醒 / 已送达提醒 | 观察指标 |
| 简报打开率 | 被打开的报告 / 已生成报告 | 观察指标 |
| Advice 主动生成率 | 用户从研究、预警、报告主动生成 Advice 的比例 | 不追求越高越好 |

### 13.3 复盘指标

- 信号观察完成率；
- 各窗口样本量和缺失率；
- 预警 useful 反馈率；
- Advice outcome 回填率；
- 账户收益数据完整率。

不以“AI 胜率”作为北极星指标。

## 14. 分期与开发顺序

### Phase 1A：研究档案基础

- `ResearchNote` entity、repository、schema 和 migration；
- CRUD tools/API；
- 股票/持仓详情“研究”页签；
- 聚合时间线读模型；
- 与 Advice、WatchTrigger、Trade 的跳转关联。

### Phase 1B：公司事件

- `StockEvent` entity、repository、schema 和 migration；
- 手工事件 CRUD；
- event provider Interface 和首个 Implementation；
- 同步 workflow、幂等与 stale；
- 未来事件组件；
- `event-date` 规则及通知。

### Phase 1C：可信度与运行状态

- `DataProvenance` 公共 schema；
- `StockEvent` 接入 provenance；行情状态走读模型（不改 `Quote`、不回填）；
- `WorkflowRun` 及与 `WatchRun` 的统一读模型；
- `get_market_data_status`、`list_workflow_runs`；
- 仪表盘和设置页状态组件。

### Phase 2A：来源笔记

- 安全抓取 Adapter；
- 正文抽取和引用模型；
- 按需摘要；
- 用户确认保存。

### Phase 2B：简报与证据

- `Report` 实体和历史；
- 开盘、收盘、周度 workflow；
- 调度和通知；
- fundamental、capital-flow Evidence Adapter。

### Phase 3A：信号复盘

- `SignalObservation`；
- T+N 交易日调度；
- 方案和战法统计；
- 样本量、缺失率及市场状态分组。

### Phase 3B：账户绩效

- 现金流和公司行动模型；
- 每日估值；
- TWR、回撤和贡献归因；
- 账户绩效页面。

### Phase 3C：A 股短线雷达

- 可靠涨停事件 Adapter；
- 日快照；
- 梯队和昨日样本表现；
- 动态分组 resolver 和简报 evidence。

## 15. 技术设计前必须冻结的决策

以下内容作为后续开发默认约束：

1. **研究档案是聚合读模型，不新增 TrackingCard。**
2. **ResearchNote 和 StockEvent 直接引用 Stock。**
3. **公司事件先覆盖财报、解禁、分红和手工事件。**
4. **event-date 是低频 workflow 规则，不进入每分钟行情扫描。**
5. **DataProvenance 是可复用值对象，不单独成为业务实体。**
6. **WatchRun 先保留，统一状态页通过读模型兼容 WorkflowRun。**
7. **AI 摘要和 Advice 都由用户主动触发。**
8. **报告可以自动生成，但必须区分事实摘要与投资建议。**
9. **信号效果只使用真实行情观察，并展示样本和缺失。**
10. **组合收益在现金流语义补齐前不宣称严格收益率。**
11. **报告与事件同步的调度走外部 cron + `luoome workflow run`，不引入内置调度器。** 开盘、收盘、周报和每日事件同步各对应一个 workflow，文档给出推荐 crontab；workflow 自身幂等，重复执行不产生重复产物。
12. **`SignalObservation` 是信号后续表现的唯一实现，归本文档拥有；** 策略预警 Phase 2 的触发后表现消费它，不另建。
13. **Phase 1 的 provenance 只覆盖 `StockEvent` 和行情状态读模型；** 不改 `Quote` 实体、不做存量回填，Advice evidence 与报告条目级 provenance 随 Phase 2B 接入。

## 16. 风险与应对

| 风险 | 应对 |
|---|---|
| 研究档案变成信息堆积页 | 默认按重要性和时间折叠，提供类型筛选，只突出当前假设和未来事件 |
| 公司事件 provider 不稳定 | Interface 隔离、幂等同步、保留旧快照、显式 stale |
| provenance 字段扩散 | 定义公共 schema，只在影响判断的数据边界嵌入 |
| 自动简报制造噪声 | 只突出变化和异常；普通条目聚合；允许关闭某类 section |
| 来源摘要受到提示注入 | 外部内容按不可信数据处理，不进入系统指令层 |
| 事件提醒与现有 watch 重复 | 复用 WatchTrigger、送达状态和反馈，不新建提醒表 |
| 信号观察被误认为投资胜率 | 展示方向、窗口、样本量、benchmark 和免责声明 |
| 绩效计算因现金流不全失真 | 完整度检查，降级为估值曲线并明确标记 |
| 信号观察的日线 / 指数数据覆盖不足 | Phase 3A 立项前验证 dailyBar 回填策略与指数 adapter；未覆盖时字段标 unavailable，不省略不伪造 |
| A 股短线数据成本过高 | 作为 Phase 3 条件功能，先验证用户方向和数据源 |

## 17. 后续开发产物

产品文档确认后，按 Phase 1A → 1B → 1C 依次产出：

1. 领域模型与数据库迁移技术设计；
2. Tool/API schema 清单；
3. Web 研究档案低保真交互；
4. event provider 选型与数据契约；
5. workflow 调度与失败恢复设计；
6. 测试矩阵和端到端黄金场景；
7. 可独立实施的开发任务清单。

建议使用三个黄金场景验收整个首期：

- 用户为持仓写下“财报前不加仓”的研究假设，事件提醒到达后能看到原始来源和当前持仓。
- 东方财富行情失败并切换腾讯时，预警和 Advice 明确显示 fallback，而不是看起来一切正常。
- 公司财报日期变更后，系统幂等更新事件、重新计算提醒窗口，不产生重复提醒。
