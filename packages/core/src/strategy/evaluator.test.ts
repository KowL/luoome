import { describe, expect, it } from 'vitest';

import type { StrategyDslV1, StrategyVersion } from '../entity/strategy.js';
import { strategyDefinitionHash } from '../entity/strategy.js';
import {
  assignStableStrategyRanks,
  evaluateStrategyStock,
  type StrategyStockEvaluation,
} from './evaluator.js';
import { inspectStrategyDefinitionReferences } from './field-registry.js';

const definition = (overrides: Partial<StrategyDslV1> = {}): StrategyDslV1 => ({
  schemaVersion: 1,
  metadata: {},
  universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
  selection: {
    logic: 'all',
    rules: [
      {
        id: 'trend',
        name: '趋势',
        when: 'indicators.close > indicators.ma20',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Strategy evidence placeholder
        evidence: ['close=${indicators.close}'],
      },
    ],
  },
  scoring: {
    method: 'weighted-sum',
    components: [{ ruleId: 'trend', score: 'indicators.rsi14', weight: 1 }],
  },
  signals: {
    entry: [
      {
        id: 'entry',
        name: '入场',
        when: 'indicators.close > indicators.ma20',
        score: 'Math.min(100, indicators.rsi14)',
        direction: 'bullish',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Strategy evidence placeholder
        evidence: ['RSI=${indicators.rsi14}'],
      },
    ],
    exit: [],
    risk: [],
  },
  ...overrides,
});

const version = (dsl = definition()): StrategyVersion => ({
  id: 'strategy-v1',
  strategyId: 'strategy',
  version: 1,
  definition: dsl,
  definitionHash: strategyDefinitionHash(dsl),
  validationStatus: 'valid',
  validationErrors: [],
  publishedAt: new Date('2026-01-01T00:00:00Z'),
  createdAt: new Date('2026-01-01T00:00:00Z'),
});

const evaluate = (
  stockId: string,
  indicators: Readonly<Record<string, number | undefined>>,
  dsl = definition(),
): StrategyStockEvaluation =>
  evaluateStrategyStock({
    strategyId: 'strategy',
    version: version(dsl),
    runId: 'run',
    stockId,
    ts: new Date('2026-01-02T00:00:00Z'),
    dataAsOf: new Date('2026-01-02T00:00:00Z'),
    context: { indicators },
  });

describe('Strategy evaluator', () => {
  it('evaluates selection, scoring and signals deterministically', () => {
    const result = evaluate('000001.SZ', { close: 12, ma20: 10, rsi14: 63 });
    expect(result.partial).toBe(false);
    expect(result.result).toMatchObject({ selected: true, score: 63 });
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.evidence).toEqual(['RSI=63']);
  });

  it('propagates missing fields as unknown instead of false or zero', () => {
    const result = evaluate('000001.SZ', { close: 12, rsi14: 63 });
    expect(result.partial).toBe(true);
    expect(result.result.selected).toBe(false);
    expect(result.result.ruleEvaluations[0]).toMatchObject({
      status: 'unknown',
      error: '缺少字段: indicators.ma20',
    });
  });

  it('only marks unknown partial when it can change all/any conclusion', () => {
    const rules = [
      {
        id: 'known',
        name: '已知',
        when: 'indicators.close > 0',
        evidence: ['known'],
      },
      {
        id: 'missing',
        name: '缺失',
        when: 'indicators.ma60 > 0',
        evidence: ['missing'],
      },
    ];
    const withoutSignals = {
      entry: [],
      exit: [],
      risk: [],
    };
    const anyResult = evaluate(
      '000001.SZ',
      { close: 12 },
      definition({
        ...definition(),
        selection: { logic: 'any', rules },
        scoring: undefined,
        signals: withoutSignals,
      }),
    );
    expect(anyResult.result.selected).toBe(true);
    expect(anyResult.partial).toBe(false);

    const allResult = evaluate(
      '000001.SZ',
      { close: -1 },
      definition({
        ...definition(),
        selection: { logic: 'all', rules },
        scoring: undefined,
        signals: withoutSignals,
      }),
    );
    expect(allResult.result.selected).toBe(false);
    expect(allResult.partial).toBe(false);
  });

  it('treats out-of-range score as rule error instead of clamping', () => {
    const dsl = definition({
      ...definition(),
      scoring: {
        method: 'weighted-sum',
        components: [{ ruleId: 'trend', score: '101', weight: 1 }],
      },
    });
    const result = evaluate('000001.SZ', { close: 12, ma20: 10, rsi14: 63 }, dsl);
    expect(result.partial).toBe(true);
    expect(result.result.score).toBeUndefined();
    expect(result.errors).toContain('scoring trend: score 越界: 101');
  });

  it('assigns ordinal ranks by score desc then stockId asc and applies top', () => {
    const scoring = definition().scoring;
    if (scoring === undefined) throw new Error('fixture scoring is required');
    const dsl = definition({
      ...definition(),
      scoring: { ...scoring, top: 2 },
    });
    const results = [
      evaluate('000003.SZ', { close: 12, ma20: 10, rsi14: 80 }, dsl),
      evaluate('000002.SZ', { close: 12, ma20: 10, rsi14: 80 }, dsl),
      evaluate('000001.SZ', { close: 12, ma20: 10, rsi14: 70 }, dsl),
    ];
    const ranked = assignStableStrategyRanks(results, dsl);
    expect(
      ranked.map(({ result }) => ({
        stockId: result.stockId,
        rank: result.rank,
        selected: result.selected,
      })),
    ).toEqual([
      { stockId: '000003.SZ', rank: 2, selected: true },
      { stockId: '000002.SZ', rank: 1, selected: true },
      { stockId: '000001.SZ', rank: 3, selected: false },
    ]);
  });

  it('reports unregistered static paths and data requirements', () => {
    const dsl = definition({
      ...definition(),
      selection: {
        logic: 'all',
        rules: [
          {
            id: 'bad-field',
            name: '坏字段',
            when: 'fundamentals.roe > 0.1 && indicators.ma60 > 0',
            // biome-ignore lint/suspicious/noTemplateCurlyInString: Strategy evidence placeholder
            evidence: ['roe=${fundamentals.roe}'],
          },
        ],
      },
      scoring: undefined,
    });
    const inspected = inspectStrategyDefinitionReferences(dsl);
    expect(inspected.validationErrors).toEqual(['未注册的 Strategy 字段: fundamentals.roe']);
    expect(inspected.requiredLookback).toBe(60);
    expect(inspected.dataSources).toEqual(['daily-bars']);
  });

  it('reports malformed expressions during static validation', () => {
    const dsl = definition({
      ...definition(),
      selection: {
        logic: 'all',
        rules: [
          {
            id: 'broken',
            name: '坏语法',
            when: 'quote.close >',
            evidence: ['坏语法'],
          },
        ],
      },
      scoring: undefined,
    });
    expect(inspectStrategyDefinitionReferences(dsl).validationErrors[0]).toContain(
      'selection.broken.when 表达式无效',
    );
  });
});
