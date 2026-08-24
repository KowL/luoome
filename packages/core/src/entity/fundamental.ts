import { createHash } from 'node:crypto';

import { z } from 'zod';

import { InvariantError } from '../error/index.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

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

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const uniqueSorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareStrings);

export const FinancialPeriodTypeSchema = z.enum(['instant', 'quarter', 'annual', 'ttm']);
export type FinancialPeriodType = z.infer<typeof FinancialPeriodTypeSchema>;

export const FinancialFactStatusSchema = z.enum(['reported', 'restated', 'retracted']);
export type FinancialFactStatus = z.infer<typeof FinancialFactStatusSchema>;

export const FinancialCanonicalUnitSchema = z.enum([
  'percent-points',
  'ratio',
  'CNY',
  'CNY-per-share',
  'share',
  'day',
]);
export type FinancialCanonicalUnit = z.infer<typeof FinancialCanonicalUnitSchema>;

export const FinancialMissingReasonSchema = z.enum([
  'not-covered',
  'no-eligible-vintage',
  'publication-unknown',
  'revision-unknown',
  'not-published',
  'recorded-after-cutoff',
  'retracted',
  'insufficient-periods',
  'invalid-unit',
  'invalid-value',
  'no-denominator',
  'group-missing',
  'sample-too-small',
  'source-error',
]);
export type FinancialMissingReason = z.infer<typeof FinancialMissingReasonSchema>;

export const FinancialVintagePolicySchema = z.literal('strict-pit-v1');
export type FinancialVintagePolicy = z.infer<typeof FinancialVintagePolicySchema>;

export const FinancialVintageStatusSchema = z.enum(['complete', 'partial', 'unavailable']);
export type FinancialVintageStatus = z.infer<typeof FinancialVintageStatusSchema>;

