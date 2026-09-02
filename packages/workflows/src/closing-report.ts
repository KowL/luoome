import {
  dateInShanghai,
  isHoliday,
  isWeekend,
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
  marketPulse,
  missing,
  portfolioSection,
  shanghaiDate,
  unavailableSection,
} from './opening-report.js';

export const ClosingReportInput = z.object({
  date: z.string().date().optional(),
  scope: ReportScopeSchema.default({ kind: 'all-accounts' }),
  notify: z.boolean().optional(),
  mode: z.enum(['manual', 'scheduled']).default('manual'),
});

export const ClosingReportOutput = z.object({
  report: ReportSchema,
  created: z.boolean(),
  workflowRunId: z.string(),
  notified: z.boolean(),
});

type ClosingInput = z.output<typeof ClosingReportInput>;
type ClosingOutput = z.output<typeof ClosingReportOutput>;

const nextTradingDay = (date: string): string => {
  const current = shanghaiDate(date);
  for (let offset = 1; offset <= 15; offset++) {
    const candidate = new Date(current.getTime() + offset * DAY_MS);
    if (!isWeekend(candidate) && !isHoliday(candidate)) return dateInShanghai(candidate);
  }
  throw new Error(`无法解析 ${date} 的下一 A 股交易日`);
};

const accountPerformance = async (
  input: ClosingInput,
  now: Date,
  ctx: WorkflowContext,
): Promise<ReportSectionPiece> => {
  const piece = await portfolioSection(input.scope, now, ctx, input.date);
  return {
    evidence: piece.evidence.map((item) => ({
      ...item,
      id: item.id.replace('overnight-portfolio', 'account-performance'),
      dimension: item.dimension.replace('overnight-portfolio', 'account-performance'),
    })),
    section: {
      ...piece.section,
      key: 'account-performance',
      title: '账户当日估值变化',
      evidenceIds: piece.section.evidenceIds.map((id) =>
        id.replace('overnight-portfolio', 'account-performance'),
      ),
      missingDimensions: piece.section.missingDimensions.map((item) => ({
        ...item,
        dimension: item.dimension.replace('overnight-portfolio', 'account-performance'),
      })),
    },
  };
};

const triggersSection = async (date: string, now: Date, ctx: WorkflowContext) => {
  const since = new Date(`${date}T00:00:00+08:00`);
  const result = await ctx.tools.list_watch_triggers.execute({ since, limit: 500 });
  if (!result.ok) {
    return unavailableSection(
      'important-triggers',
      '重要预警',
      true,
      now,
      'watch-triggers',
      result.error.kind,
    );
  }
  const evidence = [
    localEvidence('important-triggers:0', 'important-triggers', now, 'local/watch-triggers'),
  ];
  return {
    evidence,
    section: {
      key: 'important-triggers',
      title: '重要预警',
      required: true,
      status: 'complete' as const,
      dataAsOf: now,
      blocks: [
        {
          kind: 'list' as const,
          items: result.data.triggers.map((trigger) => ({
            title: `${trigger.stockId} · ${trigger.ruleKind}`,
            detail: `${trigger.priority} · ${trigger.deliveryStatus}`,
            entityKind: 'watch-trigger' as const,
            entityId: trigger.id,
          })),
        },
      ],
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions: [],
    },
  };
};

const adviceExpirySection = async (date: string, now: Date, ctx: WorkflowContext) => {
  const result = await ctx.tools.get_advice.execute({ includeExpired: true, limit: 500 });
  if (!result.ok) {
    return unavailableSection(
      'advice-expiry',
      '建议有效期',
      true,
      now,
      'advice',
      result.error.kind,
    );
  }
  const expiring = result.data.advices.filter(
    (advice) => dateInShanghai(advice.validUntil) === date,
  );
  const evidence = [localEvidence('advice-expiry:0', 'advice-expiry', now, 'local/advice')];
  return {
    evidence,
    section: {
      key: 'advice-expiry',
      title: '建议有效期',
      required: true,
      status: 'complete' as const,
      dataAsOf: now,
      blocks: [
        {
          kind: 'list' as const,
          items: expiring.map((advice) => ({
            title: advice.subjectId,
            detail: `有效期至 ${dateInShanghai(advice.validUntil)}`,
            entityKind: 'advice' as const,
            entityId: advice.id,
          })),
        },
      ],
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions: [],
    },
  };
};

