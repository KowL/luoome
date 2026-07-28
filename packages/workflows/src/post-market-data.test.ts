import type { StockUniverseManagerLike } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { postMarketDataWorkflow } from './post-market-data.js';

describe('workflow/post-market-data', () => {
  it('非交易日直接 skipped，不访问股票目录数据源', async () => {
    let universeCalls = 0;
    const manager: StockUniverseManagerLike = {
      name: 'stock-universe',
      sources: ['test'],
      fetchStockUniverse: async () => {
        universeCalls += 1;
        throw new Error('must not run');
      },
    };
    const ctx = await buildTestContext({
      clock: () => new Date('2026-08-01T08:30:00.000Z'),
      stockUniverse: manager,
    });

    const result = await postMarketDataWorkflow.run({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('skipped');
    expect(universeCalls).toBe(0);
  });

  it('目录失败但相关股票日线成功 → partial，不阻断日线归档', async () => {
    const manager: StockUniverseManagerLike = {
      name: 'stock-universe',
      sources: ['test'],
      fetchStockUniverse: () => Promise.reject(new Error('directory down')),
    };
    const ctx = await buildTestContext({
      clock: () => new Date('2026-07-27T08:30:00.000Z'),
      stockUniverse: manager,
    });

    const result = await postMarketDataWorkflow.run({ forceUniverse: true }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('partial');
    expect(result.data.universe.status).toBe('failed');
    expect(result.data.dailyBars.status).toBe('succeeded');
    expect(result.data.dailyBars.synced).toBeGreaterThan(0);
  });
});
