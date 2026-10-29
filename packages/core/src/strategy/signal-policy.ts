import type {
  StrategyDslV1,
  StrategyResult,
  StrategySignal,
  StrategySignalState,
} from '../entity/strategy.js';
import { decideStrategySignalEmission } from './emission.js';

type SignalKind = keyof StrategyDslV1['signals'];

export const isObservableStrategySignal = (signal: StrategySignal): boolean => {
  const tracking = signal.evaluationSnapshot.tracking;
  if (tracking === null || typeof tracking !== 'object' || Array.isArray(tracking)) return false;
  return (
    'policyVersion' in tracking &&
    tracking.policyVersion === 1 &&
    'eligible' in tracking &&
    tracking.eligible === true &&
    'kind' in tracking &&
    (tracking.kind === 'entry' || tracking.kind === 'exit' || tracking.kind === 'risk')
  );
};

export const planStrategySignalEvents = (input: {
  readonly strategyId: string;
  readonly strategyVersionId: string;
  readonly contextKey: string;
  readonly runId: string;
  readonly now: Date;
  readonly definition: StrategyDslV1;
  readonly results: readonly StrategyResult[];
  readonly rawSignals: readonly StrategySignal[];
  readonly previousState?: StrategySignalState;
}): { signals: StrategySignal[]; state: StrategySignalState } => {
  const previous =
    input.previousState?.strategyId === input.strategyId &&
    input.previousState.strategyVersionId === input.strategyVersionId &&
    input.previousState.contextKey === input.contextKey
      ? input.previousState
      : undefined;
  if (previous !== undefined && input.now.getTime() <= previous.evaluatedAt.getTime()) {
    return { signals: [], state: previous };
  }

  const results = new Map(
    input.results
      .filter((result) => result.runId === input.runId)
      .map((result) => [result.stockId, result]),
  );
  const selectionIsCertain = (result: StrategyResult | undefined): boolean => {
    if (result === undefined) return false;
    const selection = result.ruleEvaluations.filter((item) =>
      input.definition.selection.rules.some((rule) => rule.id === item.ruleId),
    );
    if (selection.length !== input.definition.selection.rules.length) return false;
    const matched = selection.some((item) => item.status === 'matched');
    const failed = selection.some((item) => item.status === 'not-matched');
    const uncertain = selection.some(
      (item) => item.status === 'unknown' || item.status === 'error',
    );
    const included =
      input.definition.selection.logic === 'all'
        ? !failed && !uncertain
        : matched || selection.length === 0;
    const certain =
      input.definition.selection.logic === 'all' ? failed || !uncertain : matched || !uncertain;
    return (
      certain && (!included || input.definition.scoring === undefined || result.score !== undefined)
    );
  };
  const selected = new Set(
    [...results.values()].filter((result) => result.selected).map((result) => result.stockId),
  );
  const tracked = new Set([...selected, ...(previous?.trackedStockIds ?? [])]);
  const identity = (stockId: string, ruleId: string): string => `${stockId}\0${ruleId}`;
  const previousRules = new Map(
    previous?.rules.map((rule) => [identity(rule.stockId, rule.ruleId), rule]),
  );
  const rawSignals = new Map(
    input.rawSignals
      .filter(
        (signal) =>
          signal.strategyId === input.strategyId &&
          signal.strategyVersionId === input.strategyVersionId &&
          signal.runId === input.runId,
      )
      .map((signal) => [identity(signal.stockId, signal.ruleId), signal]),
  );
  const signals: StrategySignal[] = [];
  const rules: StrategySignalState['rules'] = [];
  const retired = new Set<string>();
  const kinds: SignalKind[] = ['entry', 'exit', 'risk'];
  for (const stockId of tracked) {
    const result = results.get(stockId);
    for (const kind of kinds) {
      for (const rule of input.definition.signals[kind]) {
        const key = identity(stockId, rule.id);
        const prior = previousRules.get(key);
        const evaluation = result?.ruleEvaluations.find(
          (item) => item.ruleId === rule.id && (!('scope' in item) || item.scope === kind),
        );
        if (evaluation?.status === 'unknown' || evaluation?.status === 'error') {
          if (prior !== undefined) rules.push({ ...prior });
          continue;
        }
        const raw = rawSignals.get(key);
        if (evaluation === undefined && raw === undefined) {
          if (prior !== undefined) rules.push({ ...prior });
          continue;
        }
        if (kind === 'entry' && !selected.has(stockId)) {
          if (prior !== undefined)
            rules.push({ ...prior, matched: selectionIsCertain(result) ? false : prior.matched });
          continue;
        }
        const matched = (evaluation?.status ?? 'matched') === 'matched';
        const next = { stockId, ruleId: rule.id, matched, lastEmittedAt: prior?.lastEmittedAt };
        if (matched && raw !== undefined) {
          if (kind === 'exit') retired.add(stockId);
          const decision = decideStrategySignalEmission({
            emission: {
              mode: 'edge',
              cooldownTradingDays: rule.emission?.cooldownTradingDays ?? 0,
            },
            matched,
            previousMatched: prior?.matched ?? false,
            ...(prior?.lastEmittedAt === undefined
              ? {}
              : { previousSignal: { ...raw, ts: prior.lastEmittedAt } }),
            now: input.now,
          });
          if (decision.emit) {
            signals.push({
              ...raw,
              evaluationSnapshot: {
                ...raw.evaluationSnapshot,
                tracking: { policyVersion: 1, kind, eligible: true },
              },
            });
            next.lastEmittedAt = input.now;
          }
        }
        rules.push(next);
      }
    }
  }
  const updated = new Map(rules.map((rule) => [identity(rule.stockId, rule.ruleId), rule]));
  for (const [key, prior] of previousRules) {
    if (updated.has(key)) continue;
    const result = results.get(prior.stockId);
    const entry = input.definition.signals.entry.find((rule) => rule.id === prior.ruleId);
    const evaluation =
      entry === undefined
        ? undefined
        : result?.ruleEvaluations.find(
            (item) => item.ruleId === entry.id && (!('scope' in item) || item.scope === 'entry'),
          );
    // 退休只结束跟踪资格；事件时间仍约束重新入选后的冷却。
    updated.set(
      key,
      entry !== undefined &&
        !selected.has(prior.stockId) &&
        selectionIsCertain(result) &&
        (evaluation?.status === 'matched' || evaluation?.status === 'not-matched')
        ? { ...prior, matched: false }
        : { ...prior },
    );
  }
  return {
    signals,
    state: {
      strategyId: input.strategyId,
      strategyVersionId: input.strategyVersionId,
      contextKey: input.contextKey,
      runId: input.runId,
      evaluatedAt: input.now,
      trackedStockIds: [...tracked].filter((stockId) => !retired.has(stockId)),
      rules: [...updated.values()],
    },
  };
};
