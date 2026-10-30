// @luoome/db/node 的 Node 合约测试（node:sqlite driver）。
//
// 文件名刻意不用 `.test.ts`：`bun test packages/db` 会在 Bun 运行时加载同目录测试，
// 而 bun:sqlite 环境无法加载 node:sqlite。根 vitest config 显式 include 本文件，
// 由 Node（22/24）通过 `bun run test:db:node` 执行。
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import type {
  AnalysisContext,
  AnalysisJob,
  DataImportRow,
  DataImportScope,
  PluginAutomationGrant,
  PluginOperation,
  PluginOperationProof,
  StrategyDslV1,
  TradingPlan,
} from '@luoome/core';
import {
  reportScopeKey,
  STANDARD_DISCLAIMERS,
  strategyDefinitionHash,
  tradingPlanVersionId,
} from '@luoome/core';
import { eq, sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DATA_IMPORT_BUSINESS_TABLES, DATA_IMPORT_MANIFEST } from './data-import-manifest.js';
import {
  assertDataImportRowScope,
  hasDataTransferValidator,
  validateDataTransferRow,
} from './data-transfer-contract.js';
import { createNodeDrizzleRepos, ensureSchema, type NodeDrizzleReposHandle } from './node.js';
import { readDataImportStorageSchema, readSqliteImportSnapshot } from './node-data-import.js';
import { applyNodePragmas, drizzleNodeSqlite } from './node-sqlite-driver.js';
import {
  makeAccount,
  makeAdvice,
  makeHolding,
  makeReport,
  makeStock,
  makeWorkflowRun,
  registerRepositoryContractTests,
} from './repository/contract-tests.js';
import { registerDataImportContractTests } from './repository/data-import.contract-tests.js';
import { DrizzleDataImportRepository } from './repository/drizzle/data-import.js';
import type { DrizzleAdviceRepository } from './repository/drizzle/index.js';
import * as schema from './schema/index.js';

// Node 入口与 Bun/memory 跑同一套 repository 契约；factory 换成 node:sqlite :memory:。
registerRepositoryContractTests('node-sqlite', () => {
  const handle = createNodeDrizzleRepos(':memory:');
  return {
    repos: handle.repos,
    readOutcome: (adviceId: string) =>
      (handle.repos.advice as DrizzleAdviceRepository).getOutcome(adviceId),
    close: handle.close,
  };
});

const tempDirs: string[] = [];

