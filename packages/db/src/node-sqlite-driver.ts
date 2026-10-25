// drizzle-orm 0.45.2 没有官方 node:sqlite driver；本文件是唯一依赖 node:sqlite 的模块，
// 提供与 drizzle-orm/bun-sqlite 同形的同步 session/driver（P0 spike 已验证）。
//
// node:sqlite 与 bun:sqlite 的差异都在这里收敛：
// - StatementSync 没有 values()，用 setReturnArrays(true) + all() 还原数组行；
// - DatabaseSync 没有 transaction()，用 BEGIN/COMMIT/ROLLBACK 与嵌套 SAVEPOINT 实现；
// - 裸参数 boolean/Date/undefined 的绑定语义更严格，先归一化。
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { DefaultLogger, entityKind, type Logger, NoopLogger } from 'drizzle-orm';
import {
  createTableRelationsHelpers,
  type ExtractTablesWithRelations,
  extractTablesRelationalConfig,
  type RelationalSchemaConfig,
  type TablesRelationalConfig,
} from 'drizzle-orm/relations';
import { fillPlaceholders, type Query, sql } from 'drizzle-orm/sql/sql';
import { SQLiteSyncDialect, SQLiteTransaction } from 'drizzle-orm/sqlite-core';
import { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core/db';
import type { SelectedFieldsOrdered } from 'drizzle-orm/sqlite-core/query-builders/select.types';
import {
  SQLitePreparedQuery as PreparedQueryBase,
  type PreparedQueryConfig as PreparedQueryConfigBase,
  type SQLiteExecuteMethod,
  SQLiteSession,
  type SQLiteTransactionConfig,
} from 'drizzle-orm/sqlite-core/session';
import { type DrizzleConfig, mapResultRow } from 'drizzle-orm/utils';
import type { SQLiteRunResult } from './database.js';

// drizzle-orm 0.45.2 的 utils.js 运行时导出 mapResultRow，但 utils.d.ts 漏了声明
// （spike 在 Node 22/24 上实测可用）。这里补一个最小的类型声明，避免使用 node_modules 内部路径。
declare module 'drizzle-orm/utils' {
  export function mapResultRow<TResult = Record<string, unknown>>(
    columns: SelectedFieldsOrdered,
    row: unknown[],
    joinsNotNullableMap: Record<string, boolean> | undefined,
  ): TResult;
}

type PreparedQueryConfig = Omit<PreparedQueryConfigBase, 'statement' | 'run'>;

/** node:sqlite 可绑定的参数类型（不含 boolean/Date/undefined，见 bindValue）。 */
type BindValue = null | number | bigint | string | NodeJS.ArrayBufferView;

const bindValue = (value: unknown): BindValue => {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) throw new TypeError('node:sqlite cannot bind undefined');
  if (value instanceof Date) return value.getTime();
  return value as BindValue;
};

const bindAll = (params: readonly unknown[]): BindValue[] => params.map(bindValue);

// raw all() 返回的是数组行；按 prepare 时记录的列名还原 bun:sqlite 的普通对象语义
// （重复列名后值覆盖）。
const toObject = (columns: readonly string[], row: readonly unknown[]): Record<string, unknown> => {
  const object: Record<string, unknown> = {};
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index];
    if (column !== undefined) object[column] = row[index];
  }
  return object;
};

const toRunResult = (result: {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}): SQLiteRunResult => ({
  changes: Number(result.changes),
  lastInsertRowid: result.lastInsertRowid,
});

export interface NodeSQLiteSessionOptions {
  logger?: Logger | undefined;
}

