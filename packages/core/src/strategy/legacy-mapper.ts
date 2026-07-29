import {
  assertStrategyInvariants,
  assertStrategyRunInvariants,
  assertStrategyVersionInvariants,
  type Strategy,
  type StrategyDslV1,
  StrategyDslV1Schema,
  type StrategyRun,
  type StrategySignal,
  type StrategySignalRule,
  type StrategyVersion,
  strategyDefinitionHash,
} from '../entity/strategy.js';
import type { Tactic, TacticSignal } from '../entity/tactic.js';

export interface LegacyTacticStrategyBundle {
  readonly strategy: Strategy;
  readonly version: StrategyVersion;
  readonly run: StrategyRun;
}

const signalBucket = (tactic: Tactic): 'entry' | 'exit' | 'risk' => {
  if (tactic.tag === 'risk') return 'risk';
  if (tactic.direction === 'bearish') return 'exit';
  return 'entry';
};

export const mapLegacyTacticToStrategy = (
  tactic: Tactic,
  strategyId = tactic.id,
  signalCount = 0,
): LegacyTacticStrategyBundle => {
  const signalRule: StrategySignalRule = {
    id: 'legacy-signal',
    name: tactic.name,
    when: tactic.triggerWhen,
    score: tactic.scoreExpression,
    direction: tactic.direction,
    evidence: [...tactic.evidenceTemplate],
  };
  const bucket = signalBucket(tactic);
  const definition: StrategyDslV1 = StrategyDslV1Schema.parse({
    schemaVersion: 1,
    metadata: { style: tactic.tag },
    universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
    selection: { logic: 'all', rules: [] },
    signals: {
      entry: bucket === 'entry' ? [signalRule] : [],
      exit: bucket === 'exit' ? [signalRule] : [],
      risk: bucket === 'risk' ? [signalRule] : [],
    },
  });
  const versionId = `${strategyId}-v1`;
  const runId = `legacy-signal-import-${strategyId}`;
  const version: StrategyVersion = {
    id: versionId,
    strategyId,
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    changeSummary: '从 legacy Tactic 迁移',
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: tactic.definedAt,
    createdAt: tactic.definedAt,
  };
  const strategy: Strategy = {
    id: strategyId,
    name: tactic.name,
    description: tactic.description,
    owner: tactic.source,
    status: 'active',
    currentVersionId: versionId,
    createdAt: tactic.definedAt,
    updatedAt: tactic.definedAt,
  };
  const run: StrategyRun = {
    id: runId,
    strategyId,
    strategyVersionId: versionId,
    mode: 'replay',
    coverage: 'CN_A_SHARES_SH_SZ',
    dataAsOf: tactic.definedAt,
    startedAt: tactic.definedAt,
    finishedAt: tactic.definedAt,
    status: 'complete',
    inputSnapshot: { source: 'legacy-tactic-migration' },
    providerStatuses: [],
    summary: { importedSignals: signalCount },
  };
  assertStrategyInvariants(strategy);
  assertStrategyVersionInvariants(version, 'migration');
  assertStrategyRunInvariants(run);
  return { strategy, version, run };
};

export const mapLegacyTacticSignal = (
  signal: TacticSignal,
  ids: {
    readonly id: string;
    readonly strategyId: string;
    readonly strategyVersionId: string;
    readonly runId: string;
  },
): StrategySignal => ({
  id: ids.id,
  strategyId: ids.strategyId,
  strategyVersionId: ids.strategyVersionId,
  runId: ids.runId,
  ruleId: 'legacy-signal',
  stockId: signal.stockId,
  ts: signal.ts,
  score: signal.score,
  direction: signal.direction,
  evidence: [...signal.evidence],
  evaluationSnapshot: signal.triggerSnapshot ?? {},
});
