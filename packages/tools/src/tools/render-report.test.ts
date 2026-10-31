import {
  ADVICE_SEGMENTS,
  REPORT_FACTUAL_TABLE_NOTE,
  type Report,
  STANDARD_DISCLAIMERS,
  segmentLabel,
} from '@luoome/core';
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

// REQ-M3-08：报告是研究材料，正文不得出现行动词。两条渲染路径各守一遍——只守一条必漏。
describe('REQ-M3-08 行动词禁令', () => {
  const reportWithText = (text: string): Report => {
    const base = reportFixture();
    return {
      ...base,
      status: 'complete',
      missingDimensions: [],
      sections: base.sections.map((section) => ({
        ...section,
        status: 'complete' as const,
        missingDimensions: [],
        blocks: [{ kind: 'text' as const, text, tone: 'factual' as const }],
      })),
    };
  };

  /**
   * 存量违规行：写回路径（`assertReportInvariants`）现在会拒绝它，所以仓储里只可能存在
   * 守卫落地**之前**落库的行。渲染层必须自己再守一遍，否则这些行会原样渲染出去。
   */
  const ctxWithLegacyReport = async (report: Report) => {
    const ctx = await buildTestContext({ clock: () => now });
    return {
      ...ctx,
      repos: {
        ...ctx.repos,
        report: {
          ...ctx.repos.report,
          findById: async (id: string) => (id === report.id ? report : null),
        },
      },
    } as typeof ctx;
  };

  it('rejects forbidden action language on the markdown path and names the field', async () => {
    for (const word of ['买入', '卖出', '已建仓', '下单']) {
      const report = reportWithText(`今日计划：${word} 600519`);
      const ctx = await ctxWithLegacyReport(report);
      const result = await renderReportTool.execute(
        { reportId: report.id, format: 'markdown' },
        ctx,
      );
      expect(result.ok, word).toBe(false);
      if (result.ok) continue;
      expect(result.error.kind).toBe('invariant_violation');
      const message = 'message' in result.error ? result.error.message : '';
      expect(message).toContain(`含行动词「${word}」`);
      expect(message).toContain('sections[market-pulse].blocks[0].text');
    }
  });

  it('rejects forbidden action language on the notification path too', async () => {
    for (const word of ['买入', '卖出', '已建仓', '下单']) {
      const report = reportWithText(`盘前提示：${word} 600519`);
      const ctx = await ctxWithLegacyReport(report);
      const result = await renderReportTool.execute(
        { reportId: report.id, format: 'notification' },
        ctx,
      );
      expect(result.ok, word).toBe(false);
      if (result.ok) continue;
      expect(result.error.kind).toBe('invariant_violation');
      expect('message' in result.error ? result.error.message : '').toContain(
        `含行动词「${word}」`,
      );
    }
  });

  // 正文里没有行动词时三条格式都必须照常渲染（守卫不能误伤）。
  it('keeps rendering reports whose text has no action language', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    const report = reportWithText('今日以观察为主，等待量能确认。');
    await ctx.repos.report.upsertForPeriod(report);
    for (const format of ['markdown', 'plain-text', 'notification'] as const) {
      const result = await renderReportTool.execute({ reportId: report.id, format }, ctx);
      expect(result.ok, format).toBe(true);
    }
  });
});

