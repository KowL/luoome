import { createHash } from 'node:crypto';
import {
  DATA_IMPORT_PREVIEW_TTL_MS,
  DATA_IMPORT_RESTORE_TOOL,
  type DataImportCommand,
  DataImportError,
  type DataImportReceipt,
  type DataImportRepository,
  type DataImportRow,
  type DataImportScope,
  type DataImportTables,
} from '@luoome/core';
import { and, eq, sql } from 'drizzle-orm';
import { DATA_IMPORT_BUSINESS_TABLES, DATA_IMPORT_MANIFEST } from '../../data-import-manifest.js';
import {
  buildDataImportFts,
  canonicalDataImportJson,
  dataImportBusinessDigest,
  dataImportHash,
  dataImportRowHash,
  planDataImportRestore,
} from '../../data-transfer-contract.js';
import type { DrizzleDatabase } from '../../database.js';
import { dataImportReceipts } from '../../schema/data-import.js';
import type { Schema } from '../../schema/index.js';

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

export class DrizzleDataImportRepository implements DataImportRepository {
  constructor(private readonly db: DrizzleDatabase<Schema>) {}

  private readTables(db = this.db): DataImportTables {
    return Object.fromEntries(
      DATA_IMPORT_BUSINESS_TABLES.map((table) => [
        table,
        db.all<DataImportRow>(sql.raw(`SELECT * FROM ${quote(table)}`)),
      ]),
    );
  }

  /**
   * 导出业务事实（task-35）：只读，全在事务里读同一快照。
   *
   * 表集合**直接来自 `DATA_IMPORT_BUSINESS_TABLES`**（= `replace ∪ union`），
   * 与 `restore` 的读集合是同一份常量 ⇒ 「导出的东西恰好能被吃回去」是结构性保证。
   * `preserve` / `transient` 天然不在其中；`research_document_fts` 走 `rebuild`，恢复时重建。
   */
  async exportBusinessTables(): Promise<{
    readonly tables: DataImportTables;
    readonly digest: string;
  }> {
    return this.db.transaction((tx) => {
      const tables = this.readTables(tx);
      return {
        tables,
        digest: createHash('sha256').update(canonicalDataImportJson(tables)).digest('hex'),
      };
    });
  }

  private receipt(
    scope: DataImportScope,
    requestId: string,
    db = this.db,
  ): DataImportReceipt | null {
    return (
      db
        .select()
        .from(dataImportReceipts)
        .where(
          and(
            eq(dataImportReceipts.userId, scope.userId),
            eq(dataImportReceipts.accountId, scope.accountId),
            eq(dataImportReceipts.requestId, requestId),
          ),
        )
        .get()?.result ?? null
    );
  }

  async findReceipt(scope: DataImportScope, requestId: string): Promise<DataImportReceipt | null> {
    return this.receipt(scope, requestId);
  }

  async targetDigest(scope: DataImportScope): Promise<string> {
    return this.db.transaction((tx) => dataImportBusinessDigest(this.readTables(tx), scope), {
      behavior: 'immediate',
    });
  }

  async preview(input: Parameters<DataImportRepository['preview']>[0]) {
    return this.db.transaction(
      (tx) =>
        planDataImportRestore(input.snapshot, this.readTables(tx), input.scope, input.now).preview,
    );
  }

