import { type DateRange, type MarketDataAdapterLike, money } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { syncDailyBarsTool } from './sync-daily-bars.js';

const qfqBar = (stockId: string, date: string) => ({
  stockId,
  date: new Date(`${date}T00:00:00.000Z`),
  open: money(10),
  high: money(11),
  low: money(9),
  close: money(10.5),
  volume: 1_000_000,
  adjustment: 'qfq' as const,
  source: 'test-source',
});

describe('tool/sync_daily_bars', () => {
  it('explicit 范围逐股拉取并持久化 qfq 日线', async () => {
    const calls: Array<{ stockId: string; range: DateRange }> = [];
    const base = await buildTestContext({
      clock: () => new Date('2026-07-28T08:30:00.000Z'),
    });
    const market: MarketDataAdapterLike = {
      ...base.adapters.market,
      fetchDailyBars: async (stockId, range) => {
        calls.push({ stockId, range });
        return [qfqBar(stockId, '2026-07-27')];
      },
    };
    const ctx = {
      ...base,
      adapters: { ...base.adapters, market },
    };

    const result = await syncDailyBarsTool.execute(
      {
        scope: 'explicit',
        stockIds: ['600519.SH', '000001.SZ'],
        correctionWindowDays: 15,
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('succeeded');
    expect(result.data.synced).toBe(2);
    expect(result.data.failed).toBe(0);
    expect(calls).toHaveLength(2);
    expect(
      await ctx.repos.dailyBar.findInRange(
        '600519.SH',
        new Date('2026-07-01T00:00:00.000Z'),
        new Date('2026-07-31T00:00:00.000Z'),
      ),
    ).toHaveLength(1);
  });

  it('relevant 范围纳入启用 Watchlist 的当前成员（disabled 不纳入）', async () => {
    const calls: string[] = [];
    const now = new Date('2026-07-28T08:30:00.000Z');
    const base = await buildTestContext({
      clock: () => now,
    });
    await base.repos.watchlist.save({
      id: 'wl-active',
      name: '启用观察',
      kind: 'personal',
      membershipPolicy: 'manual',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    await base.repos.watchlistMember.saveMember({
      id: 'wl-active:000001.SZ',
      watchlistId: 'wl-active',
      stockId: '000001.SZ',
      stage: 'watching',
      priority: 'normal',
      firstAddedAt: now,
      lastActivityAt: now,
    });
    await base.repos.watchlist.save({
      id: 'wl-disabled',
      name: '停用观察',
      kind: 'personal',
      membershipPolicy: 'manual',
      enabled: false,
      createdAt: now,
      updatedAt: now,
    });
    await base.repos.watchlistMember.saveMember({
      id: 'wl-disabled:601318.SH',
      watchlistId: 'wl-disabled',
      stockId: '601318.SH',
      stage: 'watching',
      priority: 'normal',
      firstAddedAt: now,
      lastActivityAt: now,
    });
    const market: MarketDataAdapterLike = {
      ...base.adapters.market,
      fetchDailyBars: async (stockId) => {
        calls.push(stockId);
        return [qfqBar(stockId, '2026-07-27')];
      },
    };
    const ctx = { ...base, adapters: { ...base.adapters, market } };

    const result = await syncDailyBarsTool.execute({ scope: 'relevant' }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toContain('000001.SZ');
    expect(calls).not.toContain('601318.SH');
  });

  it('单股失败返回 partial，并保留其它股票已成功的日线', async () => {
    const base = await buildTestContext({
      clock: () => new Date('2026-07-28T08:30:00.000Z'),
    });
    const market: MarketDataAdapterLike = {
      ...base.adapters.market,
      fetchDailyBars: async (stockId) => {
        if (stockId === '000001.SZ') throw new Error('upstream down');
        return [qfqBar(stockId, '2026-07-27')];
      },
    };
    const ctx = {
      ...base,
      adapters: { ...base.adapters, market },
    };

    const result = await syncDailyBarsTool.execute(
      {
        scope: 'explicit',
        stockIds: ['600519.SH', '000001.SZ'],
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('partial');
    expect(result.data.synced).toBe(1);
    expect(result.data.failed).toBe(1);
    expect(result.data.items.find((item) => item.stockId === '000001.SZ')).toMatchObject({
      status: 'failed',
      reason: 'upstream down',
    });
  });

  it('已有日线时从最后日期向前覆盖 correction window', async () => {
    let requestedRange: DateRange | undefined;
    const base = await buildTestContext({
      clock: () => new Date('2026-07-28T08:30:00.000Z'),
    });
    await base.repos.dailyBar.saveMany([qfqBar('600519.SH', '2026-07-20')]);
    const market: MarketDataAdapterLike = {
      ...base.adapters.market,
      fetchDailyBars: async (stockId, range) => {
        requestedRange = range;
        return [qfqBar(stockId, '2026-07-27')];
      },
    };
    const ctx = { ...base, adapters: { ...base.adapters, market } };

    await syncDailyBarsTool.execute(
      {
        scope: 'explicit',
        stockIds: ['600519.SH'],
        correctionWindowDays: 15,
      },
      ctx,
    );

    expect(requestedRange?.start).toEqual(new Date('2026-07-05T00:00:00.000Z'));
  });
});
