import {
  type AShareSentimentSnapshot,
  dateInShanghai,
  isHoliday,
  isWeekend,
  MARKET_OBSERVATION_HISTORICAL_LABEL,
  MARKET_OBSERVATION_PRIOR_SESSION_LABEL,
  marketObservationLabel,
  marketObservationScope,
  previousTradingDate,
  type ReportEvidence,
  type ReportMissingDimension,
  ReportSchema,
  type AccountReportScope as ReportScope,
  AccountReportScopeSchema as ReportScopeSchema,
  type ReportSection,
  type ToolResult,
} from '@luoome/core';
import { z } from 'zod';

import { defineWorkflow, type WorkflowContext } from './define-workflow.js';
import { executeReportWorkflow } from './internal/report-runner.js';

export const OpeningReportInput = z.object({
  date: z.string().date().optional(),
  scope: ReportScopeSchema.default({ kind: 'all-accounts' }),
  notify: z.boolean().optional(),
  mode: z.enum(['manual', 'scheduled']).default('manual'),
});

export const OpeningReportOutput = z.object({
  report: ReportSchema,
  created: z.boolean(),
  workflowRunId: z.string(),
  notified: z.boolean(),
});

type OpeningInput = z.output<typeof OpeningReportInput>;
type OpeningOutput = z.output<typeof OpeningReportOutput>;

export const DAY_MS = 86_400_000;

export const shanghaiDate = (date: string): Date => new Date(`${date}T12:00:00+08:00`);

/**
 * 上一 A 股交易日的**薄包装**（U7）：日历逻辑只有 core `previousTradingDate` 一份。
 *
 * 这里只是把入参从日期字符串转成 `shanghaiDate` 锚点、再把结果转回字符串，
 * 不再自带 `isWeekend/isHoliday` 循环——第二份日历实现曾经让「节假日表更新时要改两处」。
 */
export const previousTradingDay = (date: string): string => previousTradingDate(shanghaiDate(date));

export const localEvidence = (
  id: string,
  dimension: string,
  now: Date,
  provider: string,
): ReportEvidence => ({
  id,
  dimension,
  provenance: {
    provider,
    observedAt: now,
    fetchedAt: now,
    freshness: 'unknown',
  },
});

export const missing = (
  dimension: string,
  reason: string,
  errorKind?: string,
): ReportMissingDimension => ({
  dimension,
  reason: reason.slice(0, 500),
  ...(errorKind === undefined ? {} : { errorKind }),
  retryable: errorKind !== 'not_implemented',
});

/**
 * 市场脉搏：报告里唯一的市场级判断。
 *
 * 每个市场级判断必须带 `observedAt`（REQ-M3-20）——数字本身没有时点就没有意义。
 * `reference` 是判定口径所依据的日期，取**报告期**（实时路径下与 now 同日）。
 * 标注分三档，但都不删除观察本身（读者仍能看到它，只是不能当今日依据）：
 * - 报告期当日盘中观察 → 当前依据；
 * - 报告期的上一交易日收盘 → 「上一交易日收盘观察」+ factual，盘前简报本来就只有这份数据；
 * - 其余（更早或未来）→ 「历史观察」+ warning，被降级的判断必须显眼。
 */
