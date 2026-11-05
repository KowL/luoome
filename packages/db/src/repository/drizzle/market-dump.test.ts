import { DailyBarRevisionSchema } from '@luoome/core';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDrizzleRepos, ensureSchema } from '../../client.js';
import { makeDailyBar, makeQuote } from '../contract-tests.js';
import { registerMarketDumpContractTests } from '../market-dump.contract-tests.js';

/**
 * Drizzle 实现（bun:sqlite :memory:）跑 market dump 契约套件。
 * 本文件位于 drizzle/ 下：vitest（node）按 vitest.config.ts 排除，由 `bun run test:db` 执行。
 * 三表 DDL 由共享 ensureSchema 建立（createDrizzleRepos 默认执行迁移），
 * 仓储经生产装配 createReposFromDatabase 注入。
 */
describe('Fuyao additive schema migration', () => {
  it('新建 dump 三表并重复迁移后，历史 Tushare 报价与 qfq revision 原样可读', async () => {
    const handle = createDrizzleRepos(':memory:');
    const at = new Date('2026-07-01T00:00:00.000Z');
    const quote = makeQuote('600519.SH', at, { source: 'tushare' });
    const bar = makeDailyBar('600519.SH', at, { source: 'tushare' });
    const revision = DailyBarRevisionSchema.parse({
      ...bar,
      recordedAt: at,
      contentHash: 'a'.repeat(64),
    });
    try {
      await handle.repos.quote.save(quote);
      await handle.repos.dailyBar.saveMany([bar]);
      await handle.repos.dailyBar.saveRevisions([revision]);
      // 模拟 Fuyao 扩展之前已有行情事实、尚无新增三表的库。
      handle.db.run(sql`DROP TABLE market_dump_runs`);
      handle.db.run(sql`DROP TABLE raw_daily_bar_revisions`);
      handle.db.run(sql`DROP TABLE corporate_action_event_revisions`);
      const readStored = () => ({
        quotes: handle.db.all(sql`SELECT * FROM price_snapshots`),
        bars: handle.db.all(sql`SELECT * FROM daily_bars`),
        revisions: handle.db.all(sql`SELECT * FROM daily_bar_revisions`),
      });
      const before = readStored();
      ensureSchema(handle.db);
      ensureSchema(handle.db);
      expect(readStored()).toEqual(before);
      expect(await handle.repos.quote.latestByStock('600519.SH')).toEqual(quote);
      expect(await handle.repos.dailyBar.findInRange('600519.SH', at, at)).toEqual([bar]);
      expect(await handle.repos.dailyBar.listRevisions({ stockId: '600519.SH' })).toEqual([
        revision,
      ]);
      expect(await handle.repos.marketDumpRun.listRecent({})).toEqual([]);
      expect(await handle.repos.rawDailyBar.listRevisions({ stockId: '600519.SH' })).toEqual([]);
      expect(
        await handle.repos.corporateActionEvent.listRevisions({ stockId: '600519.SH' }),
      ).toEqual([]);
    } finally {
      handle.close();
    }
  });
});

registerMarketDumpContractTests('drizzle', () => {
  const handle = createDrizzleRepos(':memory:');
  return {
    repos: {
      marketDumpRun: handle.repos.marketDumpRun,
      rawDailyBar: handle.repos.rawDailyBar,
      corporateActionEvent: handle.repos.corporateActionEvent,
    },
    close: handle.close,
  };
});
