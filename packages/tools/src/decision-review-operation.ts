import { z } from 'zod';
import { normalizeDecisionReviewWriteContent } from './internal/decision-review-write-content.js';
import { type ConfirmablePluginTool, PluginOperationScopeError } from './plugin-operations.js';
import {
  decisionReviewWriteHash,
  resolveDecisionReviewWriteContent,
  saveDecisionReviewTool,
} from './tools/decision-review.js';

export const decisionReviewOperation: ConfirmablePluginTool = {
  tool: saveDecisionReviewTool,
  scheduled: false,
  hostBoundFields: ['accountId', 'requestId'],
  async bind(raw, principal, operationId, ctx) {
    const input = z.record(z.string(), z.unknown()).parse(raw);
    if (input.accountId !== undefined && input.accountId !== principal.accountId)
      throw new PluginOperationScopeError('accountId');
    if (input.requestId !== undefined && input.requestId !== operationId)
      throw new PluginOperationScopeError('requestId');
    const parsed = saveDecisionReviewTool.inputSchema.parse({
      ...input,
      accountId: principal.accountId,
      requestId: operationId,
    });
    return {
      ...parsed,
      content: await resolveDecisionReviewWriteContent(
        { ...parsed, accountId: principal.accountId },
        ctx,
      ),
    };
  },
  async receipt(raw, ctx) {
    const input = saveDecisionReviewTool.inputSchema.parse(raw);
    if (!input.accountId) return null;
    const receipt = await ctx.repos.decisionReview.findWriteReceipt({
      accountId: input.accountId,
      requestId: input.requestId,
    });
    if (
      !receipt ||
      receipt.requestHash !==
        decisionReviewWriteHash({
          ...input,
          accountId: input.accountId,
          // 与写入路径共用同一个规范化：少一步（排序或 origin 盖章）就会让
          // response-loss 后的 reconcile 永远认不出自己已提交的修订。
          content: normalizeDecisionReviewWriteContent(
            await resolveDecisionReviewWriteContent({ ...input, accountId: input.accountId }, ctx),
            ctx,
          ),
        })
    )
      return null;
    return { ok: true, data: { result: receipt.result, replayed: true } };
  },
};