export const marketPulse = (
  snapshot: AShareSentimentSnapshot,
  reference: Date,
): { section: ReportSection; evidence: ReportEvidence[] } => {
  const dimensions = [
    ['indexes', snapshot.indexes],
    ['breadth', snapshot.breadth],
    ['limit-up', snapshot.limitUp],
    ['themes', snapshot.themes],
  ] as const;
  const evidence = dimensions.flatMap(([dimension, value]) =>
    value.provenance.map((provenance, index) => ({
      id: `market-pulse:${dimension}:${index}`,
      dimension: `market-pulse.${dimension}`,
      provenance,
    })),
  );
  const missingDimensions = dimensions.flatMap(([dimension, value]) =>
    value.status === 'complete'
      ? []
      : [
          missing(
            `market-pulse.${dimension}`,
            value.warnings.join('; ') || `${dimension} unavailable`,
            value.provenance.find((item) => item.errorKind !== undefined)?.errorKind,
          ),
        ],
  );
  const statuses = dimensions.map(([, value]) => value.status);
  const status = statuses.every((value) => value === 'complete')
    ? ('complete' as const)
    : statuses.every((value) => value === 'unavailable')
      ? ('unavailable' as const)
      : ('partial' as const);
  if (status === 'unavailable') {
    return {
      evidence,
      section: {
        key: 'market-pulse',
        title: '市场脉搏',
        required: true,
        status,
        blocks: [{ kind: 'text', tone: 'warning', text: '市场情绪证据不可用' }],
        evidenceIds: evidence.map((item) => item.id),
        missingDimensions,
      },
    };
  }
  const value = snapshot.limitUp.value;
  const indexQuotes = snapshot.indexes.values ?? [];
  const breadth = snapshot.breadth.value;
  const themes = snapshot.themes.value;
  // 三档口径全部来自 core（`marketObservationScope`）：报告期当日 / 报告期的上一交易日 / 更早或未来。
  // 盘前简报常态复用上一交易日收盘，那是背景；只有第三档才是被降级的判断、必须告警。
  const scope = marketObservationScope(snapshot.dataAsOf, reference);
  const priorSession = scope === 'prior-session';
  const downgraded = scope === 'historical';
  return {
    evidence,
    section: {
      key: 'market-pulse',
      title: '市场脉搏',
      required: true,
      status,
      dataAsOf: snapshot.dataAsOf,
      blocks: [
        {
          kind: 'metrics',
          items: [
            // 观测时点排第一：下面每个数字都只在这一点上成立。
            {
              key: 'observedAt',
              label: '市场观测时间',
              value: snapshot.dataAsOf.toISOString(),
              displayValue: marketObservationLabel(snapshot.dataAsOf, reference),
            },
            { key: 'sealedCount', label: '封板家数', value: value?.sealedCount ?? null },
            { key: 'brokenCount', label: '炸板家数', value: value?.brokenCount ?? null },
            {
              key: 'brokenRate',
              label: '炸板率',
              value: value?.brokenRate ?? null,
              unit: 'ratio',
            },
            {
              key: 'maxLadderLevel',
              label: '最高连板',
              value: value?.maxLadderLevel ?? null,
            },
            ...(breadth === undefined
              ? []
              : [
                  { key: 'advancing', label: '上涨家数', value: breadth.advancing },
                  { key: 'declining', label: '下跌家数', value: breadth.declining },
                  { key: 'unchanged', label: '平盘家数', value: breadth.unchanged },
                ]),
          ],
        },
        ...(priorSession
          ? [
              {
                kind: 'text' as const,
                tone: 'factual' as const,
                text:
                  `${MARKET_OBSERVATION_PRIOR_SESSION_LABEL}：本节市场级数据观测于 ` +
                  `${snapshot.dataAsOf.toISOString()}，是上一交易日收盘时的市场状态；` +
                  '盘前只能作为背景参照，不得作为今日依据进入建议链。',
              },
            ]
          : []),
        ...(downgraded
          ? [
              {
                kind: 'text' as const,
                tone: 'warning' as const,
                text:
                  `${MARKET_OBSERVATION_HISTORICAL_LABEL}：本节市场级判断观测于 ` +
                  `${snapshot.dataAsOf.toISOString()}，不属于当日盘中观察；` +
                  '只能作为历史对照，不得作为当前依据进入建议链。',
              },
            ]
          : []),
        ...(breadth === undefined
          ? []
          : [
              {
                kind: 'text' as const,
                text: `涨跌统计覆盖 ${breadth.total} 只股票${snapshot.breadth.status === 'partial' ? '，仅代表已取得有效涨跌幅的样本，非全市场统计' : ''}。`,
                tone: 'factual' as const,
              },
            ]),
        ...(themes === undefined || themes.industries.length === 0
          ? []
          : [
              {
                kind: 'text' as const,
                text: `涨停/炸板样本行业：${themes.industries
                  .slice(0, 5)
                  .map((item) => `${item.name} ${item.count} 只`)
                  .join(
                    '、',
                  )}。${themes.concepts.length === 0 ? '当前来源未提供概念题材分类。' : ''}`,
                tone: 'factual' as const,
              },
            ]),
        ...(indexQuotes.length === 0
          ? []
          : [
              {
                kind: 'list' as const,
                items: indexQuotes.map((quote) => ({
                  title: `${quote.name} ${quote.changePct >= 0 ? '+' : ''}${quote.changePct.toFixed(2)}%`,
                  detail: `收盘 ${Number(quote.close).toFixed(2)}`,
                })),
              },
            ]),
      ],
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions,
    },
  };
};

