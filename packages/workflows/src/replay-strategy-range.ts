import { createHash } from 'node:crypto';
import { isHoliday, isWeekend } from '@luoome/core';
import { z } from 'zod';

import { defineWorkflow, type WorkflowStep } from './define-workflow.js';

const DAY_MS = 86_400_000;
const endOfDay = (date: Date): Date => new Date(date.getTime() + DAY_MS - 1);

export const ReplayStrategyRangeInput = z.object({
  strategyId: z.string().min(1),
  versionId: z.string().min(1).optional(),
  from: z.coerce.date(),
  to: z.coerce.date(),
  stockIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  persist: z.boolean().default(true),
  resumeSessionId: z.string().min(1).optional(),
  owner: z.string().min(1).optional(),
});
export type ReplayStrategyRangeInputT = z.infer<typeof ReplayStrategyRangeInput>;

export const ReplayStrategyRangeOutput = z.object({
  sessionId: z.string(),
  status: z.enum(['complete', 'partial', 'failed']),
  summary: z.object({
    tradingDays: z.number().int().nonnegative(),
    completedDays: z.number().int().nonnegative(),
    failedDays: z.number().int().nonnegative(),
    vintageAvailableDays: z.number().int().nonnegative(),
    vintageUnavailableDays: z.number().int().nonnegative(),
    evaluatedCount: z.number().int().nonnegative(),
    selectedCount: z.number().int().nonnegative(),
    signalCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
  }),
  days: z.array(
    z.object({
      dataAsOf: z.coerce.date(),
      status: z.enum(['complete', 'failed']),
      vintageStatus: z.enum(['not-applicable', 'available', 'unavailable']),
      runId: z.string().optional(),
      error: z.string().optional(),
      evaluatedCount: z.number().int().nonnegative().optional(),
      selectedCount: z.number().int().nonnegative().optional(),
      signalCount: z.number().int().nonnegative().optional(),
      failedCount: z.number().int().nonnegative().optional(),
    }),
  ),
});
export type ReplayStrategyRangeOutputT = z.infer<typeof ReplayStrategyRangeOutput>;

const errorText = (error: {
  readonly kind?: unknown;
  readonly message?: unknown;
  readonly cause?: unknown;
}): string =>
  typeof error.message === 'string'
    ? error.message
    : typeof error.cause === 'string'
      ? error.cause
      : String(error.kind ?? 'unknown error');

const normalizeStockIds = (stockIds: readonly string[] | undefined): string[] | undefined =>
  stockIds === undefined ? undefined : [...new Set(stockIds)].sort();

const stockIdChecksum = (stockIds: readonly string[]): string =>
  createHash('sha256').update(JSON.stringify(stockIds)).digest('hex');

const runCounts = (
  summary: unknown,
): {
  evaluatedCount: number;
  selectedCount: number;
  signalCount: number;
  failedCount: number;
} | null => {
  if (typeof summary !== 'object' || summary === null) return null;
  const { evaluatedCount, selectedCount, signalCount, failedCount } = summary as Readonly<
    Record<string, unknown>
  >;
  return typeof evaluatedCount === 'number' &&
    typeof selectedCount === 'number' &&
    typeof signalCount === 'number' &&
    typeof failedCount === 'number'
    ? { evaluatedCount, selectedCount, signalCount, failedCount }
    : null;
};

