import type { MinuteBar, Quote, ToolContext } from '@luoome/core';
import { getIntradaySummaryTool } from '@luoome/toolkit/tools/get-intraday-summary.js';
import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';

const quote = (overrides: Partial<Quote> = {}): Quote => ({
  stockId: '002594.SZ',
  observedAt: new Date('2026-07-17T06:59:00.000Z'),
  fetchedAt: new Date('2026-07-17T07:00:00.000Z'),
  timestampSource: 'upstream',
  ts: new Date('2026-07-17T06:59:00.000Z'),
  open: 99 as Quote['open'],
  high: 102 as Quote['high'],
  low: 98 as Quote['low'],
  close: 101 as Quote['close'],
  volume: 1_000_000,
  prevClose: 100 as Quote['prevClose'],
  source: 'fixture-quote',
  ...overrides,
});

const minuteBar = (input: {
  readonly endedAt: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly amount?: number;
}): MinuteBar => ({
  stockId: '002594.SZ',
  interval: '1m',
  endedAt: new Date(input.endedAt),
  open: input.open as MinuteBar['open'],
  high: input.high as MinuteBar['high'],
  low: input.low as MinuteBar['low'],
  close: input.close as MinuteBar['close'],
  volume: input.volume,
  ...(input.amount === undefined ? {} : { amount: input.amount }),
  adjustment: 'raw',
  source: 'fixture-minute',
  fetchedAt: new Date('2026-07-17T07:00:00.000Z'),
  completeness: 'closed',
});

const contextWithMarket = async (market: {
  readonly name: string;
  fetchQuote: () => Promise<Quote>;
  fetchMinuteBars: () => Promise<readonly MinuteBar[]>;
}): Promise<ToolContext> => {
  const ctx = await buildTestContext();
  return {
    ...ctx,
    adapters: { ...ctx.adapters, market: market as unknown as ToolContext['adapters']['market'] },
  };
};

describe('tool/get_intraday_summary', () => {
  it('返回开盘相对昨收的缺口、高低点时间、最新价与 VWAP', async () => {
    const ctx = await contextWithMarket({
      name: 'fixture',
      fetchQuote: async () => quote(),
      fetchMinuteBars: async () => [
        minuteBar({
          endedAt: '2026-07-17T01:30:00.000Z',
          open: 99,
          high: 99.5,
          low: 98.5,
          close: 99,
          volume: 100,
          amount: 9_900,
        }),
        minuteBar({
          endedAt: '2026-07-17T01:31:00.000Z',
          open: 99,
          high: 102,
          low: 99,
          close: 101,
          volume: 300,
          amount: 30_300,
        }),
      ],
    });

    const res = await getIntradaySummaryTool.execute({ stockId: '002594.SZ' }, ctx);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.supported).toBe(true);
    expect(res.data.date).toBe('2026-07-17');
    expect(res.data.pointsCount).toBe(2);
    expect(res.data.open).toEqual({
      price: 99,
      at: new Date('2026-07-17T01:30:00.000Z'),
    });
    expect(res.data.previousClose).toBe(100);
    expect(res.data.openGapPct).toBe(-1);
    expect(res.data.openVsPrevClose).toBe('low');
    expect(res.data.high?.price).toBe(102);
    expect(res.data.high?.at).toEqual(new Date('2026-07-17T01:31:00.000Z'));
    expect(res.data.low?.price).toBe(98.5);
    expect(res.data.latest?.price).toBe(101);
    expect(res.data.vwap).toBeCloseTo(402 / 4);
    expect(res.data.changePct).toBe(1);
  });

  it('无分时能力时退回快照事实并显式标记 supported=false', async () => {
    const ctx = await contextWithMarket({
      name: 'fixture',
      fetchQuote: async () => quote(),
      fetchMinuteBars: async () => {
        throw new Error('unsupported_capability: minute-bars');
      },
    });

    const res = await getIntradaySummaryTool.execute({ stockId: '002594.SZ' }, ctx);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.supported).toBe(false);
    expect(res.data.pointsCount).toBe(0);
    expect(res.data.warnings).toEqual(
      expect.arrayContaining(['unsupported-capability', 'no-intraday-points']),
    );
    expect(res.data.open?.price).toBe(99);
    expect(res.data.openVsPrevClose).toBe('low');
    expect(res.data.vwap).toBeNull();
  });

  it('分时与快照都不可用时返回 adapter_error', async () => {
    const ctx = await contextWithMarket({
      name: 'fixture',
      fetchQuote: async () => {
        throw new Error('upstream down');
      },
      fetchMinuteBars: async () => [],
    });

    const res = await getIntradaySummaryTool.execute({ stockId: '002594.SZ' }, ctx);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('adapter_error');
  });
});
