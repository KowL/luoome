import { Database, type SQLQueryBindings } from 'bun:sqlite';
import {
  AccountSchema,
  AdviceOutcomeSchema,
  AdviceSchema,
  AlertPlanSchema,
  assertAccountInvariants,
  assertAdviceInvariants,
  assertAlertPlanInvariants,
  assertChatMessageInvariants,
  assertChatSessionInvariants,
  assertHoldingInvariants,
  assertNotificationInvariants,
  assertReportInvariants,
  assertSignalObservationInvariants,
  assertStockEventInvariants,
  assertStockInvariants,
  assertStrategyAutonomyActionInvariants,
  assertStrategyInvariants,
  assertStrategyRunInvariants,
  assertStrategyScheduleInvariants,
  assertStrategyVersionInvariants,
  assertStrategyWatchlistSubscriptionInvariants,
  assertTradeInvariants,
  assertTradingPlanInvariants,
  assertWatchlistInvariants,
  assertWatchlistMemberInvariants,
  assertWatchlistMemberSourceInvariants,
  assertWatchlistSyncRunInvariants,
  assertWatchRunInvariants,
  assertWatchTriggerInvariants,
  assertWorkflowRunInvariants,
  ChatMessageSchema,
  ChatSessionSchema,
  DailyBarSchema,
  DecisionReviewContentSchema,
  DecisionReviewContextSchema,
  DecisionReviewRevisionSchema,
  DecisionReviewSchema,
  DecisionTradeCommitResultSchema,
  HoldingCashAdjustmentSchema,
  HoldingSchema,
  LimitUpLadderSchema,
  MembershipSnapshotSchema,
  NotificationSchema,
  PortfolioCashFlowSchema,
  PortfolioCorporateActionSchema,
  QuoteSchema,
  ReportSchema,
  ResearchDocumentChunkSchema,
  ResearchDocumentIndexSchema,
  ResearchSubjectLinkSchema,
  ResearchTopicDocumentSchema,
  ResearchTopicIndexSchema,
  ResearchVaultSyncRunSchema,
  SignalObservationSchema,
  StockEventSchema,
  StockSchema,
  StrategyAutonomyActionSchema,
  StrategyResultSchema,
  StrategyRunSchema,
  StrategyScheduleSchema,
  StrategySchema,
  StrategySignalSchema,
  StrategyVersionSchema,
  StrategyWatchlistSubscriptionSchema,
  TradeSchema,
  TradingPlanSchema,
  tradingPlanVersionId,
  WatchlistMemberSchema,
  WatchlistMemberSourceSchema,
  WatchlistSchema,
  WatchlistSyncRunSchema,
  WatchRuleStateSchema,
  WatchRunSchema,
  WatchTriggerSchema,
  WorkflowRunSchema,
} from '@luoome/core';
import { createDrizzleRepos } from '@luoome/db';
import { z } from 'zod';

export const DATA_TRANSFER_CATEGORIES = [
  'portfolio',
  'strategies',
  'watchlists',
  'advice-reports',
  'market-data',
  'research',
  'chat',
] as const;

export type DataTransferCategory = (typeof DATA_TRANSFER_CATEGORIES)[number];

