import type { TechnicalIndicators } from '../entity/indicator-set.js';
import type { Quote } from '../entity/quote.js';
import type {
  RuleEvaluation,
  RuleEvaluationV2,
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
  rule: {
    readonly id: string;
    readonly name: string;
    readonly when: string;
    readonly evidence: readonly string[];
  },
  scope: RuleEvaluationV2['scope'],
  context: Readonly<Record<string, unknown>>,
): RuleEvaluationV2 => {
  const expressionPaths = [...new Set(extractExpressionPaths(rule.when))].sort();
  const inputs = expressionPaths.map((path) => {
    const value = resolveExpressionPath(path, context);
    return value === undefined
      ? { path, status: 'missing' as const }
      : { path, status: 'available' as const, value };
  });
  const missingWhen = inputs
    .filter((input) => input.status === 'missing')
    .map((input) => input.path);
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
        schemaVersion: 2,
        ruleId: rule.id,
        scope,
        expression: rule.when,
        status: 'unknown',
        value,
        inputs,
        explanation: {
          code: 'missing-input',
          message: `缺少字段：${missing.join(', ')}`,
        },
        evidence: [],
        error: `缺少字段: ${missing.join(', ')}`,
      };
    }
    return {
      schemaVersion: 2,
      ruleId: rule.id,
      scope,
      expression: rule.when,
      status: matched ? 'matched' : 'not-matched',
      value,
      inputs,
      explanation: matched
        ? { code: 'matched', message: `规则「${rule.name}」已命中` }
        : {
            code: 'not-matched',
            message: `规则「${rule.name}」未命中：表达式求值为 false`,
          },
      evidence: matched ? rule.evidence.map((template) => interpolate(template, context)) : [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      schemaVersion: 2,
      ruleId: rule.id,
      scope,
      expression: rule.when,
      status: 'error',
      inputs,
      explanation: { code: 'evaluation-error', message },
      evidence: [],
      error: message,
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
  scope: Exclude<RuleEvaluationV2['scope'], 'selection'>,
  context: Readonly<Record<string, unknown>>,
): {
  readonly evaluation: RuleEvaluation;
  readonly signal?: StrategySignal;
  readonly error?: string;
} => {
  const evaluation = evaluateRule(rule, scope, context);
  if (evaluation.status !== 'matched') {
    // 与 selection rule 对齐：when 求值抛错的 error 也要进 errors 收集
    if (evaluation.status === 'error') {
      return { evaluation, error: evaluation.error ?? `信号规则 ${rule.id} 求值失败` };
    }
    return { evaluation };
  }
  const scored = evaluateScore(rule.score, context);
  if (scored.score === undefined) {
    const error = scored.error ?? 'signal score 无效';
    return {
      evaluation: {
        ...evaluation,
        status: 'error',
        explanation: { code: 'evaluation-error', message: error },
        error,
        evidence: [],
      },
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
    evaluateRule(rule, 'selection', context),
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
    ...definition.signals.entry.map((rule) => ({ rule, scope: 'entry' as const })),
    ...definition.signals.exit.map((rule) => ({ rule, scope: 'exit' as const })),
    ...definition.signals.risk.map((rule) => ({ rule, scope: 'risk' as const })),
  ].map(({ rule, scope }) => evaluateSignal(input, rule, scope, context));
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
    if (rank === undefined) {
      // 有 scoring 时无 score 的 selected 是 partial 结果，不得保持入选绕过 top 截断
      if (!evaluation.result.selected) return evaluation;
      return { ...evaluation, result: { ...evaluation.result, selected: false } };
    }
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