export const FinancialFactSchema = z
  .object({
    id: z.string().min(1).max(200),
    stockId: z.string().min(1).max(100),
    metricId: z.string().min(1).max(100),
    periodType: FinancialPeriodTypeSchema,
    periodStart: z.coerce.date().optional(),
    periodEnd: z.coerce.date(),
    value: z.number().finite(),
    canonicalUnit: FinancialCanonicalUnitSchema,
    currency: z.literal('CNY').optional(),
    rawValue: z.number().finite().optional(),
    rawUnit: z.string().min(1).max(100).optional(),
    source: z.string().min(1).max(100),
    sourceRecordId: z.string().min(1).max(200),
    sourceRevision: z.string().min(1).max(200),
    publishedAt: z.coerce.date(),
    revisionPublishedAt: z.coerce.date(),
    recordedAt: z.coerce.date(),
    status: FinancialFactStatusSchema,
    supersedesId: z.string().min(1).max(200).optional(),
    industryKey: z.string().min(1).max(100).optional(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((fact, ctx) => {
    const issue = (path: string, message: string): void =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (fact.periodType !== 'instant' && fact.periodStart === undefined) {
      issue('periodStart', '非 instant 财务事实必须有 periodStart');
    }
    if (fact.periodStart !== undefined && fact.periodStart > fact.periodEnd) {
      issue('periodStart', 'periodStart 不能晚于 periodEnd');
    }
    if (fact.revisionPublishedAt < fact.publishedAt) {
      issue('revisionPublishedAt', 'revisionPublishedAt 不能早于 publishedAt');
    }
    if (fact.recordedAt < fact.revisionPublishedAt) {
      issue('recordedAt', 'recordedAt 不能早于 revisionPublishedAt');
    }
    const currencyUnit = fact.canonicalUnit === 'CNY' || fact.canonicalUnit === 'CNY-per-share';
    if (currencyUnit && fact.currency !== 'CNY') {
      issue('currency', 'CNY 单位必须显式声明 currency=CNY');
    }
    if (!currencyUnit && fact.currency !== undefined) {
      issue('currency', '非 CNY 单位不得声明 currency');
    }
    if (fact.rawValue !== undefined && fact.rawUnit === undefined) {
      issue('rawUnit', '有 rawValue 时必须保留 rawUnit');
    }
    if (fact.rawValue === undefined && fact.rawUnit !== undefined) {
      issue('rawValue', '有 rawUnit 时必须保留 rawValue');
    }
    if (fact.supersedesId === fact.id) {
      issue('supersedesId', 'supersedesId 不能指向自身');
    }
  });
export type FinancialFact = z.infer<typeof FinancialFactSchema>;

const financialFactHashPayload = (fact: FinancialFact): Record<string, unknown> => ({
  id: fact.id,
  stockId: fact.stockId,
  metricId: fact.metricId,
  periodType: fact.periodType,
  ...(fact.periodStart === undefined ? {} : { periodStart: fact.periodStart }),
  periodEnd: fact.periodEnd,
  value: fact.value,
  canonicalUnit: fact.canonicalUnit,
  ...(fact.currency === undefined ? {} : { currency: fact.currency }),
  ...(fact.rawValue === undefined ? {} : { rawValue: fact.rawValue }),
  ...(fact.rawUnit === undefined ? {} : { rawUnit: fact.rawUnit }),
  source: fact.source,
  sourceRecordId: fact.sourceRecordId,
  sourceRevision: fact.sourceRevision,
  publishedAt: fact.publishedAt,
  revisionPublishedAt: fact.revisionPublishedAt,
  recordedAt: fact.recordedAt,
  status: fact.status,
  ...(fact.supersedesId === undefined ? {} : { supersedesId: fact.supersedesId }),
  ...(fact.industryKey === undefined ? {} : { industryKey: fact.industryKey }),
});

export const canonicalFinancialFactJson = (fact: FinancialFact): string =>
  JSON.stringify(canonicalize(financialFactHashPayload(FinancialFactSchema.parse(fact))));

export const financialFactContentHash = (fact: FinancialFact): string =>
  sha256(canonicalFinancialFactJson(fact));

export const assertFinancialFactInvariants = (fact: FinancialFact): void => {
  const parsed = FinancialFactSchema.parse(fact);
  if (parsed.contentHash !== financialFactContentHash(parsed)) {
    throw new InvariantError('FinancialFact.contentHash 与 canonical fact payload 不一致');
  }
};

export const FinancialVintageMissingSchema = z
  .object({
    stockId: z.string().min(1).max(100),
    metricId: z.string().min(1).max(100),
    periodEnd: z.coerce.date().optional(),
    reason: FinancialMissingReasonSchema,
    revisionIds: z.array(z.string().min(1).max(200)).max(200).optional(),
  })
  .strict();
export type FinancialVintageMissing = z.infer<typeof FinancialVintageMissingSchema>;

export const FinancialVintageCoverageSchema = z
  .object({
    requested: z.number().int().nonnegative(),
    available: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    retracted: z.number().int().nonnegative(),
  })
  .strict();
export type FinancialVintageCoverage = z.infer<typeof FinancialVintageCoverageSchema>;

export const FinancialVintageSchema = z
  .object({
    policy: FinancialVintagePolicySchema,
    asOf: z.coerce.date(),
    status: FinancialVintageStatusSchema,
    vintageKey: z.string().regex(/^[a-f0-9]{64}$/),
    facts: z.array(FinancialFactSchema),
    missing: z.array(FinancialVintageMissingSchema),
    coverage: FinancialVintageCoverageSchema,
  })
  .strict()
  .superRefine((vintage, ctx) => {
    const { coverage } = vintage;
    if (coverage.requested !== coverage.available + coverage.missing) {
      ctx.addIssue({
        code: 'custom',
        path: ['coverage'],
        message: 'requested 必须等于 available + missing',
      });
    }
    if (coverage.retracted > coverage.missing) {
      ctx.addIssue({
        code: 'custom',
        path: ['coverage', 'retracted'],
        message: 'retracted 不能大于 missing',
      });
    }
    const expectedStatus =
      coverage.available === 0 ? 'unavailable' : coverage.missing === 0 ? 'complete' : 'partial';
    if (vintage.status !== expectedStatus) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: `status 应为 ${expectedStatus}`,
      });
    }
  });
