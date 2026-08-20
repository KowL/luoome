import type {
  AccountKind,
  AdviceDataSnapshot,
  AdviceDecision,
  AdviceHorizon,
  AdviceReasoning,
  AdviceSubjectKind,
  AlertPlan,
  ChatMessagePart,
  DeliveryStatus,
  Exchange,
  LimitUpLadder,
  LimitUpLadderSource,
  ListingStatus,
  MarketCoverage,
  MembershipSnapshot,
  Money,
  Notification,
  PortfolioCashFlow,
  PortfolioCorporateAction,
  PortfolioPerformanceSnapshot,
  ProviderStatus,
  Quantity,
  Report,
  ResearchTopicIndex,
  ResearchVaultSyncRun,
  SignalObservation,
  StockCode,
  StockEvent,
  Strategy,
  StrategyDataCheckpoint,
  StrategyDataCheckpointMember,
  StrategyEvaluationDay,
  StrategyEvaluationSession,
  StrategyResult,
  StrategyRun,
  StrategyRunPublication,
  StrategySchedule,
  StrategySignal,
  StrategyVersion,
  StrategyWatchlistSubscription,
  TradeSide,
  TradeSource,
  Watchlist,
  WatchlistMember,
  WatchlistMemberSource,
  WatchlistSyncRun,
  WatchRun,
  WatchTrigger,
  WorkflowRun,
} from '@luoome/core';
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/** 跨多表数据迁移登记；迁移逻辑由 repository-free runner 执行。 */
export const schemaMigrations = sqliteTable('schema_migrations', {
  id: text('id').primaryKey(),
  appliedAt: integer('applied_at', { mode: 'timestamp_ms' }).notNull(),
  checksum: text('checksum').notNull(),
  details: text('details_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
});

/**
 * Drizzle schema（ARCHITECTURE §4.3 / §5，MVP-TASK Phase 3）。
 *
 * 全包统一存储约定（详见 packages/db README 口径 / W2a 报告）：
 * - id：text（uuid 字符串），主键
 * - Date：integer + mode 'timestamp_ms'（毫秒整数），全包一致，不用 text ISO
 * - Money：real（JS number，Money branded type 本质是 number，f64→f64 往返无损）
 * - Quantity：integer
 * - Advice 的 reasoning / risks / disclaimers / basedOn：text + mode 'json'
 *   （basedOn 内含 Date 字段，读出时由 AdviceRepository 的 mapper 负责 revive）
 */

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').$type<AccountKind>().notNull(),
  /** ISO 4217 三字母币种代码。 */
  currency: text('currency').notNull(),
  initialCapital: real('initial_capital').$type<Money>().notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const stocks = sqliteTable(
  'stocks',
  {
    id: text('id').primaryKey(),
    code: text('code').$type<StockCode>().notNull(),
    exchange: text('exchange').$type<Exchange>().notNull(),
    name: text('name').notNull(),
    industry: text('industry'),
    nameSource: text('name_source')
      .$type<'stub' | 'manual' | 'universe'>()
      .notNull()
      .default('manual'),
    nameUpdatedAt: integer('name_updated_at', { mode: 'timestamp_ms' }),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(sql`0`),
  },
  (t) => ({
    /** 同一交易所内代码唯一；跨交易所代码可重复（如 SH/SZ 都有 000001）。 */
    codeExchangeUnique: uniqueIndex('stocks_code_exchange_unique').on(t.code, t.exchange),
  }),
);

export const stockUniverseMemberships = sqliteTable(
  'stock_universe_memberships',
  {
    source: text('source').notNull(),
    coverage: text('coverage').$type<MarketCoverage>().notNull(),
    stockId: text('stock_id').notNull(),
    observedName: text('observed_name').notNull(),
    listingStatus: text('listing_status').$type<ListingStatus>().notNull(),
    state: text('state').$type<'active' | 'missing'>().notNull(),
    firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull(),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
    missingSince: integer('missing_since', { mode: 'timestamp_ms' }),
    lastSyncId: text('last_sync_id').notNull(),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.source, t.coverage, t.stockId],
      name: 'stock_universe_memberships_pk',
    }),
    coverageStateIdx: index('stock_universe_memberships_coverage_state_idx').on(
      t.coverage,
      t.state,
      t.stockId,
    ),
    stockIdx: index('stock_universe_memberships_stock_idx').on(t.stockId),
  }),
);

export const stockUniverseSyncRuns = sqliteTable(
  'stock_universe_sync_runs',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    coverage: text('coverage').$type<MarketCoverage>().notNull(),
    status: text('status').$type<'running' | 'succeeded' | 'failed'>().notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    observedAt: integer('observed_at', { mode: 'timestamp_ms' }),
    reportedTotal: integer('reported_total'),
    observedCount: integer('observed_count').notNull().default(0),
    createdStocks: integer('created_stocks').notNull().default(0),
    updatedStocks: integer('updated_stocks').notNull().default(0),
    reactivated: integer('reactivated').notNull().default(0),
    markedMissing: integer('marked_missing').notNull().default(0),
    errorKind: text('error_kind'),
    errorMessage: text('error_message'),
  },
  (t) => ({
    sourceCoverageFinishedIdx: index('stock_universe_sync_runs_source_coverage_finished_idx').on(
      t.source,
      t.coverage,
      t.finishedAt,
    ),
  }),
);

/** immutable PIT membership projection for each successful universe sync. */
export const stockUniverseSnapshotMembers = sqliteTable(
  'stock_universe_snapshot_members',
  {
    syncId: text('sync_id').notNull(),
    stockId: text('stock_id').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.syncId, t.stockId], name: 'stock_universe_snapshot_members_pk' }),
    stockIdx: index('stock_universe_snapshot_members_stock_idx').on(t.stockId),
  }),
);

/** Real provider 的按交易日天梯快照；replay 只读取此 PIT 表，不读取当前 manager。 */
export const limitUpLadderSnapshots = sqliteTable(
  'limit_up_ladder_snapshots',
  {
    date: text('date').notNull(),
    source: text('source').$type<LimitUpLadderSource>().notNull(),
    total: integer('total').notNull(),
    maxLevel: integer('max_level').notNull(),
    levels: text('levels_json', { mode: 'json' }).$type<LimitUpLadder['levels']>().notNull(),
    warnings: text('warnings_json', { mode: 'json' }).$type<LimitUpLadder['warnings']>().notNull(),
    asOf: integer('as_of', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.date, t.source], name: 'limit_up_ladder_snapshots_pk' }),
    sourceDateIdx: index('limit_up_ladder_snapshots_source_date_idx').on(t.source, t.date),
  }),
);