const CATEGORY_TABLES: Readonly<Record<DataTransferCategory, readonly string[]>> = {
  portfolio: [
    'accounts',
    'stocks',
    'holdings',
    'trades',
    'portfolio_cash_flows',
    'holding_cash_adjustments',
    'portfolio_corporate_actions',
  ],
  strategies: [
    'stocks',
    'strategies',
    'strategy_versions',
    'strategy_runs',
    'strategy_results',
    'strategy_signals',
    'strategy_schedules',
    'strategy_watchlist_subscriptions',
    'strategy_autonomy_actions',
  ],
  watchlists: [
    'stocks',
    'watchlists',
    'strategy_watchlist_subscriptions',
    'watchlist_members',
    'watchlist_member_sources',
    'watchlist_sync_runs',
    'membership_snapshots',
    'alert_plans',
    'watch_triggers',
    'watch_rule_states',
    'watch_runs',
  ],
  'advice-reports': [
    'advices',
    'advice_outcomes',
    'decision_reviews',
    'decision_review_revisions',
    'decision_review_trade_links',
    'decision_write_receipts',
    'reports',
    'report_refresh_receipts',
    'notifications',
    'signal_observations',
    'workflow_runs',
    'trading_plans',
  ],
  'market-data': [
    'stocks',
    'stock_universe_memberships',
    'stock_universe_sync_runs',
    'price_snapshots',
    'daily_bars',
    'limit_up_ladder_snapshots',
    'stock_events',
  ],
  research: [
    'research_topic_index',
    'research_document_index',
    'research_topic_documents',
    'research_subject_links',
    'research_document_chunks',
    'research_document_fts',
    'research_vault_sync_runs',
  ],
  chat: ['chat_sessions', 'chat_messages'],
};

const IMPORT_ORDER = [...new Set(DATA_TRANSFER_CATEGORIES.flatMap((key) => CATEGORY_TABLES[key]))];
const ALLOWED_TABLES = new Set(IMPORT_ORDER);
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const isBinding = (value: unknown): value is SQLQueryBindings =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'bigint' ||
  typeof value === 'boolean' ||
  ArrayBuffer.isView(value);

const BOOLEAN_COLUMNS = new Set([
  'active',
  'all_day',
  'enabled',
  'notify_on_recovery',
  'selected',
  'stale',
]);
const JSON_COLUMNS = new Set([
  'attachment_paths',
  'based_on',
  'details_json',
  'disclaimers',
  'evidence',
  'eval_snapshot',
  'input_summary',
  'metadata',
  'output_summary',
  'parts',
  'payload',
  'provenance',
  'provider_statuses',
  'reasoning',
  'remind_before_days',
  'risks',
  'rules',
  'tags',
  'trade_ids',
]);

const snakeToCamel = (value: string): string =>
  value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

const decodeStorageRow = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(row).map(([storageKey, value]) => {
      const logicalKey = storageKey.endsWith('_json') ? storageKey.slice(0, -5) : storageKey;
      const key = snakeToCamel(logicalKey);
      if (BOOLEAN_COLUMNS.has(storageKey)) {
        if (value !== 0 && value !== 1 && typeof value !== 'boolean') {
          throw new Error(`${storageKey} 必须是 0/1`);
        }
        return [key, Boolean(value)];
      }
      if ((storageKey.endsWith('_json') || JSON_COLUMNS.has(storageKey)) && value !== null) {
        if (typeof value !== 'string') throw new Error(`${storageKey} 必须是 JSON 字符串`);
        return [key, JSON.parse(value)];
      }
      return [key, value];
    }),
  );

const omitNulls = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));

const validateTradingPlanStorageRow = (row: Record<string, unknown>): void => {
  const rawPlan = row.plan_json;
  const planValue =
    typeof rawPlan === 'string'
      ? JSON.parse(rawPlan)
      : rawPlan !== null && typeof rawPlan === 'object'
        ? rawPlan
        : undefined;
  const plan = TradingPlanSchema.parse(planValue);
  assertTradingPlanInvariants(plan);
  const metadata: Readonly<Record<string, unknown>> = {
    version_id: row.version_id,
    plan_id: row.plan_id,
    version: row.version,
    account_id: row.account_id,
    stock_id: row.stock_id,
    status: row.status,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    created_at: row.created_at,
  };
  const expected: Readonly<Record<string, unknown>> = {
    version_id: tradingPlanVersionId(plan),
    plan_id: plan.id,
    version: plan.version,
    account_id: plan.accountId,
    stock_id: plan.stockId,
    status: plan.status,
    valid_from: plan.validFrom.getTime(),
    valid_until: plan.validUntil.getTime(),
    created_at: plan.createdAt.getTime(),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (metadata[key] !== value) {
      throw new Error(`trading_plans ${key} 与 plan_json 元数据不一致`);
    }
  }
};

