import type { StrategyRun, ToolContext } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

const DAY_MS = 86_400_000;

export const PruneStrategyRunsInput = z
  .object({
    /** 只清理评估类运行；发布运行（operational）永不参与保留期清理。 */
    scope: z.literal('evaluation').default('evaluation'),
    /** 每个策略保留最近多少次运行。 */
    keepPerStrategy: z.number().int().min(1).max(500).default(10),
    /** 最近多少天内的运行一律保留。 */
    olderThanDays: z.number().int().min(0).max(3650).default(30),
    /** 默认只演练：返回将删除的运行，不落库。 */
    dryRun: z.boolean().default(true),
    limitPerStrategy: z.number().int().min(1).max(1000).default(200),
  })
  .strict();
export const PruneStrategyRunsOutput = z.object({
  scope: z.literal('evaluation'),
  dryRun: z.boolean(),
  scanned: z.number().int().nonnegative(),
  kept: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  runIds: z.array(z.string()),
  byStrategy: z.array(
    z.object({
      strategyId: z.string().min(1),
      kept: z.number().int().nonnegative(),
      deleted: z.number().int().nonnegative(),
    }),
  ),
});

export const selectExpiredRuns = (
  runs: readonly StrategyRun[],
  keepPerStrategy: number,
  cutoff: Date,
): { kept: StrategyRun[]; expired: StrategyRun[] } => {
  // 仓储按 startedAt 倒序返回；最新 N 次与窗口内的运行一律保留。
  const kept: StrategyRun[] = [];
  const expired: StrategyRun[] = [];
  runs.forEach((run, index) => {
    if (index < keepPerStrategy || run.startedAt >= cutoff) kept.push(run);
    else expired.push(run);
  });
  return { kept, expired };
};

export const pruneStrategyRunsTool = defineTool({
  name: 'prune_strategy_runs',
  description:
    '按策略清理过期的评估运行（运行、逐股结果与信号）；保留最近 N 次与最近天数内的运行，operational 发布运行永不删除；默认 dryRun 只演练',
  sideEffect: 'write',
  input: PruneStrategyRunsInput,
  output: PruneStrategyRunsOutput,
  handler: async (input, ctx: ToolContext) => {
    const cutoff = new Date(ctx.clock().getTime() - input.olderThanDays * DAY_MS);
    const strategies = await ctx.repos.strategy.list();
    const runIds: string[] = [];
    const byStrategy: { strategyId: string; kept: number; deleted: number }[] = [];
    let scanned = 0;
    let kept = 0;
    for (const strategy of strategies) {
      const runs = await ctx.repos.strategyRun.listRuns({
        strategyId: strategy.id,
        scope: input.scope,
        limit: input.limitPerStrategy,
      });
      scanned += runs.length;
      const selected = selectExpiredRuns(runs, input.keepPerStrategy, cutoff);
      kept += selected.kept.length;
      if (selected.expired.length === 0) continue;
      byStrategy.push({
        strategyId: strategy.id,
        kept: selected.kept.length,
        deleted: selected.expired.length,
      });
      runIds.push(...selected.expired.map((run) => run.id));
    }
    if (!input.dryRun && runIds.length > 0) await ctx.repos.strategyRun.deleteRuns(runIds);
    return {
      scope: input.scope,
      dryRun: input.dryRun,
      scanned,
      kept,
      deleted: runIds.length,
      runIds,
      byStrategy,
    };
  },
});
