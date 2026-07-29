import type {
  AccountKind,
  AdviceDataSnapshot,
  AdviceDecision,
  AdviceHorizon,
  AdviceReasoning,
  AdviceSubjectKind,
  ChatMessagePart,
  Citation,
  Exchange,
  ListingStatus,
  MarketCoverage,
  Money,
  Notification,
  ProviderStatus,
  Quantity,
  ResearchNote,
  StockCode,
  StockEvent,
  StockGroup,
  StockPool,
  Tactic,
  TradeSide,
  TradeSource,
  WatchRule,
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

/**
 * 战法定义（v0.3 起）。
 * - builtin 战法由 TACTIC_BUILTIN_DEFINED_AT 固化的 definedAt 标识，不被覆盖；
 * - user 战法由用户在 ~/.luoome/tactics/*.yml 落盘后通过 save_user_tactic 写入。
 */
export const tactics = sqliteTable(
  'tactics',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    tag: text('tag').$type<Tactic['tag']>().notNull(),
    description: text('description').notNull(),
    triggerWhen: text('trigger_when').notNull(),
    scoreExpression: text('score_expression').notNull(),
    direction: text('direction').$type<Tactic['direction']>().notNull(),
    /** evidenceTemplate 走 text + mode 'json'（字符串数组）。 */
    evidenceTemplate: text('evidence_template', { mode: 'json' })
      .$type<readonly string[]>()
      .notNull(),
    source: text('source').$type<Tactic['source']>().notNull(),
    definedAt: integer('defined_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    /** tag 索引：list_tactics 按 tag 过滤走索引。 */
    tagIdx: index('tactics_tag_idx').on(t.tag),
    sourceIdx: index('tactics_source_idx').on(t.source),
  }),
);

/**
 * 战法信号历史（v0.3 起）。
 * 写多读多：run_tactic 写入，tactic-scan workflow / 复盘页查询。
 */
export const tacticSignals = sqliteTable(
  'tactic_signals',
  {
    id: text('id').primaryKey(),
    tacticId: text('tactic_id').notNull(),
    tacticName: text('tactic_name').notNull(),
    tacticTag: text('tactic_tag').$type<Tactic['tag']>().notNull(),
    stockId: text('stock_id').notNull(),
    ts: integer('ts', { mode: 'timestamp_ms' }).notNull(),
    score: real('score').notNull(),
    direction: text('direction').$type<Tactic['direction']>().notNull(),
    /** evidence 走 text + mode 'json'（字符串数组）。 */
    evidence: text('evidence', { mode: 'json' }).$type<readonly string[]>().notNull(),
    /** triggerSnapshot 可选（{ expression, result }）。 */
    triggerSnapshot: text('trigger_snapshot', { mode: 'json' }).$type<
      { readonly expression: string; readonly result: boolean } | undefined
    >(),
  },
  (t) => ({
    /** 按 tacticId + ts 倒序：signalsByTactic 查询走索引。 */
    tacticTsIdx: index('tactic_signals_tactic_ts_idx').on(t.tacticId, t.ts),
    /** 按 stockId + ts 倒序：signalsByStock 查询走索引。 */
    stockTsIdx: index('tactic_signals_stock_ts_idx').on(t.stockId, t.ts),
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

/**
 * 股票池（v0.6 起，docs/ddd/intraday-watch-design.md §3；
 * 分组化改造 docs/ddd/stock-group-design.md §3/§5；
 * 策略预警扩展 docs/ddd/strategy-alert-detailed-design.md §3）。
 *
 * rules 走 text + mode 'json'（discriminated union）；enabled 用 0/1 integer。
 * - source：@deprecated 旧 PoolSource JSON。新行恒为 NULL；旧行数据原样保留
 * - groupId：成员分组引用（stock_groups.id）；旧行迁移前为 NULL
 * - logic / triggerMode / priority / dailyNotificationLimit / notifyOnRecovery：
 *   v0.7 策略预警新增。启动迁移补齐；旧行 logic / triggerMode 设为默认 'ANY' / 'on-enter'，
 *   dailyNotificationLimit 默认 20，notifyOnRecovery 默认 0。priority 老行为无对应字段（NULL）。
 */
export const stockPools = sqliteTable(
  'stock_pools',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    source: text('source', { mode: 'json' }).$type<unknown>(),
    groupId: text('group_id'),
    rules: text('rules', { mode: 'json' }).$type<StockPool['rules']>().notNull(),
    cooldownMinutes: integer('cooldown_minutes').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    logic: text('logic').$type<StockPool['logic']>().notNull(),
    triggerMode: text('trigger_mode').$type<StockPool['triggerMode']>().notNull(),
    priority: text('priority').$type<NonNullable<StockPool['priority']>>(),
    dailyNotificationLimit: integer('daily_notification_limit').notNull(),
    notifyOnRecovery: integer('notify_on_recovery', { mode: 'boolean' }).notNull(),
  },
  (t) => ({
    /** list(enabledOnly=true) 走索引。 */
    enabledIdx: index('stock_pools_enabled_idx').on(t.enabled),
  }),
);

/**
 * 股票分组（分组化起，docs/ddd/stock-group-design.md §3）。
 * resolver 走 text + mode 'json'（discriminated union）；enabled 用 0/1 integer。
 */
export const stockGroups = sqliteTable(
  'stock_groups',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    resolver: text('resolver', { mode: 'json' }).$type<StockGroup['resolver']>().notNull(),
    refreshPolicy: text('refresh_policy').$type<StockGroup['refreshPolicy']>().notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    /** list(enabledOnly=true) 走索引。 */
    enabledIdx: index('stock_groups_enabled_idx').on(t.enabled),
  }),
);