  private assertQuiescent(input: DataImportCommand, db: DrizzleDatabase<Schema>): void {
    const operations = db.all<{
      id: string;
      user_id: string;
      account_id: string;
      state: string;
      record_json: string;
    }>(
      sql`SELECT id, user_id, account_id, state, record_json FROM plugin_operations WHERE state IN ('pending','executing','unknown')`,
    );
    for (const operation of operations) {
      const tool = (JSON.parse(operation.record_json) as { tool?: string }).tool;
      // 只排除「已核验的本次导入自身」：id（= requestId）、账户、owner、状态、工具名全部对上。
      // 同账户其它 user 的操作不因 userId 不同被漏掉。
      if (
        operation.id === input.requestId &&
        operation.account_id === input.scope.accountId &&
        operation.user_id === input.scope.userId &&
        operation.state === 'executing' &&
        tool === DATA_IMPORT_RESTORE_TOOL
      )
        continue;
      // 本导入替换全局业务事实（stocks/strategies 等共享表），其它账户的未终结操作同样阻断。
      throw new DataImportError(
        'busy',
        operation.account_id === input.scope.accountId
          ? '存在未终结的 Operation，恢复尚未提交'
          : '其它账户存在未终结的 Operation，全局业务恢复尚未提交',
      );
    }
    const leases = ['strategy_run_leases', 'watch_execution_lease', 'report_execution'];
    for (const table of leases) {
      if (db.all(sql.raw(`SELECT 1 FROM ${quote(table)} LIMIT 1`)).length !== 0)
        throw new DataImportError('busy', `存在执行控制状态: ${table}`);
    }
  }

  async commit(input: DataImportCommand): Promise<DataImportReceipt> {
    const requestHash = dataImportHash({
      scope: input.scope,
      archiveDigest: input.snapshot.archiveDigest,
      mode: 'restore-business-v1',
      version: input.snapshot.manifestVersion,
    });
    return this.db.transaction(
      (tx) => {
        const previous = this.receipt(input.scope, input.requestId, tx);
        if (previous !== null) {
          if (previous.requestHash !== requestHash)
            throw new DataImportError('conflict', '相同 requestId 对应不同导入内容');
          return previous;
        }
        this.assertQuiescent(input, tx);
        const current = this.readTables(tx);
        const currentDigest = dataImportBusinessDigest(current, input.scope);
        const candidates = tx
          .select()
          .from(dataImportReceipts)
          .where(
            and(
              eq(dataImportReceipts.userId, input.scope.userId),
              eq(dataImportReceipts.accountId, input.scope.accountId),
              eq(dataImportReceipts.archiveDigest, input.snapshot.archiveDigest),
            ),
          )
          .all();
        const original = candidates.find(
          (row) => row.requestHash === requestHash && row.result.postDigest === currentDigest,
        )?.result;
        if (original !== undefined) {
          const alias: DataImportReceipt = {
            ...original,
            requestId: input.requestId,
            originalRequestId: original.originalRequestId,
          };
          tx.insert(dataImportReceipts)
            .values({
              ...input.scope,
              requestId: input.requestId,
              requestHash,
              archiveDigest: input.snapshot.archiveDigest,
              originalRequestId: alias.originalRequestId,
              committedAt: alias.committedAt,
              result: alias,
            })
            .run();
          return alias;
        }
        // 备份只对「真的要写业务事实」的路径是前置条件：持久 alias 不写数据，
        // 它的正确性由 postDigest 相等保证。
        // 备份是提交的前置条件：必须是为本次快照做的、且对应现在这份目标事实。
        if (input.backup === undefined || input.backup.backupId === '')
          throw new DataImportError('stale', '缺少恢复前一致性备份，拒绝提交');
        if (input.backup.archiveDigest !== input.snapshot.archiveDigest)
          throw new DataImportError('conflict', '备份不是为本次快照生成的');
        if (input.backup.targetDigest !== currentDigest)
          throw new DataImportError('stale', '备份对应的目标状态已变化，请重新备份并重新预检');
        if (input.now > input.preview.expiresAt)
          throw new DataImportError('stale', '导入预检已过期');
        const plan = planDataImportRestore(
          input.snapshot,
          current,
          input.scope,
          input.preview.expiresAt - DATA_IMPORT_PREVIEW_TTL_MS,
        );
        if (plan.preview.previewHash !== input.preview.previewHash)
          throw new DataImportError('stale', '目标业务内容或快照已变化，请重新预检');
        for (const table of [...DATA_IMPORT_BUSINESS_TABLES].reverse()) {
          if (DATA_IMPORT_MANIFEST[table] === 'replace')
            tx.run(sql.raw(`DELETE FROM ${quote(table)}`));
        }
        for (const table of DATA_IMPORT_BUSINESS_TABLES) {
          const rows = plan.tables[table] ?? [];
          if (DATA_IMPORT_MANIFEST[table] === 'union') {
            // Preserve existing business request identities; equal rows were verified by the plan.
            const existing = new Set((current[table] ?? []).map((row) => dataImportRowHash(row)));
            for (const row of rows)
              if (!existing.has(dataImportRowHash(row))) this.insert(tx, table, row);
          } else for (const row of rows) this.insert(tx, table, row);
        }
        const actualTables = this.readTables(tx);
        this.rebuildFts(tx, actualTables);
        const postDigest = dataImportBusinessDigest(actualTables, input.scope);
        if (postDigest !== plan.preview.postDigest)
          throw new DataImportError('conflict', '写入后完整业务摘要与预检不一致');
        const receipt: DataImportReceipt = {
          requestId: input.requestId,
          originalRequestId: input.requestId,
          requestHash,
          archiveDigest: input.snapshot.archiveDigest,
          committedAt: input.now,
          postDigest,
          actual: Object.fromEntries(
            DATA_IMPORT_BUSINESS_TABLES.map((table) => [table, actualTables[table]?.length ?? 0]),
          ),
        };
        tx.insert(dataImportReceipts)
          .values({
            ...input.scope,
            requestId: input.requestId,
            requestHash,
            archiveDigest: input.snapshot.archiveDigest,
            originalRequestId: input.requestId,
            committedAt: input.now,
            result: receipt,
          })
          .run();
        return receipt;
      },
      { behavior: 'immediate' },
    );
  }

