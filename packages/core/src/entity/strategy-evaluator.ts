import { createHash } from 'node:crypto';

import { z } from 'zod';

export const STRATEGY_EVALUATOR_VERSION = 'strategy-evaluator-v2';

const evaluatorManifest = {
  evaluatorVersion: STRATEGY_EVALUATOR_VERSION,
  expression: 'compiled-ast-three-valued-v2',
  ranking: 'score-desc-stock-id-asc-v1',
  signalEmission: 'level-edge-cooldown-v2',
} as const;

export const STRATEGY_EVALUATOR_CODE_HASH = createHash('sha256')
  .update(JSON.stringify(evaluatorManifest))
  .digest('hex');

export const StrategyEvaluatorIdentitySchema = z.object({
  version: z.literal(STRATEGY_EVALUATOR_VERSION),
  codeHash: z.literal(STRATEGY_EVALUATOR_CODE_HASH),
});
export type StrategyEvaluatorIdentity = z.infer<typeof StrategyEvaluatorIdentitySchema>;

export const CURRENT_STRATEGY_EVALUATOR_IDENTITY: StrategyEvaluatorIdentity = {
  version: STRATEGY_EVALUATOR_VERSION,
  codeHash: STRATEGY_EVALUATOR_CODE_HASH,
};
