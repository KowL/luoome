import { z } from 'zod';

import { canonicalStrategyDefinitionJson, type StrategyVersion } from '../entity/strategy.js';

export const StrategyPromotionPolicySchema = z.object({
  policyVersion: z.literal('strategy-promotion-v1'),
  minValidationTradingDays: z.number().int().positive().default(20),
  minVintageCoverageRatio: z.number().min(0).max(1).default(1),
  minCompleteObservations: z.number().int().positive().default(30),
  minBenchmarkCoverageRatio: z.number().min(0).max(1).default(0.9),
});
export type StrategyPromotionPolicy = z.infer<typeof StrategyPromotionPolicySchema>;

export const DEFAULT_STRATEGY_PROMOTION_POLICY: StrategyPromotionPolicy = {
  policyVersion: 'strategy-promotion-v1',
  minValidationTradingDays: 20,
  minVintageCoverageRatio: 1,
  minCompleteObservations: 30,
  minBenchmarkCoverageRatio: 0.9,
};

const STRATEGY_PROMOTION_REASONS = [
  'base-version-missing',
  'candidate-version-missing',
  'candidate-already-published',
  'candidate-not-valid',
  'candidate-parent-mismatch',
  'definition-unchanged',
  'validation-session-missing',
  'validation-version-mismatch',
  'validation-not-complete',
  'validation-days-insufficient',
  'pit-vintage-coverage-insufficient',
  'observations-insufficient',
  'benchmark-coverage-insufficient',
] as const;

export const StrategyPromotionReasonSchema = z.enum(STRATEGY_PROMOTION_REASONS);
export type StrategyPromotionReason = z.infer<typeof StrategyPromotionReasonSchema>;

export const StrategyPromotionAssessmentSchema = z.object({
  policyVersion: z.literal('strategy-promotion-v1'),
  status: z.enum(['blocked', 'eligible-for-human-review']),
  reasons: z.array(StrategyPromotionReasonSchema),
  metrics: z.object({
    validationTradingDays: z.number().int().nonnegative(),
    vintageCoverageRatio: z.number().min(0).max(1),
    completeObservationCount: z.number().int().nonnegative(),
    benchmarkCoverageRatio: z.number().min(0).max(1),
  }),
  factReferences: z.array(z.string()),
  limitations: z.array(z.string()),
});
export type StrategyPromotionAssessment = z.infer<typeof StrategyPromotionAssessmentSchema>;

type StrategyPromotionVersionFact = Pick<StrategyVersion, 'id'> &
  Partial<
    Pick<
      StrategyVersion,
      'definition' | 'definitionHash' | 'parentVersionId' | 'validationStatus' | 'publishedAt'
    >
  >;

export interface AssessStrategyPromotionInput {
  readonly baseVersion?: StrategyPromotionVersionFact;
  readonly candidateVersion?: StrategyPromotionVersionFact;
  /** 可直接传入 definition diff 的 changed，供 read model 复用已计算的 diff。 */
  readonly definitionChanged?: boolean;
  readonly definitionDiff?: { readonly changed: boolean };
  readonly validation?: {
    readonly sessionId: string;
    readonly strategyVersionId: string;
    readonly status: 'running' | 'complete' | 'partial' | 'failed';
    readonly tradingDays: number;
    readonly vintageCoverageRatio: number;
  };
  readonly observations?: {
    readonly completeObservationCount: number;
    readonly benchmarkCoverageRatio: number;
  };
  readonly policy?: StrategyPromotionPolicy;
  readonly factReferences?: readonly string[];
  readonly limitations?: readonly string[];
}

