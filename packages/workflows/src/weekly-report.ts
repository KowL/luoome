import {
  dateInShanghai,
  isHoliday,
  isWeekend,
  type ReportEvidence,
  type ReportMissingDimension,
  ReportSchema,
  ReportScopeSchema,
  type ToolResult,
} from '@luoome/core';
import type { GetDecisionLoopReviewOutput, ListTradesOutput } from '@luoome/tools';
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

const signalObservationWeekSection = async (
  periodStart: string,
  periodEnd: string,
  now: Date,
  ctx: WorkflowContext,
): Promise<ReportSectionPiece> => {
  const result = await ctx.tools.get_signal_observation_stats.execute({
    since: new Date(`${periodStart}T00:00:00+08:00`),
    until: new Date(`${periodEnd}T23:59:59.999+08:00`),
    limit: 5000,
  });
  if (!result.ok) {
    return unavailableSection(
      'signal-outcomes',
      '信号真实表现',
      false,
      now,
      'signal-observation',
      result.error.kind,
    );
  }

  const data = result.data;
  const evidence: ReportEvidence[] = [
    {
      id: 'signal-outcomes:stats',
      dimension: 'signal-outcomes',
      provenance: {
        provider: 'tool:get_signal_observation_stats',
        observedAt: data.observedAsOf ?? now,
        fetchedAt: now,
        freshness: data.observedAsOf === undefined ? 'unavailable' : 'unknown',
        ...(data.observedAsOf === undefined
          ? { errorKind: data.total === 0 ? 'no_data' : 'no_complete_observation' }
          : {}),
      },
    },
  ];
  const missingDimensions = [];
  if (data.total === 0) {
    missingDimensions.push(
      missing('signal-outcomes.samples', '本周没有可用 SignalObservation 样本', 'no_data'),
    );
  }
  if (data.missingRate > 0) {
    missingDimensions.push(
      missing(
        'signal-outcomes.completeness',
        `${(data.missingRate * 100).toFixed(2)}% 的观察尚未 complete 或不可用`,
        'incomplete_observation',
      ),
    );
  }
  if (data.stats.some((stat) => stat.complete > 0 && stat.benchmarkStatus === 'unavailable')) {
    missingDimensions.push(
      missing(
        'signal-outcomes.benchmark',
        '部分 complete 观察缺少可用 benchmark，benchmark/excess return 不能完整计算',
        'benchmark_unavailable',
      ),
    );
  }

  return {
    evidence,
    section: {
      key: 'signal-outcomes',
      title: '信号真实表现',
      required: false,
      status: missingDimensions.length === 0 ? 'complete' : 'partial',
      ...(data.observedAsOf === undefined ? {} : { dataAsOf: data.observedAsOf }),
      blocks: [
        {
          kind: 'metrics',
          items: [
            { key: 'sampleUnit', label: '样本单位', value: data.sampleUnit },
            { key: 'total', label: '去重样本数', value: data.total },
            { key: 'complete', label: '已完成观察', value: data.complete },
            {
              key: 'missingRate',
              label: '缺失率',
              value: data.total === 0 ? null : data.missingRate,
              unit: 'ratio',
            },
            {
              key: 'observedAsOf',
              label: '最新观察时间',
              value: data.observedAsOf?.toISOString() ?? null,
            },
          ],
        },
        {
          kind: 'table',
          columns: [
            { key: 'horizon', label: '观察周期' },
            { key: 'total', label: '样本数' },
            { key: 'complete', label: '完成数' },
            { key: 'missingRate', label: '缺失率' },
            { key: 'averageReturnPct', label: '平均标的表现' },
            { key: 'averageBenchmarkReturnPct', label: '平均基准表现' },
            { key: 'averageExcessReturnPct', label: '平均超额表现' },
          ],
          rows: data.stats.map((stat) => ({
            horizon: stat.horizon,
            total: stat.total,
            complete: stat.complete,
            missingRate: stat.total === 0 ? null : stat.missingRate,
            averageReturnPct: stat.averageReturnPct ?? null,
            averageBenchmarkReturnPct: stat.averageBenchmarkReturnPct ?? null,
            averageExcessReturnPct: stat.averageExcessReturnPct ?? null,
          })),
        },
        {
          kind: 'text',
          tone: missingDimensions.length === 0 ? 'factual' : 'warning',
          text: data.limitations.join('；'),
        },
      ],
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions,
    },
  };
};

const MIN_STRATEGY_REVIEW_SAMPLE = 10;

/**
 * 「策略复盘」（PRD strategy-ai-managed-automation §5 M1）：对每个本周有 published
 * operational run 的 active 策略，复用 generate_strategy_insight 的确定性事实
 * （T+1/T+3/T+5 观察统计）与 AI 解读；AI 失败由 tool 内部降级 facts-only，
 * 样本不足与 benchmark 不可用在文本中显式标注，不展示伪精度。
 */
