import { describe, expect, it } from 'vitest';

import * as core from '../index.js';
import {
  assertFactorRegistryInvariants,
  assertFundamentalScoreResultInvariants,
  assertFundamentalScoreVersionInvariants,
  evaluateFundamentalFactor,
  type FactorDefinition,
  FactorDefinitionSchema,
  FUNDAMENTAL_FACTOR_REGISTRY_HASH,
  FUNDAMENTAL_FACTOR_REGISTRY_V1,
  type FundamentalFactorObservation,
  FundamentalScoreResultSchema,
  type FundamentalScoreVersion,
  fundamentalFactorRegistryHash,
  fundamentalScoreVersionDefinitionHash,
  getFundamentalFactor,
  normalizeFundamentalFactor,
  percentileRank,
  runFundamentalScore,
} from '../strategy/fundamental-factor.js';
import {
  assertFinancialFactInvariants,
  canonicalFinancialFactJson,
  type FinancialFact,
  FinancialFactSchema,
  financialFactContentHash,
  resolveStrictPitFinancialVintage,
} from './fundamental.js';

const date = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

const makeFact = (overrides: Partial<FinancialFact> = {}): FinancialFact => {
  const { contentHash: explicitHash, ...rest } = {
    id: 'fact-1',
    stockId: '000001.SZ',
    metricId: 'roe',
    periodType: 'annual',
    periodStart: date('2022-01-01'),
    periodEnd: date('2022-12-31'),
    value: 10,
    canonicalUnit: 'percent-points',
    source: 'fixture-provider',
    sourceRecordId: 'row-1',
    sourceRevision: '1',
    publishedAt: date('2023-03-31'),
    revisionPublishedAt: date('2023-03-31'),
    recordedAt: date('2023-04-01'),
    status: 'reported',
    ...overrides,
  };
  const candidate = {
    ...rest,
    contentHash: explicitHash ?? '0'.repeat(64),
  } as FinancialFact;
  return explicitHash === undefined
    ? { ...candidate, contentHash: financialFactContentHash(candidate) }
    : candidate;
};

const resolve = (
  facts: readonly FinancialFact[],
  asOf: string,
  stockIds: readonly string[] = ['000001.SZ'],
) =>
  resolveStrictPitFinancialVintage({
    stockIds,
    metricIds: ['roe'],
    asOf: date(asOf),
    policy: 'strict-pit-v1',
    facts,
  });

const factor = (factorId: string): FactorDefinition => {
  const definition = getFundamentalFactor(factorId);
  if (definition === undefined) throw new Error(`missing fixture factor: ${factorId}`);
  return definition;
};

const makeObservation = (
  factorId: string,
  stockId: string,
  rawValue?: number,
  industryKey?: string,
): FundamentalFactorObservation => {
  const definition = factor(factorId);
  return {
    stockId,
    factorId,
    ...(rawValue === undefined ? {} : { rawValue }),
    unit: definition.outputUnit,
    direction: definition.direction,
    sourceRevisionIds: [`${stockId}-${factorId}`],
    ...(industryKey === undefined ? {} : { industryKey }),
  };
};

const makeScoreVersion = (
  overrides: Partial<FundamentalScoreVersion> = {},
): FundamentalScoreVersion => {
  const { definitionHash: _definitionHash, ...withoutHash } = {
    id: 'fundamental-score-audit-v1',
    version: 1,
    registryVersion: 'fundamental-factor-registry-v1',
    registryHash: FUNDAMENTAL_FACTOR_REGISTRY_HASH,
    normalizationVersion: 'fundamental-normalization-v1' as const,
    components: [
      {
        factorId: 'fundamental.profitability.roe',
        weight: 1,
        normalizer: 'market-percentile-v1' as const,
      },
    ],
    missingPolicy: 'unknown' as const,
    rounding: 'round-to-6-decimal' as const,
    status: 'published' as const,
    createdAt: date('2024-01-01'),
    publishedAt: date('2024-01-02'),
    ...overrides,
  };
  const candidate = {
    ...withoutHash,
    definitionHash: '0'.repeat(64),
  } as FundamentalScoreVersion;
  return {
    ...candidate,
    definitionHash: fundamentalScoreVersionDefinitionHash(candidate),
  };
};

