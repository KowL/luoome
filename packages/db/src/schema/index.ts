import type {
  AccountKind,
  AdviceDataSnapshot,
  AdviceDecision,
  AdviceHorizon,
  AdviceReasoning,
  AdviceSubjectKind,
  AlertPlan,
  ChatMessagePart,
  DecisionReviewContent,
  DecisionReviewSubjectKind,
  DeliveryStatus,
  Exchange,
  LimitUpLadder,
  LimitUpLadderSample,
  LimitUpLadderSource,
  ListingStatus,
  MarketCoverage,
  MarketSnapshotCompleteness,
  MarketSnapshotItem,
  MinuteBarCompleteness,
  MinuteBarInterval,
  Money,
  Notification,
  PortfolioPerformanceSnapshot,
  ProviderStatus,
  Quantity,
  Report,
  SectorCatalogState,
  SectorChangeKind,
  SectorKind,
  SectorMemberStatus,
  SectorMembershipState,
  SectorSyncFailure,
  SectorSyncStatus,
  SignalObservation,
  StockCode,
  Strategy,
  StrategyEvaluatorIdentity,
  StrategyRun,
  StrategyRunPublication,
  StrategySignal,
  StrategyVersion,
  StrategyWatchlistSubscription,
  StrictBacktestGateAudit,
  StrictBacktestMetrics,
  StrictBacktestRun,
  StrictBacktestSpec,
  TradeSide,
  TradeSource,
  TradingPlan,
  Watchlist,
  WatchlistMember,
  WatchlistMemberSource,
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
  /** 当前现金余额：由交易/持仓/资金流水在同一事务内增减，口径见 core portfolio/ledger。 */
  cashBalance: real('cash_balance').$type<Money>().notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const decisionReviews = sqliteTable(
  'decision_reviews',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    subjectKind: text('subject_kind').$type<DecisionReviewSubjectKind>().notNull(),
    subjectId: text('subject_id').notNull(),
    stockId: text('stock_id'),
    content: text('content_json', { mode: 'json' }).$type<DecisionReviewContent>().notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    subjectUnique: uniqueIndex('decision_reviews_account_subject_unique').on(
      t.accountId,
      t.subjectKind,
      t.subjectId,
    ),
    accountTimeIdx: index('decision_reviews_account_time_idx').on(t.accountId, t.updatedAt, t.id),
  }),
);

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

/**
 * 行业 / 概念目录。内部 id 是本地生成的不透明标识，vendor_code 只用于外部请求与溯源；
 * (source, kind, vendor_code) 唯一，重复同步只会更新观测时间而不会产生新身份。
 */
export const sectorCatalogEntries = sqliteTable(
  'sector_catalog_entries',
  {
    id: text('id').primaryKey(),
    kind: text('kind').$type<SectorKind>().notNull(),
    source: text('source').notNull(),
    vendorCode: text('vendor_code').notNull(),
    name: text('name').notNull(),
    state: text('state').$type<SectorCatalogState>().notNull(),
    firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull(),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
    retiredAt: integer('retired_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    vendorUnique: uniqueIndex('sector_catalog_entries_vendor_unique').on(
      t.source,
      t.kind,
      t.vendorCode,
    ),
    kindStateIdx: index('sector_catalog_entries_kind_state_idx').on(t.kind, t.state),
  }),
);

/** 成分多对多；成员消失只标记 missing，不删除关系与首次观测时间。 */
export const sectorMemberships = sqliteTable(
  'sector_memberships',
  {
    sectorId: text('sector_id').notNull(),
    stockId: text('stock_id').notNull(),
    source: text('source').notNull(),
    state: text('state').$type<SectorMembershipState>().notNull(),
    memberStatus: text('member_status').$type<SectorMemberStatus>().notNull(),
    firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull(),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
    missingSince: integer('missing_since', { mode: 'timestamp_ms' }),
    lastSyncId: text('last_sync_id').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sectorId, t.stockId], name: 'sector_memberships_pk' }),
    stockStateIdx: index('sector_memberships_stock_state_idx').on(t.stockId, t.state),
    sectorStateIdx: index('sector_memberships_sector_state_idx').on(t.sectorId, t.state),
  }),
);

