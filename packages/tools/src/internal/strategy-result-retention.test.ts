import type { StrategyDslV1, StrategyResult } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { retainStrategyResults } from './strategy-result-retention.js';

const definition: StrategyDslV1 = {
  schemaVersion: 1,
  metadata: {},
  universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
  selection: {
    logic: 'all',
    rules: [
      { id: 'price', name: '价格有效', when: 'quote.close > 0', evidence: ['价格有效'] },
      { id: 'volume', name: '量能', when: 'indicators.volRatio5_20 >= 2', evidence: ['放量'] },
    ],
  },
  signals: { entry: [], exit: [], risk: [] },
};

const result = (
  stockId: string,
  selected: boolean,
  evaluations: StrategyResult['ruleEvaluations'],
): StrategyResult =>
  ({
    runId: 'run-1',
    stockId,
    selected,
    score: 50,
    rank: selected ? 1 : undefined,
    ruleEvaluations: evaluations,
    evidence: [],
    dataAsOf: new Date('2026-10-29T00:00:00Z'),
  }) as unknown as StrategyResult;

const matched = (ruleId: string) => ({
  ruleId,
  schemaVersion: 2 as const,
  scope: 'selection' as const,
  status: 'matched' as const,
  value: true,
  evidence: [],
});
const unmatched = (ruleId: string) => ({
  ruleId,
  schemaVersion: 2 as const,
  scope: 'selection' as const,
  status: 'not-matched' as const,
  value: false,
  evidence: [],
});

describe('strategy result retention', () => {
  it('keeps selected and near-miss rows and only counts the rest', () => {
    const kept = retainStrategyResults(definition, [
      result('600519.SH', true, [matched('price'), matched('volume')]),
      result('000001.SZ', false, [matched('price'), unmatched('volume')]),
      result('000002.SZ', false, [unmatched('price'), unmatched('volume')]),
    ]);
    expect(kept.results.map((row) => row.stockId)).toEqual(['600519.SH', '000001.SZ']);
    expect(kept.counts).toEqual({
      ruleNearMissCount: 1,
      rankingNearMissCount: 0,
      excludedCount: 1,
      incompleteCount: 0,
    });
  });

  it('bounds rule near misses by score and keeps counting them', () => {
    const many = Array.from({ length: 5 }, (_, index) =>
      result(`00000${index}.SZ`, false, [matched('price'), unmatched('volume')]),
    ).map((row, index) => ({ ...row, score: index }));
    const kept = retainStrategyResults(definition, many, { nearMissLimit: 2 });
    expect(kept.results.map((row) => row.stockId)).toEqual(['000004.SZ', '000003.SZ']);
    expect(kept.counts.ruleNearMissCount).toBe(5);
  });

  it('keeps nothing extra when every row is excluded', () => {
    const kept = retainStrategyResults(definition, [
      result('000002.SZ', false, [unmatched('price'), unmatched('volume')]),
    ]);
    expect(kept.results).toEqual([]);
    expect(kept.counts.excludedCount).toBe(1);
  });
});
