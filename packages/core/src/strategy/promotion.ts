import { z } from 'zod';

import { signalObservationDueAt } from '../entity/signal-observation.js';
import { canonicalStrategyDefinitionJson, type StrategyVersion } from '../entity/strategy.js';
import { dateInShanghai, isHoliday, isWeekend } from '../trading-calendar.js';

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

export interface AssessStrategyInitialPublicationInput {
  readonly candidateVersion?: StrategyPromotionVersionFact;
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

/**
 * 全新策略的首发门禁（docs/ddd/strategy-ai-lifecycle-detailed-design.md §9.2）：
 * 复用晋级门阈值，但不检查 base/parent/diff（新策略无基线版本）。
 * 同样只评估证据质量，不看收益正负，不做任何持久化或外部调用。
 */
export const assessStrategyInitialPublication = (
  input: AssessStrategyInitialPublicationInput,
): StrategyPromotionAssessment => {
  const policy = StrategyPromotionPolicySchema.parse(
    input.policy ?? DEFAULT_STRATEGY_PROMOTION_POLICY,
  );
  const validationTradingDays = input.validation?.tradingDays ?? 0;
  const vintageCoverageRatio = input.validation?.vintageCoverageRatio ?? 0;
  const completeObservationCount = input.observations?.completeObservationCount ?? 0;
  const benchmarkCoverageRatio = input.observations?.benchmarkCoverageRatio ?? 0;
  const reasons: StrategyPromotionReason[] = [];

  const candidate = input.candidateVersion;
  if (candidate === undefined) {
    reasons.push('candidate-version-missing');
  } else {
    if (candidate.publishedAt !== undefined) reasons.push('candidate-already-published');
    if (candidate.validationStatus !== 'valid') reasons.push('candidate-not-valid');
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
    '该门禁只检查候选版本质量、独立验证和观察覆盖，不依据收益正负做首发判断。',
    '全新策略没有基线版本，不做 base/parent/definition diff 对比。',
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

export const STRATEGY_AUTOMATIC_VALIDATION_TRADING_DAYS = 20;

/** Session 使用 UTC 日期键；从已有 T+5 收盘结果的最近交易日向前选取历史样本。 */
export const strategyAutomaticValidationWindow = (evaluatedAt: Date) => {
  let cursor = new Date(`${dateInShanghai(evaluatedAt)}T00:00:00Z`);
  const days: Date[] = [];
  while (days.length < STRATEGY_AUTOMATIC_VALIDATION_TRADING_DAYS) {
    if (
      !isWeekend(cursor) &&
      !isHoliday(cursor) &&
      signalObservationDueAt(new Date(`${dateInShanghai(cursor)}T15:00:00+08:00`), 't5') <=
        evaluatedAt
    ) {
      days.push(cursor);
    }
    cursor = new Date(cursor.getTime() - 86_400_000);
  }
  const from = days[days.length - 1] as Date;
  const to = days[0] as Date;
  const readyAt = signalObservationDueAt(new Date(`${dateInShanghai(to)}T15:00:00+08:00`), 't5');
  return { from, to, readyAt };
};

export const StrategyAutomaticPublicationAssessmentSchema = z.object({
  policyVersion: z.enum(['strategy-auto-publication-v1', 'strategy-auto-publication-v2']),
  status: z.enum(['blocked', 'eligible']),
  reasons: z.array(
    z.union([
      StrategyPromotionReasonSchema,
      z.enum([
        'strategy-not-active-or-draft',
        'validation-overlaps-proposal',
        'validation-observations-not-mature',
        'performance-unavailable',
        'average-excess-not-positive',
        'median-excess-not-positive',
      ]),
    ]),
  ),
  metrics: StrategyPromotionAssessmentSchema.shape.metrics.extend({
    averageExcessReturnPct: z.number().finite().optional(),
    medianExcessReturnPct: z.number().finite().optional(),
    validationFrom: z.coerce.date(),
    validationTo: z.coerce.date(),
    observationsReadyAt: z.coerce.date(),
  }),
  factReferences: z.array(z.string()),
  limitations: z.array(z.string()),
});
export type StrategyAutomaticPublicationAssessment = z.infer<
  typeof StrategyAutomaticPublicationAssessmentSchema
>;

export const assessStrategyAutomaticPublication = (input: {
  readonly evidence: StrategyPromotionAssessment;
  readonly strategyStatus: 'draft' | 'active' | 'paused' | 'archived';
  readonly validationFrom: Date;
  readonly validationTo: Date;
  readonly now: Date;
  readonly performance?:
    | {
        readonly averageExcessReturnPct?: number | undefined;
        readonly medianExcessReturnPct?: number | undefined;
      }
    | undefined;
}): StrategyAutomaticPublicationAssessment => {
  const reasons: StrategyAutomaticPublicationAssessment['reasons'] = [...input.evidence.reasons];
  if (input.strategyStatus !== 'active' && input.strategyStatus !== 'draft')
    reasons.push('strategy-not-active-or-draft');
  const observationsReadyAt = signalObservationDueAt(
    new Date(`${dateInShanghai(input.validationTo)}T15:00:00+08:00`),
    't5',
  );
  if (input.now < observationsReadyAt) reasons.push('validation-observations-not-mature');
  const { averageExcessReturnPct, medianExcessReturnPct } = input.performance ?? {};
  if (averageExcessReturnPct === undefined || medianExcessReturnPct === undefined)
    reasons.push('performance-unavailable');
  if (averageExcessReturnPct !== undefined && averageExcessReturnPct <= 0)
    reasons.push('average-excess-not-positive');
  if (medianExcessReturnPct !== undefined && medianExcessReturnPct <= 0)
    reasons.push('median-excess-not-positive');
  return StrategyAutomaticPublicationAssessmentSchema.parse({
    policyVersion: 'strategy-auto-publication-v2',
    status: reasons.length === 0 ? 'eligible' : 'blocked',
    reasons,
    metrics: {
      ...input.evidence.metrics,
      averageExcessReturnPct,
      medianExcessReturnPct,
      validationFrom: input.validationFrom,
      validationTo: input.validationTo,
      observationsReadyAt,
    },
    factReferences: input.evidence.factReferences,
    limitations: [
      '自动发布基于冻结规则的历史回放，检查历史 T+5 平均、中位超额收益均为正，不等待提议后的未来交易日。',
      '超额收益相对于沪深 300 基准，属于描述性观察，未证明相对旧版本改善，不包含费用或真实交易执行。',
      '历史区间可能参与过策略提议或调参，不能据此宣称样本外有效；AI 不参与回放匹配和收益计算。历史表现不代表未来收益，策略发布不会自动下单。',
    ],
  });
};