export const holdings = sqliteTable(
  'holdings',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    stockId: text('stock_id').notNull(),
    quantity: integer('quantity').notNull(),
    availableQuantity: integer('available_quantity').notNull(),
    avgCost: real('avg_cost').$type<Money>().notNull(),
    openedAt: integer('opened_at', { mode: 'timestamp_ms' }).notNull(),
    closedAt: integer('closed_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    /** holdings 无重复：同一账户对同一标的只有一条持仓记录。 */
    accountStockUnique: uniqueIndex('holdings_account_stock_unique').on(t.accountId, t.stockId),
  }),
);

export const trades = sqliteTable('trades', {
  /** trades id 唯一（主键）。 */
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  stockId: text('stock_id').notNull(),
  side: text('side').$type<TradeSide>().notNull(),
  quantity: integer('quantity').$type<Quantity>().notNull(),
  price: real('price').$type<Money>().notNull(),
  fee: real('fee').$type<Money>().notNull(),
  executedAt: integer('executed_at', { mode: 'timestamp_ms' }).notNull(),
  source: text('source').$type<TradeSource>().notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const portfolioCashFlows = sqliteTable(
  'portfolio_cash_flows',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull(),
    kind: text('kind').$type<PortfolioCashFlow['kind']>().notNull(),
    amount: real('amount').notNull(),
    currency: text('currency').notNull(),
    stockId: text('stock_id'),
    source: text('source').$type<PortfolioCashFlow['source']>().notNull(),
    note: text('note'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    accountOccurredIdx: index('portfolio_cash_flows_account_occurred_idx').on(
      t.accountId,
      t.occurredAt,
    ),
  }),
);

export const portfolioCorporateActions = sqliteTable(
  'portfolio_corporate_actions',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    stockId: text('stock_id').notNull(),
    occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull(),
    kind: text('kind').$type<PortfolioCorporateAction['kind']>().notNull(),
    ratio: real('ratio'),
    cashPerShare: real('cash_per_share'),
    source: text('source').$type<PortfolioCorporateAction['source']>().notNull(),
    note: text('note'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    accountOccurredIdx: index('portfolio_corporate_actions_account_occurred_idx').on(
      t.accountId,
      t.occurredAt,
    ),
    stockOccurredIdx: index('portfolio_corporate_actions_stock_occurred_idx').on(
      t.stockId,
      t.occurredAt,
    ),
  }),
);

export const portfolioPerformanceSnapshots = sqliteTable(
  'portfolio_performance_snapshots',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    from: integer('from_at', { mode: 'timestamp_ms' }).notNull(),
    to: integer('to_at', { mode: 'timestamp_ms' }).notNull(),
    currency: text('currency').notNull(),
    inputFingerprint: text('input_fingerprint').notNull(),
    calculatedAt: integer('calculated_at', { mode: 'timestamp_ms' }).notNull(),
    dataAsOf: integer('data_as_of', { mode: 'timestamp_ms' }),
    performance: text('performance_json', { mode: 'json' })
      .$type<PortfolioPerformanceSnapshot['performance']>()
      .notNull(),
  },
  (t) => ({
    accountRangeFingerprintUnique: uniqueIndex(
      'portfolio_performance_snapshots_account_range_fingerprint_unique',
    ).on(t.accountId, t.from, t.to, t.inputFingerprint),
    accountCalculatedIdx: index('portfolio_performance_snapshots_account_calculated_idx').on(
      t.accountId,
      t.calculatedAt,
    ),
    accountRangeIdx: index('portfolio_performance_snapshots_account_range_idx').on(
      t.accountId,
      t.from,
      t.to,
    ),
  }),
);

export const advices = sqliteTable(
  'advices',
  {
    id: text('id').primaryKey(),
    subjectKind: text('subject_kind').$type<AdviceSubjectKind>().notNull(),
    subjectId: text('subject_id').notNull(),
    stockName: text('stock_name'),
    decision: text('decision').$type<AdviceDecision>().notNull(),
    confidence: real('confidence').notNull(),
    horizon: text('horizon').$type<AdviceHorizon>().notNull(),
    reasoning: text('reasoning', { mode: 'json' }).$type<AdviceReasoning>().notNull(),
    risks: text('risks', { mode: 'json' }).$type<readonly string[]>().notNull(),
    disclaimers: text('disclaimers', { mode: 'json' }).$type<readonly string[]>().notNull(),
    sourceTool: text('source_tool'),
    sourceWorkflow: text('source_workflow'),
    basedOn: text('based_on', { mode: 'json' }).$type<AdviceDataSnapshot>().notNull(),
    validFrom: integer('valid_from', { mode: 'timestamp_ms' }).notNull(),
    validUntil: integer('valid_until', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    subjectIdx: index('advices_subject_idx').on(t.subjectKind, t.subjectId),
    createdAtIdx: index('advices_created_at_idx').on(t.createdAt),
  }),
);

/** 每条 advice 至多一条 outcome（复盘回填，重复回填视为覆盖）。 */
export const adviceOutcomes = sqliteTable('advice_outcomes', {
  adviceId: text('advice_id').primaryKey(),
  outcome: text('outcome').$type<'followed' | 'partially_followed' | 'ignored'>().notNull(),
  pnl: real('pnl').$type<Money>(),
  benchmarkPnl: real('benchmark_pnl').$type<Money>(),
  recordedAt: integer('recorded_at', { mode: 'timestamp_ms' }).notNull(),
});

/** 实时行情快照（可选表，ARCHITECTURE §5.1 PriceSnapshot）。 */
export const priceSnapshots = sqliteTable(
  'price_snapshots',
  {
    stockId: text('stock_id').notNull(),
    observedAt: integer('observed_at', { mode: 'timestamp_ms' }).notNull(),
    fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).notNull(),
    timestampSource: text('timestamp_source').$type<'upstream' | 'retrieval'>().notNull(),
    open: real('open').$type<Money>().notNull(),
    high: real('high').$type<Money>().notNull(),
    low: real('low').$type<Money>().notNull(),
    close: real('close').$type<Money>().notNull(),
    volume: integer('volume').notNull(),
    /** 成交额（元，可选）与换手率（%，可选）：数据源给得出才填。 */
    amount: real('amount'),
    turnoverRatePct: real('turnover_rate'),
    /** 昨收（可选）：数据源给得出才填；缓存保留后，DB 降级路径不再丢涨幅基准。 */
    prevClose: real('prev_close').$type<Money>(),
    source: text('source').notNull(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.stockId, t.observedAt, t.source],
      name: 'price_snapshots_pk',
    }),
    stockObservedIdx: index('price_snapshots_stock_observed_idx').on(t.stockId, t.observedAt),
  }),
);