const strategyReviewWeekSection = async (
  periodStart: string,
  now: Date,
  ctx: WorkflowContext,
): Promise<ReportSectionPiece> => {
  const [strategies, runs] = await Promise.all([
    ctx.tools.list_strategies.execute({ filter: { status: 'active' } }),
    ctx.tools.list_strategy_runs.execute({
      scope: 'operational',
      publication: 'published',
      since: new Date(`${periodStart}T00:00:00+08:00`),
      limit: 500,
    }),
  ]);
  if (!strategies.ok) {
    return unavailableSection(
      'strategy-review',
      '策略复盘',
      false,
      now,
      'strategy-review.strategies',
      strategies.error.kind,
    );
  }
  if (!runs.ok) {
    return unavailableSection(
      'strategy-review',
      '策略复盘',
      false,
      now,
      'strategy-review.runs',
      runs.error.kind,
    );
  }

  const publishedStrategyIds = new Set(runs.data.runs.map((run) => run.strategyId));
  const reviewed = strategies.data.strategies.filter((strategy) =>
    publishedStrategyIds.has(strategy.id),
  );
  const evidence: ReportEvidence[] = [
    localEvidence('strategy-review:runs', 'strategy-review.runs', now, 'tool:list_strategy_runs'),
  ];
  const missingDimensions: ReportMissingDimension[] = [];
  const rows: Record<string, string | number | boolean | null>[] = [];
  const narratives: string[] = [];
  for (const strategy of reviewed) {
    const insight = await ctx.tools.generate_strategy_insight.execute({ strategyId: strategy.id });
    if (!insight.ok) {
      missingDimensions.push(
        missing(
          `strategy-review.insight.${strategy.id}`,
          `${strategy.name} 的策略洞察不可用`,
          insight.error.kind,
        ),
      );
      continue;
    }
    evidence.push(
      localEvidence(
        `strategy-review:insight:${strategy.id}`,
        `strategy-review.insight.${strategy.id}`,
        now,
        'tool:generate_strategy_insight',
      ),
    );
    const notes: string[] = [];
    if (insight.data.provider === 'facts-only') {
      notes.push('AI 不可用，以下为确定性事实摘要');
    }
    for (const observation of insight.data.facts.observations) {
      rows.push({
        strategy: strategy.name,
        horizon: observation.horizon,
        total: observation.total,
        complete: observation.complete,
        missingRate: observation.total === 0 ? null : observation.missingRate,
        averageExcessReturnPct:
          observation.benchmarkStatus === 'complete'
            ? (observation.averageExcessReturnPct ?? null)
            : null,
        benchmarkStatus: observation.benchmarkStatus,
      });
      if (observation.complete === 0) {
        notes.push(`${observation.horizon.toUpperCase()} 尚无完整观察样本`);
        continue;
      }
      if (observation.complete < MIN_STRATEGY_REVIEW_SAMPLE) {
        notes.push(
          `${observation.horizon.toUpperCase()} 完整样本 ${observation.complete} 条，样本不足，只作描述性参考`,
        );
      }
      if (observation.benchmarkStatus === 'unavailable') {
        notes.push(`${observation.horizon.toUpperCase()} benchmark 不可用，不展示超额收益`);
      }
    }
    narratives.push(
      `【${strategy.name}】${insight.data.insight.headline}：${insight.data.insight.summary}${
        notes.length === 0 ? '' : `（${notes.join('；')}）`
      }`,
    );
  }
  const status = missingDimensions.length === 0 ? ('complete' as const) : ('partial' as const);
  return {
    evidence,
    section: {
      key: 'strategy-review',
      title: '策略复盘',
      required: false,
      status,
      dataAsOf: now,
      blocks: [
        {
          kind: 'table' as const,
          columns: [
            { key: 'strategy', label: '策略' },
            { key: 'horizon', label: '观察周期' },
            { key: 'total', label: '样本数' },
            { key: 'complete', label: '完整样本' },
            { key: 'missingRate', label: '缺失率' },
            { key: 'averageExcessReturnPct', label: '平均超额表现' },
            { key: 'benchmarkStatus', label: 'Benchmark 状态' },
          ],
          rows,
        },
        {
          kind: 'text' as const,
          tone: status === 'complete' ? ('factual' as const) : ('warning' as const),
          text:
            narratives.length > 0
              ? narratives.join('\n')
              : reviewed.length === 0
                ? '本周没有 active 策略的 published 运行，无需复盘。'
                : '策略洞察均不可用，详见缺失维度。',
        },
      ],
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions,
    },
  };
};

const AUTONOMY_KIND_LABELS: Record<string, string> = {
  pause: '自动暂停',
  archive: '自动归档',
  'propose-version': '提议版本',
  'publish-version': '发布版本',
};

const autonomySnapshotSummary = (action: {
  readonly ruleSnapshot?: Record<string, unknown> | undefined;
}): string => {
  const snapshot = action.ruleSnapshot;
  if (snapshot === undefined) return '';
  const sampleCount = snapshot.sampleCount;
  const benchmarkCoverage = snapshot.benchmarkCoverage;
  const avgExcessReturn = snapshot.avgExcessReturn;
  const medianExcessReturn = snapshot.medianExcessReturn;
  const parts: string[] = [];
  if (typeof sampleCount === 'number') parts.push(`完整样本 ${sampleCount}`);
  if (typeof benchmarkCoverage === 'number') {
    parts.push(`基准覆盖 ${(benchmarkCoverage * 100).toFixed(1)}%`);
  }
  if (typeof avgExcessReturn === 'number') {
    parts.push(`平均超额 ${(avgExcessReturn * 100).toFixed(2)}%`);
  }
  if (typeof medianExcessReturn === 'number') {
    parts.push(`中位超额 ${(medianExcessReturn * 100).toFixed(2)}%`);
  }
  return parts.length === 0 ? '' : ` · ${parts.join(' · ')}`;
};

/**
 * 「AI 管理动作」（DDD strategy-ai-lifecycle §4，M2-S1）：本周 StrategyAutonomyAction
 * 的事实列表。detail 只读 ruleSnapshot 的确定性指标，不引用 aiNarrative 做判定式表述。
 */