/** 目录与成分变更 append-only；不覆盖历史，也不因再次观测相同事实而重复写入。 */
export const sectorChangeEvents = sqliteTable(
  'sector_change_events',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    sectorId: text('sector_id').notNull(),
    stockId: text('stock_id'),
    kind: text('kind').$type<SectorChangeKind>().notNull(),
    occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull(),
    syncId: text('sync_id').notNull(),
    previousValue: text('previous_value'),
    nextValue: text('next_value'),
  },
  (t) => ({
    sectorIdx: index('sector_change_events_sector_idx').on(t.sectorId, t.seq),
    stockIdx: index('sector_change_events_stock_idx').on(t.stockId, t.seq),
  }),
);

/** 一次同步的审计与幂等凭据；同一 id 重放返回原摘要。 */
export const sectorSyncRuns = sqliteTable(
  'sector_sync_runs',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    status: text('status').$type<SectorSyncStatus>().notNull(),
    appliedAt: integer('applied_at', { mode: 'timestamp_ms' }).notNull(),
    observedSectors: integer('observed_sectors').notNull().default(0),
    createdSectors: integer('created_sectors').notNull().default(0),
    renamedSectors: integer('renamed_sectors').notNull().default(0),
    retiredSectors: integer('retired_sectors').notNull().default(0),
    observedStocks: integer('observed_stocks').notNull().default(0),
    createdMemberships: integer('created_memberships').notNull().default(0),
    removedMemberships: integer('removed_memberships').notNull().default(0),
    reactivatedMemberships: integer('reactivated_memberships').notNull().default(0),
    failures: text('failures_json', { mode: 'json' }).$type<SectorSyncFailure[]>().notNull(),
  },
  (t) => ({
    sourceAppliedIdx: index('sector_sync_runs_source_applied_idx').on(t.source, t.appliedAt),
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

/**
 * 按采样时点保存的天梯事实（ticket #41）：同一天可有多份，用于还原开板 / 换位时间线。
 * sampledAt 对齐盘中批次间隔；同 (trading_date, source, sampled_at) 重试幂等。
 */
export const limitUpLadderSamples = sqliteTable(
  'limit_up_ladder_samples',
  {
    id: text('id').primaryKey(),
    tradingDate: text('trading_date').notNull(),
    source: text('source').$type<LimitUpLadderSource>().notNull(),
    sampledAt: integer('sampled_at', { mode: 'timestamp_ms' }).notNull(),
    total: integer('total').notNull(),
    maxLevel: integer('max_level').notNull(),
    levels: text('levels_json', { mode: 'json' }).$type<LimitUpLadder['levels']>().notNull(),
    warnings: text('warnings_json', { mode: 'json' })
      .$type<LimitUpLadderSample['warnings']>()
      .notNull(),
    asOf: integer('as_of', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    sourceDateSampledIdx: index('limit_up_ladder_samples_source_date_sampled_idx').on(
      t.source,
      t.tradingDate,
      t.sampledAt,
    ),
  }),
);

/**
 * 盘中全市场批次（ticket #35）：一次采集 = 一行不可变快照。
 * id 由 coverage + 对齐后的 sampledAt 派生，主键冲突即“同批次重试”，保留首次发布内容。
 */
export const marketSnapshotBatches = sqliteTable(
  'market_snapshot_batches',
  {
    id: text('id').primaryKey(),
    coverage: text('coverage').$type<MarketCoverage>().notNull(),
    tradingDate: text('trading_date').notNull(),
    sampledAt: integer('sampled_at', { mode: 'timestamp_ms' }).notNull(),
    source: text('source').notNull(),
    fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).notNull(),
    observedAt: integer('observed_at', { mode: 'timestamp_ms' }),
    dataAsOf: integer('data_as_of', { mode: 'timestamp_ms' }),
    completeness: text('completeness_json', { mode: 'json' })
      .$type<MarketSnapshotCompleteness>()
      .notNull(),
    gaps: text('gaps_json', { mode: 'json' }).$type<string[]>().notNull(),
    items: text('items_json', { mode: 'json' }).$type<MarketSnapshotItem[]>().notNull(),
  },
  (t) => ({
    coverageSampledIdx: index('market_snapshot_batches_coverage_sampled_idx').on(
      t.coverage,
      t.sampledAt,
    ),
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
  adviceId: text('advice_id'),
  strategyVersionId: text('strategy_version_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

/**
 * 账户资金与权益流水（§6：holding_cash_adjustments + portfolio_cash_flows +
 * portfolio_corporate_actions 合并为单表，entry_kind 区分事实类型）。
 * 旧表不再创建；存量库由启动迁移把数据搬入本表，旧表保留不 DROP。
 */
export const accountLedgerEntries = sqliteTable(
  'account_ledger_entries',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    /** 'holding-adjustment' | 'cash-flow' | 'corporate-action' */
    entryKind: text('entry_kind').notNull(),
    occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull(),
    /** holding-adjustment 与 cash-flow 的金额；corporate-action 为空。 */
    amount: real('amount'),
    /** cash-flow 币种；其它类型为空。 */
    currency: text('currency'),
    holdingId: text('holding_id'),
    stockId: text('stock_id'),
    quantityDelta: integer('quantity_delta'),
    /** cash-flow 类型：deposit/withdrawal/... */
    flowKind: text('flow_kind'),
    /** corporate-action 类型：split/bonus/dividend */
    actionKind: text('action_kind'),
    ratio: real('ratio'),
    cashPerShare: real('cash_per_share'),
    source: text('source'),
    note: text('note'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    accountOccurredIdx: index('account_ledger_entries_account_occurred_idx').on(
      t.accountId,
      t.occurredAt,
    ),
    stockOccurredIdx: index('account_ledger_entries_stock_occurred_idx').on(
      t.stockId,
      t.occurredAt,
    ),
    kindIdx: index('account_ledger_entries_kind_idx').on(t.entryKind),
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
    entryPrice: real('entry_price').$type<Money>(),
    entryPriceLow: real('entry_price_low').$type<Money>(),
    entryPriceHigh: real('entry_price_high').$type<Money>(),
    targetPositionPct: real('target_position_pct'),
    targetPrice: real('target_price').$type<Money>(),
    stopLoss: real('stop_loss').$type<Money>(),
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
export const adviceOutcomes = sqliteTable(
  'advice_outcomes',
  {
    adviceId: text('advice_id').primaryKey(),
    tradeIds: text('trade_ids', { mode: 'json' }).$type<readonly string[]>().notNull(),
    outcome: text('outcome').$type<'followed' | 'partially_followed' | 'ignored'>().notNull(),
    pnl: real('pnl').$type<Money>(),
    benchmarkPnl: real('benchmark_pnl').$type<Money>(),
    holdingHours: real('holding_hours'),
    notes: text('notes'),
    recordedAt: integer('recorded_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    recordedAtIdx: index('advice_outcomes_recorded_at_idx').on(t.recordedAt),
  }),
);

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
    totalShares: real('total_shares'),
    floatShares: real('float_shares'),
    totalMarketCap: real('total_market_cap'),
    floatMarketCap: real('float_market_cap'),
    peDynamic: real('pe_dynamic'),
    peTtm: real('pe_ttm'),
    peStatic: real('pe_static'),
    psTtm: real('ps_ttm'),
    pb: real('pb'),
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

/** 独立分钟 OHLCV；不复用 price_snapshots，价格口径固定为 provider raw。 */
export const minuteBars = sqliteTable(
  'minute_bars',
  {
    stockId: text('stock_id').notNull(),
    interval: text('interval').$type<MinuteBarInterval>().notNull(),
    endedAt: integer('ended_at', { mode: 'timestamp_ms' }).notNull(),
    open: real('open').$type<Money>().notNull(),
    high: real('high').$type<Money>().notNull(),
    low: real('low').$type<Money>().notNull(),
    close: real('close').$type<Money>().notNull(),
    volume: integer('volume').notNull(),
    amount: real('amount'),
    adjustment: text('adjustment').$type<'raw'>().notNull(),
    source: text('source').notNull(),
    fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).notNull(),
    completeness: text('completeness').$type<MinuteBarCompleteness>().notNull(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.stockId, t.interval, t.endedAt],
      name: 'minute_bars_pk',
    }),
    stockIntervalEndedIdx: index('minute_bars_stock_interval_ended_idx').on(
      t.stockId,
      t.interval,
      t.endedAt,
    ),
    endedIdx: index('minute_bars_ended_idx').on(t.endedAt),
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
    /** 自动运行 cron；NULL 表示未启用调度。 */
    scheduleCron: text('schedule_cron'),
    /** 最近一次调度运行时间。 */
    lastScheduledAt: integer('last_scheduled_at', { mode: 'timestamp_ms' }),
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
    /** §6：strategy_results 并入 strategy_runs.results_json（逐股明细）。 */
    resultsJson: text('results_json', { mode: 'json' }).$type<
      readonly Readonly<Record<string, unknown>>[]
    >(),
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

export const strategyBacktestRuns = sqliteTable(
  'strategy_backtest_runs',
  {
    id: text('id').primaryKey(),
    strategyId: text('strategy_id').notNull(),
    strategyVersionId: text('strategy_version_id').notNull(),
    status: text('status').$type<StrictBacktestRun['status']>().notNull(),
    resultAvailability: text('result_availability')
      .$type<StrictBacktestRun['resultAvailability']>()
      .notNull(),
    spec: text('spec_json', { mode: 'json' }).$type<StrictBacktestSpec>().notNull(),
    specHash: text('spec_hash').notNull(),
    inputFingerprint: text('input_fingerprint').notNull(),
    evaluator: text('evaluator_json', { mode: 'json' })
      .$type<StrategyEvaluatorIdentity>()
      .notNull(),
    gateAudit: text('gate_audit_json', { mode: 'json' }).$type<StrictBacktestGateAudit>().notNull(),
    metrics: text('metrics_json', { mode: 'json' }).$type<StrictBacktestMetrics>(),
    error: text('error'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    strategyCreatedIdx: index('strategy_backtest_runs_strategy_created_idx').on(
      t.strategyId,
      t.createdAt,
    ),
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
    investmentBinding: text('investment_binding_json', { mode: 'json' }).$type<
      StrategyWatchlistSubscription['investmentBinding']
    >(),
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
    ownerUserId: text('owner_user_id'),
    importBatchId: text('import_batch_id'),
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
    /** 存量 event-date 触发关联的公司事件 id（新触发为空，仅读兼容）。 */
    eventId: text('event_id'),
    deliveryAttempts: integer('delivery_attempts'),
    lastDeliveryAttemptAt: integer('last_delivery_attempt_at', { mode: 'timestamp_ms' }),
    deliveryCompletedAt: integer('delivery_completed_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    createdIdIdx: index('watch_triggers_created_id_idx').on(t.createdAt, t.id),
    stockCreatedIdIdx: index('watch_triggers_stock_created_id_idx').on(
      t.stockId,
      t.createdAt,
      t.id,
    ),
    /** cooldown 查询 lastForKey 走这条。 */
    poolStockRuleTsIdx: index('watch_triggers_pool_stock_rule_ts_idx').on(
      t.poolId,
      t.stockId,
      t.ruleId,
      t.createdAt,
    ),
    /** listByPool 按时间倒序走这条。 */
    poolTsIdx: index('watch_triggers_pool_ts_idx').on(t.poolId, t.createdAt),
    /** 存量 event-date 触发的按事件过滤走这条。 */
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
    stockCodes: text('stock_codes', { mode: 'json' })
      .$type<readonly string[]>()
      .notNull()
      .default([]),
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
// FTS5 virtual table is created by ensureSchema; this declaration only supplies
// Drizzle's typed query surface and does not create a second ordinary table.
export const researchDocumentFts = sqliteTable('research_document_fts', {
  documentId: text('document_id').notNull(),
  contentHash: text('content_hash').notNull(),
  title: text('title').notNull(),
  tags: text('tags').notNull(),
  relativePath: text('relative_path').notNull(),
  excerpt: text('excerpt').notNull(),
  body: text('body').notNull(),
});

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
    version: integer('version').notNull().default(1),
    supersedesReportId: text('supersedes_report_id'),
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
    notificationPolicy: text('notification_policy').$type<Report['notificationPolicy']>(),
    watchlistFactsSnapshot: text('watchlist_facts_snapshot', { mode: 'json' }).$type<
      Report['watchlistFactsSnapshot']
    >(),
    decisionReviewFingerprint: text('decision_review_fingerprint'),
    deliveryAttemptId: text('delivery_attempt_id'),
    workflowRunId: text('workflow_run_id').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    periodVersionUnique: uniqueIndex('reports_period_version_unique').on(
      t.kind,
      t.scopeKey,
      t.periodStart,
      t.periodEnd,
      t.version,
    ),
    periodEndIdx: index('reports_period_end_idx').on(t.periodEnd),
    kindPeriodEndIdx: index('reports_kind_period_end_idx').on(t.kind, t.periodEnd),
    statusPeriodEndIdx: index('reports_status_period_end_idx').on(t.status, t.periodEnd),
    workflowRunIdx: index('reports_workflow_run_idx').on(t.workflowRunId),
  }),
);

/** 逐股结构化交易计划的不可变版本；plan_json 是唯一完整领域载荷。 */
export const tradingPlans = sqliteTable(
  'trading_plans',
  {
    versionId: text('version_id').primaryKey(),
    planId: text('plan_id').notNull(),
    version: integer('version').notNull(),
    accountId: text('account_id').notNull(),
    stockId: text('stock_id').notNull(),
    status: text('status').$type<TradingPlan['status']>().notNull(),
    validFrom: integer('valid_from', { mode: 'timestamp_ms' }).notNull(),
    validUntil: integer('valid_until', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    plan: text('plan_json', { mode: 'json' }).$type<TradingPlan>().notNull(),
  },
  (t) => ({
    planVersionUnique: uniqueIndex('trading_plans_plan_version_unique').on(t.planId, t.version),
    accountStockStatusIdx: index('trading_plans_account_stock_status_idx').on(
      t.accountId,
      t.stockId,
      t.status,
    ),
    createdAtIdx: index('trading_plans_created_at_idx').on(t.createdAt),
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
  decisionReviews,
  stocks,
  stockUniverseMemberships,
  stockUniverseSyncRuns,
  sectorCatalogEntries,
  sectorMemberships,
  sectorChangeEvents,
  sectorSyncRuns,
  limitUpLadderSnapshots,
  limitUpLadderSamples,
  marketSnapshotBatches,
  holdings,
  trades,
  accountLedgerEntries,
  portfolioPerformanceSnapshots,
  advices,
  adviceOutcomes,
  priceSnapshots,
  dailyBars,
  minuteBars,
  dailyBarRevisions,
  strategies,
  strategyVersions,
  strategyRuns,
  strategySignals,
  strategyBacktestRuns,
  signalObservations,
  notifications,
  // v0.6 起
  alertPlans,
  watchTriggers,
  // v0.7 起：边沿状态机
  watchRuleStates,
  watchlists,
  watchlistMembers,
  watchlistMemberSources,
  // ruo 迁移起（docs/ddd/ruo-feature-migration-detailed-design.md §3）
  researchDocumentIndex,
  researchDocumentFts,
  workflowRuns,
  reports,
  tradingPlans,
  chatSessions,
  chatMessages,
} as const;

export type Schema = typeof schema;
