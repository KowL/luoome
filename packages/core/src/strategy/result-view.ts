import { z } from 'zod';

import {
  type StrategyDslV1,
  type StrategyResult,
  StrategyResultSchema,
} from '../entity/strategy.js';

export const StrategyResultViewKindSchema = z.enum([
  'selected',
  'rule-near-miss',
  'ranking-near-miss',
  'incomplete',
  'excluded',
]);
export type StrategyResultViewKind = z.infer<typeof StrategyResultViewKindSchema>;

export const StrategyResultDistanceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rule-count'), missingRuleCount: z.literal(1) }),
  z.object({
    kind: z.literal('rank'),
    rank: z.number().int().positive(),
    top: z.number().int().positive(),
    positionsAway: z.number().int().positive(),
  }),
]);

export const StrategyResultViewSchema = z.object({
  kind: StrategyResultViewKindSchema,
  result: StrategyResultSchema,
  blockingRuleIds: z.array(z.string()),
  distance: StrategyResultDistanceSchema.optional(),
});
export type StrategyResultView = z.infer<typeof StrategyResultViewSchema>;

const isV2Selection = (
  evaluation: StrategyResult['ruleEvaluations'][number],
): evaluation is Extract<StrategyResult['ruleEvaluations'][number], { schemaVersion: 2 }> =>
  'schemaVersion' in evaluation &&
  evaluation.schemaVersion === 2 &&
  evaluation.scope === 'selection';

export const classifyStrategyResult = (
  definition: StrategyDslV1,
  result: StrategyResult,
): StrategyResultView => {
  const selection = result.ruleEvaluations.filter(isV2Selection);
  const blockers = selection
    .filter((evaluation) => evaluation.status === 'not-matched')
    .map((evaluation) => evaluation.ruleId)
    .sort();
  const deterministic = selection.every(
    (evaluation) => evaluation.status === 'matched' || evaluation.status === 'not-matched',
  );
  const uncertain = result.ruleEvaluations.some(
    (evaluation) => evaluation.status === 'unknown' || evaluation.status === 'error',
  );
  if (uncertain) return { kind: 'incomplete', result, blockingRuleIds: blockers };

  const legacy = result.ruleEvaluations.some(
    (evaluation) => !('schemaVersion' in evaluation && evaluation.schemaVersion === 2),
  );
  if (result.selected) return { kind: 'selected', result, blockingRuleIds: [] };
  if (legacy || selection.length !== definition.selection.rules.length) {
    return { kind: 'incomplete', result, blockingRuleIds: blockers };
  }

  const top = definition.scoring?.top;
  if (
    top !== undefined &&
    selection.every((evaluation) => evaluation.status === 'matched') &&
    result.score !== undefined &&
    result.rank !== undefined &&
    result.rank > top
  ) {
    return {
      kind: 'ranking-near-miss',
      result,
      blockingRuleIds: [],
      distance: {
        kind: 'rank',
        rank: result.rank,
        top,
        positionsAway: result.rank - top,
      },
    };
  }
  if (
    definition.selection.logic === 'all' &&
    selection.length === definition.selection.rules.length &&
    deterministic &&
    blockers.length === 1 &&
    selection.filter((evaluation) => evaluation.status === 'matched').length ===
      selection.length - 1
  ) {
    return {
      kind: 'rule-near-miss',
      result,
      blockingRuleIds: blockers,
      distance: { kind: 'rule-count', missingRuleCount: 1 },
    };
  }
  return { kind: 'excluded', result, blockingRuleIds: blockers };
};