const makeTempDbPath = (name = 'luoome.db'): string => {
  const dir = mkdtempSync(join(tmpdir(), 'luoome-node-db-'));
  tempDirs.push(dir);
  return join(dir, name);
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const clientOf = (db: unknown): DatabaseSync => (db as { $client: DatabaseSync }).$client;

const executedSqlOf = (db: unknown): string[] =>
  (db as { session: { executedSql: string[] } }).session.executedSql;

const countTables = (db: { get<T = unknown>(query: ReturnType<typeof sql>): T }): number =>
  Number(
    db.get<{ n: number }>(sql`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'`).n,
  );

describe('node:sqlite 入口：连接、pragma 与幂等迁移', () => {
  it(':memory: 跳过 WAL，pragma 与 bun 入口一致，ensureSchema 两次幂等', () => {
    const handle = createNodeDrizzleRepos(':memory:');
    try {
      const client = clientOf(handle.db);
      expect(client.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'memory' });
      expect(client.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
      expect(client.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      const before = countTables(handle.db);
      expect(before).toBeGreaterThan(50);
      ensureSchema(handle.db);
      ensureSchema(handle.db);
      expect(countTables(handle.db)).toBe(before);
    } finally {
      handle.close();
    }
  });

  it('文件库用 WAL + synchronous NORMAL，重开后数据仍在（含 Date/JSON 往返）', async () => {
    const path = makeTempDbPath();
    const first = createNodeDrizzleRepos(path);
    try {
      const client = clientOf(first.db);
      expect(client.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
      expect(client.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 1 });
      await first.repos.account.save(makeAccount('persist-account'));
      await first.repos.advice.save(makeAdvice('persist-advice'));
    } finally {
      first.close();
    }
    const second = createNodeDrizzleRepos(path);
    try {
      expect(await second.repos.account.findById('persist-account')).toEqual(
        makeAccount('persist-account'),
      );
      const advice = await second.repos.advice.findById('persist-advice');
      expect(advice?.createdAt).toEqual(new Date('2026-07-02T01:00:00.000Z'));
      expect(advice?.basedOn.dataAsOf).toEqual(new Date('2026-07-02T01:00:00.000Z'));
      expect(advice?.risks).toEqual(['大盘系统性下行风险']);
    } finally {
      second.close();
    }
  });

  it('旧库副本重跑迁移：数据保留、表数稳定、缺列被补回', async () => {
    const path = makeTempDbPath();
    const first = createNodeDrizzleRepos(path);
    try {
      await first.repos.account.save(makeAccount('legacy-account'));
    } finally {
      first.close();
    }
    const second = createNodeDrizzleRepos(path);
    try {
      // 模拟旧库：删掉 v0.8 才加的列，重新执行共享 DDL 应通过 ALTER 迁移补回。
      second.db.run(sql`ALTER TABLE advices DROP COLUMN stock_name`);
      const tableCount = countTables(second.db);
      ensureSchema(second.db);
      ensureSchema(second.db);
      expect(countTables(second.db)).toBe(tableCount);
      const columns = second.db
        .all<{ name: string }>(sql`PRAGMA table_info(advices)`)
        .map((column) => column.name);
      expect(columns).toContain('stock_name');
      expect(await second.repos.account.findById('legacy-account')).toEqual(
        makeAccount('legacy-account'),
      );
    } finally {
      second.close();
    }
  });

  it('migrate:false 时不建表，显式 ensureSchema 仍可完成迁移', () => {
    const path = makeTempDbPath();
    const handle = createNodeDrizzleRepos(path, { migrate: false });
    try {
      expect(countTables(handle.db)).toBe(0);
      ensureSchema(handle.db);
      expect(countTables(handle.db)).toBeGreaterThan(50);
    } finally {
      handle.close();
    }
  });

  it('迁移失败时释放连接，文件锁不泄漏', () => {
    const path = makeTempDbPath();
    const seed = new DatabaseSync(path);
    try {
      // 与共享 DDL 冲突的残缺 accounts 表：迁移中的索引/回填语句会失败。
      seed.exec('CREATE TABLE accounts (id TEXT PRIMARY KEY)');
    } finally {
      seed.close();
    }
    expect(() => createNodeDrizzleRepos(path)).toThrow();
    const reopen = new DatabaseSync(path);
    try {
      reopen.exec('CREATE TABLE reopen_probe (id TEXT)');
    } finally {
      reopen.close();
    }
  });

  it('applyNodePragmas 可在裸连接上单独使用', () => {
    const path = makeTempDbPath();
    const client = new DatabaseSync(path);
    try {
      applyNodePragmas(client);
      expect(client.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
      expect(client.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    } finally {
      client.close();
    }
  });
});

describe('node:sqlite 入口：真实 repository 在 Node 下同语义', () => {
  let handle: NodeDrizzleReposHandle;

  beforeEach(() => {
    handle = createNodeDrizzleRepos(':memory:');
  });

  afterEach(() => {
    handle.close();
  });

  it('account/advice/analysis 三个 repo 的读写与 Bun 合约一致', async () => {
    await handle.repos.account.save(makeAccount('account-1'));
    expect(await handle.repos.account.findById('account-1')).toEqual(makeAccount('account-1'));

    const advice = makeAdvice('advice-1');
    await handle.repos.advice.save(advice);
    const storedAdvice = await handle.repos.advice.findById('advice-1');
    expect(storedAdvice).toMatchObject({
      id: 'advice-1',
      createdAt: advice.createdAt,
      validUntil: advice.validUntil,
      risks: advice.risks,
    });
    expect(storedAdvice?.basedOn).toEqual(advice.basedOn);

    const now = new Date('2026-10-22T04:00:00.000Z');
    const job: AnalysisJob = {
      id: 'job-1',
      kind: 'advice_stock',
      source: 'schedule',
      accountId: 'account-1',
      subject: { kind: 'stock', id: '600519.SH' },
      priority: 50,
      dedupeKey: 'key-1',
      payload: {},
      dataAsOf: now,
      notBefore: now,
      status: 'pending',
      attempts: 0,
      maxAttempts: 2,
      claimToken: null,
      claimedBy: null,
      leaseUntil: null,
      contextId: null,
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    const context: AnalysisContext = {
      id: 'context-1',
      jobId: 'job-1',
      kind: 'advice_stock',
      accountId: 'account-1',
      subject: job.subject,
      dataAsOf: now,
      facts: [{ id: 'quote', label: '行情', value: 100, evidenceIds: [] }],
      factIds: ['quote'],
      limitations: ['无实时盘口'],
      contextHash: 'a'.repeat(64),
      writeUntil: new Date(now.getTime() + 86_400_000),
      expiresAt: new Date(now.getTime() + 31 * 86_400_000),
      createdAt: now,
    };
    expect(await handle.repos.analysis.enqueue(job)).toEqual({ job, deduped: false });
    const claimed = await handle.repos.analysis.claim({
      accountId: 'account-1',
      jobId: 'job-1',
      owner: 'worker:test',
      token: 'token',
      now,
      leaseUntil: new Date(now.getTime() + 1000),
      context,
    });
    expect(claimed).toMatchObject({
      status: 'claimed',
      claimToken: 'token',
      contextId: 'context-1',
    });
    const storedContext = await handle.repos.analysis.findContext('account-1', 'context-1');
    expect(storedContext?.facts).toEqual(context.facts);
    expect(storedContext?.dataAsOf).toEqual(now);
    expect(storedContext?.writeUntil).toEqual(context.writeUntil);
  });

  it('复合主键、boolean、REAL、timestamp 与 RETURNING 走 drizzle 列映射', () => {
    const at = new Date('2026-07-01T01:00:00.000Z');
    const inserted = handle.db
      .insert(schema.watchRuleStates)
      .values({
        alertPlanId: null,
        poolId: 'pool-1',
        stockId: 'stock-1',
        ruleId: 'rule-1',
        active: true,
        firstTriggeredAt: at,
        lastEvaluatedAt: at,
        lastValue: 1.25,
        lastRecoveredAt: null,
      })
      .returning()
      .all();
    expect(inserted).toEqual([
      {
        alertPlanId: null,
        poolId: 'pool-1',
        stockId: 'stock-1',
        ruleId: 'rule-1',
        active: true,
        firstTriggeredAt: at,
        lastEvaluatedAt: at,
        lastValue: 1.25,
        lastRecoveredAt: null,
      },
    ]);
    expect(() =>
      handle.db
        .insert(schema.watchRuleStates)
        .values({
          alertPlanId: null,
          poolId: 'pool-1',
          stockId: 'stock-1',
          ruleId: 'rule-1',
          active: false,
          firstTriggeredAt: null,
          lastEvaluatedAt: at,
          lastValue: null,
          lastRecoveredAt: null,
        })
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
    const selected = handle.db
      .select()
      .from(schema.watchRuleStates)
      .where(eq(schema.watchRuleStates.poolId, 'pool-1'))
      .get();
    expect(selected).toMatchObject({ active: true, lastValue: 1.25, lastEvaluatedAt: at });
  });

  it('innerJoin 映射嵌套行（mapResultRow + joinsNotNullableMap）', async () => {
    const account = makeAccount('join-account');
    const stock = makeStock('join-stock', '002594');
    await handle.repos.account.save(account);
    await handle.repos.stock.save(stock);
    await handle.repos.holding.save(
      makeHolding('join-holding', { accountId: account.id, stockId: stock.id }),
    );

    const joined = handle.db
      .select({ accountId: schema.accounts.id, holdingId: schema.holdings.id })
      .from(schema.accounts)
      .innerJoin(schema.holdings, eq(schema.holdings.accountId, schema.accounts.id))
      .all();
    expect(joined).toEqual([{ accountId: 'join-account', holdingId: 'join-holding' }]);

    const nested = handle.db
      .select()
      .from(schema.accounts)
      .innerJoin(schema.holdings, eq(schema.holdings.accountId, schema.accounts.id))
      .all();
    expect(nested[0]?.accounts.name).toBe('账户-join-account');
    expect(nested[0]?.holdings.quantity).toBe(1000);
    expect(nested[0]?.holdings.avgCost).toBe(12.3456);
  });

  it('裸 sql 参数归一化：boolean→1/0、Date→毫秒、BLOB 原样；undefined 显式失败', () => {
    handle.db.run(sql`CREATE TABLE bind_probe (id TEXT PRIMARY KEY, flag INTEGER, ts INTEGER)`);
    const at = new Date('2026-07-01T01:00:00.000Z');
    handle.db.run(sql`INSERT INTO bind_probe (id, flag, ts) VALUES ('x', ${false}, ${at})`);
    expect(handle.db.get(sql`SELECT flag, ts FROM bind_probe WHERE id = 'x'`)).toEqual({
      flag: 0,
      ts: at.getTime(),
    });

    let undefinedError: unknown;
    try {
      // 裸 `${undefined}` 会被 drizzle 的 sql 模板直接省略，这里用 sql.param 显式绑定。
      handle.db.run(
        sql`INSERT INTO bind_probe (id, flag, ts) VALUES ('y', ${sql.param(undefined)}, ${at})`,
      );
    } catch (error) {
      undefinedError = error;
    }
    expect((undefinedError as { cause?: Error }).cause?.message).toMatch(/undefined/);

    handle.db.run(sql`CREATE TABLE blob_probe (id TEXT PRIMARY KEY, payload BLOB)`);
    const payload = new Uint8Array([0, 1, 127, 255]);
    handle.db.run(sql`INSERT INTO blob_probe (id, payload) VALUES ('b', ${payload})`);
    const blob = handle.db.get<{ payload: Uint8Array }>(
      sql`SELECT payload FROM blob_probe WHERE id = 'b'`,
    );
    expect(blob?.payload).toBeInstanceOf(Uint8Array);
    expect(Array.from(blob?.payload ?? [])).toEqual([0, 1, 127, 255]);
  });
});

describe('node:sqlite 入口：事务语义', () => {
  let handle: NodeDrizzleReposHandle;

  beforeEach(() => {
    handle = createNodeDrizzleRepos(':memory:');
  });

  afterEach(() => {
    handle.close();
  });

  it('throw 回滚、返回值透传', async () => {
    await handle.repos.account.save(makeAccount('tx-account'));
    expect(() =>
      handle.db.transaction((tx) => {
        tx.update(schema.accounts).set({ name: 'rolled-back' }).run();
        throw new Error('rollback-me');
      }),
    ).toThrow('rollback-me');
    expect((await handle.repos.account.findById('tx-account'))?.name).toBe('账户-tx-account');

    const result = handle.db.transaction((tx) => {
      tx.update(schema.accounts).set({ name: 'committed' }).run();
      return 'done';
    });
    expect(result).toBe('done');
    expect((await handle.repos.account.findById('tx-account'))?.name).toBe('committed');
  });

  it('behavior immediate/exclusive 发出对应的 BEGIN', () => {
    handle.db.transaction(() => undefined, { behavior: 'immediate' });
    handle.db.transaction(() => undefined, { behavior: 'exclusive' });
    expect(executedSqlOf(handle.db)).toEqual(
      expect.arrayContaining(['BEGIN IMMEDIATE', 'BEGIN EXCLUSIVE', 'COMMIT']),
    );
  });

  it('tx.transaction 嵌套 savepoint 局部回滚且不毒化外层', async () => {
    await handle.repos.account.save(makeAccount('nested-tx'));
    handle.db.transaction((tx) => {
      tx.update(schema.accounts)
        .set({ name: 'outer' })
        .where(eq(schema.accounts.id, 'nested-tx'))
        .run();
      try {
        tx.transaction((inner) => {
          inner
            .update(schema.accounts)
            .set({ name: 'inner' })
            .where(eq(schema.accounts.id, 'nested-tx'))
            .run();
          throw new Error('inner-rollback');
        });
      } catch (error) {
        expect((error as Error).message).toBe('inner-rollback');
      }
      tx.update(schema.accounts)
        .set({ name: 'outer-after' })
        .where(eq(schema.accounts.id, 'nested-tx'))
        .run();
    });
    expect((await handle.repos.account.findById('nested-tx'))?.name).toBe('outer-after');
  });

  it('嵌套 db.transaction() 降级为 savepoint', async () => {
    await handle.repos.account.save(makeAccount('nested-db'));
    handle.db.transaction((tx) => {
      tx.update(schema.accounts)
        .set({ name: 'outer' })
        .where(eq(schema.accounts.id, 'nested-db'))
        .run();
      const inner = handle.db.transaction((innerTx) => {
        innerTx
          .update(schema.accounts)
          .set({ name: 'inner' })
          .where(eq(schema.accounts.id, 'nested-db'))
          .run();
        return 'inner-result';
      });
      expect(inner).toBe('inner-result');
    });
    expect(executedSqlOf(handle.db)).toEqual(
      expect.arrayContaining(['SAVEPOINT drizzle_sp_0', 'RELEASE SAVEPOINT drizzle_sp_0']),
    );
    expect((await handle.repos.account.findById('nested-db'))?.name).toBe('inner');
  });

  it('嵌套 db.transaction() 回滚只撤销 savepoint 内写入', async () => {
    await handle.repos.account.save(makeAccount('nested-db-rollback'));
    handle.db.transaction((tx) => {
      tx.update(schema.accounts)
        .set({ name: 'outer' })
        .where(eq(schema.accounts.id, 'nested-db-rollback'))
        .run();
      try {
        handle.db.transaction((innerTx) => {
          innerTx
            .update(schema.accounts)
            .set({ name: 'inner' })
            .where(eq(schema.accounts.id, 'nested-db-rollback'))
            .run();
          throw new Error('nested-rollback');
        });
      } catch (error) {
        expect((error as Error).message).toBe('nested-rollback');
      }
    });
    expect((await handle.repos.account.findById('nested-db-rollback'))?.name).toBe('outer');
  });
});

describe('node:sqlite 入口：双连接', () => {
  it('第二个连接按 busy_timeout 等待后报 SQLITE_BUSY，锁释放后可恢复', async () => {
    const path = makeTempDbPath('lock.db');
    const first = createNodeDrizzleRepos(path);
    const second = createNodeDrizzleRepos(path);
    try {
      const firstClient = clientOf(first.db);
      const secondClient = clientOf(second.db);
      secondClient.exec('PRAGMA busy_timeout = 100');
      firstClient.exec('BEGIN IMMEDIATE');
      const startedAt = Date.now();
      const error = await second.repos.account.save(makeAccount('lock-account')).then(
        () => null,
        (cause: unknown) => cause,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/locked|busy/i);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
      firstClient.exec('ROLLBACK');
      await second.repos.account.save(makeAccount('lock-account'));
      expect(await second.repos.account.findById('lock-account')).toEqual(
        makeAccount('lock-account'),
      );
    } finally {
      first.close();
      second.close();
    }
  });

  it('两个连接并发认领同一 Operation 只有一个成功（CAS/fencing）', async () => {
    const path = makeTempDbPath('authority.db');
    const first = createNodeDrizzleRepos(path);
    let second: NodeDrizzleReposHandle | undefined;
    try {
      await first.repos.pluginAuthority.saveGrant(grant(), null);
      await first.repos.pluginAuthority.insertOperation(operation());
      second = createNodeDrizzleRepos(path);
      // 再次显式执行共享迁移，验证旧库副本两次迁移幂等。
      ensureSchema(first.db);
      ensureSchema(first.db);
      const claims = await Promise.all([
        first.repos.pluginAuthority.claimOperation(proof()),
        second.repos.pluginAuthority.claimOperation({ ...proof(), claimToken: 'second' }),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect((await second.repos.pluginAuthority.findOperation(proof()))?.state).toBe('executing');
      expect(await second.repos.pluginAuthority.findGrant('grant', 'u')).toEqual(grant());
    } finally {
      second?.close();
      first.close();
    }
  });

  it('drizzleNodeSqlite 可直接包装裸 DatabaseSync 连接', () => {
    const client = new DatabaseSync(':memory:');
    try {
      applyNodePragmas(client, { wal: false });
      const db = drizzleNodeSqlite(client);
      db.run(sql`CREATE TABLE probe (id TEXT PRIMARY KEY, value INTEGER)`);
      db.run(sql`INSERT INTO probe (id, value) VALUES ('p', 42)`);
      expect(db.get(sql`SELECT value FROM probe WHERE id = 'p'`)).toEqual({ value: 42 });
    } finally {
      client.close();
    }
  });
});

describe('T48 DDL 对齐：data_import_receipts', () => {
  it('Node 建表与 Drizzle 定义逐列一致，重复 ensureSchema 幂等且保留回执', () => {
    const path = makeTempDbPath('receipt-ddl.db');
    const handle = createNodeDrizzleRepos(path);
    try {
      const config = getTableConfig(schema.dataImportReceipts);
      const primaryKeyColumns = config.primaryKeys.flatMap((key) =>
        key.columns.map((column) => column.name),
      );
      const columns = handle.db.all<{ name: string; type: string; notnull: number; pk: number }>(
        sql.raw(`PRAGMA table_xinfo(${JSON.stringify(config.name)})`),
      );
      expect(
        columns.map((column) => ({
          name: column.name,
          type: column.type.toLowerCase(),
          notNull: column.notnull === 1,
          primaryKey: column.pk,
        })),
      ).toEqual(
        Object.values(config.columns).map((column) => ({
          name: column.name,
          type: column.getSQLType(),
          notNull: column.notNull,
          primaryKey: primaryKeyColumns.indexOf(column.name) + 1,
        })),
      );
      expect(columns.filter((column) => column.pk > 0).map((column) => column.name)).toEqual([
        'user_id',
        'account_id',
        'request_id',
      ]);
      expect(
        handle.db
          .all<{ sql: string }>(
            sql`SELECT sql FROM sqlite_master WHERE name = 'data_import_receipts'`,
          )[0]
          ?.sql.replace(/\s+/g, ' ')
          .trim(),
      ).toBe(
        'CREATE TABLE data_import_receipts ( user_id TEXT NOT NULL, account_id TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, archive_digest TEXT NOT NULL, original_request_id TEXT NOT NULL, committed_at INTEGER NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY (user_id, account_id, request_id) )',
      );
      clientOf(handle.db)
        .prepare(
          `INSERT INTO data_import_receipts (user_id,account_id,request_id,request_hash,archive_digest,original_request_id,committed_at,result_json)
           VALUES ('u','a','r','${'a'.repeat(64)}','${'b'.repeat(64)}','r',1000,'{}')`,
        )
        .run();
      ensureSchema(handle.db);
      ensureSchema(handle.db);
      expect(
        handle.db.all<{ request_id: string }>(sql`SELECT request_id FROM data_import_receipts`),
      ).toEqual([{ request_id: 'r' }]);
    } finally {
      handle.close();
    }
  });
});

describe('T21 旧单值计划读时归一化（Node 文件库）', () => {
  it('旧行归一化为退化区间，两次启动后 plan_json 字节与 status 不变', async () => {
    const path = makeTempDbPath('t21-legacy-plan.db');
    const planJson = JSON.stringify({
      id: 'account:a:stock:600519.SH',
      version: 1,
      accountId: 'a',
      stockId: '600519.SH',
      status: 'active',
      action: 'add',
      entryPriceLow: 10,
      entryPriceHigh: 11,
      entryConditions: [],
      invalidEntryConditions: [],
      position: {
        currentPct: 5,
        targetPct: 30,
        deltaPct: 25,
        constraintStatus: 'passed',
        constraintReasons: [],
        prerequisiteActions: [],
      },
      holding: {
        minTradingDays: 1,
        maxTradingDays: 5,
        nextReviewAt: T1,
        earlyExitConditions: [],
        extensionBasis: [],
      },
      exit: { conditions: [], triggerConditions: [], canSellNow: true },
      validFrom: T0,
      validUntil: T2,
      invalidationConditions: ['账户事实变化'],
      accountFactsAsOf: T0,
      accountFactsDigest: 'legacy-node-digest',
      marketFacts: [],
      evidence: [],
      source: { strategyIds: [], strategyVersionIds: [], runIds: [], signalIds: [], adviceIds: [] },
      explanation: { supportingEvidenceIds: [], counterEvidence: [], risks: [], unknowns: [] },
      confidence: 50,
      createdAt: T0,
    });
    const first = createNodeDrizzleRepos(path);
    try {
      first.db.run(sql`
        INSERT INTO trading_plans
          (version_id, plan_id, version, account_id, stock_id, status, valid_from, valid_until, created_at, plan_json)
        VALUES
          ('account:a:stock:600519.SH:v1', 'account:a:stock:600519.SH', 1, 'a', '600519.SH', 'active',
           ${T0}, ${T2}, ${T0}, ${planJson})
      `);
      const plan = await first.repos.tradingPlan.findByVersionId('account:a:stock:600519.SH:v1');
      expect(plan).toMatchObject({
        status: 'active',
        position: {
          targetPctRange: { min: 30, max: 30 },
          appliedPct: 30,
          fallbackPct: 30,
          rangePick: { ruleId: 'lower-bound' },
        },
      });
      expect(plan?.position).not.toHaveProperty('deltaPct');
    } finally {
      first.close();
    }
    const before = createHash('sha256').update(planJson).digest('hex');
    const second = createNodeDrizzleRepos(path);
    try {
      const plan = await second.repos.tradingPlan.findByVersionId('account:a:stock:600519.SH:v1');
      expect(plan).toMatchObject({ status: 'active' });
      const row = clientOf(second.db)
        .prepare(
          "SELECT plan_json FROM trading_plans WHERE version_id = 'account:a:stock:600519.SH:v1'",
        )
        .get() as { plan_json: string };
      expect(createHash('sha256').update(row.plan_json).digest('hex')).toBe(before);
      expect(JSON.parse(row.plan_json)).toEqual(JSON.parse(planJson));
    } finally {
      second.close();
    }
  });
});

describe('T48 B1a SQLite 只读输入预检', () => {
  const scope = { userId: 'import-owner', accountId: 'import-account' };
  const state = (path: string) => ({
    bytes: createHash('sha256').update(readFileSync(path)).digest('hex'),
    mtime: statSync(path).mtimeMs,
    files: readdirSync(join(path, '..')).sort(),
  });
  const fixture = async () => {
    const sourcePath = makeTempDbPath('source.db');
    const targetPath = makeTempDbPath('target.db');
    const source = createNodeDrizzleRepos(sourcePath);
    await source.repos.account.save(makeAccount(scope.accountId));
    source.close();
    createNodeDrizzleRepos(targetPath).close();
    const target = new DatabaseSync(targetPath, { readOnly: true });
    const expected = readDataImportStorageSchema(target);
    target.close();
    return { sourcePath, targetPath, expected };
  };

  it('当前 schema 真文件读取不改变来源/目标业务、文件内容或目录', async () => {
    const { sourcePath, targetPath, expected } = await fixture();
    const before = { source: state(sourcePath), target: state(targetPath) };
    const result = readSqliteImportSnapshot(sourcePath, scope, expected);
    expect(result.format).toBe('sqlite');
    expect(result.tables.accounts?.map((row) => row.id)).toEqual([scope.accountId]);
    expect(result.archiveDigest).toBe(before.source.bytes);
    expect({ source: state(sourcePath), target: state(targetPath) }).toEqual(before);
  });

  it('未知表和非当前列结构报错且不修复输入', async () => {
    const { sourcePath, targetPath, expected } = await fixture();
    const source = new DatabaseSync(sourcePath);
    source.exec('CREATE TABLE unexpected_import_table (id TEXT)');
    source.close();
    const before = { source: state(sourcePath), target: state(targetPath) };
    expect(() => readSqliteImportSnapshot(sourcePath, scope, expected)).toThrow('未声明的表');
    expect({ source: state(sourcePath), target: state(targetPath) }).toEqual(before);
    const change = new DatabaseSync(sourcePath);
    change.exec('DROP TABLE unexpected_import_table');
    change.exec('ALTER TABLE accounts ADD COLUMN unsupported_import_field TEXT');
    change.close();
    expect(() => readSqliteImportSnapshot(sourcePath, scope, expected)).toThrow(
      '表结构不是当前支持版本',
    );
  });

  it('其它账户和已知 JSON 内嵌账户归属均报错', async () => {
    const { sourcePath, expected } = await fixture();
    const source = createNodeDrizzleRepos(sourcePath);
    await source.repos.account.save(makeAccount('other-account'));
    source.close();
    expect(() => readSqliteImportSnapshot(sourcePath, scope, expected)).toThrow('其它账户');
    const mutate = createNodeDrizzleRepos(sourcePath);
    mutate.db.run(sql`DELETE FROM accounts WHERE id = 'other-account'`);
    await mutate.repos.advice.save(makeAdvice('nested-import-advice'));
    clientOf(mutate.db)
      .prepare('UPDATE advices SET based_on = ?')
      .run(JSON.stringify({ accountId: 'other-account' }));
    mutate.close();
    expect(() => readSqliteImportSnapshot(sourcePath, scope, expected)).toThrow('其它账户');
  });

  it('sqliteX 前缀未知表不会被当作 SQLite 内部表跳过', async () => {
    const { sourcePath, expected } = await fixture();
    const source = new DatabaseSync(sourcePath);
    source.exec('CREATE TABLE sqliteXhidden_scope (account_id TEXT)');
    source.prepare('INSERT INTO sqliteXhidden_scope VALUES (?)').run('other-account');
    source.close();
    expect(() => readSqliteImportSnapshot(sourcePath, scope, expected)).toThrow('未声明的表');
  });

  it.each(['constructor', '__proto__', 'toString'])(
    '继承属性表名 %s 也必须属于显式清单',
    async (name) => {
      const { sourcePath, expected } = await fixture();
      const source = new DatabaseSync(sourcePath);
      source.exec(`CREATE TABLE "${name}" (account_id TEXT)`);
      source.close();
      expect(() => readSqliteImportSnapshot(sourcePath, scope, expected)).toThrow('未声明的表');
    },
  );

  it('隐藏生成列和丢失唯一索引不属于当前 schema', async () => {
    const generated = await fixture();
    const source = new DatabaseSync(generated.sourcePath);
    source.exec(
      "ALTER TABLE accounts ADD COLUMN hidden_version_field TEXT GENERATED ALWAYS AS ('unexpected') VIRTUAL",
    );
    source.close();
    expect(() => readSqliteImportSnapshot(generated.sourcePath, scope, generated.expected)).toThrow(
      '表结构不是当前支持版本',
    );
    const missing = await fixture();
    const another = new DatabaseSync(missing.sourcePath);
    another.exec('DROP INDEX stocks_code_exchange_unique');
    another.close();
    expect(() => readSqliteImportSnapshot(missing.sourcePath, scope, missing.expected)).toThrow(
      '表结构不是当前支持版本',
    );
  });

  it('孤立普通表不能伪装成 FTS shadow', async () => {
    const { sourcePath, expected } = await fixture();
    const source = new DatabaseSync(sourcePath);
    source.exec('DROP TABLE research_document_fts');
    source.exec('CREATE TABLE research_document_fts_data (account_id TEXT)');
    source.prepare('INSERT INTO research_document_fts_data VALUES (?)').run('other-account');
    source.close();
    expect(() => readSqliteImportSnapshot(sourcePath, scope, expected)).toThrow('FTS shadow');
  });

  it('portfolio Advice 的 subject_id 也必须绑定当前账户', async () => {
    const { sourcePath, expected } = await fixture();
    const source = createNodeDrizzleRepos(sourcePath);
    await source.repos.advice.save(makeAdvice('portfolio-scope-advice'));
    clientOf(source.db)
      .prepare('UPDATE advices SET subject_kind = ?, subject_id = ?')
      .run('portfolio', 'other-account');
    source.close();
    expect(() => readSqliteImportSnapshot(sourcePath, scope, expected)).toThrow('其它账户');
  });

  it('工作流所有声明 JSON 存储摘要都会递归核验账户', async () => {
    const { sourcePath, expected } = await fixture();
    const source = createNodeDrizzleRepos(sourcePath);
    await source.repos.workflowRun.save(
      makeWorkflowRun('scope-workflow', {
        inputSummary: { accountId: scope.accountId },
        outputSummary: { accountId: scope.accountId },
      }),
    );
    source.close();
    expect(readSqliteImportSnapshot(sourcePath, scope, expected).tables.workflow_runs).toHaveLength(
      1,
    );
    const mutate = new DatabaseSync(sourcePath);
    mutate
      .prepare('UPDATE workflow_runs SET input_summary = ?')
      .run(JSON.stringify({ accountId: 'other-account' }));
    mutate.close();
    expect(() => readSqliteImportSnapshot(sourcePath, scope, expected)).toThrow('其它账户');
    const output = new DatabaseSync(sourcePath);
    output
      .prepare('UPDATE workflow_runs SET input_summary = ?, output_summary = ?')
      .run(
        JSON.stringify({ accountId: scope.accountId }),
        JSON.stringify({ accountId: 'other-account' }),
      );
    output.close();
    expect(() => readSqliteImportSnapshot(sourcePath, scope, expected)).toThrow('其它账户');
  });

  it('portfolio关注来源按 sourceId/sourceKey 映射核验账户', async () => {
    const { sourcePath, expected } = await fixture();
    const source = createNodeDrizzleRepos(sourcePath);
    const at = new Date('2026-10-01T00:00:00Z');
    await source.repos.stock.save(makeStock('portfolio-stock', '600519'));
    await source.repos.watchlist.save({
      id: 'portfolio-import',
      name: '持仓关注',
      kind: 'portfolio',
      membershipPolicy: 'synced',
      enabled: false,
      createdAt: at,
      updatedAt: at,
    });
    await source.repos.watchlistMember.saveMember({
      id: 'portfolio-member',
      watchlistId: 'portfolio-import',
      stockId: 'portfolio-stock',
      stage: 'discovered',
      priority: 'normal',
      firstAddedAt: at,
      lastActivityAt: at,
    });
    await source.repos.watchlistMember.saveSource({
      id: 'portfolio-source',
      memberId: 'portfolio-member',
      kind: 'portfolio',
      sourceKey: `portfolio:${scope.accountId}`,
      sourceId: scope.accountId,
      ownerUserId: scope.userId,
      reason: '持仓历史',
      status: 'ended',
      evidence: [],
      validFrom: at,
      validUntil: at,
    });
    source.close();
    expect(
      readSqliteImportSnapshot(sourcePath, scope, expected).tables.watchlist_member_sources,
    ).toHaveLength(1);
    const mutate = new DatabaseSync(sourcePath);
    mutate
      .prepare('UPDATE watchlist_member_sources SET source_key = ?, source_id = ?')
      .run('portfolio:other-account', 'other-account');
    mutate.close();
    expect(() => readSqliteImportSnapshot(sourcePath, scope, expected)).toThrow('其它账户');
  });

  it('报告存储scope_key须与合法scope_json一致', async () => {
    const { sourcePath, expected } = await fixture();
    const source = createNodeDrizzleRepos(sourcePath);
    await source.repos.report.upsertForPeriod(
      makeReport('scope-report', {
        scope: { kind: 'account', accountId: scope.accountId },
        notificationPolicy: 'never',
      }),
    );
    source.close();
    expect(readSqliteImportSnapshot(sourcePath, scope, expected).tables.reports).toHaveLength(1);
    const mutate = new DatabaseSync(sourcePath);
    mutate.prepare('UPDATE reports SET scope_key = ?').run('account:other-account');
    mutate.close();
    expect(() => readSqliteImportSnapshot(sourcePath, scope, expected)).toThrow('scope_key');
  });

  it('纯validator也拒绝Object继承属性名', () => {
    for (const name of ['constructor', '__proto__', 'toString']) {
      expect(hasDataTransferValidator(name)).toBe(false);
      expect(() => validateDataTransferRow(name, {})).toThrow('尚未支持');
    }
  });

  it('真实在线backup快照零sidecar，活WAL和非空journal明确报错', async () => {
    const { sourcePath, expected } = await fixture();
    const source = new DatabaseSync(sourcePath);
    source.exec('PRAGMA wal_autocheckpoint=0');
    source.prepare('UPDATE accounts SET name = ?').run('live-wal-owner');
    const copyPath = makeTempDbPath('backup space # 中文.db');
    try {
      await backup(source, copyPath);
      expect(() => readSqliteImportSnapshot(sourcePath, scope, expected)).toThrow('WAL');
      const before = state(copyPath);
      expect(readSqliteImportSnapshot(copyPath, scope, expected).tables.accounts?.[0]?.name).toBe(
        'live-wal-owner',
      );
      expect(state(copyPath)).toEqual(before);
      writeFileSync(`${copyPath}-journal`, Buffer.alloc(512, 1));
      expect(() => readSqliteImportSnapshot(copyPath, scope, expected)).toThrow('journal');
    } finally {
      source.close();
    }
  });

  it('SQL 文本与损坏二进制不会作为脚本执行', async () => {
    const { expected } = await fixture();
    const path = makeTempDbPath('input.db');
    writeFileSync(path, 'CREATE TABLE should_never_execute (id TEXT);');
    const before = state(path);
    expect(() => readSqliteImportSnapshot(path, scope, expected)).toThrow('不支持 SQL 脚本');
    expect(state(path)).toEqual(before);
    writeFileSync(path, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(100)]));
    expect(() => readSqliteImportSnapshot(path, scope, expected)).toThrow('SQLite');
  });
});

registerDataImportContractTests('node-sqlite-file', async () => {
  const scope = { userId: 'import-owner', accountId: 'import-account' };
  const sourcePath = makeTempDbPath('atomic-source.db');
  const targetPath = makeTempDbPath('atomic-target.db');
  const sourceHandle = createNodeDrizzleRepos(sourcePath);
  await sourceHandle.repos.account.save(
    makeAccount(scope.accountId, { name: 'source-import-name' }),
  );
  sourceHandle.close();
  let handle = createNodeDrizzleRepos(targetPath);
  await handle.repos.account.save(makeAccount(scope.accountId, { name: 'target-before-import' }));
  const source = readSqliteImportSnapshot(
    sourcePath,
    scope,
    readDataImportStorageSchema(clientOf(handle.db)),
  );
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
      handle.db.run(sql`INSERT INTO plugin_operations (id,user_id,account_id,state,claim_token,updated_at,record_json)
        VALUES (${overrides.id ?? 'other-operation'},${overrides.userId ?? 'another-user'},${overrides.accountId ?? scope.accountId},${state},NULL,1,${JSON.stringify({ tool: overrides.tool ?? 'close_holding' })})`);
    },
    async reopen() {
      handle.close();
      handle = createNodeDrizzleRepos(targetPath);
      repository = new DrizzleDataImportRepository(handle.db);
    },
    close() {
      handle.close();
    },
  };
});

/** 备份是提交前置条件：合约统一补一份与当前目标一致的备份引用。 */
const commitWithBackup = async (
  repository: DrizzleDataImportRepository,
  input: Parameters<DrizzleDataImportRepository['commit']>[0] extends infer T
    ? T extends { backup: unknown }
      ? Omit<T, 'backup'> & { backup?: T['backup'] }
      : never
    : never,
) =>
  repository.commit({
    ...input,
    backup: input.backup ?? {
      backupId: 'fixture-backup',
      archiveDigest: input.snapshot.archiveDigest,
      targetDigest: await repository.targetDigest(input.scope),
    },
  });

describe('T48 atomic receipt failure', () => {
  it('数据已写但receipt插入失败，账户和receipt一起回滚', async () => {
    const scope = { userId: 'import-owner', accountId: 'import-account' };
    const sourcePath = makeTempDbPath('receipt-source.db');
    const targetPath = makeTempDbPath('receipt-target.db');
    const sourceHandle = createNodeDrizzleRepos(sourcePath);
    await sourceHandle.repos.account.save(
      makeAccount(scope.accountId, { name: 'source-after-import' }),
    );
    sourceHandle.close();
    const target = createNodeDrizzleRepos(targetPath);
    try {
      await target.repos.account.save(makeAccount(scope.accountId, { name: 'target-original' }));
      const snapshot = readSqliteImportSnapshot(
        sourcePath,
        scope,
        readDataImportStorageSchema(clientOf(target.db)),
      );
      const repository = new DrizzleDataImportRepository(target.db);
      const preview = await repository.preview({ scope, snapshot, now: 1000 });
      target.db.run(
        sql`CREATE TRIGGER fail_import_receipt BEFORE INSERT ON data_import_receipts BEGIN SELECT RAISE(ABORT, 'receipt fault'); END`,
      );
      await expect(
        commitWithBackup(repository, {
          scope,
          snapshot,
          preview,
          requestId: 'late-receipt-fault',
          now: 1001,
        }),
      ).rejects.toThrow();
      expect((await target.repos.account.findById(scope.accountId))?.name).toBe('target-original');
      expect(await repository.findReceipt(scope, 'late-receipt-fault')).toBeNull();
      expect(clientOf(target.db).isTransaction).toBe(false);
      expect(executedSqlOf(target.db).slice(-2)).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
    } finally {
      target.close();
    }
  });
});

// ---------- PluginAuthority fixtures（与 bun/drizzle 合约同源） ----------

const identity = { userId: 'u', profile: 'p', sessionId: 's', taskId: 't' };

const operation = (id = 'op'): PluginOperation => ({
  id,
  userId: 'u',
  accountId: 'a',
  tool: 'batch',
  inputJson: '{}',
  inputHash: 'a'.repeat(64),
  policyVersion: 1,
  requiredCapabilities: ['write', 'external'],
  authorization: { kind: 'human', tokenHash: 'b'.repeat(64) },
  state: 'pending',
  claimToken: null,
  resultJson: null,
  createdAt: 100,
  updatedAt: 100,
  expiresAt: 1000,
});

const proof = (id = 'op'): PluginOperationProof & { claimToken: string } => ({
  id,
  userId: 'u',
  accountId: 'a',
  now: 200,
  policyVersion: 1,
  claimToken: 'claim',
  authorization: { kind: 'human', tokenHash: 'b'.repeat(64) },
});

const grant = (): PluginAutomationGrant => ({
  id: 'grant',
  identity: { ...identity },
  scheduleHash: 'd'.repeat(64),
  version: 1,
  policyVersion: 1,
  enabled: true,
  allowedCalls: [
    {
      tool: 'batch',
      accountId: 'a',
      inputHash: 'a'.repeat(64),
      inputJson: '{}',
      capabilities: ['write', 'external'],
    },
  ],
  createdAt: 100,
  updatedAt: 100,
  expiresAt: 1000,
});

// ---------- T48 全量事实覆盖 fixture ----------
//
// 每张 replace 表至少一行 + union 表各一行，用真实 Node 文件库做 roundtrip。
// 断言按表逐项比较（不是四个总数），并让 commit 内的图校验/账本校验/摘要校验真实执行。

const FULL_SCOPE: DataImportScope = { userId: 'import-owner', accountId: 'import-account' };
const H = (seed: string): string => seed.repeat(64).slice(0, 64);
const AT = (iso: string): number => Date.parse(iso);
const T0 = AT('2026-07-01T01:00:00.000Z');
const T1 = AT('2026-07-02T01:00:00.000Z');
const T2 = AT('2026-07-03T01:00:00.000Z');
const DAY = AT('2026-07-01T00:00:00.000Z');

const fullFixture = (): Record<string, DataImportRow> => {
  const accountId = FULL_SCOPE.accountId;
  const userId = FULL_SCOPE.userId;
  const definition: StrategyDslV1 = {
    schemaVersion: 1,
    metadata: {},
    universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
    selection: { logic: 'all', rules: [] },
    signals: { entry: [], exit: [], risk: [] },
  };
  const tradingPlan: TradingPlan = {
    id: 'plan-1',
    version: 1,
    accountId,
    stockId: 'stock-1',
    industry: '白酒',
    status: 'draft',
    action: 'observe',
    entryConditions: [],
    invalidEntryConditions: [],
    position: {
      currentPct: 0,
      targetPctRange: null,
      appliedPct: null,
      fallbackPct: null,
      rangePick: null,
      constraintStatus: 'passed',
      constraintReasons: [],
      prerequisiteActions: [],
    },
    holding: {
      minTradingDays: 1,
      maxTradingDays: 5,
      nextReviewAt: new Date(T2),
      earlyExitConditions: [],
      extensionBasis: [],
    },
    exit: { conditions: [], triggerConditions: [], canSellNow: true },
    validFrom: new Date(T0),
    validUntil: new Date(T2),
    invalidationConditions: [],
    invalidationRules: [],
    accountFactsAsOf: new Date(T0),
    accountFactsDigest: 'account-facts-digest',
    marketFacts: [],
    evidence: [],
    source: { strategyIds: [], strategyVersionIds: [], runIds: [], signalIds: [], adviceIds: [] },
    explanation: { supportingEvidenceIds: [], counterEvidence: [], risks: [], unknowns: [] },
    confidence: 50,
    createdAt: new Date(T0),
  };
  const decisionReview = {
    id: 'review-1',
    accountId,
    subject: { kind: 'advice', id: 'advice-1' },
    stockId: 'stock-1',
    sourceOccurredAt: T0,
    context: {
      schemaVersion: 1,
      capturedAt: T0,
      sourceDataAsOf: T0,
      captureOrigin: 'user',
      source: {},
      contextHash: 'context-hash-1',
    },
    currentRevision: 1,
    createdAt: T0,
  };
  const decisionRevision = {
    reviewId: 'review-1',
    revision: 1,
    sequence: 1,
    content: { tradeIds: ['trade-1'], adviceFeedback: null, triggerFeedback: null, note: '覆盖' },
    tradeFactHashes: { 'trade-1': 'trade-fact-hash-1' },
    contentHash: 'revision-hash-1',
    recordedAt: T1,
    changeNote: null,
  };
  const reportScope = { kind: 'account' as const, accountId };
  const row: Record<string, DataImportRow> = {
    accounts: {
      id: accountId,
      name: '全量覆盖账户',
      kind: 'real',
      currency: 'CNY',
      initial_capital: 1000,
      cash_balance: 1400,
      created_at: T0,
    },
    stocks: {
      id: 'stock-1',
      code: '600519',
      exchange: 'SH',
      name: '贵州茅台',
      industry: '白酒',
      name_source: 'manual',
      name_updated_at: T0,
      updated_at: T0,
    },
    holdings: {
      id: 'holding-1',
      account_id: accountId,
      stock_id: 'stock-1',
      quantity: 10,
      available_quantity: 10,
      avg_cost: 10,
      opened_at: T0,
      closed_at: null,
    },
    trades: {
      id: 'trade-1',
      account_id: accountId,
      stock_id: 'stock-1',
      side: 'buy',
      quantity: 10,
      price: 10,
      fee: 0,
      executed_at: T0,
      source: 'manual',
      advice_id: 'advice-1',
      research_hypothesis_version_id: null,
      strategy_version_id: 'strategy-a-v1',
      created_at: T0,
    },
    portfolio_cash_flows: {
      id: 'flow-1',
      account_id: accountId,
      occurred_at: T0,
      kind: 'deposit',
      amount: 500,
      currency: 'CNY',
      stock_id: null,
      source: 'manual',
      note: null,
      created_at: T0,
    },
    holding_cash_adjustments: {
      id: 'adjustment-1',
      account_id: accountId,
      holding_id: 'holding-1',
      stock_id: 'stock-1',
      amount: 0,
      quantity_delta: 0,
      occurred_at: T0,
    },
    portfolio_corporate_actions: {
      id: 'corporate-action-1',
      account_id: accountId,
      stock_id: 'stock-1',
      occurred_at: T0,
      kind: 'dividend',
      ratio: null,
      cash_per_share: 0.5,
      source: 'manual',
      note: null,
      created_at: T0,
    },
    portfolio_performance_snapshots: {
      id: 'performance-1',
      account_id: accountId,
      from_at: T0,
      to_at: T1,
      currency: 'CNY',
      input_fingerprint: 'fingerprint-1',
      calculated_at: T1,
      data_as_of: T0,
      performance_json: JSON.stringify({
        realizedPnl: 0,
        valuation: [],
        contributions: [],
        warnings: [],
      }),
    },
    strategies: {
      id: 'strategy-a',
      name: '覆盖策略',
      description: '全量覆盖 fixture 策略',
      owner: 'user',
      status: 'active',
      current_version_id: 'strategy-a-v1',
      created_at: T0,
      updated_at: T0,
    },
    strategy_versions: {
      id: 'strategy-a-v1',
      strategy_id: 'strategy-a',
      version: 1,
      definition_json: JSON.stringify(definition),
      definition_hash: strategyDefinitionHash(definition),
      parent_version_id: null,
      change_summary: '覆盖',
      fact_references_json: null,
      agent_trace_json: null,
      validation_status: 'valid',
      validation_errors_json: '[]',
      published_at: T1,
      created_at: T0,
    },
    strategy_runs: {
      id: 'run-1',
      strategy_id: 'strategy-a',
      strategy_version_id: 'strategy-a-v1',
      mode: 'scan',
      coverage: 'CN_A_SHARES_SH_SZ',
      data_as_of: T0,
      started_at: T0,
      finished_at: T1,
      status: 'complete',
      scope: 'operational',
      input_snapshot_json: '{}',
      provider_statuses_json: '[]',
      provider_coverage_json: null,
      summary_json: '{}',
      publication_json: null,
      publication_status: null,
      error: null,
    },
    strategy_results: {
      run_id: 'run-1',
      stock_id: 'stock-1',
      selected: 1,
      score: 80,
      rank: 1,
      rule_evaluations_json: '[]',
      evidence_json: '["evidence-1"]',
      data_as_of: T0,
    },
    strategy_signals: {
      id: 'signal-1',
      strategy_id: 'strategy-a',
      strategy_version_id: 'strategy-a-v1',
      run_id: 'run-1',
      rule_id: 'entry-1',
      stock_id: 'stock-1',
      ts: T0,
      score: 80,
      direction: 'bullish',
      evidence_json: '["evidence-1"]',
      evaluation_snapshot_json: '{}',
    },
    strategy_schedules: {
      id: 'schedule-1',
      strategy_id: 'strategy-a',
      cron: '0 9 * * 1-5',
      timezone: 'Asia/Shanghai',
      enabled: 1,
      acceptance_policy_json: null,
      recommendation_policy_json: null,
      next_run_at: T2,
      last_run_id: null,
      lease_owner: null,
      lease_until: null,
      lease_fence: 0,
      lease_heartbeat_at: null,
      created_at: T0,
      updated_at: T0,
    },
    strategy_watchlist_subscriptions: {
      id: 'subscription-1',
      strategy_id: 'strategy-a',
      watchlist_id: 'watch-a',
      source_key: 'strategy:strategy-a',
      status: 'active',
      created_by: userId,
      created_at: T0,
      updated_at: T0,
      cancelled_at: null,
      cancelled_by: null,
      investment_binding_json: null,
    },
    strategy_autonomy_actions: {
      id: 'autonomy-1',
      kind: 'propose-version',
      status: 'published',
      strategy_id: 'strategy-a',
      strategy_version_id: 'strategy-a-v1',
      evaluation_session_id: null,
      trigger: 'weekly-review',
      rule_snapshot_json: '{}',
      ai_narrative: null,
      provenance_json: null,
      fact_references_json: '[]',
      attempts: 0,
      last_error: null,
      created_at: T0,
      updated_at: T1,
      completed_at: T1,
    },
    strategy_signal_states: {
      strategy_id: 'strategy-a',
      strategy_version_id: 'strategy-a-v1',
      context_key: 'context-1',
      run_id: 'run-1',
      evaluated_at: T0,
      state_json: JSON.stringify({
        trackedStockIds: ['stock-1'],
        rules: [{ stockId: 'stock-1', ruleId: 'entry-1', matched: true }],
      }),
    },
    strategy_data_checkpoints: {
      id: 'checkpoint-1',
      coverage: 'CN_A_SHARES_SH_SZ',
      data_as_of: T0,
      status: 'complete',
      vintage_status: 'available',
      universe_sync_id: 'universe-1',
      requested_count: 1,
      available_count: 1,
      failed_count: 0,
      member_checksum: H('a'),
      data_checksum: H('b'),
      provider_statuses_json: '[]',
      started_at: T0,
      finished_at: T1,
    },
    strategy_data_checkpoint_members: {
      checkpoint_id: 'checkpoint-1',
      stock_id: 'stock-1',
      status: 'available',
      latest_bar_date: DAY,
      bar_count: 1,
      provider: 'fixture',
      error_kind: null,
    },
    strategy_evaluation_sessions: {
      id: 'session-eval-1',
      strategy_id: 'strategy-a',
      strategy_version_id: 'strategy-a-v1',
      from_at: T0,
      to_at: T1,
      status: 'complete',
      definition_hash: H('c'),
      created_at: T0,
      stock_ids_json: null,
      stock_id_checksum: null,
      finished_at: T1,
      error: null,
    },
    strategy_research_states: {
      strategy_id: 'strategy-a',
      account_id: accountId,
      revision: 1,
      state_json: '{}',
    },
    strategy_evaluation_days: {
      session_id: 'session-eval-1',
      data_as_of: T0,
      run_id: 'run-1',
      universe_sync_id: 'universe-1',
      data_checkpoint_id: 'checkpoint-1',
      revision_cutoff: null,
      vintage_status: 'available',
      status: 'complete',
      evaluated_count: 1,
      selected_count: 1,
      signal_count: 1,
      failed_count: 0,
      error: null,
    },
    strategy_backtest_runs: {
      id: 'backtest-1',
      strategy_id: 'strategy-a',
      strategy_version_id: 'strategy-a-v1',
      evaluation_session_id: 'session-eval-1',
      status: 'queued',
      result_availability: 'unavailable',
      spec_json: '{}',
      spec_hash: H('d'),
      input_fingerprint: H('e'),
      evaluator_json: '{}',
      gate_audit_json: '{}',
      metrics_json: null,
      error: null,
      created_at: T0,
      started_at: null,
      finished_at: null,
    },
    strategy_backtest_market_facts: {
      stock_id: 'stock-1',
      date: DAY,
      recorded_at: T1,
      content_hash: H('f'),
      fact_json: '{}',
    },
    watchlists: {
      id: 'watch-a',
      name: '关注A',
      description: null,
      kind: 'personal',
      membership_policy: 'manual',
      enabled: 1,
      created_at: T0,
      updated_at: T0,
    },
    watchlist_members: {
      id: 'member-1',
      watchlist_id: 'watch-a',
      stock_id: 'stock-1',
      stage: 'watching',
      priority: 'normal',
      first_added_at: T0,
      last_activity_at: T0,
      archived_at: null,
    },
    watchlist_member_sources: {
      id: 'source-1',
      member_id: 'member-1',
      kind: 'manual',
      source_key: 'manual:fixture',
      source_id: null,
      source_version_id: null,
      sync_run_id: null,
      owner_user_id: userId,
      import_batch_id: null,
      reason: '覆盖',
      score: null,
      rank: null,
      status: 'active',
      evidence_json: '[]',
      data_as_of: null,
      valid_from: T0,
      valid_until: null,
    },
    watchlist_sync_runs: {
      id: 'sync-1',
      watchlist_id: 'watch-a',
      source_kind: 'import',
      source_key: 'import:fixture',
      producer_run_id: null,
      status: 'complete',
      data_as_of: T0,
      started_at: T0,
      finished_at: T1,
      entered_count: 1,
      exited_count: 0,
      unchanged_count: 0,
      missing_dimensions_json: '[]',
      error: null,
    },
    membership_snapshots: {
      id: 'membership-1',
      sync_run_id: 'sync-1',
      stock_id: 'stock-1',
      selected: 1,
      change: 'entered',
      reason: '覆盖',
      score: 50,
      rank: 1,
      evidence_json: '["evidence-1"]',
      data_as_of: T0,
    },
    alert_plans: {
      id: 'alert-a',
      name: '提醒A',
      description: null,
      watchlist_id: 'watch-a',
      rules: JSON.stringify([{ id: 'price', kind: 'price-change', pct: 0.05, direction: 'any' }]),
      logic: 'ANY',
      trigger_mode: 'on-enter',
      priority: null,
      cooldown_minutes: 30,
      daily_notification_limit: 20,
      notify_on_recovery: 0,
      enabled: 1,
      created_at: T0,
      updated_at: T0,
    },
    watch_triggers: {
      id: 'trigger-1',
      alert_plan_id: 'alert-a',
      pool_id: 'watch-a',
      stock_id: 'stock-1',
      rule_kind: 'price-change',
      direction: 'buy',
      reason: '覆盖',
      evidence: JSON.stringify(['evidence-1']),
      quote_close: 10.5,
      quote_ts: T0,
      notified: 1,
      created_at: T0,
      rule_id: 'price',
      trigger_type: 'triggered',
      priority: 'normal',
      delivery_status: 'sent',
      notification_id: 'notification-1',
      eval_snapshot: JSON.stringify({
        ruleId: 'price',
        kind: 'price-change',
        quoteClose: 10.5,
        quoteTs: T0,
        threshold: 0.05,
      }),
      feedback: null,
      feedback_at: null,
      event_id: null,
      delivery_attempts: 1,
      last_delivery_attempt_at: T1,
      delivery_completed_at: T1,
    },
    watch_rule_states: {
      alert_plan_id: 'alert-a',
      pool_id: 'watch-a',
      stock_id: 'stock-1',
      rule_id: 'price',
      active: 1,
      first_triggered_at: T0,
      last_evaluated_at: T1,
      last_value: 0.05,
      last_recovered_at: null,
    },
    watch_runs: {
      id: 'watch-run-1',
      mode: 'once',
      status: 'succeeded',
      started_at: T0,
      finished_at: T1,
      evaluated_pools: 1,
      evaluated_stocks: 1,
      triggered: 1,
      notified: 1,
      suppressed_by_cooldown: 0,
      error: null,
      suppressed_by_daily_limit: 0,
      notify_failed: 0,
      delivered: 1,
      unknown_rules: 0,
    },
    advices: {
      id: 'advice-1',
      subject_kind: 'stock',
      subject_id: 'stock-1',
      stock_name: '贵州茅台',
      decision: 'buy',
      confidence: 60,
      horizon: 'short',
      entry_price: 10,
      entry_price_low: null,
      entry_price_high: null,
      target_position_pct: null,
      target_price: 12,
      stop_loss: 9,
      reasoning: JSON.stringify({
        premise: '覆盖',
        evidence: ['evidence-1'],
        counterEvidence: ['counter-1'],
      }),
      risks: JSON.stringify(['risk-1']),
      disclaimers: JSON.stringify([...STANDARD_DISCLAIMERS]),
      provenance_json: null,
      generator_kind: null,
      source_tool: 't48-fixture',
      source_workflow: null,
      based_on: JSON.stringify({ dataAsOf: T0 }),
      valid_from: T0,
      valid_until: T2,
      created_at: T0,
    },
    advice_outcomes: {
      advice_id: 'advice-1',
      trade_ids: JSON.stringify(['trade-1']),
      outcome: 'followed',
      pnl: 1,
      benchmark_pnl: 0.5,
      holding_hours: 24,
      notes: '覆盖',
      recorded_at: T1,
    },
    decision_reviews: {
      id: 'review-1',
      account_id: accountId,
      subject_kind: 'advice',
      subject_id: 'advice-1',
      stock_id: 'stock-1',
      source_occurred_at: T0,
      context_json: JSON.stringify(decisionReview.context),
      context_hash: 'context-hash-1',
      current_revision: 1,
      created_at: T0,
    },
    decision_review_revisions: {
      sequence: 1,
      review_id: 'review-1',
      revision: 1,
      content_json: JSON.stringify(decisionRevision.content),
      content_hash: 'revision-hash-1',
      trade_fact_hashes_json: JSON.stringify(decisionRevision.tradeFactHashes),
      recorded_at: T1,
      change_note: null,
    },
    decision_review_trade_links: {
      review_id: 'review-1',
      account_id: accountId,
      trade_id: 'trade-1',
      revision: 1,
    },
    reports: {
      id: 'report-1',
      version: 1,
      supersedes_report_id: null,
      kind: 'closing',
      scope_key: reportScopeKey(reportScope),
      scope_json: JSON.stringify(reportScope),
      period_start: '2026-07-01',
      period_end: '2026-07-01',
      title: '收盘报告',
      generated_at: T1,
      data_as_of: T0,
      status: 'complete',
      sections_json: JSON.stringify([
        {
          key: 'summary',
          title: '摘要',
          required: true,
          status: 'complete',
          blocks: [],
          evidenceIds: [],
          missingDimensions: [],
        },
      ]),
      evidence_json: '[]',
      missing_dimensions_json: '[]',
      delivery_status: 'not-requested',
      notification_policy: 'never',
      watchlist_facts_snapshot: null,
      decision_review_snapshot: null,
      delivery_attempt_id: null,
      workflow_run_id: 'workflow-1',
      created_at: T1,
      updated_at: T1,
    },
    notifications: {
      id: 'notification-1',
      channel: 'log',
      payload: JSON.stringify({ title: '覆盖', content: '覆盖通知', level: 'info' }),
      result: 'success',
      error_message: null,
      advice_id: 'advice-1',
      tactic_signal_id: null,
      sent_at: T1,
    },
    signal_observations: {
      id: 'observation-1',
      source_kind: 'watch-trigger',
      source_id: 'trigger-1',
      stock_id: 'stock-1',
      baseline_price: 10,
      baseline_at: T0,
      horizon: 't1',
      vintage: 'pit',
      close_price: 11,
      return_pct: 0.1,
      max_favorable_excursion_pct: 0.1,
      max_adverse_excursion_pct: 0,
      benchmark_return_pct: 0.05,
      benchmark_status: 'complete',
      status: 'complete',
      provenance: JSON.stringify({
        provider: 'fixture',
        observedAt: T0,
        fetchedAt: T1,
        freshness: 'fresh',
      }),
      unavailable_reason: null,
      observed_at: T1,
      due_at: T1,
      attempt_count: 1,
      last_attempt_at: T1,
      next_attempt_at: null,
      last_error_kind: null,
    },
    workflow_runs: {
      id: 'workflow-1',
      workflow_name: 't48-fixture',
      mode: 'manual',
      status: 'succeeded',
      started_at: T0,
      finished_at: T1,
      input_summary: null,
      output_summary: null,
      provider_statuses: '[]',
      error: null,
    },
    trading_plans: {
      version_id: tradingPlanVersionId(tradingPlan),
      plan_id: tradingPlan.id,
      version: tradingPlan.version,
      account_id: accountId,
      stock_id: 'stock-1',
      status: tradingPlan.status,
      valid_from: T0,
      valid_until: T2,
      created_at: T0,
      plan_json: JSON.stringify(tradingPlan),
    },
    stock_universe_memberships: {
      source: 'fixture',
      coverage: 'CN_A_SHARES_SH_SZ',
      stock_id: 'stock-1',
      observed_name: '贵州茅台',
      listing_status: 'listed',
      state: 'active',
      first_seen_at: T0,
      last_seen_at: T0,
      missing_since: null,
      last_sync_id: 'universe-1',
      metadata: null,
    },
    stock_universe_sync_runs: {
      id: 'universe-1',
      source: 'fixture',
      coverage: 'CN_A_SHARES_SH_SZ',
      status: 'succeeded',
      started_at: T0,
      finished_at: T1,
      observed_at: T1,
      reported_total: 1,
      observed_count: 1,
      created_stocks: 1,
      updated_stocks: 0,
      reactivated: 0,
      marked_missing: 0,
      error_kind: null,
      error_message: null,
    },
    stock_universe_snapshot_members: { sync_id: 'universe-1', stock_id: 'stock-1' },
    price_snapshots: {
      stock_id: 'stock-1',
      observed_at: T0,
      fetched_at: T1,
      timestamp_source: 'upstream',
      open: 10,
      high: 11,
      low: 9,
      close: 10.5,
      volume: 100,
      amount: 1000,
      turnover_rate: 1,
      prev_close: 10,
      total_shares: 1000,
      float_shares: 800,
      total_market_cap: 10500,
      float_market_cap: 8400,
      pe_dynamic: 20,
      pe_ttm: 20,
      pe_static: 20,
      ps_ttm: 5,
      pb: 3,
      source: 'fixture',
    },
    daily_bars: {
      stock_id: 'stock-1',
      date: DAY,
      open: 10,
      high: 11,
      low: 9,
      close: 10.5,
      volume: 100,
      adj_factor: 1,
      adjustment: 'qfq',
      source_adj_factor: 1,
      source: 'fixture',
    },
    minute_bars: {
      stock_id: 'stock-1',
      interval: '1m',
      ended_at: T0,
      open: 10,
      high: 11,
      low: 9,
      close: 10.5,
      volume: 100,
      amount: 1000,
      adjustment: 'raw',
      source: 'fixture',
      fetched_at: T1,
      completeness: 'closed',
    },
    daily_bar_revisions: {
      stock_id: 'stock-1',
      date: DAY,
      content_hash: H('a'),
      open: 10,
      high: 11,
      low: 9,
      close: 10.5,
      volume: 100,
      source: 'fixture',
      recorded_at: T1,
    },
    financial_fact_revisions: {
      id: 'fact-1',
      stock_id: 'stock-1',
      metric_id: 'revenue',
      period_type: 'annual',
      period_start: DAY,
      period_end: T1,
      value: 100,
      canonical_unit: 'ratio',
      currency: null,
      raw_value: null,
      raw_unit: null,
      source: 'fixture',
      source_record_id: 'record-1',
      source_revision: 'r1',
      published_at: T0,
      revision_published_at: T0,
      recorded_at: T0,
      status: 'reported',
      supersedes_id: null,
      industry_key: null,
      content_hash: H('b'),
    },
    fundamental_score_versions: {
      id: 'score-v1',
      version: 1,
      registry_version: 'registry-v1',
      registry_hash: H('c'),
      normalization_version: 'fundamental-normalization-v1',
      components_json: JSON.stringify([
        {
          factorId: 'fundamental.profitability.roe',
          weight: 1,
          normalizer: 'market-percentile-v1',
        },
      ]),
      missing_policy: 'unknown',
      rounding: 'round-to-6-decimal',
      definition_hash: H('d'),
      status: 'published',
      created_at: T0,
      published_at: T1,
    },
    fundamental_score_runs: {
      id: 'score-run-1',
      score_version_id: 'score-v1',
      score_version_hash: H('e'),
      registry_hash: H('f'),
      universe_sync_id: 'universe-1',
      universe_member_checksum: H('a'),
      as_of: T2,
      financial_vintage_key: H('b'),
      normalizer_denominator_hash: H('c'),
      counts_json: JSON.stringify({ evaluated: 1, available: 0, missing: 1, excluded: 0 }),
      provider_status: 'complete',
      evaluator_code_identity: 'score-evaluator-fixture',
      status: 'started',
      created_at: T1,
      committed_at: null,
      terminal_reason_json: null,
    },
    fundamental_score_results: {
      score_run_id: 'score-run-1',
      stock_id: 'stock-1',
      status: 'missing',
      score: null,
      rank: null,
      components_json: JSON.stringify([
        { factorId: 'fundamental.profitability.roe', missingReason: 'provider-missing' },
      ]),
      data_as_of: T2,
      vintage_key: H('d'),
    },
    limit_up_ladder_snapshots: {
      date: '2026-07-01',
      source: 'eastmoney',
      total: 0,
      max_level: 0,
      levels_json: '[]',
      warnings_json: '[]',
      as_of: T0,
    },
    stock_events: {
      id: 'event-1',
      stock_id: 'stock-1',
      kind: 'dividend',
      title: '分红',
      description: null,
      occurs_at: T1,
      all_day: 1,
      importance: 'normal',
      status: 'scheduled',
      source: 'manual',
      provider: null,
      external_id: null,
      source_url: null,
      observed_at: null,
      fetched_at: null,
      stale: 0,
      remind_before_days: '[]',
      created_at: T0,
      updated_at: T0,
    },
    research_topic_index: {
      id: 'topic_1',
      title: '覆盖主题',
      kind: 'company',
      summary: null,
      tags: '[]',
      vault_id: 'vault-1',
      relative_path: 'topics/topic.md',
      content_hash: H('a'),
      archived_at: null,
      file_modified_at: T0,
      indexed_at: T0,
      availability: 'available',
      diagnostic: null,
    },
    research_document_index: {
      id: 'doc_1',
      kind: 'note',
      title: '覆盖文档',
      author: null,
      source_url: null,
      source_status: null,
      published_at: null,
      observed_at: null,
      imported_at: T0,
      tags: '[]',
      vault_id: 'vault-1',
      relative_path: 'docs/doc.md',
      attachment_paths: '[]',
      content_hash: H('b'),
      excerpt: null,
      file_modified_at: T0,
      indexed_at: T0,
      availability: 'available',
      diagnostic: null,
    },
    research_topic_documents: {
      topic_id: 'topic_1',
      document_id: 'doc_1',
      relation: 'primary',
      sort_order: 0,
    },
    research_subject_links: {
      owner_kind: 'topic',
      owner_id: 'topic_1',
      subject_kind: 'stock',
      subject_key: 'stock-1',
      relation: 'primary',
    },
    research_document_chunks: {
      document_id: 'doc_1',
      ordinal: 0,
      heading_path: '# 覆盖',
      content_hash: H('c'),
      body: '正文',
    },
    research_vault_sync_runs: {
      id: 'vault-run-1',
      vault_id: 'vault-1',
      mode: 'manual',
      status: 'succeeded',
      scanned: 1,
      added: 1,
      updated: 0,
      unchanged: 0,
      missing: 0,
      invalid: 0,
      conflicts: 0,
      started_at: T0,
      finished_at: T1,
      error: null,
    },
    research_hypothesis_versions: {
      id: 'hypothesis_1',
      topic_id: 'topic_1',
      document_id: 'doc_1',
      document_content_hash: H('b'),
      version: 1,
      status: 'active',
      supersedes_id: null,
      summary: '覆盖假设',
      created_at: T0,
    },
    research_chunk_embeddings: {
      identity_key: 'embedding-identity-1',
      document_id: 'doc_1',
      ordinal: 0,
      content_hash: H('c'),
      provider: 'fixture',
      model: 'fixture-model',
      dimensions: 2,
      version: 'v1',
      vector_json: '[1,2]',
      embedded_at: T0,
    },
    research_embedding_index_states: {
      identity_key: 'embedding-identity-1',
      provider: 'fixture',
      model: 'fixture-model',
      dimensions: 2,
      version: 'v1',
      status: 'ready',
      expected_chunks: 1,
      embedded_chunks: 1,
      stale_chunks: 0,
      updated_at: T0,
      diagnostic: null,
    },
    chat_sessions: {
      id: 'session-1',
      account_id: accountId,
      title: '覆盖会话',
      created_at: T0,
      updated_at: T0,
    },
    chat_messages: {
      id: 'message-1',
      session_id: 'session-1',
      role: 'user',
      parts: JSON.stringify([{ type: 'text', text: '你好' }]),
      created_at: T0,
    },
    analysis_jobs: {
      id: 'job-1',
      kind: 'advice_stock',
      source: 'tool',
      account_id: accountId,
      subject_kind: 'stock',
      subject_id: 'stock-1',
      priority: 50,
      dedupe_key: 'dedupe-1',
      payload_json: '{}',
      data_as_of: T0,
      not_before: T0,
      status: 'completed',
      attempts: 1,
      max_attempts: 3,
      claim_token: null,
      claimed_by: null,
      lease_until: null,
      context_id: 'context-1',
      result_json: null,
      error_json: null,
      created_at: T0,
      updated_at: T1,
      finished_at: T1,
    },
    analysis_contexts: {
      recorded_result_json: null,
      id: 'context-1',
      job_id: 'job-1',
      kind: 'advice_stock',
      account_id: accountId,
      subject_kind: 'stock',
      subject_id: 'stock-1',
      data_as_of: T0,
      facts_json: '[]',
      fact_ids_json: '[]',
      limitations_json: '[]',
      context_hash: H('e'),
      write_until: T1,
      expires_at: T1,
      created_at: T0,
    },
    investment_research: {
      id: 'investment-research-1',
      owner_user_id: userId,
      account_id: accountId,
      request_id: 'request-research-1',
      request_hash: 'request-hash-1',
      payload_json: '{}',
      created_at: T0,
    },
    investment_consensus: {
      id: 'investment-consensus-1',
      owner_user_id: userId,
      account_id: accountId,
      version: 1,
      request_id: 'request-consensus-1',
      request_hash: 'request-hash-2',
      payload_json: '{}',
      created_at: T0,
    },
    investment_tracking: {
      id: 'investment-tracking-1',
      owner_user_id: userId,
      account_id: accountId,
      request_id: 'request-tracking-1',
      request_hash: 'request-hash-3',
      status: 'tracking',
      payload_json: '{}',
      started_at: T0,
    },
    watch_delivery_intents: {
      id: 'watch-intent-1',
      intent_json: JSON.stringify({
        id: 'watch-intent-1',
        tenantId: 'tenant-1',
        generation: 1,
        businessKey: 'business-1',
        resultRef: 'trigger-1',
        channel: 'feishu',
        bindingVersion: 1,
        state: 'pending',
        attempt: 0,
        attemptId: null,
        providerMessageId: null,
        availableAt: T0,
        expiresAt: T2,
        deliveredAt: null,
        errorKind: null,
        createdAt: T0,
        updatedAt: T0,
        executionOwner: 'fixture',
        notificationId: null,
      }),
    },
    report_delivery_intents: {
      report_id: 'report-1',
      intent_json: JSON.stringify({
        id: 'report-intent-1',
        tenantId: 'tenant-1',
        generation: 1,
        businessKey: 'business-2',
        resultRef: 'report-1',
        channel: 'feishu',
        bindingVersion: 1,
        state: 'pending',
        attempt: 0,
        attemptId: null,
        providerMessageId: null,
        availableAt: T0,
        expiresAt: T2,
        deliveredAt: null,
        errorKind: null,
        createdAt: T0,
        updatedAt: T0,
        executionOwner: 'fixture',
        notificationId: null,
      }),
    },
    decision_write_receipts: {
      account_id: accountId,
      request_id: '6f1c9d5e-0000-4000-8000-000000000001',
      command: 'save_decision_review',
      request_hash: 'decision-request-hash-1',
      result_json: JSON.stringify({ review: decisionReview, revision: decisionRevision }),
      committed_at: T1,
    },
    report_refresh_receipts: {
      account_id: accountId,
      request_id: '6f1c9d5e-0000-4000-8000-000000000002',
      request_hash: 'report-request-hash-1',
      report_id: 'report-1',
    },
    watchlist_import_batches: {
      operation_id: 'operation-1',
      preview_id: 'preview-1',
      result_json: '{}',
    },
    watchlist_removal_receipts: { operation_id: 'operation-2', result_json: '{}' },
    personal_alert_plan_mutations: { operation_id: 'operation-3', result_json: '{}' },
    personal_alert_evaluations: {
      id: 'evaluation-1',
      operation_id: 'operation-4',
      evaluation_json: '{}',
    },
    personal_watch_feedback: {
      trigger_id: 'trigger-1',
      revision: 1,
      request_id: 'request-feedback-1',
      feedback_json: '{}',
    },
    watchlist_facts_report_keys: { identity: 'identity-1', report_id: 'report-1' },
  };
  return row;
};

const insertFullRow = (handle: NodeDrizzleReposHandle, table: string, row: DataImportRow): void => {
  const columns = Object.keys(row);
  const client = clientOf(handle.db);
  client
    .prepare(
      `INSERT INTO ${JSON.stringify(table)} (${columns.map((column) => JSON.stringify(column)).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
    )
    .run(...columns.map((column) => row[column] ?? null));
};

describe('T48 全量事实 fixture 自校验', () => {
  it('每张业务表的 fixture 行都通过 scope 与领域/结构校验', () => {
    const fixture = fullFixture();
    const errors: string[] = [];
    for (const [table, row] of Object.entries(fixture)) {
      try {
        assertDataImportRowScope(table, row, FULL_SCOPE);
        validateDataTransferRow(table, row);
      } catch (error) {
        errors.push(`${table}: ${(error as Error).message.slice(0, 400)}`);
      }
    }
    expect(errors).toEqual([]);
  });
});

const UNION_TABLES = new Set(
  DATA_IMPORT_BUSINESS_TABLES.filter((table) => DATA_IMPORT_MANIFEST[table] === 'union'),
);

const seedFullFixture = (path: string, options: { readonly skipUnion?: boolean } = {}): void => {
  const handle = createNodeDrizzleRepos(path);
  const fixture = fullFixture();
  for (const table of DATA_IMPORT_BUSINESS_TABLES) {
    if (options.skipUnion === true && UNION_TABLES.has(table)) continue;
    const row = fixture[table];
    if (row === undefined) throw new Error(`fixture 缺少表: ${table}`);
    insertFullRow(handle, table, row);
  }
  handle.close();
};

describe('T48 全量事实覆盖 roundtrip', () => {
  it('每张 replace 表与 union 表都有一行，且逐表 actual 与预期一致', async () => {
    const fixture = fullFixture();
    const businessTables = [...DATA_IMPORT_BUSINESS_TABLES];
    expect(Object.keys(fixture).sort()).toEqual(businessTables);
    const sourcePath = makeTempDbPath('full-source.db');
    const targetPath = makeTempDbPath('full-target.db');
    const source = createNodeDrizzleRepos(sourcePath);
    for (const table of businessTables) {
      const row = fixture[table];
      if (row === undefined) throw new Error(`fixture 缺少表: ${table}`);
      insertFullRow(source, table, row);
    }
    source.close();
    const target = createNodeDrizzleRepos(targetPath);
    try {
      await target.repos.account.save(
        makeAccount(FULL_SCOPE.accountId, { name: 'target-before-import' }),
      );
      const snapshot = readSqliteImportSnapshot(
        sourcePath,
        FULL_SCOPE,
        readDataImportStorageSchema(clientOf(target.db)),
      );
      for (const table of businessTables) {
        expect(snapshot.tables[table], `source ${table}`).toEqual([fixture[table]]);
      }
      const repository = new DrizzleDataImportRepository(target.db);
      const preview = await repository.preview({ scope: FULL_SCOPE, snapshot, now: T0 });
      for (const table of businessTables) {
        const count = preview.counts[table];
        expect(count, `preview ${table}`).toMatchObject({ source: 1, expected: 1 });
      }
      const receipt = await commitWithBackup(repository, {
        scope: FULL_SCOPE,
        snapshot,
        preview,
        requestId: 'full-coverage-request',
        now: T0 + 1,
      });
      for (const table of businessTables) {
        expect(receipt.actual[table], `receipt ${table}`).toBe(1);
        expect(
          target.db.all<DataImportRow>(sql.raw(`SELECT * FROM ${JSON.stringify(table)}`)),
          `actual ${table}`,
        ).toEqual([fixture[table]]);
      }
      expect(await repository.findReceipt(FULL_SCOPE, 'full-coverage-request')).toEqual(receipt);
    } finally {
      target.close();
    }
  });
});

describe('T48 写入失败回滚', () => {
  it('写入中途唯一键冲突：已删除/改写的业务数据与 receipt 一起回滚', async () => {
    const sourcePath = makeTempDbPath('fault-source.db');
    const targetPath = makeTempDbPath('fault-target.db');
    seedFullFixture(sourcePath);
    const target = createNodeDrizzleRepos(targetPath);
    try {
      await target.repos.account.save(
        makeAccount(FULL_SCOPE.accountId, { name: 'target-before-import' }),
      );
      const snapshot = readSqliteImportSnapshot(
        sourcePath,
        FULL_SCOPE,
        readDataImportStorageSchema(clientOf(target.db)),
      );
      const repository = new DrizzleDataImportRepository(target.db);
      const stocks = snapshot.tables.stocks ?? [];
      const duplicate = { ...stocks[0], id: 'stock-duplicate' };
      const tampered = {
        ...snapshot,
        tables: { ...snapshot.tables, stocks: [...stocks, duplicate] },
      };
      const preview = await repository.preview({
        scope: FULL_SCOPE,
        snapshot: tampered,
        now: T0,
      });
      await expect(
        commitWithBackup(repository, {
          scope: FULL_SCOPE,
          snapshot: tampered,
          preview,
          requestId: 'fault-mid-write',
          now: T0 + 1,
        }),
      ).rejects.toThrow(/INSERT INTO "stocks"/);
      expect((await target.repos.account.findById(FULL_SCOPE.accountId))?.name).toBe(
        'target-before-import',
      );
      expect(await repository.findReceipt(FULL_SCOPE, 'fault-mid-write')).toBeNull();
      expect(clientOf(target.db).isTransaction).toBe(false);
      expect(executedSqlOf(target.db).slice(-2)).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
      // 写入顺序按 manifest 排序：accounts 先写，stocks 失败时账户已被删除并重写，必须一起回滚。
      expect(DATA_IMPORT_BUSINESS_TABLES.indexOf('accounts')).toBeLessThan(
        DATA_IMPORT_BUSINESS_TABLES.indexOf('stocks'),
      );
      expect(target.db.all(sql`SELECT id FROM stocks`)).toEqual([]);
      expect(target.db.all(sql`SELECT id FROM holdings`)).toEqual([]);
    } finally {
      target.close();
    }
  });

  it('业务写入完成但 receipt 插入失败（唯一索引，非触发器）：全部回滚', async () => {
    const sourcePath = makeTempDbPath('receipt-source.db');
    const targetPath = makeTempDbPath('receipt-target.db');
    seedFullFixture(sourcePath);
    const target = createNodeDrizzleRepos(targetPath);
    try {
      await target.repos.account.save(
        makeAccount(FULL_SCOPE.accountId, { name: 'target-before-import' }),
      );
      const snapshot = readSqliteImportSnapshot(
        sourcePath,
        FULL_SCOPE,
        readDataImportStorageSchema(clientOf(target.db)),
      );
      const repository = new DrizzleDataImportRepository(target.db);
      const preview = await repository.preview({ scope: FULL_SCOPE, snapshot, now: T0 });
      target.db.run(
        sql`CREATE UNIQUE INDEX t48_receipt_digest_unique ON data_import_receipts (archive_digest)`,
      );
      clientOf(target.db)
        .prepare(
          `INSERT INTO data_import_receipts (user_id,account_id,request_id,request_hash,archive_digest,original_request_id,committed_at,result_json)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          FULL_SCOPE.userId,
          FULL_SCOPE.accountId,
          'other-request',
          'other-request-hash',
          snapshot.archiveDigest,
          'other-request',
          T0,
          JSON.stringify({
            requestId: 'other-request',
            originalRequestId: 'other-request',
            archiveDigest: snapshot.archiveDigest,
            requestHash: 'other-request-hash',
            committedAt: T0,
            postDigest: 'other-post-digest',
            actual: {},
          }),
        );
      await expect(
        commitWithBackup(repository, {
          scope: FULL_SCOPE,
          snapshot,
          preview,
          requestId: 'fault-receipt',
          now: T0 + 1,
        }),
      ).rejects.toThrow(/data_import_receipts/);
      expect((await target.repos.account.findById(FULL_SCOPE.accountId))?.name).toBe(
        'target-before-import',
      );
      expect(await repository.findReceipt(FULL_SCOPE, 'fault-receipt')).toBeNull();
      expect(clientOf(target.db).isTransaction).toBe(false);
      expect(target.db.all(sql`SELECT id FROM stocks`)).toEqual([]);
      expect(
        target.db.all<{ request_id: string }>(sql`SELECT request_id FROM data_import_receipts`),
      ).toEqual([{ request_id: 'other-request' }]);
    } finally {
      target.close();
    }
  });
});