const ladderStockId = (code: string): string =>
  `${code}.${code.startsWith('6') ? 'SH' : code.startsWith('8') || code.startsWith('4') ? 'BJ' : 'SZ'}`;

const attachLadderFacts = async (
  base: { section: ReportSection; evidence: ReportEvidence[] },
  date: string,
  now: Date,
  ctx: WorkflowContext,
): Promise<{ section: ReportSection; evidence: ReportEvidence[] }> => {
  const result = await ctx.tools.limit_up_ladder.execute({ date, days: 15 });
  const evidence = localEvidence(
    'market-pulse:limit-up-ladder',
    'market-pulse.limit-up-ladder',
    now,
    'limit-up-ladder',
  );
  if (!result.ok) {
    return {
      evidence: [...base.evidence, evidence],
      section: {
        ...base.section,
        status: base.section.status === 'complete' ? 'partial' : base.section.status,
        evidenceIds: [...base.section.evidenceIds, evidence.id],
        missingDimensions: [
          ...base.section.missingDimensions,
          missing(
            'market-pulse.limit-up-ladder',
            'message' in result.error ? result.error.message : result.error.kind,
            result.error.kind,
          ),
        ],
      },
    };
  }
  if (base.section.status === 'unavailable') {
    // 不可用段只允许 warning 文本块（assertReportInvariants）。缓存的天梯事实不能混进
    // 「市场判断不可用」的结论里，但也不能静默吞掉它——说明省略原因、单独查询入口与快照时间。
    return {
      evidence: [...base.evidence, evidence],
      section: {
        ...base.section,
        blocks: [
          ...base.section.blocks,
          {
            kind: 'text' as const,
            tone: 'warning' as const,
            text:
              '市场情绪源不可用；本节不展示涨停天梯快照（避免把缓存事实混入不可用判断），' +
              `天梯数据可用 limit_up_ladder 单独查询（快照时间 ${result.data.asOf.toISOString()}）。`,
          },
        ],
        evidenceIds: [...base.section.evidenceIds, evidence.id],
      },
    };
  }
  const entries = result.data.levels
    .flatMap((level) => level.stocks.map((stock) => ({ level: level.level, stock })))
    .slice(0, 20);
  const list = {
    kind: 'list' as const,
    items: entries.map(({ level, stock }) => {
      // eastmoney 涨停池无涨停原因字段；缺省时退到行业与首封时间，不展示占位符
      const detail = [
        stock.reason === '--' ? undefined : stock.reason,
        stock.industry === 'unclassified' ? undefined : stock.industry,
        stock.firstTime === null ? undefined : `首封 ${stock.firstTime}`,
      ]
        .filter((part): part is string => part !== undefined)
        .join(' · ');
      return {
        title: `${stock.name} · ${level} 连板`,
        ...(detail.length === 0 ? {} : { detail }),
        entityKind: 'stock' as const,
        entityId: ladderStockId(stock.code),
      };
    }),
  };
  return {
    evidence: [...base.evidence, evidence],
    section: {
      ...base.section,
      // 段级 `dataAsOf` 属于市场级判断本身（sentiment 的观测时点），不被天梯快照时间覆盖：
      // 天梯是独立事实，用自己的 metrics item 带时点，否则段级时点在描述一个不描述它指标的时间。
      blocks: [
        ...base.section.blocks.map((block) =>
          block.kind === 'metrics' && block.items.some((entry) => entry.key === 'observedAt')
            ? {
                ...block,
                items: [
                  ...block.items,
                  {
                    key: 'ladderAsOf',
                    label: '天梯快照时间',
                    value: result.data.asOf.toISOString(),
                  },
                ],
              }
            : block,
        ),
        list,
      ],
      evidenceIds: [...base.section.evidenceIds, evidence.id],
    },
  };
};

