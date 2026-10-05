import { createHash } from 'node:crypto';
import { DecisionReviewReportSnapshotSchema, TradeSchema } from '@luoome/core';
import { z } from 'zod';
import { defineTool, errNotFound } from '../define-tool.js';

export const GetDecisionReviewSnapshotInput = z
  .object({
    accountId: z.string().min(1),
    periodStart: z.string().date(),
    periodEnd: z.string().date(),
  })
  .strict()
  .refine((input) => input.periodStart <= input.periodEnd, '报告窗口无效');
export const GetDecisionReviewSnapshotOutput = z.object({
  snapshot: DecisionReviewReportSnapshotSchema,
});

export const getDecisionReviewSnapshotTool = defineTool({
  name: 'get_decision_review_snapshot',
  description: '固定账户报告窗口内本地复盘修订水位与成交事实身份',
  sideEffect: 'read',
  input: GetDecisionReviewSnapshotInput,
  output: GetDecisionReviewSnapshotOutput,
  handler: async (input, ctx) => {
    if ((await ctx.repos.account.findById(input.accountId)) === null)
      return errNotFound('Account', input.accountId);
    const throughSequence = await ctx.repos.decisionReview.latestSequence(input.accountId);
    const since = new Date(`${input.periodStart}T00:00:00.000+08:00`);
    const until = new Date(`${input.periodEnd}T23:59:59.999+08:00`);
    const revisionIds: { reviewId: string; revision: number }[] = [];
    const tradeIds = new Set<string>();
    let cursor: { occurredAt: Date; id: string } | undefined;
    while (true) {
      const page = await ctx.repos.decisionReview.list({
        accountId: input.accountId,
        since,
        until,
        throughSequence,
        ...(cursor === undefined ? {} : { cursor }),
        limit: 100,
      });
      for (const { review, revision } of page) {
        revisionIds.push({ reviewId: review.id, revision: revision.revision });
        for (const id of revision.content.tradeIds) tradeIds.add(id);
      }
      if (page.length < 100) break;
      const last = page.at(-1)!;
      cursor = { occurredAt: last.review.sourceOccurredAt, id: last.review.id };
    }
    revisionIds.sort((a, b) => a.reviewId.localeCompare(b.reviewId));
    const tradeFactHashes: Record<string, string> = {};
    for (const id of [...tradeIds].sort()) {
      const trade = await ctx.repos.trade.findById(id);
      tradeFactHashes[id] =
        trade === null
          ? 'missing'
          : createHash('sha256')
              .update(JSON.stringify(TradeSchema.parse(trade)))
              .digest('hex');
    }
    const inputFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          schemaVersion: 1,
          accountId: input.accountId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          revisionIds,
          tradeFactHashes,
        }),
      )
      .digest('hex');
    return {
      snapshot: {
        schemaVersion: 1 as const,
        accountId: input.accountId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        throughSequence,
        revisionIds,
        tradeFactHashes,
        inputFingerprint,
      },
    };
  },
});
