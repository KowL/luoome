import { describe, expect, it } from 'vitest';

import { BUILTIN_STRATEGIES, STRATEGY_BUILTIN_DEFINED_AT } from './builtin.js';

/**
 * 内置策略身份锁定：definitionHash 是 StrategyVersion 的落库 identity，
 * 存量库已按这些值播种；hash 变化等于给内置策略换身份（播种按 id 跳过后
 * 新旧定义会并存漂移）。改动内置策略 DSL 时必须同步更新本表并评估存量影响。
 */
const EXPECTED: Readonly<Record<string, string>> = {
  'breakout-volume': '5cf7de88bc0d4121d058c29c77b5ea262ddcf5560da454f9bfa6408c746f4af5',
  'ma-bullish-alignment': 'ee7cead5d5a15540df19f46be970dc0aaf67ca6428762852d871473d5864b942',
  'pullback-after-limit-up': 'e4dd29e4c114fdeaad450933757a627093359caefcbbe98af63d95bcdad4cf9d',
  'volume-price-divergence': 'c9870687e694cec18b7bf4692c6043928a52ce8713c5b387d4fbc659a112c0ce',
  'sector-resonance': 'e9c5866c37082421b4aac4c6d472c2ffa18e6aa07ed256df3eba6c0488fd20ec',
  'early-breakout': '7cb3081861389bd768a57f353df8a25e72c68f83b824b6fd69987f759a96f84d',
  'bollinger-band': 'cf1d293fc6d39f50c22f8e88f399517166fcde4e0d49b6aaf830f9b7a8b47512',
};

describe('BUILTIN_STRATEGIES', () => {
  it('7 个内置策略的 id 与 definitionHash 稳定', () => {
    expect(BUILTIN_STRATEGIES.map((bundle) => bundle.strategy.id).sort()).toEqual(
      Object.keys(EXPECTED).sort(),
    );
    for (const bundle of BUILTIN_STRATEGIES) {
      expect(bundle.version.definitionHash).toBe(EXPECTED[bundle.strategy.id]);
    }
  });

  it('版本身份字段与播种语义稳定', () => {
    for (const bundle of BUILTIN_STRATEGIES) {
      expect(bundle.strategy.owner).toBe('builtin');
      expect(bundle.strategy.status).toBe('active');
      expect(bundle.strategy.currentVersionId).toBe(`${bundle.strategy.id}-v1`);
      expect(bundle.version.id).toBe(`${bundle.strategy.id}-v1`);
      expect(bundle.version.version).toBe(1);
      expect(bundle.version.validationStatus).toBe('valid');
      expect(bundle.version.publishedAt).toEqual(STRATEGY_BUILTIN_DEFINED_AT);
      expect(bundle.strategy.createdAt).toEqual(STRATEGY_BUILTIN_DEFINED_AT);
    }
  });
});