const eventsSection = async (
  date: string,
  now: Date,
  ctx: WorkflowContext,
): Promise<{ section: ReportSection; evidence: ReportEvidence[] }> => {
  const from = new Date(`${date}T00:00:00+08:00`);
  const to = new Date(from.getTime() + 8 * DAY_MS - 1);
  const result = await ctx.tools.list_stock_events.execute({
    from,
    to,
    status: 'scheduled',
    importance: 'important',
    limit: 500,
  });
  if (!result.ok) {
    return unavailableSection(
      'upcoming-events',
      '未来重要事件',
      true,
      now,
      'stock-events',
      result.error.kind,
    );
  }
  const evidence = [
    localEvidence('upcoming-events:0', 'upcoming-events', now, 'local/stock-events'),
  ];
  const stale = result.data.events.filter((event) => event.stale);
  return {
    evidence,
    section: {
      key: 'upcoming-events',
      title: '未来重要事件',
      required: true,
      status: stale.length === 0 ? 'complete' : 'partial',
      dataAsOf: now,
      blocks: [
        {
          kind: 'list',
          items: result.data.events.map((event) => ({
            title: event.title,
            detail: `${event.stockId} · ${dateInShanghai(event.occursAt)}`,
            entityKind: 'stock-event' as const,
            entityId: event.id,
          })),
        },
      ],
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions:
        stale.length === 0
          ? []
          : [missing('upcoming-events.freshness', `${stale.length} 条事件已标记 stale`, 'stale')],
    },
  };
};

