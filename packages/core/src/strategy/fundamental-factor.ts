import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  assertFinancialFactInvariants,
  type FinancialCanonicalUnit,
  FinancialCanonicalUnitSchema,
  type FinancialFact,
  FinancialFactSchema,
  type FinancialMissingReason,
  FinancialMissingReasonSchema,
} from '../entity/fundamental.js';
import { InvariantError } from '../error/index.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const round6 = (value: number): number => Number(value.toFixed(6));

const canonicalize = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
};

export const FundamentalNormalizerIdSchema = z.enum([
  'market-percentile-v1',
  'industry-percentile-v1',
]);
export type FundamentalNormalizerId = z.infer<typeof FundamentalNormalizerIdSchema>;

export const FactorKindSchema = z.enum(['reported', 'derived']);
export type FactorKind = z.infer<typeof FactorKindSchema>;

export const FactorDirectionSchema = z.enum(['higher', 'lower']);
export type FactorDirection = z.infer<typeof FactorDirectionSchema>;

export const FactorPeriodPolicySchema = z.enum([
  'latest-annual',
  'latest-quarter',
  'ttm-4-quarter',
]);
export type FactorPeriodPolicy = z.infer<typeof FactorPeriodPolicySchema>;

export const FactorMissingPolicySchema = z.enum(['unknown', 'exclude-stock', 'fail-run']);
export type FactorMissingPolicy = z.infer<typeof FactorMissingPolicySchema>;

export const FactorDefinitionSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,127}$/),
    registryVersion: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,127}$/),
    kind: FactorKindSchema,
    sourceMetricIds: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9.-]{0,127}$/))
      .min(1)
      .max(8),
    computeId: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,127}$/),
    periodPolicy: FactorPeriodPolicySchema,
    outputUnit: FinancialCanonicalUnitSchema,
    direction: FactorDirectionSchema,
    allowedNormalizers: z.array(FundamentalNormalizerIdSchema).min(1).max(2),
    missingPolicy: FactorMissingPolicySchema,
    validRange: z
      .object({
        min: z.number().finite().optional(),
        max: z.number().finite().optional(),
      })
      .strict()
      .optional(),
    description: z.string().min(1).max(500),
  })
  .strict()
  .superRefine((factor, ctx) => {
    if (new Set(factor.sourceMetricIds).size !== factor.sourceMetricIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['sourceMetricIds'],
        message: 'sourceMetricIds 必须唯一',
      });
    }
    if (new Set(factor.allowedNormalizers).size !== factor.allowedNormalizers.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowedNormalizers'],
        message: 'allowedNormalizers 必须唯一',
      });
    }
    if (
      factor.validRange?.min !== undefined &&
      factor.validRange.max !== undefined &&
      factor.validRange.min > factor.validRange.max
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['validRange'],
        message: 'validRange.min 不能大于 max',
      });
    }
  });
export type FactorDefinition = z.infer<typeof FactorDefinitionSchema>;

export const FUNDAMENTAL_FACTOR_REGISTRY_VERSION = 'fundamental-factor-registry-v1' as const;
export const FUNDAMENTAL_NORMALIZATION_VERSION = 'fundamental-normalization-v1' as const;
export const FUNDAMENTAL_ROUNDING = 'round-to-6-decimal' as const;
export const FUNDAMENTAL_DEFAULT_MIN_SAMPLE_SIZE = 20;

const METRIC_UNITS: Readonly<Record<string, FinancialCanonicalUnit>> = {
  roe: 'percent-points',
  'revenue-yoy': 'percent-points',
  'operating-cashflow': 'CNY',
  revenue: 'CNY',
  pe: 'ratio',
};

const COMPUTE_OUTPUTS: Readonly<
  Record<string, { readonly sourceCount: number; readonly outputUnit: FinancialCanonicalUnit }>
> = {
  identity: { sourceCount: 1, outputUnit: 'percent-points' },
  'identity-ratio': { sourceCount: 1, outputUnit: 'ratio' },
  'divide-percent': { sourceCount: 2, outputUnit: 'percent-points' },
};

const registryDefinitions: readonly FactorDefinition[] = [
  {
    id: 'fundamental.profitability.roe',
    registryVersion: FUNDAMENTAL_FACTOR_REGISTRY_VERSION,
    kind: 'reported',
    sourceMetricIds: ['roe'],
    computeId: 'identity',
    periodPolicy: 'latest-annual',
    outputUnit: 'percent-points',
    direction: 'higher',
    allowedNormalizers: ['market-percentile-v1', 'industry-percentile-v1'],
    missingPolicy: 'unknown',
    validRange: { min: -1000, max: 1000 },
    description: 'Return on equity in canonical percentage points',
  },
  {
    id: 'fundamental.growth.revenue-yoy',
    registryVersion: FUNDAMENTAL_FACTOR_REGISTRY_VERSION,
    kind: 'reported',
    sourceMetricIds: ['revenue-yoy'],
    computeId: 'identity',
    periodPolicy: 'latest-annual',
    outputUnit: 'percent-points',
    direction: 'higher',
    allowedNormalizers: ['market-percentile-v1', 'industry-percentile-v1'],
    missingPolicy: 'unknown',
    validRange: { min: -1000, max: 1000 },
    description: 'Year-over-year revenue growth in percentage points',
  },
  {
    id: 'fundamental.quality.ocf-margin',
    registryVersion: FUNDAMENTAL_FACTOR_REGISTRY_VERSION,
    kind: 'derived',
    sourceMetricIds: ['operating-cashflow', 'revenue'],
    computeId: 'divide-percent',
    periodPolicy: 'latest-annual',
    outputUnit: 'percent-points',
    direction: 'higher',
    allowedNormalizers: ['market-percentile-v1', 'industry-percentile-v1'],
    missingPolicy: 'unknown',
    validRange: { min: -1000, max: 1000 },
    description: 'Operating cash flow divided by revenue in percentage points',
  },
  {
    id: 'fundamental.valuation.pe',
    registryVersion: FUNDAMENTAL_FACTOR_REGISTRY_VERSION,
    kind: 'reported',
    sourceMetricIds: ['pe'],
    computeId: 'identity-ratio',
    periodPolicy: 'latest-quarter',
    outputUnit: 'ratio',
    direction: 'lower',
    allowedNormalizers: ['market-percentile-v1', 'industry-percentile-v1'],
    missingPolicy: 'unknown',
    validRange: { min: 0, max: 5000 },
    description: 'Price-to-earnings ratio',
  },
];

