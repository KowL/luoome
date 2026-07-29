import type { AShareSentimentManagerLike, AShareSentimentSnapshot } from '@luoome/core';
import { getReportTool, listWorkflowRunsTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { openingReportWorkflow } from './opening-report.js';

const generatedAt = new Date('2026-07-27T01:00:00.000Z');
const marketAsOf = new Date('2026-07-24T07:00:00.000Z');

const sentimentSnapshot = (): AShareSentimentSnapshot => ({
  date: '2026-07-24',
  coverage: 'CN_A_SHARES_SH_SZ',
  dataAsOf: marketAsOf,
  indexes: {
    status: 'complete',
    provenance: [
      {
        provider: 'fixture-index',
        observedAt: marketAsOf,
        fetchedAt: generatedAt,
        freshness: 'fresh',
      },
    ],
    warnings: [],
    values: [],
  },
  breadth: {
    status: 'unavailable',
    provenance: [
      {
        provider: 'fixture-market-snapshot',
        observedAt: generatedAt,
        fetchedAt: generatedAt,
        freshness: 'unavailable',
        errorKind: 'incomplete_coverage',
      },
    ],
    warnings: ['market snapshot completeness envelope is unavailable'],
  },
  limitUp: {
    status: 'complete',
    provenance: [
      {
        provider: 'fixture-limit-up',
        observedAt: marketAsOf,
        fetchedAt: generatedAt,
        freshness: 'fresh',
      },
    ],
    warnings: [],
    value: {
      sealedCount: 12,
      brokenCount: 3,
      brokenRate: 0.2,
      maxLadderLevel: 4,
      totalSealAmount: 800_000_000,
      boardDistribution: { '1': 8, '2': 2, '3': 1, '4': 1 },
      leaders: [],
    },
  },
  themes: {
    status: 'partial',
    provenance: [
      {
        provider: 'fixture-limit-up',
        observedAt: marketAsOf,
        fetchedAt: generatedAt,
        freshness: 'fresh',
      },
    ],
    warnings: ['concept themes unavailable'],
    value: { industries: [{ name: '半导体', count: 4 }], concepts: [] },
  },
});

describe('opening-report workflow', () => {
  it('周一使用上周五市场证据，幂等保存结构化报告并写入 partial 审计', async () => {
    const requestedDates: string[] = [];
    const manager: AShareSentimentManagerLike = {
      fetch: async (input) => {
        requestedDates.push(input.date);
        return { ok: true, data: sentimentSnapshot() };
      },
    };
    const ctx = await buildTestContext({
      clock: () => generatedAt,
      ashareSentiment: manager,
    });

    const first = await openingReportWorkflow.run({ date: '2026-07-27', notify: false }, ctx);

    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(requestedDates).toEqual(['2026-07-24']);
    expect(first.data).toMatchObject({
      created: true,
      notified: false,
      report: {
        kind: 'opening',
        periodStart: '2026-07-27',
        periodEnd: '2026-07-27',
        status: 'partial',
        dataAsOf: marketAsOf,
      },
    });
    expect(first.data.report.sections.map((section) => section.key)).toEqual([
      'market-pulse',
      'upcoming-events',
      'overnight-portfolio',
      'alert-plans',
      'watchlist-health',
      'research-follow-ups',
    ]);

    const stored = await getReportTool.execute({ id: first.data.report.id }, ctx);
    expect(stored).toMatchObject({
      ok: true,
      data: { report: { workflowRunId: first.data.workflowRunId } },
    });
    const audit = await listWorkflowRunsTool.execute(
      { workflowName: 'opening-report', includeWatch: false },
      ctx,
    );
    expect(audit).toMatchObject({
      ok: true,
      data: {
        runs: [
          {
            name: 'opening-report',
            status: 'partial',
            summary: { reportId: first.data.report.id, reportStatus: 'partial' },
          },
        ],
      },
    });

    const rerun = await openingReportWorkflow.run({ date: '2026-07-27', notify: false }, ctx);
    expect(rerun.ok).toBe(true);
    if (!rerun.ok) return;
    expect(rerun.data.created).toBe(false);
    expect(rerun.data.report.id).toBe(first.data.report.id);
  });

  it('scheduled 模式默认发送通知并把报告 deliveryStatus 更新为 sent', async () => {
    const manager: AShareSentimentManagerLike = {
      fetch: async () => ({ ok: true, data: sentimentSnapshot() }),
    };
    const ctx = await buildTestContext({
      clock: () => generatedAt,
      ashareSentiment: manager,
    });

    const result = await openingReportWorkflow.run({ date: '2026-07-27', mode: 'scheduled' }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.notified).toBe(true);
    expect(result.data.report.deliveryStatus).toBe('sent');
    const stored = await getReportTool.execute({ id: result.data.report.id }, ctx);
    expect(stored).toMatchObject({
      ok: true,
      data: { report: { deliveryStatus: 'sent' } },
    });
  });

  it('通知失败时保留报告并把 deliveryStatus 记为 failed', async () => {
    const manager: AShareSentimentManagerLike = {
      fetch: async () => ({ ok: true, data: sentimentSnapshot() }),
    };
    const base = await buildTestContext({
      clock: () => generatedAt,
      ashareSentiment: manager,
    });
    const ctx = {
      ...base,
      notification: {
        send: async (input: {
          channel: 'feishu' | 'log';
          payload: { title: string; content: string; level: string };
        }) => ({
          notification: {
            id: 'failed-report-notification',
            channel: input.channel,
            payload: input.payload,
            result: 'failed',
            errorMessage: 'fixture delivery failure',
            sentAt: generatedAt,
          },
        }),
      },
    };

    const result = await openingReportWorkflow.run({ date: '2026-07-27', mode: 'scheduled' }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.notified).toBe(false);
    expect(result.data.report.deliveryStatus).toBe('failed');
    const stored = await getReportTool.execute({ id: result.data.report.id }, ctx);
    expect(stored).toMatchObject({
      ok: true,
      data: { report: { deliveryStatus: 'failed' } },
    });
  });
});