const strategyAutonomyActionsWeekSection = async (
  periodStart: string,
  periodEnd: string,
  now: Date,
  ctx: WorkflowContext,
): Promise<ReportSectionPiece> => {
  const result = await ctx.tools.list_strategy_autonomy_actions.execute({
    since: new Date(`${periodStart}T00:00:00+08:00`),
    until: new Date(`${periodEnd}T23:59:59.999+08:00`),
    limit: 500,
  });
  if (!result.ok) {
    return unavailableSection(
      'strategy-autonomy-actions',
      'AI 管理动作',
      false,
      now,
      'strategy-autonomy-actions',
      result.error.kind,
    );
  }
  const evidence = [
    localEvidence(
      'strategy-autonomy-actions:0',
      'strategy-autonomy-actions',
      now,
      'tool:list_strategy_autonomy_actions',
    ),
  ];
  return {
    evidence,
    section: {
      key: 'strategy-autonomy-actions',
      title: 'AI 管理动作',
      required: false,
      status: 'complete',
      dataAsOf: now,
      blocks: [
        {
          kind: 'list',
          items: result.data.actions.map((action) => ({
            title: `${AUTONOMY_KIND_LABELS[action.kind] ?? action.kind} · ${action.status}`,
            detail: `${action.strategyId}${autonomySnapshotSummary(action)}`,
            entityKind: 'strategy' as const,
            entityId: action.strategyId,
          })),
        },
        {
          kind: 'text',
          tone: 'factual',
          text:
            result.data.total === 0
              ? '本周没有 AI 管理动作。'
              : '以上为确定性规则触发并落库的管理动作；AI 解释文本不参与任何状态判定。',
        },
      ],
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions: [],
    },
  };
};

const adviceOutcomesWeekSection = async (
  input: WeeklyInput,
  periodStart: string,
  periodEnd: string,
  now: Date,
  ctx: WorkflowContext,
): Promise<ReportSectionPiece> => {
  const since = new Date(`${periodStart}T00:00:00+08:00`);
  const until = new Date(`${periodEnd}T23:59:59.999+08:00`);
  const [adviceResult, statsResult] = await Promise.all([
    ctx.tools.get_advice.execute({ since, until, includeExpired: true, limit: 500 }),
    ctx.tools.get_advice_stats.execute({ since, until }),
  ]);
  if (!adviceResult.ok && !statsResult.ok) {
    return unavailableSection(
      'advice-outcomes',
      'Advice 复盘',
      false,
      now,
      'advice-outcomes',
      `${adviceResult.error.kind}:${statsResult.error.kind}`,
    );
  }

  const advices = adviceResult.ok ? adviceResult.data.advices : [];
  const stats = statsResult.ok ? statsResult.data : undefined;
  const detailsAreComplete = adviceResult.ok && advices.length < 500;
  const counts = { followed: 0, partiallyFollowed: 0, ignored: 0 };
  for (const advice of advices) {
    const outcome = advice.outcome?.outcome;
    if (outcome === 'followed') counts.followed += 1;
    if (outcome === 'partially_followed') counts.partiallyFollowed += 1;
    if (outcome === 'ignored') counts.ignored += 1;
  }
  const total = stats?.totalAdvices ?? (adviceResult.ok ? adviceResult.data.total : 0);
  const withOutcome = detailsAreComplete
    ? counts.followed + counts.partiallyFollowed + counts.ignored
    : undefined;
  const pending = withOutcome === undefined ? undefined : Math.max(0, total - withOutcome);
  const outcomeMissingRate = total === 0 || pending === undefined ? null : pending / total;
  const ratio = (value: number | undefined): number | null =>
    total === 0 || value === undefined ? null : value;
  const rateFromDetails = (count: number): number | null =>
    total === 0 || !detailsAreComplete ? null : count / total;
  const limitations = [
    '仅描述 Advice 的回填状态和采纳分布，不评价建议正确性、收益因果或胜率。',
    'Advice 结果由用户回填或可信事实提供，不从行情反推是否采纳。',
  ];
  const missingDimensions = [];
  if (!adviceResult.ok) {
    limitations.push(`Advice 明细读取失败：${adviceResult.error.kind}。`);
    missingDimensions.push(
      missing(
        'advice-outcomes.details',
        'Advice 明细读取失败，待回填数量不可完整核对',
        adviceResult.error.kind,
      ),
    );
  }
  if (!statsResult.ok) {
    limitations.push(`Advice 聚合统计读取失败：${statsResult.error.kind}。`);
    missingDimensions.push(
      missing(
        'advice-outcomes.stats',
        'Advice 聚合统计读取失败，采纳分布只能依据有限明细',
        statsResult.error.kind,
      ),
    );
  }
  if (adviceResult.ok && !detailsAreComplete) {
    limitations.push('Advice 明细最多读取 500 条；达到上限时待回填数量只能标记为 unknown。');
    missingDimensions.push(
      missing('advice-outcomes.details-limit', 'Advice 明细达到 500 条读取上限', 'limit_reached'),
    );
  }
  if (input.scope.kind === 'account') {
    limitations.push('Advice 当前没有账户归属字段，账户范围周报无法隔离 Advice 样本。');
    missingDimensions.push(
      missing(
        'advice-outcomes.account-scope',
        'Advice 当前没有可靠的 account scope，当前区块按全局 Advice 统计',
        'scope_unavailable',
      ),
    );
  }
  if (total === 0) {
    limitations.push('本周没有 Advice 样本。');
    missingDimensions.push(missing('advice-outcomes.samples', '本周没有 Advice 样本', 'no_data'));
  } else if (pending !== undefined && pending > 0) {
    missingDimensions.push(
      missing('advice-outcomes.pending', `${pending} 条 Advice 尚未回填结果`, 'outcome_pending'),
    );
  }

  const evidence: ReportEvidence[] = [];
  if (adviceResult.ok) {
    evidence.push(
      localEvidence('advice-outcomes:advice', 'advice-outcomes.advice', now, 'tool:get_advice'),
    );
  }
  if (statsResult.ok) {
    evidence.push(
      localEvidence('advice-outcomes:stats', 'advice-outcomes.stats', now, 'tool:get_advice_stats'),
    );
  }
  return {
    evidence,
    section: {
      key: 'advice-outcomes',
      title: 'Advice 复盘',
      required: false,
      status: missingDimensions.length === 0 ? 'complete' : 'partial',
      dataAsOf: now,
      blocks: [
        {
          kind: 'metrics',
          items: [
            { key: 'totalAdvices', label: 'Advice 样本数', value: total },
            { key: 'withOutcome', label: '已回填结果', value: withOutcome ?? null },
            { key: 'pendingOutcome', label: '待回填', value: pending ?? null },
            {
              key: 'outcomeMissingRate',
              label: '结果缺失率',
              value: outcomeMissingRate,
              unit: 'ratio',
            },
            {
              key: 'followed',
              label: '完全采纳',
              value: detailsAreComplete ? counts.followed : null,
            },
            {
              key: 'partiallyFollowed',
              label: '部分采纳',
              value: detailsAreComplete ? counts.partiallyFollowed : null,
            },
            { key: 'ignored', label: '未采纳', value: detailsAreComplete ? counts.ignored : null },
            {
              key: 'followedRate',
              label: '完全采纳比例',
              value: ratio(
                stats?.outcomeRate.followed ?? rateFromDetails(counts.followed) ?? undefined,
              ),
              unit: 'ratio',
            },
            {
              key: 'partiallyFollowedRate',
              label: '部分采纳比例',
              value: ratio(
                stats?.outcomeRate.partiallyFollowed ??
                  rateFromDetails(counts.partiallyFollowed) ??
                  undefined,
              ),
              unit: 'ratio',
            },
            {
              key: 'ignoredRate',
              label: '未采纳比例',
              value: ratio(
                stats?.outcomeRate.ignored ?? rateFromDetails(counts.ignored) ?? undefined,
              ),
              unit: 'ratio',
            },
            {
              key: 'knownPnlSamples',
              label: '已知盈亏样本',
              value: detailsAreComplete
                ? advices.filter((advice) => advice.outcome?.pnl !== undefined).length
                : null,
            },
            {
              key: 'knownBenchmarkPnlSamples',
              label: '已知基准盈亏样本',
              value: detailsAreComplete
                ? advices.filter((advice) => advice.outcome?.benchmarkPnl !== undefined).length
                : null,
            },
            {
              key: 'avgConfidence',
              label: '平均信心度',
              value: total === 0 ? null : (stats?.avgConfidence ?? null),
            },
          ],
        },
        {
          kind: 'text',
          tone: missingDimensions.length === 0 ? 'factual' : 'warning',
          text: limitations.join('；'),
        },
      ],
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions,
    },
  };
};