describe('P3-0 fundamental contract audit', () => {
  describe('FinancialFact schema and identity', () => {
    it('accepts a valid fact and hashes canonical content independent of key order', () => {
      const fact = makeFact();
      const reordered = {
        contentHash: fact.contentHash,
        recordedAt: fact.recordedAt,
        status: fact.status,
        sourceRevision: fact.sourceRevision,
        sourceRecordId: fact.sourceRecordId,
        source: fact.source,
        revisionPublishedAt: fact.revisionPublishedAt,
        publishedAt: fact.publishedAt,
        canonicalUnit: fact.canonicalUnit,
        value: fact.value,
        periodEnd: fact.periodEnd,
        periodStart: fact.periodStart,
        periodType: fact.periodType,
        metricId: fact.metricId,
        stockId: fact.stockId,
        id: fact.id,
      } satisfies FinancialFact;

      expect(FinancialFactSchema.parse(fact)).toEqual(fact);
      expect(canonicalFinancialFactJson(reordered)).toBe(canonicalFinancialFactJson(fact));
      expect(financialFactContentHash(reordered)).toBe(fact.contentHash);
      expect(() => assertFinancialFactInvariants(fact)).not.toThrow();
    });

    it.each([
      ['NaN value', { value: Number.NaN }],
      ['infinite value', { value: Number.POSITIVE_INFINITY }],
      ['unknown canonical unit', { canonicalUnit: 'USD' }],
      ['annual fact without period start', { periodStart: undefined }],
      ['period start after period end', { periodStart: date('2023-01-01') }],
      ['revision published before publication', { revisionPublishedAt: date('2023-03-01') }],
      ['recorded before revision publication', { recordedAt: date('2023-03-01') }],
      ['CNY fact without explicit currency', { canonicalUnit: 'CNY' }],
      ['non-currency fact with currency', { currency: 'CNY' }],
    ] as const)('rejects %s', (_label, overrides) => {
      expect(() =>
        FinancialFactSchema.parse(makeFact(overrides as Partial<FinancialFact>)),
      ).toThrow();
    });

    it('rejects an incorrect content hash', () => {
      const fact = makeFact({ contentHash: '0'.repeat(64) });
      expect(() => assertFinancialFactInvariants(fact)).toThrow(
        'FinancialFact.contentHash 与 canonical fact payload 不一致',
      );
    });
  });

  describe('strict PIT vintage golden vectors', () => {
    it('selects the revision visible at the requested cutoff', () => {
      const reported = makeFact({ id: 'reported', value: 10, sourceRevision: '1' });
      const restated = makeFact({
        id: 'restated',
        value: 12,
        sourceRevision: '2',
        publishedAt: date('2024-07-01'),
        revisionPublishedAt: date('2024-07-01'),
        recordedAt: date('2024-07-02'),
        status: 'restated',
        supersedesId: 'reported',
      });

      const beforeRestatement = resolve([reported, restated], '2024-06-30');
      const afterRestatement = resolve([reported, restated], '2024-07-03');

      expect(beforeRestatement).toMatchObject({
        status: 'complete',
        facts: [{ id: 'reported', value: 10 }],
      });
      expect(afterRestatement).toMatchObject({
        status: 'complete',
        facts: [{ id: 'restated', value: 12 }],
      });
    });

    it('does not select a value recorded after the cutoff', () => {
      const lateRecorded = makeFact({
        publishedAt: date('2023-03-31'),
        revisionPublishedAt: date('2023-03-31'),
        recordedAt: date('2023-04-02'),
      });
      const vintage = resolve([lateRecorded], '2023-04-01');

      expect(vintage.facts).toEqual([]);
      expect(vintage).toMatchObject({
        status: 'unavailable',
        coverage: { requested: 1, available: 0, missing: 1 },
        missing: [{ reason: 'recorded-after-cutoff' }],
      });
    });

    it('treats an eligible retraction as a terminal event instead of falling back', () => {
      const reported = makeFact({ id: 'reported', value: 10, sourceRevision: '1' });
      const retracted = makeFact({
        id: 'retracted',
        value: 10,
        sourceRevision: '2',
        publishedAt: date('2024-07-01'),
        revisionPublishedAt: date('2024-07-01'),
        recordedAt: date('2024-07-02'),
        status: 'retracted',
        supersedesId: 'reported',
      });
      const vintage = resolve([reported, retracted], '2024-07-03');

      expect(vintage.facts).toEqual([]);
      expect(vintage).toMatchObject({
        status: 'unavailable',
        coverage: { requested: 1, available: 0, missing: 1, retracted: 1 },
        missing: [{ reason: 'retracted' }],
      });
    });

    it('uses the same deterministic tie-breaker regardless of input order', () => {
      const first = makeFact({ id: 'tie-a', value: 10, sourceRevision: 'same' });
      const second = makeFact({ id: 'tie-b', value: 11, sourceRevision: 'same' });
      const expectedId = first.contentHash > second.contentHash ? first.id : second.id;

      expect(resolve([first, second], '2024-01-01').facts[0]?.id).toBe(expectedId);
      expect(resolve([second, first], '2024-01-01').facts[0]?.id).toBe(expectedId);
    });

    it('sorts requested identities before calculating the vintage key', () => {
      const first = makeFact({ id: 'fact-a', stockId: '000001.SZ' });
      const second = makeFact({ id: 'fact-b', stockId: '000002.SZ' });
      const left = resolve([first, second], '2024-01-01', ['000002.SZ', '000001.SZ']);
      const right = resolve([second, first], '2024-01-01', ['000001.SZ', '000002.SZ']);

      expect(left.vintageKey).toBe(right.vintageKey);
    });
  });

  describe('factor registry, normalizer, and score vectors', () => {
    it('keeps the registry hash stable and rejects contract mismatches', () => {
      const roe = factor('fundamental.profitability.roe');
      expect(fundamentalFactorRegistryHash([...FUNDAMENTAL_FACTOR_REGISTRY_V1].reverse())).toBe(
        FUNDAMENTAL_FACTOR_REGISTRY_HASH,
      );
      expect(() => assertFactorRegistryInvariants(FUNDAMENTAL_FACTOR_REGISTRY_V1)).not.toThrow();
      expect(() =>
        assertFactorRegistryInvariants([roe, { ...roe, id: `${roe.id}.duplicate` }]),
      ).not.toThrow();
      expect(() => assertFactorRegistryInvariants([roe, { ...roe, id: roe.id }])).toThrow(
        /id 必须唯一/,
      );
      expect(() =>
        assertFactorRegistryInvariants([
          { ...roe, sourceMetricIds: ['vendor-private-metric'] } as FactorDefinition,
        ]),
      ).toThrow(/未知 source metric/);
      expect(() =>
        assertFactorRegistryInvariants([
          { ...roe, computeId: 'arbitrary-code' } as FactorDefinition,
        ]),
      ).toThrow(/computeId/);
      expect(() =>
        assertFactorRegistryInvariants([
          { ...roe, computeId: 'identity-ratio', outputUnit: 'percent-points' },
        ]),
      ).toThrow(/outputUnit/);
      expect(() => FactorDefinitionSchema.parse({ ...roe, direction: 'sideways' })).toThrow();
      expect(() => FactorDefinitionSchema.parse({ ...roe, unexpectedField: true })).toThrow();
    });

    it('computes aligned registered factors and explicit denominator failures', () => {
      const roe = evaluateFundamentalFactor({
        stockId: '000001.SZ',
        factor: 'fundamental.profitability.roe',
        facts: [makeFact({ id: 'roe', value: 18 })],
      });
      expect(roe).toMatchObject({
        factorId: 'fundamental.profitability.roe',
        rawValue: 18,
        unit: 'percent-points',
        direction: 'higher',
      });

      const margin = evaluateFundamentalFactor({
        stockId: '000001.SZ',
        factor: 'fundamental.quality.ocf-margin',
        facts: [
          makeFact({
            id: 'ocf',
            metricId: 'operating-cashflow',
            value: 25,
            canonicalUnit: 'CNY',
            currency: 'CNY',
          }),
          makeFact({
            id: 'revenue',
            metricId: 'revenue',
            value: 100,
            canonicalUnit: 'CNY',
            currency: 'CNY',
          }),
        ],
      });
      expect(margin.rawValue).toBe(25);

      const noDenominator = evaluateFundamentalFactor({
        stockId: '000001.SZ',
        factor: 'fundamental.quality.ocf-margin',
        facts: [
          makeFact({
            id: 'ocf-zero',
            metricId: 'operating-cashflow',
            value: 25,
            canonicalUnit: 'CNY',
            currency: 'CNY',
          }),
          makeFact({
            id: 'revenue-zero',
            metricId: 'revenue',
            value: 0,
            canonicalUnit: 'CNY',
            currency: 'CNY',
          }),
        ],
      });
      expect(noDenominator).toMatchObject({ missingReason: 'no-denominator' });

      const wrongUnit = evaluateFundamentalFactor({
        stockId: '000001.SZ',
        factor: 'fundamental.profitability.roe',
        facts: [makeFact({ id: 'roe-wrong-unit', canonicalUnit: 'ratio' })],
      });
      expect(wrongUnit).toMatchObject({ missingReason: 'invalid-unit' });
    });

    it('implements n=1, average ties, direction inversion, and small-sample gating', () => {
      const values = [
        { stockId: 'a', rawValue: 10 },
        { stockId: 'b', rawValue: 20 },
        { stockId: 'c', rawValue: 20 },
        { stockId: 'd', rawValue: 30 },
      ];
      expect(percentileRank('a', 10, values, 'higher')).toBe(0);
      expect(percentileRank('b', 20, values, 'higher')).toBe(50);
      expect(percentileRank('b', 20, values, 'lower')).toBe(50);
      expect(percentileRank('only', 7, [{ stockId: 'only', rawValue: 7 }], 'higher')).toBe(50);

      const factorId = 'fundamental.profitability.roe';
      const tooSmall = normalizeFundamentalFactor({
        factor: factorId,
        normalizer: 'market-percentile-v1',
        observations: [
          makeObservation(factorId, '000001.SZ', 10),
          makeObservation(factorId, '000002.SZ', 20),
        ],
      });
      expect(tooSmall).toMatchObject([
        { stockId: '000001.SZ', sampleSize: 2, missingReason: 'sample-too-small' },
        { stockId: '000002.SZ', sampleSize: 2, missingReason: 'sample-too-small' },
      ]);

      const industry = normalizeFundamentalFactor({
        factor: factorId,
        normalizer: 'industry-percentile-v1',
        observations: [
          ...Array.from({ length: 20 }, (_, index) =>
            makeObservation(factorId, `bank-${String(index).padStart(2, '0')}`, index, 'bank'),
          ),
          makeObservation(factorId, 'missing-industry', 30),
        ],
      });
      expect(industry.find((value) => value.stockId === 'bank-00')).toMatchObject({
        normalizedValue: 0,
        groupKey: 'industry:bank',
      });
      expect(industry.find((value) => value.stockId === 'bank-19')).toMatchObject({
        normalizedValue: 100,
        groupKey: 'industry:bank',
      });
      expect(industry.find((value) => value.stockId === 'missing-industry')).toMatchObject({
        missingReason: 'group-missing',
      });
    });

    it('scores available observations with round-to-6 and keeps missing non-zero semantics', () => {
      const version = makeScoreVersion();
      expect(() => assertFundamentalScoreVersionInvariants(version)).not.toThrow();
      const scoreStocks = Array.from(
        { length: 20 },
        (_, index) => `score-${String(index).padStart(2, '0')}`,
      );
      const score = runFundamentalScore({
        scoreRunId: 'score-audit',
        scoreVersion: version,
        stockIds: scoreStocks,
        observations: scoreStocks.map((stockId, index) =>
          makeObservation('fundamental.profitability.roe', stockId, index),
        ),
        dataAsOf: date('2024-01-03'),
        vintageKey: 'a'.repeat(64),
      });
      expect(score).toMatchObject({
        status: 'complete',
        counts: { evaluated: 20, available: 20, missing: 0, excluded: 0 },
      });
      expect(score.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ stockId: 'score-00', status: 'available', score: 0, rank: 20 }),
          expect.objectContaining({
            stockId: 'score-19',
            status: 'available',
            score: 100,
            rank: 1,
          }),
        ]),
      );

      const partialStocks = Array.from(
        { length: 21 },
        (_, index) => `partial-${String(index).padStart(2, '0')}`,
      );
      const partial = runFundamentalScore({
        scoreRunId: 'score-audit-missing',
        scoreVersion: version,
        stockIds: partialStocks,
        observations: partialStocks
          .slice(0, 20)
          .map((stockId, index) =>
            makeObservation('fundamental.profitability.roe', stockId, index),
          ),
        dataAsOf: date('2024-01-03'),
        vintageKey: 'b'.repeat(64),
      });
      expect(partial.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stockId: 'partial-00',
            status: 'available',
            score: 0,
            rank: 20,
          }),
          expect.objectContaining({
            stockId: 'partial-19',
            status: 'available',
            score: 100,
            rank: 1,
          }),
          expect.objectContaining({ stockId: 'partial-20', status: 'missing' }),
        ]),
      );
      const missing = partial.results.find((result) => result.stockId === 'partial-20');
      expect(missing?.score).toBeUndefined();
      expect(missing?.rank).toBeUndefined();
    });
  });

  describe('explicitly uncovered design vectors', () => {
    it('exports the P3-0 contract through the core barrel', () => {
      expect((core as unknown as Record<string, unknown>).FinancialFactSchema).toBeDefined();
    });

    it('does not evaluate a fact belonging to another stock', () => {
      const foreignFact = makeFact({ stockId: '000002.SZ', value: 99 });
      const result = evaluateFundamentalFactor({
        stockId: '000001.SZ',
        factor: 'fundamental.profitability.roe',
        facts: [foreignFact],
      });

      expect(result).toMatchObject({ missingReason: 'no-eligible-vintage' });
    });

    it('does not accept an ad-hoc factor outside the immutable registry', () => {
      const registered = factor('fundamental.profitability.roe');
      const adHoc = { ...registered, id: 'fundamental.ad-hoc.roe' };

      expect(() =>
        evaluateFundamentalFactor({
          stockId: '000001.SZ',
          factor: adHoc,
          facts: [makeFact()],
        }),
      ).toThrow();
    });

    it('rejects lowering the frozen production minimum sample size', () => {
      const factorId = 'fundamental.profitability.roe';
      expect(() =>
        normalizeFundamentalFactor({
          factor: factorId,
          normalizer: 'market-percentile-v1',
          minSampleSize: 1,
          observations: [makeObservation(factorId, '000001.SZ', 10)],
        }),
      ).toThrow();
    });

    it('requires available score components to carry normalized values and contributions', () => {
      const result = {
        scoreRunId: 'run',
        stockId: '000001.SZ',
        status: 'available' as const,
        score: 0,
        components: [
          {
            factorId: 'fundamental.profitability.roe',
            unit: 'percent-points' as const,
            direction: 'higher' as const,
            sourceRevisionIds: [],
          },
        ],
        dataAsOf: date('2024-01-01'),
        vintageKey: 'a'.repeat(64),
      };

      expect(() => {
        const parsed = FundamentalScoreResultSchema.parse(result);
        assertFundamentalScoreResultInvariants(parsed);
      }).toThrow();
    });

    it('does not run a draft score version', () => {
      const version = makeScoreVersion({ status: 'draft', publishedAt: undefined });
      expect(() =>
        runFundamentalScore({
          scoreRunId: 'draft-run',
          scoreVersion: version,
          stockIds: ['000001.SZ'],
          observations: [makeObservation('fundamental.profitability.roe', '000001.SZ', 10)],
          dataAsOf: date('2024-01-01'),
          vintageKey: 'a'.repeat(64),
        }),
      ).toThrow();
    });

    it('rejects supersedesId that targets another stock/metric/period', () => {
      const source = makeFact({ id: 'source' });
      const invalid = makeFact({
        id: 'invalid',
        stockId: '000002.SZ',
        sourceRevision: '2',
        publishedAt: date('2024-07-01'),
        revisionPublishedAt: date('2024-07-01'),
        recordedAt: date('2024-07-02'),
        supersedesId: source.id,
      });

      expect(() => resolve([source, invalid], '2024-07-03', ['000002.SZ'])).toThrow();
    });

    it('includes the selected retraction revision in vintage identity', () => {
      const reported = makeFact({ id: 'reported', sourceRevision: '1' });
      const retractedA = makeFact({
        id: 'retracted-a',
        sourceRevision: '2',
        status: 'retracted',
        publishedAt: date('2024-07-01'),
        revisionPublishedAt: date('2024-07-01'),
        recordedAt: date('2024-07-02'),
        supersedesId: reported.id,
      });
      const retractedB = makeFact({
        id: 'retracted-b',
        sourceRevision: '3',
        status: 'retracted',
        publishedAt: date('2024-07-01'),
        revisionPublishedAt: date('2024-07-01'),
        recordedAt: date('2024-07-02'),
        supersedesId: reported.id,
      });

      expect(resolve([reported, retractedA], '2024-07-03').vintageKey).not.toBe(
        resolve([reported, retractedB], '2024-07-03').vintageKey,
      );
    });

    it('distinguishes an uncovered metric from a covered metric with no eligible vintage', () => {
      const vintage = resolve([], '2024-01-01');

      expect(vintage.missing).toEqual([
        { stockId: '000001.SZ', metricId: 'roe', reason: 'not-covered' },
      ]);
    });
  });
});
