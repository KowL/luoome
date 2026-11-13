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
});
export type ReplayStrategyRangeInputT = z.infer<typeof ReplayStrategyRangeInput>;

export const ReplayStrategyRangeOutput = z.object({
  status: z.enum(['complete', 'partial', 'failed']),
  summary: z.object({
    tradingDays: z.number().int().nonnegative(),
    completedDays: z.number().int().nonnegative(),
    failedDays: z.number().int().nonnegative(),
    evaluatedCount: z.number().int().nonnegative(),
    selectedCount: z.number().int().nonnegative(),
    signalCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
  }),
  days: z.array(
    z.object({
      dataAsOf: z.coerce.date(),
      status: z.enum(['complete', 'failed']),
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
  const stockIds = normalizeStockIds(input.stockIds);
  const days: z.infer<typeof ReplayStrategyRangeOutput>['days'] = [];
  let failed = false;
  let cursor = new Date(input.from);
  while (cursor <= input.to) {
    const dataAsOf = new Date(cursor);
    if (isWeekend(dataAsOf) || isHoliday(dataAsOf)) {
      cursor = new Date(cursor.getTime() + DAY_MS);
      continue;
    }
    // dataAsOf 是交易日 key（UTC 零点）；日线是盘后同步的固定事实，
    // 回放只按 dataAsOf 截断，不再依赖 revision 时点。
    const run = await ctx.tools.run_strategy.execute({
      strategyId: input.strategyId,
      ...(input.versionId === undefined ? {} : { versionId: input.versionId }),
      mode: 'replay',
      asOf: dataAsOf,
      universeAsOf: endOfDay(dataAsOf),
      ...(stockIds === undefined ? {} : { stockIds }),
      persist: input.persist,
    });
    if (!run.ok) {
      failed = true;
      days.push({
        dataAsOf,
        status: 'failed',
        error: errorText(run.error),
      });
    } else {
      const dayStatus =
        run.data.run.status === 'failed' ? ('failed' as const) : ('complete' as const);
      if (dayStatus === 'failed') failed = true;
      const counts = runCounts(run.data.run.summary);
      days.push({
        dataAsOf,
        status: dayStatus,
        ...(input.persist ? { runId: run.data.run.id } : {}),
        ...(dayStatus === 'failed' ? { error: run.data.run.error } : {}),
        ...(counts ?? {}),
      });
    }
    cursor = new Date(cursor.getTime() + DAY_MS);
  }
  const completed = days.filter((day) => day.status === 'complete').length;
  return ReplayStrategyRangeOutput.parse({
    status: failed ? (completed > 0 ? 'partial' : 'failed') : 'complete',
    summary: {
      tradingDays: days.length,
      completedDays: completed,
      failedDays: days.length - completed,
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
  description: '按 PIT universe 与日线 revision cutoff 逐日 replay Strategy',
  input: ReplayStrategyRangeInput,
  steps: [replay],
});
