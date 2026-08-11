import {
  AdviceSchema,
  isPublishableOperationalRun,
  StrategyRecommendationPolicySchema,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput } from '../define-tool.js';
import { analyzeStrategyCandidateTool } from './analyze-strategy-candidate.js';
import { getAdviceTool } from './get-advice.js';
import { sendNotificationTool } from './send-notification.js';
import { listStrategyResultViewsTool } from './strategy-query.js';

export const GenerateStrategyRecommendationsInput = z.object({
  strategyId: z.string().min(1),
  runId: z.string().min(1),
  policy: StrategyRecommendationPolicySchema,
  trigger: z.enum(['run', 't1', 't3', 't5', 't20']).default('run'),
  stockIds: z.array(z.string().min(1)).max(200).optional(),
});
export const GenerateStrategyRecommendationsOutput = z.object({
  strategyId: z.string(),
  runId: z.string(),
  advices: z.array(AdviceSchema),
  skippedCooldown: z.number().int().nonnegative(),
  notificationFailed: z.number().int().nonnegative(),
});

export const generateStrategyRecommendationsTool = defineTool({
  name: 'generate_strategy_recommendations',
  description: '按 StrategyRecommendationPolicy 从已发布运行生成可追溯 Advice 并可选通知',
  sideEffect: 'advice',
  requiredCapabilities: ['advice', 'external'],
  input: GenerateStrategyRecommendationsInput,
  output: GenerateStrategyRecommendationsOutput,
  handler: async (input, ctx: ToolContext) => {
    if (!input.policy.enabled) {
      return {
        strategyId: input.strategyId,
        runId: input.runId,
        advices: [],
        skippedCooldown: 0,
        notificationFailed: 0,
      };
    }
    const listed = await listStrategyResultViewsTool.execute(
      {
        strategyId: input.strategyId,
        runId: input.runId,
        view: 'selected',
        sort: 'rank',
        order: 'asc',
        offset: 0,
        limit: input.policy.maxRank,
      },
      ctx,
    );
    if (!listed.ok) return listed;
    if (!isPublishableOperationalRun(listed.data.run)) {
      return errInvalidInput('只有已发布且通过完整性门禁的 operational StrategyRun 才能生成推荐');
    }
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
      const previous = await getAdviceTool.execute(
        {
          subjectKind: 'stock',
          subjectId: row.stock.stockId,
          sourceTool: 'analyze_strategy_candidate',
          since,
          includeExpired: true,
          limit: 50,
        },
        ctx,
      );
      if (!previous.ok) continue;
      if (
        previous.data.advices.some(
          (advice) =>
            advice.basedOn.strategy?.strategyId === input.strategyId &&
            advice.basedOn.strategy.recommendationTrigger === input.trigger,
        )
      ) {
        skippedCooldown += 1;
        continue;
      }
      const generated = await analyzeStrategyCandidateTool.execute(
        {
          strategyId: input.strategyId,
          runId: input.runId,
          stockId: row.stock.stockId,
          recommendationTrigger: input.trigger,
        },
        ctx,
      );
      if (!generated.ok) continue;
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
      const notification = await sendNotificationTool.execute(
        {
          channel: input.policy.channel,
          ...(input.policy.channel === 'feishu' ? { feishu: payload } : { log: payload }),
          adviceId: advice.id,
        },
        ctx,
      );
      if (!notification.ok) notificationFailed += 1;
    }
    return {
      strategyId: input.strategyId,
      runId: input.runId,
      advices,
      skippedCooldown,
      notificationFailed,
    };
  },
});
