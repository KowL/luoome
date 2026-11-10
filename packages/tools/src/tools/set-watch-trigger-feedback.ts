import { TriggerFeedbackSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';

export const SetWatchTriggerFeedbackInput = z
  .object({
    triggerId: z.string().min(1),
    feedback: TriggerFeedbackSchema,
    accountId: z.string().min(1).optional(),
  })
  .strict();

export const SetWatchTriggerFeedbackOutput = z.object({
  ok: z.literal(true),
  triggerId: z.string(),
  feedback: TriggerFeedbackSchema,
  feedbackAt: z.coerce.date(),
});

/**
 * 设置 watch trigger 反馈（v0.7 策略预警，docs/.../§9.2/§6.4）。
 *
 * - 幂等：重复设置同一值直接成功；改值覆盖并更新 feedbackAt
 * - 校验：triggerId 不存在 → not_found
 * - MCP：write opt-in
 */
export const setWatchTriggerFeedbackTool = defineTool({
  name: 'set_watch_trigger_feedback',
  description: '设置盯盘触发反馈（handled / useful / useless / ignored）',
  sideEffect: 'write',
  input: SetWatchTriggerFeedbackInput,
  output: SetWatchTriggerFeedbackOutput,
  handler: async (input, ctx) => {
    const trigger = await ctx.repos.watchTrigger.findById(input.triggerId);
    if (trigger === null) return errNotFound('WatchTrigger', input.triggerId);
    const feedbackAt = ctx.clock();
    await ctx.repos.watchTrigger.setFeedback(input.triggerId, input.feedback, feedbackAt);
    return {
      ok: true as const,
      triggerId: input.triggerId,
      feedback: input.feedback,
      feedbackAt,
    };
  },
});
