import type { Report } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { renderReportTool } from './render-report.js';

const now = new Date('2026-07-27T01:00:00.000Z');

const reportFixture = (): Report => ({
  id: 'report-ratio',
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
      blocks: [
        {
          kind: 'metrics',
          items: [
            { key: 'sealedCount', label: '封板家数', value: 58 },
            { key: 'brokenRate', label: '炸板率', value: 0.226, unit: 'ratio' },
            { key: 'indexCount', label: '指数样本', value: null },
            { key: 'custom', label: '自定义', value: 3, unit: '只', displayValue: '三' },
          ],
        },
      ],
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

describe('render_report tool', () => {
  it('metrics 的 ratio 值渲染为百分比，null 渲染为不可用，displayValue 优先', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await ctx.repos.report.upsertForPeriod(reportFixture());

    const result = await renderReportTool.execute(
      { reportId: 'report-ratio', format: 'markdown' },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.content).toContain('- 封板家数：58');
    expect(result.data.content).toContain('- 炸板率：22.6%');
    expect(result.data.content).toContain('- 指数样本：不可用');
    expect(result.data.content).toContain('- 自定义：三');
    expect(result.data.content).not.toContain('0.226');
  });
});