const definitionChanged = (input: AssessStrategyPromotionInput): boolean => {
  if (input.definitionChanged !== undefined) return input.definitionChanged;
  if (input.definitionDiff !== undefined) return input.definitionDiff.changed;
  const base = input.baseVersion;
  const candidate = input.candidateVersion;
  if (base === undefined || candidate === undefined) return false;
  if (base.definitionHash !== undefined && candidate.definitionHash !== undefined) {
    return base.definitionHash !== candidate.definitionHash;
  }
  if (base.definition !== undefined && candidate.definition !== undefined) {
    return (
      canonicalStrategyDefinitionJson(base.definition) !==
      canonicalStrategyDefinitionJson(candidate.definition)
    );
  }
  // A caller that only supplies version identities cannot prove that two different versions
  // have the same definition. Keep the gate conservative and let the read model provide diff.changed.
  return false;
};

const uniqueInPolicyOrder = (
  reasons: readonly StrategyPromotionReason[],
): StrategyPromotionReason[] => {
  const present = new Set(reasons);
  return STRATEGY_PROMOTION_REASONS.filter((reason) => present.has(reason));
};

/**
 * Deterministic evidence-quality gate for a candidate StrategyVersion.
 *
 * This function only assesses version relationships and evidence coverage. It deliberately does
 * not inspect returns, win rates, scores, or call any persistence/external capability.
 */
export const assessStrategyPromotion = (
  input: AssessStrategyPromotionInput,
): StrategyPromotionAssessment => {
  const policy = StrategyPromotionPolicySchema.parse(
    input.policy ?? DEFAULT_STRATEGY_PROMOTION_POLICY,
  );
  const validationTradingDays = input.validation?.tradingDays ?? 0;
  const vintageCoverageRatio = input.validation?.vintageCoverageRatio ?? 0;
  const completeObservationCount = input.observations?.completeObservationCount ?? 0;
  const benchmarkCoverageRatio = input.observations?.benchmarkCoverageRatio ?? 0;
  const reasons: StrategyPromotionReason[] = [];

  if (input.baseVersion === undefined) reasons.push('base-version-missing');
  if (input.candidateVersion === undefined) reasons.push('candidate-version-missing');

  const candidate = input.candidateVersion;
  if (candidate !== undefined) {
    if (candidate.publishedAt !== undefined) reasons.push('candidate-already-published');
    if (candidate.validationStatus !== 'valid') reasons.push('candidate-not-valid');
    if (input.baseVersion !== undefined && candidate.parentVersionId !== input.baseVersion.id) {
      reasons.push('candidate-parent-mismatch');
    }
  }
  if (input.baseVersion !== undefined && candidate !== undefined && !definitionChanged(input)) {
    reasons.push('definition-unchanged');
  }

  if (input.validation === undefined) {
    reasons.push('validation-session-missing');
  } else {
    if (candidate !== undefined && input.validation.strategyVersionId !== candidate.id) {
      reasons.push('validation-version-mismatch');
    }
    if (input.validation.status !== 'complete') reasons.push('validation-not-complete');
  }
  if (validationTradingDays < policy.minValidationTradingDays) {
    reasons.push('validation-days-insufficient');
  }
  if (vintageCoverageRatio < policy.minVintageCoverageRatio) {
    reasons.push('pit-vintage-coverage-insufficient');
  }
  if (completeObservationCount < policy.minCompleteObservations) {
    reasons.push('observations-insufficient');
  }
  if (benchmarkCoverageRatio < policy.minBenchmarkCoverageRatio) {
    reasons.push('benchmark-coverage-insufficient');
  }

  const stableReasons = uniqueInPolicyOrder(reasons);
  const limitations = [
    '该门禁只检查版本关系、独立验证和观察覆盖，不依据收益正负做晋级判断。',
    'eligible-for-human-review 仅表示证据质量允许人工评审，不代表发布建议、未来收益或自动交易。',
    ...(input.limitations ?? []),
  ];
  return StrategyPromotionAssessmentSchema.parse({
    policyVersion: policy.policyVersion,
    status: stableReasons.length === 0 ? 'eligible-for-human-review' : 'blocked',
    reasons: stableReasons,
    metrics: {
      validationTradingDays,
      vintageCoverageRatio,
      completeObservationCount,
      benchmarkCoverageRatio,
    },
    factReferences: [...new Set(input.factReferences ?? [])],
    limitations: [...new Set(limitations)],
  });
};
