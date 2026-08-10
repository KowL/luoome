import { AdviceSchema, StrategyRecommendationPolicySchema } from '@luoome/core';
import { z } from 'zod';

import { defineWorkflow, type WorkflowContext, type WorkflowStep } from './define-workflow.js';

export const StrategyRecommendationsInput = z.object({
  strategyId: z.string().min(1),
  runId: z.string().min(1),
  policy: StrategyRecommendationPolicySchema,
  trigger: z.enum(['run', 't1', 't3', 't5', 't20']).default('run'),
  stockIds: z.array(z.string().min(1)).max(200).optional(),
});
export type StrategyRecommendationsInputT = z.infer<typeof StrategyRecommendationsInput>;

export const StrategyRecommendationsOutput = z.object({
  strategyId: z.string(),
  runId: z.string(),
  advices: z.array(AdviceSchema),
  skippedCooldown: z.number().int().nonnegative(),
  notificationFailed: z.number().int().nonnegative(),
});
export type StrategyRecommendationsOutputT = z.infer<typeof StrategyRecommendationsOutput>;

const generateRecommendations = async (
  input: StrategyRecommendationsInputT,
  ctx: WorkflowContext,
): Promise<
  | StrategyRecommendationsOutputT
  | Awaited<ReturnType<WorkflowContext['tools']['list_strategy_result_views']['execute']>>
> => {
  const listed = await ctx.tools.list_strategy_result_views.execute({
    strategyId: input.strategyId,
    runId: input.runId,
    view: 'selected',
    sort: 'rank',
    order: 'asc',
    offset: 0,
    limit: input.policy.maxRank,
  });
  if (!listed.ok) return listed;
  const eligible = listed.data.rows
    .filter(({ stock }) => input.stockIds === undefined || input.stockIds.includes(stock.stockId))
    .filter(({ view }) => (view.result.rank ?? Number.MAX_SAFE_INTEGER) <= input.policy.maxRank)
    .filter(({ view }) => (view.result.score ?? -1) >= input.policy.minScore)
    .slice(0, input.policy.maxPerRun);
  const advices: z.output<typeof AdviceSchema>[] = [];
  let skippedCooldown = 0;
  let notificationFailed = 0;
  const since = new Date(ctx.clock().getTime() - input.policy.cooldownHours * 60 * 60 * 1000);
  for (const row of eligible) {
    const previous = await ctx.tools.get_advice.execute({
      subjectKind: 'stock',
      subjectId: row.stock.stockId,
      sourceTool: 'analyze_strategy_candidate',
      since,
      includeExpired: true,
      limit: 50,
    });
    if (!previous.ok) return previous;
    const duplicate = previous.data.advices.some(
      (advice) =>
        advice.basedOn.strategy?.strategyId === input.strategyId &&
        advice.basedOn.strategy.recommendationTrigger === input.trigger,
    );
    if (duplicate) {
      skippedCooldown += 1;
      continue;
    }
    const generated = await ctx.tools.analyze_strategy_candidate.execute({
      strategyId: input.strategyId,
      runId: input.runId,
      stockId: row.stock.stockId,
      recommendationTrigger: input.trigger,
    });
    if (!generated.ok) {
      ctx.logger.warn('strategy-recommendations: 单票 Advice 生成失败', {
        strategyId: input.strategyId,
        runId: input.runId,
        stockId: row.stock.stockId,
        errorKind: generated.error.kind,
      });
      continue;
    }
    advices.push(generated.data.advice);
    if (!input.policy.notify) continue;
    const advice = generated.data.advice;
    const payload = {
      title: `策略推荐 · ${advice.stockName ?? advice.subjectId}`,
      content: [
        `${advice.subjectId} · ${advice.decision} · 信心度 ${advice.confidence}`,
        advice.reasoning.premise,
        `证据：${advice.reasoning.evidence.join('；') || '暂无'}`,
        `反证：${advice.reasoning.counterEvidence.join('；') || '暂无'}`,
        `风险：${advice.risks.join('；') || '暂无'}`,
        `有效期至 ${advice.validUntil.toISOString()}`,
        advice.disclaimers.join('\n'),
      ].join('\n'),
      level: advice.decision === 'avoid' || advice.decision === 'sell' ? 'warn' : 'info',
    } as const;
    const notification = await ctx.tools.send_notification.execute({
      channel: input.policy.channel,
      ...(input.policy.channel === 'feishu' ? { feishu: payload } : { log: payload }),
      adviceId: advice.id,
    });
    if (!notification.ok) notificationFailed += 1;
  }
  return StrategyRecommendationsOutput.parse({
    strategyId: input.strategyId,
    runId: input.runId,
    advices,
    skippedCooldown,
    notificationFailed,
  });
};

const run: WorkflowStep = async (previous, ctx) => {
  const input = previous as StrategyRecommendationsInputT;
  if (!input.policy.enabled) {
    return StrategyRecommendationsOutput.parse({
      strategyId: input.strategyId,
      runId: input.runId,
      advices: [],
      skippedCooldown: 0,
      notificationFailed: 0,
    });
  }
  return generateRecommendations(input, ctx);
};

export const strategyRecommendationsWorkflow = defineWorkflow<
  StrategyRecommendationsInputT,
  StrategyRecommendationsOutputT
>({
  name: 'strategy-recommendations',
  description: '按 StrategyRecommendationPolicy 从持久化策略股票池生成可追溯 Advice 并可选通知',
  input: StrategyRecommendationsInput,
  steps: [run],
});
