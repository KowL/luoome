import { z } from 'zod';
import type { ConfirmablePluginTool } from './plugin-operations.js';
import {
  decisionReviewWriteHash,
  resolveDecisionReviewWriteContent,
  saveDecisionReviewTool,
} from './tools/decision-review.js';

export const decisionReviewOperation: ConfirmablePluginTool = {
  tool: saveDecisionReviewTool,
  scheduled: false,
  async bind(raw, principal, operationId, ctx) {
    const input = z.record(z.string(), z.unknown()).parse(raw);
    if (
      (input.accountId !== undefined && input.accountId !== principal.accountId) ||
      (input.requestId !== undefined && input.requestId !== operationId)
    )
      throw new Error('Operation scope mismatch');
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
          content: await resolveDecisionReviewWriteContent(
            { ...input, accountId: input.accountId },
            ctx,
          ),
        })
    )
      return null;
    return { ok: true, data: { result: receipt.result, replayed: true } };
  },
};
