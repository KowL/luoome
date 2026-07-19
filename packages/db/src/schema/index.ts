import type {
  AccountKind,
  AdviceDataSnapshot,
  AdviceDecision,
  AdviceHorizon,
  AdviceReasoning,
  AdviceSubjectKind,
  Exchange,
  Money,
  Quantity,
  StockCode,
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

export const schema = {
  accounts,
  stocks,
  holdings,
  trades,
  advices,
  adviceOutcomes,
  priceSnapshots,
  dailyBars,
} as const;

export type Schema = typeof schema;
