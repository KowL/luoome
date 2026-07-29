import type { Logger } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { createAShareSentimentManagerFromEnv } from './factory.js';

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('createAShareSentimentManagerFromEnv', () => {
  it('默认装配 eastmoney 情绪 manager', () => {
    const manager = createAShareSentimentManagerFromEnv({}, { logger });
    expect(manager.fetch).toBeTypeOf('function');
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
});