export type FinancialVintage = z.infer<typeof FinancialVintageSchema>;

const vintageMissingIdentity = (missing: FinancialVintageMissing): Record<string, unknown> => ({
  stockId: missing.stockId,
  metricId: missing.metricId,
  ...(missing.periodEnd === undefined ? {} : { periodEnd: missing.periodEnd }),
  reason: missing.reason,
  ...(missing.revisionIds === undefined ? {} : { revisionIds: uniqueSorted(missing.revisionIds) }),
});

export const canonicalFinancialVintageIdentityJson = (input: {
  readonly policy: FinancialVintagePolicy;
  readonly asOf: Date;
  readonly selectedRevisionIds: readonly string[];
  readonly missing: readonly FinancialVintageMissing[];
}): string =>
  JSON.stringify(
    canonicalize({
      policy: input.policy,
      asOf: input.asOf,
      selectedRevisionIds: uniqueSorted(input.selectedRevisionIds),
      missing: [...input.missing]
        .map(vintageMissingIdentity)
        .sort((left, right) => compareStrings(JSON.stringify(left), JSON.stringify(right))),
    }),
  );

export const financialVintageKey = (input: {
  readonly policy: FinancialVintagePolicy;
  readonly asOf: Date;
  readonly selectedRevisionIds: readonly string[];
  readonly missing: readonly FinancialVintageMissing[];
}): string => sha256(canonicalFinancialVintageIdentityJson(input));

export const assertFinancialVintageInvariants = (vintage: FinancialVintage): void => {
  const parsed = FinancialVintageSchema.parse(vintage);
  for (const fact of parsed.facts) assertFinancialFactInvariants(fact);
  const factIds = parsed.facts.map((fact) => fact.id);
  if (new Set(factIds).size !== factIds.length) {
    throw new InvariantError('FinancialVintage.facts 的 revision id 必须唯一');
  }
  const expectedKey = financialVintageKey({
    policy: parsed.policy,
    asOf: parsed.asOf,
    selectedRevisionIds: factIds,
    missing: parsed.missing,
  });
  if (parsed.vintageKey !== expectedKey) {
    throw new InvariantError('FinancialVintage.vintageKey 与选择的 revision/missing 不一致');
  }
};

export interface ResolveFinancialVintageInput {
  readonly stockIds: readonly string[];
  readonly metricIds: readonly string[];
  readonly asOf: Date;
  readonly policy: FinancialVintagePolicy;
  readonly facts: readonly FinancialFact[];
}

const periodKey = (fact: FinancialFact): string =>
  [fact.periodType, fact.periodStart?.toISOString() ?? '', fact.periodEnd.toISOString()].join('|');

const compareRevision = (left: FinancialFact, right: FinancialFact): number =>
  right.revisionPublishedAt.getTime() - left.revisionPublishedAt.getTime() ||
  compareStrings(right.sourceRevision, left.sourceRevision) ||
  right.recordedAt.getTime() - left.recordedAt.getTime() ||
  compareStrings(right.contentHash, left.contentHash);

const visibleAt = (fact: FinancialFact, asOf: Date): boolean =>
  fact.publishedAt <= asOf && fact.revisionPublishedAt <= asOf && fact.recordedAt <= asOf;

const missingReasonForPeriod = (
  candidates: readonly FinancialFact[],
  asOf: Date,
): FinancialMissingReason => {
  const visible = candidates.filter((fact) => visibleAt(fact, asOf));
  const latestVisible = [...visible].sort(compareRevision)[0];
  if (latestVisible?.status === 'retracted') return 'retracted';
  if (candidates.some((fact) => fact.publishedAt > asOf || fact.revisionPublishedAt > asOf)) {
    return 'not-published';
  }
  if (candidates.some((fact) => fact.recordedAt > asOf)) return 'recorded-after-cutoff';
  return 'no-eligible-vintage';
};

