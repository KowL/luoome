import { Database, type SQLQueryBindings } from 'bun:sqlite';

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
    const tables = Object.fromEntries(
      tableNames.map((table) => [
        table,
        db.query(`SELECT * FROM ${quoteIdentifier(table)}`).all() as Record<string, unknown>[],
      ]),
    );
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
        for (const row of rows) {
          const keys = Object.keys(row).filter((key) => columns.has(key));
          if (keys.length === 0 || keys.length !== Object.keys(row).length) {
            throw new Error(`表 ${table} 包含未知或空字段`);
          }
          const placeholders = keys.map(() => '?').join(', ');
          const sql = `INSERT OR REPLACE INTO ${quoteIdentifier(table)} (${keys.map(quoteIdentifier).join(', ')}) VALUES (${placeholders})`;
          const bindings = keys.map((key) => row[key]);
          if (!bindings.every(isBinding)) throw new Error(`表 ${table} 包含不可写入的字段值`);
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