// D：外部来源（advice）的自由文本在渲染时规范化；报告自撰文本命中则拒绝。两条不许混同。
describe('REQ-M3-08 交付物词面策略分层', () => {
  const layeredReport = (textOrigin?: 'advice'): Report => {
    const base = reportFixture();
    return {
      ...base,
      status: 'complete',
      missingDimensions: [],
      sections: [
        {
          key: 'market-pulse',
          title: '市场脉搏',
          required: true,
          status: 'complete',
          blocks: [
            {
              kind: 'list',
              items: [
                {
                  title: '测试标的',
                  detail: '反证：值得买入；风险：已建仓后卖出',
                  ...(textOrigin === undefined ? {} : { textOrigin }),
                },
              ],
            },
          ],
          evidenceIds: [],
          missingDimensions: [],
        },
        {
          key: 'strategy-actions',
          title: '策略行动',
          required: true,
          status: 'complete',
          blocks: [
            {
              kind: 'list',
              items: [
                {
                  title: '贵州茅台',
                  notificationSummary: '**考虑买入** · 已建仓后下单',
                  entityKind: 'advice' as const,
                  entityId: 'advice-1',
                  ...(textOrigin === undefined ? {} : { textOrigin }),
                },
              ],
            },
          ],
          evidenceIds: [],
          missingDimensions: [],
        },
      ],
    };
  };

  it('normalizes advice-origin list text on every render path', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    const report = layeredReport('advice');
    await ctx.repos.report.upsertForPeriod(report);
    for (const format of ['markdown', 'plain-text', 'notification'] as const) {
      const result = await renderReportTool.execute({ reportId: report.id, format }, ctx);
      expect(result.ok, format).toBe(true);
      if (!result.ok) continue;
      expect(result.data.content, format).not.toMatch(/买入|卖出|已建仓|下单/);
    }
  });

  it('rejects the same text when it is report-authored (no origin marker)', async () => {
    const report = layeredReport();
    const ctx = await buildTestContext({ clock: () => now });
    const stub = {
      ...ctx,
      repos: {
        ...ctx.repos,
        report: {
          ...ctx.repos.report,
          findById: async (id: string) => (id === report.id ? report : null),
        },
      },
    } as typeof ctx;
    const result = await renderReportTool.execute(
      { reportId: report.id, format: 'markdown' },
      stub,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invariant_violation');
    expect('message' in result.error ? result.error.message : '').toContain('items[0].detail');
  });
});

// REQ-M3-08 收窄：成交事实字段按字段键豁免，且说明句由内容派生。
describe('REQ-M3-08 成交事实边界', () => {
  const tradeReport = (withTrades: boolean): Report => {
    const base = reportFixture();
    return {
      ...base,
      status: 'complete',
      missingDimensions: [],
      sections: base.sections.map((section) => ({
        ...section,
        status: 'complete' as const,
        missingDimensions: [],
        blocks: withTrades
          ? [
              {
                kind: 'table' as const,
                columns: [
                  { key: 'side', label: '方向' },
                  { key: 'quantity', label: '数量' },
                ],
                rows: [{ side: '买入', quantity: 100 }],
              },
            ]
          : [{ kind: 'text' as const, text: '今日以观察为主。', tone: 'factual' as const }],
      })),
    };
  };

  it('renders the trade-side column and appends the factual note', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    const report = tradeReport(true);
    await ctx.repos.report.upsertForPeriod(report);
    const result = await renderReportTool.execute({ reportId: report.id, format: 'markdown' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.content).toContain('买入');
    expect(result.data.content).toContain(REPORT_FACTUAL_TABLE_NOTE);
  });

  it('omits the note when the report has no trade facts', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    const report = tradeReport(false);
    await ctx.repos.report.upsertForPeriod(report);
    const result = await renderReportTool.execute({ reportId: report.id, format: 'markdown' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.content).not.toContain(REPORT_FACTUAL_TABLE_NOTE);
  });
});

// ---------------------------------------------------------------------------
// U2 收口：通知摘要的兜底文案由 ADVICE_SEGMENTS 生成（段名同源，措辞自定）
// ---------------------------------------------------------------------------

describe('通知摘要的段名同源', () => {
  it('建议项缺 notificationSummary 时，兜底文案按 ADVICE_SEGMENTS 列出全部段标签', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    const report = reportFixture();
    report.sections.push({
      key: 'strategy-actions',
      title: '策略行动',
      required: false,
      status: 'complete',
      evidenceIds: [],
      missingDimensions: [],
      blocks: [
        {
          kind: 'list',
          items: [
            {
              title: '某只票',
              entityKind: 'advice' as const,
              entityId: 'advice-without-summary',
              // 关键：不给 notificationSummary → 走 `??` 兜底分支。
            },
          ],
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
    const content = result.data.content;
    // 每一段的**标签**都必须出现（顺序 = ADVICE_SEGMENTS），证明不是手写字符串。
    for (const segment of ADVICE_SEGMENTS) expect(content).toContain(segmentLabel(segment));
    // 措辞仍是通知侧自己的（「请在应用中核对」）。
    expect(content).toContain('请在应用中核对');
  });
});