type DomainValidator = (row: Record<string, unknown>) => void;
const domainValidator = (
  schema: z.ZodType,
  assertion?: (value: never) => void,
  normalize: (row: Record<string, unknown>) => Record<string, unknown> = omitNulls,
): DomainValidator => {
  return (row) => {
    const value = schema.parse(normalize(decodeStorageRow(row)));
    assertion?.(value as never);
  };
};

const stockUniverseMembershipSchema = z.object({
  source: z.string().min(1),
  coverage: z.enum(['CN_A_SHARES_SH_SZ', 'CN_A_SHARES_BJ', 'HK_EQUITIES', 'US_EQUITIES']),
  stockId: z.string().min(1),
  observedName: z.string().min(1),
  listingStatus: z.enum(['listed', 'suspended', 'delisted', 'unknown']),
  state: z.enum(['active', 'missing']),
  firstSeenAt: z.coerce.date(),
  lastSeenAt: z.coerce.date(),
  missingSince: z.coerce.date().optional(),
  lastSyncId: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const stockUniverseSyncRunSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  coverage: z.enum(['CN_A_SHARES_SH_SZ', 'CN_A_SHARES_BJ', 'HK_EQUITIES', 'US_EQUITIES']),
  status: z.enum(['running', 'succeeded', 'failed']),
  startedAt: z.coerce.date(),
  finishedAt: z.coerce.date().optional(),
  observedAt: z.coerce.date().optional(),
  reportedTotal: z.number().int().nonnegative().optional(),
  observedCount: z.number().int().nonnegative(),
  createdStocks: z.number().int().nonnegative(),
  updatedStocks: z.number().int().nonnegative(),
  reactivated: z.number().int().nonnegative(),
  markedMissing: z.number().int().nonnegative(),
  errorKind: z.string().optional(),
  errorMessage: z.string().optional(),
});
const researchDocumentFtsSchema = z.object({
  documentId: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string(),
  headingPath: z.string(),
  body: z.string(),
});

const decisionReviewStorageSchema = z.object({
  id: z.string().min(1),
  account_id: z.string().min(1),
  subject_kind: z.enum(['advice', 'trading-plan-version', 'watch-trigger']),
  subject_id: z.string().min(1),
  stock_id: z.string().nullable(),
  source_occurred_at: z.number().int(),
  context_json: z.string(),
  context_hash: z.string().min(1),
  current_revision: z.number().int().positive(),
  created_at: z.number().int(),
});
const validateDecisionReviewStorageRow: DomainValidator = (row) => {
  const parsed = decisionReviewStorageSchema.parse(row);
  const context = DecisionReviewContextSchema.parse(JSON.parse(parsed.context_json));
  if (context.contextHash !== parsed.context_hash) throw new Error('context_hash 与快照不一致');
  DecisionReviewSchema.parse({
    id: parsed.id,
    accountId: parsed.account_id,
    subject: { kind: parsed.subject_kind, id: parsed.subject_id },
    stockId: parsed.stock_id,
    sourceOccurredAt: parsed.source_occurred_at,
    context,
    currentRevision: parsed.current_revision,
    createdAt: parsed.created_at,
  });
};
const validateDecisionRevisionStorageRow: DomainValidator = (row) => {
  const parsed = z
    .object({
      sequence: z.number().int().positive(),
      review_id: z.string().min(1),
      revision: z.number().int().positive(),
      content_json: z.string(),
      content_hash: z.string().min(1),
      trade_fact_hashes_json: z.string(),
      recorded_at: z.number().int(),
      change_note: z.string().nullable(),
    })
    .parse(row);
  const content = DecisionReviewContentSchema.parse(JSON.parse(parsed.content_json));
  DecisionReviewRevisionSchema.parse({
    reviewId: parsed.review_id,
    revision: parsed.revision,
    sequence: parsed.sequence,
    content,
    contentHash: parsed.content_hash,
    tradeFactHashes: JSON.parse(parsed.trade_fact_hashes_json),
    recordedAt: parsed.recorded_at,
    changeNote: parsed.change_note,
  });
};
const validateDecisionTradeLinkStorageRow: DomainValidator = (row) => {
  z.object({
    review_id: z.string().min(1),
    account_id: z.string().min(1),
    trade_id: z.string().min(1),
    revision: z.number().int().positive(),
  }).parse(row);
};
const validateDecisionReceiptStorageRow: DomainValidator = (row) => {
  const parsed = z
    .object({
      account_id: z.string().min(1),
      request_id: z.uuid(),
      command: z.enum(['save_decision_review', 'record_decision_trade']),
      request_hash: z.string().min(1),
      result_json: z.string(),
      committed_at: z.number().int(),
    })
    .parse(row);
  const result: unknown = JSON.parse(parsed.result_json);
  if (parsed.command === 'record_decision_trade') DecisionTradeCommitResultSchema.parse(result);
  else
    z.object({ review: DecisionReviewSchema, revision: DecisionReviewRevisionSchema }).parse(
      result,
    );
};