export class NodeSQLiteSession<
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> extends SQLiteSession<'sync', SQLiteRunResult, TFullSchema, TSchema> {
  static override readonly [entityKind]: string = 'NodeSQLiteSession';

  private readonly client: DatabaseSync;
  private readonly sqliteDialect: SQLiteSyncDialect;
  private readonly relationalSchema: RelationalSchemaConfig<TSchema> | undefined;
  private readonly logger: Logger;
  private savepoint = 0;
  /** 已执行的 DDL/事务控制语句（与 bun-sqlite session 的调试面同形）。 */
  readonly executedSql: string[] = [];

  constructor(
    client: DatabaseSync,
    dialect: SQLiteSyncDialect,
    schema: RelationalSchemaConfig<TSchema> | undefined,
    options: NodeSQLiteSessionOptions = {},
  ) {
    super(dialect);
    this.client = client;
    this.sqliteDialect = dialect;
    this.relationalSchema = schema;
    this.logger = options.logger ?? new NoopLogger();
  }

  exec(query: string): void {
    this.executedSql.push(query);
    this.client.exec(query);
  }

  override prepareQuery<T extends Omit<PreparedQueryConfig, 'run'>>(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    _isResponseInArrayMode: boolean,
    customResultMapper?: (rows: unknown[][]) => unknown,
  ): NodeSQLitePreparedQuery<T> {
    const stmt = this.client.prepare(query.sql);
    stmt.setReturnArrays(true);
    return new NodeSQLitePreparedQuery<T>(
      stmt,
      query,
      this.logger,
      fields,
      executeMethod,
      customResultMapper,
    );
  }

  override transaction<T>(
    transaction: (tx: NodeSQLiteTransaction<TFullSchema, TSchema>) => T,
    config: SQLiteTransactionConfig = {},
  ): T {
    const tx = new NodeSQLiteTransaction('sync', this.sqliteDialect, this, this.relationalSchema);
    // 嵌套 db.transaction() 降级为 savepoint（与 drizzle 的 tx.transaction 行为一致）。
    if (this.client.isTransaction) {
      const name = `drizzle_sp_${this.savepoint}`;
      this.savepoint += 1;
      this.exec(`SAVEPOINT ${name}`);
      try {
        const result = transaction(tx);
        this.exec(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        this.exec(`ROLLBACK TO SAVEPOINT ${name}`);
        this.exec(`RELEASE SAVEPOINT ${name}`);
        throw error;
      } finally {
        this.savepoint -= 1;
      }
    }
    this.exec(`BEGIN ${(config.behavior ?? 'deferred').toUpperCase()}`);
    try {
      const result = transaction(tx);
      this.exec('COMMIT');
      return result;
    } catch (error) {
      this.exec('ROLLBACK');
      throw error;
    }
  }
}

export class NodeSQLiteTransaction<
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> extends SQLiteTransaction<'sync', SQLiteRunResult, TFullSchema, TSchema> {
  static override readonly [entityKind]: string = 'NodeSQLiteTransaction';

  // drizzle 的 SQLiteTransaction 类型声明没有暴露 session 字段，这里自己保存
  // session/dialect/schema 供嵌套 savepoint 复用。
  private readonly nodeSession: NodeSQLiteSession<TFullSchema, TSchema>;
  private readonly nodeDialect: SQLiteSyncDialect;
  private readonly nodeSchema: RelationalSchemaConfig<TSchema> | undefined;

  constructor(
    resultType: 'sync',
    dialect: SQLiteSyncDialect,
    session: NodeSQLiteSession<TFullSchema, TSchema>,
    schema: RelationalSchemaConfig<TSchema> | undefined,
    nestedIndex?: number,
  ) {
    super(resultType, dialect, session, schema, nestedIndex);
    this.nodeSession = session;
    this.nodeDialect = dialect;
    this.nodeSchema = schema;
  }

  override transaction<T>(transaction: (tx: NodeSQLiteTransaction<TFullSchema, TSchema>) => T): T {
    const name = `sp${this.nestedIndex}`;
    const tx = new NodeSQLiteTransaction(
      'sync',
      this.nodeDialect,
      this.nodeSession,
      this.nodeSchema,
      this.nestedIndex + 1,
    );
    this.nodeSession.run(sql.raw(`savepoint ${name}`));
    try {
      const result = transaction(tx);
      this.nodeSession.run(sql.raw(`release savepoint ${name}`));
      return result;
    } catch (error) {
      this.nodeSession.run(sql.raw(`rollback to savepoint ${name}`));
      this.nodeSession.run(sql.raw(`release savepoint ${name}`));
      throw error;
    }
  }
}

class NodeSQLitePreparedQuery<
  T extends PreparedQueryConfig = PreparedQueryConfig,
> extends PreparedQueryBase<{
  type: 'sync';
  run: SQLiteRunResult;
  all: T['all'];
  get: T['get'];
  values: T['values'];
  execute: T['execute'];
}> {
  static override readonly [entityKind]: string = 'NodeSQLitePreparedQuery';

  private readonly stmt: StatementSync;
  private readonly logger: Logger;
  private readonly fields: SelectedFieldsOrdered | undefined;
  private readonly customResultMapper: ((rows: unknown[][]) => unknown) | undefined;
  private readonly columns: string[];
  /** drizzle 构建 join 查询时动态挂到 prepared query 上。 */
  joinsNotNullableMap: Record<string, boolean> | undefined;

  constructor(
    stmt: StatementSync,
    query: Query,
    logger: Logger,
    fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    customResultMapper?: (rows: unknown[][]) => unknown,
  ) {
    super('sync', executeMethod, query);
    this.stmt = stmt;
    this.logger = logger;
    this.fields = fields;
    this.customResultMapper = customResultMapper;
    this.columns = stmt.columns().map((column) => column.name);
  }

  override run(placeholderValues?: Record<string, unknown>): SQLiteRunResult {
    const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
    this.logger.logQuery(this.query.sql, params);
    return toRunResult(this.stmt.run(...bindAll(params)));
  }

  override all(placeholderValues?: Record<string, unknown>): T['all'] {
    if (!this.fields && !this.customResultMapper) {
      const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
      this.logger.logQuery(this.query.sql, params);
      const rows = this.stmt.all(...bindAll(params)) as unknown as unknown[][];
      return rows.map((row) => toObject(this.columns, row)) as unknown as T['all'];
    }
    const rows = this.values(placeholderValues) as unknown as unknown[][];
    if (this.customResultMapper) return this.customResultMapper(rows) as T['all'];
    return rows.map((row) =>
      mapResultRow(this.fields as SelectedFieldsOrdered, row, this.joinsNotNullableMap),
    ) as unknown as T['all'];
  }

  override get(placeholderValues?: Record<string, unknown>): T['get'] {
    const rows = this.values(placeholderValues) as unknown as unknown[][];
    const row = rows[0];
    if (!row) return undefined as T['get'];
    if (!this.fields && !this.customResultMapper) {
      return toObject(this.columns, row) as unknown as T['get'];
    }
    if (this.customResultMapper) return this.customResultMapper([row]) as T['get'];
    return mapResultRow(
      this.fields as SelectedFieldsOrdered,
      row,
      this.joinsNotNullableMap,
    ) as unknown as T['get'];
  }

  override values(placeholderValues?: Record<string, unknown>): T['values'] {
    const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
    this.logger.logQuery(this.query.sql, params);
    // setReturnArrays(true) 后 all() 返回数组行。
    return this.stmt.all(...bindAll(params)) as unknown as T['values'];
  }
}

export class NodeSQLiteDatabase<
  TSchema extends Record<string, unknown> = Record<string, never>,
> extends BaseSQLiteDatabase<'sync', SQLiteRunResult, TSchema> {
  static override readonly [entityKind]: string = 'NodeSQLiteDatabase';

  declare $client: DatabaseSync;
}

const construct = <TSchema extends Record<string, unknown>>(
  client: DatabaseSync,
  config: DrizzleConfig<TSchema>,
): NodeSQLiteDatabase<TSchema> & { $client: DatabaseSync } => {
  const dialect = new SQLiteSyncDialect(
    config.casing === undefined ? {} : { casing: config.casing },
  );
  let logger: Logger | undefined;
  if (config.logger === true) logger = new DefaultLogger();
  else if (config.logger !== false) logger = config.logger;
  let relationalSchema: RelationalSchemaConfig<ExtractTablesWithRelations<TSchema>> | undefined;
  if (config.schema !== undefined) {
    const tables = extractTablesRelationalConfig(config.schema, createTableRelationsHelpers);
    relationalSchema = {
      fullSchema: config.schema,
      schema: tables.tables,
      tableNamesMap: tables.tableNamesMap,
    } as unknown as RelationalSchemaConfig<ExtractTablesWithRelations<TSchema>>;
  }
  const session = new NodeSQLiteSession<TSchema, ExtractTablesWithRelations<TSchema>>(
    client,
    dialect,
    relationalSchema,
    { logger },
  );
  const db = new NodeSQLiteDatabase<TSchema>('sync', dialect, session, relationalSchema);
  db.$client = client;
  return db;
};

/** 用已有的 node:sqlite 连接创建 drizzle 句柄；连接创建与 pragma 由调用方负责。 */
export function drizzleNodeSqlite<TSchema extends Record<string, unknown> = Record<string, never>>(
  client: DatabaseSync,
  config: DrizzleConfig<TSchema> = {},
): NodeSQLiteDatabase<TSchema> & { $client: DatabaseSync } {
  if (typeof client !== 'object' || client === null || !('prepare' in client)) {
    throw new TypeError('drizzleNodeSqlite: pass a node:sqlite DatabaseSync instance');
  }
  return construct(client, config);
}

export interface NodeSqlitePragmaOptions {
  /** 文件库开 WAL；:memory: 传 false（pragma 会被静默忽略，显式跳过更清晰）。 */
  readonly wal?: boolean;
}

/** 与 bun client 相同的连接 pragma：foreign_keys / busy_timeout / WAL + synchronous NORMAL。 */
export function applyNodePragmas(
  client: DatabaseSync,
  options: NodeSqlitePragmaOptions = {},
): void {
  client.exec('PRAGMA foreign_keys = ON');
  // Web chat、策略调度器和确认面板会并发写同一文件；给短事务留出等待窗口。
  client.exec('PRAGMA busy_timeout = 5000');
  if (options.wal !== false) {
    client.exec('PRAGMA journal_mode = WAL');
    client.exec('PRAGMA synchronous = NORMAL');
  }
}
