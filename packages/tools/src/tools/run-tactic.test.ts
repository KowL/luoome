import { TEST_STOCKS } from '@luoome/adapters/testing';
import { type DailyBar, type MarketDataAdapterLike, money } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { buildTestContext, seedTestStockUniverse } from '../testing/context.js';
import { runTacticTool } from './run-tactic.js';

const A_SHARE_TEST_STOCKS = TEST_STOCKS.filter(
  (stock) => stock.exchange === 'SH' || stock.exchange === 'SZ',
);

const earlyBreakoutBars = (stockId: string): DailyBar[] => {
  const tail = [
    9.9, 10.1, 9.9, 10.1, 9.9, 10.1, 9.9, 10.1, 9.9, 10.1, 9.9, 10.1, 9.9, 10.1, 9.9, 10.2, 10.1,
    9.8, 9.8, 10.5,
  ];
  return [...Array<number>(45).fill(10), ...tail].map((close, index) => ({
    stockId,
    date: new Date(Date.UTC(2026, 0, index + 1)),
    open: money(close),
    high: money(close + 0.2),
    low: money(close - 0.2),
    close: money(close),
    volume: index < 60 ? 1_000_000 : 2_000_000,
    adjustment: 'qfq',
    source: 'early-breakout-test',
  }));
};