const TABLE_VALIDATORS: Readonly<Record<string, DomainValidator>> = {
  accounts: domainValidator(AccountSchema, assertAccountInvariants),
  stocks: domainValidator(StockSchema, assertStockInvariants),
  holdings: domainValidator(HoldingSchema, assertHoldingInvariants, (row) => {
    return { ...omitNulls(row), closedAt: row.closedAt };
  }),
  trades: domainValidator(TradeSchema, assertTradeInvariants),
  portfolio_cash_flows: domainValidator(PortfolioCashFlowSchema),
  holding_cash_adjustments: domainValidator(HoldingCashAdjustmentSchema),
  portfolio_corporate_actions: domainValidator(PortfolioCorporateActionSchema),
  strategies: domainValidator(StrategySchema, assertStrategyInvariants),
  strategy_versions: domainValidator(StrategyVersionSchema, (value) =>
    assertStrategyVersionInvariants(value, 'migration'),
  ),
  strategy_runs: domainValidator(StrategyRunSchema, assertStrategyRunInvariants),
  strategy_results: domainValidator(StrategyResultSchema),
  strategy_signals: domainValidator(StrategySignalSchema),
  strategy_schedules: domainValidator(StrategyScheduleSchema, assertStrategyScheduleInvariants),
  strategy_watchlist_subscriptions: domainValidator(
    StrategyWatchlistSubscriptionSchema,
    assertStrategyWatchlistSubscriptionInvariants,
  ),
  strategy_autonomy_actions: domainValidator(
    StrategyAutonomyActionSchema,
    assertStrategyAutonomyActionInvariants,
  ),
  watchlists: domainValidator(WatchlistSchema, assertWatchlistInvariants),
  watchlist_members: domainValidator(WatchlistMemberSchema, assertWatchlistMemberInvariants),
  watchlist_member_sources: domainValidator(
    WatchlistMemberSourceSchema,
    assertWatchlistMemberSourceInvariants,
  ),
  watchlist_sync_runs: domainValidator(WatchlistSyncRunSchema, assertWatchlistSyncRunInvariants),
  membership_snapshots: domainValidator(MembershipSnapshotSchema),
  alert_plans: domainValidator(AlertPlanSchema, assertAlertPlanInvariants),
  watch_triggers: domainValidator(WatchTriggerSchema, assertWatchTriggerInvariants, (row) => {
    const normalized = omitNulls(row);
    if (row.notified !== 0 && row.notified !== 1 && typeof row.notified !== 'boolean') {
      throw new Error('notified 必须是 0/1');
    }
    normalized.notified = Boolean(row.notified);
    const quoteClose = row.quoteClose;
    const quoteTs = row.quoteTs;
    if ((quoteClose == null) !== (quoteTs == null)) {
      throw new Error('quote_close 与 quote_ts 必须同时为空或同时存在');
    }
    delete normalized.quoteClose;
    delete normalized.quoteTs;
    return quoteClose == null
      ? normalized
      : { ...normalized, quote: { close: quoteClose, ts: quoteTs } };
  }),
  watch_rule_states: domainValidator(WatchRuleStateSchema),
  watch_runs: domainValidator(WatchRunSchema, assertWatchRunInvariants, (row) => {
    return { ...omitNulls(row), finishedAt: row.finishedAt };
  }),
  advices: domainValidator(AdviceSchema, assertAdviceInvariants),
  advice_outcomes: domainValidator(AdviceOutcomeSchema),
  decision_reviews: validateDecisionReviewStorageRow,
  decision_review_revisions: validateDecisionRevisionStorageRow,
  decision_review_trade_links: validateDecisionTradeLinkStorageRow,
  decision_write_receipts: validateDecisionReceiptStorageRow,
  reports: domainValidator(ReportSchema, assertReportInvariants),
  report_refresh_receipts: (row) => {
    z.object({
      account_id: z.string().min(1),
      request_id: z.uuid(),
      request_hash: z.string().min(1),
      report_id: z.string().min(1),
    }).parse(row);
  },
  notifications: domainValidator(NotificationSchema, assertNotificationInvariants),
  signal_observations: domainValidator(SignalObservationSchema, assertSignalObservationInvariants),
  workflow_runs: domainValidator(WorkflowRunSchema, assertWorkflowRunInvariants),
  trading_plans: validateTradingPlanStorageRow,
  stock_universe_memberships: domainValidator(stockUniverseMembershipSchema),
  stock_universe_sync_runs: domainValidator(stockUniverseSyncRunSchema),
  price_snapshots: domainValidator(QuoteSchema),
  daily_bars: domainValidator(DailyBarSchema),
  limit_up_ladder_snapshots: domainValidator(LimitUpLadderSchema),
  stock_events: domainValidator(StockEventSchema, assertStockEventInvariants),
  research_topic_index: domainValidator(ResearchTopicIndexSchema),
  research_document_index: domainValidator(ResearchDocumentIndexSchema),
  research_topic_documents: domainValidator(ResearchTopicDocumentSchema, undefined, (row) => {
    return row.sortOrder == null ? omitNulls(row) : { ...omitNulls(row), order: row.sortOrder };
  }),
  research_subject_links: domainValidator(ResearchSubjectLinkSchema),
  research_document_chunks: domainValidator(ResearchDocumentChunkSchema),
  research_document_fts: domainValidator(researchDocumentFtsSchema),
  research_vault_sync_runs: domainValidator(ResearchVaultSyncRunSchema),
  chat_sessions: domainValidator(ChatSessionSchema, assertChatSessionInvariants),
  chat_messages: domainValidator(ChatMessageSchema, assertChatMessageInvariants),
};