/**
 * 日线缓存（v0.2 起）。
 * 行情 adapter 用 1 小时级 TTL 缓存日线；AnalyzeStockTool 拉日线时优先走这里。
 * 复合主键 (stockId, date) → 同日重复写入视为覆盖。
 */
export const dailyBars = sqliteTable(
  'daily_bars',
  {
    stockId: text('stock_id').notNull(),
    date: integer('date', { mode: 'timestamp_ms' }).notNull(),
    open: real('open').$type<Money>().notNull(),
    high: real('high').$type<Money>().notNull(),
    low: real('low').$type<Money>().notNull(),
    close: real('close').$type<Money>().notNull(),
    volume: integer('volume').notNull(),
    /** 旧列保留，方便存量库幂等升级；规范读取以 adjustment/sourceAdjFactor 为准。 */
    legacyAdjFactor: real('adj_factor').notNull(),
    adjustment: text('adjustment').$type<'raw' | 'qfq' | 'hfq'>().notNull().default('raw'),
    sourceAdjFactor: real('source_adj_factor'),
    source: text('source').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.stockId, t.date], name: 'daily_bars_pk' }),
    stockIdx: index('daily_bars_stock_idx').on(t.stockId),
  }),
);

export const dailyBarRevisions = sqliteTable(
  'daily_bar_revisions',
  {
    stockId: text('stock_id').notNull(),
    date: integer('date', { mode: 'timestamp_ms' }).notNull(),
    contentHash: text('content_hash').notNull(),
    open: real('open').notNull(),
    high: real('high').notNull(),
    low: real('low').notNull(),
    close: real('close').notNull(),
    volume: integer('volume').notNull(),
    source: text('source').notNull(),
    recordedAt: integer('recorded_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.stockId, t.date, t.recordedAt, t.contentHash],
      name: 'daily_bar_revisions_pk',
    }),
    lookupIdx: index('daily_bar_revisions_lookup_idx').on(t.stockId, t.date, t.recordedAt),
  }),
);

export const strategies = sqliteTable(
  'strategies',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    owner: text('owner').$type<Strategy['owner']>().notNull(),
    status: text('status').$type<Strategy['status']>().notNull(),
    currentVersionId: text('current_version_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    statusIdx: index('strategies_status_idx').on(table.status),
    ownerIdx: index('strategies_owner_idx').on(table.owner),
  }),
);

export const strategyVersions = sqliteTable(
  'strategy_versions',
  {
    id: text('id').primaryKey(),
    strategyId: text('strategy_id').notNull(),
    version: integer('version').notNull(),
    definition: text('definition_json', { mode: 'json' })
      .$type<StrategyVersion['definition']>()
      .notNull(),
    definitionHash: text('definition_hash').notNull(),
    parentVersionId: text('parent_version_id'),
    changeSummary: text('change_summary'),
    factReferences: text('fact_references_json', { mode: 'json' }).$type<
      readonly string[] | null
    >(),
    agentTrace: text('agent_trace_json', { mode: 'json' }).$type<
      StrategyVersion['agentTrace'] | null
    >(),
    validationStatus: text('validation_status')
      .$type<StrategyVersion['validationStatus']>()
      .notNull(),
    validationErrors: text('validation_errors_json', { mode: 'json' })
      .$type<readonly string[]>()
      .notNull(),
    publishedAt: integer('published_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    strategyVersionUnique: uniqueIndex('strategy_versions_strategy_version_unique').on(
      table.strategyId,
      table.version,
    ),
    hashIdx: index('strategy_versions_hash_idx').on(table.definitionHash),
  }),
);

export const strategyRuns = sqliteTable(
  'strategy_runs',
  {
    id: text('id').primaryKey(),
    strategyId: text('strategy_id').notNull(),
    strategyVersionId: text('strategy_version_id').notNull(),
    mode: text('mode').$type<StrategyRun['mode']>().notNull(),
    coverage: text('coverage').$type<StrategyRun['coverage']>().notNull(),
    dataAsOf: integer('data_as_of', { mode: 'timestamp_ms' }).notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    status: text('status').$type<StrategyRun['status']>().notNull(),
    scope: text('scope')
      .$type<NonNullable<StrategyRun['scope']>>()
      .notNull()
      .default('operational'),
    inputSnapshot: text('input_snapshot_json', { mode: 'json' })
      .$type<StrategyRun['inputSnapshot']>()
      .notNull(),
    providerStatuses: text('provider_statuses_json', { mode: 'json' })
      .$type<StrategyRun['providerStatuses']>()
      .notNull(),
    providerCoverage: text('provider_coverage_json', { mode: 'json' }).$type<
      NonNullable<StrategyRun['providerCoverage']>
    >(),
    summary: text('summary_json', { mode: 'json' }).$type<StrategyRun['summary']>(),
    publication: text('publication_json', { mode: 'json' }).$type<StrategyRunPublication>(),
    publicationStatus: text('publication_status').$type<StrategyRunPublication['status']>(),
    error: text('error'),
  },
  (table) => ({
    strategyStartedIdx: index('strategy_runs_strategy_started_idx').on(
      table.strategyId,
      table.startedAt,
    ),
    statusStartedIdx: index('strategy_runs_status_started_idx').on(table.status, table.startedAt),
    publishedCurrentIdx: index('strategy_runs_published_current_idx').on(
      table.strategyId,
      table.scope,
      table.publicationStatus,
      table.status,
      table.startedAt,
    ),
  }),
);

export const strategySchedules = sqliteTable(
  'strategy_schedules',
  {
    id: text('id').primaryKey(),
    strategyId: text('strategy_id').notNull(),
    cron: text('cron').notNull(),
    timezone: text('timezone').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    acceptancePolicy: text('acceptance_policy_json', { mode: 'json' }).$type<
      StrategySchedule['acceptancePolicy']
    >(),
    recommendationPolicy: text('recommendation_policy_json', { mode: 'json' }).$type<
      StrategySchedule['recommendationPolicy']
    >(),
    nextRunAt: integer('next_run_at', { mode: 'timestamp_ms' }),
    lastRunId: text('last_run_id'),
    leaseOwner: text('lease_owner'),
    leaseUntil: integer('lease_until', { mode: 'timestamp_ms' }),
    leaseFence: integer('lease_fence').notNull().default(0),
    leaseHeartbeatAt: integer('lease_heartbeat_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    strategyUnique: uniqueIndex('strategy_schedules_strategy_unique').on(table.strategyId),
    dueIdx: index('strategy_schedules_due_idx').on(table.enabled, table.nextRunAt),
    leaseIdx: index('strategy_schedules_lease_idx').on(table.leaseUntil),
  }),
);

