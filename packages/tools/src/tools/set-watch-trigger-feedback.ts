import { TriggerFeedbackSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';
import { getDecisionReviewContextTool, saveDecisionReviewTool } from './decision-review.js';

export const SetWatchTriggerFeedbackInput = z.object({
  triggerId: z.string().min(1),
  feedback: TriggerFeedbackSchema,
  accountId: z.string().min(1).optional(),
  requestId: z.uuid().optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
});

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
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const subject = { kind: 'watch-trigger' as const, id: input.triggerId };
    const preview = await getDecisionReviewContextTool.execute({ accountId, subject }, ctx);
    if (!preview.ok) return preview;
    if (preview.data.context === null) return errNotFound('WatchTrigger', input.triggerId);
    const saved = await saveDecisionReviewTool.execute(
      {
        accountId,
        subject,
        requestId: input.requestId ?? crypto.randomUUID(),
        contextHash: preview.data.context.contextHash,
        expectedRevision:
          input.expectedRevision ?? preview.data.current?.review.currentRevision ?? 0,
        content: {
          tradeIds: preview.data.current?.revision.content.tradeIds ?? [],
          adviceFeedback: null,
          triggerFeedback: input.feedback,
          note: preview.data.current?.revision.content.note ?? null,
        },
      },
      ctx,
    );
    if (!saved.ok) return saved;
    const at = saved.data.result.revision.recordedAt;
    return {
      ok: true as const,
      triggerId: input.triggerId,
      feedback: input.feedback,
      feedbackAt: at,
    };
  },
});