export const portfolioSection = async (
  scope: ReportScope,
  now: Date,
  ctx: WorkflowContext,
  asOfDate?: string,
  performanceRange?: { readonly fromDate: string; readonly toDate: string },
): Promise<{ section: ReportSection; evidence: ReportEvidence[] }> => {
  const accountIds: string[] = [];
  if (scope.kind === 'account') {
    accountIds.push(scope.accountId);
  } else {
    const accounts = await ctx.tools.list_accounts.execute({});
    if (!accounts.ok) {
      return unavailableSection(
        'overnight-portfolio',
        '隔夜持仓',
        true,
        now,
        'accounts',
        accounts.error.kind,
      );
    }
    accountIds.push(...accounts.data.accounts.map((account) => account.id));
  }
  const results = await Promise.all(
    accountIds.map((accountId) => ctx.tools.list_holdings.execute({ accountId })),
  );
  const performanceDate = asOfDate ?? dateInShanghai(now);
  const performanceFrom = performanceRange?.fromDate ?? previousTradingDay(performanceDate);
  const performanceTo = performanceRange?.toDate ?? performanceDate;
  const performanceResults = await Promise.all(
    accountIds.map((accountId) =>
      ctx.tools.get_account_performance.execute({
        accountId,
        from: new Date(`${performanceFrom}T00:00:00.000Z`),
        to: new Date(`${performanceTo}T00:00:00.000Z`),
      }),
    ),
  );
  const successful = results.filter((result) => result.ok);
  if (successful.length === 0 && results.length > 0) {
    return unavailableSection(
      'overnight-portfolio',
      '隔夜持仓',
      true,
      now,
      'holdings',
      'read_failed',
    );
  }
  const values = successful.flatMap((result) => (result.ok ? [result.data] : []));
  const successfulPerformance = performanceResults.filter((result) => result.ok);
  const performanceValues = successfulPerformance.flatMap((result) =>
    result.ok ? [result.data] : [],
  );
  const failedPerformanceAccounts = performanceResults.length - successfulPerformance.length;
  const incompletePerformance = performanceValues.some(
    (value) => value.completeness !== 'complete',
  );
  const ranged = performanceRange !== undefined;
  const periodStartValues = performanceValues.map((value) => value.valuation.at(0)?.totalValue);
  const periodEndValues = performanceValues.map((value) => value.valuation.at(-1)?.totalValue);
  const allPeriodValuesAvailable = (values: readonly (number | undefined)[]): values is number[] =>
    values.length > 0 &&
    values.length === accountIds.length &&
    values.every((value) => value !== undefined);
  const periodStartValue = allPeriodValuesAvailable(periodStartValues)
    ? periodStartValues.reduce((total, value) => total + value, 0)
    : null;
  const periodEndValue = allPeriodValuesAvailable(periodEndValues)
    ? periodEndValues.reduce((total, value) => total + value, 0)
    : null;
  const periodValueChange =
    periodStartValue === null || periodEndValue === null ? null : periodEndValue - periodStartValue;
  // 「当日收益率」取最后一个估值日的日收益事实，不取区间 TWR：区间 TWR 有 20 个完整
  // 估值日的样本下限（REQ-M3-07），单日报告只取 1 个交易日，用 twrPct 会让这一行永远缺席。
  const periodTwrValues = performanceValues.map((value) => value.valuation.at(-1)?.twrReturnPct);
  const periodTwrPct = accountIds.length === 1 ? (periodTwrValues[0] ?? null) : null;
  const drawdownValues = performanceValues.map((value) => value.maxDrawdownPct);
  const maxDrawdownPct = accountIds.length === 1 ? (drawdownValues[0] ?? null) : null;
  const benchmarkTwrPct =
    accountIds.length === 1 ? performanceValues[0]?.benchmarkTwrPct : undefined;
  const evidence = [
    localEvidence('overnight-portfolio:0', 'overnight-portfolio', now, 'local/holdings'),
    localEvidence(
      'overnight-portfolio:performance',
      'overnight-portfolio.performance',
      now,
      'tool/get_account_performance',
    ),
  ];
  const missingTodayPnl = ranged ? false : values.some((value) => value.totalTodayPnl === null);
  const failedAccounts = results.length - successful.length;
  const isPartial =
    missingTodayPnl || failedAccounts > 0 || failedPerformanceAccounts > 0 || incompletePerformance;
  const missingDimensions = [
    ...(missingTodayPnl
      ? [missing('overnight-portfolio.previous-close', '部分持仓缺少可靠昨收', 'no_data')]
      : []),
    ...(failedAccounts > 0
      ? [missing('overnight-portfolio.accounts', `${failedAccounts} 个账户读取失败`, 'read_failed')]
      : []),
    ...(failedPerformanceAccounts > 0
      ? [
          missing(
            'overnight-portfolio.performance',
            `${failedPerformanceAccounts} 个账户绩效读取失败`,
            'read_failed',
          ),
        ]
      : []),
    ...(incompletePerformance
      ? [
          missing(
            'overnight-portfolio.valuation',
            '部分估值日缺少行情，相关收益指标未展示；请补齐对应交易日日线后重新生成报告',
            'no_data',
          ),
        ]
      : []),
  ];
  return {
    evidence,
    section: {
      key: 'overnight-portfolio',
      title: '隔夜持仓',
      required: true,
      status: isPartial ? 'partial' : 'complete',
      dataAsOf: now,
      blocks: [
        {
          kind: 'metrics',
          items: [
            { key: 'accountCount', label: '账户数', value: accountIds.length },
            {
              key: 'holdingCount',
              label: '持仓数',
              value: values.reduce((total, value) => total + value.holdings.length, 0),
            },
            {
              key: 'totalValue',
              label: ranged ? '期末估值' : '当前估值',
              value: ranged
                ? periodEndValue
                : values.reduce((total, value) => total + Number(value.totalValue), 0),
            },
            ...(ranged
              ? [
                  { key: 'periodStartValue', label: '期初估值', value: periodStartValue },
                  { key: 'periodTwrPct', label: '区间收益率', value: periodTwrPct, unit: '%' },
                  {
                    key: 'maxDrawdownPct',
                    label: '区间最大回撤',
                    value: maxDrawdownPct,
                    unit: '%',
                  },
                ]
              : []),
            {
              key: 'todayPnl',
              label: ranged ? '区间估值变化' : '今日估值变化',
              value: ranged
                ? periodValueChange
                : missingTodayPnl
                  ? null
                  : values.reduce((total, value) => total + Number(value.totalTodayPnl), 0),
            },
            {
              key: 'totalPnl',
              label: '账本累计盈亏',
              value:
                performanceValues.length !== accountIds.length ||
                performanceValues.length === 0 ||
                performanceValues.some((value) => value.totalPnl === undefined)
                  ? null
                  : performanceValues.reduce((total, value) => total + Number(value.totalPnl), 0),
            },
            ...(!ranged && periodTwrPct !== null
              ? [
                  {
                    key: 'twrPct',
                    label: '当日收益率',
                    value: periodTwrPct,
                    unit: '%',
                  },
                ]
              : []),
            ...(benchmarkTwrPct === undefined
              ? []
              : [
                  {
                    key: 'benchmarkTwrPct',
                    label: ranged ? '区间基准收益率' : '当日基准收益率',
                    value: benchmarkTwrPct,
                    unit: '%',
                  },
                ]),
          ],
        },
      ],
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions,
    },
  };
};

