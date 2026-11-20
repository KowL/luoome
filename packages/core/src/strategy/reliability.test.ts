import { describe, expect, it } from 'vitest';

import {
  assertExpressionSafety,
  compileStrategyExpression,
  compileStrategyQuotePrefilter,
  DslEvalError,
  decideStrategySignalEmission,
  deriveStrategyRunScope,
  isAdvisoryEligibleRun,
  normalizeStrategyRunScope,
  observeCrossingUp,
  StrategyRunSchema,
} from '../index.js';
import { money } from '../types/branded.js';

const NOW = new Date('2026-08-12T00:00:00.000Z');

describe('Strategy reliability primitives', () => {
  it('把 DSL 禁用关键字归一为可识别的 DslEvalError', () => {
    expect(() => assertExpressionSafety('globalThis.process')).toThrow(DslEvalError);
    expect(() => assertExpressionSafety('globalThis.process')).toThrow(/globalThis/);
  });

  it('compiled expressions short-circuit missing branches and keep three-valued results', () => {
    const falseAnd = compileStrategyExpression('selection.price > 10 && selection.missing > 0');
    const trueOr = compileStrategyExpression('selection.price > 10 || selection.missing > 0');
    const trueAnd = compileStrategyExpression('selection.price > 10 && selection.missing > 0');

    expect(falseAnd.evaluate({ selection: { price: 1 } })).toMatchObject({
      status: 'value',
      value: false,
    });
    expect(trueOr.evaluate({ selection: { price: 11 } })).toMatchObject({
      status: 'value',
      value: true,
    });
    expect(trueAnd.evaluate({ selection: { price: 11 } })).toMatchObject({
      status: 'missing',
      missingPaths: ['selection.missing'],
    });
    expect(falseAnd.evaluate({ selection: { price: 1 } }).reads).toEqual([
      { path: 'selection.price', status: 'available', value: 1 },
    ]);
    expect(compileStrategyExpression('selection.missing === undefined').evaluate({})).toMatchObject(
      {
        status: 'value',
        value: true,
        missingPaths: ['selection.missing'],
      },
    );
  });

  it('distinguishes insufficient crossing history from a not-observed event', () => {
    expect(observeCrossingUp([1, 2, 3], 3)).toEqual({
      status: 'insufficient-history',
      requiredLookback: 4,
    });
    expect(observeCrossingUp([1, 1, 1, 1, 1], 3)).toEqual({
      status: 'not-observed',
      lowerBound: 5,
    });
    expect(observeCrossingUp([1, 1, 1, 1, 2], 3)).toEqual({
      status: 'observed',
      daysSince: 0,
    });
  });

  it('applies edge and cooldown emission policies', () => {
    const previousSignal = {
      id: 'signal-1',
      strategyId: 'strategy-1',
      strategyVersionId: 'strategy-1-v1',
      runId: 'run-1',
      ruleId: 'rule-1',
      stockId: '600519.SH',
      ts: new Date('2026-08-10T00:00:00.000Z'),
      score: 1,
      direction: 'bullish' as const,
      evidence: [],
      evaluationSnapshot: {},
    };
    expect(
      decideStrategySignalEmission({
        matched: true,
        previousMatched: true,
        previousSignal,
        now: NOW,
        emission: { mode: 'edge', cooldownTradingDays: 0 },
      }),
    ).toEqual({ emit: false, reason: 'rising-edge' });
    expect(
      decideStrategySignalEmission({
        matched: true,
        previousSignal,
        now: new Date('2026-08-10T12:00:00.000Z'),
        emission: { mode: 'level', cooldownTradingDays: 2 },
      }),
    ).toEqual({ emit: false, reason: 'cooldown' });
    expect(
      decideStrategySignalEmission({
        matched: true,
        previousMatched: true,
        now: new Date('2026-08-11T00:00:00.000Z'),
        emission: { mode: 'edge', cooldownTradingDays: 0 },
      }),
    ).toEqual({ emit: false, reason: 'rising-edge' });
  });

  it('quote prefilter only rejects conservatively decidable selection rules', () => {
    const prefilter = compileStrategyQuotePrefilter({
      schemaVersion: 1,
      metadata: {},
      universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
      selection: {
        logic: 'all',
        rules: [
          { id: 'price', name: '价格', when: 'quote.close > 10', evidence: ['价格'] },
          {
            id: 'trend',
            name: '趋势',
            when: 'indicators.close > indicators.ma20',
            evidence: ['趋势'],
          },
        ],
      },
      signals: { entry: [], exit: [], risk: [] },
    });
    expect(prefilter.applicableRuleIds).toEqual(['price']);
    expect(prefilter.skippedRuleIds).toEqual(['trend']);
    expect(
      prefilter.evaluate({
        stockId: '600519.SH',
        observedAt: NOW,
        fetchedAt: NOW,
        timestampSource: 'upstream',
        ts: NOW,
        open: money(9),
        high: money(10),
        low: money(8),
        close: money(9),
        volume: 1,
        source: 'test',
      }),
    ).toEqual({ status: 'reject', rejectedBy: ['price'] });
  });

  it('cooldown counts trading days rather than weekends and exchange holidays', () => {
    const previousSignal = {
      id: 'signal-holiday',
      strategyId: 'strategy-1',
      strategyVersionId: 'strategy-1-v1',
      runId: 'run-holiday',
      ruleId: 'rule-1',
      stockId: '600519.SH',
      ts: new Date('2026-09-30T00:00:00.000Z'),
      score: 1,
      direction: 'bullish' as const,
      evidence: [],
      evaluationSnapshot: {},
    };
    expect(
      decideStrategySignalEmission({
        matched: true,
        previousSignal,
        now: new Date('2026-10-08T00:00:00.000Z'),
        emission: { mode: 'level', cooldownTradingDays: 2 },
      }),
    ).toEqual({ emit: false, reason: 'cooldown' });
  });

  it('只把 operational 且已结束的运行视为可消费，并归一化存量 scope', () => {
    const base = {
      id: 'run-1',
      strategyId: 'strategy-1',
      strategyVersionId: 'strategy-1-v1',
      mode: 'scan' as const,
      coverage: 'CN_A_SHARES_SH_SZ' as const,
      dataAsOf: NOW,
      startedAt: NOW,
      finishedAt: NOW,
      inputSnapshot: { fixture: true },
      providerStatuses: [],
    };
    const run = (patch: Record<string, unknown>) => StrategyRunSchema.parse({ ...base, ...patch });

    expect(isAdvisoryEligibleRun(run({ status: 'complete', scope: 'operational' }))).toBe(true);
    expect(isAdvisoryEligibleRun(run({ status: 'partial', scope: 'operational' }))).toBe(true);
    expect(isAdvisoryEligibleRun(run({ status: 'complete', scope: 'evaluation' }))).toBe(false);
    expect(isAdvisoryEligibleRun(run({ status: 'running', scope: 'operational' }))).toBe(false);
    expect(isAdvisoryEligibleRun(run({ status: 'failed', scope: 'operational' }))).toBe(false);

    expect(normalizeStrategyRunScope(run({ status: 'complete', mode: 'replay' })).scope).toBe(
      'evaluation',
    );
    expect(normalizeStrategyRunScope(run({ status: 'complete' })).scope).toBe('operational');
    expect(deriveStrategyRunScope({ mode: 'scan', hasExplicitStockIds: true })).toBe('evaluation');
    expect(deriveStrategyRunScope({ mode: 'scheduled', hasExplicitStockIds: false })).toBe(
      'operational',
    );
  });
});
