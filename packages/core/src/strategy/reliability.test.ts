import { describe, expect, it } from 'vitest';

import {
  assessStrategyRun,
  compileStrategyExpression,
  compileStrategyQuotePrefilter,
  decideStrategyRunPublication,
  decideStrategySignalEmission,
  normalizeLegacyStrategyRun,
  observeCrossingUp,
} from '../index.js';
import { money } from '../types/branded.js';

const NOW = new Date('2026-08-12T00:00:00.000Z');

describe('Strategy reliability primitives', () => {
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

  it('separates acceptance from publication and normalizes legacy reads', () => {
    const acceptance = assessStrategyRun({
      status: 'complete',
      universeCount: 10,
      evaluatedCount: 10,
      failedCount: 0,
      incompleteCount: 0,
      assessedAt: NOW,
    });
    expect(acceptance.decision).toBe('accepted');
    expect(
      decideStrategyRunPublication({
        scope: 'operational',
        universeKind: 'explicit',
        status: 'complete',
        universeCheckpointPresent: true,
        acceptance,
        decidedAt: NOW,
      }),
    ).toMatchObject({ status: 'non-publishing', reasons: ['explicit-subset'] });

    const rejectedAcceptance = assessStrategyRun({
      status: 'complete',
      universeCount: 5548,
      evaluatedCount: 5225,
      failedCount: 323,
      incompleteCount: 5,
      assessedAt: NOW,
    });
    expect(rejectedAcceptance.decision).toBe('rejected');
    expect(
      decideStrategyRunPublication({
        scope: 'operational',
        universeKind: 'full',
        status: 'complete',
        universeCheckpointPresent: true,
        acceptance: rejectedAcceptance,
        decidedAt: NOW,
      }),
    ).toMatchObject({ status: 'withheld', reasons: ['acceptance-rejected'] });
    expect(
      decideStrategyRunPublication({
        scope: 'operational',
        universeKind: 'full',
        status: 'complete',
        universeCheckpointPresent: true,
        acceptance: rejectedAcceptance,
        requestedBy: 'manual',
        decidedAt: NOW,
      }),
    ).toMatchObject({ status: 'published', reasons: [] });
    expect(
      decideStrategyRunPublication({
        scope: 'operational',
        universeKind: 'full',
        status: 'complete',
        universeCheckpointPresent: true,
        acceptance: rejectedAcceptance,
        requestedBy: 'scheduled',
        decidedAt: NOW,
      }),
    ).toMatchObject({ status: 'withheld', reasons: ['acceptance-rejected'] });

    const legacy = normalizeLegacyStrategyRun({
      id: 'run-legacy',
      strategyId: 'strategy-1',
      strategyVersionId: 'strategy-1-v1',
      mode: 'scan',
      coverage: 'CN_A_SHARES_SH_SZ',
      dataAsOf: NOW,
      startedAt: NOW,
      finishedAt: NOW,
      status: 'complete',
      inputSnapshot: { fixture: true },
      providerStatuses: [],
      summary: { selected: 1 },
    });
    expect(legacy).toMatchObject({
      scope: 'operational',
      publication: { status: 'published', reasons: ['legacy-publication'] },
    });
  });
});
