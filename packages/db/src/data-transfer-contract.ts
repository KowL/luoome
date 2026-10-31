import { createHash } from 'node:crypto';
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
  assertExternalMarketFactInvariants,
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
  assertTradingPlanReadable,
  assertWatchlistInvariants,
  assertWatchlistMemberInvariants,
  assertWatchlistMemberSourceInvariants,
  assertWatchlistSyncRunInvariants,
  assertWatchRunInvariants,
  assertWatchTriggerInvariants,
  assertWorkflowRunInvariants,
  ChatMessageSchema,
  ChatSessionSchema,
  DATA_IMPORT_PREVIEW_TTL_MS,
  DailyBarSchema,
  DataImportError,
  type DataImportPreview,
  type DataImportRow,
  type DataImportScope,
  type DataImportSnapshot,
  type DataImportTableCount,
  type DataImportTables,
  type DataImportValidationLevel,
  DecisionReviewContentSchema,
  DecisionReviewContextSchema,
  DecisionReviewRevisionSchema,
  DecisionReviewSchema,
  DecisionTradeCommitResultSchema,
  ExternalMarketFactSchema,
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
  reconcileCashBalance,
  reportScopeKey,
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
import { z } from 'zod';
import { DATA_IMPORT_BUSINESS_TABLES, DATA_IMPORT_MANIFEST } from './data-import-manifest.js';

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
  // REQ-M3-16：external 市场事实的 JSON 列（referenced_by 不带 _json 后缀）。
  'referenced_by',
]);

const snakeToCamel = (value: string): string =>
  value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

export const decodeStorageRow = (row: Record<string, unknown>): Record<string, unknown> =>
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
  // 旧归档里的 active 计划没有结构化失效条件：读路径归一化 + readable，不因历史行拒绝导入。
  const plan = assertTradingPlanReadable(planValue);
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

/**
 * 尚未有完整领域映射的业务表：按存储列做结构校验。
 * 只保证「主键列存在、JSON 列可解析、布尔列是 0/1、枚举值已知」，
 * 不做领域不变量（那些由后续切片补 domainValidator）。清单由
 * `assertDataImportManifestCoverage` 与 manifest 差集固定。
 */
/** 标记「只做结构校验」的校验器，供预检/回执按表披露校验级别。 */
const STRUCTURAL_ONLY = Symbol('data-import-structural-only');