const groupChangesSection = async (date: string, now: Date, ctx: WorkflowContext) => {
  const watchlists = await ctx.tools.list_watchlists.execute({ enabledOnly: true });
  if (!watchlists.ok) {
    return unavailableSection(
      'group-changes',
      '分组变化',
      true,
      now,
      'group-changes.history',
      watchlists.error.kind,
    );
  }

  const evidence = [];
  const missingDimensions = [];
  const rows = [];
  for (const item of watchlists.data.items) {
    const changes = await ctx.tools.list_watchlist_changes.execute({
      watchlistId: item.watchlist.id,
      limit: 50,
    });
    if (!changes.ok) {
      missingDimensions.push(
        missing(
          `group-changes.${item.watchlist.id}`,
          `${item.watchlist.name} 的同步变化不可用`,
          changes.error.kind,
        ),
      );
      continue;
    }
    const runs = changes.data.runs.filter((entry) => {
      const observedDates = [entry.run.dataAsOf, entry.run.finishedAt, entry.run.startedAt]
        .filter((value): value is Date => value !== undefined)
        .map(dateInShanghai);
      return observedDates.includes(date);
    });
    evidence.push(
      localEvidence(
        `group-changes:${item.watchlist.id}`,
        `group-changes.${item.watchlist.id}`,
        now,
        'tool/list_watchlist_changes',
      ),
    );
    if (runs.length === 0) {
      missingDimensions.push(
        missing(
          `group-changes.${item.watchlist.id}`,
          `${item.watchlist.name} 在 ${date} 没有同步运行记录`,
          'not_found',
        ),
      );
      continue;
    }
    const entered = runs.reduce((sum, entry) => sum + entry.run.enteredCount, 0);
    const exited = runs.reduce((sum, entry) => sum + entry.run.exitedCount, 0);
    const unchanged = runs.reduce((sum, entry) => sum + entry.run.unchangedCount, 0);
    const incompleteRuns = runs.filter((entry) => entry.run.status !== 'complete');
    for (const entry of incompleteRuns) {
      for (const dimension of entry.run.missingDimensions) {
        missingDimensions.push({
          ...dimension,
          dimension: `group-changes.${item.watchlist.id}.${dimension.dimension}`,
        });
      }
      if (entry.run.status === 'partial' && entry.run.missingDimensions.length === 0) {
        missingDimensions.push(
          missing(
            `group-changes.${item.watchlist.id}`,
            `${item.watchlist.name} 的同步运行仅部分完成`,
            'incomplete_coverage',
          ),
        );
      }
      if (entry.run.status === 'failed' && entry.run.missingDimensions.length === 0) {
        missingDimensions.push(
          missing(
            `group-changes.${item.watchlist.id}`,
            `${item.watchlist.name} 的同步运行失败${entry.run.error === undefined ? '' : `：${entry.run.error}`}`,
            'upstream_error',
          ),
        );
      }
    }
    rows.push({
      watchlist: item.watchlist.name,
      entered,
      exited,
      unchanged,
      runs: runs.length,
      status: incompleteRuns.length === 0 ? 'complete' : 'partial',
    });
  }

  const status = missingDimensions.length === 0 ? ('complete' as const) : ('partial' as const);
  return {
    evidence,
    section: {
      key: 'group-changes',
      title: '分组变化',
      required: true,
      status,
      dataAsOf: now,
      blocks: [
        {
          kind: 'table' as const,
          columns: [
            { key: 'watchlist', label: '分组' },
            { key: 'entered', label: '新增' },
            { key: 'exited', label: '移出' },
            { key: 'unchanged', label: '未变' },
            { key: 'runs', label: '同步次数' },
            { key: 'status', label: '状态' },
          ],
          rows,
        },
      ],
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions,
    },
  };
};

