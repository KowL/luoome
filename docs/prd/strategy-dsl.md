# Strategy DSL（策略标准化语言）PRD

> 状态：目标模型草案；需要从现有 Tactic 渐进迁移
> 日期：2026-07-29
> 上位文档：[AI 投资决策闭环产品总纲](./ai-investment-decision-loop.md)
> 当前实现：`packages/core/src/entity/tactic.ts`、`packages/core/src/tactic/dsl.ts`

## 1. 文档结论

`Tactic` 应重构为正式的 `Strategy`，而不是长期作为一套并行的“战法”概念存在。

原因：

- 用户真正想沉淀的是完整投资方法，不只是一个触发表达式。
- 选股、评分、信号、观察和复盘需要共享同一策略身份与版本。
- Strategy 是 Agent、Watchlist、Portfolio 和复盘之间更稳定的领域语言。
- “战法”适合描述某条规则或模板，不适合作为顶层资产。

但这不是把类型名从 `Tactic` 机械替换为 `Strategy`。当前 Tactic 只有条件、分数、方向和证据；
Strategy 还需要 universe、数据依赖、筛选、评分、信号、风险、调度、版本和运行结果。

目标关系：

```text
Strategy
  ├── StrategyVersion        不可变定义版本
  ├── StrategyRule           当前 Tactic 表达式能力迁入这里
  ├── StrategyRun            一次确定性运行
  ├── StrategyResult         每只股票的入选、评分和解释
  └── StrategySignal         某时点产生的方向性信号

StrategyRun ──► WatchlistMemberSource(strategy)
StrategySignal ──► Alert / Advice evidence / SignalObservation
```

Strategy 的“执行”指运行研究规则和产生结果，永远不表示向券商下单。

## 2. 产品定位

### 2.1 一句话定位

> 用一份人、机器和 Agent 都能理解的版本化定义，描述策略在哪里选、依据什么判断、如何评分、何时产生信号以及如何验证。

### 2.2 目标用户

- 希望把个人投资方法标准化和持续复用的投资者。
- 希望用自然语言创建策略、再检查具体规则的普通用户。
- 需要确定性运行、版本对比和真实信号复盘的高级用户。
- 通过 MCP 或 Agent 调用 luoome 策略能力的外部客户端。

### 2.3 核心价值

- 一个策略身份贯穿定义、运行、Watchlist、Advice 和复盘。
- 策略结果可重放、可解释、可比较，不依赖模型临场发挥。
- Agent 负责创建和解释草案，确定性引擎负责实际运行。
- 策略变更形成新版本，历史信号不会失去上下文。

## 3. 领域模型

### 3.1 Strategy

保存稳定身份和生命周期：

```text
Strategy
- id
- name
- description
- owner: builtin | user
- status: draft | active | paused | archived
- currentVersionId
- createdAt
- updatedAt
```

Strategy 不直接保存可变 DSL 内容；运行始终绑定一个不可变 `StrategyVersion`。

### 3.2 StrategyVersion

```text
StrategyVersion
- id
- strategyId
- version
- definition
- definitionHash
- parentVersionId?
- changeSummary?
- validationStatus
- publishedAt?
- createdAt
```

约束：

- 已发布版本不可原地修改。
- 新版本必须重新校验数据依赖和表达式。
- 激活新版本不改变历史 StrategyRun 和 StrategySignal 的引用。
- 回滚是将旧定义复制成一个新版本，而不是改写历史。

### 3.3 StrategyRule

当前 `Tactic` 应迁移为 Strategy 内的规则组件：

```text
StrategyRule
- id
- name
- kind: filter | score | entry-signal | exit-signal | risk-signal
- when
- score?
- direction?
- evidence[]
```

“放量突破”“均线多头”“量价背离”等现有战法可成为：

- 内置 Strategy 模板；或
- 可被多个 StrategyVersion 引用的规则模板。

是否将规则模板独立持久化，应根据复用需求决定；产品层不再把 Tactic 作为顶层导航。

### 3.4 StrategyRun

记录一次实际运行：

```text
StrategyRun
- id
- strategyId
- strategyVersionId
- mode: scan | scheduled | replay | backtest
- coverage
- dataAsOf
- startedAt
- completedAt?
- status: running | complete | partial | failed
- dataStatus
- inputSnapshot
- summary
```

运行失败、部分数据不可用和零命中必须区分。

### 3.5 StrategyResult

每只候选股票的结构化结果：

```text
StrategyResult
- runId
- stockId
- selected
- score?
- rank?
- factorResults[]
- matchedRules[]
- rejectedRules[]
- evidence[]
- dataAsOf
```

StrategyResult 是 Watchlist 策略来源的事实依据，不直接等于 Advice。

### 3.6 StrategySignal

信号保留当前 `TacticSignal` 的方向、分数、证据和求值快照，并增加策略版本与规则身份：

```text
StrategySignal
- strategyId
- strategyVersionId
- ruleId
- stockId
- ts
- direction: bullish | bearish | neutral
- score: 0..100
- evidence[]
- evaluationSnapshot
```

