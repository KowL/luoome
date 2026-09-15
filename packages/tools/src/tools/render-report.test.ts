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
  it('list 引用用中文标签 + 保留 id，便于阅读与溯源', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await ctx.repos.report.upsertForPeriod({
      ...reportFixture(),
      id: 'report-plan-ref',
      // 必填 section 全 complete 时报告状态必须同步为 complete（Report 不变量）。
      status: 'complete',
      missingDimensions: [],
      sections: [
        {
          key: 'trading-plans',
          title: '交易计划',
          required: true,
          status: 'complete',
          blocks: [
            {
              kind: 'list',
              items: [
                {
                  title: '贵州茅台 · enter · v2',
                  detail: '入场 98-103 · 目标 8% · active',
                  entityKind: 'trading-plan',
                  entityId: 'account:acc-1:stock:600519.SH:v2',
                },
              ],
            },
          ],
          evidenceIds: [],
          missingDimensions: [],
        },
      ],
    });

    const result = await renderReportTool.execute(
      { reportId: 'report-plan-ref', format: 'markdown' },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.content).toContain(
      '- 贵州茅台 · enter · v2（交易计划:account:acc-1:stock:600519.SH:v2） — 入场 98-103 · 目标 8% · active',
    );
  });

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
