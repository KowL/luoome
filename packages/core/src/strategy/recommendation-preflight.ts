import { z } from 'zod';

import type { Account } from '../entity/account.js';
import type {
  ActiveStrategyRecommendationTrigger,
  StrategyRecommendationTrigger,
} from '../entity/advice.js';
import type { Holding } from '../entity/holding.js';
import { type Quote, QuoteSchema } from '../entity/quote.js';
import type { StrategyRun, StrategySignal } from '../entity/strategy.js';
import { isPublishableOperationalRun } from '../entity/strategy.js';
import type { StrategyRecommendationPolicyV2 } from '../entity/strategy-schedule.js';
import { dateInShanghai, isHoliday, isWeekend } from '../trading-calendar.js';

/** Stable, auditable reasons.  Their order is part of the preflight contract. */
export const StrategyRecommendationPreflightReasonCodeSchema = z.enum([
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
export type StrategyRecommendationPreflightReasonCode = z.infer<
  typeof StrategyRecommendationPreflightReasonCodeSchema
>;

export const StrategyRecommendationPreflightReasonSchema = z.object({
  code: StrategyRecommendationPreflightReasonCodeSchema,
  message: z.string().min(1),
});
export type StrategyRecommendationPreflightReason = z.infer<
  typeof StrategyRecommendationPreflightReasonSchema
>;

export const StrategyRecommendationPreflightMetricsSchema = z.object({
  candidateDataAgeTradingDays: z.number().int().nonnegative().optional(),
  runDataAgeTradingDays: z.number().int().nonnegative().optional(),
  portfolioValue: z.number().finite().nonnegative().optional(),
  candidatePositionValue: z.number().finite().nonnegative().optional(),
  singlePositionExposurePct: z.number().finite().nonnegative().optional(),
  industryExposurePct: z.number().finite().nonnegative().optional(),
  existingHoldingQuantity: z.number().int().nonnegative().optional(),
  liquidityVolume: z.number().finite().nonnegative().optional(),
  liquidityAmount: z.number().finite().nonnegative().optional(),
  liquidityTurnoverRatePct: z.number().finite().nonnegative().optional(),
  cooldownMatches: z.number().int().nonnegative().optional(),
});
export type StrategyRecommendationPreflightMetrics = z.infer<
  typeof StrategyRecommendationPreflightMetricsSchema
>;

export const StrategyRecommendationPreflightSchema = z.object({
  accountId: z.string().min(1),
  strategyId: z.string().min(1),
  runId: z.string().min(1),
  stockId: z.string().min(1),
  status: z.enum(['eligible', 'skipped', 'unavailable']),
  reasons: z.array(StrategyRecommendationPreflightReasonSchema),
  factReferences: z.array(z.string().min(1)),
  evaluatedAt: z.coerce.date(),
  metrics: StrategyRecommendationPreflightMetricsSchema,
});
export type StrategyRecommendationPreflight = z.infer<typeof StrategyRecommendationPreflightSchema>;

export const StrategyRecommendationPreflightSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  eligible: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  unavailable: z.number().int().nonnegative(),
  details: z.array(StrategyRecommendationPreflightSchema),
});
export type StrategyRecommendationPreflightSummary = z.infer<
  typeof StrategyRecommendationPreflightSummarySchema
>;

export interface StrategyRecommendationCandidateFact {
  readonly stockId: string;
  readonly stockResolved: boolean;
  readonly industry?: string;
  readonly quote?: Quote;
  /** Only a real, caller-supplied sizing fact may enable exposure checks. */
  readonly proposedPositionValue?: number;
  readonly factReferences?: readonly string[];
}

export interface StrategyRecommendationHoldingFact {
  readonly holding: Holding;
  readonly industry?: string;
  readonly quote?: Quote;
  readonly factReferences?: readonly string[];
}

export interface StrategyRecommendationSignalFact {
  readonly signal: StrategySignal;
  readonly scope: 'entry' | 'exit' | 'risk';
  readonly factReferences?: readonly string[];
}