const storageColumns = (
  primary: readonly string[],
  enums: Readonly<Record<string, readonly string[]>> = {},
): DomainValidator => {
  const validator: DomainValidator = (row) => {
    for (const column of primary) {
      if (row[column] === undefined || row[column] === null)
        throw new Error(`缺少主键列: ${column}`);
    }
    decodeStorageRow(row);
    for (const [column, allowed] of Object.entries(enums)) {
      const value = row[column];
      if (value !== undefined && value !== null && !allowed.includes(String(value)))
        throw new Error(`${column} 不是已知取值`);
    }
  };
  Object.defineProperty(validator, STRUCTURAL_ONLY, { value: true });
  return validator;
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
  // REQ-M3-16：external 市场事实是业务事实（可导出）；凭据不在表里，天然不会被导出。
  external_market_facts: domainValidator(ExternalMarketFactSchema, (fact) =>
    assertExternalMarketFactInvariants(fact),
  ),
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
  portfolio_performance_snapshots: storageColumns(['id']),
  strategy_signal_states: storageColumns(['strategy_id', 'strategy_version_id', 'context_key']),
  strategy_data_checkpoints: storageColumns(['id'], {
    status: ['running', 'complete', 'partial', 'failed'],
    vintage_status: ['not-applicable', 'available', 'unavailable'],
  }),
  strategy_data_checkpoint_members: storageColumns(['checkpoint_id', 'stock_id'], {
    status: ['available', 'missing', 'failed'],
  }),
  strategy_evaluation_sessions: storageColumns(['id'], {
    status: ['running', 'complete', 'partial', 'failed'],
    origin: ['backfill', 'prospective'],
  }),
  strategy_research_states: storageColumns(['strategy_id', 'account_id']),
  strategy_evaluation_days: storageColumns(['session_id', 'data_as_of'], {
    status: ['running', 'complete', 'failed'],
  }),
  strategy_backtest_runs: storageColumns(['id'], {
    status: ['queued', 'running', 'complete', 'failed'],
    result_availability: ['complete', 'partial', 'unavailable'],
  }),
  strategy_backtest_market_facts: storageColumns([
    'stock_id',
    'date',
    'recorded_at',
    'content_hash',
  ]),
  stock_universe_snapshot_members: storageColumns(['sync_id', 'stock_id']),
  minute_bars: storageColumns(['stock_id', 'interval', 'ended_at'], {
    interval: ['1m', '5m', '15m', '30m', '60m'],
    adjustment: ['raw'],
    completeness: ['closed', 'live'],
  }),
  daily_bar_revisions: storageColumns(['stock_id', 'date', 'recorded_at', 'content_hash']),
  financial_fact_revisions: storageColumns(['id'], {
    status: ['reported', 'restated', 'retracted'],
  }),
  fundamental_score_versions: storageColumns(['id'], {
    status: ['draft', 'published', 'retired'],
    missing_policy: ['unknown', 'exclude-stock', 'fail-run'],
    rounding: ['round-to-6-decimal'],
  }),
  fundamental_score_runs: storageColumns(['id'], {
    status: ['started', 'committed', 'unavailable', 'failed'],
    provider_status: ['complete', 'partial', 'unavailable'],
  }),
  fundamental_score_results: storageColumns(['score_run_id', 'stock_id'], {
    status: ['available', 'missing', 'excluded', 'unavailable'],
  }),
  research_hypothesis_versions: storageColumns(['id'], {
    status: ['active', 'superseded', 'archived'],
  }),
  research_chunk_embeddings: storageColumns(['identity_key', 'document_id', 'ordinal']),
  research_embedding_index_states: storageColumns(['identity_key'], {
    status: ['empty', 'building', 'ready', 'partial', 'failed', 'stale'],
  }),
  analysis_jobs: storageColumns(['id'], {
    status: ['pending', 'claimed', 'completed', 'failed', 'dead_letter', 'cancelled'],
  }),
  analysis_contexts: storageColumns(['id']),
  investment_research: storageColumns(['id']),
  investment_consensus: storageColumns(['id']),
  investment_tracking: storageColumns(['id'], {
    status: ['starting', 'tracking', 'partial', 'failed', 'paused'],
  }),
  watch_delivery_intents: storageColumns(['id']),
  report_delivery_intents: storageColumns(['report_id']),
  watchlist_import_batches: storageColumns(['operation_id']),
  watchlist_removal_receipts: storageColumns(['operation_id']),
  personal_alert_plan_mutations: storageColumns(['operation_id']),
  personal_alert_evaluations: storageColumns(['id']),
  personal_watch_feedback: storageColumns(['trigger_id', 'revision']),
  watchlist_facts_report_keys: storageColumns(['identity']),
};