  /**
   * `research_document_fts` 是派生投影（manifest: rebuild），必须与已写入的
   * research_document_chunks / research_document_index 在同事务内重建并核对，
   * 不能只标 rebuild 而从不执行。FTS shadow 内表不复制，由 fts5 自己维护。
   */
  private rebuildFts(db: DrizzleDatabase<Schema>, tables: DataImportTables): void {
    const rows = buildDataImportFts(tables);
    const present =
      db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'research_document_fts'`,
      ).length !== 0;
    if (!present) {
      if (rows.length === 0) return;
      throw new DataImportError('schema', '目标缺少 research_document_fts 投影，无法重建');
    }
    db.run(sql`DELETE FROM research_document_fts`);
    const columns = ['document_id', 'ordinal', 'content_hash', 'title', 'heading_path', 'body'];
    for (const row of rows) {
      db.run(
        sql`${sql.raw(`INSERT INTO research_document_fts (${columns.map(quote).join(',')}) VALUES (`)}${sql.join(
          columns.map((column) => sql`${row[column] ?? null}`),
          sql`, `,
        )}${sql.raw(')')}`,
      );
    }
    const actual = db.all<Record<string, unknown>>(
      sql.raw(`SELECT ${columns.map(quote).join(',')} FROM research_document_fts`),
    );
    const project = (list: readonly Record<string, unknown>[]) =>
      list.map((row) => canonicalDataImportJson(row)).sort();
    const expected = project(
      rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column] ?? null]))),
    );
    if (project(actual).join('\n') !== expected.join('\n'))
      throw new DataImportError('graph', 'FTS 投影与文档/分块不一致');
  }

  private insert(db: DrizzleDatabase<Schema>, table: string, row: DataImportRow): void {
    const columns = Object.keys(row);
    const statement = sql`${sql.raw(`INSERT INTO ${quote(table)} (${columns.map(quote).join(',')}) VALUES (`)}${sql.join(
      columns.map((column) => sql`${row[column]}`),
      sql`, `,
    )}${sql.raw(')')}`;
    db.run(statement);
  }
}
