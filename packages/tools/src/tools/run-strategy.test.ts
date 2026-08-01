import {
  type MarketDataAdapterLike,
  type Strategy,
  type StrategyDslV1,
  type StrategyVersion,
  strategyDefinitionHash,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext, seedTestDailyBars, seedTestStockUniverse } from '../testing/context.js';
import { runStrategyTool } from './run-strategy.js';

const seedStrategy = async (ctx: Awaited<ReturnType<typeof buildTestContext>>): Promise<void> => {
  const now = new Date('2026-07-28T09:00:00Z');
  const definition: StrategyDslV1 = {
    schemaVersion: 1,
    metadata: {},
    universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
    selection: {
      logic: 'all',
      rules: [
        {
          id: 'positive-price',
          name: '价格有效',
          when: 'quote.close > 0',
          evidence: ['价格有效'],
        },
      ],
    },
    scoring: {
      method: 'weighted-sum',
      components: [{ ruleId: 'positive-price', score: '50', weight: 1 }],
    },
    signals: {
      entry: [
        {
          id: 'entry',
          name: '研究信号',
          when: 'quote.close > 0',
          score: '60',
          direction: 'bullish',
          evidence: ['仅供研究'],
        },
      ],
      exit: [],
      risk: [],
    },
  };
  const version: StrategyVersion = {
    id: 'scan-strategy-v1',
    strategyId: 'scan-strategy',
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: now,
    createdAt: now,
  };
  const strategy: Strategy = {
    id: 'scan-strategy',
    name: '扫描策略',
    description: '测试扫描策略',
    owner: 'user',
    status: 'active',
    currentVersionId: version.id,
    createdAt: now,
    updatedAt: now,
  };
  await ctx.repos.strategy.save(strategy);
  await ctx.repos.strategy.saveVersion(version);
};

describe('run_strategy', () => {
  it('uses active StockUniverse, ranks deterministically and atomically persists', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 2 });
    await seedStrategy(ctx);
    const result = await runStrategyTool.execute(
      { strategyId: 'scan-strategy', stockIds: ['600519.SH', '300750.SZ'] },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.run.status).toBe('complete');
    expect(result.data.results.map((item) => [item.stockId, item.rank])).toEqual([
      ['300750.SZ', 1],
      ['600519.SH', 2],
    ]);
    expect(result.data.signals).toHaveLength(2);
    expect(result.data.run.inputSnapshot).toMatchObject({
      schemaVersion: 2,
      strategyVersionId: 'scan-strategy-v1',
      coverage: 'CN_A_SHARES_SH_SZ',
      stockIds: ['300750.SZ', '600519.SH'],
      requestedBy: 'manual',
    });
    expect(result.data.run.inputSnapshot.stockIdChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(result.data.run.summary).toMatchObject({
      schemaVersion: 2,
      universeCount: 2,
      evaluatedCount: 2,
      selectedCount: 2,
      signalCount: 2,
      partialCount: 0,
      failedCount: 0,
    });
    expect(await ctx.repos.strategyRun.findRunById(result.data.run.id)).not.toBeNull();
    expect(await ctx.repos.strategyRun.listResults(result.data.run.id)).toHaveLength(2);
  });

  it('dry-run does not persist', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 1 });
    await seedStrategy(ctx);
    const result = await runStrategyTool.execute(
      { strategyId: 'scan-strategy', stockIds: ['600519.SH'], persist: false },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.persisted).toBe(false);
    expect(await ctx.repos.strategyRun.findRunById(result.data.run.id)).toBeNull();
  });

  it('one stock data failure yields partial without blocking other stocks', async () => {
    const base = await buildTestContext();
    await seedTestStockUniverse(base, { limit: 2 });
    await seedStrategy(base);
    const market: MarketDataAdapterLike = {
      ...base.adapters.market,
      fetchQuote: (stockId) =>
        stockId === '300750.SZ'
          ? Promise.reject(new Error('quote unavailable'))
          : base.adapters.market.fetchQuote(stockId),
    };
    const ctx = { ...base, adapters: { ...base.adapters, market } };
    const result = await runStrategyTool.execute(
      { strategyId: 'scan-strategy', stockIds: ['300750.SZ', '600519.SH'] },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.run.status).toBe('partial');
    expect(result.data.results).toHaveLength(1);
    expect(result.data.run.summary).toMatchObject({ failedCount: 1, evaluatedCount: 1 });
  });

  it('all candidate data failures yield failed without partial persistence', async () => {
    const base = await buildTestContext();
    await seedTestStockUniverse(base, { limit: 1 });
    await seedStrategy(base);
    const market: MarketDataAdapterLike = {
      ...base.adapters.market,
      fetchQuote: () => Promise.reject(new Error('provider down')),
    };
    const ctx = { ...base, adapters: { ...base.adapters, market } };
    const result = await runStrategyTool.execute(
      { strategyId: 'scan-strategy', stockIds: ['600519.SH'] },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.run.status).toBe('failed');
    expect(result.data.results).toEqual([]);
    expect(await ctx.repos.strategyRun.findRunById(result.data.run.id)).toMatchObject({
      status: 'failed',
    });
  });

  it('rejects candidates outside the authoritative active universe', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 1 });
    await seedStrategy(ctx);
    const result = await runStrategyTool.execute(
      { strategyId: 'scan-strategy', stockIds: ['002594.SZ'] },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('refuses full-universe replay without a historical universe snapshot', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 1 });
    await seedStrategy(ctx);
    const result = await runStrategyTool.execute(
      {
        strategyId: 'scan-strategy',
        mode: 'replay',
        asOf: new Date('2026-07-01T00:00:00Z'),
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('rejects scan with asOf（历史 bars 与实时 quote 时点不一致）', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 1 });
    await seedStrategy(ctx);
    const result = await runStrategyTool.execute(
      {
        strategyId: 'scan-strategy',
        stockIds: ['600519.SH'],
        asOf: new Date('2026-07-01T00:00:00Z'),
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('replay 的 providerStatuses 只报本地 dailyBar，不以 market adapter 名义上报', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 1 });
    await seedTestDailyBars(ctx);
    await seedStrategy(ctx);
    const result = await runStrategyTool.execute(
      {
        strategyId: 'scan-strategy',
        mode: 'replay',
        asOf: new Date('2026-07-01T00:00:00Z'),
        stockIds: ['600519.SH'],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.run.providerStatuses.map((status) => status.provider)).toEqual([
      'local:daily-bars',
    ]);
  });
});
