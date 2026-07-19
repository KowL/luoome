import { describe, expect, it } from 'vitest';

import {
  assertIndicatorInvariants,
  isKnownIndicatorKey,
  KNOWN_INDICATOR_KEYS,
  readIndicator,
  TechnicalIndicatorsSchema,
} from './indicator-set.js';

describe('entity/indicator-set', () => {
  describe('KNOWN_INDICATOR_KEYS', () => {
    it('contains v0.2 known keys (momentum + volume + range)', () => {
      expect(KNOWN_INDICATOR_KEYS).toContain('ma5');
      expect(KNOWN_INDICATOR_KEYS).toContain('ma20');
      expect(KNOWN_INDICATOR_KEYS).toContain('rsi14');
      expect(KNOWN_INDICATOR_KEYS).toContain('macdDif');
      expect(KNOWN_INDICATOR_KEYS).toContain('volRatio5_20');
      expect(KNOWN_INDICATOR_KEYS).toContain('high20');
    });
  });

  describe('TechnicalIndicatorsSchema', () => {
    it('accepts empty object (sample insufficient → all undefined)', () => {
      expect(TechnicalIndicatorsSchema.parse({})).toEqual({});
    });

    it('accepts known keys', () => {
      const parsed = TechnicalIndicatorsSchema.parse({
        ma5: 10.5,
        ma20: 11.0,
        rsi14: 55.3,
        volRatio5_20: 1.6,
        high20: 12.0,
      });
      expect(parsed.ma5).toBe(10.5);
      expect(parsed.volRatio5_20).toBe(1.6);
    });

    it('accepts catchall number fields (forward compat for v0.3+ tactics)', () => {
      const parsed = TechnicalIndicatorsSchema.parse({ customMetric: 42 });
      expect(parsed.customMetric).toBe(42);
    });

    it('rejects non-number catchall', () => {
      expect(() => TechnicalIndicatorsSchema.parse({ custom: 'oops' })).toThrow();
    });
  });

  describe('assertIndicatorInvariants', () => {
    it('passes for empty + finite values', () => {
      expect(() => assertIndicatorInvariants({})).not.toThrow();
      expect(() => assertIndicatorInvariants({ ma5: 10, ma20: 11 })).not.toThrow();
    });

    it('throws on NaN', () => {
      expect(() => assertIndicatorInvariants({ ma5: Number.NaN })).toThrow(/finite/);
    });

    it('throws on Infinity', () => {
      expect(() => assertIndicatorInvariants({ ma5: Number.POSITIVE_INFINITY })).toThrow(/finite/);
    });

    it('skips undefined fields', () => {
      expect(() => assertIndicatorInvariants({ ma20: 10 })).not.toThrow();
    });
  });

  describe('readIndicator / isKnownIndicatorKey', () => {
    it('readIndicator returns number when present', () => {
      expect(readIndicator({ ma5: 10.5 }, 'ma5')).toBe(10.5);
    });

    it('readIndicator returns undefined for missing', () => {
      expect(readIndicator({}, 'ma5')).toBeUndefined();
    });

    it('isKnownIndicatorKey covers all KNOWN_INDICATOR_KEYS', () => {
      for (const key of KNOWN_INDICATOR_KEYS) {
        expect(isKnownIndicatorKey(key)).toBe(true);
      }
      expect(isKnownIndicatorKey('foo')).toBe(false);
    });
  });
});