`score` 是规则强度，不是收益概率，也不是 Advice confidence。

## 4. Strategy DSL 结构

目标结构：

```yaml
strategy:
  metadata: {}
  universe: {}
  data: {}
  factors: {}
  selection: {}
  scoring: {}
  signals: {}
  portfolio: {}
  risk: {}
  schedule: {}
  evaluation: {}
```

不是所有段落都必须在首期实现。DSL schema 使用显式版本号，未知字段默认拒绝，避免拼写错误被
静默忽略。

## 5. DSL 详细设计

### 5.1 Metadata

```yaml
metadata:
  id: value-growth-cn-a
  name: A 股价值成长
  version: 3
  style: value-growth
  horizon: medium
  description: 寻找盈利质量稳定、成长合理且估值不过度透支的公司
```

`version` 由系统发布流程管理，用户不能覆盖既有版本。

### 5.2 Universe

```yaml
universe:
  coverage: CN_A_SHARES_SH_SZ
  include:
    index: CSI300
  exclude:
    - suspended
    - delisting-risk
```

要求：

- coverage 必须是系统注册的明确覆盖范围。
- 运行记录保存当时的成分股快照。
- 不能用当前成分股回放历史日期。
- 首期不宣称支持尚无规范数据的市场。

### 5.3 Data requirements

```yaml
data:
  price:
    adjustment: qfq
    lookbackTradingDays: 120
  fundamentals:
    required:
      - roe
      - revenueGrowth
      - pe
```

每个字段必须来自注册的数据字典，包含类型、单位、频率、来源能力和历史可得时间。缺失数据策略
必须显式配置为 `exclude / unknown / fail-run`，不允许默认填零。

### 5.4 Factors

```yaml
factors:
  quality:
    expression: fundamentals.roe
    normalize: industry-percentile
  growth:
    expression: fundamentals.revenueGrowth
    normalize: market-percentile
  valuation:
    expression: fundamentals.pe
    normalize: inverse-industry-percentile
```

首期因子只能引用已注册字段和白名单函数。Agent 不得临时发明字段。

### 5.5 Selection

```yaml
selection:
  logic: all
  rules:
    - id: profitable
      when: fundamentals.roe > 15
      evidence: ROE=${fundamentals.roe}%
    - id: valuation-cap
      when: fundamentals.pe < 30
      evidence: PE=${fundamentals.pe}
```

选择规则回答“是否进入候选”。每条规则单独保存求值结果和证据。

### 5.6 Scoring

```yaml
scoring:
  method: weighted-sum
  components:
    - factor: quality
      weight: 0.4
    - factor: growth
      weight: 0.35
    - factor: valuation
      weight: 0.25
  rank:
    top: 30
```

要求：

- 权重和归一化口径显式。
- 保存原始值、归一化值和贡献分。
- 同分排序规则稳定。
- 缺失因子不能被悄悄重新分配权重。

### 5.7 Signals

当前 Tactic DSL 的主要能力迁入本段：

```yaml
signals:
  entry:
    - id: early-breakout
      when: >-
        indicators.close > indicators.ma20
        && indicators.volRatio5_20 >= 1.2
      score: >-
        Math.min(100, 50 + (indicators.volRatio5_20 - 1.2) * 20)
      direction: bullish
      evidence:
        - 收盘=${indicators.close}，MA20=${indicators.ma20}
        - 量比=${indicators.volRatio5_20}
  risk:
    - id: volume-price-divergence
      when: meta.priceUp && indicators.volRatio5_20 <= 0.7
      direction: bearish
      evidence:
        - 价格上涨但量比仅 ${indicators.volRatio5_20}
```

信号名称 `entry / exit / risk` 描述研究语义，不触发真实买卖。

### 5.8 Portfolio guidance

```yaml
portfolio:
  maxPositions: 10
  maxSingleWeight: 0.10
  maxIndustryWeight: 0.30
  cashReserve: 0.20
```

这些是生成 Portfolio Advice 时使用的约束，不是订单执行参数。首期可以只校验和展示，不自动
计算调仓。

### 5.9 Risk

```yaml
risk:
  reject:
    - when: market.delistingRisk == true
  warnings:
    - when: metrics.drawdown20d > 0.15
      level: important
      evidence:
        - 20 日回撤=${metrics.drawdown20d}
```

风险规则可以排除候选或产生信号，但不能在数据缺失时默认通过。

### 5.10 Schedule

```yaml
schedule:
  scan: after-market
  timezone: Asia/Shanghai
```

调度只触发 StrategyRun。盘中提醒仍由 AlertPlan 消费 StrategySignal 或对 Watchlist 成员求值，
避免 DSL 自己再造通知和冷却系统。

### 5.11 Evaluation

```yaml
evaluation:
  benchmark: CSI300
  observationWindows:
    - 1d
    - 5d
    - 20d
  backtest:
    rebalance: monthly
    feesBps: 10
```

