import {
  type AShareSentimentSnapshot,
  dateInShanghai,
  isHoliday,
  isWeekend,
  type ReportEvidence,
  type ReportMissingDimension,
  ReportSchema,
  type ReportScope,
  ReportScopeSchema,
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

export const previousTradingDay = (date: string): string => {
  const current = shanghaiDate(date);
  for (let offset = 1; offset <= 15; offset++) {
    const candidate = new Date(current.getTime() - offset * DAY_MS);
    if (!isWeekend(candidate) && !isHoliday(candidate)) return dateInShanghai(candidate);
  }
  throw new Error(`无法解析 ${date} 的前一 A 股交易日`);
};

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

export const marketPulse = (
  snapshot: AShareSentimentSnapshot,
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
            {
              key: 'indexCount',
              label: '指数样本',
              value: snapshot.indexes.values?.length ?? null,
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
          ],
        },
      ],
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions,
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
  const evidence = [
    localEvidence('overnight-portfolio:0', 'overnight-portfolio', now, 'local/holdings'),
  ];
  const missingTodayPnl = values.some((value) => value.totalTodayPnl === null);
  const failedAccounts = results.length - successful.length;
  const isPartial = missingTodayPnl || failedAccounts > 0;
  const missingDimensions = [
    ...(missingTodayPnl
      ? [missing('overnight-portfolio.previous-close', '部分持仓缺少可靠昨收', 'no_data')]
      : []),
    ...(failedAccounts > 0
      ? [missing('overnight-portfolio.accounts', `${failedAccounts} 个账户读取失败`, 'read_failed')]
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
              label: '当前估值',
              value: values.reduce((total, value) => total + Number(value.totalValue), 0),
            },
            {
              key: 'todayPnl',
              label: '今日估值变化',
              value: missingTodayPnl
                ? null
                : values.reduce((total, value) => total + Number(value.totalTodayPnl), 0),
            },
          ],
        },
      ],
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions,
    },
  };
};

const plansSection = async (
  now: Date,
  ctx: WorkflowContext,
): Promise<{ section: ReportSection; evidence: ReportEvidence[] }> => {
  const result = await ctx.tools.list_watch_plans.execute({ enabledOnly: true });
  if (!result.ok) {
    return unavailableSection(
      'watch-plans',
      '盯盘方案',
      true,
      now,
      'watch-plans',
      result.error.kind,
    );
  }
  const evidence = [localEvidence('watch-plans:0', 'watch-plans', now, 'local/watch-plans')];
  return {
    evidence,
    section: {
      key: 'watch-plans',
      title: '盯盘方案',
      required: true,
      status: 'complete',
      dataAsOf: now,
      blocks: [
        {
          kind: 'list',
          items: result.data.plans.map((view) => ({
            title: view.plan.name,
            detail: `${view.state} · ${view.memberCount} 个成员`,
            entityKind: 'watch-plan' as const,
            entityId: view.plan.id,
          })),
        },
      ],
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions: [],
    },
  };
};

const groupsSection = async (
  now: Date,
  ctx: WorkflowContext,
): Promise<{ section: ReportSection; evidence: ReportEvidence[] }> => {
  const result = await ctx.tools.list_stock_groups.execute({
    enabledOnly: true,
    includeMemberCount: true,
  });
  if (!result.ok) {
    return unavailableSection(
      'group-health',
      '分组健康',
      true,
      now,
      'stock-groups',
      result.error.kind,
    );
  }
  const evidence = [localEvidence('group-health:0', 'group-health', now, 'local/stock-groups')];
  return {
    evidence,
    section: {
      key: 'group-health',
      title: '分组健康',
      required: true,
      status: 'complete',
      dataAsOf: now,
      blocks: [
        {
          kind: 'list',
          items: result.data.groups.map(({ group, memberCount }) => ({
            title: group.name,
            detail: `${group.resolver.kind} · ${memberCount ?? 0} 个成员`,
            entityKind: 'stock-group' as const,
            entityId: group.id,
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
        const market = sentimentResult.ok
          ? marketPulse(sentimentResult.data.snapshot)
          : unavailableSection(
              'market-pulse',
              '市场脉搏',
              true,
              generatedAt,
              'ashare-sentiment',
              sentimentResult.error.kind,
            );
        const [events, portfolio, plans, groups] = await Promise.all([
          eventsSection(date, generatedAt, ctx),
          portfolioSection(input.scope, generatedAt, ctx),
          plansSection(generatedAt, ctx),
          groupsSection(generatedAt, ctx),
        ]);
        return [market, events, portfolio, plans, groups, researchSection(generatedAt)];
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
