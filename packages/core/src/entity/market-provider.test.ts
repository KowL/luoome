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
    it('accepts mock / real config', () => {
      expect(MarketProviderConfigSchema.parse({ provider: 'mock' }).provider).toBe('mock');
      expect(MarketProviderConfigSchema.parse({ provider: 'real' }).provider).toBe('real');
    });

    it('rejects unknown provider', () => {
      expect(() => MarketProviderConfigSchema.parse({ provider: 'eastmoney' })).toThrow();
    });
  });

  describe('parseMarketProviderConfigFromEnv', () => {
    it('defaults to mock when LUOOME_MARKET_PROVIDER unset', () => {
      expect(parseMarketProviderConfigFromEnv({}).provider).toBe('mock');
    });

    it('treats empty / "mock" / whitespace as mock', () => {
      expect(parseMarketProviderConfigFromEnv({ LUOOME_MARKET_PROVIDER: '' }).provider).toBe(
        'mock',
      );
      expect(parseMarketProviderConfigFromEnv({ LUOOME_MARKET_PROVIDER: 'mock' }).provider).toBe(
        'mock',
      );
      expect(parseMarketProviderConfigFromEnv({ LUOOME_MARKET_PROVIDER: '  ' }).provider).toBe(
        'mock',
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
