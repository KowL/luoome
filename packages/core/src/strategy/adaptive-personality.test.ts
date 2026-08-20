import { describe, expect, it } from 'vitest';

import { assessAdaptivePersonality } from './adaptive-personality.js';

const hash = 'a'.repeat(64);
const input = () => ({
  parameterVersion: {
    strategyId: 'strategy-a',
    strategyVersionId: 'version-2',
    definitionHash: hash,
    factReferences: ['strategy-evaluation:training'],
  },
  training: {
    sessionId: 'training',
    strategyId: 'strategy-a',
    status: 'complete' as const,
    from: new Date('2025-01-01T00:00:00Z'),
    to: new Date('2025-04-01T00:00:00Z'),
    tradingDays: 60,
    vintageAvailableDays: 60,
  },
  validation: {
    sessionId: 'validation',
    strategyId: 'strategy-a',
    strategyVersionId: 'version-2',
    status: 'complete' as const,
    from: new Date('2025-05-01T00:00:00Z'),
    to: new Date('2025-06-01T00:00:00Z'),
    tradingDays: 20,
    vintageAvailableDays: 20,
    observationCount: 30,
    benchmarkAvailableCount: 30,
  },
  policy: {
    policyVersion: 'adaptive-personality-gate-v1' as const,
    minTrainingTradingDays: 60,
    minValidationTradingDays: 20,
    minValidationObservations: 30,
    minVintageCoverageRatio: 1,
    minBenchmarkCoverageRatio: 0.9,
  },
});

describe('adaptive personality gate', () => {
  it('只有参数版本绑定训练事实且独立验证完整时进入人工评审', () => {
    const result = assessAdaptivePersonality(input());
    expect(result.status).toBe('eligible-for-human-review');
    expect(result.reasons).toEqual([]);
    expect(result.conclusion).not.toBeNull();
  });

  it('验证样本不足时不输出自适应结论', () => {
    const value = input();
    value.validation.observationCount = 3;
    value.validation.benchmarkAvailableCount = 0;
    const result = assessAdaptivePersonality(value);
    expect(result.status).toBe('unavailable');
    expect(result.conclusion).toBeNull();
    expect(result.reasons).toEqual([
      'validation-observations-insufficient',
      'benchmark-coverage-insufficient',
    ]);
  });

  it('训练与验证区间重叠时拒绝', () => {
    const value = input();
    value.validation.from = new Date('2025-03-01T00:00:00Z');
    expect(assessAdaptivePersonality(value).reasons).toContain('training-validation-not-separated');
  });
});
