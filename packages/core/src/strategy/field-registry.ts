import { KNOWN_INDICATOR_KEYS } from '../entity/indicator-set.js';
import type { StrategyDslV1 } from '../entity/strategy.js';
import {
  assertExpressionSyntax,
  assertTemplateSyntax,
  extractExpressionPaths,
  extractTemplatePaths,
} from './expression.js';

export type StrategyFieldType = 'number' | 'boolean' | 'string';
export type StrategyFieldDataSource = 'quote' | 'daily-bars' | 'meta' | 'limit-up-ladder';

export interface StrategyFieldDefinition {
  readonly path: string;
  readonly type: StrategyFieldType;
  readonly unit?: string;
  readonly requiredLookback?: number;
  readonly dataSource: StrategyFieldDataSource;
  readonly availableForCoverage: readonly ['CN_A_SHARES_SH_SZ'];
}

const coverage = ['CN_A_SHARES_SH_SZ'] as const;
const indicatorLookback: Readonly<Record<string, number>> = {
  ma5: 5,
  ma10: 10,
  ma20: 20,
  ma60: 60,
  momentum20Pct: 21,
  maDistance20Pct: 20,
  maDistance60Pct: 60,
  daysSinceMa20CrossUp: 120,
  daysSinceMa60CrossUp: 120,
  daysAboveMa20: 120,
  rsi14: 15,
  macdDif: 35,
  macdDea: 35,
  macdHist: 35,
  volMa5: 5,
  volMa20: 20,
  volRatio5_20: 20,
  high20: 20,
  low20: 20,
  bollMiddle20: 20,
  bollUpper20: 20,
  bollLower20: 20,
  bollBandwidth20Pct: 20,
  bollPosition20: 20,
};

const quoteFields: readonly StrategyFieldDefinition[] = [
  {
    path: 'quote.open',
    type: 'number',
    unit: 'CNY',
    dataSource: 'quote',
    availableForCoverage: coverage,
  },
  {
    path: 'quote.high',
    type: 'number',
    unit: 'CNY',
    dataSource: 'quote',
    availableForCoverage: coverage,
  },
  {
    path: 'quote.low',
    type: 'number',
    unit: 'CNY',
    dataSource: 'quote',
    availableForCoverage: coverage,
  },
  {
    path: 'quote.close',
    type: 'number',
    unit: 'CNY',
    dataSource: 'quote',
    availableForCoverage: coverage,
  },
  {
    path: 'quote.volume',
    type: 'number',
    unit: 'share',
    dataSource: 'quote',
    availableForCoverage: coverage,
  },
  {
    path: 'quote.prevClose',
    type: 'number',
    unit: 'CNY',
    dataSource: 'quote',
    availableForCoverage: coverage,
  },
];

const indicatorFields: readonly StrategyFieldDefinition[] = KNOWN_INDICATOR_KEYS.map((key) => ({
  path: `indicators.${key}`,
  type: 'number',
  ...(key.includes('Pct') ? { unit: 'percent' } : {}),
  ...(indicatorLookback[key] === undefined ? {} : { requiredLookback: indicatorLookback[key] }),
  dataSource: 'daily-bars',
  availableForCoverage: coverage,
}));

const metaFields: readonly StrategyFieldDefinition[] = [
  { path: 'meta.recentLimitUp', type: 'boolean', dataSource: 'daily-bars', requiredLookback: 6 },
  {
    path: 'meta.daysSinceLimitUp',
    type: 'number',
    unit: 'trading-day',
    dataSource: 'daily-bars',
    requiredLookback: 6,
  },
  { path: 'meta.priceUp', type: 'boolean', dataSource: 'daily-bars', requiredLookback: 4 },
  {
    path: 'meta.sectorAvgChange3d',
    type: 'number',
    unit: 'ratio',
    dataSource: 'daily-bars',
    requiredLookback: 4,
  },
  {
    path: 'meta.stockChange3d',
    type: 'number',
    unit: 'ratio',
    dataSource: 'daily-bars',
    requiredLookback: 4,
  },
  {
    path: 'meta.limitUpLevel',
    type: 'number',
    unit: 'board',
    dataSource: 'limit-up-ladder',
    requiredLookback: 1,
  },
  {
    path: 'meta.limitUpToday',
    type: 'boolean',
    dataSource: 'limit-up-ladder',
    requiredLookback: 1,
  },
].map((field) => ({ ...field, availableForCoverage: coverage })) as StrategyFieldDefinition[];

export const STRATEGY_FIELD_REGISTRY: readonly StrategyFieldDefinition[] = [
  ...quoteFields,
  ...indicatorFields,
  ...metaFields,
];

const registryByPath = new Map(STRATEGY_FIELD_REGISTRY.map((field) => [field.path, field]));

export const getStrategyField = (path: string): StrategyFieldDefinition | undefined =>
  registryByPath.get(path);

export interface StrategyDefinitionReferences {
  readonly paths: readonly string[];
  readonly fields: readonly StrategyFieldDefinition[];
  readonly validationErrors: readonly string[];
  readonly requiredLookback: number;
  readonly dataSources: readonly StrategyFieldDataSource[];
}

export const inspectStrategyDefinitionReferences = (
  definition: StrategyDslV1,
): StrategyDefinitionReferences => {
  const paths = new Set<string>();
  const errors: string[] = [];
  const addExpression = (label: string, expression: string): void => {
    try {
      assertExpressionSyntax(expression);
      for (const path of extractExpressionPaths(expression)) paths.add(path);
    } catch (error) {
      errors.push(`${label} 表达式无效: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const addEvidence = (label: string, templates: readonly string[]): void => {
    for (const [index, template] of templates.entries()) {
      try {
        assertTemplateSyntax(template);
        for (const path of extractTemplatePaths(template)) paths.add(path);
      } catch (error) {
        errors.push(
          `${label}.evidence[${index}] 表达式无效: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  };

  for (const rule of definition.selection.rules) {
    addExpression(`selection.${rule.id}.when`, rule.when);
    addEvidence(`selection.${rule.id}`, rule.evidence);
  }
  for (const component of definition.scoring?.components ?? []) {
    addExpression(`scoring.${component.ruleId}.score`, component.score);
  }
  for (const rule of [
    ...definition.signals.entry,
    ...definition.signals.exit,
    ...definition.signals.risk,
  ]) {
    addExpression(`signal.${rule.id}.when`, rule.when);
    addExpression(`signal.${rule.id}.score`, rule.score);
    addEvidence(`signal.${rule.id}`, rule.evidence);
  }

  const ruleIds = [
    ...definition.selection.rules.map((rule) => rule.id),
    ...definition.signals.entry.map((rule) => rule.id),
    ...definition.signals.exit.map((rule) => rule.id),
    ...definition.signals.risk.map((rule) => rule.id),
  ];
  for (const id of new Set(ruleIds)) {
    if (ruleIds.filter((candidate) => candidate === id).length > 1) {
      errors.push(`Strategy rule id 重复: ${id}`);
    }
  }

  const sortedPaths = [...paths].sort();
  const fields = sortedPaths.flatMap((path) => {
    const field = getStrategyField(path);
    return field === undefined ? [] : [field];
  });
  return {
    paths: sortedPaths,
    fields,
    validationErrors: [
      ...errors,
      ...sortedPaths
        .filter((path) => getStrategyField(path) === undefined)
        .map((path) => `未注册的 Strategy 字段: ${path}`),
    ],
    requiredLookback: Math.max(0, ...fields.map((field) => field.requiredLookback ?? 0)),
    dataSources: [...new Set(fields.map((field) => field.dataSource))].sort(),
  };
};
