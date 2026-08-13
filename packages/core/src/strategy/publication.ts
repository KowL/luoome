import {
  DEFAULT_STRATEGY_RUN_ACCEPTANCE_POLICY,
  type StrategyRun,
  type StrategyRunAcceptance,
  type StrategyRunAcceptancePolicy,
  StrategyRunAcceptancePolicySchema,
  type StrategyRunInputSnapshotV3,
  type StrategyRunPublication,
  StrategyRunPublicationSchema,
  type StrategyRunScope,
  type StrategyRunUniverseKind,
} from '../entity/strategy.js';

export interface AssessStrategyRunInput {
  readonly status: StrategyRun['status'];
  readonly universeCount: number;
  readonly evaluatedCount: number;
  readonly failedCount: number;
  readonly incompleteCount: number;
  readonly policy?: StrategyRunAcceptancePolicy;
  readonly assessedAt: Date;
}

/**
 * 运行验收只描述覆盖事实是否过门，不修改 dataHealth，也不决定下游是否可见。
 */
export const assessStrategyRun = (input: AssessStrategyRunInput): StrategyRunAcceptance => {
  const policy = StrategyRunAcceptancePolicySchema.parse(
    input.policy ?? DEFAULT_STRATEGY_RUN_ACCEPTANCE_POLICY,
  );
  const denominator = input.universeCount;
  const evaluatedRatio = denominator === 0 ? 0 : input.evaluatedCount / denominator;
  const failedRatio = denominator === 0 ? 0 : input.failedCount / denominator;
  const incompleteRatio =
    denominator === 0 ? 0 : Math.min(input.incompleteCount, input.evaluatedCount) / denominator;
  const reasons: StrategyRunAcceptance['reasons'] = [];
  if (input.status !== 'complete') reasons.push('run-not-complete');
  if (denominator === 0) reasons.push('empty-universe');
  if (evaluatedRatio < policy.minEvaluatedRatio) reasons.push('evaluated-ratio-below-min');
  if (failedRatio > policy.maxFailedRatio) reasons.push('failed-ratio-above-max');
  if (incompleteRatio > policy.maxIncompleteRatio) reasons.push('incomplete-ratio-above-max');
  return {
    decision: reasons.length === 0 ? 'accepted' : 'rejected',
    policy,
    metrics: { evaluatedRatio, failedRatio, incompleteRatio },
    reasons,
    assessedAt: input.assessedAt,
  };
};

export interface DecideStrategyRunPublicationInput {
  readonly scope: StrategyRunScope;
  readonly universeKind: StrategyRunUniverseKind;
  readonly status: StrategyRun['status'];
  readonly universeCheckpointPresent: boolean;
  readonly acceptance: StrategyRunAcceptance;
  readonly requestedBy?: StrategyRunInputSnapshotV3['requestedBy'];
  readonly decidedAt: Date;
}

/**
 * publication 是 operational current 的消费门，不是执行状态或 dataHealth 的别名。
 *
 * 对于手工触发的正式全市场运行（requestedBy=manual），用户已在 Web 端显式确认接受 partial
 * 数据；只要运行完成且 universe checkpoint 存在，就允许进入 current，不把验收失败作为
 * withheld 理由。scheduled/replay 仍受 acceptance policy 约束，避免无人值守运行自动污染
 * 当前股票池。
 */
export const decideStrategyRunPublication = (
  input: DecideStrategyRunPublicationInput,
): StrategyRunPublication => {
  const reasons: StrategyRunPublication['reasons'] = [];
  if (input.scope === 'evaluation') reasons.push('evaluation-scope');
  if (input.universeKind === 'explicit') reasons.push('explicit-subset');
  if (input.status !== 'complete') reasons.push('run-not-complete');
  if (input.scope === 'operational' && !input.universeCheckpointPresent) {
    reasons.push('universe-checkpoint-missing');
  }
  const manualFormalPublishes =
    input.requestedBy === 'manual' &&
    input.scope === 'operational' &&
    input.universeKind === 'full' &&
    input.status === 'complete' &&
    input.universeCheckpointPresent;
  if (!manualFormalPublishes && input.acceptance.decision === 'rejected') {
    reasons.push('acceptance-rejected');
  }
  const nonPublishing = input.scope === 'evaluation' || input.universeKind === 'explicit';
  const status = nonPublishing ? 'non-publishing' : reasons.length === 0 ? 'published' : 'withheld';
  return StrategyRunPublicationSchema.parse({
    status,
    reasons,
    decidedAt: input.decidedAt,
  });
};

export const deriveStrategyRunScope = (input: {
  readonly mode: StrategyRun['mode'];
  readonly hasExplicitStockIds: boolean;
}): StrategyRunScope =>
  input.mode === 'replay' || input.mode === 'backtest' || input.hasExplicitStockIds
    ? 'evaluation'
    : 'operational';

export const deriveStrategyRunUniverseKind = (input: {
  readonly hasExplicitStockIds: boolean;
}): StrategyRunUniverseKind => (input.hasExplicitStockIds ? 'explicit' : 'full');

export const legacyStrategyRunPublication = (
  run: StrategyRun,
  assessedAt: Date,
): StrategyRunPublication => ({
  status: run.mode === 'replay' || run.mode === 'backtest' ? 'non-publishing' : 'published',
  reasons: ['legacy-publication'],
  decidedAt: assessedAt,
});

/**
 * 读取存量 run 时补齐 current reader 所需的兼容字段；不回写、不改变已发布版本。
 * running run 不能被解释成 published，Summary V4 也必须由新 writer 显式给出 publication。
 */
export const normalizeLegacyStrategyRun = (run: StrategyRun): StrategyRun => {
  if (run.status !== 'complete' && run.status !== 'partial') return run;
  const scope =
    run.scope ?? (run.mode === 'replay' || run.mode === 'backtest' ? 'evaluation' : 'operational');
  const publication =
    run.publication ??
    (run.summary?.schemaVersion === 4
      ? undefined
      : legacyStrategyRunPublication(run, run.finishedAt ?? run.startedAt));
  return {
    ...run,
    scope,
    ...(publication === undefined ? {} : { publication }),
  };
};