for (const table of ALLOWED_TABLES) {
  if (TABLE_VALIDATORS[table] === undefined) {
    throw new Error(`数据导入表 ${table} 缺少领域校验器`);
  }
}
// manifest 的每张业务表都必须有校验器：新增 replace/union 表时先补校验，不能靠跳过后声称完整恢复。
for (const table of DATA_IMPORT_BUSINESS_TABLES) {
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

export const parseDataTransferArchive = (value: unknown): LuoomeDataArchive => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('导入文件必须是 luoome JSON 数据包');
  }
  const record = value as Record<string, unknown>;
  if (record.format !== 'luoome-data' || record.version !== 1) {
    throw new Error('不支持的数据包格式或版本');
  }
  const categories = normalizeCategories(
    Array.isArray(record.categories)
      ? record.categories.map((v: unknown) => {
          if (typeof v !== 'string') throw new Error('无效分类');
          return v;
        })
      : [],
  );
  if (record.tables === null || typeof record.tables !== 'object' || Array.isArray(record.tables)) {
    throw new Error('数据包缺少 tables');
  }
  const tables = record.tables as Record<string, unknown>;
  for (const [table, rows] of Object.entries(tables)) {
    if (!categories.some((category) => CATEGORY_TABLES[category].includes(table)))
      throw new Error(`数据包包含不允许导入的表: ${table}`);
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

export const hasDataTransferValidator = (table: string): boolean =>
  Object.hasOwn(TABLE_VALIDATORS, table);

export const validateDataTransferRow = (table: string, row: Record<string, unknown>): void => {
  if (!Object.hasOwn(TABLE_VALIDATORS, table)) throw new Error(`尚未支持表的领域校验: ${table}`);
  const validator = TABLE_VALIDATORS[table];
  if (validator === undefined) throw new Error(`尚未支持表的领域校验: ${table}`);
  validator(row);
};

/**
 * 校验级别（Lead 裁定 round-15 §4.1）。有领域校验器的表是 `domain`；
 * 其余 durable 表只做 `structural`：主键存在、布尔列 0/1、JSON 列可解析、存储值类型受限。
 * 这不是领域不变量，预检与回执必须显式披露，不能静默当成完整校验。
 */
export const dataImportValidationLevel = (table: string): DataImportValidationLevel => {
  const validator = TABLE_VALIDATORS[table];
  if (validator === undefined) return 'structural';
  return (validator as unknown as Record<symbol, unknown>)[STRUCTURAL_ONLY] === true
    ? 'structural'
    : 'domain';
};

/**
 * 按表声明的级别校验：`domain` 表走领域不变量，`structural` 表的校验器本身只钉
 * 「主键列存在 / JSON 可解析 / 布尔 0-1 / 枚举已知」。级别由预检与回执披露。
 */
export const validateDataImportRow = (table: string, row: Record<string, unknown>): void =>
  validateDataTransferRow(table, row);

export const assertDataImportRowScope = (
  table: string,
  row: DataImportRow,
  scope: DataImportScope,
): void => {
  const decoded = decodeStorageRow(row);
  const visit = (value: unknown, depth: number): void => {
    if (depth > 64) throw new DataImportError('limit', '嵌套数据层级过深');
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (
        ['accountId', 'account_id', 'defaultAccountId'].includes(key) &&
        item !== null &&
        item !== scope.accountId
      )
        throw new DataImportError('scope', '数据包含其它账户归属');
      if (
        ['ownerUserId', 'owner_user_id', 'userId', 'user_id'].includes(key) &&
        item !== null &&
        item !== scope.userId
      )
        throw new DataImportError('scope', '数据包含其它 owner 归属');
      if (key === 'kind' && item === 'all-accounts')
        throw new DataImportError('scope', '全账户范围不属于单账户恢复');
      if (key === 'account' && item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const id = (item as Record<string, unknown>).id;
        if (id !== undefined && id !== scope.accountId)
          throw new DataImportError('scope', '嵌套账户归属不一致');
      }
      visit(item, depth + 1);
    }
  };
  visit(decoded, 0);
  if (table === 'accounts' && row.id !== scope.accountId)
    throw new DataImportError('scope', '快照包含其它账户');
  if (
    table === 'advices' &&
    decoded.subjectKind === 'portfolio' &&
    decoded.subjectId !== scope.accountId
  )
    throw new DataImportError('scope', '组合建议主体属于其它账户');
  if (table === 'watchlist_member_sources' && decoded.kind === 'portfolio') {
    if (
      decoded.sourceKey !== `portfolio:${scope.accountId}` ||
      (decoded.sourceId !== undefined &&
        decoded.sourceId !== null &&
        decoded.sourceId !== scope.accountId)
    )
      throw new DataImportError('scope', '持仓关注来源属于其它账户');
  }
  if (
    table === 'watchlist_sync_runs' &&
    decoded.sourceKind === 'portfolio' &&
    decoded.sourceKey !== `portfolio:${scope.accountId}`
  )
    throw new DataImportError('scope', '持仓同步来源属于其它账户');
  if (table === 'reports') {
    const report = ReportSchema.parse(omitNulls(decoded));
    if (row.scope_key !== reportScopeKey(report.scope))
      throw new DataImportError('scope', '报告 scope_key 与 scope_json 不一致');
  }
};

