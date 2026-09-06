import { describe, expect, it } from 'vitest';

import {
  assessStrategyAutomaticPublication,
  assessStrategyInitialPublication,
  assessStrategyPromotion,
  DEFAULT_STRATEGY_PROMOTION_POLICY,
  StrategyPromotionAssessmentSchema,
  strategyAutomaticValidationWindow,
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

describe('自动发布门禁', () => {
  const proposalAt = new Date('2026-08-05T08:00:00Z');
  const automaticInput = () => ({
    evidence: assessStrategyPromotion(completeInput()),
    strategyStatus: 'active' as const,
    proposedAt: proposalAt,
    candidateCreatedAt: proposalAt,
    validationFrom: new Date('2026-07-02T00:00:00Z'),
    validationTo: new Date('2026-07-29T00:00:00Z'),
    now: new Date('2026-08-05T08:00:00Z'),
    performance: { averageExcessReturnPct: 0.02, medianExcessReturnPct: 0.01 },
  });

  it('验证窗口回溯 20 个历史交易日，末日 T+5 已有结果，不等待未来', () => {
    const window = strategyAutomaticValidationWindow(new Date('2026-09-02T16:30:00Z'));
    expect(window.from.toISOString()).toBe('2026-07-30T00:00:00.000Z');
    expect(window.to.toISOString()).toBe('2026-08-26T00:00:00.000Z');
    expect(window.readyAt.toISOString()).toBe('2026-09-02T07:00:00.000Z');
  });

  it.each([
    '2026-09-02T06:59:59Z',
    '2026-09-02T07:00:00Z',
    '2026-09-06T02:00:00Z',
    '2026-10-01T02:00:00Z',
  ])('盘前、收盘、周末或节假日 %s 选择的收益截止时间不晚于当前时点', (at) => {
    const now = new Date(at);
    const window = strategyAutomaticValidationWindow(now);
    expect(window.readyAt.getTime()).toBeLessThanOrEqual(now.getTime());
    expect(window.to.getTime()).toBeLessThan(now.getTime());
    expect(window.from.getTime()).toBeLessThan(window.to.getTime());
  });

  it('历史验证早于提议和版本创建，完整证据与正向超额仍允许发布', () => {
    expect(assessStrategyAutomaticPublication(automaticInput())).toMatchObject({
      status: 'eligible',
      reasons: [],
    });
  });

  it.each([
    ['策略已暂停', { strategyStatus: 'paused' as const }, 'strategy-not-active-or-draft'],
    [
      '平均超额非正',
      { performance: { averageExcessReturnPct: 0, medianExcessReturnPct: 0.01 } },
      'average-excess-not-positive',
    ],
    [
      '中位超额非正',
      { performance: { averageExcessReturnPct: 0.02, medianExcessReturnPct: -0.01 } },
      'median-excess-not-positive',
    ],
    ['收益指标缺失', { performance: undefined }, 'performance-unavailable'],
    [
      '末日观察未成熟',
      { now: new Date('2026-08-05T06:59:00Z') },
      'validation-observations-not-mature',
    ],
  ])('%s 阻止自动发布', (_label, override, reason) => {
    const result = assessStrategyAutomaticPublication({ ...automaticInput(), ...override });
    expect(result.status).toBe('blocked');
    expect(result.reasons).toContain(reason);
  });

  it('有效性检查不会绕过现有证据覆盖门禁', () => {
    const result = assessStrategyAutomaticPublication({
      ...automaticInput(),
      evidence: assessStrategyPromotion({}),
    });
    expect(result.reasons).toContain('observations-insufficient');
  });
});
