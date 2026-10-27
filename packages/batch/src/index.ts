// DSH/MCP 共用的确定性批处理入口；不加入领域 tool registry。
//
// 单机形态不再有常驻定时器进程：批处理由 DSH 的定时任务触发，
// DSH 提醒唤起会话后调用这里的工具，工具内部跑既有的领域工作流。
// 门槛判定（交易日、盘后小时、周几）与调度器保持同一口径。

import {
  dateInShanghai,
  isAshareTradingSession,
  isHoliday,
  isWeekend,
  previousTradingDate,
  type ToolContext,
  type WorkflowRun,
} from '@luoome/core';
import {
  defineTool,
  errInvalidInput,
  errNotFound,
  GetStrategyEvaluationProgressOutput,
  getStrategyEvaluationProgressTool,
  getStrategyEvaluationSessionTool,
} from '@luoome/tools';
import {
  closingReportCutoffWorkflow,
  intradayTradingPlanWatchWorkflow,
  ReplayStrategyRangeOutput,
  replayStrategyRangeWorkflow,
  snapshotAccountPerformanceWorkflow,
  strategyAutonomyWeeklyWorkflow,
  strategyDailyCycleWorkflow,
} from '@luoome/workflows';
import { z } from 'zod';

export const BatchInput = z
  .object({
    /** 忽略时间门槛立即执行（手工补跑用）。 */
    force: z.boolean().optional(),
    accountId: z.string().min(1).optional(),
  })
  .strict();

const BatchOutput = z.object({
  /** due：门槛通过并已执行；skipped：未到时间/非交易日；failed：执行失败。 */
  outcome: z.enum(['due', 'skipped', 'partial', 'failed']),
  reason: z.string(),
  summary: z.record(z.string(), z.unknown()).optional(),
});

const shanghaiHour = (date: Date): number =>
  new Date(date.getTime() + 8 * 60 * 60 * 1_000).getUTCHours();

/** 盘后快照的门槛：收盘后的小时数。 */
const PORTFOLIO_PERFORMANCE_CLOSE_HOUR_SHANGHAI = 16;

/** 策略自治周报的执行日：周日。 */
const isStrategyAutonomyDueDay = (now: Date): boolean =>
  new Date(now.getTime() + 8 * 60 * 60 * 1_000).getUTCDay() === 0;

/** 每周一条确定性 run id，崩溃重试不会重复写事实。 */
const strategyAutonomyWeeklyRunId = (now: Date): string =>
  `strategy-autonomy-weekly:${dateInShanghai(now)}`;

const failureText = (error: { kind?: unknown; message?: unknown }): string =>
  typeof error.message === 'string'
    ? error.message
    : typeof error.kind === 'string'
      ? error.kind
      : 'unknown_error';

export const runStrategyDailyCycleTool = defineTool({
  name: 'run_strategy_daily_cycle',
  description:
    '执行全局策略日循环：认领到期的策略计划并写运行事实；账户计划和报告限 accountId（省略则所有账户）。非交易日跳过，不下单。',
  sideEffect: 'write',
  requiredCapabilities: ['write', 'external'],
  input: BatchInput,
  output: BatchOutput,
  handler: async (input, ctx) => {
    const now = ctx.clock();
    if (!input.force && (isWeekend(now) || isHoliday(now))) {
      return { outcome: 'skipped' as const, reason: '非交易日' };
    }
    const result = await strategyDailyCycleWorkflow.run(
      {
        owner: `dsh-batch:${globalThis.crypto.randomUUID()}`,
        limit: 100,
        ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
      },
      ctx,
    );
    if (!result.ok) {
      ctx.logger.error('策略日循环批处理失败', { error: result.error });
      return { outcome: 'failed' as const, reason: failureText(result.error) };
    }
    return {
      outcome:
        result.data.failed > 0 || result.data.partial > 0
          ? result.data.complete > 0 || result.data.partial > 0
            ? ('partial' as const)
            : ('failed' as const)
          : ('due' as const),
      reason: '策略日循环已执行',
      summary: {
        complete: result.data.complete,
        partial: result.data.partial,
        skipped: result.data.skipped,
        failed: result.data.failed,
      },
    };
  },
});