const metricIds = new Set(Object.keys(METRIC_UNITS));

export const canonicalFactorRegistryJson = (
  registry: readonly FactorDefinition[] = registryDefinitions,
): string =>
  JSON.stringify(
    canonicalize(
      [...registry]
        .map((factor) => FactorDefinitionSchema.parse(factor))
        .sort((left, right) => compareStrings(left.id, right.id)),
    ),
  );

export const fundamentalFactorRegistryHash = (
  registry: readonly FactorDefinition[] = registryDefinitions,
): string => sha256(canonicalFactorRegistryJson(registry));

export const assertFactorRegistryInvariants = (registry: readonly FactorDefinition[]): void => {
  const parsed = registry.map((factor) => FactorDefinitionSchema.parse(factor));
  const ids = parsed.map((factor) => factor.id);
  if (new Set(ids).size !== ids.length) throw new InvariantError('Factor registry id 必须唯一');
  for (const factor of parsed) {
    if (factor.registryVersion !== FUNDAMENTAL_FACTOR_REGISTRY_VERSION) {
      throw new InvariantError(`未知 factor registryVersion: ${factor.registryVersion}`);
    }
    for (const metricId of factor.sourceMetricIds) {
      if (!metricIds.has(metricId)) {
        throw new InvariantError(`Factor ${factor.id} 引用了未知 source metric: ${metricId}`);
      }
    }
    const compute = COMPUTE_OUTPUTS[factor.computeId];
    if (compute === undefined)
      throw new InvariantError(`未知 factor computeId: ${factor.computeId}`);
    if (compute.sourceCount !== factor.sourceMetricIds.length) {
      throw new InvariantError(`Factor ${factor.id} 的 compute/source metric 数量不匹配`);
    }
    if (compute.outputUnit !== factor.outputUnit) {
      throw new InvariantError(`Factor ${factor.id} 的 compute/outputUnit 不匹配`);
    }
    for (const metricId of factor.sourceMetricIds) {
      const expectedUnit = METRIC_UNITS[metricId];
      if (factor.computeId === 'identity' || factor.computeId === 'identity-ratio') {
        if (expectedUnit !== factor.outputUnit) {
          throw new InvariantError(`Factor ${factor.id} 的 source/output unit 不匹配`);
        }
      }
    }
  }
};

assertFactorRegistryInvariants(registryDefinitions);

export const FUNDAMENTAL_FACTOR_REGISTRY_V1: readonly FactorDefinition[] = registryDefinitions;
export const FUNDAMENTAL_FACTOR_REGISTRY_HASH = fundamentalFactorRegistryHash(
  FUNDAMENTAL_FACTOR_REGISTRY_V1,
);

export const getFundamentalFactor = (factorId: string): FactorDefinition | undefined =>
  FUNDAMENTAL_FACTOR_REGISTRY_V1.find((factor) => factor.id === factorId);

export const FundamentalFactorObservationSchema = z
  .object({
    stockId: z.string().min(1).max(100),
    factorId: z.string().min(1).max(200),
    rawValue: z.number().finite().optional(),
    unit: FinancialCanonicalUnitSchema,
    direction: FactorDirectionSchema,
    sourceRevisionIds: z.array(z.string().min(1).max(200)).max(200),
    industryKey: z.string().min(1).max(100).optional(),
    missingReason: FinancialMissingReasonSchema.optional(),
  })
  .strict()
  .superRefine((observation, ctx) => {
    if (observation.rawValue === undefined && observation.missingReason === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['missingReason'],
        message: '没有 rawValue 时必须提供 missingReason',
      });
    }
    if (new Set(observation.sourceRevisionIds).size !== observation.sourceRevisionIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['sourceRevisionIds'],
        message: 'sourceRevisionIds 必须唯一',
      });
    }
    if (observation.rawValue !== undefined && observation.missingReason !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['missingReason'],
        message: '有 rawValue 时不得同时声明 missingReason',
      });
    }
  });
export type FundamentalFactorObservation = z.infer<typeof FundamentalFactorObservationSchema>;

export const FundamentalNormalizedFactorSchema = z
  .object({
    stockId: z.string().min(1).max(100),
    factorId: z.string().min(1).max(200),
    normalizer: FundamentalNormalizerIdSchema,
    groupKey: z.string().min(1).max(200),
    sampleSize: z.number().int().nonnegative(),
    denominatorHash: z.string().regex(/^[a-f0-9]{64}$/),
    normalizedValue: z.number().min(0).max(100).finite().optional(),
    missingReason: FinancialMissingReasonSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.normalizedValue === undefined && value.missingReason === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['missingReason'],
        message: '没有 normalizedValue 时必须提供 missingReason',
      });
    }
  });
export type FundamentalNormalizedFactor = z.infer<typeof FundamentalNormalizedFactorSchema>;

export interface EvaluateFundamentalFactorInput {
  readonly stockId: string;
  readonly factor: FactorDefinition | string;
  readonly facts: readonly FinancialFact[];
}

