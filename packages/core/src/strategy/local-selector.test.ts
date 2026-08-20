import { describe, expect, it } from 'vitest';

import { type DailyBar, DailyBarSchema } from '../entity/quote.js';
import {
  DEFAULT_LOCAL_SELECTOR_PARAMETERS,
  LocalSelectorParametersV1Schema,
  runLocalSelector,
} from './local-selector.js';

const bars = (stockId: string, slope: number, volatility = 0): DailyBar[] =>
  Array.from({ length: 60 }, (_, index) => {
    const close = 10 + index * slope + (index % 2 === 0 ? volatility : -volatility);
    return DailyBarSchema.parse({
      stockId,
      date: new Date(Date.UTC(2026, 0, index + 1)),
      open: close,
      high: close + 0.2,
      low: close - 0.2,
      close,
      volume: 1000 + index * 10,
      adjustment: 'qfq',
      source: 'fixture',
    });
  });

describe('local selector', () => {
  it('固定 PIT 日线与参数得到稳定横截面排序和反证', () => {
    const input = {
      stockIds: ['B', 'A', 'C'],
      barsByStock: new Map([
        ['A', bars('A', 0.1)],
        ['B', bars('B', 0.04, 0.8)],
        ['C', bars('C', -0.02)],
      ]),
      parameters: { ...DEFAULT_LOCAL_SELECTOR_PARAMETERS, top: 2 },
    };
    const first = runLocalSelector(input);
    const second = runLocalSelector(input);
    expect(second).toEqual(first);
    expect(first.candidates.map((candidate) => candidate.stockId)).toEqual(['A', 'C', 'B']);
    expect(first.candidates.map((candidate) => candidate.selected)).toEqual([true, true, false]);
    expect(first.candidates[2]?.counterEvidence.length).toBeGreaterThan(0);
  });

  it('数据不足保留 unavailable，不用当前快照或零值补齐', () => {
    const result = runLocalSelector({
      stockIds: ['A', 'MISSING'],
      barsByStock: new Map([['A', bars('A', 0.1)]]),
      parameters: DEFAULT_LOCAL_SELECTOR_PARAMETERS,
    });
    expect(result.evaluatedCount).toBe(1);
    expect(result.coverageRatio).toBe(0.5);
    expect(result.unavailable).toEqual([
      {
        stockId: 'MISSING',
        reason: 'no-bars',
        availableBars: 0,
        requiredBars: 60,
      },
    ]);
  });

  it('参数 schema 拒绝重复因子和非 1 权重和', () => {
    expect(
      LocalSelectorParametersV1Schema.safeParse({
        parameterVersion: 'local-selector-v1',
        minimumBars: 60,
        minimumCoverageRatio: 0.98,
        top: 30,
        factors: [
          { metric: 'momentum-20', direction: 'higher', weight: 0.6 },
          { metric: 'momentum-20', direction: 'higher', weight: 0.3 },
        ],
      }).success,
    ).toBe(false);
  });
});
