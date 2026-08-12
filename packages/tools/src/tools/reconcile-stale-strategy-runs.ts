import {
  assessStrategyRun,
  decideStrategyRunPublication,
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

const snapshotRequestedBy = (
  run: z.infer<typeof StrategyRunSchema>,
): 'manual' | 'scheduled' | 'replay' | undefined => {
  const snapshot = run.inputSnapshot;
  if (typeof snapshot !== 'object' || snapshot === null) return undefined;
  const value = snapshot as Record<string, unknown>;
  if (
    value.requestedBy === 'manual' ||
    value.requestedBy === 'scheduled' ||
    value.requestedBy === 'replay'
  ) {
    return value.requestedBy;
  }
  return undefined;
};

const snapshotMeta = (
  run: z.infer<typeof StrategyRunSchema>,
): {
  readonly universeCount: number;
  readonly universeKind: 'full' | 'explicit';
} => {
  const snapshot = run.inputSnapshot;
  if (typeof snapshot !== 'object' || snapshot === null) {
    return { universeCount: 0, universeKind: 'full' };
  }
  const value = snapshot as Record<string, unknown>;
  const stockIds = Array.isArray(value.stockIds) ? value.stockIds : [];
  return {
    universeCount: stockIds.length,
    universeKind: value.universeKind === 'explicit' ? 'explicit' : 'full',
  };
};

export const reconcileStaleStrategyRunsTool = defineTool({
  name: 'reconcile_stale_strategy_runs',
  description: '收敛失去有效 lease 的 stale running StrategyRun；不覆盖仍持有 lease 的 owner',
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
      const owner = `stale-reconciler:${globalThis.crypto.randomUUID()}`;
      const token = await ctx.repos.strategyRun.acquireRunLeaseToken({
        strategyId: run.strategyId,
        strategyVersionId: run.strategyVersionId,
        owner,
        runId: run.id,
        now,
        leaseUntil: new Date(now.getTime() + 60_000),
      });
      if (token === null) {
        skipped += 1;
        continue;
      }
      const meta = snapshotMeta(run);
      const requestedBy = snapshotRequestedBy(run);
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
      const committed = await ctx.repos.strategyRun.commitRunWithFence({
        token,
        now,
        bundle: { run: failed, results: [], signals: [] },
      });
      if (committed === 'committed') runIds.push(run.id);
      else skipped += 1;
      await ctx.repos.strategyRun.releaseRunLease({
        strategyId: run.strategyId,
        strategyVersionId: run.strategyVersionId,
        owner,
        fence: token.fence,
      });
    }
    return {
      scanned: running.length,
      reconciled: runIds.length,
      skipped,
      runIds,
    };
  },
});
