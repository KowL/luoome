import { z } from 'zod';

import type { StrategyRun } from '../entity/strategy.js';
import { InvariantError } from '../error/index.js';
import { type StrategyResultView, StrategyResultViewSchema } from './result-view.js';

export const StrategyRunDiffChangeSchema = z.enum([
  'entered',
  'exited',
  'stayed',
  'candidate-promoted',
  'selected-demoted',
  'rank-changed',
  'score-changed',
  'blocking-rule-changed',
  'data-unavailable',
]);
export type StrategyRunDiffChange = z.infer<typeof StrategyRunDiffChangeSchema>;

export const StrategyRunDiffRowSchema = z.object({
  stockId: z.string().min(1),
  before: StrategyResultViewSchema.optional(),
  after: StrategyResultViewSchema.optional(),
  changes: z.array(StrategyRunDiffChangeSchema),
  rankDelta: z.number().int().optional(),
  scoreDelta: z.number().optional(),
});

export const StrategyRunDiffSummarySchema = z.object({
  entered: z.number().int().nonnegative(),
  exited: z.number().int().nonnegative(),
  stayed: z.number().int().nonnegative(),
  candidatePromoted: z.number().int().nonnegative(),
  selectedDemoted: z.number().int().nonnegative(),
  rankChanged: z.number().int().nonnegative(),
  scoreChanged: z.number().int().nonnegative(),
  blockingRuleChanged: z.number().int().nonnegative(),
  dataUnavailable: z.number().int().nonnegative(),
});

export const StrategyRunDiffSchema = z.object({
  fromRunId: z.string().min(1),
  toRunId: z.string().min(1),
  definitionChanged: z.boolean(),
  summary: StrategyRunDiffSummarySchema,
  rows: z.array(StrategyRunDiffRowSchema),
});
export type StrategyRunDiff = z.infer<typeof StrategyRunDiffSchema>;

const isCandidate = (view: StrategyResultView | undefined): boolean =>
  view?.kind === 'rule-near-miss' || view?.kind === 'ranking-near-miss';

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((item, index) => item === right[index]);

export const diffStrategyRunViews = (input: {
  readonly fromRun: StrategyRun;
  readonly toRun: StrategyRun;
  readonly fromViews: readonly StrategyResultView[];
  readonly toViews: readonly StrategyResultView[];
}): StrategyRunDiff => {
  if (input.fromRun.strategyId !== input.toRun.strategyId) {
    throw new InvariantError('StrategyRun Diff 只能比较同一 Strategy');
  }
  if (input.fromRun.id === input.toRun.id) {
    throw new InvariantError('StrategyRun Diff 需要两个不同 run');
  }
  for (const view of input.fromViews) {
    if (view.result.runId !== input.fromRun.id) {
      throw new InvariantError('from StrategyResult.runId 与 fromRun 不匹配');
    }
  }
  for (const view of input.toViews) {
    if (view.result.runId !== input.toRun.id) {
      throw new InvariantError('to StrategyResult.runId 与 toRun 不匹配');
    }
  }

  const fromByStock = new Map(input.fromViews.map((view) => [view.result.stockId, view]));
  const toByStock = new Map(input.toViews.map((view) => [view.result.stockId, view]));
  const stockIds = [...new Set([...fromByStock.keys(), ...toByStock.keys()])].sort();
  const rows = stockIds.flatMap((stockId) => {
    const before = fromByStock.get(stockId);
    const after = toByStock.get(stockId);
    const changes: StrategyRunDiffChange[] = [];
    const dataUnavailable =
      before === undefined ||
      after === undefined ||
      before.kind === 'incomplete' ||
      after.kind === 'incomplete';
    let rankDelta: number | undefined;
    let scoreDelta: number | undefined;
    if (dataUnavailable) {
      changes.push('data-unavailable');
    } else {
      const beforeSelected = before.kind === 'selected';
      const afterSelected = after.kind === 'selected';
      if (!beforeSelected && afterSelected) changes.push('entered');
      else if (beforeSelected && !afterSelected) changes.push('exited');
      else if (beforeSelected && afterSelected) changes.push('stayed');
      if (isCandidate(before) && afterSelected) changes.push('candidate-promoted');
      if (beforeSelected && !afterSelected) changes.push('selected-demoted');

      const beforeRank = before.result.rank;
      const afterRank = after.result.rank;
      rankDelta =
        beforeRank !== undefined && afterRank !== undefined && beforeRank !== afterRank
          ? afterRank - beforeRank
          : undefined;
      if (rankDelta !== undefined) changes.push('rank-changed');

      const beforeScore = before.result.score;
      const afterScore = after.result.score;
      scoreDelta =
        beforeScore !== undefined && afterScore !== undefined && beforeScore !== afterScore
          ? afterScore - beforeScore
          : undefined;
      if (scoreDelta !== undefined) changes.push('score-changed');

      const beforeBlockers = [...before.blockingRuleIds].sort();
      const afterBlockers = [...after.blockingRuleIds].sort();
      if (!sameStrings(beforeBlockers, afterBlockers)) changes.push('blocking-rule-changed');
    }
    if (changes.length === 0) return [];
    return [
      {
        stockId,
        ...(before === undefined ? {} : { before }),
        ...(after === undefined ? {} : { after }),
        changes,
        ...(rankDelta === undefined ? {} : { rankDelta }),
        ...(scoreDelta === undefined ? {} : { scoreDelta }),
      },
    ];
  });

  const priority = (row: (typeof rows)[number]): number =>
    row.changes.includes('entered') ? 0 : row.changes.includes('exited') ? 1 : 2;
  rows.sort(
    (left, right) => priority(left) - priority(right) || left.stockId.localeCompare(right.stockId),
  );

  return StrategyRunDiffSchema.parse({
    fromRunId: input.fromRun.id,
    toRunId: input.toRun.id,
    definitionChanged: input.fromRun.strategyVersionId !== input.toRun.strategyVersionId,
    summary: {
      entered: rows.filter((row) => row.changes.includes('entered')).length,
      exited: rows.filter((row) => row.changes.includes('exited')).length,
      stayed: rows.filter((row) => row.changes.includes('stayed')).length,
      candidatePromoted: rows.filter((row) => row.changes.includes('candidate-promoted')).length,
      selectedDemoted: rows.filter((row) => row.changes.includes('selected-demoted')).length,
      rankChanged: rows.filter((row) => row.changes.includes('rank-changed')).length,
      scoreChanged: rows.filter((row) => row.changes.includes('score-changed')).length,
      blockingRuleChanged: rows.filter((row) => row.changes.includes('blocking-rule-changed'))
        .length,
      dataUnavailable: rows.filter((row) => row.changes.includes('data-unavailable')).length,
    },
    rows,
  });
};
