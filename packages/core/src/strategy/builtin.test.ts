import { describe, expect, it } from 'vitest';

import { BUILTIN_STRATEGIES, STRATEGY_BUILTIN_DEFINED_AT } from './builtin.js';

/**
 * 内置策略身份锁定：definitionHash 是 StrategyVersion 的落库 identity，
 * 存量库已按这些值播种；hash 变化等于给内置策略换身份（播种按 id 跳过后
 * 新旧定义会并存漂移）。改动内置策略 DSL 时必须同步更新本表并评估存量影响。
 */
const EXPECTED: Readonly<Record<string, string>> = {
  'breakout-volume': '63d8fb42b272ab65b8104a2216eca3780b37844b5656e1094cc4d8097d390540',
  'ma-bullish-alignment': '272f82c753cb34641118f4b1e391b401d7bb30d187c092a49d05bcb8711360b1',
  'pullback-after-limit-up': '11b17d7cb555b6662ae3cce3058471773397e5a1b4e7b758dd07d1eba90231a3',
  'volume-price-divergence': '947f839d471f8b99040b85e1022af77b19649fb5930b32b8ea7a2c31ebc0be7c',
  'sector-resonance': '3baf763c7f7504549c6791a878932473dffa2fe31405dc3589e8e97aa771a692',
  'early-breakout': 'c5ae295e819135c657d5fe771ecfbc41edf0d5c86aa54bc0af52558024b96500',
  'bollinger-band': '00f49673bb05654a09a0e3e4736e4a27a340a995dba5ea5fe392f7276b6e27a0',
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

  it('种子 definition 带 scoring：组件引用 selection rule 且权重和为 1、不设 top', () => {
    for (const bundle of BUILTIN_STRATEGIES) {
      const { definition } = bundle.version;
      expect(definition.scoring).toBeDefined();
      const scoring = definition.scoring;
      expect(scoring?.method).toBe('weighted-sum');
      expect(scoring?.top).toBeUndefined();
      const selectionIds = new Set(definition.selection.rules.map((rule) => rule.id));
      const totalWeight =
        scoring?.components.reduce((sum, component) => sum + component.weight, 0) ?? 0;
      expect(Math.abs(totalWeight - 1)).toBeLessThan(1e-9);
      for (const component of scoring?.components ?? []) {
        expect(selectionIds.has(component.ruleId)).toBe(true);
      }
    }
  });
});