const factorOrThrow = (factor: FactorDefinition | string): FactorDefinition => {
  const resolved =
    typeof factor === 'string' ? getFundamentalFactor(factor) : getFundamentalFactor(factor.id);
  if (resolved === undefined) throw new InvariantError(`未知 factorId: ${factor}`);
  const parsed = FactorDefinitionSchema.parse(typeof factor === 'string' ? resolved : factor);
  if (parsed.registryVersion !== FUNDAMENTAL_FACTOR_REGISTRY_VERSION) {
    throw new InvariantError(`未知 factor registryVersion: ${parsed.registryVersion}`);
  }
  if (JSON.stringify(canonicalize(parsed)) !== JSON.stringify(canonicalize(resolved))) {
    throw new InvariantError(`factor definition 必须来自 immutable registry: ${parsed.id}`);
  }
  return resolved;
};

const expectedPeriodType = (policy: FactorPeriodPolicy): 'annual' | 'quarter' =>
  policy === 'latest-annual' ? 'annual' : 'quarter';

const factPeriodKey = (fact: FinancialFact): string =>
  `${fact.periodType}|${fact.periodStart?.toISOString() ?? ''}|${fact.periodEnd.toISOString()}`;

const byLatestPeriod = (left: FinancialFact, right: FinancialFact): number =>
  right.periodEnd.getTime() - left.periodEnd.getTime() || compareStrings(right.id, left.id);

const missingObservation = (
  stockId: string,
  factor: FactorDefinition,
  missingReason: FinancialMissingReason,
  sourceRevisionIds: readonly string[] = [],
): FundamentalFactorObservation =>
  FundamentalFactorObservationSchema.parse({
    stockId,
    factorId: factor.id,
    unit: factor.outputUnit,
    direction: factor.direction,
    sourceRevisionIds: [...new Set(sourceRevisionIds)].sort(compareStrings),
    missingReason,
  });

/** Compute one registered factor from PIT-selected facts; no fallback is applied. */
export const evaluateFundamentalFactor = (
  input: EvaluateFundamentalFactorInput,
): FundamentalFactorObservation => {
  const factor = factorOrThrow(input.factor);
  const facts = input.facts.map((fact) => {
    const parsed = FinancialFactSchema.parse(fact);
    assertFinancialFactInvariants(parsed);
    return parsed;
  });
  const sourceFacts = facts.filter(
    (fact) => fact.stockId === input.stockId && factor.sourceMetricIds.includes(fact.metricId),
  );
  if (sourceFacts.length === 0)
    return missingObservation(input.stockId, factor, 'no-eligible-vintage');
  if (sourceFacts.some((fact) => fact.status === 'retracted')) {
    return missingObservation(
      input.stockId,
      factor,
      'retracted',
      sourceFacts.filter((fact) => fact.status === 'retracted').map((fact) => fact.id),
    );
  }

  const periodGroups = new Map<string, FinancialFact[]>();
  for (const fact of sourceFacts) {
    if (fact.periodType !== expectedPeriodType(factor.periodPolicy)) continue;
    const group = periodGroups.get(factPeriodKey(fact));
    if (group === undefined) periodGroups.set(factPeriodKey(fact), [fact]);
    else group.push(fact);
  }
  const completeGroups = [...periodGroups.values()]
    .filter((group) => {
      const ids = new Set(group.map((fact) => fact.metricId));
      return factor.sourceMetricIds.every((metricId) => ids.has(metricId));
    })
    .sort((left, right) => byLatestPeriod(left[0] as FinancialFact, right[0] as FinancialFact));

  let selectedGroups: FinancialFact[][] = [];
  if (factor.periodPolicy === 'ttm-4-quarter') {
    const periods = completeGroups.slice(0, 4);
    if (periods.length < 4) {
      return missingObservation(
        input.stockId,
        factor,
        'insufficient-periods',
        completeGroups.flatMap((group) => group.map((fact) => fact.id)),
      );
    }
    selectedGroups = periods;
  } else {
    const latest = completeGroups[0];
    if (latest === undefined) {
      const hasWrongUnit = sourceFacts.some(
        (fact) => fact.canonicalUnit !== METRIC_UNITS[fact.metricId],
      );
      return missingObservation(
        input.stockId,
        factor,
        hasWrongUnit ? 'invalid-unit' : 'insufficient-periods',
        sourceFacts.map((fact) => fact.id),
      );
    }
    selectedGroups = [latest];
  }

  const selectedFacts = selectedGroups.flat();
  const unitInvalid = selectedFacts.some(
    (fact) => fact.canonicalUnit !== METRIC_UNITS[fact.metricId],
  );
  if (unitInvalid) {
    return missingObservation(
      input.stockId,
      factor,
      'invalid-unit',
      selectedFacts.map((fact) => fact.id),
    );
  }

  const valuesByMetric = new Map<string, number>();
  for (const metricId of factor.sourceMetricIds) {
    const values = selectedGroups.flatMap((group) =>
      group.filter((fact) => fact.metricId === metricId).map((fact) => fact.value),
    );
    if (values.length !== selectedGroups.length) {
      return missingObservation(
        input.stockId,
        factor,
        'insufficient-periods',
        selectedFacts.map((fact) => fact.id),
      );
    }
    valuesByMetric.set(
      metricId,
      values.reduce((sum, value) => sum + value, 0),
    );
  }

  let value: number;
  switch (factor.computeId) {
    case 'identity':
    case 'identity-ratio':
      value = valuesByMetric.get(factor.sourceMetricIds[0] as string) as number;
      break;
    case 'divide-percent': {
      const numerator = valuesByMetric.get(factor.sourceMetricIds[0] as string) as number;
      const denominator = valuesByMetric.get(factor.sourceMetricIds[1] as string) as number;
      if (denominator === 0) {
        return missingObservation(
          input.stockId,
          factor,
          'no-denominator',
          selectedFacts.map((fact) => fact.id),
        );
      }
      value = (numerator / denominator) * 100;
      break;
    }
    default:
      throw new InvariantError(`未注册的 factor computeId: ${factor.computeId}`);
  }

  if (!Number.isFinite(value)) {
    return missingObservation(
      input.stockId,
      factor,
      'invalid-value',
      selectedFacts.map((fact) => fact.id),
    );
  }
  if (
    (factor.validRange?.min !== undefined && value < factor.validRange.min) ||
    (factor.validRange?.max !== undefined && value > factor.validRange.max)
  ) {
    return missingObservation(
      input.stockId,
      factor,
      'invalid-value',
      selectedFacts.map((fact) => fact.id),
    );
  }
  const industryKeys = [
    ...new Set(
      selectedFacts.flatMap((fact) => (fact.industryKey === undefined ? [] : [fact.industryKey])),
    ),
  ];
  return FundamentalFactorObservationSchema.parse({
    stockId: input.stockId,
    factorId: factor.id,
    rawValue: value,
    unit: factor.outputUnit,
    direction: factor.direction,
    sourceRevisionIds: [...new Set(selectedFacts.map((fact) => fact.id))].sort(compareStrings),
    ...(industryKeys.length === 1 ? { industryKey: industryKeys[0] } : {}),
  });
};