export const strategyRunLeases = sqliteTable(
  'strategy_run_leases',
  {
    strategyId: text('strategy_id').notNull(),
    strategyVersionId: text('strategy_version_id').notNull(),
    owner: text('owner').notNull(),
    leaseUntil: integer('lease_until', { mode: 'timestamp_ms' }).notNull(),
    fence: integer('fence').notNull().default(0),
    heartbeatAt: integer('heartbeat_at', { mode: 'timestamp_ms' }).notNull().default(sql`0`),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.strategyId, table.strategyVersionId],
      name: 'strategy_run_leases_pk',
    }),
    untilIdx: index('strategy_run_leases_until_idx').on(table.leaseUntil),
  }),
);

export const strategyResults = sqliteTable(
  'strategy_results',
  {
    runId: text('run_id').notNull(),
    stockId: text('stock_id').notNull(),
    selected: integer('selected', { mode: 'boolean' }).notNull(),
    score: real('score'),
    rank: integer('rank'),
    ruleEvaluations: text('rule_evaluations_json', { mode: 'json' })
      .$type<StrategyResult['ruleEvaluations']>()
      .notNull(),
    evidence: text('evidence_json', { mode: 'json' }).$type<StrategyResult['evidence']>().notNull(),
    dataAsOf: integer('data_as_of', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.runId, table.stockId], name: 'strategy_results_pk' }),
    runRankIdx: index('strategy_results_run_rank_idx').on(table.runId, table.rank),
  }),
);

export const strategySignals = sqliteTable(
  'strategy_signals',
  {
    id: text('id').primaryKey(),
    strategyId: text('strategy_id').notNull(),
    strategyVersionId: text('strategy_version_id').notNull(),
    runId: text('run_id').notNull(),
    ruleId: text('rule_id').notNull(),
    stockId: text('stock_id').notNull(),
    ts: integer('ts', { mode: 'timestamp_ms' }).notNull(),
    score: real('score').notNull(),
    direction: text('direction').$type<StrategySignal['direction']>().notNull(),
    evidence: text('evidence_json', { mode: 'json' }).$type<StrategySignal['evidence']>().notNull(),
    evaluationSnapshot: text('evaluation_snapshot_json', { mode: 'json' })
      .$type<StrategySignal['evaluationSnapshot']>()
      .notNull(),
  },
  (table) => ({
    identityUnique: uniqueIndex('strategy_signals_run_event_unique').on(
      table.runId,
      table.ruleId,
      table.stockId,
      table.ts,
    ),
    strategyTsIdx: index('strategy_signals_strategy_ts_idx').on(table.strategyId, table.ts),
    runTsIdx: index('strategy_signals_run_ts_idx').on(table.runId, table.ts),
    stockTsIdx: index('strategy_signals_stock_ts_idx').on(table.stockId, table.ts),
  }),
);

export const strategyDataCheckpoints = sqliteTable(
  'strategy_data_checkpoints',
  {
    id: text('id').primaryKey(),
    coverage: text('coverage').notNull(),
    dataAsOf: integer('data_as_of', { mode: 'timestamp_ms' }).notNull(),
    status: text('status').$type<StrategyDataCheckpoint['status']>().notNull(),
    vintageStatus: text('vintage_status')
      .$type<StrategyDataCheckpoint['vintageStatus']>()
      .notNull()
      .default('not-applicable'),
    universeSyncId: text('universe_sync_id').notNull(),
    requestedCount: integer('requested_count').notNull(),
    availableCount: integer('available_count').notNull(),
    failedCount: integer('failed_count').notNull(),
    memberChecksum: text('member_checksum').notNull(),
    dataChecksum: text('data_checksum').notNull(),
    providerStatuses: text('provider_statuses_json', { mode: 'json' })
      .$type<StrategyDataCheckpoint['providerStatuses']>()
      .notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    lookupIdx: index('strategy_data_checkpoints_lookup_idx').on(
      t.coverage,
      t.universeSyncId,
      t.dataAsOf,
    ),
  }),
);

export const strategyDataCheckpointMembers = sqliteTable(
  'strategy_data_checkpoint_members',
  {
    checkpointId: text('checkpoint_id').notNull(),
    stockId: text('stock_id').notNull(),
    status: text('status').$type<StrategyDataCheckpointMember['status']>().notNull(),
    latestBarDate: integer('latest_bar_date', { mode: 'timestamp_ms' }),
    barCount: integer('bar_count').notNull(),
    provider: text('provider'),
    errorKind: text('error_kind'),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.checkpointId, t.stockId],
      name: 'strategy_data_checkpoint_members_pk',
    }),
    statusIdx: index('strategy_data_checkpoint_members_status_idx').on(t.checkpointId, t.status),
  }),
);

export const strategyEvaluationSessions = sqliteTable(
  'strategy_evaluation_sessions',
  {
    id: text('id').primaryKey(),
    strategyId: text('strategy_id').notNull(),
    strategyVersionId: text('strategy_version_id').notNull(),
    from: integer('from_at', { mode: 'timestamp_ms' }).notNull(),
    to: integer('to_at', { mode: 'timestamp_ms' }).notNull(),
    status: text('status').$type<StrategyEvaluationSession['status']>().notNull(),
    definitionHash: text('definition_hash').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    stockIds: text('stock_ids_json', { mode: 'json' }).$type<
      StrategyEvaluationSession['stockIds']
    >(),
    stockIdChecksum: text('stock_id_checksum'),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    error: text('error'),
  },
  (t) => ({
    strategyCreatedIdx: index('strategy_evaluation_sessions_strategy_created_idx').on(
      t.strategyId,
      t.createdAt,
    ),
  }),
);

export const strategyEvaluationDays = sqliteTable(
  'strategy_evaluation_days',
  {
    sessionId: text('session_id').notNull(),
    dataAsOf: integer('data_as_of', { mode: 'timestamp_ms' }).notNull(),
    runId: text('run_id'),
    universeSyncId: text('universe_sync_id'),
    dataCheckpointId: text('data_checkpoint_id'),
    revisionCutoff: integer('revision_cutoff', { mode: 'timestamp_ms' }),
    vintageStatus:
      text('vintage_status').$type<NonNullable<StrategyEvaluationDay['vintageStatus']>>(),
    status: text('status').$type<StrategyEvaluationDay['status']>().notNull(),
    evaluatedCount: integer('evaluated_count'),
    selectedCount: integer('selected_count'),
    signalCount: integer('signal_count'),
    failedCount: integer('failed_count'),
    error: text('error'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sessionId, t.dataAsOf], name: 'strategy_evaluation_days_pk' }),
    statusIdx: index('strategy_evaluation_days_status_idx').on(t.sessionId, t.status),
  }),
);

