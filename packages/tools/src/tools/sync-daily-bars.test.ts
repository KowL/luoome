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
