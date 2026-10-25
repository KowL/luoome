// @luoome/db/node 的 Node 合约测试（node:sqlite driver）。
//
// 文件名刻意不用 `.test.ts`：`bun test packages/db` 会在 Bun 运行时加载同目录测试，
// 而 bun:sqlite 环境无法加载 node:sqlite。根 vitest config 显式 include 本文件，
// 由 Node（22/24）通过 `bun run test:db:node` 执行。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AnalysisContext,
  AnalysisJob,
  PluginAutomationGrant,
  PluginOperation,
  PluginOperationProof,
} from '@luoome/core';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeDrizzleRepos, ensureSchema, type NodeDrizzleReposHandle } from './node.js';
import { applyNodePragmas, drizzleNodeSqlite } from './node-sqlite-driver.js';
import {
  makeAccount,
  makeAdvice,
  makeHolding,
  makeStock,
  registerRepositoryContractTests,
} from './repository/contract-tests.js';
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