export interface NormalizeFundamentalFactorInput {
  readonly factor: FactorDefinition | string;
  readonly observations: readonly FundamentalFactorObservation[];
  readonly normalizer: FundamentalNormalizerId;
  readonly minSampleSize?: number;
}

const denominatorHash = (values: readonly { stockId: string; rawValue: number }[]): string =>
  sha256(
    JSON.stringify(
      canonicalize(
        [...values].sort(
          (left, right) =>
            compareStrings(left.stockId, right.stockId) || left.rawValue - right.rawValue,
        ),
      ),
    ),
  );

export const percentileRank = (
  stockId: string,
  rawValue: number,
  values: readonly { stockId: string; rawValue: number }[],
  direction: FactorDirection,
): number => {
  const sorted = [...values].sort(
    (left, right) => left.rawValue - right.rawValue || compareStrings(left.stockId, right.stockId),
  );
  const index = sorted.findIndex(
    (entry) => entry.stockId === stockId && Object.is(entry.rawValue, rawValue),
  );
  if (index < 0) throw new InvariantError(`percentile 输入缺少 stock: ${stockId}`);
  let start = index;
  while (start > 0 && sorted[start - 1]?.rawValue === rawValue) start -= 1;
  let end = index + 1;
  while (end < sorted.length && sorted[end]?.rawValue === rawValue) end += 1;
  const averageRank = (start + 1 + end) / 2;
  const ascending = sorted.length === 1 ? 50 : (100 * (averageRank - 1)) / (sorted.length - 1);
  return round6(direction === 'higher' ? ascending : 100 - ascending);
};

export const normalizeFundamentalFactor = (
  input: NormalizeFundamentalFactorInput,
): readonly FundamentalNormalizedFactor[] => {
  const factor = factorOrThrow(input.factor);
  const normalizer = FundamentalNormalizerIdSchema.parse(input.normalizer);
  if (!factor.allowedNormalizers.includes(normalizer)) {
    throw new InvariantError(`Factor ${factor.id} 不允许 normalizer=${normalizer}`);
  }
  const minSampleSize = input.minSampleSize ?? FUNDAMENTAL_DEFAULT_MIN_SAMPLE_SIZE;
  if (!Number.isInteger(minSampleSize) || minSampleSize < FUNDAMENTAL_DEFAULT_MIN_SAMPLE_SIZE) {
    throw new InvariantError(
      `minSampleSize 不能低于 v1 production 下限 ${FUNDAMENTAL_DEFAULT_MIN_SAMPLE_SIZE}`,
    );
  }
  const observations = input.observations.map((observation) =>
    FundamentalFactorObservationSchema.parse(observation),
  );
  if (
    new Set(observations.map((observation) => observation.stockId)).size !== observations.length
  ) {
    throw new InvariantError(`Factor ${factor.id} 的 observation stockId 必须唯一`);
  }
  for (const observation of observations) {
    if (observation.factorId !== factor.id) {
      throw new InvariantError(`observation.factorId 与 factor 不匹配: ${observation.factorId}`);
    }
    if (observation.unit !== factor.outputUnit || observation.direction !== factor.direction) {
      throw new InvariantError(`observation 的 unit/direction 与 factor 不匹配: ${factor.id}`);
    }
  }

  const valuesByGroup = new Map<string, { stockId: string; rawValue: number }[]>();
  const groupFor = (observation: FundamentalFactorObservation): string | undefined => {
    if (normalizer === 'market-percentile-v1') return 'market';
    return observation.industryKey === undefined
      ? undefined
      : `industry:${observation.industryKey}`;
  };
  for (const observation of observations) {
    const groupKey = groupFor(observation);
    if (groupKey === undefined || observation.rawValue === undefined) continue;
    const values = valuesByGroup.get(groupKey);
    if (values === undefined)
      valuesByGroup.set(groupKey, [
        { stockId: observation.stockId, rawValue: observation.rawValue },
      ]);
    else values.push({ stockId: observation.stockId, rawValue: observation.rawValue });
  }

  const normalized = observations.map((observation) => {
    const groupKey = groupFor(observation) ?? 'industry:missing';
    const values = valuesByGroup.get(groupKey) ?? [];
    const hash = denominatorHash(values);
    if (observation.rawValue === undefined) {
      return FundamentalNormalizedFactorSchema.parse({
        stockId: observation.stockId,
        factorId: factor.id,
        normalizer,
        groupKey,
        sampleSize: values.length,
        denominatorHash: hash,
        missingReason: observation.missingReason,
      });
    }
    if (normalizer === 'industry-percentile-v1' && observation.industryKey === undefined) {
      return FundamentalNormalizedFactorSchema.parse({
        stockId: observation.stockId,
        factorId: factor.id,
        normalizer,
        groupKey,
        sampleSize: 0,
        denominatorHash: hash,
        missingReason: 'group-missing',
      });
    }
    if (values.length < minSampleSize) {
      return FundamentalNormalizedFactorSchema.parse({
        stockId: observation.stockId,
        factorId: factor.id,
        normalizer,
        groupKey,
        sampleSize: values.length,
        denominatorHash: hash,
        missingReason: 'sample-too-small',
      });
    }
    return FundamentalNormalizedFactorSchema.parse({
      stockId: observation.stockId,
      factorId: factor.id,
      normalizer,
      groupKey,
      sampleSize: values.length,
      denominatorHash: hash,
      normalizedValue: percentileRank(
        observation.stockId,
        observation.rawValue,
        values,
        factor.direction,
      ),
    });
  });
  return normalized.sort((left, right) => compareStrings(left.stockId, right.stockId));
};