/** A trade-derived current exposure fact; no inference is made from an untagged Holding. */
export interface StrategyRecommendationStrategyExposureFact {
  readonly accountId: string;
  readonly strategyId: string;
  readonly strategyVersionId: string;
  readonly stockId: string;
  readonly factReferences?: readonly string[];
}

/** Advice-derived cooldown fact.  Account and publishable-run provenance are explicit. */
export interface StrategyRecommendationCooldownFact {
  readonly adviceId: string;
  readonly accountId?: string;
  readonly strategyId: string;
  readonly runId: string;
  readonly runScope: 'operational' | 'evaluation';
  readonly runPublication: 'published' | 'withheld' | 'non-publishing';
  readonly stockId: string;
  readonly trigger: StrategyRecommendationTrigger;
  readonly createdAt: Date;
  readonly factReferences?: readonly string[];
}

export interface StrategyRecommendationPreflightInput {
  readonly policy: StrategyRecommendationPolicyV2;
  readonly accountId: string;
  readonly strategyId: string;
  readonly run: StrategyRun;
  readonly candidate: StrategyRecommendationCandidateFact;
  readonly account: Account | null;
  readonly holdings: readonly StrategyRecommendationHoldingFact[];
  readonly holdingFactsUnavailable?: boolean;
  readonly portfolioValue?: number;
  readonly signals: readonly StrategyRecommendationSignalFact[];
  readonly signalsUnavailable?: boolean;
  readonly strategyExposureFacts: readonly StrategyRecommendationStrategyExposureFact[];
  readonly strategyExposureFactsUnavailable?: boolean;
  readonly strategyVersionIds?: readonly string[];
  readonly trigger: ActiveStrategyRecommendationTrigger;
  readonly cooldownFacts: readonly StrategyRecommendationCooldownFact[];
  readonly cooldownFactsUnavailable?: boolean;
  readonly evaluatedAt: Date;
}

export const STRATEGY_RECOMMENDATION_PREFLIGHT_REASON_ORDER = [
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
] as const satisfies readonly StrategyRecommendationPreflightReasonCode[];

const UNAVAILABLE_REASONS = new Set<StrategyRecommendationPreflightReasonCode>([
  'run-not-publishable',
  'account-facts-unavailable',
  'holding-facts-unavailable',
  'candidate-data-unavailable',
  'signal-facts-unavailable',
  'strategy-exposure-facts-unavailable',
  'single-position-exposure-unavailable',
  'industry-facts-unavailable',
  'industry-exposure-unavailable',
  'portfolio-valuation-unavailable',
  'liquidity-facts-unavailable',
  'cooldown-facts-unavailable',
]);

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const validDate = (value: Date): boolean => Number.isFinite(value.getTime());

const shanghaiDateAtMidnight = (value: Date): Date =>
  new Date(`${dateInShanghai(value)}T00:00:00.000Z`);

