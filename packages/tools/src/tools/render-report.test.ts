import { type Report, STANDARD_DISCLAIMERS } from '@luoome/core';
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

  it('保留有效指标与零值，空指标合并说明且原始缺口仍可追溯', async () => {
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
    expect(result.data.content).toContain('未展示指标：指数样本');
    expect(result.data.content).not.toContain('指数样本：不可用');
    expect(result.data.content).toContain('market-pulse.indexes：index quotes unavailable');
    expect(result.data.content).toContain('- 自定义：三');
    expect(result.data.content).not.toContain('0.226');
  });
});

describe('手机报告摘要', () => {
  it('飞书排除账户与交易计划，保留策略摘要与北京时间，完整报告仍含账户事实', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    const report = reportFixture();
    report.sections.push(
      {
        key: 'account-performance',
        title: '账户表现',
        required: false,
        status: 'complete',
        evidenceIds: [],
        missingDimensions: [],
        blocks: [
          {
            kind: 'metrics',
            items: [
              { key: 'totalPnl', label: '账本总 PnL', value: 37823.40000000001 },
              { key: 'todayPnl', label: '今日估值变化', value: 10823 },
            ],
          },
        ],
      },
      {
        key: 'strategy-actions',
        title: '策略行动',
        required: false,
        status: 'complete',
        evidenceIds: [],
        missingDimensions: [],
        blocks: [
          {
            kind: 'list',
            items: Array.from({ length: 9 }, (_, i) => ({
              title: `测试股票${i}`,
              entityKind: 'advice' as const,
              entityId: `internal-advice-${i}`,
              detail:
                '观察 · LLM 推理不可用，基于规则的保守判断 · 反证：规则 fallback 不考虑基本面',
            })),
          },
        ],
      },
      {
        key: 'trading-plans',
        title: '交易计划',
        required: false,
        status: 'complete',
        evidenceIds: [],
        missingDimensions: [],
        blocks: [
          {
            kind: 'table',
            columns: [
              { key: 'account', label: '账户' },
              { key: 'stock', label: '股票' },
            ],
            rows: [{ account: 'manual-account-secret', stock: '华金资本', status: 'draft' }],
          },
        ],
      },
    );
    await ctx.repos.report.upsertForPeriod(report);
    const result = await renderReportTool.execute(
      { reportId: report.id, format: 'notification' },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const content = result.data.content;
    expect(content).not.toContain('37,823.4');
    expect(content).not.toContain('10,823');
    expect(content).not.toContain('账户表现');
    expect(content).toContain('9 条 AI 分析未完成');
    expect(content).not.toContain('草案未生效');
    expect(content).not.toContain('交易计划');
    expect(content).toContain('07/27 09:00');
    expect(content).toContain('指数行情不完整');
    expect(content).not.toMatch(
      /internal-advice|manual-account|00000000001|\| ---|T01:00|状态：partial|# 2026/,
    );
    expect(content).not.toContain('规则 fallback');
    expect(content.length).toBeLessThan(1600);
    for (const disclaimer of STANDARD_DISCLAIMERS)
      expect(content.split(disclaimer)).toHaveLength(2);
    const full = await renderReportTool.execute({ reportId: report.id, format: 'markdown' }, ctx);
    expect(full.ok && full.data.content).toContain('internal-advice-0');
    expect(full.ok && full.data.content).toContain('37,823.4');
    expect(full.ok && full.data.content).toContain('账户表现');
  });

  it('大量结果按完整段落省略，保留结尾风险声明与报告入口', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    const report = reportFixture();
    for (const key of [
      'market-week',
      'strategy-review',
      'signal-outcomes',
      'strategy-autonomy-actions',
      'upcoming-events',
      'next-events',
      'next-week-events',
      'alert-feedback',
      'alert-plans',
    ])
      report.sections.push({
        key,
        title: `板块${key}`,
        required: false,
        status: 'complete',
        evidenceIds: [],
        missingDimensions: [],
        blocks: [
          {
            kind: 'list',
            items: Array.from({ length: 20 }, () => ({
              title: '测试股票',
              detail: '长内容'.repeat(300),
            })),
          },
        ],
      });
    await ctx.repos.report.upsertForPeriod(report);
    const result = await renderReportTool.execute(
      { reportId: report.id, format: 'notification' },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.content.length).toBeLessThan(4200);
    expect(result.data.content).toContain('个板块，见完整报告');
    expect(result.data.content).toContain('完整报告与证据见 luoome');
    expect(result.data.content.endsWith(STANDARD_DISCLAIMERS.join(' '))).toBe(true);
  });
  it.each(['opening', 'closing', 'weekly'] as const)(
    '只因私有数据缺失的 %s 报告不在飞书显示账户告警',
    async (kind) => {
      const ctx = await buildTestContext({ clock: () => now });
      const report = reportFixture();
      report.kind = kind;
      report.sections = report.sections.map((section) => ({
        ...section,
        status: 'complete',
        missingDimensions: [],
      }));
      const privateKeys = [
        'overnight-portfolio',
        'account-performance',
        'account-week',
        'trade-attribution',
        'trading-plans',
        'advice-outcomes',
        'behavior-patterns',
        'data-quality',
        'advice-expiry',
        'future-account-section',
      ];
      report.sections.push(
        ...privateKeys.map((key) => ({
          key,
          title: `私有数据${key}`,
          required: true,
          status: 'unavailable' as const,
          blocks: [
            {
              kind: 'text' as const,
              tone: 'warning' as const,
              text: '秘密余额 123456789 / 个人交易记录',
            },
          ],
          evidenceIds: [],
          missingDimensions: [{ dimension: key, reason: '账户读取失败', retryable: true }],
        })),
      );
      report.missingDimensions = report.sections.flatMap((section) => section.missingDimensions);
      await ctx.repos.report.upsertForPeriod(report);
      const result = await renderReportTool.execute(
        { reportId: report.id, format: 'notification' },
        ctx,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.content).toContain('封板家数 58');
      expect(result.data.content).not.toMatch(
        /私有数据|123456789|个人交易|账户读取失败|部分数据不完整|待获取/,
      );
    },
  );
});
