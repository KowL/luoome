import {
  ActiveStrategyRecommendationTriggerSchema,
  AdviceSchema,
  StrategyRecommendationPolicySchema,
  StrategyRecommendationPreflightSummarySchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineWorkflow, type WorkflowStep } from './define-workflow.js';

export const StrategyRecommendationsInput = z.object({
  strategyId: z.string().min(1),
  runId: z.string().min(1),
  policy: StrategyRecommendationPolicySchema,
  trigger: ActiveStrategyRecommendationTriggerSchema.default('run'),
  stockIds: z.array(z.string().min(1)).max(200).optional(),
});
export type StrategyRecommendationsInputT = z.infer<typeof StrategyRecommendationsInput>;

export const StrategyRecommendationsOutput = z.object({
  strategyId: z.string(),
  runId: z.string(),
  advices: z.array(AdviceSchema),
  skippedCooldown: z.number().int().nonnegative(),
  notificationFailed: z.number().int().nonnegative(),
  preflight: StrategyRecommendationPreflightSummarySchema.optional(),
});
export type StrategyRecommendationsOutputT = z.infer<typeof StrategyRecommendationsOutput>;

const run: WorkflowStep = async (previous, ctx) =>
  ctx.tools.generate_strategy_recommendations.execute(StrategyRecommendationsInput.parse(previous));

export const strategyRecommendationsWorkflow = defineWorkflow<
  StrategyRecommendationsInputT,
  StrategyRecommendationsOutputT
>({
  name: 'strategy-recommendations',
  description: '按 StrategyRecommendationPolicy 从持久化策略股票池生成可追溯 Advice 并可选通知',
  input: StrategyRecommendationsInput,
  steps: [run],
});
