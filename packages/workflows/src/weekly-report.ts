import {
  dateInShanghai,
  isHoliday,
  isWeekend,
  type ReportEvidence,
  ReportSchema,
  ReportScopeSchema,
  type ToolResult,
} from '@luoome/core';
import { z } from 'zod';

import { defineWorkflow, type WorkflowContext } from './define-workflow.js';
import { executeReportWorkflow, type ReportSectionPiece } from './internal/report-runner.js';
import {
  DAY_MS,
  localEvidence,
  missing,
  portfolioSection,
  shanghaiDate,
  unavailableSection,
} from './opening-report.js';

export const WeeklyReportInput = z.object({
  periodEnd: z.string().date().optional(),
  scope: ReportScopeSchema.default({ kind: 'all-accounts' }),
  notify: z.boolean().optional(),
  mode: z.enum(['manual', 'scheduled']).default('manual'),
});

export const WeeklyReportOutput = z.object({
  report: ReportSchema,
  created: z.boolean(),
  workflowRunId: z.string(),
  notified: z.boolean(),
});

type WeeklyInput = z.output<typeof WeeklyReportInput>;
type WeeklyOutput = z.output<typeof WeeklyReportOutput>;

const tradingDaysOfWeek = (periodEnd: string): string[] => {
  const end = shanghaiDate(periodEnd);
  const weekday = new Date(`${periodEnd}T00:00:00.000Z`).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  const monday = new Date(end.getTime() - daysSinceMonday * DAY_MS);
  const dates: string[] = [];
  for (
    let candidate = monday;
    candidate.getTime() <= end.getTime();
    candidate = new Date(candidate.getTime() + DAY_MS)
  ) {
    if (!isWeekend(candidate) && !isHoliday(candidate)) dates.push(dateInShanghai(candidate));
  }
  return dates;
};

const marketWeekSection = async (
  dates: readonly string[],
  now: Date,
  ctx: WorkflowContext,
): Promise<ReportSectionPiece> => {
  const results = await Promise.all(
    dates.map(async (date) => ({
      date,
      result: await ctx.tools.get_ashare_sentiment.execute({ date }),
    })),
  );
  const successful = results.filter(
    (
      item,
    ): item is {
      date: string;
      result: Extract<(typeof results)[number]['result'], { ok: true }>;
    } => item.result.ok,
  );
  if (successful.length === 0) {
    return unavailableSection(
      'market-week',
      '市场周度趋势',
      true,
      now,
      'ashare-sentiment',
      'all_dates_failed',
    );
  }
  const evidence: ReportEvidence[] = [];
  const missingDimensions = [];
  for (const { date, result } of successful) {
    const dimensions = [
      ['indexes', result.data.snapshot.indexes],
      ['breadth', result.data.snapshot.breadth],
      ['limit-up', result.data.snapshot.limitUp],
      ['themes', result.data.snapshot.themes],
    ] as const;
    for (const [dimension, value] of dimensions) {
      value.provenance.forEach((provenance, index) => {
        evidence.push({
          id: `market-week:${date}:${dimension}:${index}`,
          dimension: `market-week.${date}.${dimension}`,
          provenance,
        });
      });
      if (value.status !== 'complete') {
        missingDimensions.push(
          missing(
            `market-week.${date}.${dimension}`,
            value.warnings.join('; ') || `${dimension} unavailable`,
            value.provenance.find((item) => item.errorKind !== undefined)?.errorKind,
          ),
        );
      }
    }
  }
  for (const failed of results.filter((item) => !item.result.ok)) {
    if (failed.result.ok) continue;
    missingDimensions.push(
      missing(`market-week.${failed.date}`, '当日市场情绪不可用', failed.result.error.kind),
    );
  }
  const dataAsOf = new Date(
    Math.min(...successful.map((item) => item.result.data.snapshot.dataAsOf.getTime())),
  );
  return {
    evidence,
    section: {
      key: 'market-week',
      title: '市场周度趋势',
      required: true,
      status: missingDimensions.length === 0 ? 'complete' : 'partial',
      dataAsOf,
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'date', label: '交易日' },
            { key: 'sealedCount', label: '封板家数' },
            { key: 'brokenRate', label: '炸板率' },
            { key: 'maxLadderLevel', label: '最高连板' },
          ],
          rows: successful.map(({ date, result }) => {
            const brokenRate = result.data.snapshot.limitUp.value?.brokenRate;
            return {
              date,
              sealedCount: result.data.snapshot.limitUp.value?.sealedCount ?? null,
              // 表格列无 unit 元数据，ratio 在构建期格式化为百分比字符串
              brokenRate:
                brokenRate === undefined || brokenRate === null
                  ? null
                  : `${(brokenRate * 100).toFixed(1)}%`,
              maxLadderLevel: result.data.snapshot.limitUp.value?.maxLadderLevel ?? null,
            };
          }),
        },
      ],
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions,
    },
  };
};

const accountWeekSection = async (
  input: WeeklyInput,
  periodStart: string,
  periodEnd: string,
  now: Date,
  ctx: WorkflowContext,
): Promise<ReportSectionPiece> => {
  const current = await portfolioSection(input.scope, now, ctx, periodEnd, {
    fromDate: periodStart,
    toDate: periodEnd,
  });
  const evidence = current.evidence.map((item) => ({
    ...item,
    id: item.id.replace('overnight-portfolio', 'account-week'),
    dimension: item.dimension.replace('overnight-portfolio', 'account-week'),
  }));
  const historicalMissing = current.section.missingDimensions.some((item) =>
    item.dimension.includes('overnight-portfolio.valuation'),
  );
  return {
    evidence,
    section: {
      ...current.section,
      key: 'account-week',
      title: '账户周度变化',
      status: historicalMissing ? 'partial' : current.section.status,
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions: [
        ...current.section.missingDimensions.map((item) => ({
          ...item,
          dimension: item.dimension.replace('overnight-portfolio', 'account-week'),
        })),
        ...(historicalMissing
          ? [
              missing(
                'account-week.historical-valuations',
                '部分估值日缺少行情，周度收益与最大回撤保持 unavailable',
                'no_data',
              ),
            ]
          : []),
      ],
    },
  };
};

