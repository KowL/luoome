import { describe, expect, it } from 'vitest';

import {
  ALL_MARKETS,
  MARKET_LABEL,
  MarketSchema,
  marketFromExchange,
  V0_2_SUPPORTED_MARKETS,
} from './market.js';

describe('entity/market', () => {
  describe('marketFromExchange', () => {
    it.each([
      ['SH', 'cn-a'],
      ['SZ', 'cn-a'],
      ['BJ', 'cn-a'],
      ['HK', 'cn-hk'],
      ['US', 'us'],
    ] as const)('exchange %s → market %s', (exchange, expected) => {
      expect(marketFromExchange(exchange)).toBe(expected);
    });
  });

  describe('MarketSchema', () => {
    it('accepts all 3 markets', () => {
      for (const m of ALL_MARKETS) {
        expect(MarketSchema.parse(m)).toBe(m);
      }
    });

    it('rejects unknown market', () => {
      expect(() => MarketSchema.parse('jpx')).toThrow();
    });
  });

  describe('labels & supported set', () => {
    it('MARKET_LABEL covers every Market', () => {
      for (const m of ALL_MARKETS) {
        expect(MARKET_LABEL[m]).toBeTruthy();
      }
    });

    it('V0_2_SUPPORTED_MARKETS = cn-a + cn-hk（不含 us）', () => {
      expect(V0_2_SUPPORTED_MARKETS.has('cn-a')).toBe(true);
      expect(V0_2_SUPPORTED_MARKETS.has('cn-hk')).toBe(true);
      expect(V0_2_SUPPORTED_MARKETS.has('us')).toBe(false);
    });
  });
});
