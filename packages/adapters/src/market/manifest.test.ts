import type { Logger } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { createMarketAdapterFromEnv, type MarketSourceId } from './factory.js';
import { MARKET_SOURCE_MANIFEST } from './manifest.js';

const silentLogger = (): Logger => {
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
};

/** 逐源构建真实 binding，断言 registry 观测到的 capability 集合与 manifest 声明一致。 */
describe('MARKET_SOURCE_MANIFEST 与 factory binding 一致性', () => {
  const ids = Object.keys(MARKET_SOURCE_MANIFEST) as MarketSourceId[];
  for (const id of ids) {
    it(`${id}`, () => {
      const adapter = createMarketAdapterFromEnv(
        {
          LUOOME_MARKET_PROVIDER: 'real',
          TUSHARE_TOKEN: 'manifest-test-token',
          FUYAO_API_KEY: 'manifest-test-key',
        },
        { logger: silentLogger(), sourceOrder: [id] },
      );
      const bound = adapter
        .marketSourceStatus()
        .map((status) => status.dataset)
        .sort();
      expect(bound).toEqual([...MARKET_SOURCE_MANIFEST[id].capabilities].sort());
    });
  }

  it('manifest 覆盖全部五个行情源', () => {
    expect([...ids].sort()).toEqual(['eastmoney', 'fuyao', 'sina', 'tencent', 'tushare']);
  });
});