export const FundamentalScoreVersionComponentSchema = z
  .object({
    factorId: z.string().min(1).max(200),
    weight: z.number().positive().max(1).finite(),
    normalizer: FundamentalNormalizerIdSchema,
  })
  .strict();
export type FundamentalScoreVersionComponent = z.infer<
  typeof FundamentalScoreVersionComponentSchema
>;

export const FundamentalScoreVersionSchema = z
  .object({
    id: z.string().min(1).max(200),
    version: z.number().int().positive(),
    registryVersion: z.string().min(1).max(100),
    registryHash: z.string().regex(/^[a-f0-9]{64}$/),
    normalizationVersion: z.literal(FUNDAMENTAL_NORMALIZATION_VERSION),
    components: z.array(FundamentalScoreVersionComponentSchema).min(1).max(32),
    missingPolicy: FactorMissingPolicySchema,
    rounding: z.literal(FUNDAMENTAL_ROUNDING),
    definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(['draft', 'published', 'retired']),
    createdAt: z.coerce.date(),
    publishedAt: z.coerce.date().optional(),
  })
  .strict()
  .superRefine((version, ctx) => {
    if (
      new Set(version.components.map((component) => component.factorId)).size !==
      version.components.length
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['components'],
        message: 'score component factorId 必须唯一',
      });
    }
    const weight = version.components.reduce((sum, component) => sum + component.weight, 0);
    if (Math.abs(weight - 1) > 1e-9) {
      ctx.addIssue({
        code: 'custom',
        path: ['components'],
        message: 'score component 权重之和必须等于 1',
      });
    }
    if (version.status === 'published' && version.publishedAt === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['publishedAt'],
        message: 'published score version 必须有 publishedAt',
      });
    }
    if (version.publishedAt !== undefined && version.publishedAt < version.createdAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['publishedAt'],
        message: 'publishedAt 不能早于 createdAt',
      });
    }
  });
export type FundamentalScoreVersion = z.infer<typeof FundamentalScoreVersionSchema>;

const normalizedScoreComponents = (components: readonly FundamentalScoreVersionComponent[]) =>
  [...components].sort((left, right) => compareStrings(left.factorId, right.factorId));

const scoreVersionDefinitionPayload = (
  version: FundamentalScoreVersion,
): Record<string, unknown> => ({
  id: version.id,
  version: version.version,
  registryVersion: version.registryVersion,
  registryHash: version.registryHash,
  normalizationVersion: version.normalizationVersion,
  components: normalizedScoreComponents(version.components),
  missingPolicy: version.missingPolicy,
  rounding: version.rounding,
});

export const canonicalFundamentalScoreVersionDefinitionJson = (
  version: FundamentalScoreVersion,
): string =>
  JSON.stringify(
    canonicalize(scoreVersionDefinitionPayload(FundamentalScoreVersionSchema.parse(version))),
  );

export const fundamentalScoreVersionDefinitionHash = (version: FundamentalScoreVersion): string =>
  sha256(canonicalFundamentalScoreVersionDefinitionJson(version));

export const assertFundamentalScoreVersionInvariants = (version: FundamentalScoreVersion): void => {
  const parsed = FundamentalScoreVersionSchema.parse(version);
  if (parsed.registryVersion !== FUNDAMENTAL_FACTOR_REGISTRY_VERSION) {
    throw new InvariantError(`score version registryVersion 不匹配: ${parsed.registryVersion}`);
  }
  if (parsed.registryHash !== FUNDAMENTAL_FACTOR_REGISTRY_HASH) {
    throw new InvariantError('score version.registryHash 不匹配当前 factor registry');
  }
  for (const component of parsed.components) {
    const factor = getFundamentalFactor(component.factorId);
    if (factor === undefined)
      throw new InvariantError(`score version 引用了未知 factor: ${component.factorId}`);
    if (!factor.allowedNormalizers.includes(component.normalizer)) {
      throw new InvariantError(`factor 不允许 score normalizer: ${component.factorId}`);
    }
  }
  if (parsed.definitionHash !== fundamentalScoreVersionDefinitionHash(parsed)) {
    throw new InvariantError('FundamentalScoreVersion.definitionHash 不匹配 canonical definition');
  }
};

const FundamentalIdentityHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const FundamentalScoreRunProviderStatusSchema = z.enum([
  'complete',
  'partial',
  'unavailable',
]);
export type FundamentalScoreRunProviderStatus = z.infer<
  typeof FundamentalScoreRunProviderStatusSchema
>;

export const FundamentalScoreRunStatusSchema = z.enum([
  'started',
  'committed',
  'unavailable',
  'failed',
]);
export type FundamentalScoreRunStatus = z.infer<typeof FundamentalScoreRunStatusSchema>;

/**
 * A terminal run reason is retained as structured audit data rather than a
 * bare error string. `observedAt` is the time the provider/evaluator observed
 * the condition; the run's `committedAt` records when that terminal fact was
 * persisted.
 */