首期只实现真实信号观察；完整回测必须满足第 9 节的前置条件。

## 6. 当前表达式引擎的继承

现有 mini-eval 支持数字、布尔、空值、算术、比较、逻辑、路径访问以及
`Math.min / Math.max / Math.abs`，且禁止动态代码和任意全局访问。这套安全边界继续保留。

重构时需要补齐：

- 从 `${path}` 模板和直接 `path` 语法中选择一种规范写法；
- 注册字段字典和静态路径校验；
- 字符串/枚举比较；
- 数组聚合与明确的时间窗口函数；
- 表达式 AST 或规范化表示，支持迁移和调试；
- 每条规则独立的 unknown/error 语义。

禁止为了扩展语法引入 `eval` 或 `new Function`。

## 7. 与统一 Watchlist 的关系

StrategyRun 更新 Watchlist 的策略来源：

```text
StrategyRun
  ├── selected=true  ──► 添加/刷新 WatchlistMemberSource(strategy)
  └── selected=false ──► 结束该策略来源的有效期
```

重要约束：

- 同一股票可被多个 Strategy 同时发现。
- 策略不再命中时，只结束对应 strategy source。
- 如果股票仍有手工、AI、持仓或其它策略来源，WatchlistMember 继续存在。
- 策略刷新失败不结束任何旧来源，旧结果标记 stale。
- 用户可把策略候选提升为重点研究，而不改变 StrategyResult。

## 8. 与 Advice、Portfolio 和 Agent 的关系

### Advice

StrategyResult 和 StrategySignal 是 Advice 的证据输入。Strategy 不直接产出最终买卖结论；
同一信号对不同持仓成本、风险偏好和周期可能产生不同 Advice。

### Portfolio

持仓可记录 `strategyId + strategyVersionId + adviceId + thesisId` 作为归因，但实际数量和成本仍以
Trade/Holding 为事实来源。

### Agent

Agent 可以：

- 从自然语言生成 StrategyVersion 草案；
- 解释字段、规则和数据依赖；
- 运行样本试算或历史回放；
- 比较版本差异；
- 基于真实复盘提出新版本草案。

Agent 不可以：

- 未经确认发布或激活版本；
- 使用未注册数据字段；
- 把回测结果包装成收益承诺；
- 让 StrategyRun 直接调用 trade。

## 9. 回测前置条件

正式宣称“可回测”前必须满足：

- 输入数据采用明确覆盖范围和统一 qfq 口径；
- 基本面和事件数据记录真实发布日期/可获得时间；
- universe 使用当时可见的股票和指数成分；
- 明确退市、停牌、涨跌停、费用和滑点；
- 运行引擎与线上 StrategyRun 共享规则语义；
- 防止幸存者偏差、未来函数和数据修订穿越；
- 结果绑定 StrategyVersion、数据版本、参数和代码版本；
- 输出基准、回撤、换手、样本量、缺失数据和适用边界。

在此之前，只提供 StrategyRun 历史回放和 SignalObservation，不展示虚假的年化收益。

## 10. 迁移路径

### Phase 0：领域定名

- 产品和新文档统一使用 Strategy。
- `Tactic` 标记为兼容实现名，不再新增顶层 Tactic 产品能力。
- 内置战法映射为内置 Strategy 或 StrategyRule 模板。
- `TacticSignal` 输出增加向 StrategySignal 的兼容映射。

### Phase 1：Strategy 核心

- 新增 Strategy、StrategyVersion、StrategyRun、StrategyResult、StrategySignal。
- 首版 DSL 实现 metadata、universe、selection、scoring 和 signals。
- 当前 `run_tactic` 由 Strategy Runner 包装或迁移。
- formula StockGroup 迁移为 Strategy 驱动的 Watchlist source。

### Phase 2：创建、版本与观察

- 模板和自然语言草案；
- 发布、暂停、复制、回滚和版本差异；
- 注册数据字典与静态校验；
- StrategyRun 原子更新统一 Watchlist；
- Agent/Web/CLI/MCP 使用统一 Strategy tools。

### Phase 3：风险与真实复盘

- portfolio guidance 和 risk；
- StrategySignal 后续表现；
- 按版本、市场环境和样本量复盘；
- 用户确认后生成新版本草案。

### Phase 4：严格回测

数据时间切片、评估引擎和偏差控制成熟后，再实现 evaluation.backtest。

## 11. 验收标准

- “战法”不再作为与 Strategy 并列的顶层领域概念。
- 相同 StrategyVersion、输入快照和运行引擎得到确定性相同结果。
- 每次运行可追溯策略版本、数据时间、覆盖范围和部分失败。
- 每只候选能解释为何入选、得分如何组成、哪些规则未满足。
- 历史信号可还原到对应 StrategyVersion 和 rule。
- Strategy 更新 Watchlist 来源时不会误删其它来源。
- score 不表述为收益概率，signal 不表述为最终 Advice。
- Strategy 的任何运行都不能触发真实交易。
