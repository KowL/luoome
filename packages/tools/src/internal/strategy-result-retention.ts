import { classifyStrategyResult, type StrategyDslV1, type StrategyResult } from '@luoome/core';

export interface StrategyResultRetention {
  /** 需要落库的逐股结果：入选、规则近似与排名近似。 */
  readonly results: StrategyResult[];
  readonly counts: {
    readonly ruleNearMissCount: number;
    readonly rankingNearMissCount: number;
    readonly excludedCount: number;
    readonly incompleteCount: number;
  };
}

/**
 * 运行结果保留策略：只落库可解释的入选与近似入选行，
 * 其余分类只保留计数，避免每次全市场运行写入数千行无人读取的事实。
 */
export const retainStrategyResults = (
  definition: StrategyDslV1,
  results: readonly StrategyResult[],
  options: { readonly nearMissLimit?: number } = {},
): StrategyResultRetention => {
  // 规则很少的策略里，“只差一条规则”会命中大半个市场；近似入选按分数截断，
  // 其余只保留计数，避免把近似行变成新的全量写入。
  const nearMissLimit = options.nearMissLimit ?? 200;
  const kept: StrategyResult[] = [];
  const ruleNearMiss: StrategyResult[] = [];
  const counts = {
    ruleNearMissCount: 0,
    rankingNearMissCount: 0,
    excludedCount: 0,
    incompleteCount: 0,
  };
  for (const result of results) {
    const { kind } = classifyStrategyResult(definition, result);
    if (kind === 'rule-near-miss') counts.ruleNearMissCount += 1;
    else if (kind === 'ranking-near-miss') counts.rankingNearMissCount += 1;
    else if (kind === 'excluded') counts.excludedCount += 1;
    else if (kind === 'incomplete') counts.incompleteCount += 1;
    if (kind === 'selected' || kind === 'ranking-near-miss') kept.push(result);
    else if (kind === 'rule-near-miss') ruleNearMiss.push(result);
  }
  const bounded = ruleNearMiss
    .sort(
      (left, right) =>
        (right.score ?? Number.NEGATIVE_INFINITY) - (left.score ?? Number.NEGATIVE_INFINITY) ||
        left.stockId.localeCompare(right.stockId),
    )
    .slice(0, nearMissLimit);
  return { results: [...kept, ...bounded], counts };
};