export const FundamentalScoreRunTerminalReasonSchema = z
  .object({
    code: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    message: z.string().min(1).max(500),
    observedAt: z.coerce.date(),
  })
  .strict();
export type FundamentalScoreRunTerminalReason = z.infer<
  typeof FundamentalScoreRunTerminalReasonSchema
>;

export const FundamentalScoreRunCountsSchema = z
  .object({
    evaluated: z.number().int().nonnegative(),
    available: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
  })
  .strict();
export type FundamentalScoreRunCounts = z.infer<typeof FundamentalScoreRunCountsSchema>;

export const FundamentalScoreRunSchema = z
  .object({
    id: z.string().min(1).max(200),
    scoreVersionId: z.string().min(1).max(200),
    scoreVersionHash: FundamentalIdentityHashSchema,
    registryHash: FundamentalIdentityHashSchema,
    universeSyncId: z.string().min(1).max(200),
    universeMemberChecksum: FundamentalIdentityHashSchema,
    asOf: z.coerce.date(),
    financialVintageKey: FundamentalIdentityHashSchema,
    normalizerDenominatorHash: FundamentalIdentityHashSchema,
    counts: FundamentalScoreRunCountsSchema,
    providerStatus: FundamentalScoreRunProviderStatusSchema,
    evaluatorCodeIdentity: z.string().min(1).max(200),
    status: FundamentalScoreRunStatusSchema,
    createdAt: z.coerce.date(),
    committedAt: z.coerce.date().optional(),
    terminalReason: FundamentalScoreRunTerminalReasonSchema.optional(),
  })
  .strict()
  .superRefine((run, ctx) => {
    const classified = run.counts.available + run.counts.missing + run.counts.excluded;
    if (classified > run.counts.evaluated) {
      ctx.addIssue({
        code: 'custom',
        path: ['counts', 'evaluated'],
        message: 'available + missing + excluded 不能大于 evaluated',
      });
    }
    if (run.status === 'committed' && run.counts.evaluated !== classified) {
      ctx.addIssue({
        code: 'custom',
        path: ['counts', 'evaluated'],
        message: 'committed run 的 evaluated 必须等于 available + missing + excluded',
      });
    }

    const terminal = run.status !== 'started';
    if (run.status === 'started' && run.committedAt !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['committedAt'],
        message: 'started score run 不得有 committedAt',
      });
    }
    if (terminal && run.committedAt === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['committedAt'],
        message: 'terminal score run 必须有 committedAt',
      });
    }
    if (run.committedAt !== undefined && run.committedAt.getTime() < run.createdAt.getTime()) {
      ctx.addIssue({
        code: 'custom',
        path: ['committedAt'],
        message: 'committedAt 不能早于 createdAt',
      });
    }

    const requiresReason = run.status === 'unavailable' || run.status === 'failed';
    if (requiresReason && run.terminalReason === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['terminalReason'],
        message: `${run.status} score run 必须保留 terminalReason`,
      });
    }
    if (!requiresReason && run.terminalReason !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['terminalReason'],
        message: `${run.status} score run 不得有 terminalReason`,
      });
    }
    if (
      run.terminalReason !== undefined &&
      run.terminalReason.observedAt.getTime() < run.createdAt.getTime()
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['terminalReason', 'observedAt'],
        message: 'terminalReason.observedAt 不能早于 createdAt',
      });
    }
    if (
      run.terminalReason !== undefined &&
      run.committedAt !== undefined &&
      run.terminalReason.observedAt.getTime() > run.committedAt.getTime()
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['terminalReason', 'observedAt'],
        message: 'terminalReason.observedAt 不能晚于 committedAt',
      });
    }
  });
export type FundamentalScoreRun = z.infer<typeof FundamentalScoreRunSchema>;

export const assertFundamentalScoreRunInvariants = (run: FundamentalScoreRun): void => {
  FundamentalScoreRunSchema.parse(run);
};

export const FundamentalScoreResultComponentSchema = z
  .object({
    factorId: z.string().min(1).max(200),
    rawValue: z.number().finite().optional(),
    unit: FinancialCanonicalUnitSchema,
    direction: FactorDirectionSchema,
    normalizedValue: z.number().min(0).max(100).finite().optional(),
    contribution: z.number().min(0).max(100).finite().optional(),
    sourceRevisionIds: z.array(z.string().min(1).max(200)).max(200),
    missingReason: FinancialMissingReasonSchema.optional(),
  })
  .strict()
  .superRefine((component, ctx) => {
    if (component.rawValue === undefined && component.normalizedValue !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['normalizedValue'],
        message: '无 rawValue 不得有 normalizedValue',
      });
    }
    if (component.normalizedValue === undefined && component.contribution !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['contribution'],
        message: '无 normalizedValue 不得有 contribution',
      });
    }
    if (component.rawValue === undefined && component.missingReason === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['missingReason'],
        message: '无 rawValue 时必须保留 missingReason',
      });
    }
  });
export type FundamentalScoreResultComponent = z.infer<typeof FundamentalScoreResultComponentSchema>;

