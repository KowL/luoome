import type { Report } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { getReportTool } from './get-report.js';
import { listReportsTool } from './list-reports.js';
import { renderReportTool } from './render-report.js';
import { saveReportTool } from './save-report.js';
import { setReportDeliveryStatusTool } from './set-report-delivery-status.js';

const NOW = new Date('2026-07-29T10:00:00.000Z');

const makeReport = (overrides: Partial<Report> = {}): Report => ({
  id: 'report-1',
  kind: 'closing',
  scope: { kind: 'all-accounts' },
  periodStart: '2026-07-29',
  periodEnd: '2026-07-29',
  title: 'A 股收盘复盘',
  generatedAt: NOW,
  dataAsOf: new Date('2026-07-29T08:00:00.000Z'),
  status: 'complete',
  sections: [
    {
      key: 'market-pulse',
      title: '市场脉搏',
      required: true,
      status: 'complete',
      blocks: [{ kind: 'text', text: '市场平稳', tone: 'factual' }],
      evidenceIds: [],
      missingDimensions: [],
    },
  ],
  evidence: [],
  missingDimensions: [],
  deliveryStatus: 'not-requested',
  workflowRunId: 'workflow-run-1',
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe('report tools', () => {
  it('save_report 保存后，get_report 可按稳定 id 读取', async () => {
    const ctx = await buildTestContext();
    const saved = await saveReportTool.execute({ report: makeReport() }, ctx);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.data.created).toBe(true);

    const found = await getReportTool.execute({ id: saved.data.report.id }, ctx);
    expect(found).toEqual({ ok: true, data: { report: saved.data.report } });
  });

  it('list_reports 返回轻量摘要并按筛选条件查询', async () => {
    const ctx = await buildTestContext();
    await saveReportTool.execute({ report: makeReport() }, ctx);

    const result = await listReportsTool.execute(
      {
        kind: 'closing',
        scope: { kind: 'all-accounts' },
        from: '2026-07-29',
        to: '2026-07-29',
        status: 'complete',
        limit: 30,
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.reports).toHaveLength(1);
    expect(result.data.reports[0]).not.toHaveProperty('sections');
    expect(result.data.reports[0]?.title).toBe('A 股收盘复盘');
  });

  it('render_report 的 Markdown 明示数据截止时间、partial、缺失原因和 provenance', async () => {
    const ctx = await buildTestContext();
    const baseSection = makeReport().sections[0];
    if (baseSection === undefined) throw new Error('invalid fixture');
    const missing = {
      dimension: 'market.breadth',
      reason: '宽度源超时',
      errorKind: 'adapter_error',
      retryable: true,
    };
    await saveReportTool.execute(
      {
        report: makeReport({
          status: 'partial',
          sections: [
            {
              ...baseSection,
              status: 'partial',
              missingDimensions: [missing],
            },
          ],
          evidence: [
            {
              id: 'market-index',
              dimension: 'market.index',
              provenance: {
                provider: 'eastmoney',
                observedAt: new Date('2026-07-29T07:00:00.000Z'),
                fetchedAt: NOW,
                freshness: 'fresh',
              },
            },
          ],
          missingDimensions: [missing],
        }),
      },
      ctx,
    );

    const rendered = await renderReportTool.execute(
      { reportId: 'report-1', format: 'markdown' },
      ctx,
    );
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.data.contentType).toBe('text/markdown; charset=utf-8');
    expect(rendered.data.content).toContain('部分可用');
    expect(rendered.data.content).toContain('数据截止');
    expect(rendered.data.content).toContain('宽度源超时');
    expect(rendered.data.content).toContain('eastmoney');
  });

  it('set_report_delivery_status 更新状态并拒绝 sent 回退 pending', async () => {
    const ctx = await buildTestContext();
    await saveReportTool.execute({ report: makeReport() }, ctx);

    const sent = await setReportDeliveryStatusTool.execute(
      { reportId: 'report-1', deliveryStatus: 'sent' },
      ctx,
    );
    expect(sent).toEqual({
      ok: true,
      data: { reportId: 'report-1', deliveryStatus: 'sent' },
    });

    const rollback = await setReportDeliveryStatusTool.execute(
      { reportId: 'report-1', deliveryStatus: 'pending' },
      ctx,
    );
    expect(rollback.ok).toBe(false);
    if (rollback.ok) return;
    expect(rollback.error.kind).toBe('invariant_violation');
  });
});