export const canonicalDataImportJson = (value: unknown): string => {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    return item;
  };
  return JSON.stringify(canonical(value));
};
export const dataImportHash = (value: unknown): string =>
  createHash('sha256').update(canonicalDataImportJson(value)).digest('hex');

export const canonicalDataImportRow = (row: DataImportRow): string =>
  canonicalDataImportJson(decodeStorageRow(row));
export const dataImportRowHash = (row: DataImportRow): string =>
  dataImportHash(canonicalDataImportRow(row));

export const dataImportBusinessDigest = (
  tables: DataImportTables,
  scope: DataImportScope,
): string =>
  dataImportHash({
    version: 1,
    mode: 'restore-business-v1',
    scope,
    manifest: DATA_IMPORT_MANIFEST,
    tables: Object.fromEntries(
      DATA_IMPORT_BUSINESS_TABLES.map((table) => [
        table,
        (tables[table] ?? []).map(canonicalDataImportRow).sort(),
      ]),
    ),
  });

const assertDataImportDecisionGraph = (tables: DataImportTables): void => {
  const find = (table: string, id: unknown) => (tables[table] ?? []).find((row) => row.id === id);
  for (const review of tables.decision_reviews ?? []) {
    const revisions = (tables.decision_review_revisions ?? [])
      .filter((row) => row.review_id === review.id)
      .sort((a, b) => Number(a.revision) - Number(b.revision));
    if (
      revisions.length !== review.current_revision ||
      revisions.some((row, i) => row.revision !== i + 1)
    )
      throw new DataImportError('graph', '复盘修订不连续或当前修订缺失');
    const current = revisions.at(-1);
    if (!current) throw new DataImportError('graph', '复盘缺少当前修订');
    const currentContent = DecisionReviewContentSchema.parse(
      JSON.parse(String(current.content_json)),
    );
    const links = (tables.decision_review_trade_links ?? []).filter(
      (row) => row.review_id === review.id,
    );
    if (
      canonicalDataImportJson(links.map((row) => row.trade_id).sort()) !==
      canonicalDataImportJson([...currentContent.tradeIds].sort())
    )
      throw new DataImportError('graph', '复盘当前修订与成交关联不一致');
    for (const revision of revisions) {
      const content = DecisionReviewContentSchema.parse(JSON.parse(String(revision.content_json)));
      for (const id of content.tradeIds) {
        const trade = find('trades', id);
        if (
          !trade ||
          trade.account_id !== review.account_id ||
          (review.stock_id !== null && trade.stock_id !== review.stock_id)
        )
          throw new DataImportError('graph', '历史复盘成交归属不一致');
      }
    }
    if (
      links.some(
        (link) =>
          link.account_id !== review.account_id || link.revision !== review.current_revision,
      )
    )
      throw new DataImportError('graph', '复盘成交关联账户或修订不一致');
  }
  for (const row of tables.report_refresh_receipts ?? []) {
    const report = find('reports', row.report_id);
    const scope = report
      ? (JSON.parse(String(report.scope_json)) as { kind?: string; accountId?: string })
      : null;
    if (scope?.kind !== 'account' || scope.accountId !== row.account_id)
      throw new DataImportError('graph', '报告补充回执缺少同账户报告');
  }
  for (const row of tables.decision_write_receipts ?? []) {
    const result = JSON.parse(String(row.result_json)) as Record<string, unknown>;
    const results =
      row.command === 'save_decision_review'
        ? [result]
        : (result.reviews as Record<string, unknown>[]);
    for (const item of results) {
      const review = item.review as { id: string; accountId: string };
      const revision = item.revision as { reviewId: string; revision: number; contentHash: string };
      const finalReview = find('decision_reviews', review.id);
      const finalRevision = (tables.decision_review_revisions ?? []).find(
        (stored) => stored.review_id === review.id && stored.revision === revision.revision,
      );
      if (
        review.accountId !== row.account_id ||
        revision.reviewId !== review.id ||
        finalReview?.account_id !== row.account_id ||
        !finalRevision ||
        finalRevision.content_hash !== revision.contentHash
      )
        throw new DataImportError('graph', '复盘回执缺少对应主体/修订强引用');
    }
    if (row.command === 'record_decision_trade') {
      const trade = result.trade as { id: string; accountId: string };
      const account = result.account as { id: string };
      if (
        trade.accountId !== row.account_id ||
        account.id !== row.account_id ||
        find('trades', trade.id)?.account_id !== row.account_id
      )
        throw new DataImportError('graph', '成交回执缺少对应同账户成交');
    }
  }
};

