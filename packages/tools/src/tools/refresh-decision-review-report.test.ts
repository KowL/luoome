import { ReportSchema } from '@luoome/core';
import { expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';
import { getDecisionReviewSnapshotTool } from './get-decision-review-snapshot.js';
import { refreshDecisionReviewReportTool } from './refresh-decision-review-report.js';
import { setReportDeliveryStatusTool } from './set-report-delivery-status.js';

const now = new Date('2026-09-04T10:00:00.000Z');

it('周报复盘补充保留原版、同键重试幂等，且 never 版不能进入通知状态', async () => {
  const ctx = await buildTestContext({ clock: () => now });
  const accountId = ctx.user.defaultAccountId;
  const original = ReportSchema.parse({
    id: 'report-review-original',
    version: 1,
    kind: 'weekly',
    scope: { kind: 'account', accountId },
    periodStart: '2026-09-03',
    periodEnd: '2026-09-03',
    title: '复盘测试',
    generatedAt: now,
    dataAsOf: now,
    status: 'complete',
    sections: [
      {
        key: 'original',
        title: '原始事实',
        required: true,
        status: 'complete',
        blocks: [{ kind: 'text', text: '历史数据' }],
        evidenceIds: [],
        missingDimensions: [],
      },
    ],
    evidence: [],
    missingDimensions: [],
    deliveryStatus: 'sent',
    workflowRunId: 'workflow-original',
    createdAt: now,
    updatedAt: now,
  });
  const closing = { ...original, id: 'closing-report', kind: 'closing' as const };
  await ctx.repos.report.upsertForPeriod(closing);
  const rejected = await refreshDecisionReviewReportTool.execute(
    {
      reportId: closing.id,
      expectedLatestReportId: closing.id,
      requestId: 'be63612a-a9cf-472f-917c-710897b38d67',
    },
    ctx,
  );
  expect(rejected).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
  expect(await ctx.repos.report.list({ kind: 'closing' })).toEqual([closing]);
  await ctx.repos.report.upsertForPeriod(original);
  const input = {
    reportId: original.id,
    expectedLatestReportId: original.id,
    requestId: 'e6c5fe7f-6637-4870-ae2a-4c5c53dba1cf',
  };
  const first = await refreshDecisionReviewReportTool.execute(input, ctx);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(first.data.report).toMatchObject({
    version: 2,
    supersedesReportId: original.id,
    notificationPolicy: 'never',
    deliveryStatus: 'not-requested',
  });
  expect(first.data.created).toBe(true);
  expect((await ctx.repos.report.findById(original.id))?.sections[0]?.key).toBe('original');
  const replay = await refreshDecisionReviewReportTool.execute(input, ctx);
  expect(replay.ok && replay.data.replayed).toBe(true);
  const forbidden = await setReportDeliveryStatusTool.execute(
    {
      reportId: first.data.report.id,
      deliveryStatus: 'pending',
    },
    ctx,
  );
  expect(forbidden).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
  expect(
    await ctx.repos.report.claimDelivery({
      id: first.data.report.id,
      attemptId: 'forbidden',
      now,
      stalePendingBefore: now,
      failedRetryBefore: now,
    }),
  ).toBe(false);
  const unchanged = await refreshDecisionReviewReportTool.execute(
    {
      reportId: first.data.report.id,
      expectedLatestReportId: first.data.report.id,
      requestId: 'a97f580b-f44d-464e-a46a-39e2ef3b63eb',
    },
    ctx,
  );
  expect(unchanged.ok && unchanged.data.created).toBe(false);
  expect(await ctx.repos.report.list({ kind: 'weekly' })).toHaveLength(2);
});

it('事实水位变化后重算指纹，同一前驱并发只能追加一个版本', async () => {
  const ctx = await buildTestContext({ clock: () => now });
  const accountId = ctx.user.defaultAccountId;
  const snapshot = await getDecisionReviewSnapshotTool.execute(
    {
      accountId,
      periodStart: '2026-09-03',
      periodEnd: '2026-09-03',
    },
    ctx,
  );
  expect(snapshot.ok).toBe(true);
  if (!snapshot.ok) return;
  await ctx.repos.decisionReview.commit({
    accountId,
    requestId: 'test-review-write',
    requestHash: 'hash',
    expectedRevision: 0,
    review: {
      id: 'test-review',
      accountId,
      subject: { kind: 'advice', id: 'test-advice' },
      stockId: '002594.SZ',
      sourceOccurredAt: new Date('2026-09-03T00:00:00.000Z'),
      context: {
        schemaVersion: 1,
        capturedAt: now,
        sourceDataAsOf: null,
        captureOrigin: 'user',
        source: {},
        contextHash: 'context',
      },
      createdAt: now,
    },
    content: {
      tradeIds: [],
      adviceFeedback: { outcome: 'ignored' },
      triggerFeedback: null,
      note: null,
    },
    contentHash: 'content',
    tradeFactHashes: {},
    changeNote: null,
    recordedAt: now,
  });
  const updated = await getDecisionReviewSnapshotTool.execute(
    {
      accountId,
      periodStart: '2026-09-03',
      periodEnd: '2026-09-03',
    },
    ctx,
  );
  expect(updated.ok).toBe(true);
  if (!updated.ok) return;
  expect(updated.data.snapshot.inputFingerprint).not.toBe(snapshot.data.snapshot.inputFingerprint);
  expect(updated.data.snapshot.revisionIds).toEqual([{ reviewId: 'test-review', revision: 1 }]);
});