export const signalObservations = sqliteTable(
  'signal_observations',
  {
    id: text('id').primaryKey(),
    sourceKind: text('source_kind').$type<SignalObservation['sourceKind']>().notNull(),
    sourceId: text('source_id').notNull(),
    stockId: text('stock_id').notNull(),
    baselinePrice: real('baseline_price'),
    baselineAt: integer('baseline_at', { mode: 'timestamp_ms' }),
    horizon: text('horizon').$type<SignalObservation['horizon']>().notNull(),
    closePrice: real('close_price'),
    returnPct: real('return_pct'),
    maxFavorableExcursionPct: real('max_favorable_excursion_pct'),
    maxAdverseExcursionPct: real('max_adverse_excursion_pct'),
    benchmarkReturnPct: real('benchmark_return_pct'),
    benchmarkStatus: text('benchmark_status')
      .$type<SignalObservation['benchmarkStatus']>()
      .notNull(),
    status: text('status').$type<SignalObservation['status']>().notNull(),
    provenance: text('provenance', { mode: 'json' })
      .$type<SignalObservation['provenance']>()
      .notNull(),
    unavailableReason: text('unavailable_reason'),
    observedAt: integer('observed_at', { mode: 'timestamp_ms' }),
    dueAt: integer('due_at', { mode: 'timestamp_ms' }),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastAttemptAt: integer('last_attempt_at', { mode: 'timestamp_ms' }),
    nextAttemptAt: integer('next_attempt_at', { mode: 'timestamp_ms' }),
    lastErrorKind: text('last_error_kind'),
  },
  (t) => ({
    statusBaselineIdx: index('signal_observations_status_baseline_idx').on(t.status, t.baselineAt),
    sourceIdx: index('signal_observations_source_idx').on(t.sourceKind, t.sourceId),
    dueIdx: index('signal_observations_due_idx').on(t.status, t.dueAt, t.nextAttemptAt),
  }),
);

/**
 * 通知历史（v0.3 起）。
 * 软关联 adviceId / tacticSignalId（text，可空；不强 FK）。
 * result / sentAt 索引方便「最近失败通知」排查。
 */
export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    channel: text('channel').$type<Notification['channel']>().notNull(),
    /** payload 是 union schema，JSON 序列化后由 Repository mapper 区分 channel 还原。 */
    payload: text('payload', { mode: 'json' }).$type<Notification['payload']>().notNull(),
    result: text('result').$type<Notification['result']>().notNull(),
    errorMessage: text('error_message'),
    adviceId: text('advice_id'),
    tacticSignalId: text('tactic_signal_id'),
    sentAt: integer('sent_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    adviceIdx: index('notifications_advice_idx').on(t.adviceId),
    signalIdx: index('notifications_signal_idx').on(t.tacticSignalId),
    resultIdx: index('notifications_result_idx').on(t.result, t.sentAt),
  }),
);

export const alertPlans = sqliteTable(
  'alert_plans',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    watchlistId: text('watchlist_id').notNull(),
    rules: text('rules', { mode: 'json' }).$type<AlertPlan['rules']>().notNull(),
    logic: text('logic').$type<AlertPlan['logic']>().notNull(),
    triggerMode: text('trigger_mode').$type<AlertPlan['triggerMode']>().notNull(),
    priority: text('priority').$type<NonNullable<AlertPlan['priority']>>(),
    cooldownMinutes: integer('cooldown_minutes').notNull(),
    dailyNotificationLimit: integer('daily_notification_limit').notNull(),
    notifyOnRecovery: integer('notify_on_recovery', { mode: 'boolean' }).notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    watchlistIdx: index('alert_plans_watchlist_idx').on(t.watchlistId),
    enabledIdx: index('alert_plans_enabled_idx').on(t.enabled),
  }),
);

export const watchlists = sqliteTable(
  'watchlists',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    kind: text('kind').$type<Watchlist['kind']>().notNull(),
    membershipPolicy: text('membership_policy').$type<Watchlist['membershipPolicy']>().notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    enabledIdx: index('watchlists_enabled_idx').on(t.enabled),
    kindIdx: index('watchlists_kind_idx').on(t.kind),
  }),
);

export const strategyWatchlistSubscriptions = sqliteTable(
  'strategy_watchlist_subscriptions',
  {
    id: text('id').primaryKey(),
    strategyId: text('strategy_id').notNull(),
    watchlistId: text('watchlist_id').notNull(),
    sourceKey: text('source_key').notNull(),
    status: text('status').$type<StrategyWatchlistSubscription['status']>().notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    cancelledAt: integer('cancelled_at', { mode: 'timestamp_ms' }),
    cancelledBy: text('cancelled_by'),
  },
  (t) => ({
    strategyStatusIdx: index('strategy_watchlist_subscriptions_strategy_status_idx').on(
      t.strategyId,
      t.status,
    ),
    watchlistStatusIdx: index('strategy_watchlist_subscriptions_watchlist_status_idx').on(
      t.watchlistId,
      t.status,
    ),
    activeUnique: uniqueIndex('strategy_watchlist_subscriptions_active_unique')
      .on(t.strategyId, t.watchlistId)
      .where(sql`status = 'active'`),
  }),
);

export const watchlistMembers = sqliteTable(
  'watchlist_members',
  {
    id: text('id').primaryKey(),
    watchlistId: text('watchlist_id').notNull(),
    stockId: text('stock_id').notNull(),
    stage: text('stage').$type<WatchlistMember['stage']>().notNull(),
    priority: text('priority').$type<WatchlistMember['priority']>().notNull(),
    firstAddedAt: integer('first_added_at', { mode: 'timestamp_ms' }).notNull(),
    lastActivityAt: integer('last_activity_at', { mode: 'timestamp_ms' }).notNull(),
    archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    watchlistStockUnique: uniqueIndex('watchlist_members_watchlist_stock_unique').on(
      t.watchlistId,
      t.stockId,
    ),
    watchlistStageIdx: index('watchlist_members_watchlist_stage_idx').on(t.watchlistId, t.stage),
  }),
);

export const watchlistMemberSources = sqliteTable(
  'watchlist_member_sources',
  {
    id: text('id').primaryKey(),
    memberId: text('member_id').notNull(),
    kind: text('kind').$type<WatchlistMemberSource['kind']>().notNull(),
    sourceKey: text('source_key').notNull(),
    sourceId: text('source_id'),
    sourceVersionId: text('source_version_id'),
    syncRunId: text('sync_run_id'),
    reason: text('reason').notNull(),
    score: real('score'),
    rank: integer('rank'),
    status: text('status').$type<WatchlistMemberSource['status']>().notNull(),
    evidence: text('evidence_json', { mode: 'json' }).$type<readonly string[]>().notNull(),
    dataAsOf: integer('data_as_of', { mode: 'timestamp_ms' }),
    validFrom: integer('valid_from', { mode: 'timestamp_ms' }).notNull(),
    validUntil: integer('valid_until', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    memberStatusIdx: index('watchlist_sources_member_status_idx').on(t.memberId, t.status),
    sourceKeyStatusIdx: index('watchlist_sources_key_status_idx').on(t.sourceKey, t.status),
    /** 同一 member 的同一 sourceKey 只允许一个非 ended 来源（DDL 见 client.ts ensureSchema）。 */
    currentUnique: uniqueIndex('watchlist_sources_current_unique')
      .on(t.memberId, t.sourceKey)
      .where(sql`status <> 'ended'`),
  }),
);