export const runClosingReportCutoffTool = defineTool({
  name: 'run_closing_report_cutoff',
  description: '执行收盘报告截止：补投前一交易日的缺口，并封存当日收盘报告。非交易日自动跳过。',
  sideEffect: 'write',
  requiredCapabilities: ['write', 'external'],
  input: BatchInput,
  output: BatchOutput,
  handler: async (input, ctx) => {
    const now = ctx.clock();
    if (!input.force && (isWeekend(now) || isHoliday(now))) {
      return { outcome: 'skipped' as const, reason: '非交易日' };
    }
    const priorDate = previousTradingDate(now);
    const recovered = await closingReportCutoffWorkflow.run(
      { date: priorDate, accountId: input.accountId },
      ctx,
    );
    const result = await closingReportCutoffWorkflow.run({ accountId: input.accountId }, ctx);
    if (!result.ok) {
      ctx.logger.error('收盘报告截止批处理失败', { error: result.error });
      return { outcome: 'failed' as const, reason: failureText(result.error) };
    }
    return {
      outcome:
        !recovered.ok || recovered.data.failed.length > 0 || result.data.failed.length > 0
          ? ('partial' as const)
          : ('due' as const),
      reason: '收盘报告截止已执行',
      summary: {
        date: result.data.date,
        created: result.data.created.length,
        failed: result.data.failed.length,
        recoveredFailed: recovered.ok ? recovered.data.failed.length : null,
      },
    };
  },
});

export const runPortfolioPerformanceSnapshotTool = defineTool({
  name: 'run_portfolio_performance_snapshot',
  description: '执行账户绩效快照：收盘后为每个账户落一条当日绩效事实。未到盘后时间自动跳过。',
  sideEffect: 'write',
  requiredCapabilities: ['write', 'external'],
  input: BatchInput,
  output: BatchOutput,
  handler: async (input, ctx) => {
    const now = ctx.clock();
    const tradingDay = dateInShanghai(now);
    if (
      !input.force &&
      (shanghaiHour(now) < PORTFOLIO_PERFORMANCE_CLOSE_HOUR_SHANGHAI ||
        isWeekend(now) ||
        isHoliday(now))
    ) {
      return { outcome: 'skipped' as const, reason: '未到盘后时间或非交易日' };
    }
    const result = await snapshotAccountPerformanceWorkflow.run(
      {
        to: tradingDay,
        mode: 'scheduled',
        ...(input.accountId === undefined ? {} : { accountIds: [input.accountId] }),
      },
      ctx,
    );
    if (!result.ok) {
      ctx.logger.error('账户绩效快照批处理失败', { error: result.error });
      return { outcome: 'failed' as const, reason: failureText(result.error) };
    }
    return {
      outcome:
        result.data.failedAccounts > 0 || result.data.partialAccounts > 0
          ? result.data.completedAccounts > 0 || result.data.partialAccounts > 0
            ? ('partial' as const)
            : ('failed' as const)
          : ('due' as const),
      reason: '账户绩效快照已执行',
      summary: {
        tradingDay,
        completedAccounts: result.data.completedAccounts,
        partialAccounts: result.data.partialAccounts,
        failedAccounts: result.data.failedAccounts,
        createdSnapshots: result.data.createdSnapshots,
        reusedSnapshots: result.data.reusedSnapshots,
      },
    };
  },
});

export const runIntradayPlanBatchTool = defineTool({
  name: 'run_intraday_plan_batch',
  description: '执行盘中计划批处理：为每个账户跑一次盘中交易计划与盯盘。非盘中时段自动跳过。',
  sideEffect: 'write',
  requiredCapabilities: ['write', 'external'],
  input: BatchInput,
  output: BatchOutput,
  handler: async (input, ctx) => {
    const now = ctx.clock();
    if (!input.force && !isAshareTradingSession(now)) {
      return { outcome: 'skipped' as const, reason: '非盘中时段' };
    }
    const accounts = (await ctx.repos.account.list()).filter(
      (account) => input.accountId === undefined || account.id === input.accountId,
    );
    let complete = 0;
    const failed: string[] = [];
    for (const account of accounts) {
      const result = await intradayTradingPlanWatchWorkflow.run({ accountId: account.id }, ctx);
      if (!result.ok) {
        failed.push(`${account.id}:${failureText(result.error)}`);
        continue;
      }
      if (result.data.status === 'complete') complete += 1;
      else failed.push(`${account.id}:${result.data.status}`);
    }
    return {
      outcome:
        failed.length === 0
          ? ('due' as const)
          : complete === 0
            ? ('failed' as const)
            : ('partial' as const),
      reason: '盘中计划批处理已执行',
      summary: { accounts: accounts.length, complete, failed: failed.length },
    };
  },
});

