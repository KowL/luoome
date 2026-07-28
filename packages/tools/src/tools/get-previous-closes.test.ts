import { money } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { getPreviousClosesTool } from './get-previous-closes.js';

describe('tool/get_previous_closes', () => {
  it('批量返回严格早于目标交易日的最近 qfq 收盘价', async () => {
    const ctx = await buildTestContext();
    await ctx.repos.dailyBar.saveMany([
      {
        stockId: '600519.SH',
        date: new Date('2026-07-24T00:00:00.000Z'),
        open: money(1400),
        high: money(1420),
        low: money(1390),
        close: money(1410),
        volume: 1_000_000,
        adjustment: 'qfq',
        source: 'eastmoney',
      },
      {
        stockId: '600519.SH',
        date: new Date('2026-07-27T00:00:00.000Z'),
        open: money(1410),
        high: money(1430),
        low: money(1400),
        close: money(1420),
        volume: 1_100_000,
        adjustment: 'qfq',
        source: 'eastmoney',
      },
    ]);

    const result = await getPreviousClosesTool.execute(
      {
        stockIds: ['600519.SH', '000001.SZ'],
        tradingDate: '2026-07-27',
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items).toEqual([
      {
        stockId: '600519.SH',
        status: 'ok',
        close: 1410,
        date: '2026-07-24',
        source: 'eastmoney',
      },
      {
        stockId: '000001.SZ',
        status: 'unavailable',
        reason: 'no-qfq-daily-bar-before-2026-07-27',
      },
    ]);
  });
});