export const watchlistSyncRuns = sqliteTable(
  'watchlist_sync_runs',
  {
    id: text('id').primaryKey(),
    watchlistId: text('watchlist_id').notNull(),
    sourceKind: text('source_kind').$type<WatchlistSyncRun['sourceKind']>().notNull(),
    sourceKey: text('source_key').notNull(),
    producerRunId: text('producer_run_id'),
    status: text('status').$type<WatchlistSyncRun['status']>().notNull(),
    dataAsOf: integer('data_as_of', { mode: 'timestamp_ms' }),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    enteredCount: integer('entered_count').notNull(),
    exitedCount: integer('exited_count').notNull(),
    unchangedCount: integer('unchanged_count').notNull(),
    missingDimensions: text('missing_dimensions_json', { mode: 'json' })
      .$type<WatchlistSyncRun['missingDimensions']>()
      .notNull(),
    error: text('error'),
  },
  (t) => ({
    watchlistStartedIdx: index('watchlist_sync_runs_watchlist_started_idx').on(
      t.watchlistId,
      t.startedAt,
    ),
    producerIdx: index('watchlist_sync_runs_producer_idx').on(t.producerRunId),
    producerSourceUnique: uniqueIndex('watchlist_sync_runs_producer_source_unique')
      .on(t.watchlistId, t.sourceKey, t.producerRunId)
      .where(sql`producer_run_id IS NOT NULL`),
  }),
);

export const membershipSnapshots = sqliteTable(
  'membership_snapshots',
  {
    id: text('id').primaryKey(),
    syncRunId: text('sync_run_id').notNull(),
    stockId: text('stock_id').notNull(),
    selected: integer('selected', { mode: 'boolean' }).notNull(),
    change: text('change').$type<MembershipSnapshot['change']>().notNull(),
    reason: text('reason').notNull(),
    score: real('score'),
    rank: integer('rank'),
    evidence: text('evidence_json', { mode: 'json' }).$type<readonly string[]>().notNull(),
    dataAsOf: integer('data_as_of', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    runStockUnique: uniqueIndex('membership_snapshots_run_stock_unique').on(t.syncRunId, t.stockId),
    runChangeIdx: index('membership_snapshots_run_change_idx').on(t.syncRunId, t.change),
  }),
);

/**
 * 盯盘触发（v0.6 起，v0.7 策略预警扩展）。
 * - 每次 watch fire 即写入（含 cooldown 抑制的）；deliveryStatus 标识实际送达状态。
 * - evidence 走 text + mode 'json'（字符串数组）。
 * - 主索引 (poolId, stockId, ruleId, createdAt) 支撑 cooldown 查询 lastForKey。
 * - ruleKind 保留（展示 + 旧查询）；ALL 组合触发的 ruleKind 取组合中优先级最高的 kind，
 *   ruleId 固定为 'composite'。
 */