export const runStrategyAutonomyWeeklyTool = defineTool({
  name: 'run_strategy_autonomy_weekly',
  description:
    '执行全局策略自治：按既有规则暂停/归档策略、推进存量验证与符合门禁的版本发布；周报限 accountId（省略则全部账户）。周日执行，不下单，不生成 AI 提案。',
  sideEffect: 'write',
  requiredCapabilities: ['write', 'external'],
  input: BatchInput,
  output: BatchOutput,
  handler: async (input, ctx) => {
    const now = ctx.clock();
    if (!input.force && !isStrategyAutonomyDueDay(now)) {
      return { outcome: 'skipped' as const, reason: '非策略自治执行日' };
    }
    const runId = `${strategyAutonomyWeeklyRunId(now)}${input.accountId === undefined ? '' : `:${input.accountId}`}`;
    const existing = await ctx.repos.workflowRun.findById(runId);
    if (existing !== null && existing.status !== 'failed' && !input.force) {
      return { outcome: 'skipped' as const, reason: '本周已执行' };
    }
    const startedAt = ctx.clock();
    const base: WorkflowRun = {
      id: runId,
      workflowName: 'strategy-autonomy-weekly',
      mode: 'scheduled',
      status: 'running',
      startedAt,
      providerStatuses: [],
    };
    await ctx.repos.workflowRun.save(base);
    const result = await strategyAutonomyWeeklyWorkflow.run(
      { mode: 'scheduled', accountId: input.accountId },
      ctx,
    );
    const finishedAt = ctx.clock();
    if (!result.ok) {
      await ctx.repos.workflowRun.save({
        ...base,
        status: 'failed',
        finishedAt,
        error: failureText(result.error),
      });
      ctx.logger.error('策略自治周报批处理失败', { runId, error: result.error });
      return { outcome: 'failed' as const, reason: failureText(result.error) };
    }
    const failedCount =
      result.data.failed +
      result.data.archive.failed +
      result.data.proposals.failed +
      result.data.validation.failed +
      result.data.promotion.failed +
      (result.data.weeklyReport?.status === 'failed' ? 1 : 0);
    await ctx.repos.workflowRun.save({
      ...base,
      status: failedCount > 0 ? 'partial' : 'succeeded',
      finishedAt,
      outputSummary: {
        evaluated: result.data.evaluated,
        paused: result.data.paused,
        promotionPublished: result.data.promotion.published,
        weeklyReport: result.data.weeklyReport?.status,
      },
    });
    return {
      outcome: failedCount > 0 ? ('partial' as const) : ('due' as const),
      reason: '策略自治周报已执行',
      summary: {
        evaluated: result.data.evaluated,
        paused: result.data.paused,
        failed: failedCount,
      },
    };
  },
});

export const RunStrategyEvaluationInput = z
  .object({
    strategyId: z.string().min(1),
    sessionId: z.string().min(1),
    maxDays: z.number().int().min(1).max(20).default(5),
  })
  .strict();
export const RunStrategyEvaluationOutput = z.object({
  progress: GetStrategyEvaluationProgressOutput,
  advanced: ReplayStrategyRangeOutput.optional(),
});
export const runStrategyEvaluationTool = defineTool({
  name: 'run_strategy_evaluation',
  description:
    '推进已确认的历史研究 session，单次最多 20 个交易日；复用 PIT replay 工作流并保留 checkpoint，可取消/断点恢复，不发布当前股票池',
  sideEffect: 'write',
  requiredCapabilities: ['write', 'external'],
  input: RunStrategyEvaluationInput,
  output: RunStrategyEvaluationOutput,
  handler: async (input, ctx) => {
    const found = await getStrategyEvaluationSessionTool.execute(
      { sessionId: input.sessionId },
      ctx,
    );
    if (!found.ok) return found;
    const session = found.data.session;
    if (session === null) return errNotFound('StrategyEvaluationSession', input.sessionId);
    if (session.strategyId !== input.strategyId)
      return errInvalidInput('session 不属于该 Strategy');
    if (session.status !== 'running' && session.status !== 'complete')
      return errInvalidInput('请先显式 resume_strategy_evaluation_session，再推进未完成日期');
    const result =
      session.status === 'complete'
        ? null
        : await replayStrategyRangeWorkflow.run(
            {
              strategyId: session.strategyId,
              versionId: session.strategyVersionId,
              from: session.from,
              to: session.to,
              ...(session.stockIds === undefined ? {} : { stockIds: session.stockIds }),
              persist: true,
              resumeSessionId: session.id,
              maxDays: input.maxDays,
            },
            ctx,
          );
    if (result !== null && !result.ok) return result;
    const progress = await getStrategyEvaluationProgressTool.execute(
      { strategyId: session.strategyId, sessionId: session.id },
      ctx,
    );
    if (!progress.ok) return progress;
    return { progress: progress.data, ...(result?.ok ? { advanced: result.data } : {}) };
  },
});

/** 批处理工具清单：只给写面（设置面/批处理面）暴露。 */
export const batchTools = [
  runStrategyDailyCycleTool,
  runClosingReportCutoffTool,
  runPortfolioPerformanceSnapshotTool,
  runIntradayPlanBatchTool,
  runStrategyAutonomyWeeklyTool,
] as const;

/** 批处理工具是否应当出现在当前暴露面里。 */
export const isBatchToolName = (name: string): boolean =>
  batchTools.some((tool) => tool.name === name);

export type BatchToolContext = ToolContext;
