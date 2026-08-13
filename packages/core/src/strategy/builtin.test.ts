import { describe, expect, it } from 'vitest';

import {
  BUILTIN_STRATEGY_TEMPLATES,
  EARLY_BREAKOUT_V2_DRAFT,
  STRATEGY_TEMPLATE_REVISION,
} from './builtin.js';
import { compileStrategyExpression } from './expression.js';

/**
 * 内置策略身份锁定：definitionHash 是 StrategyVersion 的落库 identity，
 * 存量库已按这些值播种；hash 变化等于给内置策略换身份（播种按 id 跳过后
 * 新旧定义会并存漂移）。改动内置策略 DSL 时必须同步更新本表并评估存量影响。
 */
const EXPECTED: Readonly<Record<string, string>> = {
  'breakout-volume': '63d8fb42b272ab65b8104a2216eca3780b37844b5656e1094cc4d8097d390540',
  'ma-bullish-alignment': '35c9a7d3855c0da48d9524286179bf15961ec8d541e4fa2b1ecda8c4a13169ec',
  'pullback-after-limit-up': '11b17d7cb555b6662ae3cce3058471773397e5a1b4e7b758dd07d1eba90231a3',
  'volume-price-divergence': '947f839d471f8b99040b85e1022af77b19649fb5930b32b8ea7a2c31ebc0be7c',
  'sector-resonance': '3baf763c7f7504549c6791a878932473dffa2fe31405dc3589e8e97aa771a692',
  'early-breakout': 'c5ae295e819135c657d5fe771ecfbc41edf0d5c86aa54bc0af52558024b96500',
  'bollinger-band': '00f49673bb05654a09a0e3e4736e4a27a340a995dba5ea5fe392f7276b6e27a0',
};

describe('BUILTIN_STRATEGY_TEMPLATES', () => {
  it('7 个内置模板的 id 与 definitionHash 稳定', () => {
    expect(BUILTIN_STRATEGY_TEMPLATES.map((template) => template.id).sort()).toEqual(
      Object.keys(EXPECTED).sort(),
    );
    for (const template of BUILTIN_STRATEGY_TEMPLATES) {
      expect(template.definitionHash).toBe(EXPECTED[template.id]);
    }
  });

  it('模板只有目录身份，不携带 Strategy 生命周期字段', () => {
    for (const template of BUILTIN_STRATEGY_TEMPLATES) {
      expect(template.revision).toBe(STRATEGY_TEMPLATE_REVISION);
      expect(template).not.toHaveProperty('owner');
      expect(template).not.toHaveProperty('status');
      expect(template).not.toHaveProperty('currentVersionId');
    }
  });

  it('模板 definition 带 scoring：组件引用 selection rule 且权重和为 1、不设 top', () => {
    for (const template of BUILTIN_STRATEGY_TEMPLATES) {
      const { definition } = template;
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

  it('早期突破 V2 草案拆分 selection，并使用 edge/exit/risk 信号', () => {
    expect(EARLY_BREAKOUT_V2_DRAFT.definition.selection.rules.map((rule) => rule.id)).toEqual([
      'trend-above-ma20',
      'momentum-window',
      'volume-confirmation',
      'rsi-window',
      'distance-control',
      'breakout-freshness',
    ]);
    expect(EARLY_BREAKOUT_V2_DRAFT.definition.signals.entry[0]?.emission).toEqual({
      mode: 'edge',
      cooldownTradingDays: 3,
    });
    expect(EARLY_BREAKOUT_V2_DRAFT.definition.signals.exit[0]?.id).toBe('early-breakout-exit-v2');
    expect(EARLY_BREAKOUT_V2_DRAFT.definition.signals.risk[0]?.id).toBe('early-breakout-risk-v2');
  });

  it('均线多头要求趋势确认，并保持评分区分度', () => {
    const template = BUILTIN_STRATEGY_TEMPLATES.find(
      (candidate) => candidate.id === 'ma-bullish-alignment',
    );
    if (template === undefined) throw new Error('ma-bullish-alignment template missing');
    const rule = template.definition.selection.rules[0];
    const score = template.definition.scoring?.components[0]?.score;
    if (rule === undefined || score === undefined) throw new Error('ma template rule missing');

    const weakTrend = {
      indicators: {
        close: 11,
        ma5: 10.5,
        ma10: 10,
        ma20: 9.5,
        momentum20Pct: 2,
        daysAboveMa20: 10,
        volRatio5_20: 1,
      },
    };
    const confirmedTrend = {
      indicators: {
        ...weakTrend.indicators,
        momentum20Pct: 8,
        daysAboveMa20: 4,
        volRatio5_20: 1.2,
      },
    };

    expect(compileStrategyExpression(rule.when).evaluate(weakTrend)).toMatchObject({
      status: 'value',
      value: false,
    });
    expect(compileStrategyExpression(rule.when).evaluate(confirmedTrend)).toMatchObject({
      status: 'value',
      value: true,
    });
    expect(compileStrategyExpression(score).evaluate(confirmedTrend)).toMatchObject({
      status: 'value',
      value: expect.any(Number),
    });
    const scored = compileStrategyExpression(score).evaluate(confirmedTrend);
    expect(Number(scored.value)).toBeLessThan(100);
  });
});
