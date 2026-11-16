import {
  assessStrategyRun,
  decideStrategyRunPublication,
  readStrategyRunSnapshot,
  StrategyRunSchema,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

export const ReconcileStaleStrategyRunsInput = z.object({
  olderThanMinutes: z
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .default(30),
  limit: z.number().int().min(1).max(100).default(20),
});
export const ReconcileStaleStrategyRunsOutput = z.object({
  scanned: z.number().int().nonnegative(),
  reconciled: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  runIds: z.array(z.string()),
});

const snapshotMeta = (
  run: z.infer<typeof StrategyRunSchema>,
): {
  readonly universeCount: number;
  readonly universeKind: 'full' | 'explicit';
} => {
  const snapshot = readStrategyRunSnapshot(run.inputSnapshot);
  return {
    universeCount: snapshot.stockIds.length,
    universeKind: snapshot.universeKind ?? 'full',
  };
};

export const reconcileStaleStrategyRunsTool = defineTool({
  name: 'reconcile_stale_strategy_runs',
  description: '收敛 startedAt 超时的 stale running StrategyRun；单进程以内存互斥防重入',
  sideEffect: 'write',
  input: ReconcileStaleStrategyRunsInput,
  output: ReconcileStaleStrategyRunsOutput,
  handler: async (input, ctx: ToolContext) => {
    const now = ctx.clock();
    const cutoff = new Date(now.getTime() - input.olderThanMinutes * 60_000);
    const running = await ctx.repos.strategyRun.listRuns({ status: 'running', limit: input.limit });
    let skipped = 0;
    const runIds: string[] = [];
    for (const run of running) {
      if (run.startedAt > cutoff) {
        skipped += 1;
        continue;
      }
      const meta = snapshotMeta(run);
      const requestedBy = readStrategyRunSnapshot(run.inputSnapshot).requestedBy;
      const finishedAt = new Date(
        Math.max(now.getTime(), run.dataAsOf.getTime(), run.startedAt.getTime()),
      );
      const acceptance = assessStrategyRun({
        status: 'failed',
        universeCount: meta.universeCount,
        evaluatedCount: 0,
        failedCount: meta.universeCount,
        incompleteCount: 0,
        assessedAt: finishedAt,
      });
      const failed = StrategyRunSchema.parse({
        ...run,
        finishedAt,
        status: 'failed',
        summary: {
          schemaVersion: 4,
          dataHealth: 'unavailable',
          universeCount: meta.universeCount,
          evaluatedCount: 0,
          selectedCount: 0,
          signalCount: 0,
          incompleteCount: 0,
          failedCount: meta.universeCount,
          failureSamples: [],
          acceptance,
        },
        publication: decideStrategyRunPublication({
          scope:
            run.scope ??
            (run.mode === 'replay' || run.mode === 'backtest' ? 'evaluation' : 'operational'),
          universeKind: meta.universeKind,
          status: 'failed',
          universeCheckpointPresent: false,
          acceptance,
          ...(requestedBy === undefined ? {} : { requestedBy }),
          decidedAt: finishedAt,
        }),
        error: 'stale_strategy_run_reconciled',
      });
      await ctx.repos.strategyRun.commitRun({ run: failed, results: [], signals: [] });
      runIds.push(run.id);
    }
    return {
      scanned: running.length,
      reconciled: runIds.length,
      skipped,
      runIds,
    };
  },
});