const replay: WorkflowStep = async (previous, ctx) => {
  const input = previous as ReplayStrategyRangeInputT;
  if (input.from > input.to) {
    return { ok: false, error: { kind: 'invalid_input', message: 'from 不能晚于 to', issues: [] } };
  }
  const requestedStockIds = normalizeStockIds(input.stockIds);
  const requestedStockIdChecksum =
    requestedStockIds === undefined ? undefined : stockIdChecksum(requestedStockIds);
  const session =
    input.resumeSessionId === undefined
      ? await ctx.tools.start_strategy_evaluation_session.execute(input)
      : await ctx.tools.get_strategy_evaluation_session
          .execute({
            sessionId: input.resumeSessionId,
          })
          .then((result) =>
            !result.ok
              ? result
              : result.data.session === null
                ? {
                    ok: false as const,
                    error: {
                      kind: 'not_found' as const,
                      entity: 'StrategyEvaluationSession',
                      id: input.resumeSessionId,
                    },
                  }
                : { ok: true as const, data: { session: result.data.session } },
          );
  if (!session.ok) return session;
  const evaluationSession = session.data.session;
  if (input.resumeSessionId !== undefined) {
    if (evaluationSession.status !== 'running') {
      return {
        ok: false,
        error: {
          kind: 'invalid_input',
          message: `只能续跑 running evaluation session：${evaluationSession.id}`,
          issues: [],
        },
      };
    }
    if (
      evaluationSession.strategyId !== input.strategyId ||
      (input.versionId !== undefined && evaluationSession.strategyVersionId !== input.versionId) ||
      evaluationSession.from.getTime() !== input.from.getTime() ||
      evaluationSession.to.getTime() !== input.to.getTime() ||
      (requestedStockIds === undefined
        ? evaluationSession.stockIds !== undefined
        : evaluationSession.stockIds === undefined ||
          evaluationSession.stockIdChecksum !== requestedStockIdChecksum ||
          JSON.stringify(evaluationSession.stockIds) !== JSON.stringify(requestedStockIds))
    ) {
      return {
        ok: false,
        error: {
          kind: 'invalid_input',
          message: 'resume evaluation session 与请求的 strategy/version/from/to/stockIds 不一致',
          issues: [],
        },
      };
    }
  }
  const effectiveStrategyId = evaluationSession.strategyId;
  const effectiveVersionId = evaluationSession.strategyVersionId;
  const effectiveStockIds = evaluationSession.stockIds;
  const days: z.infer<typeof ReplayStrategyRangeOutput>['days'] = [];
  const previousDays = await ctx.tools.list_strategy_evaluation_days.execute({
    sessionId: evaluationSession.id,
  });
  if (!previousDays.ok) return previousDays;
  const completedDays = new Set(
    previousDays.data.days
      .filter((day) => day.status === 'complete')
      .map((day) => day.dataAsOf.toISOString()),
  );
  let cursor = new Date(input.from);
  let failed = false;
  let cancelled = false;
  while (cursor <= input.to) {
    const dataAsOf = new Date(cursor);
    if (isWeekend(dataAsOf) || isHoliday(dataAsOf)) {
      cursor = new Date(cursor.getTime() + 86_400_000);
      continue;
    }
    if (completedDays.has(dataAsOf.toISOString())) {
      const existing = previousDays.data.days.find(
        (day) => day.dataAsOf.toISOString() === dataAsOf.toISOString(),
      );
      const detail =
        existing?.runId === undefined
          ? null
          : await ctx.tools.get_strategy_run.execute({ runId: existing.runId });
      if (detail !== null && !detail.ok) return detail;
      const counts = detail === null ? null : runCounts(detail.data.run.summary);
      days.push({
        dataAsOf,
        status: 'complete',
        vintageStatus: existing?.vintageStatus ?? 'unavailable',
        ...(existing?.runId === undefined ? {} : { runId: existing.runId }),
        ...(existing?.evaluatedCount === undefined && counts?.evaluatedCount === undefined
          ? {}
          : { evaluatedCount: existing?.evaluatedCount ?? counts?.evaluatedCount }),
        ...(existing?.selectedCount === undefined && counts?.selectedCount === undefined
          ? {}
          : { selectedCount: existing?.selectedCount ?? counts?.selectedCount }),
        ...(existing?.signalCount === undefined && counts?.signalCount === undefined
          ? {}
          : { signalCount: existing?.signalCount ?? counts?.signalCount }),
        ...(existing?.failedCount === undefined && counts?.failedCount === undefined
          ? {}
          : { failedCount: existing?.failedCount ?? counts?.failedCount }),
      });
      cursor = new Date(cursor.getTime() + 86_400_000);
      continue;
    }
    const currentSession = await ctx.tools.get_strategy_evaluation_session.execute({
      sessionId: evaluationSession.id,
    });
    if (!currentSession.ok) return currentSession;
    if (currentSession.data.session === null || currentSession.data.session.status !== 'running') {
      cancelled = true;
      break;
    }
    const startedDay = await ctx.tools.record_strategy_evaluation_day.execute({
      sessionId: evaluationSession.id,
      dataAsOf,
      status: 'running',
    });
    if (!startedDay.ok) return startedDay;
    // dataAsOf is the trading-day key at 00:00 UTC; an immutable universe snapshot
    // recorded during that trading day is valid for its end-of-day replay.
    const pit = await ctx.tools.get_strategy_pit_universe.execute({ asOf: endOfDay(dataAsOf) });
    if (!pit.ok) {
      failed = true;
      days.push({
        dataAsOf,
        status: 'failed',
        vintageStatus: 'unavailable',
        error: errorText(pit.error),
      });
      await ctx.tools.record_strategy_evaluation_day.execute({
        sessionId: evaluationSession.id,
        dataAsOf,
        vintageStatus: 'unavailable',
        status: 'failed',
        evaluatedCount: 0,
        selectedCount: 0,
        signalCount: 0,
        failedCount: 0,
        error: errorText(pit.error),
      });
      cursor = new Date(cursor.getTime() + 86_400_000);
      continue;
    }
    const prepared = await ctx.tools.prepare_strategy_data.execute({
      strategyId: effectiveStrategyId,
      asOf: dataAsOf,
      universeAsOf: endOfDay(dataAsOf),
      persistCurrentProjection: false,
      ...(effectiveStockIds === undefined ? {} : { stockIds: effectiveStockIds }),
    });
    if (!prepared.ok) {
      failed = true;
      const error = errorText(prepared.error);
      days.push({ dataAsOf, status: 'failed', vintageStatus: 'unavailable', error });
      await ctx.tools.record_strategy_evaluation_day.execute({
        sessionId: evaluationSession.id,
        dataAsOf,
        universeSyncId: pit.data.syncId,
        vintageStatus: 'unavailable',
        status: 'failed',
        evaluatedCount: 0,
        selectedCount: 0,
        signalCount: 0,
        failedCount: 0,
        error,
      });
      cursor = new Date(cursor.getTime() + 86_400_000);
      continue;
    }
    const revisionCutoff =
      prepared.data.checkpoint.vintageStatus === 'available'
        ? dataAsOf
        : (prepared.data.checkpoint.finishedAt ?? ctx.clock());
    const run = await ctx.tools.run_strategy.execute({
      strategyId: effectiveStrategyId,
      versionId: effectiveVersionId,
      mode: 'replay',
      asOf: dataAsOf,
      universeAsOf: endOfDay(dataAsOf),
      ...(effectiveStockIds === undefined ? {} : { stockIds: effectiveStockIds }),
      revisionCutoff,
      dataCheckpointId: prepared.data.checkpoint.id,
      evaluationSessionId: evaluationSession.id,
      persist: input.persist,
    });
    if (!run.ok) {
      failed = true;
      const error = errorText(run.error);
      days.push({
        dataAsOf,
        status: 'failed',
        vintageStatus: prepared.data.checkpoint.vintageStatus,
        error,
      });
      await ctx.tools.record_strategy_evaluation_day.execute({
        sessionId: evaluationSession.id,
        dataAsOf,
        universeSyncId: pit.data.syncId,
        revisionCutoff,
        vintageStatus: prepared.data.checkpoint.vintageStatus,
        status: 'failed',
        error,
      });
    } else {
      const dayStatus =
        run.data.run.status === 'failed' ? ('failed' as const) : ('complete' as const);
      if (dayStatus === 'failed') failed = true;
      const counts = runCounts(run.data.run.summary);
      days.push({
        dataAsOf,
        status: dayStatus,
        vintageStatus: prepared.data.checkpoint.vintageStatus,
        ...(input.persist ? { runId: run.data.run.id } : {}),
        ...(dayStatus === 'failed' ? { error: run.data.run.error } : {}),
        ...(counts ?? {}),
      });
      await ctx.tools.record_strategy_evaluation_day.execute({
        sessionId: evaluationSession.id,
        dataAsOf,
        ...(input.persist ? { runId: run.data.run.id } : {}),
        universeSyncId: pit.data.syncId,
        dataCheckpointId: prepared.data.checkpoint.id,
        revisionCutoff,
        vintageStatus: prepared.data.checkpoint.vintageStatus,
        status: dayStatus === 'failed' ? 'failed' : 'complete',
        ...(counts ?? {}),
        ...(dayStatus === 'failed' ? { error: run.data.run.error ?? 'replay run failed' } : {}),
      });
    }
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  const finished = cancelled
    ? await ctx.tools.get_strategy_evaluation_session.execute({ sessionId: evaluationSession.id })
    : await ctx.tools.finish_strategy_evaluation_session.execute({
        sessionId: evaluationSession.id,
        status: failed
          ? days.some((day) => day.status === 'complete')
            ? 'partial'
            : 'failed'
          : 'complete',
      });
  if (!finished.ok) return finished;
  if (finished.data.session === null) {
    return {
      ok: false,
      error: {
        kind: 'not_found',
        entity: 'StrategyEvaluationSession',
        id: evaluationSession.id,
      },
    };
  }
  const completed = days.filter((day) => day.status === 'complete').length;
  return ReplayStrategyRangeOutput.parse({
    sessionId: evaluationSession.id,
    status: finished.data.session.status === 'running' ? 'partial' : finished.data.session.status,
    summary: {
      tradingDays: days.length,
      completedDays: completed,
      failedDays: days.length - completed,
      vintageAvailableDays: days.filter((day) => day.vintageStatus === 'available').length,
      vintageUnavailableDays: days.filter((day) => day.vintageStatus === 'unavailable').length,
      evaluatedCount: days.reduce((sum, day) => sum + (day.evaluatedCount ?? 0), 0),
      selectedCount: days.reduce((sum, day) => sum + (day.selectedCount ?? 0), 0),
      signalCount: days.reduce((sum, day) => sum + (day.signalCount ?? 0), 0),
      failedCount: days.reduce((sum, day) => sum + (day.failedCount ?? 0), 0),
    },
    days,
  });
};

export const replayStrategyRangeWorkflow = defineWorkflow<
  ReplayStrategyRangeInputT,
  ReplayStrategyRangeOutputT
>({
  name: 'replay-strategy-range',
  description: '按 PIT universe 与日线 revision checkpoint 逐日 replay Strategy，支持 session 续跑',
  input: ReplayStrategyRangeInput,
  steps: [replay],
});
