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
  assertStrategyInvariants,
  assertStrategyRunInvariants,
  assertStrategyScheduleInvariants,
  assertStrategyVersionInvariants,
  assertTradeInvariants,
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
  HoldingSchema,
  MembershipSnapshotSchema,
  NotificationSchema,
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
  StrategyResultSchema,
  StrategyRunSchema,
  StrategyScheduleSchema,
  StrategySchema,
  StrategySignalSchema,
  StrategyVersionSchema,
  TradeSchema,
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
  portfolio: ['accounts', 'stocks', 'holdings', 'trades'],
  strategies: [
    'stocks',
    'strategies',
    'strategy_versions',
    'strategy_runs',
    'strategy_results',
    'strategy_signals',
    'strategy_schedules',
  ],
  watchlists: [
    'stocks',
    'watchlists',
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
    'reports',
    'notifications',
    'signal_observations',
    'workflow_runs',
  ],
  'market-data': [
    'stocks',
    'stock_universe_memberships',
    'stock_universe_sync_runs',
    'price_snapshots',
    'daily_bars',
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

const TABLE_VALIDATORS: Readonly<Record<string, DomainValidator>> = {
  accounts: domainValidator(AccountSchema, assertAccountInvariants),
  stocks: domainValidator(StockSchema, assertStockInvariants),
  holdings: domainValidator(HoldingSchema, assertHoldingInvariants, (row) => {
    return { ...omitNulls(row), closedAt: row.closedAt };
  }),
  trades: domainValidator(TradeSchema, assertTradeInvariants),
  strategies: domainValidator(StrategySchema, assertStrategyInvariants),
  strategy_versions: domainValidator(StrategyVersionSchema, (value) =>
    assertStrategyVersionInvariants(value, 'migration'),
  ),
  strategy_runs: domainValidator(StrategyRunSchema, assertStrategyRunInvariants),
  strategy_results: domainValidator(StrategyResultSchema),
  strategy_signals: domainValidator(StrategySignalSchema),
  strategy_schedules: domainValidator(StrategyScheduleSchema, assertStrategyScheduleInvariants),
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
  reports: domainValidator(ReportSchema, assertReportInvariants),
  notifications: domainValidator(NotificationSchema, assertNotificationInvariants),
  signal_observations: domainValidator(SignalObservationSchema, assertSignalObservationInvariants),
  workflow_runs: domainValidator(WorkflowRunSchema, assertWorkflowRunInvariants),
  stock_universe_memberships: domainValidator(stockUniverseMembershipSchema),
  stock_universe_sync_runs: domainValidator(stockUniverseSyncRunSchema),
  price_snapshots: domainValidator(QuoteSchema),
  daily_bars: domainValidator(DailyBarSchema),
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
    });
    apply();
    return {
      imported: Object.values(counts).reduce((sum, count) => sum + count, 0),
      tables: counts,
    };
  } finally {
    db.close();
  }
};
