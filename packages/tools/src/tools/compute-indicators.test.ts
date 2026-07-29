import { type DailyBar, type MarketDataAdapterLike, money, type ToolContext } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';
import { computeIndicatorsTool } from './compute-indicators.js';

const barsFromCloses = (stockId: string, closes: readonly number[]): DailyBar[] =>
  closes.map((close, index) => ({
    stockId,
    date: new Date(Date.UTC(2026, 0, index + 1)),
    open: money(close),
    high: money(close + 0.5),
    low: money(close - 0.5),
    close: money(close),
    volume: 1_000_000 + index * 10_000,
    adjustment: 'qfq',
    source: 'indicator-test',
  }));

const withDailyBars = async (closes: readonly number[]): Promise<ToolContext> => {
  const base = await buildTestContext();
  const market: MarketDataAdapterLike = {
    ...base.adapters.market,
    fetchDailyBars: async (stockId) => barsFromCloses(stockId, closes),
  };
  return { ...base, adapters: { ...base.adapters, market } };
};

describe('tool/compute_indicators', () => {
  it('正常路径：返回 indicators + barsCount + dataAsOf', async () => {
    const ctx = await buildTestContext();
    const res = await computeIndicatorsTool.execute({ stockId: '002594.SZ' }, ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.stockId).toBe('002594.SZ');
    expect(res.data.barsCount).toBeGreaterThan(0);
    // mock 出 60 根日线 → MA5/MA10/MA20 都能算
    expect(res.data.indicators.ma5).toBeDefined();
    expect(res.data.indicators.ma20).toBeDefined();
    expect(res.data.dataAsOf).toBeInstanceOf(Date);
  });

  it('正常路径：lookbackDays 自定义', async () => {
    const ctx = await buildTestContext();
    const res = await computeIndicatorsTool.execute(
      { stockId: '002594.SZ', lookbackDays: 30 },
      ctx,
    );
    expect(res.ok).toBe(true);
  });

  it('错误路径：stock 不存在 → not_found', async () => {
    const ctx = await buildTestContext();
    const res = await computeIndicatorsTool.execute({ stockId: 'NOPE' }, ctx);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('not_found');
  });

  it('错误路径：lookbackDays > 365 → invalid_input', async () => {
    const ctx = await buildTestContext();
    const res = await computeIndicatorsTool.execute(
      { stockId: '002594.SZ', lookbackDays: 500 },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid_input');
  });

  it('给早期突破返回最新价、20 日动量和 MA20/MA60 距离', async () => {
    const closes = Array.from({ length: 60 }, (_, index) => 10 + index * 0.1);
    const ctx = await withDailyBars(closes);

    const res = await computeIndicatorsTool.execute({ stockId: '002594.SZ' }, ctx);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const expectedClose = closes.at(-1) as number;
    const expectedMomentum = (expectedClose / (closes.at(-20) as number) - 1) * 100;
    expect(res.data.indicators.close).toBeCloseTo(expectedClose);
    expect(res.data.indicators.momentum20Pct).toBeCloseTo(expectedMomentum);
    expect(res.data.indicators.maDistance20Pct).toBeCloseTo(
      ((expectedClose - (res.data.indicators.ma20 as number)) /
        (res.data.indicators.ma20 as number)) *
        100,
    );
    expect(res.data.indicators.maDistance60Pct).toBeCloseTo(
      ((expectedClose - (res.data.indicators.ma60 as number)) /
        (res.data.indicators.ma60 as number)) *
        100,
    );
  });

  it('标记最新交易日刚上穿 MA20/MA60，并统计连续站上 MA20 天数', async () => {
    const ctx = await withDailyBars([...Array<number>(60).fill(10), 9, 9, 9, 9, 11]);

    const res = await computeIndicatorsTool.execute({ stockId: '002594.SZ' }, ctx);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.indicators.daysSinceMa20CrossUp).toBe(0);
    expect(res.data.indicators.daysSinceMa60CrossUp).toBe(0);
    expect(res.data.indicators.daysAboveMa20).toBe(1);
  });

  it('返回 Bollinger 20 日轨道、带宽和最新价格位置', async () => {
    const closes = [...Array<number>(19).fill(10), 8];
    const ctx = await withDailyBars(closes);

    const res = await computeIndicatorsTool.execute({ stockId: '002594.SZ' }, ctx);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const middle = closes.reduce((sum, close) => sum + close, 0) / closes.length;
    const variance =
      closes.reduce((sum, close) => sum + (close - middle) ** 2, 0) / (closes.length - 1);
    const standardDeviation = Math.sqrt(variance);
    const upper = middle + 2 * standardDeviation;
    const lower = middle - 2 * standardDeviation;
    expect(res.data.indicators.bollMiddle20).toBeCloseTo(middle);
    expect(res.data.indicators.bollUpper20).toBeCloseTo(upper);
    expect(res.data.indicators.bollLower20).toBeCloseTo(lower);
    expect(res.data.indicators.bollBandwidth20Pct).toBeCloseTo(((upper - lower) / middle) * 100);
    expect(res.data.indicators.bollPosition20).toBeCloseTo((8 - lower) / (upper - lower));
  });

  it('横盘零带宽时 Bollinger 位置稳定为中点，不产生 NaN', async () => {
    const ctx = await withDailyBars(Array<number>(20).fill(10));

    const res = await computeIndicatorsTool.execute({ stockId: '002594.SZ' }, ctx);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.indicators.bollBandwidth20Pct).toBe(0);
    expect(res.data.indicators.bollPosition20).toBe(0.5);
  });
});