/**
 * 分组成员快照（分组化起，docs/ddd/stock-group-design.md §3）。
 * 只增不改：一次刷新 = 一批（同一 refreshId）；当前成员 = 最新 refreshId 那一批。
 */
export const groupMemberSnapshots = sqliteTable(
  'group_member_snapshots',
  {
    id: text('id').primaryKey(),
    groupId: text('group_id').notNull(),
    stockId: text('stock_id').notNull(),
    refreshId: text('refresh_id').notNull(),
    reason: text('reason').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    /** currentMembers（查最新批次）走这条。 */
    groupRefreshIdx: index('group_members_group_refresh_idx').on(t.groupId, t.refreshId),
    /** listHistory（历史 / 复盘）走这条。 */
    groupTsIdx: index('group_members_group_ts_idx').on(t.groupId, t.createdAt),
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
    poolId: text('pool_id').notNull(),
    stockId: text('stock_id').notNull(),
    ruleKind: text('rule_kind').$type<WatchRule['kind']>().notNull(),
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

/**
 * 研究档案笔记（ruo 迁移 Phase 1A，docs/ddd/ruo-feature-migration-detailed-design.md §3.1）。
 * citations 走 text + mode 'json'；tags 走 text + mode 'json'（字符串数组）。
 */
export const researchNotes = sqliteTable(
  'research_notes',
  {
    id: text('id').primaryKey(),
    stockId: text('stock_id').notNull(),
    kind: text('kind').$type<ResearchNote['kind']>().notNull(),
    title: text('title'),
    content: text('content').notNull(),
    stance: text('stance').$type<NonNullable<ResearchNote['stance']>>(),
    active: integer('active', { mode: 'boolean' }).notNull(),
    supersedesId: text('supersedes_id'),
    sourceUrl: text('source_url'),
    sourceTitle: text('source_title'),
    sourceStatus: text('source_status').$type<NonNullable<ResearchNote['sourceStatus']>>(),
    fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }),
    citations: text('citations', { mode: 'json' }).$type<readonly Citation[]>(),
    relatedHoldingId: text('related_holding_id'),
    relatedAdviceId: text('related_advice_id'),
    relatedWatchTriggerId: text('related_watch_trigger_id'),
    tags: text('tags', { mode: 'json' }).$type<readonly string[]>().notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    stockCreatedIdx: index('research_notes_stock_created_idx').on(t.stockId, t.createdAt),
    stockKindActiveIdx: index('research_notes_stock_kind_active_idx').on(
      t.stockId,
      t.kind,
      t.active,
    ),
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
  accounts,
  stocks,
  stockUniverseMemberships,
  stockUniverseSyncRuns,
  holdings,
  trades,
  advices,
  adviceOutcomes,
  priceSnapshots,
  dailyBars,
  tactics,
  tacticSignals,
  notifications,
  // v0.6 起
  stockPools,
  watchTriggers,
  // v0.7 起：边沿状态机
  watchRuleStates,
  watchRuns,
  // 分组化起（docs/ddd/stock-group-design.md §3）
  stockGroups,
  groupMemberSnapshots,
  // ruo 迁移起（docs/ddd/ruo-feature-migration-detailed-design.md §3）
  researchNotes,
  stockEvents,
  workflowRuns,
  chatSessions,
  chatMessages,
} as const;

export type Schema = typeof schema;
