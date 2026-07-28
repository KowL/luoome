import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { getMarketDataStatusTool } from './get-market-data-status.js';

describe('tool/get_market_data_status', () => {
  it('数据集库存来自 Gateway，新增 capability 不依赖写死 provider 常量', async () => {
    const ctx = await buildTestContext({
      stockUniverse: {
        name: 'stock-universe',
        sources: ['universe-test'],
        fetchStockUniverse: () => Promise.reject(new Error('not used')),
      },
      limitUpLadder: {
        name: 'limit-up-ladder',
        sources: ['ladder-test'],
        fetchLadder: () => Promise.reject(new Error('not used')),
        compareLadder: () => Promise.reject(new Error('not used')),
      },
    });
    const result = await getMarketDataStatusTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.datasets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dataset: 'quote', source: 'test' }),
        expect.objectContaining({ dataset: 'daily-bars', source: 'test' }),
        expect.objectContaining({ dataset: 'market-snapshot', source: 'test' }),
        expect.objectContaining({
          dataset: 'stock-universe',
          source: 'universe-test',
        }),
        expect.objectContaining({
          dataset: 'limit-up-ladder',
          source: 'ladder-test',
        }),
      ]),
    );
    expect(result.data.providers.map((provider) => provider.provider)).toEqual(
      expect.arrayContaining(['test', 'universe-test', 'ladder-test']),
    );
  });
});
