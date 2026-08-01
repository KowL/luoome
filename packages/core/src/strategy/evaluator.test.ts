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
  it('persists auditable V2 explanations and referenced input facts', () => {
    const matched = evaluate('000001.SZ', { close: 12, ma20: 10, rsi14: 63 });
    expect(matched.result.ruleEvaluations[0]).toMatchObject({
      schemaVersion: 2,
      ruleId: 'trend',
      scope: 'selection',
      expression: 'indicators.close > indicators.ma20',
      status: 'matched',
      inputs: [
        { path: 'indicators.close', status: 'available', value: 12 },
        { path: 'indicators.ma20', status: 'available', value: 10 },
      ],
      explanation: { code: 'matched', message: '规则「趋势」已命中' },
    });

    const notMatched = evaluate('000001.SZ', { close: 8, ma20: 10, rsi14: 40 });
    expect(notMatched.result.ruleEvaluations[0]).toMatchObject({
      schemaVersion: 2,
      status: 'not-matched',
      value: false,
      explanation: {
        code: 'not-matched',
        message: '规则「趋势」未命中：表达式求值为 false',
      },
    });
  });

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

  it('drops partial stocks without score from selection under top truncation', () => {
    const scoring = definition().scoring;
    if (scoring === undefined) throw new Error('fixture scoring is required');
    const dsl = definition({
      ...definition(),
      scoring: { ...scoring, top: 1 },
    });
    const scored = evaluate('000001.SZ', { close: 12, ma20: 10, rsi14: 80 }, dsl);
    // selection 通过但 rsi14 缺失 → scoring partial，无 score
    const partial = evaluate('000002.SZ', { close: 12, ma20: 10 }, dsl);
    expect(partial.result.selected).toBe(true);
    expect(partial.result.score).toBeUndefined();
    expect(partial.partial).toBe(true);

    const ranked = assignStableStrategyRanks([scored, partial], dsl);
    expect(ranked[0]?.result).toMatchObject({ stockId: '000001.SZ', selected: true, rank: 1 });
    // 无 score 的 partial 股票不得保持入选绕过 top 截断
    expect(ranked[1]?.result.selected).toBe(false);
    expect(ranked[1]?.result.rank).toBeUndefined();
  });

  it('collects signal rule when-evaluation errors like selection errors', () => {
    const dsl = definition({
      ...definition(),
      scoring: undefined,
      signals: {
        entry: [
          {
            id: 'broken-signal',
            name: '坏信号',
            when: 'Math.abs(1, 2) > 0',
            score: '50',
            direction: 'bullish',
            evidence: ['broken'],
          },
        ],
        exit: [],
        risk: [],
      },
    });
    const result = evaluate('000001.SZ', { close: 12, ma20: 10 }, dsl);
    expect(result.result.ruleEvaluations.at(-1)).toMatchObject({
      ruleId: 'broken-signal',
      status: 'error',
    });
    expect(result.errors.some((error) => error.includes('Math.abs'))).toBe(true);
    expect(result.partial).toBe(true);
  });

  it('records an evaluation-error explanation when a matched signal has an invalid score', () => {
    const dsl = definition({
      ...definition(),
      scoring: undefined,
      signals: {
        entry: [
          {
            id: 'invalid-score-signal',
            name: '分数异常信号',
            when: 'indicators.close > indicators.ma20',
            score: '101',
            direction: 'bullish',
            evidence: ['should-not-survive'],
          },
        ],
        exit: [],
        risk: [],
      },
    });
    const result = evaluate('000001.SZ', { close: 12, ma20: 10 }, dsl);
    expect(result.result.ruleEvaluations.at(-1)).toMatchObject({
      ruleId: 'invalid-score-signal',
      status: 'error',
      explanation: { code: 'evaluation-error', message: 'score 越界: 101' },
      evidence: [],
    });
    expect(result.signals).toHaveLength(0);
    expect(result.partial).toBe(true);
  });

  it('keeps matched when when-expression is truthy on missing fields and evidence resolves', () => {
    // 语义锁定：when 引用缺失字段但求值为真、且 evidence 不缺时仍算 matched（不归 unknown）
    const dsl = definition({
      ...definition(),
      scoring: undefined,
      selection: {
        logic: 'all',
        rules: [
          {
            id: 'absence-check',
            name: '缺席检查',
            when: 'indicators.ma60 === undefined',
            evidence: ['no-ma60'],
          },
        ],
      },
      signals: { entry: [], exit: [], risk: [] },
    });
    const result = evaluate('000001.SZ', { close: 12 }, dsl);
    expect(result.result.ruleEvaluations[0]).toMatchObject({ status: 'matched' });
    expect(result.result.selected).toBe(true);
    expect(result.partial).toBe(false);
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
