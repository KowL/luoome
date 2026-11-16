import type { ToolContext } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

/**
 * 策略运行产物的保留策略：
 * - 逐股明细（`results_json`）按 Strategy 保留最近 N 次运行 + 全部已发布运行；
 * - 终态信号观察（complete / unavailable）按 baselineAt 过期。
 *
 * 只删除可重建/已归档的明细，不删 run 元数据、不删 strategy_signals，
 * 因此信号历史与发布证据不受影响。默认 dryRun，避免误删。
 */
export const PruneStrategyHistoryInput = z.object({
  dryRun: z.boolean().default(true),
  keepRunsPerStrategy: z.number().int().min(1).max(5000).default(180),
  observationRetentionDays: z.number().int().min(7).max(3650).default(365),
});

export const PruneStrategyHistoryOutput = z.object({
  dryRun: z.boolean(),
  keepRunsPerStrategy: z.number().int(),
  observationRetentionDays: z.number().int(),
  strategiesScanned: z.number().int().nonnegative(),
  runsScanned: z.number().int().nonnegative(),
  runsCleared: z.number().int().nonnegative(),
  observationsMatched: z.number().int().nonnegative(),
  observationsDeleted: z.number().int().nonnegative(),
  warnings: z.array(z.string().min(1).max(300)).max(8),
});

const isPublished = (run: {
  readonly publication?: { readonly status: string } | undefined;
}): boolean => run.publication?.status === 'published';

/**
 * 保留窗口 = 最近 N 次运行 + 最近一次 published 运行。
 *
 * 注意不能用「所有 published」当豁免：legacy 归一化会把每个 complete 的 operational
 * run 都读成 published，那样等于永不清理。只有最新一条是 current 证据。
 */
export const pruneStrategyHistoryTool = defineTool({
  name: 'prune_strategy_history',
  description:
    '按保留策略清理策略运行逐股明细与过期信号观察（默认 dryRun）；不删除 run 元数据与信号',
  sideEffect: 'write',
  input: PruneStrategyHistoryInput,
  output: PruneStrategyHistoryOutput,
  handler: async (input, ctx: ToolContext) => {
    const strategies = await ctx.repos.strategy.list();
    const warnings: string[] = [];
    let runsScanned = 0;
    let runsCleared = 0;
    for (const strategy of strategies) {
      const runs = await ctx.repos.strategyRun.listRuns({
        strategyId: strategy.id,
        limit: 5000,
      });
      runsScanned += runs.length;
      const keepIds = new Set(runs.slice(0, input.keepRunsPerStrategy).map((run) => run.id));
      const latestPublished = runs.find((run) => isPublished(run));
      if (latestPublished !== undefined) keepIds.add(latestPublished.id);
      const candidates = runs.filter((run) => !keepIds.has(run.id));
      if (candidates.length === 0) continue;
      const cleared = await ctx.repos.strategyRun.clearResults(
        candidates.map((run) => run.id),
        { dryRun: input.dryRun },
      );
      runsCleared += cleared;
    }

    const cutoff = new Date(ctx.clock().getTime() - input.observationRetentionDays * 86_400_000);
    const observationsMatched = await ctx.repos.signalObservation.pruneSettledBefore(cutoff, {
      dryRun: true,
    });
    const observationsDeleted = input.dryRun
      ? 0
      : await ctx.repos.signalObservation.pruneSettledBefore(cutoff);

    if (runsScanned === 0) warnings.push('本地没有可清理的 StrategyRun');
    if (observationsMatched > 1_000_000) {
      warnings.push(
        `过期观察 ${observationsMatched} 条，删除会持有写锁较久；建议先 dryRun 确认后分批执行`,
      );
    }
    if (input.keepRunsPerStrategy < 30) {
      warnings.push('keepRunsPerStrategy < 30 会清掉近一个月的逐股明细，排障时可能无据可查');
    }

    return {
      dryRun: input.dryRun,
      keepRunsPerStrategy: input.keepRunsPerStrategy,
      observationRetentionDays: input.observationRetentionDays,
      strategiesScanned: strategies.length,
      runsScanned,
      runsCleared,
      observationsMatched,
      observationsDeleted,
      warnings,
    };
  },
});