for (const table of ALLOWED_TABLES) {
  if (TABLE_VALIDATORS[table] === undefined) {
    throw new Error(`数据导入表 ${table} 缺少领域校验器`);
  }
}

export interface LuoomeDataArchive {
  readonly format: 'luoome-data';
  readonly version: 1;
  readonly exportedAt: string;
  readonly categories: readonly DataTransferCategory[];
  readonly tables: Readonly<Record<string, readonly Record<string, unknown>[]>>;
}

const normalizeCategories = (input: readonly string[]): DataTransferCategory[] => {
  const allowed = new Set<string>(DATA_TRANSFER_CATEGORIES);
  const unique = [...new Set(input)];
  if (unique.length === 0) throw new Error('至少选择一个数据分类');
  const invalid = unique.filter((item) => !allowed.has(item));
  if (invalid.length > 0) throw new Error(`未知数据分类: ${invalid.join(', ')}`);
  return unique as DataTransferCategory[];
};

const openDatabase = (dbPath: string): Database => {
  const db = new Database(dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  return db;
};

export const exportDataArchive = (
  dbPath: string,
  requestedCategories: readonly string[],
): LuoomeDataArchive => {
  const categories = normalizeCategories(requestedCategories);
  const tableNames = [...new Set(categories.flatMap((category) => CATEGORY_TABLES[category]))];
  const db = openDatabase(dbPath);
  try {
    const readAll = db.transaction(() =>
      Object.fromEntries(
        tableNames.map((table) => [
          table,
          db.query(`SELECT * FROM ${quoteIdentifier(table)}`).all() as Record<string, unknown>[],
        ]),
      ),
    );
    const tables = readAll();
    return {
      format: 'luoome-data',
      version: 1,
      exportedAt: new Date().toISOString(),
      categories,
      tables,
    };
  } finally {
    db.close();
  }
};

const parseArchive = (value: unknown): LuoomeDataArchive => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('导入文件必须是 luoome JSON 数据包');
  }
  const record = value as Record<string, unknown>;
  if (record.format !== 'luoome-data' || record.version !== 1) {
    throw new Error('不支持的数据包格式或版本');
  }
  const categories = normalizeCategories(
    Array.isArray(record.categories)
      ? record.categories.filter((v): v is string => typeof v === 'string')
      : [],
  );
  if (record.tables === null || typeof record.tables !== 'object' || Array.isArray(record.tables)) {
    throw new Error('数据包缺少 tables');
  }
  const tables = record.tables as Record<string, unknown>;
  for (const [table, rows] of Object.entries(tables)) {
    if (!ALLOWED_TABLES.has(table)) throw new Error(`数据包包含不允许导入的表: ${table}`);
    if (!Array.isArray(rows)) throw new Error(`表 ${table} 的数据必须是数组`);
    for (const row of rows) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error(`表 ${table} 包含无效行`);
      }
    }
  }
  return {
    format: 'luoome-data',
    version: 1,
    exportedAt: typeof record.exportedAt === 'string' ? record.exportedAt : '',
    categories,
    tables: tables as Record<string, readonly Record<string, unknown>[]>,
  };
};