const alertFeedbackSection = async (
  periodStart: string,
  now: Date,
  ctx: WorkflowContext,
): Promise<ReportSectionPiece> => {
  const since = new Date(`${periodStart}T00:00:00+08:00`);
  const result = await ctx.tools.list_watch_triggers.execute({ since, limit: 500 });
  if (!result.ok) {
    return unavailableSection(
      'alert-feedback',
      '预警反馈',
      true,
      now,
      'watch-triggers',
      result.error.kind,
    );
  }
  const evidence = [
    localEvidence('alert-feedback:0', 'alert-feedback', now, 'local/watch-triggers'),
  ];
  const feedback = result.data.triggers.filter((trigger) => trigger.feedback !== undefined);
  const useful = feedback.filter((trigger) => trigger.feedback === 'useful').length;
  const failed = result.data.triggers.filter(
    (trigger) => trigger.deliveryStatus === 'failed',
  ).length;
  return {
    evidence,
    section: {
      key: 'alert-feedback',
      title: '预警反馈',
      required: true,
      status: 'complete',
      dataAsOf: now,
      blocks: [
        {
          kind: 'metrics',
          items: [
            { key: 'triggered', label: '预警数', value: result.data.total },
            { key: 'feedbackCount', label: '已反馈', value: feedback.length },
            {
              key: 'usefulRate',
              label: '有用率',
              value: feedback.length === 0 ? null : useful / feedback.length,
              unit: 'ratio',
            },
            { key: 'deliveryFailed', label: '送达失败', value: failed },
          ],
        },
      ],
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions: [],
    },
  };
};

const nextWeekEventsSection = async (
  periodEnd: string,
  now: Date,
  ctx: WorkflowContext,
): Promise<ReportSectionPiece> => {
  let from = new Date(shanghaiDate(periodEnd).getTime() + DAY_MS);
  while (isWeekend(from) || isHoliday(from)) from = new Date(from.getTime() + DAY_MS);
  const to = new Date(from.getTime() + 7 * DAY_MS - 1);
  const result = await ctx.tools.list_stock_events.execute({
    from,
    to,
    status: 'scheduled',
    importance: 'important',
    limit: 500,
  });
  if (!result.ok) {
    return unavailableSection(
      'next-week-events',
      '下周重要事件',
      true,
      now,
      'stock-events',
      result.error.kind,
    );
  }
  const stale = result.data.events.filter((event) => event.stale);
  const evidence = [
    localEvidence('next-week-events:0', 'next-week-events', now, 'local/stock-events'),
  ];
  return {
    evidence,
    section: {
      key: 'next-week-events',
      title: '下周重要事件',
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
          : [missing('next-week-events.freshness', `${stale.length} 条事件已标记 stale`, 'stale')],
    },
  };
};

const runWeeklyReport = async (
  input: WeeklyInput,
  ctx: WorkflowContext,
): Promise<WeeklyOutput | ToolResult<never>> => {
  const periodEnd = input.periodEnd ?? dateInShanghai(ctx.clock());
  const requested = shanghaiDate(periodEnd);
  if (isWeekend(requested) || isHoliday(requested)) {
    return {
      ok: false,
      error: { kind: 'invalid_input', message: `${periodEnd} 不是 A 股交易日`, issues: [] },
    };
  }
  const dates = tradingDaysOfWeek(periodEnd);
  const periodStart = dates[0];
  if (periodStart === undefined) {
    return {
      ok: false,
      error: { kind: 'invalid_input', message: `${periodEnd} 所在周无可确认交易日`, issues: [] },
    };
  }
  const result = await executeReportWorkflow(
    {
      workflowName: 'weekly-report',
      kind: 'weekly',
      template: 'weekly-v1',
      mode: input.mode,
      notify: input.notify ?? input.mode === 'scheduled',
      scope: input.scope,
      periodStart,
      periodEnd,
      title: `${periodStart} 至 ${periodEnd} 周报`,
      inputSummary: { marketDates: dates, notify: input.notify ?? input.mode === 'scheduled' },
      buildSections: async (generatedAt) => {
        const [market, account, alerts, events] = await Promise.all([
          marketWeekSection(dates, generatedAt, ctx),
          accountWeekSection(input, periodStart, periodEnd, generatedAt, ctx),
          alertFeedbackSection(periodStart, generatedAt, ctx),
          nextWeekEventsSection(periodEnd, generatedAt, ctx),
        ]);
        const signalOutcomes = unavailableSection(
          'signal-outcomes',
          '信号真实表现',
          false,
          generatedAt,
          'signal-observation',
          'not_implemented',
        );
        const researchChanges = unavailableSection(
          'research-changes',
          '研究变化',
          false,
          generatedAt,
          'research-notes.global-query',
          'not_implemented',
        );
        return [market, account, alerts, signalOutcomes, researchChanges, events];
      },
    },
    ctx,
  );
  return 'ok' in result ? result : WeeklyReportOutput.parse(result);
};

export const weeklyReportWorkflow = defineWorkflow<WeeklyInput, WeeklyOutput>({
  name: 'weekly-report',
  description: '按本周真实交易日生成并幂等保存结构化周报',
  input: WeeklyReportInput,
  steps: [(prev, ctx) => runWeeklyReport(prev as WeeklyInput, ctx)],
});
