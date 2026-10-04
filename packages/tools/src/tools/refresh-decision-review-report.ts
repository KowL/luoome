import { createHash, randomUUID } from 'node:crypto';
import { InvariantError, ReportSchema } from '@luoome/core';
import { z } from 'zod';
import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import { getDecisionLoopReviewTool } from './get-decision-loop-review.js';
import { getDecisionReviewSnapshotTool } from './get-decision-review-snapshot.js';

export const RefreshDecisionReviewReportInput = z
  .object({
    accountId: z.string().min(1).optional(),
    reportId: z.string().min(1),
    expectedLatestReportId: z.string().min(1),
    requestId: z.uuid(),
  })
  .strict();
export const RefreshDecisionReviewReportOutput = z.object({
  report: ReportSchema,
  created: z.boolean(),
  replayed: z.boolean(),
  notified: z.literal(false),
});

export const refreshDecisionReviewReportTool = defineTool({
  name: 'refresh_decision_review_report',
  description: '仅以已落库账户复盘事实生成收盘/周报不可通知补充版',
  sideEffect: 'write',
  input: RefreshDecisionReviewReportInput,
  output: RefreshDecisionReviewReportOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const source = await ctx.repos.report.findById(input.reportId);
    if (source === null) return errNotFound('Report', input.reportId);
    if (source.scope.kind !== 'account' || source.scope.accountId !== accountId)
      return errNotFound('Report', input.reportId);
    if (source.kind !== 'closing' && source.kind !== 'weekly')
      return errInvalidInput('仅支持账户收盘或周报复盘补充');
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          accountId,
          reportId: input.reportId,
          expectedLatestReportId: input.expectedLatestReportId,
        }),
      )
      .digest('hex');
    const receipt = await ctx.repos.report.findRefreshReceipt({
      accountId,
      requestId: input.requestId,
    });
    if (receipt !== null) {
      if (receipt.requestHash !== requestHash) return errInvalidInput('请求 ID 已用于其他报告补充');
      return { report: receipt.report, created: false, replayed: true, notified: false as const };
    }
    const latest = await ctx.repos.report.findByPeriod({
      kind: source.kind,
      scopeKey: `account:${accountId}`,
      periodStart: source.periodStart,
      periodEnd: source.periodEnd,
    });
    if (latest === null || latest.id !== input.expectedLatestReportId || source.id !== latest.id)
      return errInvalidInput('报告最新版本已变化，请重新读取');
    const snapshotResult = await getDecisionReviewSnapshotTool.execute(
      {
        accountId,
        periodStart: source.periodStart,
        periodEnd: source.periodEnd,
      },
      ctx,
    );
    if (!snapshotResult.ok) return snapshotResult;
    const snapshot = snapshotResult.data.snapshot;
    if (latest.decisionReviewSnapshot?.inputFingerprint === snapshot.inputFingerprint) {
      try {
        const reused = await ctx.repos.report.reuseDecisionReviewReport({
          accountId,
          reportId: latest.id,
          requestId: input.requestId,
          requestHash,
          throughSequence: snapshot.throughSequence,
        });
        return { report: reused, created: false, replayed: false, notified: false as const };
      } catch (error) {
        if (error instanceof InvariantError) return errInvalidInput(error.message);
        throw error;
      }
    }
    const since = new Date(`${source.periodStart}T00:00:00.000+08:00`);
    const until = new Date(`${source.periodEnd}T23:59:59.999+08:00`);
    const review = await getDecisionLoopReviewTool.execute(
      { accountId, since, until, limit: 1000 },
      ctx,
    );
    if (!review.ok) return review;
    const now = ctx.clock();
    const evidenceId = `decision-review:${snapshot.inputFingerprint}`;
    const section = {
      key: 'decision-review',
      title: '账户决策与复盘',
      required: false,
      status: 'complete' as const,
      dataAsOf: now,
      blocks: [
        {
          kind: 'metrics' as const,
          items: [
            {
              key: 'decisionRecords',
              label: '明确复盘记录',
              value: review.data.decisionRecords.total,
            },
            {
              key: 'linkedTrades',
              label: '明确关联成交',
              value: review.data.decisionRecords.linkedTrades,
            },
            { key: 'pendingAdvice', label: '待核对建议', value: review.data.advice.pending },
            {
              key: 'triggerFeedback',
              label: '提醒反馈',
              value: review.data.decisionRecords.triggerFeedbackCount,
            },
          ],
        },
        {
          kind: 'text' as const,
          tone: 'factual' as const,
          text: '以上为用户明确记录的账户事实；未知盈亏不计为零，不从提醒推断成交。',
        },
      ],
      evidenceIds: [evidenceId],
      missingDimensions: [],
    };
    const version = (latest.version ?? 1) + 1;
    const report = ReportSchema.parse({
      ...latest,
      id: `report-decision-review-${randomUUID()}`,
      version,
      supersedesReportId: latest.id,
      title: `${latest.title.replace(/（复盘补充 v\d+）$/, '')}（复盘补充 v${version}）`,
      generatedAt: now,
      sections: [...latest.sections.filter((item) => item.key !== 'decision-review'), section],
      evidence: [
        ...latest.evidence.filter((item) => !item.id.startsWith('decision-review:')),
        {
          id: evidenceId,
          dimension: 'decision-review',
          provenance: {
            provider: 'local/decision-review',
            observedAt: now,
            fetchedAt: now,
            freshness: 'fresh',
          },
        },
      ],
      missingDimensions: latest.missingDimensions.filter(
        (item) => item.dimension !== 'decision-review',
      ),
      decisionReviewSnapshot: snapshot,
      notificationPolicy: 'never',
      deliveryStatus: 'not-requested',
      workflowRunId: `report-refresh-${input.requestId}`,
      createdAt: now,
      updatedAt: now,
    });
    try {
      const saved = await ctx.repos.report.appendDecisionReviewSupplement({
        report,
        expectedLatestReportId: input.expectedLatestReportId,
        requestId: input.requestId,
        requestHash,
      });
      return { ...saved, notified: false as const };
    } catch (error) {
      if (error instanceof InvariantError) return errInvalidInput(error.message);
      throw error;
    }
  },
});
