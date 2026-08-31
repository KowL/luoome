import {
  type Account,
  evaluateStrategyRecommendationPreflight,
  type Holding,
  isStrategyRecommendationPolicyV2,
  money,
  type Quote,
  STRATEGY_RECOMMENDATION_PREFLIGHT_REASON_ORDER,
  StrategyRecommendationPolicySchema,
  type StrategyRecommendationPolicyV2,
  StrategyRecommendationPolicyV2Schema,
  type StrategyRecommendationPreflightInput,
  type StrategyRun,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';

const NOW = new Date('2026-08-31T08:00:00.000Z');
const ACCOUNT_ID = 'account-1';
const STRATEGY_ID = 'strategy-1';
const STOCK_ID = '600519.SH';

const account: Account = {
  id: ACCOUNT_ID,
  name: '测试账户',
  kind: 'real',
  currency: 'CNY',
  initialCapital: money(100_000),
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const run: StrategyRun = {
  id: 'run-1',
  strategyId: STRATEGY_ID,
  strategyVersionId: 'version-1',
  mode: 'scheduled',
  coverage: 'CN_A_SHARES_SH_SZ',
  dataAsOf: new Date('2026-08-31T01:00:00.000Z'),
  startedAt: new Date('2026-08-31T02:00:00.000Z'),
  finishedAt: new Date('2026-08-31T03:00:00.000Z'),
  status: 'complete',
  scope: 'operational',
  inputSnapshot: {},
  providerStatuses: [],
  publication: {
    status: 'published',
    reasons: [],
    decidedAt: new Date('2026-08-31T03:00:00.000Z'),
  },
};

const policy = (preflight: Partial<StrategyRecommendationPolicyV2['portfolioPreflight']> = {}) =>
  StrategyRecommendationPolicyV2Schema.parse({
    schemaVersion: 2,
    enabled: true,
    minScore: 70,
    maxRank: 10,
    maxPerRun: 3,
    cooldownHours: 72,
    notify: false,
    channel: 'log',
    observationHorizons: ['t3', 't5'],
    portfolioPreflight: {
      skipExistingHolding: true,
      requireLiquidityFacts: false,
      maxDataAgeTradingDays: 1,
      rejectOnExitSignal: true,
      rejectOnRiskSignal: true,
      ...preflight,
    },
  });

const quote = (stockId = STOCK_ID, observedAt = NOW): Quote => ({
  stockId,
  observedAt,
  fetchedAt: new Date(observedAt.getTime()),
  timestampSource: 'upstream',
  ts: observedAt,
  open: money(10),
  high: money(11),
  low: money(9),
  close: money(10),
  volume: 100_000,
  amount: 1_000_000,
  source: 'test',
});

const holding = (
  id = 'holding-1',
  stockId = STOCK_ID,
  quantity = 100,
  closedAt: Date | null = null,
): Holding => ({
  id,
  accountId: ACCOUNT_ID,
  stockId,
  quantity,
  availableQuantity: quantity,
  avgCost: money(9),
  openedAt: new Date('2026-08-01T01:00:00.000Z'),
  closedAt,
});

const signal = (
  id: string,
  scope: 'entry' | 'exit' | 'risk',
): StrategyRecommendationPreflightInput['signals'][number] => ({
  signal: {
    id,
    strategyId: STRATEGY_ID,
    strategyVersionId: run.strategyVersionId,
    runId: run.id,
    ruleId: `${scope}-${id}`,
    stockId: STOCK_ID,
    ts: NOW,
    score: 80,
    direction: scope === 'entry' ? 'bullish' : 'bearish',
    evidence: [`${scope} fact`],
    evaluationSnapshot: {},
  },
  scope,
});

const baseInput = (
  overrides: Partial<StrategyRecommendationPreflightInput> = {},
): StrategyRecommendationPreflightInput => ({
  policy: policy(),
  accountId: ACCOUNT_ID,
  strategyId: STRATEGY_ID,
  run,
  candidate: {
    stockId: STOCK_ID,
    stockResolved: true,
    industry: '白酒',
    quote: quote(),
    factReferences: ['fact:z', 'fact:a', 'fact:z'],
  },
  account,
  holdings: [],
  signals: [],
  strategyExposureFacts: [],
  strategyVersionIds: ['version-1'],
  trigger: 'run',
  cooldownFacts: [],
  evaluatedAt: NOW,
  ...overrides,
});

describe('evaluateStrategyRecommendationPreflight', () => {
  it('keeps the exported reason order as a stable audit contract', () => {
    expect(STRATEGY_RECOMMENDATION_PREFLIGHT_REASON_ORDER).toEqual([
      'run-not-publishable',
      'account-facts-unavailable',
      'candidate-data-unavailable',
      'candidate-data-stale',
      'signal-facts-unavailable',
      'entry-exit-conflict',
      'entry-risk-conflict',
      'exit-risk-conflict',
      'exit-signal',
      'risk-signal',
      'holding-facts-unavailable',
      'existing-holding',
      'same-strategy-duplicate-exposure',
      'strategy-exposure-facts-unavailable',
      'single-position-exposure-unavailable',
      'single-position-exposure-exceeded',
      'industry-facts-unavailable',
      'industry-exposure-unavailable',
      'industry-exposure-exceeded',
      'portfolio-valuation-unavailable',
      'liquidity-facts-unavailable',
      'cooldown-facts-unavailable',
      'cooldown',
    ]);
  });

  it('keeps legacy policies on V1 and rejects an incomplete explicit V2', () => {
    const legacy = StrategyRecommendationPolicySchema.parse({ enabled: true });
    expect(isStrategyRecommendationPolicyV2(legacy)).toBe(false);
    expect(legacy).not.toHaveProperty('schemaVersion');
    expect(
      StrategyRecommendationPolicySchema.safeParse({ schemaVersion: 2, enabled: true }).success,
    ).toBe(false);
    expect(
      StrategyRecommendationPolicySchema.safeParse({
        enabled: true,
        portfolioPreflight: {
          skipExistingHolding: true,
          requireLiquidityFacts: false,
          maxDataAgeTradingDays: 1,
          rejectOnExitSignal: true,
          rejectOnRiskSignal: true,
        },
      }).success,
    ).toBe(false);
  });

  it('is deterministic and emits unique code-unit-sorted fact references', () => {
    const first = evaluateStrategyRecommendationPreflight(baseInput());
    const second = evaluateStrategyRecommendationPreflight(baseInput());

    expect(first).toEqual(second);
    expect(first.status).toBe('eligible');
    expect(first.factReferences).toEqual([
      'account:account-1',
      'fact:a',
      'fact:z',
      'stock:600519.SH',
      'strategy-run:run-1',
      'strategy:strategy-1',
    ]);
    expect(first.metrics).toMatchObject({
      candidateDataAgeTradingDays: 0,
      runDataAgeTradingDays: 0,
    });
  });

  it('treats missing required facts and stale data as non-eligible', () => {
    const holdingFactsMissing = evaluateStrategyRecommendationPreflight(
      baseInput({
        holdingFactsUnavailable: true,
        policy: policy({ maxSinglePositionExposurePct: 20 }),
        portfolioValue: 1000,
        candidate: {
          ...baseInput().candidate,
          proposedPositionValue: 100,
        },
      }),
    );
    expect(holdingFactsMissing.status).toBe('unavailable');
    expect(holdingFactsMissing.reasons.map((reason) => reason.code)).toContain(
      'holding-facts-unavailable',
    );

    const stale = evaluateStrategyRecommendationPreflight(
      baseInput({
        policy: policy({ maxDataAgeTradingDays: 0 }),
        candidate: {
          ...baseInput().candidate,
          quote: quote(STOCK_ID, new Date('2026-08-27T01:00:00.000Z')),
        },
      }),
    );
    expect(stale.status).toBe('skipped');
    expect(stale.reasons.map((reason) => reason.code)).toEqual(['candidate-data-stale']);

    const liquidityMissing = evaluateStrategyRecommendationPreflight(
      baseInput({
        policy: policy({ requireLiquidityFacts: true }),
        candidate: { ...baseInput().candidate, quote: { ...quote(), volume: 0 } },
      }),
    );
    expect(liquidityMissing.status).toBe('unavailable');
    expect(liquidityMissing.reasons.map((reason) => reason.code)).toEqual([
      'liquidity-facts-unavailable',
    ]);
  });

  it('rejects candidate and holding quotes fetched after the evaluation point', () => {
    const futureFetchedAt = new Date(NOW.getTime() + 60 * 60 * 1000);
    const futureCandidate = evaluateStrategyRecommendationPreflight(
      baseInput({
        candidate: {
          ...baseInput().candidate,
          quote: { ...quote(), fetchedAt: futureFetchedAt },
        },
      }),
    );
    expect(futureCandidate.status).toBe('unavailable');
    expect(futureCandidate.reasons.map((reason) => reason.code)).toEqual([
      'candidate-data-unavailable',
    ]);

    const futureHolding = evaluateStrategyRecommendationPreflight(
      baseInput({
        policy: policy({ maxIndustryExposurePct: 50 }),
        portfolioValue: 1000,
        candidate: { ...baseInput().candidate, proposedPositionValue: 100 },
        holdings: [
          {
            holding: holding('holding-other', 'stock-2'),
            industry: '白酒',
            quote: { ...quote('stock-2'), fetchedAt: futureFetchedAt },
          },
        ],
      }),
    );
    expect(futureHolding.status).toBe('unavailable');
    expect(futureHolding.reasons.map((reason) => reason.code)).toEqual([
      'portfolio-valuation-unavailable',
    ]);
  });

  it('keeps signal conflicts, holding and strategy duplicate reasons in contract order', () => {
    const result = evaluateStrategyRecommendationPreflight(
      baseInput({
        holdings: [
          {
            holding: holding(),
            industry: '白酒',
            quote: quote(),
            factReferences: ['holding:1'],
          },
        ],
        signals: [
          signal('signal-risk', 'risk'),
          signal('signal-entry', 'entry'),
          signal('signal-exit', 'exit'),
        ],
        strategyExposureFacts: [
          {
            accountId: ACCOUNT_ID,
            strategyId: STRATEGY_ID,
            strategyVersionId: 'version-1',
            stockId: STOCK_ID,
            factReferences: ['trade:1'],
          },
        ],
      }),
    );

    expect(result.status).toBe('skipped');
    expect(result.reasons.map((reason) => reason.code)).toEqual([
      'entry-exit-conflict',
      'entry-risk-conflict',
      'exit-risk-conflict',
      'exit-signal',
      'risk-signal',
      'existing-holding',
      'same-strategy-duplicate-exposure',
    ]);
  });

  it('checks post-add single-position and industry exposure from explicit sizing facts', () => {
    const result = evaluateStrategyRecommendationPreflight(
      baseInput({
        policy: policy({
          maxSinglePositionExposurePct: 20,
          maxIndustryExposurePct: 50,
        }),
        holdings: [
          {
            holding: holding('holding-other', 'stock-2', 100),
            industry: '白酒',
            quote: { ...quote('stock-2'), close: money(6) },
          },
        ],
        portfolioValue: 1000,
        candidate: { ...baseInput().candidate, proposedPositionValue: 400 },
      }),
    );

    expect(result.status).toBe('skipped');
    expect(result.reasons.map((reason) => reason.code)).toEqual([
      'single-position-exposure-exceeded',
      'industry-exposure-exceeded',
    ]);
    expect(result.metrics).toMatchObject({
      portfolioValue: 1000,
      candidatePositionValue: 400,
      singlePositionExposurePct: 28.571429,
      industryExposurePct: 71.428571,
    });
  });

  it('does not treat an account with no valued holdings as a zero-value portfolio', () => {
    const result = evaluateStrategyRecommendationPreflight(
      baseInput({
        policy: policy({ maxSinglePositionExposurePct: 20 }),
        candidate: { ...baseInput().candidate, proposedPositionValue: 100 },
      }),
    );

    expect(result.status).toBe('unavailable');
    expect(result.reasons.map((reason) => reason.code)).toEqual([
      'single-position-exposure-unavailable',
      'portfolio-valuation-unavailable',
    ]);
    expect(result.metrics).toMatchObject({ candidatePositionValue: 100 });
  });

  it('only accepts account-owned published operational cooldown facts', () => {
    const cooldown = {
      adviceId: 'advice-1',
      accountId: ACCOUNT_ID,
      strategyId: STRATEGY_ID,
      runId: 'previous-run',
      runScope: 'operational' as const,
      runPublication: 'published' as const,
      stockId: STOCK_ID,
      trigger: 'run' as const,
      createdAt: new Date('2026-08-30T08:00:00.000Z'),
    };
    const skipped = evaluateStrategyRecommendationPreflight(
      baseInput({ cooldownFacts: [cooldown] }),
    );
    expect(skipped.status).toBe('skipped');
    expect(skipped.reasons.map((reason) => reason.code)).toEqual(['cooldown']);
    expect(skipped.metrics.cooldownMatches).toBe(1);

    const crossAccount = evaluateStrategyRecommendationPreflight(
      baseInput({ cooldownFacts: [{ ...cooldown, accountId: 'other-account' }] }),
    );
    expect(crossAccount.status).toBe('eligible');

    const legacyAccountless = evaluateStrategyRecommendationPreflight(
      baseInput({
        cooldownFacts: [
          {
            adviceId: cooldown.adviceId,
            strategyId: cooldown.strategyId,
            runId: cooldown.runId,
            runScope: cooldown.runScope,
            runPublication: cooldown.runPublication,
            stockId: cooldown.stockId,
            trigger: cooldown.trigger,
            createdAt: cooldown.createdAt,
          },
        ],
      }),
    );
    expect(legacyAccountless.status).toBe('unavailable');
    expect(legacyAccountless.reasons.map((reason) => reason.code)).toEqual([
      'cooldown-facts-unavailable',
    ]);
  });
});