const nextEventsSection = async (date: string, now: Date, ctx: WorkflowContext) => {
  const nextDate = nextTradingDay(date);
  const from = new Date(`${nextDate}T00:00:00+08:00`);
  const to = new Date(from.getTime() + DAY_MS - 1);
  const result = await ctx.tools.list_stock_events.execute({
    from,
    to,
    status: 'scheduled',
    importance: 'important',
    limit: 500,
  });
  if (!result.ok) {
    return unavailableSection(
      'next-events',
      '下一交易日事件',
      true,
      now,
      'stock-events',
      result.error.kind,
    );
  }
  const stale = result.data.events.filter((event) => event.stale);
  const evidence = [localEvidence('next-events:0', 'next-events', now, 'local/stock-events')];
  return {
    evidence,
    section: {
      key: 'next-events',
      title: '下一交易日事件',
      required: true,
      status: stale.length === 0 ? ('complete' as const) : ('partial' as const),
      dataAsOf: now,
      blocks: [
        {
          kind: 'list' as const,
          items: result.data.events.map((event) => ({
            title: event.title,
            detail: event.stockId,
            entityKind: 'stock-event' as const,
            entityId: event.id,
          })),
        },
      ],
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions:
        stale.length === 0
          ? []
          : [missing('next-events.freshness', `${stale.length} 条事件已标记 stale`, 'stale')],
    },
  };
};

const STRATEGY_ADVICE_SOURCE_TOOL = 'analyze_strategy_candidate';

/**
 * 「策略行动」（PRD strategy-ai-managed-automation §4.1/§4.2）：
 * 事实层为当日 published operational run 的信号概览 + 当日策略 Advice 链接（entityKind='advice'，
 * 不含 Advice 决策字段名，decision 值仅以文本展示）；解读层只组装 Advice 已有 reasoning，不发起 LLM。
 */
const strategyActionsSection = async (
  date: string,
  now: Date,
  ctx: WorkflowContext,
): Promise<ReportSectionPiece> => {
  const dayStart = new Date(`${date}T00:00:00+08:00`);
  const [strategies, runs, advices] = await Promise.all([
    ctx.tools.list_strategies.execute({ filter: { status: 'active' } }),
    ctx.tools.list_strategy_runs.execute({
      scope: 'operational',
      publication: 'published',
      since: dayStart,
      limit: 500,
    }),
    ctx.tools.get_advice.execute({
      sourceTool: STRATEGY_ADVICE_SOURCE_TOOL,
      since: dayStart,
      until: new Date(dayStart.getTime() + DAY_MS - 1),
      includeExpired: true,
      limit: 500,
    }),
  ]);
  if (!strategies.ok) {
    return unavailableSection(
      'strategy-actions',
      '策略行动',
      false,
      now,
      'strategy-actions.strategies',
      strategies.error.kind,
    );
  }
  if (!runs.ok) {
    return unavailableSection(
      'strategy-actions',
      '策略行动',
      false,
      now,
      'strategy-actions.runs',
      runs.error.kind,
    );
  }
  if (!advices.ok) {
    return unavailableSection(
      'strategy-actions',
      '策略行动',
      false,
      now,
      'strategy-actions.advice',
      advices.error.kind,
    );
  }

  const dayRuns = runs.data.runs.filter((run) => dateInShanghai(run.dataAsOf) === date);
  const latestRunByStrategy = new Map<string, (typeof dayRuns)[number]>();
  for (const run of dayRuns) {
    if (!latestRunByStrategy.has(run.strategyId)) latestRunByStrategy.set(run.strategyId, run);
  }
  const dayAdvices = advices.data.advices.filter(
    (advice) => dateInShanghai(advice.createdAt) === date,
  );
  const summaryCount = (
    run: (typeof dayRuns)[number] | undefined,
    key: 'selectedCount' | 'signalCount',
  ) => {
    const value = run?.summary?.[key];
    return typeof value === 'number' ? value : null;
  };
  const evidence = [
    localEvidence('strategy-actions:runs', 'strategy-actions.runs', now, 'tool:list_strategy_runs'),
    localEvidence('strategy-actions:advice', 'strategy-actions.advice', now, 'tool:get_advice'),
  ];
  return {
    evidence,
    section: {
      key: 'strategy-actions',
      title: '策略行动',
      required: false,
      status: 'complete' as const,
      dataAsOf: now,
      blocks: [
        {
          kind: 'table' as const,
          columns: [
            { key: 'strategy', label: '策略' },
            { key: 'selectedCount', label: '入选数' },
            { key: 'signalCount', label: '信号数' },
          ],
          rows: strategies.data.strategies.map((strategy) => {
            const run = latestRunByStrategy.get(strategy.id);
            return {
              strategy: strategy.name,
              selectedCount: summaryCount(run, 'selectedCount'),
              signalCount: summaryCount(run, 'signalCount'),
            };
          }),
        },
        {
          kind: 'list' as const,
          items: dayAdvices.map((advice) => ({
            title: advice.stockName ?? advice.subjectId,
            detail: `${advice.decision} · 有效期至 ${dateInShanghai(advice.validUntil)}`,
            entityKind: 'advice' as const,
            entityId: advice.id,
          })),
        },
        {
          kind: 'text' as const,
          tone: 'factual' as const,
          text:
            dayAdvices.length === 0
              ? `${date} 无策略建议（推荐未启用、预检全部过滤或 AI 不可用均会导致无建议）。`
              : [
                  `${date} 策略建议 ${dayAdvices.length} 条：`,
                  ...dayAdvices.map(
                    (advice) =>
                      `${advice.stockName ?? advice.subjectId}：${advice.reasoning.premise}`,
                  ),
                ].join('\n'),
        },
      ],
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions: [],
    },
  };
};