const tradingDayLag = (from: Date, to: Date): number | undefined => {
  if (!validDate(from) || !validDate(to)) return undefined;
  const fromDay = shanghaiDateAtMidnight(from);
  const toDay = shanghaiDateAtMidnight(to);
  if (fromDay.getTime() > toDay.getTime()) return undefined;
  let days = 0;
  const cursor = new Date(fromDay.getTime());
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  while (cursor.getTime() <= toDay.getTime()) {
    if (!isWeekend(cursor) && !isHoliday(cursor)) days += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
};

const defaultReference = (kind: string, id: string): string => `${kind}:${id}`;

const addReferences = (target: Set<string>, references: readonly string[] | undefined): void => {
  for (const reference of references ?? []) {
    if (reference.length > 0) target.add(reference);
  }
};

const addFactReferences = (
  target: Set<string>,
  references: readonly string[] | undefined,
  fallback: string,
): void => {
  const before = target.size;
  addReferences(target, references);
  if (target.size === before) target.add(fallback);
};

const asNonNegativeFinite = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;

const fixed = (value: number): number => Number(value.toFixed(6));

const reasonMessage = (
  code: StrategyRecommendationPreflightReasonCode,
  value?: string | number,
): string => {
  const suffix = value === undefined ? '' : `: ${String(value)}`;
  return `${code}${suffix}`;
};

/**
 * Pure account preflight.  It only consumes assembled facts; it never reads a
 * repository, calls an adapter, calls an LLM, or chooses an order size.
 */
export const evaluateStrategyRecommendationPreflight = (
  input: StrategyRecommendationPreflightInput,
): StrategyRecommendationPreflight => {
  const reasons = new Map<StrategyRecommendationPreflightReasonCode, string>();
  const references = new Set<string>();
  const metrics: StrategyRecommendationPreflightMetrics = {};
  const addReason = (code: StrategyRecommendationPreflightReasonCode, value?: string | number) => {
    if (!reasons.has(code)) reasons.set(code, reasonMessage(code, value));
  };

  references.add(defaultReference('stock', input.candidate.stockId));
  references.add(defaultReference('strategy', input.strategyId));
  references.add(defaultReference('strategy-run', input.run.id));

  if (input.run.strategyId !== input.strategyId || !isPublishableOperationalRun(input.run)) {
    addReason('run-not-publishable');
    return buildPreflight(input, reasons, references, metrics);
  }

  const account = input.account;
  if (account === null || account.id !== input.accountId) {
    addReason('account-facts-unavailable');
    return buildPreflight(input, reasons, references, metrics);
  }
  references.add(defaultReference('account', account.id));

  if (input.holdingFactsUnavailable === true) {
    addReason('holding-facts-unavailable');
  }

  if (input.candidate.stockId.length === 0 || input.candidate.stockResolved === false) {
    addReason('candidate-data-unavailable');
    return buildPreflight(input, reasons, references, metrics);
  }

  const quote = input.candidate.quote;
  const quoteIsSchemaValid = quote !== undefined && QuoteSchema.safeParse(quote).success;
  if (
    !quoteIsSchemaValid ||
    quote === undefined ||
    quote.stockId !== input.candidate.stockId ||
    !validDate(quote.observedAt) ||
    !validDate(quote.fetchedAt) ||
    quote.observedAt.getTime() > quote.fetchedAt.getTime() ||
    quote.fetchedAt.getTime() > input.evaluatedAt.getTime() ||
    quote.close <= 0
  ) {
    addReason('candidate-data-unavailable');
    return buildPreflight(input, reasons, references, metrics);
  }
  addFactReferences(
    references,
    input.candidate.factReferences,
    `${defaultReference('quote', input.candidate.stockId)}:${quote.observedAt.toISOString()}:${quote.source}`,
  );

  const quoteAge = tradingDayLag(quote.observedAt, input.evaluatedAt);
  const runAge = tradingDayLag(input.run.dataAsOf, input.evaluatedAt);
  if (quoteAge === undefined || runAge === undefined) {
    addReason('candidate-data-unavailable');
    return buildPreflight(input, reasons, references, metrics);
  }
  metrics.candidateDataAgeTradingDays = quoteAge;
  metrics.runDataAgeTradingDays = runAge;
  const effectiveAge = Math.max(quoteAge, runAge);
  if (effectiveAge > input.policy.portfolioPreflight.maxDataAgeTradingDays) {
    addReason(
      'candidate-data-stale',
      `${effectiveAge}>${input.policy.portfolioPreflight.maxDataAgeTradingDays}`,
    );
  }

  const matchingSignalFacts = input.signals
    .filter(
      ({ signal }) =>
        signal.strategyId === input.strategyId &&
        signal.strategyVersionId === input.run.strategyVersionId &&
        signal.runId === input.run.id &&
        signal.stockId === input.candidate.stockId,
    )
    .sort((left, right) => compareCodeUnits(left.signal.id, right.signal.id));
  for (const fact of matchingSignalFacts) {
    addFactReferences(
      references,
      fact.factReferences,
      defaultReference('strategy-signal', fact.signal.id),
    );
  }
  if (input.signalsUnavailable === true) addReason('signal-facts-unavailable');

  const entrySignals = matchingSignalFacts.filter((fact) => fact.scope === 'entry');
  const exitSignals = matchingSignalFacts.filter((fact) => fact.scope === 'exit');
  const riskSignals = matchingSignalFacts.filter((fact) => fact.scope === 'risk');
  if (entrySignals.length > 0 && exitSignals.length > 0) addReason('entry-exit-conflict');
  if (entrySignals.length > 0 && riskSignals.length > 0) addReason('entry-risk-conflict');
  if (exitSignals.length > 0 && riskSignals.length > 0) addReason('exit-risk-conflict');
  if (input.policy.portfolioPreflight.rejectOnExitSignal && exitSignals.length > 0) {
    addReason('exit-signal', exitSignals.map((fact) => fact.signal.id).join(','));
  }
  if (input.policy.portfolioPreflight.rejectOnRiskSignal && riskSignals.length > 0) {
    addReason('risk-signal', riskSignals.map((fact) => fact.signal.id).join(','));
  }

  const holdingFacts = input.holdings
    .filter(
      ({ holding }) =>
        holding.accountId === input.accountId && holding.quantity > 0 && holding.closedAt === null,
    )
    .sort((left, right) => compareCodeUnits(left.holding.id, right.holding.id));
  const candidateHoldings = holdingFacts.filter(
    ({ holding }) => holding.stockId === input.candidate.stockId,
  );
  const candidateHolding = candidateHoldings[0];
  if (candidateHolding !== undefined) {
    metrics.existingHoldingQuantity = candidateHolding.holding.quantity;
    addFactReferences(
      references,
      candidateHolding.factReferences,
      defaultReference('holding', candidateHolding.holding.id),
    );
    if (input.policy.portfolioPreflight.skipExistingHolding) addReason('existing-holding');
  }

  const matchingStrategyExposure = input.strategyExposureFacts
    .filter(
      (fact) =>
        fact.accountId === input.accountId &&
        fact.strategyId === input.strategyId &&
        fact.stockId === input.candidate.stockId &&
        (input.strategyVersionIds === undefined ||
          input.strategyVersionIds.includes(fact.strategyVersionId)),
    )
    .sort((left, right) => compareCodeUnits(left.strategyVersionId, right.strategyVersionId));
  for (const fact of matchingStrategyExposure) {
    addFactReferences(
      references,
      fact.factReferences,
      defaultReference('strategy-exposure', `${fact.strategyVersionId}:${fact.stockId}`),
    );
  }
  if (input.strategyExposureFactsUnavailable === true) {
    addReason('strategy-exposure-facts-unavailable');
  } else if (candidateHolding !== undefined && matchingStrategyExposure.length > 0) {
    addReason('same-strategy-duplicate-exposure');
  }

  const singleThreshold = input.policy.portfolioPreflight.maxSinglePositionExposurePct;
  const industryThreshold = input.policy.portfolioPreflight.maxIndustryExposurePct;
  if (singleThreshold !== undefined || industryThreshold !== undefined) {
    for (const fact of holdingFacts) {
      addFactReferences(
        references,
        fact.factReferences,
        defaultReference('holding', fact.holding.id),
      );
      if (fact.quote !== undefined && validDate(fact.quote.observedAt)) {
        addFactReferences(
          references,
          undefined,
          `${defaultReference('quote', fact.holding.stockId)}:${fact.quote.observedAt.toISOString()}:${fact.quote.source}`,
        );
      }
    }
  }

  const holdingQuoteIsUsable = (fact: StrategyRecommendationHoldingFact): boolean => {
    const holdingQuote = fact.quote;
    if (
      holdingQuote === undefined ||
      !QuoteSchema.safeParse(holdingQuote).success ||
      holdingQuote.stockId !== fact.holding.stockId ||
      !validDate(holdingQuote.observedAt) ||
      !validDate(holdingQuote.fetchedAt) ||
      holdingQuote.fetchedAt.getTime() > input.evaluatedAt.getTime() ||
      holdingQuote.close <= 0
    ) {
      return false;
    }
    const age = tradingDayLag(holdingQuote.observedAt, input.evaluatedAt);
    return age !== undefined && age <= input.policy.portfolioPreflight.maxDataAgeTradingDays;
  };
  const activeHoldingsHaveQuotes = holdingFacts.every(holdingQuoteIsUsable);
  const holdingValue = (fact: StrategyRecommendationHoldingFact): number | undefined => {
    const value = !holdingQuoteIsUsable(fact)
      ? undefined
      : (fact.quote as Quote).close * fact.holding.quantity;
    return asNonNegativeFinite(value);
  };
  const values = holdingFacts.map((fact) => ({ fact, value: holdingValue(fact) }));
  const calculatedPortfolioValue =
    input.holdingFactsUnavailable === true || holdingFacts.length === 0
      ? undefined
      : values.every(({ value }) => value !== undefined)
        ? values.reduce((sum, item) => sum + (item.value ?? 0), 0)
        : undefined;
  const portfolioValue = asNonNegativeFinite(input.portfolioValue) ?? calculatedPortfolioValue;
  if (portfolioValue !== undefined) metrics.portfolioValue = fixed(portfolioValue);

  const proposedValue = asNonNegativeFinite(input.candidate.proposedPositionValue);
  const candidateValue =
    proposedValue ?? (candidateHolding === undefined ? undefined : holdingValue(candidateHolding));
  if (candidateValue !== undefined) metrics.candidatePositionValue = fixed(candidateValue);

  if (singleThreshold !== undefined) {
    if (portfolioValue === undefined || candidateValue === undefined) {
      addReason('single-position-exposure-unavailable');
    } else {
      const isNewPosition = candidateHolding === undefined;
      const denominator = isNewPosition ? portfolioValue + candidateValue : portfolioValue;
      if (denominator <= 0) {
        addReason('portfolio-valuation-unavailable');
      } else {
        const exposure = (candidateValue / denominator) * 100;
        metrics.singlePositionExposurePct = fixed(exposure);
        if (exposure > singleThreshold) {
          addReason('single-position-exposure-exceeded', `${fixed(exposure)}>${singleThreshold}`);
        }
      }
    }
  }

  if (industryThreshold !== undefined) {
    const candidateIndustry = input.candidate.industry;
    const hasIndustry = (value: string | undefined): boolean =>
      value !== undefined && value.trim().length > 0;
    const missingIndustry = holdingFacts.some(({ industry }) => !hasIndustry(industry));
    if (!hasIndustry(candidateIndustry) || missingIndustry) {
      addReason('industry-facts-unavailable');
    } else if (portfolioValue === undefined || candidateValue === undefined) {
      addReason('industry-exposure-unavailable');
    } else {
      const existingIndustryValue = values.reduce(
        (sum, item) => (item.fact.industry === candidateIndustry ? sum + (item.value ?? 0) : sum),
        0,
      );
      const isNewPosition = candidateHolding === undefined;
      const denominator = isNewPosition ? portfolioValue + candidateValue : portfolioValue;
      if (denominator <= 0 || !activeHoldingsHaveQuotes) {
        addReason('portfolio-valuation-unavailable');
      } else {
        const exposure =
          ((isNewPosition ? existingIndustryValue + candidateValue : existingIndustryValue) /
            denominator) *
          100;
        metrics.industryExposurePct = fixed(exposure);
        if (exposure > industryThreshold) {
          addReason('industry-exposure-exceeded', `${fixed(exposure)}>${industryThreshold}`);
        }
      }
    }
  }

  if (
    input.policy.portfolioPreflight.maxSinglePositionExposurePct !== undefined &&
    calculatedPortfolioValue === undefined &&
    input.portfolioValue === undefined
  ) {
    addReason('portfolio-valuation-unavailable');
  }

  if (input.policy.portfolioPreflight.requireLiquidityFacts) {
    const liquidityVolume = asNonNegativeFinite(quote.volume);
    const liquidityAmount = asNonNegativeFinite(quote.amount);
    const liquidityTurnoverRatePct = asNonNegativeFinite(quote.turnoverRatePct);
    if (liquidityVolume !== undefined) metrics.liquidityVolume = fixed(liquidityVolume);
    if (liquidityAmount !== undefined) metrics.liquidityAmount = fixed(liquidityAmount);
    if (liquidityTurnoverRatePct !== undefined) {
      metrics.liquidityTurnoverRatePct = fixed(liquidityTurnoverRatePct);
    }
    // Volume alone is not a cash-liquidity fact; require a notional or turnover field too.
    if (
      liquidityVolume === undefined ||
      liquidityVolume <= 0 ||
      ((liquidityAmount === undefined || liquidityAmount <= 0) &&
        (liquidityTurnoverRatePct === undefined || liquidityTurnoverRatePct <= 0))
    ) {
      addReason('liquidity-facts-unavailable');
    }
  }

  const cooldownStart = input.evaluatedAt.getTime() - input.policy.cooldownHours * 60 * 60_000;
  const matchingCooldownFacts = input.cooldownFacts
    .filter(
      (fact) =>
        fact.strategyId === input.strategyId &&
        fact.stockId === input.candidate.stockId &&
        fact.trigger === input.trigger &&
        fact.createdAt.getTime() >= cooldownStart &&
        fact.createdAt.getTime() <= input.evaluatedAt.getTime() &&
        fact.runScope === 'operational' &&
        fact.runPublication === 'published',
    )
    .sort((left, right) => compareCodeUnits(left.adviceId, right.adviceId));
  const accountlessCooldown = matchingCooldownFacts.filter((fact) => fact.accountId === undefined);
  for (const fact of matchingCooldownFacts) {
    addFactReferences(references, fact.factReferences, defaultReference('advice', fact.adviceId));
  }
  if (input.cooldownFactsUnavailable === true || accountlessCooldown.length > 0) {
    addReason('cooldown-facts-unavailable');
  } else {
    const accountCooldown = matchingCooldownFacts.filter(
      (fact) => fact.accountId === input.accountId,
    );
    if (accountCooldown.length > 0) {
      metrics.cooldownMatches = accountCooldown.length;
      addReason('cooldown', accountCooldown.map((fact) => fact.adviceId).join(','));
    }
  }

  return buildPreflight(input, reasons, references, metrics);
};

const buildPreflight = (
  input: StrategyRecommendationPreflightInput,
  reasons: ReadonlyMap<StrategyRecommendationPreflightReasonCode, string>,
  references: ReadonlySet<string>,
  metrics: StrategyRecommendationPreflightMetrics,
): StrategyRecommendationPreflight => {
  const orderedReasons = STRATEGY_RECOMMENDATION_PREFLIGHT_REASON_ORDER.flatMap((code) => {
    const message = reasons.get(code);
    return message === undefined ? [] : [{ code, message }];
  });
  const status = orderedReasons.some(({ code }) => UNAVAILABLE_REASONS.has(code))
    ? 'unavailable'
    : orderedReasons.length > 0
      ? 'skipped'
      : 'eligible';
  return StrategyRecommendationPreflightSchema.parse({
    accountId: input.accountId,
    strategyId: input.strategyId,
    runId: input.run.id,
    stockId: input.candidate.stockId,
    status,
    reasons: orderedReasons,
    factReferences: [...references].sort(compareCodeUnits),
    evaluatedAt: input.evaluatedAt,
    metrics,
  });
};

/** Backward-friendly name for callers that use “assess” terminology. */
export const assessStrategyRecommendationPreflight = evaluateStrategyRecommendationPreflight;
