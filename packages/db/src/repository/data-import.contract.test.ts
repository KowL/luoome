import {
  type DataImportScope,
  type DataImportSnapshot,
  type DataImportStorageSchema,
  type DataImportTables,
  money,
} from '@luoome/core';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDrizzleRepos } from '../client.js';
import { DATA_IMPORT_BUSINESS_TABLES } from '../data-import-manifest.js';
import { registerDataImportContractTests } from './data-import.contract-tests.js';
import { DrizzleDataImportRepository } from './drizzle/data-import.js';
import { InMemoryDataImportRepository } from './memory/data-import.js';
import { createInMemoryRepos } from './memory/index.js';

const scope: DataImportScope = { userId: 'import-owner', accountId: 'import-account' };
const accountRow = (name: string) => ({
  id: scope.accountId,
  name,
  kind: 'real',
  currency: 'CNY',
  initial_capital: 1000,
  cash_balance: 1000,
  created_at: 1000,
});
const tables = (name: string): DataImportTables => ({
  ...Object.fromEntries(DATA_IMPORT_BUSINESS_TABLES.map((table) => [table, []])),
  accounts: [accountRow(name)],
});

registerDataImportContractTests('memory-row-state', async () => {
  const schema: DataImportStorageSchema = Object.fromEntries(
    DATA_IMPORT_BUSINESS_TABLES.map((table) => [
      table,
      {
        columns: [{ name: 'id', type: 'TEXT', notNull: true, primaryKey: 1, hidden: 0 }],
        indexes: [],
      },
    ]),
  );
  const source: DataImportSnapshot = {
    format: 'sqlite',
    manifestVersion: 1,
    archiveDigest: 'a'.repeat(64),
    schema,
    tables: tables('source-import-name'),
    ignoredCounts: {},
  };
  let repository = new InMemoryDataImportRepository({
    tables: tables('target-before-import'),
    receipts: [],
    operations: [],
  });
  return {
    get repository() {
      return repository;
    },
    scope,
    source,
    async readName() {
      return String(repository.snapshot().tables.accounts?.[0]?.name ?? '') || null;
    },
    async changeName(name) {
      const state = repository.snapshot();
      repository = new InMemoryDataImportRepository({
        ...state,
        tables: { ...state.tables, accounts: [accountRow(name)] },
      });
    },
    async setOperation(state, overrides = {}) {
      const current = repository.snapshot();
      repository = new InMemoryDataImportRepository({
        ...current,
        operations: [
          {
            id: overrides.id ?? 'other-operation',
            userId: overrides.userId ?? 'another-user',
            accountId: overrides.accountId ?? scope.accountId,
            tool: overrides.tool ?? 'close_holding',
            state,
          },
        ],
      });
    },
    async reopen() {
      repository = new InMemoryDataImportRepository(repository.snapshot());
    },
    close() {},
  };
});

registerDataImportContractTests('bun-sqlite', async () => {
  const handle = createDrizzleRepos(':memory:');
  await handle.repos.account.save({
    id: scope.accountId,
    name: 'target-before-import',
    currency: 'CNY',
    initialCapital: money(1000),
    cashBalance: money(1000),
    kind: 'real',
    createdAt: new Date(1000),
  });
  const schema: DataImportStorageSchema = Object.fromEntries(
    DATA_IMPORT_BUSINESS_TABLES.map((table) => [
      table,
      {
        columns: handle.db
          .all<{ name: string; type: string; notnull: number; pk: number; hidden: number }>(
            sql.raw(`PRAGMA table_xinfo("${table}")`),
          )
          .map((column) => ({
            name: column.name,
            type: column.type,
            notNull: Boolean(column.notnull),
            primaryKey: column.pk,
            hidden: column.hidden,
          })),
        indexes: [],
      },
    ]),
  );
  const source: DataImportSnapshot = {
    format: 'sqlite',
    manifestVersion: 1,
    archiveDigest: 'a'.repeat(64),
    schema,
    tables: tables('source-import-name'),
    ignoredCounts: {},
  };
  let repository = new DrizzleDataImportRepository(handle.db);
  return {
    get repository() {
      return repository;
    },
    scope,
    source,
    async readName() {
      return (await handle.repos.account.findById(scope.accountId))?.name ?? null;
    },
    async changeName(name) {
      handle.db.run(sql`UPDATE accounts SET name = ${name} WHERE id = ${scope.accountId}`);
    },
    async setOperation(state, overrides = {}) {
      handle.db.run(
        sql`INSERT INTO plugin_operations (id,user_id,account_id,state,claim_token,updated_at,record_json) VALUES (${overrides.id ?? 'other-operation'},${overrides.userId ?? 'another-user'},${overrides.accountId ?? scope.accountId},${state},NULL,1,${JSON.stringify({ tool: overrides.tool ?? 'close_holding' })})`,
      );
    },
    async reopen() {
      repository = new DrizzleDataImportRepository(handle.db);
    },
    close() {
      handle.close();
    },
  };
});