type DecisionLoopReview = z.output<typeof GetDecisionLoopReviewOutput>;
type ListedTrades = z.output<typeof ListTradesOutput>;

interface DecisionLoopAccountEntry {
  readonly accountId: string;
  readonly review?: DecisionLoopReview;
  readonly reviewError?: string;
  readonly trades?: ListedTrades;
  readonly tradesError?: string;
}

interface DecisionLoopScopeData {
  readonly accountIds: readonly string[];
  readonly entries: readonly DecisionLoopAccountEntry[];
  readonly accountListError?: string;
}

const loadDecisionLoopScope = async (
  input: WeeklyInput,
  periodStart: string,
  periodEnd: string,
  ctx: WorkflowContext,
): Promise<DecisionLoopScopeData> => {
  let accountIds: readonly string[];
  if (input.scope.kind === 'account') {
    accountIds = [input.scope.accountId];
  } else {
    const accounts = await ctx.tools.list_accounts.execute({});
    if (!accounts.ok) {
      return { accountIds: [], entries: [], accountListError: accounts.error.kind };
    }
    accountIds = [...new Set(accounts.data.accounts.map((account) => account.id))];
  }

  const since = new Date(`${periodStart}T00:00:00+08:00`);
  const until = new Date(`${periodEnd}T23:59:59.999+08:00`);
  const entries = await Promise.all(
    accountIds.map(async (accountId): Promise<DecisionLoopAccountEntry> => {
      const [review, trades] = await Promise.all([
        ctx.tools.get_decision_loop_review.execute({
          accountId,
          since,
          until,
          limit: 1000,
        }),
        ctx.tools.list_trades.execute({ accountId, since, until, limit: 500 }),
      ]);
      return {
        accountId,
        ...(review.ok ? { review: review.data } : { reviewError: review.error.kind }),
        ...(trades.ok ? { trades: trades.data } : { tradesError: trades.error.kind }),
      };
    }),
  );
  return { accountIds, entries };
};

