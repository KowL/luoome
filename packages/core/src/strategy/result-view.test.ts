import { describe, expect, it } from 'vitest';

import type { StrategyDslV1, StrategyResult } from '../entity/strategy.js';
import { classifyStrategyResult } from './result-view.js';

const definition: StrategyDslV1 = {
  schemaVersion: 1,
  metadata: {},
  universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
  selection: {
    logic: 'all',
    rules: [
      { id: 'trend', name: '趋势', when: 'indicators.close > indicators.ma20', evidence: ['趋势'] },
      { id: 'liquid', name: '流动性', when: 'quote.volume > 0', evidence: ['流动性'] },
    ],
  },
  signals: { entry: [], exit: [], risk: [] },
};

const result: StrategyResult = {
  runId: 'run-1',
  stockId: '002594.SZ',
  selected: false,
  ruleEvaluations: [
    {
      schemaVersion: 2,
      ruleId: 'trend',
      scope: 'selection',
      expression: 'indicators.close > indicators.ma20',
      status: 'not-matched',
      value: false,
      inputs: [],
      explanation: { code: 'not-matched', message: '趋势未命中' },
      evidence: [],
    },
    {
      schemaVersion: 2,
      ruleId: 'liquid',
      scope: 'selection',
      expression: 'quote.volume > 0',
      status: 'matched',
      value: true,
      inputs: [],
      explanation: { code: 'matched', message: '流动性已命中' },
      evidence: ['流动性'],
    },
  ],
  evidence: ['流动性'],
  dataAsOf: new Date('2026-08-01T07:00:00Z'),
};

describe('Strategy result view', () => {
  it('classifies logic=all with exactly one deterministic blocker as rule-near-miss', () => {
    expect(classifyStrategyResult(definition, result)).toMatchObject({
      kind: 'rule-near-miss',
      blockingRuleIds: ['trend'],
      distance: { kind: 'rule-count', missingRuleCount: 1 },
    });
  });

  it('prioritizes incomplete/selected/ranking states and never invents any-rule distance', () => {
    const selected = classifyStrategyResult(definition, { ...result, selected: true });
    expect(selected.kind).toBe('selected');

    const scoringDefinition: StrategyDslV1 = {
      ...definition,
      scoring: {
        method: 'weighted-sum',
        components: [{ ruleId: 'trend', score: '50', weight: 1 }],
        top: 2,
      },
    };
    const allMatched: StrategyResult = {
      ...result,
      score: 70,
      rank: 3,
      ruleEvaluations: result.ruleEvaluations.map((evaluation) => ({
        ...evaluation,
        status: 'matched' as const,
      })),
    };
    expect(classifyStrategyResult(scoringDefinition, allMatched)).toMatchObject({
      kind: 'ranking-near-miss',
      distance: { kind: 'rank', rank: 3, top: 2, positionsAway: 1 },
    });

    const unknown: StrategyResult = {
      ...result,
      ruleEvaluations: [
        {
          ...result.ruleEvaluations[0],
          status: 'unknown',
          explanation: { code: 'missing-input', message: '缺少字段' },
        },
      ],
    } as StrategyResult;
    expect(classifyStrategyResult(definition, unknown).kind).toBe('incomplete');

    const anyDefinition: StrategyDslV1 = {
      ...definition,
      selection: { ...definition.selection, logic: 'any' },
    };
    expect(classifyStrategyResult(anyDefinition, result).kind).toBe('excluded');

    const legacySelected: StrategyResult = {
      ...result,
      selected: true,
      ruleEvaluations: [{ ruleId: 'trend', status: 'matched', value: true, evidence: ['legacy'] }],
    };
    expect(classifyStrategyResult(definition, legacySelected).kind).toBe('selected');
  });
});