export const FundamentalScoreResultSchema = z
  .object({
    scoreRunId: z.string().min(1).max(200),
    stockId: z.string().min(1).max(100),
    status: z.enum(['available', 'missing', 'excluded', 'unavailable']),
    score: z.number().min(0).max(100).finite().optional(),
    rank: z.number().int().positive().optional(),
    components: z.array(FundamentalScoreResultComponentSchema).min(1).max(32),
    dataAsOf: z.coerce.date(),
    vintageKey: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.status === 'available' && result.score === undefined) {
      ctx.addIssue({ code: 'custom', path: ['score'], message: 'available result 必须有 score' });
    }
    if (result.status === 'available') {
      for (const [index, component] of result.components.entries()) {
        if (component.rawValue === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['components', index, 'rawValue'],
            message: 'available result component 必须有 rawValue',
          });
        }
        if (component.normalizedValue === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['components', index, 'normalizedValue'],
            message: 'available result component 必须有 normalizedValue',
          });
        }
        if (component.contribution === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['components', index, 'contribution'],
            message: 'available result component 必须有 contribution',
          });
        }
        if (component.missingReason !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['components', index, 'missingReason'],
            message: 'available result component 不得有 missingReason',
          });
        }
      }
    }
    if (result.status !== 'available' && result.score !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['score'],
        message: '非 available result 不得有 score',
      });
    }
    if (result.status !== 'available' && result.rank !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['rank'], message: '非 available result 不得有 rank' });
    }
    if (
      (result.status === 'missing' || result.status === 'excluded') &&
      !result.components.some((component) => component.missingReason !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['components'],
        message: '非 available result 至少要保留一个 missingReason',
      });
    }
  });
export type FundamentalScoreResult = z.infer<typeof FundamentalScoreResultSchema>;

export const assertFundamentalScoreResultInvariants = (result: FundamentalScoreResult): void => {
  const parsed = FundamentalScoreResultSchema.parse(result);
  const factorIds = parsed.components.map((component) => component.factorId);
  if (new Set(factorIds).size !== factorIds.length) {
    throw new InvariantError('FundamentalScoreResult component factorId 必须唯一');
  }
  if (parsed.status === 'available') {
    const contributionSum = parsed.components.reduce(
      (sum, component) => sum + (component.contribution ?? 0),
      0,
    );
    if (parsed.score !== round6(contributionSum)) {
      throw new InvariantError('FundamentalScoreResult.score 与 contribution 之和不一致');
    }
  }
};

/** The atomic payload accepted by FundamentalScoreRunRepository.commit. */
export const FundamentalScoreRunCommitSchema = z
  .object({
    run: FundamentalScoreRunSchema,
    results: z.array(FundamentalScoreResultSchema),
  })
  .strict();
export interface FundamentalScoreRunCommit {
  readonly run: FundamentalScoreRun;
  readonly results: readonly FundamentalScoreResult[];
}

/**
 * Validates the cross-row part of a terminal score-run commit. Repositories
 * still own atomicity/idempotence; this helper keeps both implementations on
 * the same result-count and identity contract.
 */
export const assertFundamentalScoreRunCommitInvariants = (
  input: FundamentalScoreRunCommit,
): void => {
  const parsed = FundamentalScoreRunCommitSchema.parse(input);
  assertFundamentalScoreRunInvariants(parsed.run);
  parsed.results.forEach(assertFundamentalScoreResultInvariants);

  if (parsed.run.status === 'started') {
    throw new InvariantError('score run commit 必须提交 terminal status');
  }
  if (parsed.run.status !== 'committed' && parsed.results.length > 0) {
    throw new InvariantError('非 committed score run 不得产生可消费 results');
  }
  if (parsed.run.status !== 'committed') return;

  if (parsed.results.length !== parsed.run.counts.evaluated) {
    throw new InvariantError('score run results 数量必须等于 counts.evaluated');
  }
  const stockIds = parsed.results.map((result) => result.stockId);
  if (new Set(stockIds).size !== stockIds.length) {
    throw new InvariantError('score run results 的 stockId 必须唯一');
  }

  const counts = {
    available: parsed.results.filter((result) => result.status === 'available').length,
    missing: parsed.results.filter((result) => result.status === 'missing').length,
    excluded: parsed.results.filter((result) => result.status === 'excluded').length,
  };
  if (
    counts.available !== parsed.run.counts.available ||
    counts.missing !== parsed.run.counts.missing ||
    counts.excluded !== parsed.run.counts.excluded
  ) {
    throw new InvariantError('score run counts 与 results status 分布不一致');
  }

  const available = parsed.results.filter((result) => result.status === 'available');
  const ranks = available
    .map((result) => result.rank)
    .sort(
      (left, right) => (left ?? Number.POSITIVE_INFINITY) - (right ?? Number.POSITIVE_INFINITY),
    );
  if (ranks.some((rank) => rank === undefined)) {
    throw new InvariantError('committed available result 必须有 rank');
  }
  ranks.forEach((rank, index) => {
    if (rank !== index + 1) {
      throw new InvariantError('committed result rank 必须从 1 连续递增');
    }
  });

  for (const result of parsed.results) {
    if (result.scoreRunId !== parsed.run.id) {
      throw new InvariantError('result.scoreRunId 必须指向当前 score run');
    }
    if (result.dataAsOf.getTime() !== parsed.run.asOf.getTime()) {
      throw new InvariantError('result.dataAsOf 必须与 score run.asOf 一致');
    }
    if (result.vintageKey !== parsed.run.financialVintageKey) {
      throw new InvariantError('result.vintageKey 必须与 score run.financialVintageKey 一致');
    }
  }
};

export interface FundamentalScoreEngineInput {
  readonly scoreRunId: string;
  readonly scoreVersion: FundamentalScoreVersion;
  readonly stockIds: readonly string[];
  readonly observations: readonly FundamentalFactorObservation[];
  readonly dataAsOf: Date;
  readonly vintageKey: string;
  readonly minSampleSize?: number;
}

export interface FundamentalScoreEngineResult {
  readonly status: 'complete' | 'partial' | 'unavailable';
  readonly results: readonly FundamentalScoreResult[];
  readonly denominatorHash: string;
  readonly counts: {
    readonly evaluated: number;
    readonly available: number;
    readonly missing: number;
    readonly excluded: number;
  };
}

