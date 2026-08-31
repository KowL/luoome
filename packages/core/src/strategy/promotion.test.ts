import { describe, expect, it } from 'vitest';

import {
  assessStrategyPromotion,
  DEFAULT_STRATEGY_PROMOTION_POLICY,
  StrategyPromotionAssessmentSchema,
} from './promotion.js';

const hash = (digit: string): string => digit.repeat(64);

const completeInput = () => ({
  baseVersion: { id: 'base-v1', definitionHash: hash('a') },
  candidateVersion: {
    id: 'candidate-v2',
    definitionHash: hash('b'),
    parentVersionId: 'base-v1',
    validationStatus: 'valid' as const,
  },
  validation: {
    sessionId: 'validation-session',
    strategyVersionId: 'candidate-v2',
    status: 'complete' as const,
    tradingDays: 20,
    vintageCoverageRatio: 1,
  },
  observations: {
    completeObservationCount: 30,
    benchmarkCoverageRatio: 0.9,
  },
  factReferences: ['strategy-run:run-1', 'signal-observation:observation-1'],
});

describe('assessStrategyPromotion', () => {
  it('only allows a candidate into human review when evidence gates meet boundaries', () => {
    const result = assessStrategyPromotion(completeInput());

    expect(result).toMatchObject({
      policyVersion: 'strategy-promotion-v1',
      status: 'eligible-for-human-review',
      reasons: [],
      metrics: {
        validationTradingDays: 20,
        vintageCoverageRatio: 1,
        completeObservationCount: 30,
        benchmarkCoverageRatio: 0.9,
      },
      factReferences: ['strategy-run:run-1', 'signal-observation:observation-1'],
    });
    expect(StrategyPromotionAssessmentSchema.parse(result)).toEqual(result);
  });

  it('returns stable, deduplicated reason codes for version and evidence failures', () => {
    const result = assessStrategyPromotion({
      baseVersion: { id: 'base-v1', definitionHash: hash('a') },
      candidateVersion: {
        id: 'candidate-v2',
        definitionHash: hash('a'),
        parentVersionId: 'other-base',
        validationStatus: 'pending',
        publishedAt: new Date('2026-08-01T00:00:00.000Z'),
      },
      validation: {
        sessionId: 'validation-session',
        strategyVersionId: 'other-version',
        status: 'partial',
        tradingDays: 19,
        vintageCoverageRatio: 0.99,
      },
      observations: {
        completeObservationCount: 29,
        benchmarkCoverageRatio: 0.89,
      },
      definitionChanged: false,
    });

    expect(result.status).toBe('blocked');
    expect(result.reasons).toEqual([
      'candidate-already-published',
      'candidate-not-valid',
      'candidate-parent-mismatch',
      'definition-unchanged',
      'validation-version-mismatch',
      'validation-not-complete',
      'validation-days-insufficient',
      'pit-vintage-coverage-insufficient',
      'observations-insufficient',
      'benchmark-coverage-insufficient',
    ]);
  });

  it('blocks missing evidence without treating missing observations as zero returns', () => {
    const result = assessStrategyPromotion({
      baseVersion: { id: 'base-v1', definitionHash: hash('a') },
      candidateVersion: {
        id: 'candidate-v2',
        definitionHash: hash('b'),
        parentVersionId: 'base-v1',
        validationStatus: 'valid',
      },
    });

    expect(result.status).toBe('blocked');
    expect(result.reasons).toEqual([
      'validation-session-missing',
      'validation-days-insufficient',
      'pit-vintage-coverage-insufficient',
      'observations-insufficient',
      'benchmark-coverage-insufficient',
    ]);
    expect(result.metrics).toEqual({
      validationTradingDays: 0,
      vintageCoverageRatio: 0,
      completeObservationCount: 0,
      benchmarkCoverageRatio: 0,
    });
    expect(DEFAULT_STRATEGY_PROMOTION_POLICY.minCompleteObservations).toBe(30);
  });
});
