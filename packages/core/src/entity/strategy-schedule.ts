import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { nextCronOccurrence, validateCronExpression, validateTimeZone } from '../strategy/cron.js';

export const StrategyRecommendationPolicySchema = z.object({
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
  observationHorizons: z.array(z.enum(['t1', 't3', 't5', 't20'])).default(['t3', 't5', 't20']),
});
export type StrategyRecommendationPolicy = z.infer<typeof StrategyRecommendationPolicySchema>;

export const StrategyScheduleSchema = z.object({
  id: z.string().min(1),
  strategyId: z.string().min(1),
  cron: z.string().min(1).max(120),
  timezone: z.string().min(1).max(100),
  enabled: z.boolean(),
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
