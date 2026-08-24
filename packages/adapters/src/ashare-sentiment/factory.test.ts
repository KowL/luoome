import type { Logger } from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';

import { EastmoneySource } from '../eastmoney/source.js';
import { createAShareSentimentManagerFromEnv } from './factory.js';

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const SEALED_FIXTURE = {
  data: {
    pool: [{ c: '000002', n: '万科A', lbc: 2, fund: 80_000_000, zbc: 0, hybk: '房地产' }],
  },
};

describe('createAShareSentimentManagerFromEnv', () => {
  it('默认装配 eastmoney 情绪 manager', () => {
    const manager = createAShareSentimentManagerFromEnv({}, { logger });
    expect(manager.fetch).toBeTypeOf('function');
    expect(manager.status).toBeTypeOf('function');
  });

  it('拒绝未验证的数据源和重复来源', () => {
    expect(() =>
      createAShareSentimentManagerFromEnv(
        { LUOOME_ASHARE_SENTIMENT_SOURCES: 'tushare' },
        { logger },
      ),
    ).toThrow();
    expect(() =>
      createAShareSentimentManagerFromEnv(
        { LUOOME_ASHARE_SENTIMENT_SOURCES: 'eastmoney,eastmoney' },
        { logger },
      ),
    ).toThrow();
  });

  it('注入共享 EastmoneySource 时复用该实例，不再用 deps.fetchImpl 自构', async () => {
    const injectedFetch = vi.fn(
      async () => new Response(JSON.stringify(SEALED_FIXTURE), { status: 200 }),
    ) as unknown as typeof fetch;
    const selfConstructFetch = vi.fn(async () => {
      throw new Error('must not self-construct');
    }) as unknown as typeof fetch;

    const manager = createAShareSentimentManagerFromEnv(
      {},
      {
        logger,
        fetchImpl: selfConstructFetch,
        sources: {
          eastmoney: new EastmoneySource({
            fetchImpl: injectedFetch,
            clock: () => new Date('2026-07-28T07:01:00.000Z'),
          }),
        },
      },
    );
    const result = await manager.fetch({ date: '2026-07-28', coverage: 'CN_A_SHARES_SH_SZ' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.limitUp.status).toBe('complete'); // 双池都走注入实例
    expect(injectedFetch).toHaveBeenCalled();
    expect(selfConstructFetch).not.toHaveBeenCalled();
  });

  it('status() 暴露封板 / 炸板两个 capability 的观测', () => {
    const manager = createAShareSentimentManagerFromEnv({}, { logger });
    const datasets = manager.status().map((s) => s.dataset);
    expect(datasets).toEqual(['sentiment-sealed-pool', 'sentiment-broken-pool']);
  });
});