describe('T48 union 语义', () => {
  it('目标同身份业务回执保留，expected=validated union 而非 source', async () => {
    const sourcePath = makeTempDbPath('union-source.db');
    const targetPath = makeTempDbPath('union-target.db');
    seedFullFixture(sourcePath, { skipUnion: true });
    seedFullFixture(targetPath);
    const target = createNodeDrizzleRepos(targetPath);
    try {
      const snapshot = readSqliteImportSnapshot(
        sourcePath,
        FULL_SCOPE,
        readDataImportStorageSchema(clientOf(target.db)),
      );
      const repository = new DrizzleDataImportRepository(target.db);
      const incomingBatch = {
        operation_id: 'operation-new',
        preview_id: 'preview-new',
        result_json: '{"imported":1}',
      };
      const merged = {
        ...snapshot,
        tables: {
          ...snapshot.tables,
          watchlist_import_batches: [
            ...(snapshot.tables.watchlist_import_batches ?? []),
            incomingBatch,
          ],
        },
      };
      const preview = await repository.preview({ scope: FULL_SCOPE, snapshot: merged, now: T0 });
      expect(preview.counts.report_refresh_receipts).toMatchObject({
        policy: 'union',
        source: 0,
        current: 1,
        expected: 1,
      });
      expect(preview.counts.decision_write_receipts).toMatchObject({
        policy: 'union',
        source: 0,
        current: 1,
        expected: 1,
      });
      expect(preview.counts.watchlist_import_batches).toMatchObject({
        policy: 'union',
        source: 1,
        current: 1,
        expected: 2,
      });
      const receipt = await commitWithBackup(repository, {
        scope: FULL_SCOPE,
        snapshot: merged,
        preview,
        requestId: 'union-request',
        now: T0 + 1,
      });
      expect(receipt.actual.report_refresh_receipts).toBe(1);
      expect(receipt.actual.decision_write_receipts).toBe(1);
      expect(receipt.actual.watchlist_import_batches).toBe(2);
      expect(target.db.all<DataImportRow>(sql`SELECT * FROM report_refresh_receipts`)).toEqual([
        fullFixture().report_refresh_receipts,
      ]);
      expect(target.db.all<DataImportRow>(sql`SELECT * FROM reports`)).toEqual([
        fullFixture().reports,
      ]);
      expect(
        target.db
          .all<{ operation_id: string }>(
            sql`SELECT operation_id FROM watchlist_import_batches ORDER BY operation_id`,
          )
          .map((row) => row.operation_id),
      ).toEqual(['operation-1', 'operation-new']);
    } finally {
      target.close();
    }
  });

  it('同身份异内容并集冲突：预检拒绝且不写业务/回执', async () => {
    const sourcePath = makeTempDbPath('union-conflict-source.db');
    const targetPath = makeTempDbPath('union-conflict-target.db');
    seedFullFixture(sourcePath, { skipUnion: true });
    seedFullFixture(targetPath);
    const target = createNodeDrizzleRepos(targetPath);
    try {
      const snapshot = readSqliteImportSnapshot(
        sourcePath,
        FULL_SCOPE,
        readDataImportStorageSchema(clientOf(target.db)),
      );
      const repository = new DrizzleDataImportRepository(target.db);
      const existing = fullFixture().report_refresh_receipts;
      const tampered = {
        ...snapshot,
        tables: {
          ...snapshot.tables,
          report_refresh_receipts: [{ ...existing, request_hash: 'different-hash' }],
        },
      };
      const before = target.db.all<DataImportRow>(sql`SELECT * FROM reports`);
      await expect(
        repository.preview({ scope: FULL_SCOPE, snapshot: tampered, now: T0 }),
      ).rejects.toThrow('业务回执身份冲突');
      expect(target.db.all<DataImportRow>(sql`SELECT * FROM reports`)).toEqual(before);
      expect(target.db.all<DataImportRow>(sql`SELECT * FROM report_refresh_receipts`)).toEqual([
        existing,
      ]);
      expect(await repository.findReceipt(FULL_SCOPE, 'union-conflict')).toBeNull();
    } finally {
      target.close();
    }
  });

  it('并集保留的回执在最终图中缺引用时整包拒绝', async () => {
    const sourcePath = makeTempDbPath('union-graph-source.db');
    const targetPath = makeTempDbPath('union-graph-target.db');
    seedFullFixture(sourcePath, { skipUnion: true });
    seedFullFixture(targetPath);
    const target = createNodeDrizzleRepos(targetPath);
    try {
      const snapshot = readSqliteImportSnapshot(
        sourcePath,
        FULL_SCOPE,
        readDataImportStorageSchema(clientOf(target.db)),
      );
      const repository = new DrizzleDataImportRepository(target.db);
      const tampered = { ...snapshot, tables: { ...snapshot.tables, reports: [] } };
      await expect(
        repository.preview({ scope: FULL_SCOPE, snapshot: tampered, now: T0 }),
      ).rejects.toThrow(/缺少引用|缺少同账户报告/);
      expect(await repository.findReceipt(FULL_SCOPE, 'union-graph')).toBeNull();
      expect(target.db.all<DataImportRow>(sql`SELECT id FROM reports`)).toEqual([
        { id: 'report-1' },
      ]);
    } finally {
      target.close();
    }
  });
});