export const watchTriggers = sqliteTable(
  'watch_triggers',
  {
    id: text('id').primaryKey(),
    alertPlanId: text('alert_plan_id'),
    poolId: text('pool_id').notNull(),
    stockId: text('stock_id').notNull(),
    ruleKind: text('rule_kind').$type<WatchTrigger['ruleKind']>().notNull(),
    direction: text('direction').$type<WatchTrigger['direction']>().notNull(),
    reason: text('reason').notNull(),
    evidence: text('evidence', { mode: 'json' }).$type<readonly string[]>().notNull(),
    quoteClose: real('quote_close').$type<Money>(),
    quoteTs: integer('quote_ts', { mode: 'timestamp_ms' }),
    notified: integer('notified', { mode: 'boolean' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    /** 规则实例 id（与 stock_pool.rules[].id 对齐）；ALL 组合触发固定为 'composite'。 */
    ruleId: text('rule_id').notNull(),
    /** 触发类型：进入（rising edge）vs 退出（recovered）；默认 'triggered'。 */
    triggerType: text('trigger_type').notNull(),
    /** 落库时为生效优先级，不再反推。 */
    priority: text('priority').notNull(),
    /** 单条送达状态机落值。 */
    deliveryStatus: text('delivery_status').notNull(),
    /** 关联的 Notification id，发送后回写。 */
    notificationId: text('notification_id'),
    /** 求值快照：输入值 / 阈值 / 窗口 / 数据时间，至少含 ruleId / kind / quoteClose / quoteTs。 */
    evalSnapshot: text('eval_snapshot', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    /** 用户反馈（handled / useful / useless / ignored），由 set_watch_trigger_feedback 写入。 */
    feedback: text('feedback'),
    feedbackAt: integer('feedback_at', { mode: 'timestamp_ms' }),
    /** ruo 迁移：event-date 触发关联的公司事件 id（非 event-date 触发为空）。 */
    eventId: text('event_id'),
  },
  (t) => ({
    /** cooldown 查询 lastForKey 走这条。 */
    poolStockRuleTsIdx: index('watch_triggers_pool_stock_rule_ts_idx').on(
      t.poolId,
      t.stockId,
      t.ruleId,
      t.createdAt,
    ),
    /** listByPool 按时间倒序走这条。 */
    poolTsIdx: index('watch_triggers_pool_ts_idx').on(t.poolId, t.createdAt),
    /** event-date 去重 / 按事件过滤走这条。 */
    poolStockRuleEventIdx: index('watch_triggers_pool_stock_rule_event_idx').on(
      t.poolId,
      t.stockId,
      t.ruleId,
      t.eventId,
      t.createdAt,
    ),
  }),
);

/**
 * 边沿状态机表（v0.7 策略预警，docs/.../§3.5 / §5）。
 * 仅 (poolId, stockId, ruleId) 维度的 active 状态；不替代 watch_triggers 历史。
 */
export const watchRuleStates = sqliteTable(
  'watch_rule_states',
  {
    alertPlanId: text('alert_plan_id'),
    poolId: text('pool_id').notNull(),
    stockId: text('stock_id').notNull(),
    /** 含虚拟 'composite'。 */
    ruleId: text('rule_id').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull(),
    firstTriggeredAt: integer('first_triggered_at', { mode: 'timestamp_ms' }),
    lastEvaluatedAt: integer('last_evaluated_at', { mode: 'timestamp_ms' }).notNull(),
    /** 最近一次求值量（如 changePct），仅展示用。 */
    lastValue: real('last_value'),
    lastRecoveredAt: integer('last_recovered_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.poolId, t.stockId, t.ruleId], name: 'watch_rule_states_pk' }),
    poolIdx: index('watch_rule_states_pool_idx').on(t.poolId),
  }),
);

/** 每轮 watch 心跳/结果；无 trigger 时也写，支撑运行健康度。 */
export const watchRuns = sqliteTable(
  'watch_runs',
  {
    id: text('id').primaryKey(),
    mode: text('mode').$type<WatchRun['mode']>().notNull(),
    status: text('status').$type<WatchRun['status']>().notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    evaluatedPools: integer('evaluated_pools').notNull(),
    evaluatedStocks: integer('evaluated_stocks').notNull(),
    triggered: integer('triggered').notNull(),
    notified: integer('notified').notNull(),
    suppressedByCooldown: integer('suppressed_by_cooldown').notNull(),
    error: text('error'),
    /** v0.7 策略预警：方案 / 全局每日上限命中导致被抑制的条数。 */
    suppressedByDailyLimit: integer('suppressed_by_daily_limit').notNull(),
    /** v0.7 策略预警：发送失败条数（面板告警）。 */
    notifyFailed: integer('notify_failed').notNull(),
  },
  (t) => ({
    startedAtIdx: index('watch_runs_started_at_idx').on(t.startedAt),
  }),
);

export const researchTopicIndex = sqliteTable(
  'research_topic_index',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    kind: text('kind').$type<ResearchTopicIndex['kind']>().notNull(),
    summary: text('summary'),
    tags: text('tags', { mode: 'json' }).$type<readonly string[]>().notNull(),
    vaultId: text('vault_id').notNull(),
    relativePath: text('relative_path').notNull(),
    contentHash: text('content_hash').notNull(),
    archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
    fileModifiedAt: integer('file_modified_at', { mode: 'timestamp_ms' }).notNull(),
    indexedAt: integer('indexed_at', { mode: 'timestamp_ms' }).notNull(),
    availability: text('availability').notNull(),
    diagnostic: text('diagnostic'),
  },
  (t) => ({
    pathUnique: uniqueIndex('research_topic_index_vault_path_unique').on(t.vaultId, t.relativePath),
    kindArchiveIdx: index('research_topic_index_kind_archive_idx').on(t.kind, t.archivedAt),
  }),
);

export const researchDocumentIndex = sqliteTable(
  'research_document_index',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    author: text('author'),
    sourceUrl: text('source_url'),
    sourceStatus: text('source_status'),
    publishedAt: integer('published_at', { mode: 'timestamp_ms' }),
    observedAt: integer('observed_at', { mode: 'timestamp_ms' }),
    importedAt: integer('imported_at', { mode: 'timestamp_ms' }).notNull(),
    tags: text('tags', { mode: 'json' }).$type<readonly string[]>().notNull(),
    vaultId: text('vault_id').notNull(),
    relativePath: text('relative_path').notNull(),
    attachmentPaths: text('attachment_paths', { mode: 'json' })
      .$type<readonly string[]>()
      .notNull(),
    contentHash: text('content_hash').notNull(),
    excerpt: text('excerpt'),
    fileModifiedAt: integer('file_modified_at', { mode: 'timestamp_ms' }).notNull(),
    indexedAt: integer('indexed_at', { mode: 'timestamp_ms' }).notNull(),
    availability: text('availability').notNull(),
    diagnostic: text('diagnostic'),
  },
  (t) => ({
    pathUnique: uniqueIndex('research_document_index_vault_path_unique').on(
      t.vaultId,
      t.relativePath,
    ),
    publishedIdx: index('research_document_index_published_idx').on(t.publishedAt),
    observedIdx: index('research_document_index_observed_idx').on(t.observedAt),
  }),
);
export const researchTopicDocuments = sqliteTable(
  'research_topic_documents',
  {
    topicId: text('topic_id').notNull(),
    documentId: text('document_id').notNull(),
    relation: text('relation').notNull(),
    sortOrder: integer('sort_order'),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.topicId, t.documentId, t.relation],
      name: 'research_topic_documents_pk',
    }),
    docIdx: index('research_topic_documents_document_idx').on(t.documentId),
  }),
);
export const researchSubjectLinks = sqliteTable(
  'research_subject_links',
  {
    ownerKind: text('owner_kind').notNull(),
    ownerId: text('owner_id').notNull(),
    subjectKind: text('subject_kind').notNull(),
    subjectKey: text('subject_key').notNull(),
    relation: text('relation').notNull(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.ownerKind, t.ownerId, t.subjectKind, t.subjectKey, t.relation],
      name: 'research_subject_links_pk',
    }),
    subjectIdx: index('research_subject_links_subject_idx').on(
      t.subjectKind,
      t.subjectKey,
      t.ownerKind,
    ),
  }),
);
export const researchDocumentChunks = sqliteTable(
  'research_document_chunks',
  {
    documentId: text('document_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    headingPath: text('heading_path').notNull(),
    contentHash: text('content_hash').notNull(),
    body: text('body').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.documentId, t.ordinal], name: 'research_document_chunks_pk' }),
  }),
);
// FTS5 virtual table is created by ensureSchema; this declaration only supplies
// Drizzle's typed query surface and does not create a second ordinary table.
export const researchDocumentFts = sqliteTable('research_document_fts', {
  documentId: text('document_id').notNull(),
  ordinal: integer('ordinal').notNull(),
  contentHash: text('content_hash').notNull(),
  title: text('title').notNull(),
  headingPath: text('heading_path').notNull(),
  body: text('body').notNull(),
});
export const researchVaultSyncRuns = sqliteTable(
  'research_vault_sync_runs',
  {
    id: text('id').primaryKey(),
    vaultId: text('vault_id').notNull(),
    mode: text('mode').$type<ResearchVaultSyncRun['mode']>().notNull(),
    status: text('status').$type<ResearchVaultSyncRun['status']>().notNull(),
    scanned: integer('scanned').notNull(),
    added: integer('added').notNull(),
    updated: integer('updated').notNull(),
    unchanged: integer('unchanged').notNull(),
    missing: integer('missing').notNull(),
    invalid: integer('invalid').notNull(),
    conflicts: integer('conflicts').notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    error: text('error'),
  },
  (t) => ({
    vaultStartedIdx: index('research_vault_sync_runs_vault_started_idx').on(t.vaultId, t.startedAt),
  }),
);

