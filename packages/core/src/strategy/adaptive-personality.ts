import { z } from 'zod';

export const AdaptivePersonalityPolicySchema = z.object({
  policyVersion: z.literal('adaptive-personality-gate-v1'),
  minTrainingTradingDays: z.number().int().positive().default(60),
  minValidationTradingDays: z.number().int().positive().default(20),
  minValidationObservations: z.number().int().positive().default(30),
  minVintageCoverageRatio: z.number().min(0).max(1).default(1),
  minBenchmarkCoverageRatio: z.number().min(0).max(1).default(0.9),
});
export type AdaptivePersonalityPolicy = z.infer<typeof AdaptivePersonalityPolicySchema>;

export const AdaptivePersonalityGateReasonSchema = z.enum([
  'parameter-version-not-linked-to-training',
  'validation-version-mismatch',
  'strategy-mismatch',
  'session-not-complete',
  'training-validation-not-separated',
  'training-days-insufficient',
  'validation-days-insufficient',
  'pit-vintage-coverage-insufficient',
  'validation-observations-insufficient',
  'benchmark-coverage-insufficient',
]);
export type AdaptivePersonalityGateReason = z.infer<typeof AdaptivePersonalityGateReasonSchema>;

export interface AdaptivePersonalityGateInput {
  readonly parameterVersion: {
    readonly strategyId: string;
    readonly strategyVersionId: string;
    readonly definitionHash: string;
    readonly factReferences: readonly string[];
  };
  readonly training: {
    readonly sessionId: string;
    readonly strategyId: string;
    readonly status: 'running' | 'complete' | 'partial' | 'failed';
    readonly from: Date;
    readonly to: Date;
    readonly tradingDays: number;
    readonly vintageAvailableDays: number;
  };
  readonly validation: {
    readonly sessionId: string;
    readonly strategyId: string;
    readonly strategyVersionId: string;
    readonly status: 'running' | 'complete' | 'partial' | 'failed';
    readonly from: Date;
    readonly to: Date;
    readonly tradingDays: number;
    readonly vintageAvailableDays: number;
    readonly observationCount: number;
    readonly benchmarkAvailableCount: number;
  };
  readonly policy: AdaptivePersonalityPolicy;
}

export const AdaptivePersonalityAssessmentSchema = z.object({
  status: z.enum(['eligible-for-human-review', 'unavailable']),
  parameterVersion: z.object({
    strategyVersionId: z.string().min(1),
    definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  trainingSessionId: z.string().min(1),
  validationSessionId: z.string().min(1),
  policy: AdaptivePersonalityPolicySchema,
  metrics: z.object({
    trainingTradingDays: z.number().int().nonnegative(),
    validationTradingDays: z.number().int().nonnegative(),
    trainingVintageCoverageRatio: z.number().min(0).max(1),
    validationVintageCoverageRatio: z.number().min(0).max(1),
    validationObservationCount: z.number().int().nonnegative(),
    benchmarkCoverageRatio: z.number().min(0).max(1),
  }),
  reasons: z.array(AdaptivePersonalityGateReasonSchema),
  conclusion: z.string().nullable(),
  limitations: z.array(z.string().min(1)),
});
export type AdaptivePersonalityAssessment = z.infer<typeof AdaptivePersonalityAssessmentSchema>;

const ratio = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : Math.min(1, numerator / denominator);

export const assessAdaptivePersonality = (
  input: AdaptivePersonalityGateInput,
): AdaptivePersonalityAssessment => {
  const policy = AdaptivePersonalityPolicySchema.parse(input.policy);
  const reasons: AdaptivePersonalityGateReason[] = [];
  if (
    !input.parameterVersion.factReferences.includes(
      `strategy-evaluation:${input.training.sessionId}`,
    )
  ) {
    reasons.push('parameter-version-not-linked-to-training');
  }
  if (input.parameterVersion.strategyVersionId !== input.validation.strategyVersionId) {
    reasons.push('validation-version-mismatch');
  }
  if (
    input.parameterVersion.strategyId !== input.training.strategyId ||
    input.parameterVersion.strategyId !== input.validation.strategyId
  ) {
    reasons.push('strategy-mismatch');
  }
  if (input.training.status !== 'complete' || input.validation.status !== 'complete') {
    reasons.push('session-not-complete');
  }
  if (input.training.to >= input.validation.from) {
    reasons.push('training-validation-not-separated');
  }
  if (input.training.tradingDays < policy.minTrainingTradingDays) {
    reasons.push('training-days-insufficient');
  }
  if (input.validation.tradingDays < policy.minValidationTradingDays) {
    reasons.push('validation-days-insufficient');
  }
  const trainingVintageCoverageRatio = ratio(
    input.training.vintageAvailableDays,
    input.training.tradingDays,
  );
  const validationVintageCoverageRatio = ratio(
    input.validation.vintageAvailableDays,
    input.validation.tradingDays,
  );
  if (
    trainingVintageCoverageRatio < policy.minVintageCoverageRatio ||
    validationVintageCoverageRatio < policy.minVintageCoverageRatio
  ) {
    reasons.push('pit-vintage-coverage-insufficient');
  }
  if (input.validation.observationCount < policy.minValidationObservations) {
    reasons.push('validation-observations-insufficient');
  }
  const benchmarkCoverageRatio = ratio(
    input.validation.benchmarkAvailableCount,
    input.validation.observationCount,
  );
  if (benchmarkCoverageRatio < policy.minBenchmarkCoverageRatio) {
    reasons.push('benchmark-coverage-insufficient');
  }
  return AdaptivePersonalityAssessmentSchema.parse({
    status: reasons.length === 0 ? 'eligible-for-human-review' : 'unavailable',
    parameterVersion: {
      strategyVersionId: input.parameterVersion.strategyVersionId,
      definitionHash: input.parameterVersion.definitionHash,
    },
    trainingSessionId: input.training.sessionId,
    validationSessionId: input.validation.sessionId,
    policy,
    metrics: {
      trainingTradingDays: input.training.tradingDays,
      validationTradingDays: input.validation.tradingDays,
      trainingVintageCoverageRatio,
      validationVintageCoverageRatio,
      validationObservationCount: input.validation.observationCount,
      benchmarkCoverageRatio,
    },
    reasons,
    conclusion:
      reasons.length === 0
        ? '训练期与独立验证期满足最小证据门禁；仅可进入人工评审，不代表未来收益或自动发布。'
        : null,
    limitations: [
      '门禁只验证样本隔离、PIT 数据和观察覆盖，不构成收益承诺。',
      '通过门禁也不会自动发布 StrategyVersion、生成 Advice 或触发交易。',
    ],
  });
};
