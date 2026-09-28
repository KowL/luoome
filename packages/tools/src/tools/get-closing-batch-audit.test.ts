import type { Report, WorkflowRun } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { getClosingBatchAuditTool } from './get-closing-batch-audit.js';

const date = '2026-09-24';
const mainAt = new Date('2026-09-24T10:05:00.000Z');
const missing = { dimension: 'account-plan-batch', reason: '账户计划批次未完成', retryable: true };

const report = (overrides: Partial<Report>): Report => ({
  id: 'closing-main',
  version: 1,
  kind: 'closing',
  scope: { kind: 'account', accountId: 'test-account' },
  periodStart: date,
  periodEnd: date,
  title: '收盘复盘',
  generatedAt: mainAt,
  dataAsOf: new Date('2026-09-24T09:00:00.000Z'),
  status: 'partial',
  sections: [
    {
      key: 'account-plans',
      title: '账户计划',
      required: true,
      status: 'partial',
      blocks: [{ kind: 'text', text: '账户计划待补', tone: 'warning' }],
      evidenceIds: [],
      missingDimensions: [missing],
    },
  ],
  evidence: [],
  missingDimensions: [missing],
  deliveryStatus: 'failed',
  workflowRunId: 'closing-workflow-main',
  createdAt: mainAt,
  updatedAt: mainAt,
  ...overrides,
});