const decisionLoopEvidence = (
  prefix: string,
  data: DecisionLoopScopeData,
  now: Date,
): ReportEvidence[] =>
  data.entries.flatMap((entry) => {
    const reviewEvidence: ReportEvidence = {
      id: `${prefix}:review:${entry.accountId}`,
      dimension: `${prefix}.review.${entry.accountId}`,
      provenance: {
        provider: 'tool:get_decision_loop_review',
        observedAt: entry.review?.dataAsOf ?? now,
        fetchedAt: now,
        freshness: entry.review === undefined ? 'unavailable' : 'unknown',
        ...(entry.reviewError === undefined ? {} : { errorKind: entry.reviewError }),
      },
    };
    const tradeEvidence: ReportEvidence = {
      id: `${prefix}:trades:${entry.accountId}`,
      dimension: `${prefix}.trades.${entry.accountId}`,
      provenance: {
        provider: 'tool:list_trades',
        observedAt: now,
        fetchedAt: now,
        freshness: entry.trades === undefined ? 'unavailable' : 'unknown',
        ...(entry.tradesError === undefined ? {} : { errorKind: entry.tradesError }),
      },
    };
    return [reviewEvidence, tradeEvidence];
  });

const scopeMissingDimensions = (
  prefix: string,
  data: DecisionLoopScopeData,
): ReturnType<typeof missing>[] => {
  const dimensions: ReturnType<typeof missing>[] = [];
  if (data.accountListError !== undefined) {
    dimensions.push(
      missing(
        `${prefix}.accounts`,
        `账户列表读取失败：${data.accountListError}`,
        data.accountListError,
      ),
    );
  }
  for (const entry of data.entries) {
    if (entry.reviewError !== undefined) {
      dimensions.push(
        missing(
          `${prefix}.review.${entry.accountId}`,
          `账户 ${entry.accountId} 的决策闭环复盘读取失败：${entry.reviewError}`,
          entry.reviewError,
        ),
      );
    }
    if (entry.tradesError !== undefined) {
      dimensions.push(
        missing(
          `${prefix}.trades.${entry.accountId}`,
          `账户 ${entry.accountId} 的交易读取失败：${entry.tradesError}`,
          entry.tradesError,
        ),
      );
    }
  }
  if (data.accountListError === undefined && data.accountIds.length === 0) {
    dimensions.push(missing(`${prefix}.samples`, '当前范围没有可复盘账户', 'no_data'));
  }
  return dimensions;
};

const tradeAttributionWeekSection = (
  data: DecisionLoopScopeData,
  now: Date,
): ReportSectionPiece => {
  const evidence = decisionLoopEvidence('trade-attribution', data, now);
  const missingDimensions = scopeMissingDimensions('trade-attribution', data);
  const reviewComplete =
    data.accountIds.length > 0 &&
    data.entries.length === data.accountIds.length &&
    data.entries.every((entry) => entry.review !== undefined);
  const tradeRowsComplete =
    data.accountIds.length > 0 &&
    data.entries.length === data.accountIds.length &&
    data.entries.every(
      (entry) => entry.trades !== undefined && entry.trades.total === entry.trades.trades.length,
    );
  const totalTrades = reviewComplete
    ? data.entries.reduce((total, entry) => total + (entry.review?.trades.total ?? 0), 0)
    : null;
  const unattributed = reviewComplete
    ? data.entries.reduce((total, entry) => total + (entry.review?.trades.unattributed ?? 0), 0)
    : null;
  const attributionCounts = reviewComplete
    ? {
        advice: data.entries.reduce(
          (total, entry) => total + (entry.review?.trades.attributionCounts.advice ?? 0),
          0,
        ),
        researchHypothesisVersion: data.entries.reduce(
          (total, entry) =>
            total + (entry.review?.trades.attributionCounts.researchHypothesisVersion ?? 0),
          0,
        ),
        strategyVersion: data.entries.reduce(
          (total, entry) => total + (entry.review?.trades.attributionCounts.strategyVersion ?? 0),
          0,
        ),
      }
    : null;
  const attributed =
    totalTrades === null || unattributed === null ? null : totalTrades - unattributed;
  const attributionRate =
    totalTrades === null || totalTrades === 0 || attributed === null
      ? null
      : attributed / totalTrades;
  const unattributedRows = data.entries
    .flatMap((entry) =>
      (entry.trades?.trades ?? [])
        .filter(
          (trade) =>
            trade.adviceId === undefined &&
            trade.researchHypothesisVersionId === undefined &&
            trade.strategyVersionId === undefined,
        )
        .map((trade) => ({ accountId: entry.accountId, trade })),
    )
    .slice(0, 10);
  if (data.entries.some((entry) => entry.trades !== undefined && !tradeRowsComplete)) {
    missingDimensions.push(
      missing(
        'trade-attribution.trade-list-limit',
        '交易列表达到读取上限，未关联交易列表仅展示已读取样本',
        'limit_reached',
      ),
    );
  }
  if (totalTrades === 0) {
    missingDimensions.push(missing('trade-attribution.samples', '当前窗口没有交易事实', 'no_data'));
  }
  const limitations = [
    '关联统计只读取 Trade 上显式保存的 Advice、ResearchHypothesisVersion 或 StrategyVersion；无关联不是失败，也不从行情或 Advice 反推关联。',
    '未关联交易列表最多展示 10 条摘要，不包含完整账本。',
  ];
  if (!tradeRowsComplete && data.accountIds.length > 0) {
    limitations.push('交易列表未完整覆盖时，未关联交易摘要只代表已读取样本。');
  }
  const status = missingDimensions.length === 0 ? 'complete' : 'partial';
  return {
    evidence,
    section: {
      key: 'trade-attribution',
      title: '交易归因',
      required: false,
      status,
      dataAsOf: now,
      blocks: [
        {
          kind: 'metrics',
          items: [
            {
              key: 'accountsRequested',
              label: '账户范围',
              value: data.accountListError === undefined ? data.accountIds.length : null,
            },
            {
              key: 'accountsCovered',
              label: '已覆盖账户',
              value:
                data.accountListError === undefined
                  ? data.entries.filter((entry) => entry.review !== undefined).length
                  : null,
            },
            { key: 'totalTrades', label: '交易数', value: totalTrades },
            { key: 'attributedTrades', label: '已关联交易', value: attributed },
            { key: 'attributionRate', label: '关联率', value: attributionRate, unit: 'ratio' },
            { key: 'unattributedTrades', label: '未关联交易', value: unattributed },
            {
              key: 'adviceAttributions',
              label: 'Advice 归因数',
              value: attributionCounts?.advice ?? null,
            },
            {
              key: 'researchHypothesisAttributions',
              label: '研究假设归因数',
              value: attributionCounts?.researchHypothesisVersion ?? null,
            },
            {
              key: 'strategyAttributions',
              label: 'StrategyVersion 归因数',
              value: attributionCounts?.strategyVersion ?? null,
            },
            {
              key: 'unattributedPreviewCount',
              label: '未关联摘要条数',
              value: tradeRowsComplete ? unattributedRows.length : null,
            },
          ],
        },
        {
          kind: 'table',
          columns: [
            { key: 'accountId', label: '账户' },
            { key: 'tradeId', label: '交易 ID' },
            { key: 'stockId', label: '标的' },
            { key: 'executedAt', label: '成交时间' },
            { key: 'side', label: '方向' },
            { key: 'quantity', label: '数量' },
          ],
          rows: unattributedRows.map(({ accountId, trade }) => ({
            accountId,
            tradeId: trade.id,
            stockId: trade.stockId,
            executedAt: trade.executedAt.toISOString(),
            side: trade.side,
            quantity: Number(trade.quantity),
          })),
        },
        {
          kind: 'text',
          tone: missingDimensions.length === 0 ? 'factual' : 'warning',
          text:
            totalTrades === 0
              ? `${limitations.join('；')} 当前窗口没有交易样本。`
              : `${limitations.join('；')} 未关联交易不代表 Advice 未采纳。`,
        },
      ],
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions,
    },
  };
};

