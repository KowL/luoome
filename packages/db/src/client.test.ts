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
});