const runClosingReport = async (
  input: ClosingInput,
  ctx: WorkflowContext,
): Promise<ClosingOutput | ToolResult<never>> => {
  const date = input.date ?? dateInShanghai(ctx.clock());
  const requested = shanghaiDate(date);
  if (isWeekend(requested) || isHoliday(requested)) {
    return {
      ok: false,
      error: { kind: 'invalid_input', message: `${date} 不是 A 股交易日`, issues: [] },
    };
  }
  const result = await executeReportWorkflow(
    {
      workflowName: 'closing-report',
      kind: 'closing',
      template: 'closing-v1',
      mode: input.mode,
      notify: input.notify ?? input.mode === 'scheduled',
      scope: input.scope,
      periodStart: date,
      periodEnd: date,
      title: `${date} 收盘复盘`,
      inputSummary: { marketDate: date, notify: input.notify ?? input.mode === 'scheduled' },
      buildSections: async (generatedAt) => {
        const sentiment = await ctx.tools.get_ashare_sentiment.execute({ date });
        const market = sentiment.ok
          ? marketPulse(sentiment.data.snapshot)
          : unavailableSection(
              'market-pulse',
              '市场脉搏',
              true,
              generatedAt,
              'ashare-sentiment',
              sentiment.error.kind,
            );
        const [performance, triggers, groupChanges, adviceExpiry, strategyActions, nextEvents] =
          await Promise.all([
            accountPerformance(input, generatedAt, ctx),
            triggersSection(date, generatedAt, ctx),
            groupChangesSection(date, generatedAt, ctx),
            adviceExpirySection(date, generatedAt, ctx),
            strategyActionsSection(date, generatedAt, ctx),
            nextEventsSection(date, generatedAt, ctx),
          ]);
        return [
          market,
          performance,
          triggers,
          groupChanges,
          adviceExpiry,
          strategyActions,
          nextEvents,
        ];
      },
    },
    ctx,
  );
  return 'ok' in result ? result : ClosingReportOutput.parse(result);
};

export const closingReportWorkflow = defineWorkflow<ClosingInput, ClosingOutput>({
  name: 'closing-report',
  description: '生成并幂等保存指定交易日的结构化收盘复盘',
  input: ClosingReportInput,
  steps: [(prev, ctx) => runClosingReport(prev as ClosingInput, ctx)],
});
