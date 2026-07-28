import { TEST_STOCKS } from '@luoome/adapters/testing';
import type { MarketDataAdapterLike } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';
import { runTacticTool } from './run-tactic.js';

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
});

describe('run_tactic scope=all-stocks 候选全集（全市场快照优先）', () => {
  it('adapter 有快照 → 候选=快照全集（非本地 stocks 表）', async () => {
    const ctx = await buildTestContext();
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
          { id: '000002.SZ', code: '000002', exchange: 'SZ', name: '万科A', close: 7.2 },
        ]),
    };
    const ctx2 = { ...ctx, adapters: { ...ctx.adapters, market } };
    const r = await runTacticTool.execute(
      { tacticId: 'breakout-volume', scope: 'all-stocks', lookbackDays: 60, persistSignals: false },
      ctx2,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.evaluatedStocks).toBe(2); // 快照 2 只，而非本地 20 只
  });

  it('adapter 无快照方法 → 降级本地 stocks 表', async () => {
    const ctx = await buildTestContext();
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
    expect(r.data.evaluatedStocks).toBe(TEST_STOCKS.length);
  });

  it('快照方法抛错 → 降级本地 stocks 表', async () => {
    const ctx = await buildTestContext();
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
    expect(r.data.evaluatedStocks).toBe(TEST_STOCKS.length);
  });

  it('Fake adapter 快照 == 种子 stocks：默认上下文 evaluatedStocks = TEST_STOCKS 数', async () => {
    const ctx = await buildTestContext();
    const r = await runTacticTool.execute(
      { tacticId: 'breakout-volume', scope: 'all-stocks', lookbackDays: 60, persistSignals: false },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.evaluatedStocks).toBe(TEST_STOCKS.length);
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
