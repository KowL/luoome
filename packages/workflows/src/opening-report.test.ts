import {
  type AShareSentimentManagerLike,
  type AShareSentimentSnapshot,
  assembleLadder,
  type LimitUpLadderManagerLike,
  money,
  type Report,
  type ReportSection,
} from '@luoome/core';
import { getReportTool, listWorkflowRunsTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { marketPulse, openingReportWorkflow } from './opening-report.js';

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

/**
 * 市场级判断的 observedAt：metrics 块里 `key === 'observedAt'` 的那一项。
 * 结构断言靠它，不靠人眼看渲染文本。
 */
const marketObservedAtValue = (section: ReportSection): string | undefined => {
  for (const block of section.blocks) {
    if (block.kind !== 'metrics') continue;
    const item = block.items.find((entry) => entry.key === 'observedAt');
    if (item !== undefined && typeof item.value === 'string') return item.value;
  }
  return undefined;
};

/** REQ-M3-20 验收 2：报告渲染层不存在「无 observedAt 的市场级判断」。 */
const assertMarketJudgmentsCarryObservedAt = (report: Report): void => {
  const marketSections = report.sections.filter((section) => section.key === 'market-pulse');
  expect(marketSections.length).toBeGreaterThan(0);
  for (const section of marketSections) {
    // unavailable = 没有判断，只有缺口说明，不需要 observedAt。
    if (section.status === 'unavailable') continue;
    const value = marketObservedAtValue(section);
    expect(value).toBeDefined();
    const observedAt = new Date(value as string);
    expect(Number.isNaN(observedAt.getTime())).toBe(false);
    expect(section.dataAsOf).toBeInstanceOf(Date);
    expect(observedAt.getTime()).toBe(section.dataAsOf?.getTime());
  }
};

/** 市场脉搏里的 warning 文本块：盘前常态不该有，当日判断被降级时必须出现。 */
const marketWarningBlocks = (section: ReportSection) =>
  section.blocks.filter((block) => block.kind === 'text' && block.tone === 'warning');

const marketPulseSection = (report: Report): ReportSection => {
  const section = report.sections.find((entry) => entry.key === 'market-pulse');
  if (section === undefined) throw new Error('报告缺少 market-pulse 段');
  return section;
};

const marketObservedAtItem = (section: ReportSection) => {
  const metrics = section.blocks.find((block) => block.kind === 'metrics');
  return metrics?.kind === 'metrics'
    ? metrics.items.find((item) => item.key === 'observedAt')
    : undefined;
};

/** 天梯成功返回一份快照；`asOf` 与情绪快照的 `dataAsOf` 刻意可不同。 */
const ladderManagerWith = (asOf: Date): LimitUpLadderManagerLike => ({
  name: 'limit-up-ladder',
  sources: ['eastmoney'],
  status: () => [],
  fetchLadder: async () => ({
    ok: true,
    data: assembleLadder(
      '2026-07-24',
      'eastmoney',
      [
        {
          code: '600111',
          name: '测试医药',
          industry: '医药',
          ladderLevel: 6,
          uncategorized: false,
          firstTime: '09:30:00',
          finalTime: '09:30:00',
          reason: '--',
          price: 10,
          rawClose: 10,
          corrected: false,
          changePct: 0.1,
          limitUpDate: '2026-07-24',
          board: 'main_board',
        },
      ],
      [],
      asOf,
    ),
  }),
  compareLadder: async () => ({ ok: false }),
});

describe('opening-report workflow', () => {
  it('部分市场数据仍展示有效指数、涨跌样本和行业，并保留覆盖限制', () => {
    const snapshot = sentimentSnapshot();
    snapshot.indexes = {
      ...snapshot.indexes,
      status: 'partial',
      values: [
        {
          code: '000001',
          name: '上证指数',
          close: money(3600),
          change: 12,
          changePct: 0.33,
          ts: marketAsOf,
          source: 'fixture',
        },
      ],
    };
    snapshot.breadth = {
      ...snapshot.breadth,
      status: 'partial',
      value: { advancing: 3000, declining: 2000, unchanged: 50, total: 5050 },
    };
    const result = marketPulse(snapshot, generatedAt);
    expect(result.section.status).toBe('partial');
    const content = JSON.stringify(result.section.blocks);
    expect(content).toContain('上证指数 +0.33%');
    expect(content).toContain('上涨家数');
    expect(content).toContain('非全市场统计');
    expect(content).toContain('半导体 4 只');
    expect(content).toContain('当前来源未提供概念题材分类');
    expect(result.section.missingDimensions.map((gap) => gap.dimension)).toContain(
      'market-pulse.breadth',
    );
  });

  it('周一使用上周五市场证据，幂等保存结构化报告并写入 partial 审计', async () => {
    const requestedDates: string[] = [];
    const manager: AShareSentimentManagerLike = {
      status: () => [],
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

  it('单账户「当日收益率」取最后一个估值日的日收益，不因区间 TWR 样本不足而消失', async () => {
    // 收盘后生成：当日日线已收盘，最后一个估值日才有价格事实。
    const ctx = await buildTestContext({
      clock: () => new Date('2026-07-27T10:00:00.000Z'),
      ashareSentiment: {
        status: () => [],
        fetch: async () => ({ ok: true, data: sentimentSnapshot() }),
      },
    });
    const result = await openingReportWorkflow.run(
      {
        date: '2026-07-27',
        notify: false,
        scope: { kind: 'account', accountId: ctx.user.defaultAccountId },
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const section = result.data.report.sections.find((item) => item.key === 'overnight-portfolio');
    const metrics =
      section?.blocks.flatMap((block) => (block.kind === 'metrics' ? block.items : [])) ?? [];
    // REQ-M3-07 给区间 TWR 加了 20 个完整估值日的样本下限，单日报告只有 2 个估值日；
    // 这一行必须继续用「最后一个估值日的日收益」表达当日收益率，而不是整行消失。
    const twrRow = metrics.find((metric) => metric.key === 'twrPct');
    expect(twrRow).toBeDefined();
    expect(typeof twrRow?.value).toBe('number');
    // 未配置基准时不生成空占位。
    expect(metrics.some((metric) => metric.key === 'benchmarkTwrPct')).toBe(false);
  });

  it('scheduled 模式默认发送通知并把报告 deliveryStatus 更新为 sent', async () => {
    const manager: AShareSentimentManagerLike = {
      status: () => [],
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

  it('指数行情可用时展示指数列表，天梯缺原因时退到行业与首封时间', async () => {
    const snapshot = sentimentSnapshot();
    const manager: AShareSentimentManagerLike = {
      status: () => [],
      fetch: async () => ({ ok: true, data: snapshot }),
    };
    const ladderManager: LimitUpLadderManagerLike = {
      name: 'limit-up-ladder',
      sources: ['eastmoney'],
      status: () => [],
      fetchLadder: async () => ({
        ok: true,
        data: assembleLadder(
          '2026-07-24',
          'eastmoney',
          [
            {
              code: '600111',
              name: '测试医药',
              industry: '医药',
              ladderLevel: 6,
              uncategorized: false,
              firstTime: '09:30:00',
              finalTime: '09:30:00',
              reason: '--',
              price: 10,
              rawClose: 10,
              corrected: false,
              changePct: 0.1,
              limitUpDate: '2026-07-24',
              board: 'main_board',
            },
            {
              code: '000222',
              name: '测试科技',
              industry: 'unclassified',
              ladderLevel: 2,
              uncategorized: false,
              firstTime: null,
              finalTime: null,
              reason: '资产注入预期',
              price: 20,
              rawClose: 20,
              corrected: false,
              changePct: 0.1,
              limitUpDate: '2026-07-24',
              board: 'main_board',
            },
          ],
          [],
          marketAsOf,
        ),
      }),
      compareLadder: async () => ({ ok: false }),
    };
    const base = await buildTestContext({
      clock: () => generatedAt,
      ashareSentiment: manager,
      limitUpLadder: ladderManager,
    });
    // get_ashare_sentiment 用 market adapter 的实时指数覆盖 manager 的 indexes；
    // ts 必须落在 marketDate（2026-07-24，上海时区）否则 date_mismatch。
    // Object.create 保留 FakeMarketAdapter 原型方法，只覆盖 fetchIndexQuotes。
    const marketAdapter = Object.create(base.adapters.market, {
      fetchIndexQuotes: {
        value: async () => [
          {
            code: '000001',
            name: '上证指数',
            close: money(3500.5),
            change: 12.3,
            changePct: 0.35,
            ts: marketAsOf,
            source: 'fixture-index',
          },
        ],
      },
    }) as typeof base.adapters.market;
    const ctx = {
      ...base,
      adapters: { ...base.adapters, market: marketAdapter },
    };

    const result = await openingReportWorkflow.run({ date: '2026-07-27', notify: false }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const market = result.data.report.sections.find((section) => section.key === 'market-pulse');
    const lists = market?.blocks.filter((block) => block.kind === 'list');
    expect(lists).toContainEqual({
      kind: 'list',
      items: [{ title: '上证指数 +0.35%', detail: '收盘 3500.50' }],
    });
    expect(lists).toContainEqual({
      kind: 'list',
      items: [
        {
          title: '测试医药 · 6 连板',
          detail: '医药 · 首封 09:30:00',
          entityKind: 'stock',
          entityId: '600111.SH',
        },
        {
          title: '测试科技 · 2 连板',
          detail: '资产注入预期',
          entityKind: 'stock',
          entityId: '000222.SZ',
        },
      ],
    });
  });

  it.each(['failed', 'suppressed'] as const)(
    '通知 %s 时保留报告并记录真实投递状态',
    async (notificationResult) => {
      const manager: AShareSentimentManagerLike = {
        status: () => [],
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
              result: notificationResult,
              errorMessage: 'fixture delivery failure',
              sentAt: generatedAt,
            },
          }),
        },
      };

      const result = await openingReportWorkflow.run(
        { date: '2026-07-27', mode: 'scheduled' },
        ctx,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.notified).toBe(false);
      expect(result.data.report.deliveryStatus).toBe(
        notificationResult === 'failed' ? 'failed' : 'fallback-log',
      );
      const stored = await getReportTool.execute({ id: result.data.report.id }, ctx);
      expect(stored).toMatchObject({
        ok: true,
        data: {
          report: { deliveryStatus: notificationResult === 'failed' ? 'failed' : 'fallback-log' },
        },
      });
    },
  );

  // REQ-M3-20 验收 2：真实报告渲染输出里不存在「无 observedAt 的市场级判断」。
  it('renders every market-level judgment with observedAt', async () => {
    const ctx = await buildTestContext({
      clock: () => generatedAt,
      ashareSentiment: {
        status: () => [],
        fetch: async () => ({ ok: true, data: sentimentSnapshot() }),
      },
    });
    const result = await openingReportWorkflow.run({ date: '2026-07-27', notify: false }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    assertMarketJudgmentsCarryObservedAt(result.data.report);
    const market = result.data.report.sections.find((section) => section.key === 'market-pulse');
    expect(marketObservedAtValue(market as ReportSection)).toBe(marketAsOf.toISOString());
  });

  // 结构断言必须有牙：把 observedAt 摘掉后必须报错，否则它只是装饰。
  it('fails the structural assertion once observedAt is stripped from a market judgment', async () => {
    const ctx = await buildTestContext({
      clock: () => generatedAt,
      ashareSentiment: {
        status: () => [],
        fetch: async () => ({ ok: true, data: sentimentSnapshot() }),
      },
    });
    const result = await openingReportWorkflow.run({ date: '2026-07-27', notify: false }, ctx);
    if (!result.ok) throw new Error('report failed');
    const stripped: Report = {
      ...result.data.report,
      sections: result.data.report.sections.map((section) =>
        section.key !== 'market-pulse'
          ? section
          : {
              ...section,
              blocks: section.blocks.map((block) =>
                block.kind !== 'metrics'
                  ? block
                  : { ...block, items: block.items.filter((item) => item.key !== 'observedAt') },
              ),
            },
      ),
    };
    expect(() => assertMarketJudgmentsCarryObservedAt(stripped)).toThrow();
  });

  // REQ-M3-20 验收 4：当日 15:00 后引用当日观察 → 标为「历史观察」，不是删除。
  it('downgrades a post-close same-day market judgment to a historical observation without dropping it', () => {
    const snapshot = sentimentSnapshot();
    // 当日 16:00（+08:00）观测，当日 17:00 渲染。
    const observedAt = new Date('2026-07-24T08:00:00.000Z');
    snapshot.dataAsOf = observedAt;
    const result = marketPulse(snapshot, new Date('2026-07-24T09:00:00.000Z'));

    const metrics = result.section.blocks.find((block) => block.kind === 'metrics');
    const keys = metrics?.kind === 'metrics' ? metrics.items.map((item) => item.key) : [];
    // 降级不是丢弃：市场级数字与观测时点都还在。
    expect(keys).toEqual(
      expect.arrayContaining([
        'observedAt',
        'sealedCount',
        'brokenCount',
        'brokenRate',
        'maxLadderLevel',
      ]),
    );
    const observedItem =
      metrics?.kind === 'metrics'
        ? metrics.items.find((item) => item.key === 'observedAt')
        : undefined;
    expect(observedItem?.value).toBe(observedAt.toISOString());
    expect(observedItem?.displayValue).toContain('历史观察');
    expect(
      result.section.blocks.some(
        (block) =>
          block.kind === 'text' && block.tone === 'warning' && block.text.includes('历史观察'),
      ),
    ).toBe(true);
    // 判断本身仍在：封板家数没有被抹掉。
    expect(
      metrics?.kind === 'metrics'
        ? metrics.items.find((item) => item.key === 'sealedCount')?.value
        : undefined,
    ).toBe(12);
  });

  // 正例：当日盘中的观察是当前依据，不挂历史观察标注。
  it('keeps a same-day pre-close market judgment as current', () => {
    const snapshot = sentimentSnapshot();
    const observedAt = new Date('2026-07-24T02:00:00.000Z'); // 当日 10:00 +08:00
    snapshot.dataAsOf = observedAt;
    const result = marketPulse(snapshot, new Date('2026-07-24T06:00:00.000Z')); // 当日 14:00
    const metrics = result.section.blocks.find((block) => block.kind === 'metrics');
    const observedItem =
      metrics?.kind === 'metrics'
        ? metrics.items.find((item) => item.key === 'observedAt')
        : undefined;
    expect(observedItem?.displayValue).not.toContain('历史观察');
    expect(
      result.section.blocks.some(
        (block) => block.kind === 'text' && block.text.includes('历史观察'),
      ),
    ).toBe(false);
  });

  // REQ-M3-20 跟进验收 1：盘前简报的数据天然是上一交易日收盘——那是背景，不是告警。
  it('labels a pre-market prior-session snapshot as a prior-close observation without a warning', () => {
    // generatedAt = 今日 09:00；snapshot.dataAsOf = 上一交易日 15:00 收盘。
    const result = marketPulse(sentimentSnapshot(), generatedAt);
    const observedItem = marketObservedAtItem(result.section);
    expect(observedItem?.displayValue).toContain('上一交易日收盘观察');
    // 不是「被降级的当日判断」——两种 historical 的措辞不能混用。
    expect(observedItem?.displayValue).not.toContain('历史观察');
    expect(marketWarningBlocks(result.section)).toEqual([]);
    // 语义不弱化：仍写明是上一交易日、不得作为今日依据。
    const note = result.section.blocks.find(
      (block) =>
        block.kind === 'text' &&
        block.tone === 'factual' &&
        block.text.includes('上一交易日收盘观察'),
    );
    const noteText = note?.kind === 'text' ? note.text : '';
    expect(noteText).toContain('不得作为今日依据');
    expect(noteText).toContain(marketAsOf.toISOString());
  });

  // 真实盘前简报：整段市场脉搏不该出现 warning，否则每天常态告警就是噪音。
  it('renders a pre-market opening report with no market warning block', async () => {
    const ctx = await buildTestContext({
      clock: () => generatedAt,
      ashareSentiment: {
        status: () => [],
        fetch: async () => ({ ok: true, data: sentimentSnapshot() }),
      },
    });
    const result = await openingReportWorkflow.run({ date: '2026-07-27', notify: false }, ctx);
    if (!result.ok) throw new Error('report failed');
    const market = marketPulseSection(result.data.report);
    expect(marketObservedAtValue(market)).toBe(marketAsOf.toISOString());
    expect(marketWarningBlocks(market)).toEqual([]);
    expect(JSON.stringify(market.blocks)).toContain('上一交易日收盘观察');
    expect(JSON.stringify(market.blocks)).not.toContain('历史观察');
  });

  // 反向对照：同一天但复用当日 16:00 的观察时 warning 必须还在，否则上一条只是装饰。
  it('still warns when a same-day post-close observation is reused in a report', async () => {
    const snapshot = sentimentSnapshot();
    snapshot.dataAsOf = new Date('2026-07-27T08:00:00.000Z'); // 当日 16:00
    const ctx = await buildTestContext({
      clock: () => new Date('2026-07-27T09:00:00.000Z'), // 当日 17:00
      ashareSentiment: {
        status: () => [],
        fetch: async () => ({ ok: true, data: snapshot }),
      },
    });
    const result = await openingReportWorkflow.run({ date: '2026-07-27', notify: false }, ctx);
    if (!result.ok) throw new Error('report failed');
    const market = marketPulseSection(result.data.report);
    expect(marketWarningBlocks(market)).toHaveLength(1);
    expect(JSON.stringify(market.blocks)).toContain('历史观察');
    expect(JSON.stringify(market.blocks)).not.toContain('上一交易日收盘观察');
  });

  // 发现 (d) 修复：参照日是报告期，不是 now。补跑 3 天前的报告时标签仍对得上事实。
  it('labels the previous session relative to the report period, not to now', () => {
    const snapshot = sentimentSnapshot();
    snapshot.dataAsOf = new Date('2026-07-23T07:00:00.000Z'); // 报告期 07-24 的前一交易日 15:00
    // 参照日 = 报告期 07-24；now 是 3 天后的 07-27，若拿 now 当参照就会说成「5 天前的数据」。
    const result = marketPulse(snapshot, new Date('2026-07-24T04:00:00.000Z'));
    expect(marketObservedAtItem(result.section)?.displayValue).toContain('上一交易日收盘观察');
    expect(marketWarningBlocks(result.section)).toEqual([]);
  });

  // 第三档不是死代码：同一报告期下，5 个交易日前的数据必须仍是「历史观察」+ warning。
  it('keeps the historical warning when the data is older than the previous session', () => {
    const snapshot = sentimentSnapshot();
    snapshot.dataAsOf = new Date('2026-07-17T07:00:00.000Z'); // 报告期 07-24 的前 5 个交易日
    const result = marketPulse(snapshot, new Date('2026-07-24T04:00:00.000Z'));
    expect(marketObservedAtItem(result.section)?.displayValue).toContain('历史观察');
    expect(marketWarningBlocks(result.section)).toHaveLength(1);
    expect(JSON.stringify(result.section.blocks)).not.toContain('上一交易日收盘观察');
  });

  // 端到端补跑：报告期 = 3 天前，市场数据 = 该报告期的前一交易日 → 不告警。
  it('renders a backfilled opening report without a market warning', async () => {
    const snapshot = sentimentSnapshot();
    snapshot.date = '2026-07-23';
    snapshot.dataAsOf = new Date('2026-07-23T07:00:00.000Z');
    const ctx = await buildTestContext({
      clock: () => new Date('2026-07-27T01:00:00.000Z'), // now = 3 天后
      ashareSentiment: {
        status: () => [],
        fetch: async () => ({ ok: true, data: snapshot }),
      },
    });
    const result = await openingReportWorkflow.run({ date: '2026-07-24', notify: false }, ctx);
    if (!result.ok) throw new Error('report failed');
    const market = marketPulseSection(result.data.report);
    expect(marketWarningBlocks(market)).toEqual([]);
    expect(marketObservedAtValue(market)).toBe('2026-07-23T07:00:00.000Z');
    expect(JSON.stringify(market.blocks)).toContain('上一交易日收盘观察');
    expect(JSON.stringify(market.blocks)).not.toContain('历史观察');
  });

  // 发现 (b) 修复：段级 dataAsOf 属于市场级判断本身，天梯快照时间不被混进来。
  it('keeps the section dataAsOf on the market judgment and exposes the ladder time separately', async () => {
    const ladderAsOf = new Date('2026-07-24T07:05:00.000Z'); // 15:05，与情绪快照不同时点
    const ladderManager = ladderManagerWith(ladderAsOf);
    const ctx = await buildTestContext({
      clock: () => generatedAt,
      ashareSentiment: {
        status: () => [],
        fetch: async () => ({ ok: true, data: sentimentSnapshot() }),
      },
      limitUpLadder: ladderManager,
    });
    const result = await openingReportWorkflow.run({ date: '2026-07-27', notify: false }, ctx);
    if (!result.ok) throw new Error('report failed');
    const market = marketPulseSection(result.data.report);
    // 段级 dataAsOf = 市场级判断的观测时点，不是天梯时间。
    expect(market.dataAsOf?.toISOString()).toBe(marketAsOf.toISOString());
    expect(market.dataAsOf?.toISOString()).not.toBe(ladderAsOf.toISOString());
    expect(marketObservedAtValue(market)).toBe(marketAsOf.toISOString());
    // 天梯时间没丢：作为它自己的事实可见。
    const metrics = market.blocks.find((block) => block.kind === 'metrics');
    const ladderItem =
      metrics?.kind === 'metrics'
        ? metrics.items.find((item) => item.key === 'ladderAsOf')
        : undefined;
    expect(ladderItem?.label).toBe('天梯快照时间');
    expect(ladderItem?.value).toBe(ladderAsOf.toISOString());
    // 结构断言在生产形态（天梯时间 ≠ 情绪时间）下成立，而不是靠 fixture 凑巧对齐。
    assertMarketJudgmentsCarryObservedAt(result.data.report);
  });

  // 缺陷：情绪源失败 + 天梯有缓存时，unavailable 段曾被塞进 list 块 → save_report 抛 InvariantError。
  it('keeps an unavailable market section warning-only when the ladder still has data', async () => {
    const ladderAsOf = new Date('2026-07-24T07:05:00.000Z');
    const ctx = await buildTestContext({
      clock: () => generatedAt,
      ashareSentiment: {
        status: () => [],
        fetch: async () => ({
          ok: false,
          error: { kind: 'adapter_error', message: '情绪源超时', recoverable: true },
        }),
      },
      limitUpLadder: ladderManagerWith(ladderAsOf),
    });
    const result = await openingReportWorkflow.run({ date: '2026-07-27', notify: false }, ctx);
    // 报告能保存：runner 会走 save_report → assertReportInvariants，抛错这里就红了。
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const market = marketPulseSection(result.data.report);
    expect(market.status).toBe('unavailable');
    // 比「不含 list」更强：整段只允许 warning 文本块。
    expect(market.blocks.every((block) => block.kind === 'text' && block.tone === 'warning')).toBe(
      true,
    );
    expect(market.blocks.some((block) => block.kind === 'list')).toBe(false);
    expect(market.blocks.some((block) => block.kind === 'metrics')).toBe(false);
    // 天梯的存在不被静默吞掉：说明省略原因、单独查询入口与快照时间。
    const text = JSON.stringify(market.blocks);
    expect(text).toContain('市场情绪源不可用');
    expect(text).toContain('limit_up_ladder');
    expect(text).toContain(ladderAsOf.toISOString());
    // 不可用说明里不许出现行动词。
    expect(text).not.toMatch(/买入|卖出|已建仓|下单/);
  });
});

// U7（task-25）：交易日历只有 core 一份实现，workflow 侧是对它的薄包装。
import { previousTradingDate as corePreviousTradingDate } from '@luoome/core';

import { previousTradingDay, shanghaiDate } from './opening-report.js';

describe('U7 上一交易日：workflow 薄包装与 core 唯一事实源一致', () => {
  const cases = [
    '2026-07-27', // 周一 → 上个周五
    '2026-07-28',
    '2026-10-09', // 国庆后首个交易日
    '2026-10-12', // 周一
    '2026-01-05', // 跨年
    '2026-06-22',
  ];

  it('同一输入两侧结果相同（core previousTradingDate vs workflow previousTradingDay）', () => {
    for (const date of cases)
      expect(previousTradingDay(date), date).toBe(corePreviousTradingDate(shanghaiDate(date)));
  });

  it('结果是合法的前一交易日：早于输入、且本身是交易日', () => {
    for (const date of cases) {
      const previous = previousTradingDay(date);
      expect(previous < date, date).toBe(true);
      expect(previousTradingDay(previous) < previous, date).toBe(true);
    }
  });
});