const DECISION_IMMUTABLE_KEYS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  decision_review_revisions: [['sequence'], ['review_id', 'revision']],
  decision_write_receipts: [['account_id', 'request_id']],
  report_refresh_receipts: [['account_id', 'request_id']],
};

const validateDecisionGraph = (db: Database, archive: ReturnType<typeof parseArchive>): void => {
  const reviewIds = new Set((archive.tables.decision_reviews ?? []).map((row) => String(row.id)));
  for (const row of archive.tables.decision_review_revisions ?? [])
    reviewIds.add(String(row.review_id));
  for (const row of archive.tables.decision_review_trade_links ?? [])
    reviewIds.add(String(row.review_id));
  for (const trade of archive.tables.trades ?? []) {
    const affected = db
      .query<{ review_id: string }, [string, string]>(
        `SELECT review_id FROM decision_review_trade_links WHERE trade_id = ?
         UNION SELECT r.review_id FROM decision_review_revisions r,
         json_each(r.content_json, '$.tradeIds') t WHERE t.value = ?`,
      )
      .all(String(trade.id), String(trade.id));
    for (const row of affected) reviewIds.add(row.review_id);
  }
  for (const id of reviewIds) {
    const review = db.query('SELECT * FROM decision_reviews WHERE id = ?').get(id) as Record<
      string,
      unknown
    > | null;
    if (!review) throw new Error(`复盘修订引用不存在的主体: ${id}`);
    const revisions = db
      .query('SELECT * FROM decision_review_revisions WHERE review_id = ? ORDER BY revision')
      .all(id) as Record<string, unknown>[];
    if (
      revisions.length !== review.current_revision ||
      revisions.some((row, index) => row.revision !== index + 1)
    )
      throw new Error(`复盘修订不连续或 current_revision 不一致: ${id}`);
    const current = revisions.at(-1);
    if (!current) throw new Error(`复盘缺少当前修订: ${id}`);
    const content = DecisionReviewContentSchema.parse(JSON.parse(String(current.content_json)));
    const links = db
      .query('SELECT * FROM decision_review_trade_links WHERE review_id = ?')
      .all(id) as Record<string, unknown>[];
    const linked = links.map((row) => String(row.trade_id)).sort();
    if (JSON.stringify(linked) !== JSON.stringify([...content.tradeIds].sort()))
      throw new Error(`复盘当前修订与成交关联不一致: ${id}`);
    for (const link of links) {
      const trade = db
        .query('SELECT account_id, stock_id FROM trades WHERE id = ?')
        .get(String(link.trade_id)) as { account_id: string; stock_id: string } | null;
      if (
        !trade ||
        trade.account_id !== review.account_id ||
        link.account_id !== review.account_id ||
        (review.stock_id !== null && trade.stock_id !== review.stock_id) ||
        link.revision !== review.current_revision
      )
        throw new Error(`复盘成交归属不一致: ${id}`);
    }
    for (const revision of revisions) {
      const history = DecisionReviewContentSchema.parse(JSON.parse(String(revision.content_json)));
      for (const tradeId of history.tradeIds) {
        const trade = db
          .query('SELECT account_id, stock_id FROM trades WHERE id = ?')
          .get(tradeId) as { account_id: string; stock_id: string } | null;
        if (
          !trade ||
          trade.account_id !== review.account_id ||
          (review.stock_id !== null && trade.stock_id !== review.stock_id)
        )
          throw new Error(`历史复盘成交归属不一致: ${id}`);
      }
    }
  }
  const reportReceipts = [...(archive.tables.report_refresh_receipts ?? [])];
  for (const report of archive.tables.reports ?? []) {
    reportReceipts.push(
      ...db
        .query<Record<string, unknown>, [string]>(
          'SELECT * FROM report_refresh_receipts WHERE report_id = ?',
        )
        .all(String(report.id)),
    );
  }
  for (const row of reportReceipts) {
    const report = db
      .query('SELECT scope_json, notification_policy FROM reports WHERE id = ?')
      .get(String(row.report_id)) as {
      scope_json: string;
      notification_policy: string | null;
    } | null;
    const scope =
      report === null
        ? null
        : (JSON.parse(report.scope_json) as { kind: string; accountId?: string });
    if (scope?.kind !== 'account' || scope.accountId !== row.account_id)
      throw new Error(`报告补充回执归属不一致: ${row.request_id}`);
  }
  for (const row of archive.tables.decision_write_receipts ?? []) {
    const result = JSON.parse(String(row.result_json)) as Record<string, unknown>;
    const reviews =
      row.command === 'save_decision_review'
        ? [result]
        : (result.reviews as Record<string, unknown>[]);
    for (const item of reviews) {
      const review = item.review as { id: string; accountId: string };
      const revision = item.revision as { reviewId: string; revision: number };
      if (
        review.accountId !== row.account_id ||
        revision.reviewId !== review.id ||
        !db
          .query('SELECT 1 FROM decision_review_revisions WHERE review_id = ? AND revision = ?')
          .get(review.id, revision.revision)
      )
        throw new Error(`复盘回执归属或修订不存在: ${row.request_id}`);
    }
    if (row.command === 'record_decision_trade') {
      const trade = result.trade as { id: string; accountId: string };
      const account = result.account as { id: string };
      if (
        trade.accountId !== row.account_id ||
        account.id !== row.account_id ||
        !db
          .query('SELECT 1 FROM trades WHERE id = ? AND account_id = ?')
          .get(trade.id, row.account_id)
      )
        throw new Error(`成交回执归属不一致: ${row.request_id}`);
    }
  }
};