const MIN_BEHAVIOR_SAMPLE = 5;

const behaviorPatternsWeekSection = (
  input: WeeklyInput,
  data: DecisionLoopScopeData,
  now: Date,
): ReportSectionPiece => {
  const evidence = decisionLoopEvidence('behavior-patterns', data, now).filter((item) =>
    item.id.includes(':review:'),
  );
  const missingDimensions: ReturnType<typeof missing>[] = [];
  const entry = input.scope.kind === 'account' ? data.entries[0] : undefined;
  const review = entry?.review;
  if (input.scope.kind !== 'account') {
    missingDimensions.push(
      missing(
        'behavior-patterns.account-scope',
        'Advice 当前没有可靠的 accountId；all-accounts 范围可能重复计算同一股票 Advice，因此不生成跨账户行为分布',
        'scope_unavailable',
      ),
    );
  }
  if (data.accountListError !== undefined) {
    missingDimensions.push(
      missing(
        'behavior-patterns.accounts',
        `账户列表读取失败：${data.accountListError}`,
        data.accountListError,
      ),
    );
  }
  if (entry?.reviewError !== undefined) {
    missingDimensions.push(
      missing(
        'behavior-patterns.review',
        `决策闭环复盘读取失败：${entry.reviewError}`,
        entry.reviewError,
      ),
    );
  }
  if (review?.unknowns.some((unknown) => unknown.includes('Advice 读取达到'))) {
    missingDimensions.push(
      missing(
        'behavior-patterns.advice-limit',
        'Advice 读取达到上限，行为分布可能不完整',
        'limit_reached',
      ),
    );
  }
  const total = review?.advice.total ?? null;
  const enough = total !== null && total >= MIN_BEHAVIOR_SAMPLE;
  if (input.scope.kind === 'account' && review !== undefined && !enough) {
    missingDimensions.push(
      missing(
        'behavior-patterns.sample-size',
        `Advice 样本数不足 ${MIN_BEHAVIOR_SAMPLE}，不生成行为模式结论`,
        'insufficient_sample',
      ),
    );
  }
  const distribution = review?.advice.outcomeDistribution;
  const rate = (value: number | undefined): number | null =>
    !enough || total === null || value === undefined ? null : value / total;
  const status = missingDimensions.length === 0 ? 'complete' : 'partial';
  const limitations = [
    '只描述 AdviceOutcome 回填与采纳分布，不评价建议正确性、收益因果或胜率。',
    `行为模式最小样本门槛为 ${MIN_BEHAVIOR_SAMPLE} 条 Advice；不足时不生成模式结论，指标保持 unknown。`,
  ];
  if (input.scope.kind !== 'account') {
    limitations.push('all-accounts 范围不对没有 accountId 的 Advice 做跨账户去重。');
  }
  if (review === undefined) limitations.push('当前范围没有可用决策闭环复盘事实。');
  return {
    evidence,
    section: {
      key: 'behavior-patterns',
      title: '行为模式',
      required: false,
      status,
      ...(review?.dataAsOf === undefined ? { dataAsOf: now } : { dataAsOf: review.dataAsOf }),
      blocks: [
        {
          kind: 'metrics',
          items: [
            { key: 'sampleCount', label: 'Advice 样本数', value: total },
            { key: 'minimumSample', label: '最小样本门槛', value: MIN_BEHAVIOR_SAMPLE },
            {
              key: 'backfilled',
              label: '已回填',
              value: enough ? (review?.advice.backfilled ?? null) : null,
            },
            {
              key: 'pending',
              label: '待回填',
              value: enough ? (review?.advice.pending ?? null) : null,
            },
            {
              key: 'followedRate',
              label: '完全采纳比例',
              value: rate(distribution?.followed),
              unit: 'ratio',
            },
            {
              key: 'partiallyFollowedRate',
              label: '部分采纳比例',
              value: rate(distribution?.partiallyFollowed),
              unit: 'ratio',
            },
            {
              key: 'ignoredRate',
              label: '未采纳比例',
              value: rate(distribution?.ignored),
              unit: 'ratio',
            },
          ],
        },
        {
          kind: 'text',
          tone: status === 'complete' ? 'factual' : 'warning',
          text: `${limitations.join('；')}${
            enough && distribution !== undefined
              ? ` 当前窗口 ${total} 条 Advice 的采纳分布为：完全采纳 ${distribution.followed}、部分采纳 ${distribution.partiallyFollowed}、未采纳 ${distribution.ignored}。`
              : ''
          }`,
        },
      ],
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions,
    },
  };
};

