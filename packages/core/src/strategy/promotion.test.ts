import { describe, expect, it } from 'vitest';

import {
  assessStrategyInitialPublication,
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

describe('assessStrategyInitialPublication', () => {
  const completeCandidate = () => ({
    candidateVersion: {
      id: 'candidate-v1',
      definitionHash: hash('c'),
      validationStatus: 'valid' as const,
    },
    validation: {
      sessionId: 'validation-session',
      strategyVersionId: 'candidate-v1',
      status: 'complete' as const,
      tradingDays: 20,
      vintageCoverageRatio: 1,
    },
    observations: {
      completeObservationCount: 30,
      benchmarkCoverageRatio: 0.9,
    },
    factReferences: ['strategy:new-1'],
  });

  it('证据齐备的全新策略首发进入人工评审（eligible），且不产生 base 类 reason', () => {
    const result = assessStrategyInitialPublication(completeCandidate());

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
      factReferences: ['strategy:new-1'],
    });
    expect(StrategyPromotionAssessmentSchema.parse(result)).toEqual(result);
    expect(result.limitations.join()).toContain('没有基线版本');
  });

  it('候选缺失或不合规时 blocked，且永不检查 base/parent/diff', () => {
    const missing = assessStrategyInitialPublication({});
    expect(missing.status).toBe('blocked');
    expect(missing.reasons).toContain('candidate-version-missing');
    expect(missing.reasons).not.toContain('base-version-missing');

    const invalid = assessStrategyInitialPublication({
      ...completeCandidate(),
      candidateVersion: {
        id: 'candidate-v1',
        validationStatus: 'pending' as const,
        publishedAt: new Date('2026-08-01T00:00:00.000Z'),
      },
    });
    expect(invalid.status).toBe('blocked');
    expect(invalid.reasons).toEqual(
      expect.arrayContaining(['candidate-already-published', 'candidate-not-valid']),
    );
    expect(invalid.reasons).not.toContain('candidate-parent-mismatch');
    expect(invalid.reasons).not.toContain('definition-unchanged');
  });

  it('验证 session 与观察证据不达标时给出稳定 reason 序列', () => {
    const result = assessStrategyInitialPublication({
      candidateVersion: { id: 'candidate-v1', validationStatus: 'valid' as const },
      validation: {
        sessionId: 'validation-session',
        strategyVersionId: 'other-version',
        status: 'partial',
        tradingDays: 19,
        vintageCoverageRatio: 0.99,
      },
      observations: { completeObservationCount: 29, benchmarkCoverageRatio: 0.89 },
    });

    expect(result.status).toBe('blocked');
    expect(result.reasons).toEqual([
      'validation-version-mismatch',
      'validation-not-complete',
      'validation-days-insufficient',
      'pit-vintage-coverage-insufficient',
      'observations-insufficient',
      'benchmark-coverage-insufficient',
    ]);
  });

  it('缺 validation session 时 blocked，缺失证据不当作 0 收益', () => {
    const result = assessStrategyInitialPublication({
      candidateVersion: { id: 'candidate-v1', validationStatus: 'valid' as const },
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
  });
});