export const buildDataImportFts = (tables: DataImportTables): readonly DataImportRow[] =>
  (tables.research_document_chunks ?? []).map((chunk) => {
    const document = (tables.research_document_index ?? []).find(
      (row) => row.id === chunk.document_id,
    );
    if (!document) throw new DataImportError('graph', '研究chunk缺少对应document');
    return {
      document_id: chunk.document_id ?? null,
      ordinal: chunk.ordinal ?? null,
      content_hash: chunk.content_hash ?? null,
      title: document.title ?? null,
      heading_path: chunk.heading_path ?? null,
      body: chunk.body ?? null,
    };
  });

export const assertDataImportFinalTables = (
  tables: DataImportTables,
  scope: DataImportScope,
): void => {
  const accounts = tables.accounts ?? [];
  if (accounts.length !== 1 || accounts[0]?.id !== scope.accountId)
    throw new DataImportError('scope', '最终数据必须仅有当前 owner 账户');
  const exists = (table: string, column: string, value: unknown) =>
    (tables[table] ?? []).some((row) => row[column] === value);
  for (const table of DATA_IMPORT_BUSINESS_TABLES) {
    for (const row of tables[table] ?? []) {
      assertDataImportRowScope(table, row, scope);
      if (
        row.account_id !== undefined &&
        row.account_id !== null &&
        row.account_id !== scope.accountId
      )
        throw new DataImportError('scope', `表 ${table} 含其它账户`);
      if (row.owner_user_id !== undefined && row.owner_user_id !== scope.userId)
        throw new DataImportError('scope', `表 ${table} 含其它 owner`);
      validateDataImportRow(table, row);
      const references: [string, string, string][] = [
        ['account_id', 'accounts', 'id'],
        ['stock_id', 'stocks', 'id'],
        ['strategy_id', 'strategies', 'id'],
        ['strategy_version_id', 'strategy_versions', 'id'],
        ['research_hypothesis_version_id', 'research_hypothesis_versions', 'id'],
        ['watchlist_id', 'watchlists', 'id'],
        ['review_id', 'decision_reviews', 'id'],
        ['trade_id', 'trades', 'id'],
        ['report_id', 'reports', 'id'],
        ['document_id', 'research_document_index', 'id'],
        ['topic_id', 'research_topic_index', 'id'],
        ['workflow_run_id', 'workflow_runs', 'id'],
      ];
      if (table === 'chat_messages') references.push(['session_id', 'chat_sessions', 'id']);
      if (table === 'strategy_evaluation_days')
        references.push(['session_id', 'strategy_evaluation_sessions', 'id']);
      for (const [column, parent, key] of references) {
        if (row[column] !== undefined && row[column] !== null && !exists(parent, key, row[column]))
          throw new DataImportError('graph', `表 ${table}.${column} 缺少引用`);
      }
    }
  }
  const account = AccountSchema.parse(omitNulls(decodeStorageRow(accounts[0] ?? {})));
  assertDataImportDecisionGraph(tables);
  const ledger = {
    account,
    holdings: (tables.holdings ?? []).map((row) =>
      HoldingSchema.parse({ ...omitNulls(decodeStorageRow(row)), closedAt: row.closed_at }),
    ),
    trades: (tables.trades ?? []).map((row) => TradeSchema.parse(omitNulls(decodeStorageRow(row)))),
    cashFlows: (tables.portfolio_cash_flows ?? []).map((row) =>
      PortfolioCashFlowSchema.parse(omitNulls(decodeStorageRow(row))),
    ),
    holdingAdjustments: (tables.holding_cash_adjustments ?? []).map((row) =>
      HoldingCashAdjustmentSchema.parse(omitNulls(decodeStorageRow(row))),
    ),
  };
  const reconciliation = reconcileCashBalance(account, ledger);
  if (!reconciliation.reconciled || reconciliation.gaps.length !== 0)
    throw new DataImportError('ledger', '账户现金或数量账本存在差额');
};

