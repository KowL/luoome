import { describe, expect, it } from 'vitest';

import {
  ALL_MARKET_PROVIDERS,
  MarketProviderConfigSchema,
  MarketProviderNameSchema,
  parseMarketProviderConfigFromEnv,
} from './market-provider.js';

describe('entity/market-provider', () => {
  describe('MarketProviderNameSchema', () => {
    it('accepts all providers', () => {
      for (const p of ALL_MARKET_PROVIDERS) {
        expect(MarketProviderNameSchema.parse(p)).toBe(p);
      }
    });

    it('rejects unknown provider', () => {
      expect(() => MarketProviderNameSchema.parse('yahoo')).toThrow();
    });
  });

  describe('MarketProviderConfigSchema', () => {
    it('accepts real config', () => {
      expect(MarketProviderConfigSchema.parse({ provider: 'real' }).provider).toBe('real');
    });

    it('rejects mock and unknown providers', () => {
      expect(() => MarketProviderConfigSchema.parse({ provider: 'mock' })).toThrow();
      expect(() => MarketProviderConfigSchema.parse({ provider: 'eastmoney' })).toThrow();
    });
  });

  describe('parseMarketProviderConfigFromEnv', () => {
    it('requires LUOOME_MARKET_PROVIDER', () => {
      expect(() => parseMarketProviderConfigFromEnv({})).toThrow(/MARKET_PROVIDER/);
      expect(() => parseMarketProviderConfigFromEnv({ LUOOME_MARKET_PROVIDER: '  ' })).toThrow(
        /MARKET_PROVIDER/,
      );
    });

    it('rejects removed mock provider', () => {
      expect(() => parseMarketProviderConfigFromEnv({ LUOOME_MARKET_PROVIDER: 'mock' })).toThrow(
        /real/,
      );
    });

    it('parses real (case-insensitive, trimmed)', () => {
      expect(parseMarketProviderConfigFromEnv({ LUOOME_MARKET_PROVIDER: 'real' }).provider).toBe(
        'real',
      );
      expect(parseMarketProviderConfigFromEnv({ LUOOME_MARKET_PROVIDER: ' REAL ' }).provider).toBe(
        'real',
      );
    });

    it('throws on unknown provider string', () => {
      expect(() =>
        parseMarketProviderConfigFromEnv({ LUOOME_MARKET_PROVIDER: 'eastmoney' }),
      ).toThrow(/非法/);
    });
  });
});
