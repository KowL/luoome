import { money } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { MarketSourceRegistry } from './source-registry.js';

describe('market/source-registry', () => {
  it('realtime 与 delayed index 使用不同 capability route', () => {
    const registry = new MarketSourceRegistry(
      [
        {
          capability: 'delayed-index',
          source: 'tushare',
          coverage: ['CN_A_SHARES_SH_SZ'],
          configurationReady: true,
          execute: () => Promise.resolve([]),
        },
        {
          capability: 'realtime-index',
          source: 'eastmoney',
          coverage: ['CN_A_SHARES_SH_SZ'],
          configurationReady: true,
          execute: () => Promise.resolve([]),
        },
      ],
      () => new Date('2026-07-28T02:30:00.000Z'),
    );

    expect(registry.sources('realtime-index').map((source) => source.source)).toEqual([
      'eastmoney',
    ]);
    expect(registry.sources('delayed-index').map((source) => source.source)).toEqual(['tushare']);
  });

  it('执行观测自动进入动态健康库存', async () => {
    const now = new Date('2026-07-28T02:30:00.000Z');
    const registry = new MarketSourceRegistry(
      [
        {
          capability: 'quote',
          source: 'eastmoney',
          coverage: ['CN_A_SHARES_SH_SZ'],
          configurationReady: true,
          execute: ({ stockId }) =>
            Promise.resolve({
              stockId,
              observedAt: now,
              fetchedAt: now,
              timestampSource: 'retrieval',
              ts: now,
              open: money(10),
              high: money(10),
              low: money(10),
              close: money(10),
              volume: 100,
              source: 'eastmoney',
            }),
          dataAsOf: (quote) => quote.observedAt,
        },
      ],
      () => now,
    );

    await registry.sources('quote')[0]?.execute({ stockId: '600519.SH' });
    expect(registry.describe()[0]).toMatchObject({
      dataset: 'quote',
      source: 'eastmoney',
      lastAttemptAt: now,
      lastSuccessAt: now,
      dataAsOf: now,
    });
  });

  it('同 source/capability 重复注册时启动期失败', () => {
    const duplicate = {
      capability: 'search' as const,
      source: 'eastmoney',
      coverage: ['CN_A_SHARES_SH_SZ'] as const,
      configurationReady: true,
      execute: () => Promise.resolve([]),
    };
    expect(() => new MarketSourceRegistry([duplicate, duplicate], () => new Date())).toThrow(
      /duplicate market capability binding/,
    );
  });

  it('失败会记录 lastErrorKind，后续成功会清除错误并更新时间', async () => {
    let shouldFail = true;
    let now = new Date('2026-07-28T02:30:00.000Z');
    const registry = new MarketSourceRegistry(
      [
        {
          capability: 'search',
          source: 'eastmoney',
          coverage: ['CN_A_SHARES_SH_SZ'],
          configurationReady: true,
          execute: () => {
            if (shouldFail) throw new Error('timeout: upstream unavailable');
            return Promise.resolve([]);
          },
        },
      ],
      () => now,
    );
    const source = registry.sources('search')[0];

    await expect(source?.execute({ query: '茅台' })).rejects.toThrow(/timeout/);
    expect(registry.describe()[0]).toMatchObject({
      lastAttemptAt: now,
      lastErrorKind: 'timeout',
    });

    shouldFail = false;
    now = new Date('2026-07-28T02:31:00.000Z');
    await source?.execute({ query: '茅台' });
    expect(registry.describe()[0]).toMatchObject({
      lastAttemptAt: now,
      lastSuccessAt: now,
    });
    expect(registry.describe()[0]?.lastErrorKind).toBeUndefined();
  });

  it('配置未就绪时启动期失败', () => {
    expect(
      () =>
        new MarketSourceRegistry(
          [
            {
              capability: 'search',
              source: 'tushare',
              coverage: ['CN_A_SHARES_SH_SZ'],
              configurationReady: false,
              execute: () => Promise.resolve([]),
            },
          ],
          () => new Date(),
        ),
    ).toThrow(/configuration not ready/);
  });
});