/**
 * 公司事件（ruo 迁移 Phase 1B，docs/.../§3.2）。
 * (provider, external_id) 唯一（manual 行两列为 NULL，SQLite 唯一索引放行多 NULL）。
 * remindBeforeDays 走 text + mode 'json'（数字数组）。
 */
export const stockEvents = sqliteTable(
  'stock_events',
  {
    id: text('id').primaryKey(),
    stockId: text('stock_id').notNull(),
    kind: text('kind').$type<StockEvent['kind']>().notNull(),
    title: text('title').notNull(),
    description: text('description'),
    occursAt: integer('occurs_at', { mode: 'timestamp_ms' }).notNull(),
    allDay: integer('all_day', { mode: 'boolean' }).notNull(),
    importance: text('importance').$type<StockEvent['importance']>().notNull(),
    status: text('status').$type<StockEvent['status']>().notNull(),
    source: text('source').$type<StockEvent['source']>().notNull(),
    provider: text('provider'),
    externalId: text('external_id'),
    sourceUrl: text('source_url'),
    observedAt: integer('observed_at', { mode: 'timestamp_ms' }),
    fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }),
    stale: integer('stale', { mode: 'boolean' }).notNull(),
    remindBeforeDays: text('remind_before_days', { mode: 'json' })
      .$type<readonly number[]>()
      .notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    providerExternalUnique: uniqueIndex('stock_events_provider_external_unique').on(
      t.provider,
      t.externalId,
    ),
    stockOccursIdx: index('stock_events_stock_occurs_idx').on(t.stockId, t.occursAt),
    occursStatusIdx: index('stock_events_occurs_status_idx').on(t.occursAt, t.status),
    stockKindOccursIdx: index('stock_events_stock_kind_occurs_idx').on(
      t.stockId,
      t.kind,
      t.occursAt,
    ),
  }),
);

/**
 * Workflow 运行审计（ruo 迁移 Phase 1C，docs/.../§3.4）。
 * inputSummary / outputSummary / providerStatuses 走 text + mode 'json'。
 */
export const workflowRuns = sqliteTable(
  'workflow_runs',
  {
    id: text('id').primaryKey(),
    workflowName: text('workflow_name').notNull(),
    mode: text('mode').$type<WorkflowRun['mode']>().notNull(),
    status: text('status').$type<WorkflowRun['status']>().notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    inputSummary: text('input_summary', { mode: 'json' }).$type<Record<string, unknown>>(),
    outputSummary: text('output_summary', { mode: 'json' }).$type<Record<string, unknown>>(),
    providerStatuses: text('provider_statuses', { mode: 'json' })
      .$type<readonly ProviderStatus[]>()
      .notNull(),
    error: text('error'),
  },
  (t) => ({
    nameStartedIdx: index('workflow_runs_name_started_idx').on(t.workflowName, t.startedAt),
    startedIdx: index('workflow_runs_started_idx').on(t.startedAt),
  }),
);

export const reports = sqliteTable(
  'reports',
  {
    id: text('id').primaryKey(),
    kind: text('kind').$type<Report['kind']>().notNull(),
    scopeKey: text('scope_key').notNull(),
    scope: text('scope_json', { mode: 'json' }).$type<Report['scope']>().notNull(),
    periodStart: text('period_start').notNull(),
    periodEnd: text('period_end').notNull(),
    title: text('title').notNull(),
    generatedAt: integer('generated_at', { mode: 'timestamp_ms' }).notNull(),
    dataAsOf: integer('data_as_of', { mode: 'timestamp_ms' }).notNull(),
    status: text('status').$type<Report['status']>().notNull(),
    sections: text('sections_json', { mode: 'json' }).$type<Report['sections']>().notNull(),
    evidence: text('evidence_json', { mode: 'json' }).$type<Report['evidence']>().notNull(),
    missingDimensions: text('missing_dimensions_json', { mode: 'json' })
      .$type<Report['missingDimensions']>()
      .notNull(),
    deliveryStatus: text('delivery_status').$type<DeliveryStatus>().notNull(),
    workflowRunId: text('workflow_run_id').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    periodUnique: uniqueIndex('reports_period_unique').on(
      t.kind,
      t.scopeKey,
      t.periodStart,
      t.periodEnd,
    ),
    periodEndIdx: index('reports_period_end_idx').on(t.periodEnd),
    kindPeriodEndIdx: index('reports_kind_period_end_idx').on(t.kind, t.periodEnd),
    statusPeriodEndIdx: index('reports_status_period_end_idx').on(t.status, t.periodEnd),
    workflowRunIdx: index('reports_workflow_run_idx').on(t.workflowRunId),
  }),
);

export const chatSessions = sqliteTable(
  'chat_sessions',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    title: text('title').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    accountUpdatedIdx: index('chat_sessions_account_updated_idx').on(t.accountId, t.updatedAt),
  }),
);

export const chatMessages = sqliteTable(
  'chat_messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    role: text('role').$type<'user' | 'assistant'>().notNull(),
    parts: text('parts', { mode: 'json' }).$type<readonly ChatMessagePart[]>().notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    sessionCreatedIdx: index('chat_messages_session_created_idx').on(t.sessionId, t.createdAt),
  }),
);

export const schema = {
  schemaMigrations,
  accounts,
  stocks,
  stockUniverseMemberships,
  stockUniverseSyncRuns,
  stockUniverseSnapshotMembers,
  limitUpLadderSnapshots,
  holdings,
  trades,
  portfolioCashFlows,
  portfolioCorporateActions,
  portfolioPerformanceSnapshots,
  advices,
  adviceOutcomes,
  priceSnapshots,
  dailyBars,
  dailyBarRevisions,
  strategies,
  strategyVersions,
  strategyRuns,
  strategySchedules,
  strategyRunLeases,
  strategyResults,
  strategySignals,
  strategyDataCheckpoints,
  strategyDataCheckpointMembers,
  strategyEvaluationSessions,
  strategyEvaluationDays,
  signalObservations,
  notifications,
  // v0.6 起
  alertPlans,
  watchTriggers,
  // v0.7 起：边沿状态机
  watchRuleStates,
  watchRuns,
  watchlists,
  watchlistMembers,
  watchlistMemberSources,
  watchlistSyncRuns,
  membershipSnapshots,
  // ruo 迁移起（docs/ddd/ruo-feature-migration-detailed-design.md §3）
  researchTopicIndex,
  researchDocumentIndex,
  researchTopicDocuments,
  researchSubjectLinks,
  researchDocumentChunks,
  researchDocumentFts,
  researchVaultSyncRuns,
  stockEvents,
  workflowRuns,
  reports,
  chatSessions,
  chatMessages,
} as const;

export type Schema = typeof schema;
