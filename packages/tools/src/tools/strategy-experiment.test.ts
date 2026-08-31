import {
  CURRENT_STRATEGY_EVALUATOR_IDENTITY,
  type SignalObservation,
  STRATEGY_FIELD_REGISTRY,
  type Strategy,
  type StrategyDslV1,
  type StrategyRun,
  type StrategySignal,
  type StrategyVersion,
  type StrictBacktestRun,
  type StrictBacktestSpec,
  strategyDefinitionHash,
  strictBacktestSpecHash,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import {
  getStrategyDslCatalogTool,
  getStrategyExperimentContextTool,
} from './strategy-experiment.js';

const definition = (style: string): StrategyDslV1 => ({
  schemaVersion: 1,
  metadata: { style, horizon: 'short' },
  universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
  selection: {
    logic: 'all',
    rules: [{ id: 'positive', name: '价格有效', when: 'quote.close > 0', evidence: ['价格有效'] }],
  },
  signals: {
    entry: [
      {
        id: 'entry',
        name: '入场',
        when: 'quote.close > 0',
        score: '50',
        direction: 'bullish',
        evidence: ['价格有效'],
      },
    ],
    exit: [],
    risk: [],
  },
});

const strategy = (id: string, currentVersionId: string): Strategy => ({
  id,
  name: '实验 Strategy',
  description: 'Strategy experiment fixture',
  owner: 'user',
  status: 'active',
  currentVersionId,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
});

const version = (
  strategyId: string,
  id: string,
  number: number,
  definitionValue: StrategyDslV1,
  overrides: Partial<StrategyVersion> = {},
): StrategyVersion => ({
  id,
  strategyId,
  version: number,
  definition: definitionValue,
  definitionHash: strategyDefinitionHash(definitionValue),
  validationStatus: 'valid',
  validationErrors: [],
  createdAt: new Date(`2026-01-0${number}T00:00:00.000Z`),
  ...overrides,
});

const run = (input: {
  readonly id: string;
  readonly strategyId: string;
  readonly strategyVersionId: string;
  readonly evaluationSessionId: string;
}): StrategyRun => {
  const at = new Date('2026-08-03T08:00:00.000Z');
  return {
    id: input.id,
    strategyId: input.strategyId,
    strategyVersionId: input.strategyVersionId,
    mode: 'replay',
    coverage: 'CN_A_SHARES_SH_SZ',
    dataAsOf: at,
    startedAt: at,
    finishedAt: new Date('2026-08-03T09:00:00.000Z'),
    status: 'complete',
    scope: 'evaluation',
    inputSnapshot: { evaluationSessionId: input.evaluationSessionId },
    providerStatuses: [],
    publication: {
      status: 'non-publishing',
      reasons: ['evaluation-scope'],
      decidedAt: at,
    },
  };
};

const signal = (input: {
  readonly id: string;
  readonly runId: string;
  readonly strategyId: string;
  readonly strategyVersionId: string;
  readonly stockId: string;
}): StrategySignal => ({
  id: input.id,
  strategyId: input.strategyId,
  strategyVersionId: input.strategyVersionId,
  runId: input.runId,
  ruleId: 'entry',
  stockId: input.stockId,
  ts: new Date('2026-08-03T08:00:00.000Z'),
  score: 50,
  direction: 'bullish',
  evidence: ['价格有效'],
  evaluationSnapshot: {},
});

const observation = (
  id: string,
  sourceId: string,
  stockId: string,
  overrides: Partial<SignalObservation> = {},
): SignalObservation => ({
  id,
  sourceKind: 'strategy-signal',
  sourceId,
  stockId,
  baselinePrice: 10,
  baselineAt: new Date('2026-08-03T08:00:00.000Z'),
  horizon: 't5',
  closePrice: 11,
  returnPct: 0.1,
  maxFavorableExcursionPct: 0.2,
  maxAdverseExcursionPct: -0.05,
  benchmarkReturnPct: 0.03,
  benchmarkStatus: 'complete',
  status: 'complete',
  provenance: {
    provider: 'fixture',
    observedAt: new Date('2026-08-08T08:00:00.000Z'),
    fetchedAt: new Date('2026-08-08T09:00:00.000Z'),
    freshness: 'fresh',
  },
  observedAt: new Date('2026-08-08T08:00:00.000Z'),
  ...overrides,
});

const strictBacktestSpec = (input: {
  readonly strategyId: string;
  readonly strategyVersionId: string;
  readonly evaluationSessionId: string;
}): StrictBacktestSpec => ({
  schemaVersion: 1,
  strategyId: input.strategyId,
  strategyVersionId: input.strategyVersionId,
  evaluationSessionId: input.evaluationSessionId,
  from: new Date('2026-08-03T00:00:00.000Z'),
  to: new Date('2026-08-08T00:00:00.000Z'),
  initialCash: 1_000_000,
  benchmark: { stockId: '000300.SH', datasetVersion: 'fixture-benchmark-v1' },
  execution: {
    model: 'next-open-full-rebalance-equal-weight-v1',
    lotSize: 100,
    maxPositions: 20,
  },
  fees: {
    model: 'ashare-fees-v1',
    commissionBps: 3,
    minimumCommission: 5,
    sellStampDutyBps: 5,
  },
  slippage: { model: 'fixed-bps-at-open-v1', buyBps: 2, sellBps: 2 },
});

const strictBacktestRun = (input: {
  readonly id: string;
  readonly strategyId: string;
  readonly strategyVersionId: string;
  readonly evaluationSessionId: string;
}): StrictBacktestRun => {
  const spec = strictBacktestSpec(input);
  const assessedAt = new Date('2026-08-09T00:00:00.000Z');
  return {
    id: input.id,
    status: 'complete',
    resultAvailability: 'unavailable',
    spec,
    specHash: strictBacktestSpecHash(spec),
    inputFingerprint: 'f'.repeat(64),
    evaluator: CURRENT_STRATEGY_EVALUATOR_IDENTITY,
    gateAudit: {
      status: 'unavailable',
      items: [
        'pit-universe',
        'daily-bar-revisions',
        'fees',
        'slippage',
        'tradability',
        'corporate-actions',
        'benchmark',
        'evaluator-code',
      ].map((key) => ({
        key: key as
          | 'pit-universe'
          | 'daily-bar-revisions'
          | 'fees'
          | 'slippage'
          | 'tradability'
          | 'corporate-actions'
          | 'benchmark'
          | 'evaluator-code',
        status: 'unavailable' as const,
        reason: 'fixture gate unavailable',
        evidenceRefs: [],
      })),
      assessedAt,
    },
    createdAt: assessedAt,
    finishedAt: new Date('2026-08-09T00:01:00.000Z'),
  };
};

describe('strategy experiment read tools', () => {
  it('projects the Field Registry into a DSL catalog without a second field allowlist', async () => {
    const ctx = await buildTestContext();
    const result = await getStrategyDslCatalogTool.execute({}, ctx);

    expect(result).toMatchObject({ ok: true, data: { schemaVersion: 1 } });
    if (!result.ok) return;
    expect(result.data.fields.map((field) => field.path)).toEqual(
      STRATEGY_FIELD_REGISTRY.map((field) => field.path),
    );
    expect(result.data.fields.find((field) => field.path === 'quote.close')).toMatchObject({
      type: 'number',
      unit: 'CNY',
      dataSource: 'quote',
      coverage: ['CN_A_SHARES_SH_SZ'],
      operators: expect.arrayContaining(['>', '+', '*']),
    });
    expect(result.data.fields.find((field) => field.path === 'meta.recentLimitUp')).toMatchObject({
      type: 'boolean',
      operators: expect.arrayContaining(['&&', '!', '==']),
    });
    expect(result.data.limits).toEqual({
      selectionRules: null,
      scoringComponents: null,
      signalRulesPerScope: null,
    });
  });

  it('selects explicit validation runs for the candidate and aggregates deduplicated observations', async () => {
    const ctx = await buildTestContext();
    const strategyId = 'experiment-context';
    const baseDefinition = definition('base');
    const candidateDefinition = definition('candidate');
    const base = version(strategyId, 'experiment-base', 1, baseDefinition, {
      publishedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    const candidate = version(strategyId, 'experiment-candidate', 2, candidateDefinition, {
      parentVersionId: base.id,
      publishedAt: new Date('2026-01-03T00:00:00.000Z'),
    });
    await ctx.repos.strategy.create(strategy(strategyId, base.id));
    await ctx.repos.strategy.createVersion(base);
    await ctx.repos.strategy.createVersion(candidate);
    const sessionId = 'experiment-validation-session';
    await ctx.repos.strategyEvaluation.saveSession({
      id: sessionId,
      strategyId,
      strategyVersionId: candidate.id,
      from: new Date('2026-08-03T00:00:00.000Z'),
      to: new Date('2026-08-08T00:00:00.000Z'),
      status: 'complete',
      definitionHash: candidate.definitionHash,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    const selectedRun = run({
      id: 'candidate-validation-run',
      strategyId,
      strategyVersionId: candidate.id,
      evaluationSessionId: sessionId,
    });
    const strayRun = run({
      id: 'candidate-stray-run',
      strategyId,
      strategyVersionId: candidate.id,
      evaluationSessionId: 'other-session',
    });
    await ctx.repos.strategyRun.commitRun({
      run: selectedRun,
      results: [],
      signals: [
        signal({
          id: 'candidate-signal',
          runId: selectedRun.id,
          strategyId,
          strategyVersionId: candidate.id,
          stockId: '600519.SH',
        }),
        signal({
          id: 'candidate-signal-002594',
          runId: selectedRun.id,
          strategyId,
          strategyVersionId: candidate.id,
          stockId: '002594.SZ',
        }),
      ],
    });
    await ctx.repos.strategyRun.commitRun({
      run: strayRun,
      results: [],
      signals: [
        signal({
          id: 'stray-signal',
          runId: strayRun.id,
          strategyId,
          strategyVersionId: candidate.id,
          stockId: '002594.SZ',
        }),
      ],
    });
    await ctx.repos.strategyEvaluation.saveDay({
      sessionId,
      dataAsOf: new Date('2026-08-03T00:00:00.000Z'),
      runId: selectedRun.id,
      vintageStatus: 'available',
      status: 'complete',
    });
    await ctx.repos.signalObservation.save(
      observation('candidate-complete', 'candidate-signal', '600519.SH'),
    );
    await ctx.repos.signalObservation.save(
      observation('candidate-pending-duplicate', 'candidate-signal', '600519.SH', {
        status: 'pending',
        closePrice: undefined,
        returnPct: undefined,
        maxFavorableExcursionPct: undefined,
        maxAdverseExcursionPct: undefined,
        benchmarkReturnPct: undefined,
        benchmarkStatus: 'unavailable',
        observedAt: undefined,
      }),
    );
    await ctx.repos.signalObservation.save(
      observation('candidate-no-benchmark', 'candidate-signal-002594', '002594.SZ', {
        benchmarkReturnPct: undefined,
        benchmarkStatus: 'unavailable',
      }),
    );
    await ctx.repos.signalObservation.save(
      observation('candidate-stock-mismatch', 'candidate-signal-002594', '300750.SZ'),
    );
    await ctx.repos.signalObservation.save(
      observation('stray-observation', 'stray-signal', '002594.SZ'),
    );
    const operationalRun: StrategyRun = {
      ...selectedRun,
      id: 'candidate-operational-run',
      mode: 'scheduled',
      scope: 'operational',
      inputSnapshot: {},
      publication: {
        status: 'published',
        reasons: [],
        decidedAt: new Date('2026-08-03T09:00:00.000Z'),
      },
    };
    await ctx.repos.strategyRun.commitRun({
      run: operationalRun,
      results: [],
      signals: [
        signal({
          id: 'operational-signal',
          runId: operationalRun.id,
          strategyId,
          strategyVersionId: candidate.id,
          stockId: '600519.SH',
        }),
      ],
    });
    await ctx.repos.signalObservation.save(
      observation('operational-t1', 'operational-signal', '600519.SH', {
        horizon: 't1',
        returnPct: 0,
      }),
    );
    await ctx.repos.signalObservation.save(
      observation('operational-t3', 'operational-signal', '600519.SH', {
        horizon: 't3',
        status: 'pending',
        closePrice: undefined,
        returnPct: undefined,
        maxFavorableExcursionPct: undefined,
        maxAdverseExcursionPct: undefined,
        benchmarkReturnPct: undefined,
        benchmarkStatus: 'unavailable',
        observedAt: undefined,
      }),
    );
    await ctx.repos.signalObservation.save(
      observation('operational-t5', 'operational-signal', '600519.SH', {
        horizon: 't5',
        status: 'unavailable',
        unavailableReason: '未来交易日尚未可用',
      }),
    );
    await ctx.repos.signalObservation.save(
      observation('operational-t20', 'operational-signal', '600519.SH', {
        horizon: 't20',
        returnPct: 0,
      }),
    );

    const result = await getStrategyExperimentContextTool.execute(
      {
        strategyId,
        baseVersionId: base.id,
        candidateVersionId: candidate.id,
        validationSessionId: sessionId,
        observationHorizon: 't5',
      },
      ctx,
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        baseVersion: { id: base.id },
        candidateVersion: { id: candidate.id },
        validation: {
          session: { id: sessionId },
          runIds: [selectedRun.id],
          vintageCoverageRatio: 1,
        },
        observations: {
          horizon: 't5',
          observationIds: ['candidate-complete', 'candidate-no-benchmark'],
          benchmarkCoverageRatio: 0.5,
          stats: [
            expect.objectContaining({
              horizon: 't5',
              total: 2,
              complete: 2,
              observationIds: ['candidate-complete', 'candidate-no-benchmark'],
            }),
          ],
        },
        limitations: expect.arrayContaining([expect.stringContaining('candidate-stock-mismatch')]),
        versionState: {
          candidatePersisted: true,
          candidateValid: true,
          candidatePublished: true,
          parentMatchesBase: true,
        },
        promotion: {
          status: 'blocked',
          reasons: expect.arrayContaining([
            'candidate-already-published',
            'validation-days-insufficient',
            'observations-insufficient',
            'benchmark-coverage-insufficient',
          ]),
        },
      },
    });
    if (!result.ok) return;
    expect(result.data.observations.observationIds).not.toContain('stray-observation');
    expect(result.data.observations.observationIds).not.toContain('candidate-stock-mismatch');
    expect(result.data.observations.horizons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          horizon: 't1',
          complete: 0,
          total: 2,
          missing: 2,
          pending: 0,
          unavailable: 0,
          untracked: 2,
        }),
        expect.objectContaining({
          horizon: 't5',
          complete: 2,
          total: 2,
          missing: 0,
          benchmarkComplete: 1,
          benchmarkTotal: 2,
          benchmarkCoverageRatio: 0.5,
        }),
      ]),
    );
    expect(result.data.observations.observationLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          observationId: 'candidate-complete',
          signalId: 'candidate-signal',
          runId: selectedRun.id,
          strategyVersionId: candidate.id,
        }),
      ]),
    );
    expect(result.data.realObservations.status).toBe('partial');
    expect(result.data.realObservations.observationIds).toEqual([
      'operational-t1',
      'operational-t3',
      'operational-t5',
    ]);
    expect(result.data.realObservations.observationIds).not.toContain('operational-t20');
    expect(result.data.realObservations.horizons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ horizon: 't1', complete: 1, total: 1, missing: 0 }),
        expect.objectContaining({ horizon: 't3', complete: 0, total: 1, missing: 1, pending: 1 }),
        expect.objectContaining({
          horizon: 't5',
          complete: 0,
          total: 1,
          missing: 1,
          unavailable: 1,
        }),
      ]),
    );
    expect(result.data.starterTemplate.id).toBe('early-breakout-v2');
    expect(result.data.evidenceLayers.map((layer) => layer.id)).toEqual([
      'trial',
      'historical-evaluation',
      'strict-backtest',
      'signal-observation',
    ]);
    expect(result.data.promotion.factReferences).toEqual(
      expect.arrayContaining([
        `definition-hash:${candidate.definitionHash}`,
        `strategy-evaluation:${sessionId}`,
        `strategy-run:${selectedRun.id}`,
        'signal-observation:candidate-complete',
      ]),
    );
  });

  it('returns blocked business data when there is no unpublished candidate, while explicit missing IDs remain errors', async () => {
    const ctx = await buildTestContext();
    const strategyId = 'experiment-no-candidate';
    const base = version(strategyId, 'no-candidate-base', 1, definition('base'), {
      publishedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    await ctx.repos.strategy.create(strategy(strategyId, base.id));
    await ctx.repos.strategy.createVersion(base);

    const blocked = await getStrategyExperimentContextTool.execute({ strategyId }, ctx);
    expect(blocked).toMatchObject({
      ok: true,
      data: {
        versionState: {
          candidatePersisted: false,
          candidateValid: false,
          candidatePublished: false,
          parentMatchesBase: false,
        },
        promotion: {
          status: 'blocked',
          reasons: expect.arrayContaining([
            'candidate-version-missing',
            'validation-session-missing',
          ]),
        },
      },
    });
    if (!blocked.ok) return;
    expect(blocked.data.candidateVersion).toBeUndefined();

    const missing = await getStrategyExperimentContextTool.execute(
      { strategyId, candidateVersionId: 'missing-candidate' },
      ctx,
    );
    expect(missing).toMatchObject({
      ok: false,
      error: { kind: 'not_found', entity: 'StrategyVersion', id: 'missing-candidate' },
    });
  });

  it('uses the three active horizons for signal-observation evidence status', async () => {
    const ctx = await buildTestContext();
    const strategyId = 'experiment-horizon-evidence-status';
    const base = version(strategyId, 'horizon-base', 1, definition('base'), {
      publishedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    const candidate = version(strategyId, 'horizon-candidate', 2, definition('candidate'), {
      parentVersionId: base.id,
      publishedAt: new Date('2026-01-03T00:00:00.000Z'),
    });
    await ctx.repos.strategy.create(strategy(strategyId, base.id));
    await ctx.repos.strategy.createVersion(base);
    await ctx.repos.strategy.createVersion(candidate);
    const sessionId = 'horizon-validation-session';
    await ctx.repos.strategyEvaluation.saveSession({
      id: sessionId,
      strategyId,
      strategyVersionId: candidate.id,
      from: new Date('2026-08-03T00:00:00.000Z'),
      to: new Date('2026-08-08T00:00:00.000Z'),
      status: 'complete',
      definitionHash: candidate.definitionHash,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    const validationRun = run({
      id: 'horizon-validation-run',
      strategyId,
      strategyVersionId: candidate.id,
      evaluationSessionId: sessionId,
    });
    await ctx.repos.strategyRun.commitRun({
      run: validationRun,
      results: [],
      signals: [
        signal({
          id: 'horizon-signal',
          runId: validationRun.id,
          strategyId,
          strategyVersionId: candidate.id,
          stockId: '600519.SH',
        }),
      ],
    });
    await ctx.repos.strategyEvaluation.saveDay({
      sessionId,
      dataAsOf: new Date('2026-08-03T00:00:00.000Z'),
      runId: validationRun.id,
      vintageStatus: 'available',
      status: 'complete',
    });
    await ctx.repos.signalObservation.save(
      observation('horizon-t5-observation', 'horizon-signal', '600519.SH'),
    );

    const result = await getStrategyExperimentContextTool.execute(
      {
        strategyId,
        baseVersionId: base.id,
        candidateVersionId: candidate.id,
        validationSessionId: sessionId,
      },
      ctx,
    );

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.data.observations.horizons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ horizon: 't1', total: 1, complete: 0, missing: 1, untracked: 1 }),
        expect.objectContaining({ horizon: 't3', total: 1, complete: 0, missing: 1, untracked: 1 }),
        expect.objectContaining({ horizon: 't5', total: 1, complete: 1, missing: 0, untracked: 0 }),
      ]),
    );
    expect(result.data.observations.horizons).toHaveLength(3);
    expect(
      result.data.evidenceLayers.find((layer) => layer.id === 'signal-observation')?.status,
    ).toBe('partial');
  });

  it('does not use an unpublished explicit baseline for production feedback', async () => {
    const ctx = await buildTestContext();
    const strategyId = 'experiment-published-feedback-version';
    const published = version(strategyId, 'feedback-published-v1', 1, definition('published'), {
      publishedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    const draft = version(strategyId, 'feedback-draft-v2', 2, definition('draft'), {
      parentVersionId: published.id,
    });
    await ctx.repos.strategy.create(strategy(strategyId, published.id));
    await ctx.repos.strategy.createVersion(published);
    await ctx.repos.strategy.createVersion(draft);
    const operationalRun = {
      ...run({
        id: 'feedback-operational-run',
        strategyId,
        strategyVersionId: published.id,
        evaluationSessionId: 'not-used',
      }),
      mode: 'scheduled' as const,
      scope: 'operational' as const,
      inputSnapshot: {},
      publication: {
        status: 'published' as const,
        reasons: [],
        decidedAt: new Date('2026-08-03T09:00:00.000Z'),
      },
    } satisfies StrategyRun;
    await ctx.repos.strategyRun.commitRun({
      run: operationalRun,
      results: [],
      signals: [
        signal({
          id: 'feedback-operational-signal',
          runId: operationalRun.id,
          strategyId,
          strategyVersionId: published.id,
          stockId: '600519.SH',
        }),
      ],
    });
    await ctx.repos.signalObservation.save(
      observation('feedback-operational-observation', 'feedback-operational-signal', '600519.SH'),
    );

    const result = await getStrategyExperimentContextTool.execute(
      {
        strategyId,
        baseVersionId: draft.id,
        candidateVersionId: draft.id,
      },
      ctx,
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        realObservations: {
          versionId: published.id,
          runIds: [operationalRun.id],
          observationIds: ['feedback-operational-observation'],
        },
      },
    });
  });

  it('marks evaluator identity unavailable when any validation run lacks evaluatorVersion', async () => {
    const ctx = await buildTestContext();
    const strategyId = 'experiment-partial-evaluator-identity';
    const base = version(strategyId, 'evaluator-base', 1, definition('base'), {
      publishedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    const candidate = version(strategyId, 'evaluator-candidate', 2, definition('candidate'), {
      parentVersionId: base.id,
      publishedAt: new Date('2026-01-03T00:00:00.000Z'),
    });
    await ctx.repos.strategy.create(strategy(strategyId, base.id));
    await ctx.repos.strategy.createVersion(base);
    await ctx.repos.strategy.createVersion(candidate);
    const sessionId = 'evaluator-validation-session';
    await ctx.repos.strategyEvaluation.saveSession({
      id: sessionId,
      strategyId,
      strategyVersionId: candidate.id,
      from: new Date('2026-08-03T00:00:00.000Z'),
      to: new Date('2026-08-04T00:00:00.000Z'),
      status: 'complete',
      definitionHash: candidate.definitionHash,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    const identifiedRun = {
      ...run({
        id: 'evaluator-identified-run',
        strategyId,
        strategyVersionId: candidate.id,
        evaluationSessionId: sessionId,
      }),
      inputSnapshot: {
        evaluationSessionId: sessionId,
        evaluatorVersion: CURRENT_STRATEGY_EVALUATOR_IDENTITY.version,
        evaluatorCodeIdentity: CURRENT_STRATEGY_EVALUATOR_IDENTITY.codeHash,
      },
    } satisfies StrategyRun;
    const missingIdentityRun = run({
      id: 'evaluator-missing-run',
      strategyId,
      strategyVersionId: candidate.id,
      evaluationSessionId: sessionId,
    });
    await ctx.repos.strategyRun.commitRun({ run: identifiedRun, results: [], signals: [] });
    await ctx.repos.strategyRun.commitRun({ run: missingIdentityRun, results: [], signals: [] });
    await ctx.repos.strategyEvaluation.saveDay({
      sessionId,
      dataAsOf: new Date('2026-08-03T00:00:00.000Z'),
      runId: identifiedRun.id,
      vintageStatus: 'available',
      status: 'complete',
    });
    await ctx.repos.strategyEvaluation.saveDay({
      sessionId,
      dataAsOf: new Date('2026-08-04T00:00:00.000Z'),
      runId: missingIdentityRun.id,
      vintageStatus: 'available',
      status: 'complete',
    });

    const result = await getStrategyExperimentContextTool.execute(
      {
        strategyId,
        baseVersionId: base.id,
        candidateVersionId: candidate.id,
        validationSessionId: sessionId,
      },
      ctx,
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        validation: { evaluatorIdentityStatus: 'unavailable' },
        limitations: expect.arrayContaining([expect.stringContaining('缺少 evaluatorVersion')]),
      },
    });
  });

  it('rejects an explicit training session from another Strategy', async () => {
    const ctx = await buildTestContext();
    const strategyId = 'experiment-training-owner';
    const otherStrategyId = 'experiment-training-other-owner';
    const base = version(strategyId, 'training-owner-base', 1, definition('base'), {
      publishedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    const otherBase = version(otherStrategyId, 'training-other-base', 1, definition('other'), {
      publishedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    await ctx.repos.strategy.create(strategy(strategyId, base.id));
    await ctx.repos.strategy.createVersion(base);
    await ctx.repos.strategy.create(strategy(otherStrategyId, otherBase.id));
    await ctx.repos.strategy.createVersion(otherBase);
    const trainingSessionId = 'training-session-other-owner';
    await ctx.repos.strategyEvaluation.saveSession({
      id: trainingSessionId,
      strategyId: otherStrategyId,
      strategyVersionId: otherBase.id,
      from: new Date('2026-08-03T00:00:00.000Z'),
      to: new Date('2026-08-08T00:00:00.000Z'),
      status: 'complete',
      definitionHash: otherBase.definitionHash,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
    });

    const result = await getStrategyExperimentContextTool.execute(
      { strategyId, trainingSessionId },
      ctx,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'invalid_input', message: 'training session 不属于请求中的 Strategy' },
    });
  });

  it('only returns strict backtests for the selected candidate and validation session', async () => {
    const ctx = await buildTestContext();
    const strategyId = 'experiment-strict-backtest-filter';
    const base = version(strategyId, 'strict-base', 1, definition('base'), {
      publishedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    const candidate = version(strategyId, 'strict-candidate', 2, definition('candidate'), {
      parentVersionId: base.id,
    });
    await ctx.repos.strategy.create(strategy(strategyId, base.id));
    await ctx.repos.strategy.createVersion(base);
    await ctx.repos.strategy.createVersion(candidate);
    const sessionId = 'strict-validation-session';
    await ctx.repos.strategyEvaluation.saveSession({
      id: sessionId,
      strategyId,
      strategyVersionId: candidate.id,
      from: new Date('2026-08-03T00:00:00.000Z'),
      to: new Date('2026-08-08T00:00:00.000Z'),
      status: 'complete',
      definitionHash: candidate.definitionHash,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    await ctx.repos.strategyBacktest.saveRun(
      strictBacktestRun({
        id: 'strict-match',
        strategyId,
        strategyVersionId: candidate.id,
        evaluationSessionId: sessionId,
      }),
    );
    await ctx.repos.strategyBacktest.saveRun(
      strictBacktestRun({
        id: 'strict-wrong-session',
        strategyId,
        strategyVersionId: candidate.id,
        evaluationSessionId: 'other-validation-session',
      }),
    );
    await ctx.repos.strategyBacktest.saveRun(
      strictBacktestRun({
        id: 'strict-wrong-version',
        strategyId,
        strategyVersionId: 'other-candidate-version',
        evaluationSessionId: sessionId,
      }),
    );

    const result = await getStrategyExperimentContextTool.execute(
      {
        strategyId,
        baseVersionId: base.id,
        candidateVersionId: candidate.id,
        validationSessionId: sessionId,
      },
      ctx,
    );

    expect(result).toMatchObject({ ok: true, data: { strictBacktests: [{ id: 'strict-match' }] } });
  });
});
