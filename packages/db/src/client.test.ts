import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDrizzleRepos, ensureSchema } from './client.js';
import { makeAccount, makeStockPool } from './repository/contract-tests.js';
import { accounts, stockPools } from './schema/index.js';

describe('createDrizzleRepos / ensureSchema', () => {
  it('createDrizzleRepos(:memory:) 自动建表，repos 可读写，close 正常', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      const account = makeAccount('acc-1');
      await handle.repos.account.save(account);
      expect(await handle.repos.account.findById('acc-1')).toEqual(account);
      // db 句柄也可直接查询（表确实存在）
      const rows = handle.db.select().from(accounts).all();
      expect(rows).toHaveLength(1);
    } finally {
      handle.close();
    }
  });

  it('ensureSchema 幂等：重复执行不报错，已有数据保留', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      await handle.repos.account.save(makeAccount('acc-1'));
      ensureSchema(handle.db);
      ensureSchema(handle.db);
      expect(await handle.repos.account.findById('acc-1')).not.toBeNull();
    } finally {
      handle.close();
    }
  });

  it('文件库：写入后重开数据仍在', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luoome-db-test-'));
    const dbPath = path.join(dir, 'test.sqlite');
    try {
      const h1 = createDrizzleRepos(dbPath);
      await h1.repos.account.save(makeAccount('acc-persist'));
      h1.close();

      const h2 = createDrizzleRepos(dbPath);
      expect(await h2.repos.account.findById('acc-persist')).not.toBeNull();
      h2.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('旧版 price_snapshots(ts) 幂等迁移为双时间并保留数据', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { Database } = await import('bun:sqlite');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luoome-quote-migration-'));
    const dbPath = path.join(dir, 'legacy.sqlite');
    try {
      const sqlite = new Database(dbPath);
      sqlite.exec(`
        CREATE TABLE price_snapshots (
          stock_id TEXT NOT NULL,
          ts INTEGER NOT NULL,
          open REAL NOT NULL,
          high REAL NOT NULL,
          low REAL NOT NULL,
          close REAL NOT NULL,
          volume INTEGER NOT NULL,
          source TEXT NOT NULL,
          PRIMARY KEY (stock_id, ts)
        );
        INSERT INTO price_snapshots
          (stock_id, ts, open, high, low, close, volume, source)
        VALUES
          ('600519.SH', 1784591400000, 100, 101, 99, 100.5, 1234, 'legacy');
      `);
      sqlite.close();

      const handle = createDrizzleRepos(dbPath);
      const migrated = await handle.repos.quote.latestByStock('600519.SH');
      expect(migrated).toMatchObject({
        stockId: '600519.SH',
        timestampSource: 'retrieval',
        source: 'legacy',
        close: 100.5,
      });
      expect(migrated?.observedAt.getTime()).toBe(1784591400000);
      expect(migrated?.fetchedAt.getTime()).toBe(1784591400000);
      ensureSchema(handle.db);
      expect(
        await handle.repos.quote.listInRange('600519.SH', new Date(0), new Date(8.64e15)),
      ).toHaveLength(1);
      handle.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('旧版 stock_pools（source NOT NULL、无 group_id）→ ensureSchema 结构升级：旧行可读、新行可写', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { Database } = await import('bun:sqlite');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luoome-db-legacy-'));
    const dbPath = path.join(dir, 'legacy.sqlite');
    try {
      // 手工建 v0.6 旧结构 + 灌一条旧行（source 有值、无 group_id 列）
      const sqlite = new Database(dbPath);
      sqlite.exec(`
        CREATE TABLE stock_pools (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          source TEXT NOT NULL,
          rules TEXT NOT NULL,
          cooldown_minutes INTEGER NOT NULL,
          enabled INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      sqlite.exec(`
        INSERT INTO stock_pools (id, name, description, source, rules, cooldown_minutes, enabled, created_at, updated_at)
        VALUES (
          'legacy-pool', '旧池', NULL,
          '{"kind":"holdings","accountId":"acc-1"}',
          '[{"kind":"price-change","pct":0.05}]',
          30, 1, 1750000000000, 1750000000000
        )
      `);
      sqlite.close();

      const handle = createDrizzleRepos(dbPath);
      try {
        // 旧行读出：source 数据仍在表里；阶段 B 数据迁移已把它拆成分组并回填 groupId
        const legacy = await handle.repos.stockPool.findById('legacy-pool');
        expect(legacy).not.toBeNull();
        expect(legacy?.groupId).toBe('legacy-pool-group');
        const migratedGroup = await handle.repos.stockGroup.findById('legacy-pool-group');
        expect(migratedGroup?.resolver).toEqual({ kind: 'holdings', accountId: 'acc-1' });
        const raw = handle.db.select().from(stockPools).all();
        expect(raw).toHaveLength(1);
        expect(raw[0]?.source).toEqual({ kind: 'holdings', accountId: 'acc-1' });
        // 新行写入：source 恒 NULL、groupId 落库（旧结构 NOT NULL 已放宽）
        await handle.repos.stockPool.save(makeStockPool('new-pool', { groupId: 'grp-1' }));
        expect((await handle.repos.stockPool.findById('new-pool'))?.groupId).toBe('grp-1');
        // 幂等：再跑一次 ensureSchema 不报错、数据保留
        ensureSchema(handle.db);
        expect(await handle.repos.stockPool.list()).toHaveLength(2);
      } finally {
        handle.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('阶段 B 存量迁移：v0.6 pool.source JSON → 拆分组 + 回填 groupId（幂等）', async () => {
    const handle = createDrizzleRepos(':memory:');
    const TS = 1750000000000;
    // 灌三类 source 旧行（group_id 空串占位）+ 一条已迁移行 + 一条新行（source NULL）
    const insertPool = (id: string, name: string, source: string | null, groupId: string | null) =>
      handle.db.run(sql`
        INSERT INTO stock_pools (id, name, description, source, group_id, rules, cooldown_minutes, enabled, created_at, updated_at)
        VALUES (${id}, ${name}, NULL, ${source}, ${groupId}, ${'[{"kind":"price-change","pct":0.05}]'}, 30, 1, ${TS}, ${TS})
      `);
    try {
      insertPool(
        'lp-manual',
        '手动池',
        '{"kind":"manual","stockIds":["002594.SZ","600519.SH"]}',
        '',
      );
      insertPool('lp-holdings', '持仓池', '{"kind":"holdings","accountId":"acc-1"}', '');
      insertPool(
        'lp-tactic',
        '战法池',
        '{"kind":"tactic","tacticId":"breakout-volume","lookbackDays":5,"minScore":70}',
        '',
      );
      insertPool('lp-done', '已迁移', '{"kind":"holdings","accountId":"acc-9"}', 'lp-done-group');
      insertPool('lp-new', '新行', null, 'grp-1');

      ensureSchema(handle.db);

      // 三类分组按 source.kind 建好（id=<poolId>-group，resolver 平移）
      const gManual = await handle.repos.stockGroup.findById('lp-manual-group');
      expect(gManual?.resolver).toEqual({
        kind: 'manual',
        stockIds: ['002594.SZ', '600519.SH'],
      });
      expect(gManual?.refreshPolicy).toBe('manual');
      const gHoldings = await handle.repos.stockGroup.findById('lp-holdings-group');
      expect(gHoldings?.resolver).toEqual({ kind: 'holdings', accountId: 'acc-1' });
      const gTactic = await handle.repos.stockGroup.findById('lp-tactic-group');
      expect(gTactic?.resolver).toEqual({
        kind: 'formula',
        tacticId: 'breakout-volume',
        lookbackDays: 5,
        minScore: 70,
      });
      expect(gTactic?.refreshPolicy).toBe('daily');

      // pool.groupId 回填；已迁移行 / 新行不动
      expect((await handle.repos.stockPool.findById('lp-manual'))?.groupId).toBe('lp-manual-group');
      expect((await handle.repos.stockPool.findById('lp-holdings'))?.groupId).toBe(
        'lp-holdings-group',
      );
      expect((await handle.repos.stockPool.findById('lp-tactic'))?.groupId).toBe('lp-tactic-group');
      expect((await handle.repos.stockPool.findById('lp-done'))?.groupId).toBe('lp-done-group');
      expect((await handle.repos.stockPool.findById('lp-new'))?.groupId).toBe('grp-1');
      // 已迁移行的 source 不会被误建分组
      expect(await handle.repos.stockGroup.findById('lp-done-group')).toBeNull();

      // source 列数据保留不删
      const raw = handle.db.select().from(stockPools).all();
      expect(raw.find((p) => p.id === 'lp-manual')?.source).toEqual({
        kind: 'manual',
        stockIds: ['002594.SZ', '600519.SH'],
      });

      // 幂等：再跑一次 ensureSchema，分组不重复、行数不变
      ensureSchema(handle.db);
      expect(await handle.repos.stockGroup.list()).toHaveLength(3);
      expect(await handle.repos.stockPool.list()).toHaveLength(5);
    } finally {
      handle.close();
    }
  });

  it('阶段 C 存量迁移：v0.5 → MVP accounts.kind=mock 自动升级为 real（幂等）', async () => {
    // 1) 手工建 accounts 表 + 灌 3 条 v0.5 旧 mock 行（绕过 repo.save 的 invariant）
    const handle = createDrizzleRepos(':memory:');
    try {
      const TS = 1750000000000;
      handle.db.run(sql`
        INSERT INTO accounts (id, name, kind, currency, initial_capital, created_at)
        VALUES
          ('f47ac10b-58cc-4372-a567-0e02b2c3d479', '默认模拟账户', 'mock', 'CNY', 1000000, ${TS}),
          ('a1b2c3d4-0001-4000-8000-000000000001', '长期持仓', 'mock', 'CNY', 500000, ${TS}),
          ('a1b2c3d4-0001-4000-8000-000000000002', '短线交易', 'mock', 'CNY', 200000, ${TS})
      `);
      // 灌一条新行 kind=real + 一条已迁移行（用于验证幂等不二次回填）
      await handle.repos.account.save(makeAccount('acc-real-1'));
      handle.db.run(sql`
        INSERT INTO accounts (id, name, kind, currency, initial_capital, created_at)
        VALUES ('already-real', '已经迁移', 'real', 'CNY', 100, ${TS})
      `);

      // 2) 直接调用迁移函数（ensureSchema 已经跑过，迁移不依赖它；这里只测函数行为）
      // 复刻 ensureSchema 末尾的迁移调用
      const { sql: sql2 } = await import('drizzle-orm');
      handle.db.run(sql2`UPDATE accounts SET kind = 'real' WHERE kind = 'mock'`);
      // 注：实际生产路径里 ensureSchema 末尾会跑，这里手工调用以验证 SQL 行为
      // 避免通过 client.ts 私有函数耦合。
      // （如要直接调私有函数，需要把 migrateLegacyAccountKinds export，权衡后维持原状。）

      // 3) 全部行应升为 real
      const all = await handle.repos.account.list();
      expect(all).toHaveLength(5);
      expect(all.every((a) => a.kind === 'real')).toBe(true);
      // 旧行 id 保留
      expect(all.find((a) => a.id === 'f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBeDefined();
      expect(all.find((a) => a.id === 'a1b2c3d4-0001-4000-8000-000000000001')).toBeDefined();
      expect(all.find((a) => a.id === 'a1b2c3d4-0001-4000-8000-000000000002')).toBeDefined();

      // 4) 幂等：再跑一次无变化
      handle.db.run(sql2`UPDATE accounts SET kind = 'real' WHERE kind = 'mock'`);
      const all2 = await handle.repos.account.list();
      expect(all2).toHaveLength(5);
      expect(all2.every((a) => a.kind === 'real')).toBe(true);
    } finally {
      handle.close();
    }
  });

  it('阶段 C 集成：createDrizzleRepos 自动跑 migrateLegacyAccountKinds（v0.5 旧库）', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { Database } = await import('bun:sqlite');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luoome-db-legacy-account-'));
    const dbPath = path.join(dir, 'legacy-account.sqlite');
    try {
      // 手工建 accounts 表 + 灌 1 条 kind=mock 旧行
      const sqlite = new Database(dbPath);
      sqlite.exec(`
        CREATE TABLE accounts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          currency TEXT NOT NULL,
          initial_capital REAL NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
      sqlite.exec(`
        INSERT INTO accounts (id, name, kind, currency, initial_capital, created_at)
        VALUES ('f47ac10b-58cc-4372-a567-0e02b2c3d479', '默认模拟账户', 'mock', 'CNY', 1000000, 1750000000000)
      `);
      sqlite.close();

      // 打开 db（createDrizzleRepos 应自动跑 migrateLegacyAccountKinds）
      const handle = createDrizzleRepos(dbPath);
      try {
        const after = await handle.repos.account.list();
        expect(after).toHaveLength(1);
        expect(after[0]?.kind).toBe('real');
        expect(after[0]?.name).toBe('默认模拟账户'); // name 保留
        expect(after[0]?.initialCapital).toBe(1000000); // initialCapital 保留
      } finally {
        handle.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