describe('T48 memory 替身边界', () => {
  it('createInMemoryRepos 不装配内存导入替身，生产装配不会误用', () => {
    expect(createInMemoryRepos().dataImport).toBeUndefined();
  });
});

describe('T48 FTS 投影在提交内重建', () => {
  it('提交会清掉陈旧 FTS 行，而不是只标 rebuild', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      await handle.repos.account.save({
        id: scope.accountId,
        name: 'target-before-import',
        currency: 'CNY',
        initialCapital: money(1000),
        cashBalance: money(1000),
        kind: 'real',
        createdAt: new Date(1000),
      });
      // 目标里留一条与任何文档都不对应的陈旧投影。
      handle.db.run(
        sql`INSERT INTO research_document_fts (document_id, ordinal, content_hash, title, heading_path, body) VALUES ('stale','0','x','stale','','stale')`,
      );
      const schema: DataImportStorageSchema = Object.fromEntries(
        DATA_IMPORT_BUSINESS_TABLES.map((table) => [
          table,
          {
            columns: handle.db
              .all<{ name: string; type: string; notnull: number; pk: number; hidden: number }>(
                sql.raw(`PRAGMA table_xinfo("${table}")`),
              )
              .map((column) => ({
                name: column.name,
                type: column.type,
                notNull: Boolean(column.notnull),
                primaryKey: column.pk,
                hidden: column.hidden,
              })),
            indexes: [],
          },
        ]),
      );
      const source: DataImportSnapshot = {
        format: 'sqlite',
        manifestVersion: 1,
        archiveDigest: 'c'.repeat(64),
        schema,
        tables: tables('source-import-name'),
        ignoredCounts: {},
      };
      const repository = new DrizzleDataImportRepository(handle.db);
      const preview = await repository.preview({ scope, snapshot: source, now: 1000 });
      await repository.commit({
        scope,
        snapshot: source,
        preview,
        now: 1001,
        requestId: 'fts-a',
        backup: {
          backupId: 'fixture-backup',
          archiveDigest: source.archiveDigest,
          targetDigest: await repository.targetDigest(scope),
        },
      });
      expect(
        handle.db.all<{ count: number }>(sql`SELECT count(*) AS count FROM research_document_fts`),
      ).toEqual([{ count: 0 }]);
    } finally {
      handle.close();
    }
  });
});

// task-35：导出 → preview → restore 的真 round-trip（真实 sqlite，不是内存替身）。
describe('task-35 export_business_data round-trip', () => {
  it('导出的表集合与 restore 读集合一致，且能通过 preview 与 commit', async () => {
    const handle = createDrizzleRepos(':memory:');
    await handle.repos.account.save({
      id: scope.accountId,
      name: 'round-trip-account',
      currency: 'CNY',
      initialCapital: money(1000),
      cashBalance: money(1000),
      kind: 'real',
      createdAt: new Date(1000),
    });

    const repository = handle.repos.dataImport;
    if (repository === undefined) throw new Error('missing data import repository');
    // 1) 导出当前业务事实。
    const exported = await repository.exportBusinessTables();
    // 导出的表集合**就是** manifest 的业务表集合（同一份常量，不是两处维护）。
    expect(Object.keys(exported.tables).sort()).toEqual([...DATA_IMPORT_BUSINESS_TABLES].sort());
    // 至少有一条真数据（accounts），证明不是空跑。
    expect(exported.tables.accounts?.length ?? 0).toBeGreaterThan(0);
    expect(exported.digest).toMatch(/^[a-f0-9]{64}$/);

    // 2) 真实表结构（preview 需要它来核对列）。
    const schema: DataImportStorageSchema = Object.fromEntries(
      DATA_IMPORT_BUSINESS_TABLES.map((table) => [
        table,
        {
          columns: handle.db
            .all<{ name: string; type: string; notnull: number; pk: number; hidden: number }>(
              sql.raw(`PRAGMA table_xinfo("${table}")`),
            )
            .map((column) => ({
              name: column.name,
              type: column.type,
              notNull: Boolean(column.notnull),
              primaryKey: column.pk,
              hidden: column.hidden,
            })),
          indexes: [],
        },
      ]),
    );
    const snapshot: DataImportSnapshot = {
      format: 'sqlite',
      manifestVersion: 1,
      archiveDigest: exported.digest,
      schema,
      tables: exported.tables,
      ignoredCounts: {},
    };

    // 3) preview 必须成功（「导出的东西能被吃回去」的直接证据）。
    const preview = await repository.preview({
      scope,
      snapshot,
      now: Date.now(),
    });
    expect(preview).toBeDefined();

    // 4) commit：必须带**同一次 preview 的 ref**（commit 会在事务内复核它）。
    const receipt = await repository.commit({
      scope,
      requestId: 'round-trip-request',
      snapshot,
      // preview 结果本身就是合法的 `DataImportPreviewRef`（它 extends 那个接口）。
      preview,
      backup: {
        backupId: 'a'.repeat(32),
        archiveDigest: exported.digest,
        targetDigest: await repository.targetDigest(scope),
      },
      now: Date.now(),
    });
    expect(receipt.requestId).toBe('round-trip-request');
    handle.close();
  });
});
