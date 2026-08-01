import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDrizzleRepos, ensureSchema } from './client.js';
import { makeAccount, makeReport } from './repository/contract-tests.js';
import { accounts } from './schema/index.js';

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
      await h1.repos.report.upsertForPeriod(makeReport('report-persist'));
      h1.close();

      const h2 = createDrizzleRepos(dbPath);
      expect(await h2.repos.account.findById('acc-persist')).not.toBeNull();
      expect((await h2.repos.report.findById('report-persist'))?.title).toBe(
        '收盘复盘-report-persist',
      );
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
