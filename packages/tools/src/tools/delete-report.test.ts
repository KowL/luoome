import type { Report } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { deleteReportTool } from './delete-report.js';
import { getReportTool } from './get-report.js';

const now = new Date('2026-07-27T01:00:00.000Z');

const reportFixture = (): Report => ({
  id: 'report-delete',
  kind: 'opening',
  scope: { kind: 'all-accounts' },
  periodStart: '2026-07-27',
  periodEnd: '2026-07-27',
  title: '2026-07-27 开盘简报',
  generatedAt: now,
  dataAsOf: now,
  status: 'partial',
  sections: [
    {
      key: 'market-pulse',
      title: '市场脉搏',
      required: true,
      status: 'partial',
      blocks: [{ kind: 'text', text: '情绪一般', tone: 'factual' }],
      evidenceIds: [],
      missingDimensions: [
        { dimension: 'market-pulse.indexes', reason: 'index quotes unavailable', retryable: true },
      ],
    },
  ],
  evidence: [],
  missingDimensions: [],
  deliveryStatus: 'not-requested',
  workflowRunId: 'run-1',
  createdAt: now,
  updatedAt: now,
});

describe('delete_report tool', () => {
  it('删除已保存报告后 get_report 返回 not_found；重复删除同样 not_found', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await ctx.repos.report.upsertForPeriod(reportFixture());

    const deleted = await deleteReportTool.execute({ reportId: 'report-delete' }, ctx);
    expect(deleted).toEqual({ ok: true, data: { ok: true } });

    const fetched = await getReportTool.execute({ id: 'report-delete' }, ctx);
    expect(fetched.ok).toBe(false);
    if (fetched.ok) return;
    expect(fetched.error.kind).toBe('not_found');

    const again = await deleteReportTool.execute({ reportId: 'report-delete' }, ctx);
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.kind).toBe('not_found');
  });
});