/**
 * Pure strict PIT resolver. Repository/adapters are intentionally outside this
 * function; callers pass the append-only facts visible to the core contract.
 */
export const resolveStrictPitFinancialVintage = (
  input: ResolveFinancialVintageInput,
): FinancialVintage => {
  if (input.policy !== 'strict-pit-v1') {
    throw new InvariantError(`不支持的 financial vintage policy: ${input.policy}`);
  }
  const asOf = new Date(input.asOf.getTime());
  const facts = input.facts.map((fact) => {
    const parsed = FinancialFactSchema.parse(fact);
    assertFinancialFactInvariants(parsed);
    return parsed;
  });
  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  for (const fact of facts) {
    if (fact.supersedesId === undefined) continue;
    const superseded = factsById.get(fact.supersedesId);
    if (superseded === undefined) {
      throw new InvariantError(
        `FinancialFact.supersedesId 未找到目标 revision: ${fact.supersedesId}`,
      );
    }
    if (
      superseded.stockId !== fact.stockId ||
      superseded.metricId !== fact.metricId ||
      superseded.periodType !== fact.periodType ||
      superseded.periodStart?.getTime() !== fact.periodStart?.getTime() ||
      superseded.periodEnd.getTime() !== fact.periodEnd.getTime()
    ) {
      throw new InvariantError(
        'FinancialFact.supersedesId 必须指向同 stock/metric/period 的 revision',
      );
    }
    if (superseded.revisionPublishedAt >= fact.revisionPublishedAt) {
      throw new InvariantError('FinancialFact.supersedesId 必须指向较早 revision');
    }
  }
  const stockIds = uniqueSorted(input.stockIds);
  const metricIds = uniqueSorted(input.metricIds);
  const selected: FinancialFact[] = [];
  const missing: FinancialVintageMissing[] = [];

  for (const stockId of stockIds) {
    for (const metricId of metricIds) {
      const candidates = facts.filter(
        (fact) => fact.stockId === stockId && fact.metricId === metricId,
      );
      const groups = new Map<string, FinancialFact[]>();
      for (const fact of candidates) {
        const key = periodKey(fact);
        const group = groups.get(key);
        if (group === undefined) groups.set(key, [fact]);
        else group.push(fact);
      }
      const entries = [...groups.entries()].sort(([left], [right]) => compareStrings(left, right));
      if (entries.length === 0) {
        missing.push({ stockId, metricId, reason: 'not-covered' });
        continue;
      }
      for (const [, periodFacts] of entries) {
        const eligible = periodFacts.filter((fact) => visibleAt(fact, asOf));
        const latest = [...eligible].sort(compareRevision)[0];
        const periodEnd = periodFacts[0]?.periodEnd;
        if (latest === undefined) {
          missing.push({
            stockId,
            metricId,
            ...(periodEnd === undefined ? {} : { periodEnd }),
            reason: missingReasonForPeriod(periodFacts, asOf),
          });
          continue;
        }
        if (latest.status === 'retracted') {
          missing.push({
            stockId,
            metricId,
            periodEnd: latest.periodEnd,
            reason: 'retracted',
            revisionIds: [latest.id],
          });
          continue;
        }
        selected.push(latest);
      }
    }
  }

  const coverage: FinancialVintageCoverage = {
    requested: selected.length + missing.length,
    available: selected.length,
    missing: missing.length,
    retracted: missing.filter((item) => item.reason === 'retracted').length,
  };
  const status: FinancialVintageStatus =
    coverage.available === 0 ? 'unavailable' : coverage.missing === 0 ? 'complete' : 'partial';
  const vintageKey = financialVintageKey({
    policy: input.policy,
    asOf,
    selectedRevisionIds: selected.map((fact) => fact.id),
    missing,
  });
  const result = FinancialVintageSchema.parse({
    policy: input.policy,
    asOf,
    status,
    vintageKey,
    facts: selected,
    missing,
    coverage,
  });
  assertFinancialVintageInvariants(result);
  return result;
};

export const resolveFinancialVintage = resolveStrictPitFinancialVintage;
