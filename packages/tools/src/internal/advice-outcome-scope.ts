import type { AdviceOutcome, AdviceOutcomeOrigin } from '@luoome/core';
import { z } from 'zod';

export const AdviceOutcomeScopeSchema = z.object({
  originFilter: z.enum(['user', 'all']),
  originCounts: z.object({
    user: z.number().int().nonnegative(),
    model: z.number().int().nonnegative(),
    import: z.number().int().nonnegative(),
    unattested: z.number().int().nonnegative(),
  }),
  excluded: z.object({
    nonUserOrigin: z.number().int().nonnegative(),
    unattested: z.number().int().nonnegative(),
  }),
});

/**
 * 统计口径的来源过滤（REQ-M3-18 §3）。
 *
 * 默认只统计 `origin='user'`：命中率是「用户回填的兑现」的比例，模型自己写的
 * outcome 一旦进分母，策略迭代就建立在模型自评上。非 user 来源必须显式
 * `originFilter='all'` 才纳入，且任何口径都要披露被排除的条数。
 */
export type AdviceOutcomeOriginFilter = 'user' | 'all';

export interface AdviceOutcomeOriginCounts {
  readonly user: number;
  readonly model: number;
  readonly import: number;
  /** REQ-M3-18 之前写入、没有来源标记的历史回填；无法追溯，按非 user 处理。 */
  readonly unattested: number;
}

export interface AdviceOutcomePartition {
  readonly originFilter: AdviceOutcomeOriginFilter;
  /** 本次口径内可参与统计的回填。 */
  readonly inScope: Map<string, AdviceOutcome>;
  readonly originCounts: AdviceOutcomeOriginCounts;
  /** 被本次口径排除的条数：非 user 来源与无法追溯的历史回填分列。 */
  readonly excluded: { readonly nonUserOrigin: number; readonly unattested: number };
}

const originKey = (origin: AdviceOutcomeOrigin | undefined): keyof AdviceOutcomeOriginCounts =>
  origin ?? 'unattested';

export const partitionAdviceOutcomes = (
  outcomes: ReadonlyMap<string, AdviceOutcome>,
  filter: AdviceOutcomeOriginFilter,
  adviceIds: Iterable<string>,
): AdviceOutcomePartition => {
  const counts: Record<keyof AdviceOutcomeOriginCounts, number> = {
    user: 0,
    model: 0,
    import: 0,
    unattested: 0,
  };
  const inScope = new Map<string, AdviceOutcome>();
  // 先限制账户/窗口/分组，再计来源，避免窗口外反馈污染排除计数。
  for (const adviceId of new Set(adviceIds)) {
    const outcome = outcomes.get(adviceId);
    if (outcome === undefined) continue;
    const key = originKey(outcome.origin);
    counts[key] += 1;
    if (key === 'user' || filter === 'all') inScope.set(adviceId, outcome);
  }
  const excludedNonUser = counts.model + counts.import;
  return {
    originFilter: filter,
    inScope,
    originCounts: counts,
    excluded:
      filter === 'all'
        ? { nonUserOrigin: 0, unattested: 0 }
        : { nonUserOrigin: excludedNonUser, unattested: counts.unattested },
  };
};
