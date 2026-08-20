import type { MarketDataAdapterLike, MinuteBar, ToolContext } from '@luoome/core';
import { money } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { getStockMinuteBarsTool } from './get-stock-minute-bars.js';

const bar = (
  endedAt: string,
  fetchedAt: string,
  overrides: Partial<MinuteBar> = {},
): MinuteBar => ({
  stockId: '002594.SZ',
  interval: '1m',
  endedAt: new Date(endedAt),
  open: money(91),
  high: money(92),
  low: money(90),
  close: money(91.5),
  volume: 10_000,
  amount: 915_000,
  adjustment: 'raw',
  source: 'tushare',
  fetchedAt: new Date(fetchedAt),
  completeness: 'closed',
  ...overrides,
});

const withMinuteBars = (
  ctx: ToolContext,
  fetchMinuteBars: MarketDataAdapterLike['fetchMinuteBars'],
): ToolContext => ({
  ...ctx,
  adapters: {
    ...ctx.adapters,
    market: { ...ctx.adapters.market, name: 'minute-test', fetchMinuteBars },
  },
});

describe('tool/get_stock_minute_bars', () => {
  it('真实当前分钟入库；内部缺口与盘中未结束诚实标 partial', async () => {
    const now = new Date('2026-08-14T02:03:30.000Z');
    const ctx = await buildTestContext({ clock: () => now });
    const result = await getStockMinuteBarsTool.execute(
      { stockId: '002594.SZ', interval: '1m' },
      withMinuteBars(ctx, () =>
        Promise.resolve([
          bar('2026-08-14T01:31:00.000Z', now.toISOString()),
          bar('2026-08-14T01:33:00.000Z', now.toISOString(), { completeness: 'live' }),
        ]),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      date: '2026-08-14',
      status: 'partial',
      retrieval: 'live',
      freshness: 'fresh',
      retentionDays: 30,
    });
    expect(result.data.warnings).toEqual(
      expect.arrayContaining(['gaps-detected', 'session-in-progress']),
    );
    expect(result.data.gaps[0]?.missingBars).toBe(1);
    expect(await ctx.repos.minuteBar.latestSession('002594.SZ', '1m')).toHaveLength(2);
  });

  it('无 capability 且无本地事实 → unavailable，不返回 adapter_error', async () => {
    const ctx = await buildTestContext({
      clock: () => new Date('2026-08-14T02:03:30.000Z'),
    });
    const result = await getStockMinuteBarsTool.execute(
      { stockId: '002594.SZ', interval: '5m' },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      status: 'unavailable',
      retrieval: 'none',
      freshness: 'unavailable',
      bars: [],
    });
    expect(result.data.warnings).toContain('unsupported-capability');
  });

  it('provider 失败时回退最新本地 session，并标 stale/local-fallback', async () => {
    const now = new Date('2026-08-15T03:00:00.000Z');
    const ctx = await buildTestContext({ clock: () => now });
    await ctx.repos.minuteBar.saveMany([
      bar('2026-08-14T01:31:00.000Z', '2026-08-14T07:01:00.000Z'),
      bar('2026-08-14T07:00:00.000Z', '2026-08-14T07:01:00.000Z'),
    ]);
    const result = await getStockMinuteBarsTool.execute(
      { stockId: '002594.SZ' },
      withMinuteBars(ctx, () => Promise.reject(new Error('tushare upstream_error: 2002'))),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      date: '2026-08-14',
      status: 'complete',
      retrieval: 'local-fallback',
      freshness: 'stale',
    });
    expect(result.data.warnings).toEqual(
      expect.arrayContaining(['provider-error', 'local-fallback']),
    );
  });

  it('显式历史日期只读本地，不调用 current-session provider', async () => {
    const ctx = await buildTestContext({
      clock: () => new Date('2026-08-15T03:00:00.000Z'),
    });
    await ctx.repos.minuteBar.saveMany([
      bar('2026-08-14T01:31:00.000Z', '2026-08-14T07:01:00.000Z'),
    ]);
    let calls = 0;
    const result = await getStockMinuteBarsTool.execute(
      { stockId: '002594.SZ', date: '2026-08-14' },
      withMinuteBars(ctx, () => {
        calls += 1;
        return Promise.resolve([]);
      }),
    );
    expect(calls).toBe(0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.retrieval).toBe('local-fallback');
    expect(result.data.warnings).toContain('historical-provider-unavailable');
  });

  it('远端成功后机会式清理 30 天前分钟数据', async () => {
    const now = new Date('2026-08-14T02:03:30.000Z');
    const ctx = await buildTestContext({ clock: () => now });
    const old = bar('2026-07-01T01:31:00.000Z', '2026-07-01T02:00:00.000Z');
    await ctx.repos.minuteBar.saveMany([old]);
    await getStockMinuteBarsTool.execute(
      { stockId: '002594.SZ' },
      withMinuteBars(ctx, () =>
        Promise.resolve([bar('2026-08-14T01:31:00.000Z', now.toISOString())]),
      ),
    );
    expect(
      await ctx.repos.minuteBar.findInRange('002594.SZ', '1m', old.endedAt, old.endedAt),
    ).toEqual([]);
  });
});
