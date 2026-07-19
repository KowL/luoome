import type {
  AccountKind,
  AdviceDataSnapshot,
  AdviceDecision,
  AdviceHorizon,
  AdviceReasoning,
  AdviceSubjectKind,
  Exchange,
  Money,
  Notification,
  Quantity,
  StockCode,
  Tactic,
  TradeSide,
  TradeSource,
} from '@luoome/core';
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
  },
  (t) => ({
    /** 同一交易所内代码唯一；跨交易所代码可重复（如 SH/SZ 都有 000001）。 */
    codeExchangeUnique: uniqueIndex('stocks_code_exchange_unique').on(t.code, t.exchange),
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
    ts: integer('ts', { mode: 'timestamp_ms' }).notNull(),
    open: real('open').$type<Money>().notNull(),
    high: real('high').$type<Money>().notNull(),
    low: real('low').$type<Money>().notNull(),
    close: real('close').$type<Money>().notNull(),
    volume: integer('volume').notNull(),
    source: text('source').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.stockId, t.ts], name: 'price_snapshots_pk' }),
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
    adjFactor: real('adj_factor').notNull(),
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

export const schema = {
  accounts,
  stocks,
  holdings,
  trades,
  advices,
  adviceOutcomes,
  priceSnapshots,
  dailyBars,
  tactics,
  tacticSignals,
  notifications,
} as const;

export type Schema = typeof schema;