describe('tool/run_tactic', () => {
  it('战法不存在 → not_found', async () => {
    const ctx = await buildTestContext();
    const r = await runTacticTool.execute(
      { tacticId: 'nope', scope: 'holdings', lookbackDays: 120 },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not_found');
  });

  it('跑内置战法：返回 signals 数组（可为空）', async () => {
    const ctx = await buildTestContext();
    const r = await runTacticTool.execute(
      { tacticId: 'breakout-volume', scope: 'holdings', lookbackDays: 120 },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.tacticId).toBe('breakout-volume');
    expect(Array.isArray(r.data.signals)).toBe(true);
    expect(typeof r.data.evaluatedStocks).toBe('number');
    expect(typeof r.data.triggeredCount).toBe('number');
  });

  it('从规范日线计算指标并命中 early-breakout', async () => {
    const base = await buildTestContext();
    const market: MarketDataAdapterLike = {
      ...base.adapters.market,
      fetchQuote: (stockId) => base.adapters.market.fetchQuote(stockId),
      fetchDailyBars: async (stockId) => earlyBreakoutBars(stockId),
    };
    const ctx = { ...base, adapters: { ...base.adapters, market } };

    const result = await runTacticTool.execute(
      {
        tacticId: 'early-breakout',
        scope: 'watchlist',
        stockIds: ['002594.SZ'],
        persistSignals: false,
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.evaluatedStocks).toBe(1);
    expect(result.data.triggeredCount).toBe(1);
    expect(result.data.signals[0]).toMatchObject({
      tacticId: 'early-breakout',
      stockId: '002594.SZ',
      direction: 'bullish',
    });
  });
});

describe('run_tactic scope=all-stocks 候选全集（StockUniverse 是身份事实源）', () => {
  it('没有成功同步的 StockUniverse 时拒绝把行情快照冒充全市场', async () => {
    const ctx = await buildTestContext();
    const r = await runTacticTool.execute(
      { tacticId: 'breakout-volume', scope: 'all-stocks', lookbackDays: 60, persistSignals: false },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('候选来自 active StockUniverse，行情快照只提供可选价格', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 2 });
    const base = ctx.adapters.market;
    const market: MarketDataAdapterLike = {
      ...base,
      name: 'stub-market',
      fetchQuote: (code) => base.fetchQuote(code),
      batchQuote: (codes) => base.batchQuote(codes),
      fetchDailyBars: (code, range) => base.fetchDailyBars(code, range),
      fetchMarketSnapshot: () =>
        Promise.resolve([
          { id: '000001.SZ', code: '000001', exchange: 'SZ', name: '平安银行', close: 11.5 },
        ]),
    };
    const ctx2 = { ...ctx, adapters: { ...ctx.adapters, market } };
    const r = await runTacticTool.execute(
      { tacticId: 'breakout-volume', scope: 'all-stocks', lookbackDays: 60, persistSignals: false },
      ctx2,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.evaluatedStocks).toBe(2);
    expect(r.data.universe).toEqual({
      coverage: 'CN_A_SHARES_SH_SZ',
      observedAt: new Date('2026-07-28T08:00:00.000Z'),
      activeStocks: 2,
    });
  });

  it('行情快照能力不可用时仍使用 active StockUniverse 身份', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 2 });
    const base = ctx.adapters.market;
    const market: MarketDataAdapterLike = {
      ...base,
      name: 'stub-market',
      fetchQuote: (code) => base.fetchQuote(code),
      batchQuote: (codes) => base.batchQuote(codes),
      fetchDailyBars: (code, range) => base.fetchDailyBars(code, range),
      fetchMarketSnapshot: () =>
        Promise.reject(new Error('unsupported_capability: market-snapshot')),
    };
    const ctx2 = { ...ctx, adapters: { ...ctx.adapters, market } };
    const r = await runTacticTool.execute(
      { tacticId: 'breakout-volume', scope: 'all-stocks', lookbackDays: 60, persistSignals: false },
      ctx2,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.evaluatedStocks).toBe(2);
  });

  it('行情快照抛错时仍使用 active StockUniverse 身份', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 2 });
    const base = ctx.adapters.market;
    const market: MarketDataAdapterLike = {
      ...base,
      name: 'stub-market',
      fetchQuote: (code) => base.fetchQuote(code),
      batchQuote: (codes) => base.batchQuote(codes),
      fetchDailyBars: (code, range) => base.fetchDailyBars(code, range),
      fetchMarketSnapshot: () => Promise.reject(new Error('snapshot down')),
    };
    const ctx2 = { ...ctx, adapters: { ...ctx.adapters, market } };
    const r = await runTacticTool.execute(
      { tacticId: 'breakout-volume', scope: 'all-stocks', lookbackDays: 60, persistSignals: false },
      ctx2,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.evaluatedStocks).toBe(2);
  });

  it('目录包含全部沪深测试股票时 evaluatedStocks = active 目录数量', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx);
    const r = await runTacticTool.execute(
      { tacticId: 'breakout-volume', scope: 'all-stocks', lookbackDays: 60, persistSignals: false },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.evaluatedStocks).toBe(A_SHARE_TEST_STOCKS.length);
  });
});

describe('run_tactic persistSignals 选项（v0.6 起）', () => {
  it('persistSignals=false 时不写 tactic_signals 表', async () => {
    const ctx = await buildTestContext();
    const before = (await ctx.repos.tactic.signalsByTactic('breakout-volume')).length;
    const r = await runTacticTool.execute(
      {
        tacticId: 'breakout-volume',
        scope: 'holdings',
        lookbackDays: 120,
        persistSignals: false,
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = (await ctx.repos.tactic.signalsByTactic('breakout-volume')).length;
    expect(after).toBe(before);
  });

  it('persistSignals=true（默认）落库', async () => {
    const ctx = await buildTestContext();
    const before = (await ctx.repos.tactic.signalsByTactic('breakout-volume')).length;
    const r = await runTacticTool.execute(
      {
        tacticId: 'breakout-volume',
        scope: 'holdings',
        lookbackDays: 120,
        // persistSignals omitted → default true
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = (await ctx.repos.tactic.signalsByTactic('breakout-volume')).length;
    // 可能多 0 / 1 / 多条（mock adapter 不确定）—— 只断言 ≥ before 且与 triggeredCount 一致
    expect(after).toBeGreaterThanOrEqual(before);
    expect(after - before).toBe(r.data.triggeredCount);
  });
});