/** Deterministic market/industry percentile score engine; missing is never zero-filled. */
export const runFundamentalScore = (
  input: FundamentalScoreEngineInput,
): FundamentalScoreEngineResult => {
  const scoreVersion = FundamentalScoreVersionSchema.parse(input.scoreVersion);
  assertFundamentalScoreVersionInvariants(scoreVersion);
  if (scoreVersion.status !== 'published' || scoreVersion.publishedAt === undefined) {
    throw new InvariantError('score engine 只接受已 published 的 FundamentalScoreVersion');
  }
  if (!/^[a-f0-9]{64}$/.test(input.vintageKey)) {
    throw new InvariantError('score engine 要求合法 vintageKey');
  }
  const observations = input.observations.map((observation) =>
    FundamentalFactorObservationSchema.parse(observation),
  );
  const stockIds = [...new Set(input.stockIds)].sort(compareStrings);
  const observationsByKey = new Map(
    observations.map((observation) => [
      `${observation.stockId}|${observation.factorId}`,
      observation,
    ]),
  );
  if (observationsByKey.size !== observations.length) {
    throw new InvariantError('score engine observation stockId/factorId 必须唯一');
  }

  const normalizedByKey = new Map<string, FundamentalNormalizedFactor>();
  const denominatorInputs: {
    factorId: string;
    normalizer: FundamentalNormalizerId;
    hash: string;
  }[] = [];
  for (const component of scoreVersion.components) {
    const factor = getFundamentalFactor(component.factorId) as FactorDefinition;
    const factorObservations = stockIds.map((stockId) => {
      const observation = observationsByKey.get(`${stockId}|${factor.id}`);
      return observation ?? missingObservation(stockId, factor, 'no-eligible-vintage');
    });
    const normalized = normalizeFundamentalFactor({
      factor,
      observations: factorObservations,
      normalizer: component.normalizer,
      ...(input.minSampleSize === undefined ? {} : { minSampleSize: input.minSampleSize }),
    });
    for (const value of normalized)
      normalizedByKey.set(`${value.stockId}|${value.factorId}`, value);
    const denominatorHashes = [...new Set(normalized.map((value) => value.denominatorHash))].sort(
      compareStrings,
    );
    for (const hash of denominatorHashes) {
      denominatorInputs.push({ factorId: factor.id, normalizer: component.normalizer, hash });
    }
  }

  const draftResults = stockIds.map((stockId) => {
    let hasMissing = false;
    const components = scoreVersion.components.map((component) => {
      const factor = getFundamentalFactor(component.factorId) as FactorDefinition;
      const observation =
        observationsByKey.get(`${stockId}|${factor.id}`) ??
        missingObservation(stockId, factor, 'no-eligible-vintage');
      const normalized = normalizedByKey.get(
        `${stockId}|${factor.id}`,
      ) as FundamentalNormalizedFactor;
      const missingReason = normalized.missingReason ?? observation.missingReason;
      if (missingReason !== undefined || normalized.normalizedValue === undefined)
        hasMissing = true;
      const contribution =
        normalized.normalizedValue === undefined
          ? undefined
          : round6(normalized.normalizedValue * component.weight);
      return {
        factorId: factor.id,
        ...(observation.rawValue === undefined ? {} : { rawValue: observation.rawValue }),
        unit: factor.outputUnit,
        direction: factor.direction,
        ...(normalized.normalizedValue === undefined
          ? {}
          : { normalizedValue: normalized.normalizedValue }),
        ...(contribution === undefined ? {} : { contribution }),
        sourceRevisionIds: [...observation.sourceRevisionIds],
        ...(missingReason === undefined ? {} : { missingReason }),
      } satisfies FundamentalScoreResultComponent;
    });
    return { stockId, components, hasMissing };
  });

  const runUnavailable =
    scoreVersion.missingPolicy === 'fail-run' && draftResults.some((result) => result.hasMissing);
  const preliminary = draftResults.map((draft) => {
    const status = runUnavailable
      ? 'unavailable'
      : draft.hasMissing
        ? scoreVersion.missingPolicy === 'exclude-stock'
          ? 'excluded'
          : 'missing'
        : 'available';
    const score =
      status === 'available'
        ? round6(
            draft.components.reduce((sum, component) => sum + (component.contribution ?? 0), 0),
          )
        : undefined;
    return {
      scoreRunId: input.scoreRunId,
      stockId: draft.stockId,
      status,
      ...(score === undefined ? {} : { score }),
      components: draft.components,
      dataAsOf: new Date(input.dataAsOf.getTime()),
      vintageKey: input.vintageKey,
    } satisfies Omit<FundamentalScoreResult, 'rank'>;
  });
  const ranked = [...preliminary]
    .filter((result) => result.status === 'available' && result.score !== undefined)
    .sort(
      (left, right) =>
        (right.score as number) - (left.score as number) ||
        compareStrings(left.stockId, right.stockId),
    );
  const rankByStock = new Map(ranked.map((result, index) => [result.stockId, index + 1]));
  const results = preliminary.map((result) =>
    FundamentalScoreResultSchema.parse({
      ...result,
      ...(rankByStock.get(result.stockId) === undefined
        ? {}
        : { rank: rankByStock.get(result.stockId) }),
    }),
  );
  results.forEach(assertFundamentalScoreResultInvariants);
  const counts = {
    evaluated: results.length,
    available: results.filter((result) => result.status === 'available').length,
    missing: results.filter((result) => result.status === 'missing').length,
    excluded: results.filter((result) => result.status === 'excluded').length,
  };
  const status: FundamentalScoreEngineResult['status'] =
    runUnavailable || counts.available === 0
      ? 'unavailable'
      : counts.missing > 0 || counts.excluded > 0
        ? 'partial'
        : 'complete';
  return {
    status,
    results,
    denominatorHash: sha256(JSON.stringify(canonicalize(denominatorInputs))),
    counts,
  };
};

export const scoreFundamentalFactors = runFundamentalScore;