export const planDataImportRestore = (
  snapshot: DataImportSnapshot,
  current: DataImportTables,
  scope: DataImportScope,
  now: number,
): { readonly preview: DataImportPreview; readonly tables: DataImportTables } => {
  const tables: Record<string, readonly DataImportRow[]> = {};
  const counts: Record<string, DataImportTableCount> = {};
  for (const table of DATA_IMPORT_BUSINESS_TABLES) {
    const incoming = snapshot.tables[table];
    if (incoming === undefined) throw new DataImportError('schema', `快照缺少表: ${table}`);
    const previous = current[table] ?? [];
    const columns = snapshot.schema[table]?.columns;
    if (!columns) throw new DataImportError('schema', `快照缺少表结构: ${table}`);
    const primary = columns
      .filter((column) => column.primaryKey > 0)
      .sort((a, b) => a.primaryKey - b.primaryKey)
      .map((column) => column.name);
    if (primary.length === 0) throw new DataImportError('schema', `业务表缺少主键: ${table}`);
    const key = (row: DataImportRow) =>
      canonicalDataImportJson(primary.map((column) => row[column]));
    const source = new Map<string, DataImportRow>();
    const old = new Map(previous.map((row) => [key(row), row]));
    for (const row of incoming) {
      const identity = key(row);
      if (source.has(identity)) throw new DataImportError('conflict', `快照重复身份: ${table}`);
      source.set(identity, row);
    }
    const policy = DATA_IMPORT_MANIFEST[table];
    if (policy === undefined) throw new DataImportError('schema', '未声明的恢复策略');
    const result = new Map(policy === 'union' ? old : []);
    let inserted = 0,
      updated = 0,
      unchanged = 0;
    for (const [identity, row] of source) {
      const existing = old.get(identity);
      if (existing === undefined) inserted += 1;
      else if (canonicalDataImportRow(existing) === canonicalDataImportRow(row)) unchanged += 1;
      else {
        if (policy === 'union') throw new DataImportError('conflict', `业务回执身份冲突: ${table}`);
        updated += 1;
      }
      result.set(identity, row);
    }
    tables[table] = [...result.values()];
    counts[table] = {
      policy,
      source: incoming.length,
      current: previous.length,
      expected: result.size,
      inserted,
      updated,
      deleted:
        policy === 'union' ? 0 : [...old.keys()].filter((identity) => !source.has(identity)).length,
      unchanged:
        unchanged +
        (policy === 'union'
          ? [...old.keys()].filter((identity) => !source.has(identity)).length
          : 0),
    };
  }
  assertDataImportFinalTables(tables, scope);
  const preDigest = dataImportBusinessDigest(current, scope);
  const postDigest = dataImportBusinessDigest(tables, scope);
  const expiresAt = now + DATA_IMPORT_PREVIEW_TTL_MS;
  const validation = Object.fromEntries(
    DATA_IMPORT_BUSINESS_TABLES.map((table) => [table, dataImportValidationLevel(table)]),
  ) as Record<string, DataImportValidationLevel>;
  const structuralOnly = DATA_IMPORT_BUSINESS_TABLES.filter(
    (table) => validation[table] === 'structural',
  );
  const previewHash = dataImportHash({
    scope,
    archiveDigest: snapshot.archiveDigest,
    version: snapshot.manifestVersion,
    mode: 'restore-business-v1',
    preDigest,
    postDigest,
    expiresAt,
    // 校验器级别同样进摘要：校验口径变化必须让旧预检过期。
    validation,
  });
  return {
    tables,
    preview: {
      archiveDigest: snapshot.archiveDigest,
      preDigest,
      postDigest,
      expiresAt,
      previewHash,
      counts,
      validation,
      structuralOnly,
    },
  };
};
