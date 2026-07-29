import type { TechnicalIndicators } from '../entity/indicator-set.js';
import type { Quote } from '../entity/quote.js';
import type {
  RuleEvaluation,
  StrategyDslV1,
  StrategyResult,
  StrategySignal,
  StrategySignalRule,
  StrategyVersion,
} from '../entity/strategy.js';
import {
  evaluateExpression,
  extractExpressionPaths,
  extractTemplatePaths,
  interpolate,
  resolveExpressionPath,
} from './expression.js';

export interface StrategyEvaluationContext {
  readonly quote?: Quote | undefined;
  readonly indicators: TechnicalIndicators;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface EvaluateStrategyStockInput {
  readonly strategyId: string;
  readonly version: StrategyVersion;
  readonly runId: string;
  readonly stockId: string;
  readonly ts: Date;
  readonly dataAsOf: Date;
  readonly context: StrategyEvaluationContext;
}

export interface StrategyStockEvaluation {
  readonly result: StrategyResult;
  readonly signals: readonly StrategySignal[];
  readonly partial: boolean;
  readonly errors: readonly string[];
}

const dslContext = (context: StrategyEvaluationContext): Readonly<Record<string, unknown>> => ({
  quote: context.quote,
  indicators: context.indicators,
  meta: context.meta ?? {},
});

const missingPaths = (
  expression: string,
  context: Readonly<Record<string, unknown>>,
): readonly string[] =>
  extractExpressionPaths(expression).filter(
    (path) => resolveExpressionPath(path, context) === undefined,
  );

const evaluateRule = (
  rule: { readonly id: string; readonly when: string; readonly evidence: readonly string[] },
  context: Readonly<Record<string, unknown>>,
): RuleEvaluation => {
  const missingWhen = extractExpressionPaths(rule.when).filter(
    (path) => resolveExpressionPath(path, context) === undefined,
  );
  try {
    const value = evaluateExpression(interpolate(rule.when, context), context);
    const matched = Boolean(value);
    const missingEvidence = matched
      ? rule.evidence
          .flatMap(extractTemplatePaths)
          .filter((path) => resolveExpressionPath(path, context) === undefined)
      : [];
    const missing = [...new Set([...missingWhen, ...missingEvidence])].sort();
    if (missing.length > 0 && (!matched || missingEvidence.length > 0)) {
      return {
        ruleId: rule.id,
        status: 'unknown',
        value,
        evidence: [],
        error: `缺少字段: ${missing.join(', ')}`,
      };
    }
    return {
      ruleId: rule.id,
      status: matched ? 'matched' : 'not-matched',
      value,
      evidence: matched ? rule.evidence.map((template) => interpolate(template, context)) : [],
    };
  } catch (error) {
    return {
      ruleId: rule.id,
      status: 'error',
      evidence: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const evaluateScore = (
  expression: string,
  context: Readonly<Record<string, unknown>>,
): { readonly score?: number; readonly error?: string } => {
  const missing = missingPaths(expression, context);
  if (missing.length > 0) return { error: `缺少字段: ${missing.join(', ')}` };
  try {
    const score = Number(evaluateExpression(interpolate(expression, context), context));
    if (!Number.isFinite(score)) return { error: `score 不是有限数: ${String(score)}` };
    if (score < 0 || score > 100) return { error: `score 越界: ${score}` };
    return { score };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

const selectionOutcome = (
  definition: StrategyDslV1,
  evaluations: readonly RuleEvaluation[],
): { readonly selected: boolean; readonly partial: boolean } => {
  if (evaluations.length === 0) return { selected: true, partial: false };
  const matched = evaluations.some((evaluation) => evaluation.status === 'matched');
  const notMatched = evaluations.some((evaluation) => evaluation.status === 'not-matched');
  const uncertain = evaluations.some(
    (evaluation) => evaluation.status === 'unknown' || evaluation.status === 'error',
  );
  if (definition.selection.logic === 'any') {
    return { selected: matched, partial: !matched && uncertain };
  }
  return {
    selected: !notMatched && !uncertain,
    partial: !notMatched && uncertain,
  };
};

const evaluateSignal = (
  input: EvaluateStrategyStockInput,
  rule: StrategySignalRule,
  context: Readonly<Record<string, unknown>>,
): {
  readonly evaluation: RuleEvaluation;
  readonly signal?: StrategySignal;
  readonly error?: string;
} => {
  const evaluation = evaluateRule(rule, context);
  if (evaluation.status !== 'matched') return { evaluation };
  const scored = evaluateScore(rule.score, context);
  if (scored.score === undefined) {
    const error = scored.error ?? 'signal score 无效';
    return {
      evaluation: { ...evaluation, status: 'error', error, evidence: [] },
      error,
    };
  }
  return {
    evaluation,
    signal: {
      id: `${input.runId}:${rule.id}:${input.stockId}:${input.ts.toISOString()}`,
      strategyId: input.strategyId,
      strategyVersionId: input.version.id,
      runId: input.runId,
      ruleId: rule.id,
      stockId: input.stockId,
      ts: input.ts,
      score: scored.score,
      direction: rule.direction,
      evidence: evaluation.evidence,
      evaluationSnapshot: { expression: rule.when, result: evaluation.value },
    },
  };
};

export const evaluateStrategyStock = (
  input: EvaluateStrategyStockInput,
): StrategyStockEvaluation => {
  const context = dslContext(input.context);
  const definition = input.version.definition;
  const selectionEvaluations = definition.selection.rules.map((rule) =>
    evaluateRule(rule, context),
  );
  const selection = selectionOutcome(definition, selectionEvaluations);
  const errors = selectionEvaluations.flatMap((evaluation) =>
    evaluation.status === 'error' ? [evaluation.error ?? `规则 ${evaluation.ruleId} 失败`] : [],
  );

  let score: number | undefined;
  if (selection.selected && definition.scoring !== undefined) {
    let weighted = 0;
    for (const component of definition.scoring.components) {
      const evaluated = evaluateScore(component.score, context);
      if (evaluated.score === undefined) {
        errors.push(`scoring ${component.ruleId}: ${evaluated.error ?? '未知错误'}`);
      } else {
        weighted += evaluated.score * component.weight;
      }
    }
    if (errors.length === 0) score = weighted;
  }

  const signalOutcomes = [
    ...definition.signals.entry,
    ...definition.signals.exit,
    ...definition.signals.risk,
  ].map((rule) => evaluateSignal(input, rule, context));
  const signalEvaluations = signalOutcomes.map((outcome) => outcome.evaluation);
  errors.push(
    ...signalOutcomes.flatMap((outcome) => (outcome.error === undefined ? [] : [outcome.error])),
  );
  const uncertainSignal = signalEvaluations.some(
    (evaluation) => evaluation.status === 'unknown' || evaluation.status === 'error',
  );
  const evidence = [...selectionEvaluations, ...signalEvaluations].flatMap(
    (evaluation) => evaluation.evidence,
  );

  return {
    result: {
      runId: input.runId,
      stockId: input.stockId,
      selected: selection.selected,
      ...(score === undefined ? {} : { score }),
      ruleEvaluations: [...selectionEvaluations, ...signalEvaluations],
      evidence,
      dataAsOf: input.dataAsOf,
    },
    signals: signalOutcomes.flatMap((outcome) =>
      outcome.signal === undefined ? [] : [outcome.signal],
    ),
    partial:
      selection.partial ||
      uncertainSignal ||
      (selection.selected && definition.scoring !== undefined && score === undefined),
    errors,
  };
};

export const assignStableStrategyRanks = (
  evaluations: readonly StrategyStockEvaluation[],
  definition: StrategyDslV1,
): readonly StrategyStockEvaluation[] => {
  if (definition.scoring === undefined) return evaluations;
  const ranked = evaluations
    .filter((evaluation) => evaluation.result.selected && evaluation.result.score !== undefined)
    .sort(
      (left, right) =>
        (right.result.score as number) - (left.result.score as number) ||
        left.result.stockId.localeCompare(right.result.stockId),
    );
  const ranks = new Map(ranked.map((evaluation, index) => [evaluation.result.stockId, index + 1]));
  const top = definition.scoring.top;
  return evaluations.map((evaluation) => {
    const rank = ranks.get(evaluation.result.stockId);
    if (rank === undefined) return evaluation;
    return {
      ...evaluation,
      result: {
        ...evaluation.result,
        selected: top === undefined ? evaluation.result.selected : rank <= top,
        rank,
      },
    };
  });
};