export const importDataArchive = (
  dbPath: string,
  value: unknown,
): { readonly imported: number; readonly tables: Readonly<Record<string, number>> } => {
  const archive = parseArchive(value);
  const db = openDatabase(dbPath);
  try {
    const counts: Record<string, number> = {};
    const apply = db.transaction(() => {
      for (const table of IMPORT_ORDER) {
        const rows = archive.tables[table];
        if (rows === undefined || rows.length === 0) continue;
        const columns = new Set(
          (
            db.query(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as { name: string }[]
          ).map((column) => column.name),
        );
        const validate = TABLE_VALIDATORS[table];
        if (validate === undefined) throw new Error(`表 ${table} 缺少领域校验器`);
        for (const [index, row] of rows.entries()) {
          const keys = Object.keys(row).filter((key) => columns.has(key));
          if (keys.length === 0 || keys.length !== Object.keys(row).length) {
            throw new Error(`表 ${table} 包含未知或空字段`);
          }
          const immutableKeys = DECISION_IMMUTABLE_KEYS[table];
          if (immutableKeys !== undefined) {
            let duplicate = false;
            for (const key of immutableKeys) {
              const existing = db
                .query<unknown, SQLQueryBindings[]>(
                  `SELECT * FROM ${quoteIdentifier(table)} WHERE ${key.map((part) => `${quoteIdentifier(part)} = ?`).join(' AND ')}`,
                )
                .get(...key.map((part) => row[part] as string | number)) as Record<
                string,
                unknown
              > | null;
              if (existing === null) continue;
              if (
                Object.keys(existing).length !== Object.keys(row).length ||
                Object.keys(existing).some((part) => existing[part] !== row[part])
              )
                throw new Error(`表 ${table} 已有不可变身份但内容不同`);
              duplicate = true;
            }
            if (duplicate) continue;
          }
          if (table === 'decision_reviews') {
            const existing = db
              .query(`SELECT * FROM decision_reviews WHERE id = ? OR
                (account_id = ? AND subject_kind = ? AND subject_id = ?)`)
              .get(
                String(row.id),
                String(row.account_id),
                String(row.subject_kind),
                String(row.subject_id),
              ) as Record<string, unknown> | null;
            if (
              existing !== null &&
              (Object.keys(existing).some(
                (part) => part !== 'current_revision' && existing[part] !== row[part],
              ) ||
                Number(row.current_revision) < Number(existing.current_revision))
            )
              throw new Error('复盘主体身份或冻结上下文与已有记录不一致');
          }
          if (table === 'reports') {
            const existing = db
              .query<Record<string, unknown>, [string, string, string, string, string, number]>(
                `SELECT * FROM reports WHERE id = ? OR
               (kind = ? AND scope_key = ? AND period_start = ? AND period_end = ? AND version = ?)`,
              )
              .get(
                String(row.id),
                String(row.kind),
                String(row.scope_key),
                String(row.period_start),
                String(row.period_end),
                Number(row.version ?? 1),
              );
            if (
              existing !== null &&
              (existing.kind === 'closing' ||
                existing.kind === 'weekly' ||
                existing.notification_policy === 'never')
            ) {
              const deliveryFields = new Set([
                'delivery_status',
                'delivery_attempt_id',
                'updated_at',
              ]);
              if (
                Object.keys(existing).some(
                  (part) => !deliveryFields.has(part) && existing[part] !== row[part],
                )
              )
                throw new Error('报告已有不可变版本但内容不同');
              continue;
            }
          }
          if (table === 'decision_review_trade_links') {
            const existing = db
              .query(
                'SELECT * FROM decision_review_trade_links WHERE review_id = ? AND trade_id = ?',
              )
              .get(String(row.review_id), String(row.trade_id)) as Record<string, unknown> | null;
            if (existing !== null && existing.account_id !== row.account_id)
              throw new Error('复盘成交关联不能改写账户归属');
          }
          const placeholders = keys.map(() => '?').join(', ');
          const sql = `INSERT OR REPLACE INTO ${quoteIdentifier(table)} (${keys.map(quoteIdentifier).join(', ')}) VALUES (${placeholders})`;
          const bindings = keys.map((key) => row[key]);
          if (!bindings.every(isBinding)) throw new Error(`表 ${table} 包含不可写入的字段值`);
          try {
            validate(row);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`表 ${table} 第 ${index + 1} 行领域校验失败: ${message}`);
          }
          db.query<unknown, SQLQueryBindings[]>(sql).run(...bindings);
        }
        counts[table] = rows.length;
      }
      validateDecisionGraph(db, archive);
    });
    apply();
    if (archive.tables.trades?.length) createDrizzleRepos(dbPath).close();
    return {
      imported: Object.values(counts).reduce((sum, count) => sum + count, 0),
      tables: counts,
    };
  } finally {
    db.close();
  }
};