const dataQualityWeekSection = (
  input: WeeklyInput,
  data: DecisionLoopScopeData,
  sourcePieces: readonly ReportSectionPiece[],
  now: Date,
): ReportSectionPiece => {
  const sourceSections = sourcePieces.map((piece) => piece.section);
  const sourceEvidence = sourcePieces.flatMap((piece) => piece.evidence);
  const reviewEntries = data.entries.filter((entry) => entry.review !== undefined);
  const reviewUnknowns = [
    ...new Set(reviewEntries.flatMap((entry) => entry.review?.unknowns ?? [])),
  ];
  const inheritedMissing = sourceSections.flatMap((section) =>
    section.missingDimensions.map((item) =>
      missing(
        `data-quality.${section.key}.${item.dimension}`,
        `${section.title}：${item.reason}`,
        item.errorKind,
      ),
    ),
  );
  const missingDimensions = [...inheritedMissing];
  const reportedPriceGaps = inheritedMissing.filter((item) =>
    /price|行情|昨收|估值|缺价/i.test(item.reason),
  ).length;
  const reportedCashFlowCorporateActionGaps = inheritedMissing.filter((item) =>
    /cash|corporate|现金流|公司行动/i.test(item.reason),
  ).length;
  if (data.accountListError !== undefined) {
    missingDimensions.push(
      missing(
        'data-quality.accounts',
        `账户列表读取失败：${data.accountListError}`,
        data.accountListError,
      ),
    );
  }
  for (const entry of data.entries) {
    if (entry.reviewError !== undefined) {
      missingDimensions.push(
        missing(
          `data-quality.review.${entry.accountId}`,
          `账户 ${entry.accountId} 的复盘数据不可用：${entry.reviewError}`,
          entry.reviewError,
        ),
      );
    }
    if (entry.tradesError !== undefined) {
      missingDimensions.push(
        missing(
          `data-quality.trades.${entry.accountId}`,
          `账户 ${entry.accountId} 的交易数据不可用：${entry.tradesError}`,
          entry.tradesError,
        ),
      );
    }
  }
  if (input.scope.kind === 'all-accounts') {
    missingDimensions.push(
      missing(
        'data-quality.signal-account-scope',
        'SignalObservation 没有 accountId；账户范围只能按股票投影，不能证明样本属于单一账户',
        'scope_unavailable',
      ),
    );
  }
  for (const [index, unknown] of reviewUnknowns.slice(0, 10).entries()) {
    missingDimensions.push(missing(`data-quality.review-unknown.${index}`, unknown, 'unknown'));
  }
  const accountReview = input.scope.kind === 'account' ? reviewEntries[0]?.review : undefined;
  const signal = accountReview?.signalObservations;
  const benchmarkUnavailable =
    signal?.stats.filter((stat) => stat.benchmarkStatus === 'unavailable').length ?? null;
  const listLimitCount = data.entries.filter(
    (entry) => entry.trades !== undefined && entry.trades.total > entry.trades.trades.length,
  ).length;
  const unavailableFreshness = sourceEvidence.filter(
    (item) => item.provenance.freshness === 'unavailable',
  ).length;
  const unknownFreshness = sourceEvidence.filter(
    (item) => item.provenance.freshness === 'unknown',
  ).length;
  if (unavailableFreshness > 0) {
    missingDimensions.push(
      missing(
        'data-quality.provider-unavailable',
        `${unavailableFreshness} 条证据的 provider 当前不可用`,
        'provider_unavailable',
      ),
    );
  }
  const qualityEvidence = localEvidence(
    'data-quality:summary',
    'data-quality',
    now,
    'workflow:weekly-report',
  );
  const evidenceIds = [qualityEvidence.id, ...new Set(sourceEvidence.map((item) => item.id))];
  const limitations = [
    '本区块只汇总已读取 section 的缺失维度、provider freshness 和复盘未知项，不把未知折算为 0。',
    '现金流与公司行动完整性依赖账户绩效事实；当前只展示其 section 缺口，不从缺少告警推断“完整”。',
    `provider freshness unknown 证据数：${unknownFreshness}；unavailable 证据数：${unavailableFreshness}。`,
  ];
  if (input.scope.kind === 'account') {
    limitations.push('SignalObservation 仍无 accountId，当前账户的信号质量是按持仓/交易股票投影。');
  }
  if (listLimitCount > 0) {
    limitations.push(`${listLimitCount} 个账户的交易列表达到读取上限，交易明细覆盖不完整。`);
  }
  if (reviewUnknowns.length > 0) {
    limitations.push(`复盘工具报告 ${reviewUnknowns.length} 条未知或覆盖提示。`);
  }
  const status = missingDimensions.length === 0 ? 'complete' : 'partial';
  return {
    evidence: [qualityEvidence],
    section: {
      key: 'data-quality',
      title: '数据质量',
      required: false,
      status,
      dataAsOf: now,
      blocks: [
        {
          kind: 'metrics',
          items: [
            { key: 'sectionsChecked', label: '检查区块数', value: sourceSections.length },
            {
              key: 'partialSections',
              label: 'partial 区块数',
              value: sourceSections.filter((section) => section.status === 'partial').length,
            },
            {
              key: 'unavailableSections',
              label: 'unavailable 区块数',
              value: sourceSections.filter((section) => section.status === 'unavailable').length,
            },
            { key: 'missingDimensions', label: '缺失维度数', value: missingDimensions.length },
            { key: 'reportedPriceGaps', label: '已报告缺价/行情缺口', value: reportedPriceGaps },
            {
              key: 'reportedCashFlowCorporateActionGaps',
              label: '已报告现金流/公司行动缺口',
              value: reportedCashFlowCorporateActionGaps,
            },
            {
              key: 'accountsRequested',
              label: '账户数',
              value: data.accountListError === undefined ? data.accountIds.length : null,
            },
            {
              key: 'accountsCovered',
              label: '复盘覆盖账户',
              value: data.accountListError === undefined ? reviewEntries.length : null,
            },
            { key: 'signalSamples', label: 'Signal 样本数', value: signal?.total ?? null },
            { key: 'signalPending', label: '未到期 Signal', value: signal?.pending ?? null },
            {
              key: 'signalUnavailable',
              label: '不可用 Signal',
              value: signal?.unavailable ?? null,
            },
            {
              key: 'signalMissingRate',
              label: 'Signal 缺失率',
              value: signal === undefined || signal.total === 0 ? null : signal.missingRate,
              unit: 'ratio',
            },
            {
              key: 'benchmarkUnavailable',
              label: 'Benchmark 不可用周期数',
              value: benchmarkUnavailable,
            },
            {
              key: 'advicePending',
              label: '待回填 Advice',
              value: accountReview?.advice.pending ?? null,
            },
            {
              key: 'tradeListLimitAccounts',
              label: '交易明细未完整账户数',
              value: data.accountListError === undefined ? listLimitCount : null,
            },
            { key: 'evidenceCount', label: '证据数', value: evidenceIds.length },
            { key: 'freshnessUnknown', label: 'freshness unknown', value: unknownFreshness },
            {
              key: 'freshnessUnavailable',
              label: 'freshness unavailable',
              value: unavailableFreshness,
            },
          ],
        },
        {
          kind: 'text',
          tone: status === 'complete' ? 'factual' : 'warning',
          text: limitations.join('；'),
        },
      ],
      evidenceIds,
      missingDimensions,
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
        const [
          market,
          account,
          alerts,
          signalOutcomes,
          strategyReview,
          autonomyActions,
          adviceOutcomes,
          events,
          decisionLoopData,
        ] = await Promise.all([
          marketWeekSection(dates, generatedAt, ctx),
          accountWeekSection(input, periodStart, periodEnd, generatedAt, ctx),
          alertFeedbackSection(periodStart, generatedAt, ctx),
          signalObservationWeekSection(periodStart, periodEnd, generatedAt, ctx),
          strategyReviewWeekSection(periodStart, generatedAt, ctx),
          strategyAutonomyActionsWeekSection(periodStart, periodEnd, generatedAt, ctx),
          adviceOutcomesWeekSection(input, periodStart, periodEnd, generatedAt, ctx),
          nextWeekEventsSection(periodEnd, generatedAt, ctx),
          loadDecisionLoopScope(input, periodStart, periodEnd, ctx),
        ]);
        const tradeAttribution = tradeAttributionWeekSection(decisionLoopData, generatedAt);
        const behaviorPatterns = behaviorPatternsWeekSection(input, decisionLoopData, generatedAt);
        const dataQuality = dataQualityWeekSection(
          input,
          decisionLoopData,
          [market, account, signalOutcomes, adviceOutcomes, tradeAttribution, behaviorPatterns],
          generatedAt,
        );
        const researchChanges = unavailableSection(
          'research-changes',
          '研究变化',
          false,
          generatedAt,
          'research-notes.global-query',
          'global_version_query_unavailable',
        );
        researchChanges.section.missingDimensions = [
          missing(
            'research-notes.global-query',
            '当前尚无可靠的全局研究版本查询能力，暂不能生成周度研究变化',
            'global_version_query_unavailable',
          ),
        ];
        return [
          market,
          account,
          alerts,
          signalOutcomes,
          strategyReview,
          autonomyActions,
          adviceOutcomes,
          tradeAttribution,
          behaviorPatterns,
          dataQuality,
          researchChanges,
          events,
        ];
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
