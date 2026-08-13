import type { Quote } from '../entity/quote.js';
import type { StrategyDslV1 } from '../entity/strategy.js';
import {
  type CompiledStrategyExpression,
  compileStrategyExpression,
  extractExpressionPaths,
} from './expression.js';
import { getStrategyField } from './field-registry.js';

export type StrategyQuotePrefilterDecision =
  | { readonly status: 'keep' }
  | { readonly status: 'reject'; readonly rejectedBy: readonly string[] };

export interface StrategyQuotePrefilter {
  readonly applicableRuleIds: readonly string[];
  readonly skippedRuleIds: readonly string[];
  readonly evaluate: (quote: Quote) => StrategyQuotePrefilterDecision;
}

type CompiledRule = {
  readonly id: string;
  readonly expression: CompiledStrategyExpression;
};

const isQuoteOnlyExpression = (expression: string): boolean =>
  extractExpressionPaths(expression).every(
    (path) => getStrategyField(path)?.dataSource === 'quote',
  );

/**
 * Compile only the conservative part of selection that can be decided from a quote.
 *
 * - `all`: a false quote-only rule is sufficient to reject the stock.
 * - `any`: rejection is safe only when every selection rule is quote-only and all
 *   of them evaluate to false; a daily-bar/meta rule may still match later.
 * - missing/error/unsupported expressions always keep the stock for the full evaluator.
 */
export const compileStrategyQuotePrefilter = (
  definition: StrategyDslV1,
): StrategyQuotePrefilter => {
  const compiled: CompiledRule[] = [];
  const skippedRuleIds: string[] = [];
  for (const rule of definition.selection.rules) {
    try {
      if (!isQuoteOnlyExpression(rule.when)) {
        skippedRuleIds.push(rule.id);
        continue;
      }
      compiled.push({ id: rule.id, expression: compileStrategyExpression(rule.when) });
    } catch {
      skippedRuleIds.push(rule.id);
    }
  }

  return {
    applicableRuleIds: compiled.map((rule) => rule.id),
    skippedRuleIds,
    evaluate: (quote) => {
      if (compiled.length === 0) return { status: 'keep' };
      const context = { quote };
      const values = compiled.map((rule) => ({
        rule,
        result: rule.expression.evaluate(context),
      }));
      if (definition.selection.logic === 'all') {
        const rejectedBy = values.flatMap(({ rule, result }) =>
          result.status === 'value' && !result.value ? [rule.id] : [],
        );
        return rejectedBy.length > 0 ? { status: 'reject', rejectedBy } : { status: 'keep' };
      }
      if (compiled.length !== definition.selection.rules.length) return { status: 'keep' };
      const allKnownFalse = values.every(
        ({ result }) => result.status === 'value' && !result.value,
      );
      return allKnownFalse
        ? { status: 'reject', rejectedBy: values.map(({ rule }) => rule.id) }
        : { status: 'keep' };
    },
  };
};
