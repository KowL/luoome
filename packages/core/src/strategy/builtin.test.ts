import { describe, expect, it } from 'vitest';

import { BUILTIN_STRATEGIES, STRATEGY_BUILTIN_DEFINED_AT } from './builtin.js';

/**
 * 内置策略身份锁定：definitionHash 是 StrategyVersion 的落库 identity，
 * 存量库已按这些值播种；hash 变化等于给内置策略换身份（播种按 id 跳过后
 * 新旧定义会并存漂移）。改动内置策略 DSL 时必须同步更新本表并评估存量影响。
 */
const EXPECTED: Readonly<Record<string, string>> = {
  'breakout-volume': '4f23bdc54ab884c347adf148d8602aab0ccf455b60b7553bf77ef9d8919d0776',
  'ma-bullish-alignment': '8c32bc2dd726f69a1882a24d72d5a50caea867fd64c131c80e7a2db10842e37a',
  'pullback-after-limit-up': 'c73250519d739f125dc46f6aaf0fa7e1915b3db52fd4ccdda0a9680c14fe9679',
  'volume-price-divergence': '7e8b967af053f09025de71a22101d460d5d2cb0a69e7b3f1f20e8b7c2dd0f422',
  'sector-resonance': 'd5205e1ac84e7811ea3374c1b71db99525063f152fd467cb975b823184015ab5',
  'early-breakout': 'efe694ddb49b06f118c557b729df3463d2819d58232083b9e89ab35730f25cd9',
  'bollinger-band': 'dcb7ed51b4eeaa7695eb471af287b09ea982499c2eb1737c6dd3df6b47fc23bc',
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
