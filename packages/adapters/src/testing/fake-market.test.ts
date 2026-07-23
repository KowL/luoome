import { DailyBarSchema, QuoteSchema } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { DEFAULT_TEST_NOW } from './deterministic.js';
import { FakeMarketAdapter } from './fake-market.js';
import { TEST_STOCK_BASE_PRICES, TEST_STOCKS } from './fixtures.js';

const fixedClock = () => new Date(DEFAULT_TEST_NOW.getTime());
const makeAdapter = () => new FakeMarketAdapter({ clock: fixedClock });

describe('FakeMarketAdapter.fetchQuote', () => {
  it('已知 fixture 股票：两次调用结果完全一致（deterministic）', async () => {
    const adapter = makeAdapter();
    const a = await adapter.fetchQuote('002594.SZ');
    const b = await adapter.fetchQuote('002594.SZ');
    expect(b).toEqual(a);
    expect(a.stockId).toBe('002594.SZ');
    expect(a.close).toBe(TEST_STOCK_BASE_PRICES['002594.SZ']);
    expect(a.ts).toEqual(fixedClock());
    expect(QuoteSchema.safeParse(a).success).toBe(true);
    // OHLC 关系
    expect(a.low).toBeLessThanOrEqual(a.open);
    expect(a.low).toBeLessThanOrEqual(a.close);
    expect(a.high).toBeGreaterThanOrEqual(a.open);
    expect(a.high).toBeGreaterThanOrEqual(a.close);
  });

  it('按裸代码也能命中 fixture（002594 → 002594.SZ）', async () => {
    const adapter = makeAdapter();
    const quote = await adapter.fetchQuote('002594');
    expect(quote.stockId).toBe('002594.SZ');
  });

  it('未知代码：稳定伪随机，多次调用一致', async () => {
    const adapter = makeAdapter();
    const a = await adapter.fetchQuote('ZZZ999');
    const b = await adapter.fetchQuote('ZZZ999');
    expect(b).toEqual(a);
    expect(a.stockId).toBe('ZZZ999');
    expect(a.close).toBeGreaterThan(0);
    expect(QuoteSchema.safeParse(a).success).toBe(true);
  });

  it('不同未知代码生成不同价格（hash 分散）', async () => {
    const adapter = makeAdapter();
    const a = await adapter.fetchQuote('FAKE1');
    const b = await adapter.fetchQuote('FAKE2');
    expect(a.close === b.close && a.volume === b.volume).toBe(false);
  });
});

describe('FakeMarketAdapter.batchQuote', () => {
  it('覆盖全部 20 只 fixture 股票', async () => {
    const adapter = makeAdapter();
    const ids = TEST_STOCKS.map((s) => s.id);
    const result = await adapter.batchQuote(ids);
    expect(result.size).toBe(TEST_STOCKS.length);
    for (const s of TEST_STOCKS) {
      const quote = result.get(s.id);
      expect(quote).toBeDefined();
      expect(quote?.stockId).toBe(s.id);
      expect(quote?.close).toBe(TEST_STOCK_BASE_PRICES[s.id]);
    }
  });
});

describe('FakeMarketAdapter.fetchDailyBars', () => {
  const range = {
    start: new Date(DEFAULT_TEST_NOW.getTime() - 59 * 86_400_000),
    end: new Date(DEFAULT_TEST_NOW.getTime()),
  };

  it('固定生成 60 根日线，日期升序', async () => {
    const adapter = makeAdapter();
    const bars = await adapter.fetchDailyBars('600519.SH', range);
    expect(bars).toHaveLength(60);
    for (let i = 1; i < bars.length; i++) {
      const prev = bars[i - 1];
      const curr = bars[i];
      expect(prev && curr).toBeTruthy();
      if (prev && curr) {
        expect(curr.date.getTime()).toBeGreaterThan(prev.date.getTime());
      }
    }
    for (const bar of bars) {
      expect(bar.stockId).toBe('600519.SH');
      expect(DailyBarSchema.safeParse(bar).success).toBe(true);
      expect(bar.low).toBeLessThanOrEqual(bar.close);
      expect(bar.high).toBeGreaterThanOrEqual(bar.close);
    }
  });

  it('deterministic：两次调用结果一致', async () => {
    const adapter = makeAdapter();
    const a = await adapter.fetchDailyBars('600519.SH', range);
    const b = await adapter.fetchDailyBars('600519.SH', range);
    expect(b).toEqual(a);
  });

  it('未知代码也能生成 60 根稳定日线', async () => {
    const adapter = makeAdapter();
    const a = await adapter.fetchDailyBars('ZZZ999', range);
    const b = await adapter.fetchDailyBars('ZZZ999', range);
    expect(a).toHaveLength(60);
    expect(b).toEqual(a);
    expect(a[0]?.stockId).toBe('ZZZ999');
  });
});