const alertPlansSection = async (
  now: Date,
  ctx: WorkflowContext,
): Promise<{ section: ReportSection; evidence: ReportEvidence[] }> => {
  const result = await ctx.tools.list_alert_plans.execute({ enabledOnly: true });
  if (!result.ok) {
    return unavailableSection(
      'alert-plans',
      'AlertPlan',
      true,
      now,
      'alert-plans',
      result.error.kind,
    );
  }
  const evidence = [localEvidence('alert-plans:0', 'alert-plans', now, 'local/alert-plans')];
  return {
    evidence,
    section: {
      key: 'alert-plans',
      title: 'AlertPlan',
      required: true,
      status: 'complete',
      dataAsOf: now,
      blocks: [
        {
          kind: 'list',
          items: result.data.plans.map((plan) => ({
            title: plan.name,
            detail: `${plan.enabled ? 'enabled' : 'disabled'} · ${plan.rules.length} rules`,
            entityKind: 'alert-plan' as const,
            entityId: plan.id,
          })),
        },
      ],
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions: [],
    },
  };
};

const watchlistsSection = async (
  now: Date,
  ctx: WorkflowContext,
): Promise<{ section: ReportSection; evidence: ReportEvidence[] }> => {
  const result = await ctx.tools.list_watchlists.execute({ enabledOnly: true });
  if (!result.ok) {
    return unavailableSection(
      'watchlist-health',
      'Watchlist 健康',
      true,
      now,
      'watchlists',
      result.error.kind,
    );
  }
  const evidence = [
    localEvidence('watchlist-health:0', 'watchlist-health', now, 'local/watchlists'),
  ];
  return {
    evidence,
    section: {
      key: 'watchlist-health',
      title: 'Watchlist 健康',
      required: true,
      status: 'complete',
      dataAsOf: now,
      blocks: [
        {
          kind: 'list',
          items: result.data.items.map(({ watchlist, memberCount, sourceHealth }) => ({
            title: watchlist.name,
            detail: `${watchlist.kind} · ${memberCount} members · ${sourceHealth.stale} stale`,
            entityKind: 'watchlist' as const,
            entityId: watchlist.id,
          })),
        },
      ],
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions: [],
    },
  };
};

