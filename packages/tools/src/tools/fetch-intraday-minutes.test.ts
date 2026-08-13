import type { IntradayMinute, MarketDataAdapterLike, ToolContext } from '@luoome/core';
import { money } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { fetchIntradayMinutesTool } from './fetch-intraday-minutes.js';

const minuteFixture = (time: string, price: number, cumVolume: number): IntradayMinute => ({
  stockId: '002594.SZ',
  time: new Date(time),
  price: money(price),
  cumVolume,
  source: 'tencent',
});

/** 在测试 ctx 的 market adapter 上叠加 fetchIntradayMinutes 实现。 */
const withIntradayMinutes = (
  ctx: ToolContext,
  fetchIntradayMinutes: MarketDataAdapterLike['fetchIntradayMinutes'],
): ToolContext => ({
  ...ctx,
  adapters: {
    ...ctx.adapters,
    market: {
      ...ctx.adapters.market,
      name: 'stub-market',
      fetchIntradayMinutes,
    },
  },
});

describe('tool/fetch_intraday_minutes', () => {
  it('正常路径：返回分钟序列与上海交易日', async () => {
    const ctx = await buildTestContext();
    const res = await fetchIntradayMinutesTool.execute(
      { stockId: '002594.SZ' },
      withIntradayMinutes(ctx, () =>
        Promise.resolve([
          minuteFixture('2026-08-11T01:30:00.000Z', 91.18, 118_900),
          minuteFixture('2026-08-11T07:00:00.000Z', 90.12, 24_247_500),
        ]),
      ),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.supported).toBe(true);
    expect(res.data.date).toBe('2026-08-11');
    expect(res.data.points).toHaveLength(2);
    expect(res.data.points[0]?.price).toBe(91.18);
    expect(res.data.points[1]?.cumVolume).toBe(24_247_500);
  });

  it('降级路径：数据源不支持 intraday-minutes → supported: false + 空序列', async () => {
    const ctx = await buildTestContext();
    const res = await fetchIntradayMinutesTool.execute({ stockId: '002594.SZ' }, ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.supported).toBe(false);
    expect(res.data.points).toEqual([]);
    expect(res.data.date).toBeUndefined();
  });

  it('错误路径：adapter 抛错 → adapter_error', async () => {
    const ctx = await buildTestContext();
    const res = await fetchIntradayMinutesTool.execute(
      { stockId: '002594.SZ' },
      withIntradayMinutes(ctx, () => Promise.reject(new Error('tencent down'))),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('adapter_error');
  });
});
