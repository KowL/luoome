import { describe, expect, it } from 'vitest';

import { createLimitUpMarketManagerFromEnv } from './factory.js';

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe('createLimitUpMarketManagerFromEnv', () => {
  it('未配置 FUYAO_API_KEY → 不注入（undefined）', () => {
    expect(createLimitUpMarketManagerFromEnv({}, { logger })).toBeUndefined();
  });

  it('配置就绪 → 返回 manager，源固定 fuyao', () => {
    const manager = createLimitUpMarketManagerFromEnv(
      { FUYAO_API_KEY: 'k' },
      { logger, clock: () => new Date('2026-11-12T00:00:00Z') },
    );
    expect(manager?.name).toBe('limit-up-market');
    expect(manager?.sources).toEqual(['fuyao']);
  });

  it('非 fuyao 来源 → 启动期抛错', () => {
    expect(() =>
      createLimitUpMarketManagerFromEnv(
        { FUYAO_API_KEY: 'k', LUOOME_LIMIT_UP_MARKET_SOURCES: 'eastmoney' },
        { logger },
      ),
    ).toThrow(/fuyao/);
  });

  it('来源重复 → 启动期抛错', () => {
    expect(() =>
      createLimitUpMarketManagerFromEnv(
        { FUYAO_API_KEY: 'k', LUOOME_LIMIT_UP_MARKET_SOURCES: 'fuyao,fuyao' },
        { logger },
      ),
    ).toThrow();
  });
});
