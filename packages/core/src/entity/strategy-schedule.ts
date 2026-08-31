import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { nextCronOccurrence, validateCronExpression, validateTimeZone } from '../strategy/cron.js';
import {
  type ActiveSignalObservationHorizon,
  ActiveSignalObservationHorizonSchema,
} from './signal-observation.js';
import { type StrategyRunAcceptancePolicy, StrategyRunAcceptancePolicySchema } from './strategy.js';

const StrategyRecommendationObservationHorizonsSchema = z
  .array(z.union([ActiveSignalObservationHorizonSchema, z.literal('t20')]))
  .default(['t3', 't5'])
  .transform((horizons) =>
    horizons.filter((horizon): horizon is ActiveSignalObservationHorizon => horizon !== 't20'),
  );

const StrategyRecommendationPolicyFields = {
  enabled: z.boolean().default(false),
  minScore: z.number().min(0).max(100).default(70),
  maxRank: z.number().int().min(1).max(200).default(10),
  maxPerRun: z.number().int().min(1).max(20).default(3),
  cooldownHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(72),
  notify: z.boolean().default(true),
  channel: z.enum(['log', 'feishu']).default('log'),
  observationHorizons: StrategyRecommendationObservationHorizonsSchema,
} as const;

/**
 * 存量 policy 没有 schemaVersion；它必须继续按原字段和默认值读取。
 * `schemaVersion: z.never()` 让一个显式但不完整的 V2 对象不能悄悄回退成 V1。
 */
export const StrategyRecommendationPolicyV1Schema = z.object({
  schemaVersion: z.never().optional(),
  portfolioPreflight: z.never().optional(),
  ...StrategyRecommendationPolicyFields,
});
export type StrategyRecommendationPolicyV1 = z.infer<typeof StrategyRecommendationPolicyV1Schema>;

export const StrategyRecommendationPortfolioPreflightPolicySchema = z.object({
  maxIndustryExposurePct: z.number().finite().min(0).max(100).optional(),
  maxSinglePositionExposurePct: z.number().finite().min(0).max(100).optional(),
  skipExistingHolding: z.boolean(),
  requireLiquidityFacts: z.boolean(),
  maxDataAgeTradingDays: z.number().int().min(0).max(30),
  rejectOnExitSignal: z.boolean(),
  rejectOnRiskSignal: z.boolean(),
});
export type StrategyRecommendationPortfolioPreflightPolicy = z.infer<
  typeof StrategyRecommendationPortfolioPreflightPolicySchema
>;

/**
 * V2 is opt-in and requires an explicit portfolio preflight policy.  The
 * existing `channel` field stays here so V2 does not change notification
 * semantics while adding the account gate.
 */
export const StrategyRecommendationPolicyV2Schema = z.object({
  schemaVersion: z.literal(2),
  ...StrategyRecommendationPolicyFields,
  portfolioPreflight: StrategyRecommendationPortfolioPreflightPolicySchema,
});
export type StrategyRecommendationPolicyV2 = z.infer<typeof StrategyRecommendationPolicyV2Schema>;

export const StrategyRecommendationPolicySchema = z.union([
  StrategyRecommendationPolicyV2Schema,
  StrategyRecommendationPolicyV1Schema,
]);
export type StrategyRecommendationPolicy = z.infer<typeof StrategyRecommendationPolicySchema>;

export const isStrategyRecommendationPolicyV2 = (
  policy: StrategyRecommendationPolicy,
): policy is StrategyRecommendationPolicyV2 => policy.schemaVersion === 2;

export const StrategyScheduleSchema = z.object({
  id: z.string().min(1),
  strategyId: z.string().min(1),
  cron: z.string().min(1).max(120),
  timezone: z.string().min(1).max(100),
  enabled: z.boolean(),
  acceptancePolicy: StrategyRunAcceptancePolicySchema.optional(),
  recommendationPolicy: StrategyRecommendationPolicySchema.optional(),
  nextRunAt: z.coerce.date().optional(),
  lastRunId: z.string().min(1).optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type StrategySchedule = z.infer<typeof StrategyScheduleSchema>;

export const strategyScheduleId = (strategyId: string): string => `strategy-schedule:${strategyId}`;

export const assertStrategyScheduleInvariants = (schedule: StrategySchedule): void => {
  const parsed = StrategyScheduleSchema.safeParse(schedule);
  if (!parsed.success) {
    throw new InvariantError(parsed.error.issues.map((issue) => issue.message).join('; '));
  }
  validateCronExpression(schedule.cron);
  validateTimeZone(schedule.timezone);
  if (schedule.updatedAt.getTime() < schedule.createdAt.getTime()) {
    throw new InvariantError('StrategySchedule.updatedAt 不得早于 createdAt');
  }
  if (schedule.enabled && schedule.nextRunAt === undefined) {
    throw new InvariantError('启用的 StrategySchedule 必须有 nextRunAt');
  }
  if (!schedule.enabled && schedule.nextRunAt !== undefined) {
    throw new InvariantError('停用的 StrategySchedule 不得保留 nextRunAt');
  }
  if (schedule.recommendationPolicy?.enabled && !schedule.enabled) {
    throw new InvariantError('启用自动推荐时 StrategySchedule 必须启用');
  }
};

export const buildStrategySchedule = (input: {
  readonly strategyId: string;
  readonly cron: string;
  readonly timezone: string;
  readonly enabled: boolean;
  readonly acceptancePolicy?: StrategyRunAcceptancePolicy;
  readonly recommendationPolicy?: StrategyRecommendationPolicy;
  readonly now: Date;
  readonly existing?: StrategySchedule;
}): StrategySchedule => {
  const schedule: StrategySchedule = {
    id: input.existing?.id ?? strategyScheduleId(input.strategyId),
    strategyId: input.strategyId,
    cron: input.cron,
    timezone: input.timezone,
    enabled: input.enabled,
    ...(input.acceptancePolicy === undefined
      ? input.existing?.acceptancePolicy === undefined
        ? {}
        : { acceptancePolicy: input.existing.acceptancePolicy }
      : { acceptancePolicy: StrategyRunAcceptancePolicySchema.parse(input.acceptancePolicy) }),
    ...(input.recommendationPolicy === undefined
      ? input.existing?.recommendationPolicy === undefined
        ? {}
        : { recommendationPolicy: input.existing.recommendationPolicy }
      : {
          recommendationPolicy: StrategyRecommendationPolicySchema.parse(
            input.recommendationPolicy,
          ),
        }),
    ...(input.enabled
      ? { nextRunAt: nextCronOccurrence(input.cron, input.timezone, input.now) }
      : {}),
    ...(input.existing?.lastRunId === undefined ? {} : { lastRunId: input.existing.lastRunId }),
    createdAt: input.existing?.createdAt ?? input.now,
    updatedAt: input.now,
  };
  assertStrategyScheduleInvariants(schedule);
  return schedule;
};