describe('get_closing_batch_audit', () => {
  it('按交易日展示全部已知账户的批次、主版和补充版，缺失主版不被旧总报告遮蔽', async () => {
    const ctx = await buildTestContext({ clock: () => new Date('2026-09-28T02:00:00.000Z') });
    const accountId = ctx.user.defaultAccountId;
    const batch: WorkflowRun = {
      id: 'batch-main',
      workflowName: 'account-plan-batch',
      mode: 'scheduled',
      status: 'partial',
      startedAt: new Date('2026-09-24T08:31:00.000Z'),
      finishedAt: new Date('2026-09-24T09:00:00.000Z'),
      inputSummary: { date, accountId },
      outputSummary: { status: 'partial', errors: [{ reason: 'quote-unavailable' }] },
      providerStatuses: [],
    };
    await ctx.repos.workflowRun.save(batch);
    await ctx.repos.workflowRun.save({
      ...batch,
      id: 'batch-retry-next-day',
      startedAt: new Date('2026-09-28T01:00:00.000Z'),
      finishedAt: new Date('2026-09-28T01:01:00.000Z'),
      status: 'succeeded',
      outputSummary: { status: 'complete', errors: [] },
    });
    await ctx.repos.report.upsertForPeriod(report({ scope: { kind: 'account', accountId } }));
    const supplementAt = new Date('2026-09-24T10:30:00.000Z');
    await ctx.repos.report.upsertForPeriod(
      report({
        id: 'closing-supplement',
        scope: { kind: 'account', accountId },
        version: 2,
        supersedesReportId: 'closing-main',
        generatedAt: supplementAt,
        status: 'complete',
        sections: [
          {
            key: 'account-plans',
            title: '账户计划',
            required: true,
            status: 'complete',
            blocks: [{ kind: 'text', text: '账户计划已补齐', tone: 'factual' }],
            evidenceIds: [],
            missingDimensions: [],
          },
        ],
        missingDimensions: [],
        deliveryStatus: 'sent',
        workflowRunId: 'closing-workflow-supplement',
        createdAt: supplementAt,
        updatedAt: supplementAt,
      }),
    );
    await ctx.repos.report.upsertForPeriod(
      report({
        id: 'legacy-all-accounts',
        scope: { kind: 'all-accounts' },
        status: 'complete',
        sections: [
          {
            key: 'market',
            title: '市场',
            required: true,
            status: 'complete',
            blocks: [{ kind: 'text', text: '市场事实', tone: 'factual' }],
            evidenceIds: [],
            missingDimensions: [],
          },
        ],
        missingDimensions: [],
      }),
    );

    const result = await getClosingBatchAuditTool.execute({ date }, ctx);
    expect(result).toMatchObject({
      ok: true,
      data: {
        tradingDay: true,
        cutoffPassed: true,
        summary: {
          knownExpectedAccounts: 3,
          withMainReport: 1,
          missingMainAfterCutoff: 2,
          mainPublishedAfterCutoff: 1,
          partialMainReports: 1,
          supplementVersions: 1,
          mainDeliveryStatusCounts: { failed: 1 },
          legacyAllAccountReports: 1,
        },
      },
    });
    if (!result.ok) return;
    const account = result.data.accounts.find((row) => row.accountId === accountId);
    expect(account).toMatchObject({
      expectedAtCutoff: true,
      mainReport: {
        id: 'closing-main',
        version: 1,
        status: 'partial',
        missingDimensions: ['account-plan-batch'],
      },
      supplements: [{ id: 'closing-supplement', version: 2, status: 'complete' }],
      mainPublishedAfterCutoffMs: 300_000,
    });
    expect(account?.batchRuns.map((run) => run.id)).toEqual(['batch-retry-next-day', 'batch-main']);
    expect(account?.batchRuns[1]).toMatchObject({ durationMs: 29 * 60_000, errorCount: 1 });

    const scoped = await getClosingBatchAuditTool.execute({ date, accountId }, ctx);
    expect(scoped).toMatchObject({
      ok: true,
      data: {
        accounts: [{ accountId }],
        summary: {
          knownExpectedAccounts: 1,
          missingMainAfterCutoff: 0,
          legacyAllAccountReports: 0,
        },
      },
    });
  });

  it('18:00 前不把尚未发布的主报告记为逾期缺口', async () => {
    const ctx = await buildTestContext({ clock: () => new Date('2026-09-24T09:00:00.000Z') });
    expect(await getClosingBatchAuditTool.execute({ date }, ctx)).toMatchObject({
      ok: true,
      data: {
        tradingDay: true,
        cutoffPassed: false,
        summary: { knownExpectedAccounts: 3, withMainReport: 0, missingMainAfterCutoff: 0 },
      },
    });
  });

  it('账户已不在当前清单时，逾期补记的主报告仍计入预期账户', async () => {
    const ctx = await buildTestContext({ clock: () => new Date('2026-09-28T02:00:00.000Z') });
    const account = (await ctx.repos.account.list())[0];
    if (account === undefined) throw new Error('account fixture missing');
    await ctx.repos.report.upsertForPeriod(
      report({
        id: 'late-gap-report',
        scope: { kind: 'account', accountId: account.id },
        generatedAt: new Date('2026-09-28T01:00:00.000Z'),
        createdAt: new Date('2026-09-28T01:00:00.000Z'),
        updatedAt: new Date('2026-09-28T01:00:00.000Z'),
      }),
    );
    await ctx.repos.account.remove(account.id);

    const result = await getClosingBatchAuditTool.execute({ date, accountId: account.id }, ctx);
    expect(result).toMatchObject({
      ok: true,
      data: {
        accounts: [{ inCurrentInventory: false, expectedAtCutoff: true }],
        summary: { knownExpectedAccounts: 1, withMainReport: 1, mainPublishedAfterCutoff: 1 },
      },
    });
  });

  it('休市日不把现有账户计作预期出报账户', async () => {
    const ctx = await buildTestContext({ clock: () => new Date('2026-09-27T12:00:00.000Z') });
    for (const date of ['2026-09-25', '2026-09-27']) {
      const result = await getClosingBatchAuditTool.execute({ date }, ctx);
      expect(result).toMatchObject({
        ok: true,
        data: {
          tradingDay: false,
          cutoffPassed: true,
          summary: {
            knownExpectedAccounts: 0,
            withMainReport: 0,
            missingMainAfterCutoff: 0,
          },
        },
      });
      if (!result.ok) continue;
      expect(result.data.accounts.every((row) => !row.expectedAtCutoff)).toBe(true);
    }
  });
});
