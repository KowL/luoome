import { isPublishableOperationalRun, type ToolContext } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';
import { createStrategyObservationCandidatesTool } from './create-strategy-observation-candidates.js';

export const BackfillStrategyObservationCandidatesInput = z
  .object({
    strategyId: z.string().min(1).optional(),
    /** 按 StrategyRun.startedAt 的闭区间下界过滤。 */
    since: z.coerce.date().optional(),
    /** 按 StrategyRun.startedAt 的闭区间上界过滤。 */
    until: z.coerce.date().optional(),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .superRefine((input, context) => {
    if (input.since !== undefined && input.until !== undefined && input.since > input.until) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['until'],
        message: 'until 必须不早于 since',
      });
    }
  });

const BackfillRunResultSchema = z.object({
  runId: z.string().min(1),
  strategyId: z.string().min(1),
  status: z.enum(['created', 'skipped', 'failed']),
  created: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  reason: z.string().min(1).max(300).optional(),
  error: z.string().min(1).max(300).optional(),
});

export const BackfillStrategyObservationCandidatesOutput = z.object({
  scanned: z.number().int().nonnegative(),
  eligible: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  runs: z.array(BackfillRunResultSchema),
  truncated: z.boolean(),
  oldestStartedAt: z.coerce.date().optional(),
  warnings: z.array(z.string().min(1).max(300)).max(8),
});

/**
 * 历史 published operational run 的一次性补建入口。
 *
 * 只补观察候选，不同步 benchmark、不补全；补全仍由日循环或
 * complete_strategy_observations 的到期扫描负责。显式传 since/until 控制范围，
 * 单次最多 500 个 run，重复执行幂等。
 */
export const backfillStrategyObservationCandidatesTool = defineTool({
  name: 'backfill_strategy_observation_candidates',
  description:
    '为历史 published operational StrategyRun 限量、幂等地补建 T+1/T+3/T+5 观察候选；不自动执行',
  sideEffect: 'write',
  input: BackfillStrategyObservationCandidatesInput,
  output: BackfillStrategyObservationCandidatesOutput,
  handler: async (input, ctx: ToolContext) => {
    const runs = await ctx.repos.strategyRun.listRuns({
      ...(input.strategyId === undefined ? {} : { strategyId: input.strategyId }),
      ...(input.since === undefined ? {} : { since: input.since }),
      ...(input.until === undefined ? {} : { until: input.until }),
      scope: 'operational',
      publication: 'published',
      limit: input.limit,
    });
    const eligibleRuns = runs.filter(isPublishableOperationalRun);
    const results: Array<z.infer<typeof BackfillRunResultSchema>> = [];
    let created = 0;
    let skipped = 0;
    let failed = 0;
    for (const run of eligibleRuns) {
      const result = await createStrategyObservationCandidatesTool.execute({ runId: run.id }, ctx);
      if (!result.ok) {
        failed += 1;
        results.push({
          runId: run.id,
          strategyId: run.strategyId,
          status: 'failed',
          created: 0,
          skipped: 0,
          error: result.error.kind,
        });
        continue;
      }
      created += result.data.created;
      skipped += result.data.skipped;
      results.push({
        runId: run.id,
        strategyId: run.strategyId,
        status:
          result.data.status === 'skipped' || result.data.created === 0 ? 'skipped' : 'created',
        created: result.data.created,
        skipped: result.data.skipped,
        ...(result.data.reason === undefined ? {} : { reason: result.data.reason }),
      });
    }

    const warnings: string[] = [];
    if (runs.length === 0) warnings.push('没有匹配的 published operational StrategyRun');
    if (runs.length === input.limit) {
      warnings.push(
        `已达到 limit=${input.limit}，结果可能不完整；请用 strategyId/since/until 缩小范围后继续`,
      );
    }
    if (failed > 0) warnings.push(`${failed} 个 run 补建失败，详见 runs[].error`);

    return {
      scanned: runs.length,
      eligible: eligibleRuns.length,
      created,
      skipped,
      failed,
      runs: results,
      truncated: runs.length === input.limit,
      ...(runs.length === 0 ? {} : { oldestStartedAt: runs.at(-1)?.startedAt }),
      warnings,
    };
  },
});
