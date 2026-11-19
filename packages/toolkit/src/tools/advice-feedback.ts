import { type AdviceFeedbackAction, AdviceFeedbackSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';

export const SubmitAdviceFeedbackInput = z.object({
  adviceId: z.string().min(1),
  /** done=做了 / skipped=没做 / later=再等等；later 不参与命中判定。 */
  action: z.enum(['done', 'skipped', 'later']),
  /** 「做了」时的实际成交价；缺省按建议入场区间中值假设成交。 */
  fillPrice: z.number().positive().optional(),
});
export const SubmitAdviceFeedbackOutput = z.object({
  adviceId: z.string().min(1),
  action: z.enum(['done', 'skipped', 'later']),
  recordedAt: z.coerce.date(),
});

/**
 * 记录用户对一条建议的动作。三按钮的落地点，必须在一次点击内完成：
 * 不做表单、不要求填盈亏，结算由 settle_advices 用日线自动完成。
 */
export const submitAdviceFeedbackTool = defineTool({
  name: 'submit_advice_feedback',
  description: '记录对一条建议的动作（做了/没做/再等等），可选实际成交价；同一建议只保留最后一次',
  sideEffect: 'write',
  input: SubmitAdviceFeedbackInput,
  output: SubmitAdviceFeedbackOutput,
  handler: async (input, ctx) => {
    const advice = await ctx.repos.advice.findById(input.adviceId);
    if (advice === null) return errNotFound('Advice', input.adviceId);
    const recordedAt = ctx.clock();
    const feedback = AdviceFeedbackSchema.parse({
      adviceId: input.adviceId,
      action: input.action satisfies AdviceFeedbackAction,
      ...(input.fillPrice === undefined ? {} : { fillPrice: input.fillPrice }),
      recordedAt,
    });
    await ctx.repos.adviceTracking.recordFeedback(feedback);
    return { adviceId: feedback.adviceId, action: feedback.action, recordedAt };
  },
});

export const ListAdviceFeedbackInput = z.object({
  limit: z.number().int().min(1).max(500).default(200),
  action: z.enum(['done', 'skipped', 'later']).optional(),
});
export const ListAdviceFeedbackOutput = z.object({
  feedbacks: z.array(
    z.object({
      adviceId: z.string().min(1),
      action: z.enum(['done', 'skipped', 'later']),
      fillPrice: z.number().optional(),
      recordedAt: z.coerce.date(),
    }),
  ),
});

/** 建议页一次性取回最近反馈，避免每条建议各发一次请求。 */
export const listAdviceFeedbackTool = defineTool({
  name: 'list_advice_feedback',
  description: '按记录时间倒序列出用户反馈（做了/没做/再等等），供建议页一次性回填按钮状态',
  sideEffect: 'read',
  input: ListAdviceFeedbackInput,
  output: ListAdviceFeedbackOutput,
  handler: async (input, ctx) => {
    const rows = await ctx.repos.adviceTracking.listFeedbacks({
      limit: input.limit,
      ...(input.action === undefined ? {} : { action: input.action }),
    });
    return {
      feedbacks: rows.map((row) => ({
        adviceId: row.adviceId,
        action: row.action,
        ...(row.fillPrice === undefined ? {} : { fillPrice: row.fillPrice }),
        recordedAt: row.recordedAt,
      })),
    };
  },
});