export const unavailableSection = (
  key: string,
  title: string,
  required: boolean,
  now: Date,
  dimension: string,
  errorKind: string,
): { section: ReportSection; evidence: ReportEvidence[] } => {
  const evidence = [
    {
      id: `${key}:0`,
      dimension,
      provenance: {
        provider: `local/${dimension}`,
        observedAt: now,
        fetchedAt: now,
        freshness: 'unavailable' as const,
        errorKind,
      },
    },
  ];
  return {
    evidence,
    section: {
      key,
      title,
      required,
      status: 'unavailable',
      blocks: [{ kind: 'text', text: `${title}不可用`, tone: 'warning' }],
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions: [missing(dimension, `${title}不可用`, errorKind)],
    },
  };
};

const researchSection = (now: Date): { section: ReportSection; evidence: ReportEvidence[] } =>
  unavailableSection(
    'research-follow-ups',
    '研究跟进',
    false,
    now,
    'research-follow-ups.global-query',
    'not_implemented',
  );

const runOpeningReport = async (
  input: OpeningInput,
  ctx: WorkflowContext,
): Promise<OpeningOutput | ToolResult<never>> => {
  const date = input.date ?? dateInShanghai(ctx.clock());
  const requested = shanghaiDate(date);
  if (isWeekend(requested) || isHoliday(requested)) {
    return {
      ok: false,
      error: { kind: 'invalid_input', message: `${date} 不是 A 股交易日`, issues: [] },
    };
  }
  const marketDate = previousTradingDay(date);
  const result = await executeReportWorkflow(
    {
      workflowName: 'opening-report',
      kind: 'opening',
      template: 'opening-v1',
      mode: input.mode,
      notify: input.notify ?? input.mode === 'scheduled',
      scope: input.scope,
      periodStart: date,
      periodEnd: date,
      title: `${date} 开盘简报`,
      inputSummary: { marketDate, notify: input.notify ?? input.mode === 'scheduled' },
      buildSections: async (generatedAt) => {
        const sentimentResult = await ctx.tools.get_ashare_sentiment.execute({
          date: marketDate,
        });
        const marketBase = sentimentResult.ok
          ? marketPulse(sentimentResult.data.snapshot, shanghaiDate(date))
          : unavailableSection(
              'market-pulse',
              '市场脉搏',
              true,
              generatedAt,
              'ashare-sentiment',
              sentimentResult.error.kind,
            );
        const [market, events, portfolio, plans, watchlists] = await Promise.all([
          attachLadderFacts(marketBase, marketDate, generatedAt, ctx),
          eventsSection(date, generatedAt, ctx),
          portfolioSection(input.scope, generatedAt, ctx, input.date),
          alertPlansSection(generatedAt, ctx),
          watchlistsSection(generatedAt, ctx),
        ]);
        return [market, events, portfolio, plans, watchlists, researchSection(generatedAt)];
      },
    },
    ctx,
  );
  return 'ok' in result ? result : OpeningReportOutput.parse(result);
};

export const openingReportWorkflow = defineWorkflow<OpeningInput, OpeningOutput>({
  name: 'opening-report',
  description: '生成并幂等保存指定交易日的结构化开盘简报',
  input: OpeningReportInput,
  steps: [(prev, ctx) => runOpeningReport(prev as OpeningInput, ctx)],
});
